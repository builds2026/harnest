import { dirname } from "node:path";
import anthropicAdapter from "@harnestai/adapter-anthropic";
import geminiAdapter from "@harnestai/adapter-gemini";
import ollamaAdapter from "@harnestai/adapter-local";
import openAIAdapter from "@harnestai/adapter-openai";
import {
  AdapterRegistry,
  DiagnosticError,
  HarnessRuntime,
  ToolRegistry,
  createBuiltinComponentRegistry,
  createHttpHostProviders,
  describeHarness,
  runHarnessTests,
  validateSpec,
  type Diagnostic,
  type HarnessSpec,
  type HarnessIntegrationContract,
  type HostProviders,
  type HarnessTestOptions,
  type HarnessTestReport,
  type ModelAdapter,
  type RunEvent,
  type RunHandle,
  type RunOptions,
  type RunSnapshot,
  type RunResult,
} from "@harnestai/core";
import {
  FileRunStore,
  NodeRuntimeServices,
  loadAdapterModules,
  loadRuntimeModules,
  loadSpecFile,
  resolveHarnessFile,
  type NodeRuntimeServiceOptions,
  type NodeArtifactContent,
  type PersistedToolPermission,
} from "@harnestai/core/node";

export interface HarnestLoadOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly adapters?: readonly ModelAdapter[];
  readonly services?: NodeRuntimeServiceOptions;
  readonly allowModuleExecution?: boolean;
  readonly persistRuns?: boolean;
  readonly providerUrl?: string;
  readonly providerToken?: string;
}

export class Harnest {
  readonly file: string;
  readonly spec: HarnessSpec;
  readonly diagnostics: readonly Diagnostic[];

  get contract(): HarnessIntegrationContract {
    return describeHarness(this.spec);
  }
  readonly #adapters: AdapterRegistry;
  readonly #components: ReturnType<typeof createBuiltinComponentRegistry>;
  readonly #tools: ToolRegistry;
  readonly #services: NodeRuntimeServices;
  readonly #environment: Readonly<Record<string, string | undefined>>;
  readonly #runs: FileRunStore | undefined;
  readonly #providers: HostProviders | undefined;
  #closed = false;

  private constructor(options: {
    file: string;
    spec: HarnessSpec;
    diagnostics: readonly Diagnostic[];
    adapters: AdapterRegistry;
    components: ReturnType<typeof createBuiltinComponentRegistry>;
    tools: ToolRegistry;
    services: NodeRuntimeServices;
    environment: Readonly<Record<string, string | undefined>>;
    runs?: FileRunStore;
    providers?: HostProviders;
  }) {
    this.file = options.file;
    this.spec = options.spec;
    this.diagnostics = options.diagnostics;
    this.#adapters = options.adapters;
    this.#components = options.components;
    this.#tools = options.tools;
    this.#services = options.services;
    this.#environment = options.environment;
    this.#runs = options.runs;
    this.#providers = options.providers;
  }

  static async load(file: string, options: HarnestLoadOptions = {}): Promise<Harnest> {
    const absolute = await resolveHarnessFile(file);
    const parsed = await loadSpecFile(absolute);
    if (!parsed.ok) throw new DiagnosticError("HarnessSpec could not be loaded", parsed.diagnostics);

    const projectDirectory = dirname(absolute);
    const environment = options.env ?? process.env;
    const providerUrl = options.providerUrl ?? environment.HARNEST_PROVIDER_URL;
    const providerToken = options.providerToken ?? environment.HARNEST_PROVIDER_TOKEN;
    if (Boolean(providerUrl) !== Boolean(providerToken)) throw new Error(
      "HARNEST_PROVIDER_URL and HARNEST_PROVIDER_TOKEN must be configured together",
    );
    const runs = options.persistRuns === false && !providerUrl ? undefined : new FileRunStore(projectDirectory);
    const providers = providerUrl && providerToken && runs
      ? createHttpHostProviders({ baseUrl: providerUrl, token: providerToken, runs })
      : undefined;
    const adapters = new AdapterRegistry();
    const components = createBuiltinComponentRegistry();
    const tools = new ToolRegistry();
    const services = new NodeRuntimeServices(projectDirectory, {
      ...options.services,
      harnessId: absolute,
      ...(options.allowModuleExecution ? { allowModuleExecution: true as const } : {}),
    });
    try {
      for (const definition of await services.toolDefinitions()) {
        if (!tools.has(definition.id)) tools.register(definition);
      }
      for (const adapter of options.adapters ?? []) adapters.register(adapter);
      const modulePermission = options.allowModuleExecution ? { allowModuleExecution: true as const } : undefined;
      const adapterLoad = await loadAdapterModules(parsed.spec, adapters, projectDirectory, modulePermission);
      const runtimeLoad = await loadRuntimeModules(
        parsed.spec,
        { adapters, components, tools },
        projectDirectory,
        modulePermission,
      );
      for (const adapter of [openAIAdapter, anthropicAdapter, geminiAdapter, ollamaAdapter]) {
        if (!adapters.has(adapter.id)) adapters.register(adapter);
      }
      const validation = validateSpec(parsed.spec, { registry: adapters, components, tools, env: environment });
      const diagnostics = [
        ...adapterLoad.diagnostics,
        ...runtimeLoad.diagnostics,
        ...validation.diagnostics,
        ...(providers?.connections ? [] : await services.connectionDiagnostics(parsed.spec, tools)),
      ];
      if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
        throw new DiagnosticError("HarnessSpec is not ready to run", diagnostics);
      }
      return new Harnest({
        file: absolute,
        spec: parsed.spec,
        diagnostics,
        adapters,
        components,
        tools,
        services,
        environment,
        ...(runs ? { runs } : {}),
        ...(providers ? { providers } : {}),
      });
    } catch (error) {
      await services.close();
      throw error;
    }
  }

  stream(input: unknown, options: RunOptions = {}): AsyncIterable<RunEvent> {
    this.#assertOpen();
    return this.#runtime().stream(input, options);
  }

  start(input: unknown, options: RunOptions = {}, reservedRunId?: string): RunHandle {
    this.#assertOpen();
    return this.#runtime().start(input, options, reservedRunId);
  }

  resume(input: unknown, snapshot: RunSnapshot, options: RunOptions = {}): RunHandle {
    this.#assertOpen();
    return this.#runtime().resume(input, snapshot, options);
  }

  async invoke(input: unknown, options: RunOptions = {}): Promise<RunResult> {
    this.#assertOpen();
    return this.#runtime().invoke(input, options);
  }

  test(options: Omit<HarnessTestOptions, "env" | "components" | "tools" | "services" | "eventSink"> = {}): Promise<HarnessTestReport> {
    this.#assertOpen();
    return runHarnessTests(this.spec, this.#adapters, {
      ...options,
      env: this.#environment,
      components: this.#components,
      tools: this.#tools,
      services: this.#services,
      ...(this.#providers ? { providers: this.#providers } : {}),
      ...(this.#runs ? { eventSink: this.#runs } : {}),
    });
  }

  listPermissions(): Promise<PersistedToolPermission[]> {
    this.#assertOpen();
    return this.#services.listToolPermissions();
  }

  revokePermission(toolId: string, connectionId?: string): Promise<boolean> {
    this.#assertOpen();
    return this.#services.revokeToolPermission(toolId, connectionId);
  }

  readArtifact(runId: string, artifactId: string): Promise<NodeArtifactContent> {
    this.#assertOpen();
    return this.#services.readArtifact(runId, artifactId);
  }

  async readRunSnapshot(runId: string): Promise<RunSnapshot | undefined> {
    this.#assertOpen();
    return this.#runs?.readSnapshot(runId);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#services.close();
  }

  #runtime(): HarnessRuntime {
    return new HarnessRuntime(this.spec, this.#adapters, {
      env: this.#environment,
      components: this.#components,
      tools: this.#tools,
      services: this.#services,
      ...(this.#providers ? { providers: this.#providers } : {}),
      harnessId: this.file,
      ...(this.#runs ? { eventSink: this.#runs } : {}),
    });
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Harnest instance is closed");
  }
}

export default Harnest;
