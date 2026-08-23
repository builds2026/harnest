import { dirname, resolve } from "node:path";
import anthropicAdapter from "@harnest/adapter-anthropic";
import geminiAdapter from "@harnest/adapter-gemini";
import ollamaAdapter from "@harnest/adapter-local";
import openAIAdapter from "@harnest/adapter-openai";
import {
  AdapterRegistry,
  DiagnosticError,
  HarnessRuntime,
  ToolRegistry,
  createBuiltinComponentRegistry,
  runHarnessTests,
  validateSpec,
  type Diagnostic,
  type HarnessSpec,
  type HarnessTestOptions,
  type HarnessTestReport,
  type ModelAdapter,
  type RunEvent,
  type RunOptions,
  type RunResult,
} from "@harnest/core";
import {
  FileRunStore,
  NodeRuntimeServices,
  loadAdapterModules,
  loadRuntimeModules,
  loadSpecFile,
  type NodeRuntimeServiceOptions,
} from "@harnest/core/node";

export interface HarnestLoadOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly adapters?: readonly ModelAdapter[];
  readonly services?: NodeRuntimeServiceOptions;
  readonly allowModuleExecution?: boolean;
  readonly persistRuns?: boolean;
}

export class Harnest {
  readonly file: string;
  readonly spec: HarnessSpec;
  readonly diagnostics: readonly Diagnostic[];
  readonly #adapters: AdapterRegistry;
  readonly #components: ReturnType<typeof createBuiltinComponentRegistry>;
  readonly #tools: ToolRegistry;
  readonly #services: NodeRuntimeServices;
  readonly #environment: Readonly<Record<string, string | undefined>>;
  readonly #runs: FileRunStore | undefined;
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
  }

  static async load(file: string, options: HarnestLoadOptions = {}): Promise<Harnest> {
    const absolute = resolve(file);
    const parsed = await loadSpecFile(absolute);
    if (!parsed.ok) throw new DiagnosticError("HarnessSpec could not be loaded", parsed.diagnostics);

    const projectDirectory = dirname(absolute);
    const adapters = new AdapterRegistry();
    const components = createBuiltinComponentRegistry();
    const tools = new ToolRegistry();
    const services = new NodeRuntimeServices(projectDirectory, {
      ...options.services,
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
      const environment = options.env ?? process.env;
      const validation = validateSpec(parsed.spec, { registry: adapters, components, tools, env: environment });
      const diagnostics = [
        ...adapterLoad.diagnostics,
        ...runtimeLoad.diagnostics,
        ...validation.diagnostics,
        ...await services.connectionDiagnostics(parsed.spec, tools),
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
        ...(options.persistRuns === false ? {} : { runs: new FileRunStore(projectDirectory) }),
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
      ...(this.#runs ? { eventSink: this.#runs } : {}),
    });
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
      ...(this.#runs ? { eventSink: this.#runs } : {}),
    });
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Harnest instance is closed");
  }
}

export default Harnest;
