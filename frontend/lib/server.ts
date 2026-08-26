import "server-only";

import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import anthropicAdapter from "@harnestai/adapter-anthropic";
import geminiAdapter from "@harnestai/adapter-gemini";
import ollamaAdapter from "@harnestai/adapter-local";
import openAIAdapter from "@harnestai/adapter-openai";
import {
  AdapterRegistry,
  ToolRegistry,
  createHttpHostProviders,
  createBuiltinComponentRegistry,
  type Diagnostic,
  type HarnessSpec,
  type RuntimeOptions,
  type RuntimeServices,
  type ToolApprovalRequest,
  type ToolApprovalDecision,
} from "@harnestai/core";
import {
  FileRunStore,
  NodeRuntimeServices,
  loadAdapterModules,
  loadRuntimeModules,
  resolveHarnessFileSync,
  type NodeRuntimeServiceOptions,
} from "@harnestai/core/node";
import {
  hostCapabilityDiagnosticsFor,
  runtimeServiceOptionsFor,
  studioCapabilityPolicy,
} from "./runtime-config";

interface ActiveStudioProject {
  base: string;
  active?: string;
}

const inside = (root: string, target: string) => {
  const path = relative(root, target);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

function persistedActiveProject(base: string): string | undefined {
  try {
    const projectRoot = realpathSync(dirname(base));
    const hidden = realpathSync(join(projectRoot, ".harnest"));
    const imports = realpathSync(join(hidden, "imports"));
    if (!inside(projectRoot, hidden) || !inside(hidden, imports)) return undefined;
    const parsed = JSON.parse(readFileSync(join(hidden, "studio-active-project.json"), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const candidate = (parsed as { version?: unknown; file?: unknown }).file;
    if ((parsed as { version?: unknown }).version !== 1 || typeof candidate !== "string"
      || candidate.includes("\\") || candidate.startsWith("/") || candidate.split("/").some((part) => !part || part === "." || part === "..")) return undefined;
    const lexical = resolve(imports, ...candidate.split("/"));
    if (!inside(imports, lexical) || lstatSync(lexical).isSymbolicLink() || !statSync(lexical).isFile()) return undefined;
    const canonical = realpathSync(lexical);
    return inside(imports, canonical) ? resolveHarnessFileSync(canonical) : undefined;
  } catch {
    return undefined;
  }
}

const activeProjectState = () => {
  const base = process.env.HARNEST_FILE
    ? resolveHarnessFileSync(process.env.HARNEST_FILE)
    : join(process.cwd(), "harnest.yaml");
  const host = globalThis as typeof globalThis & { __harnestStudioActiveProject?: ActiveStudioProject };
  if (!host.__harnestStudioActiveProject || host.__harnestStudioActiveProject.base !== base) {
    host.__harnestStudioActiveProject = { base, active: persistedActiveProject(base) };
  }
  return host.__harnestStudioActiveProject;
};

export const harnessFile = () => activeProjectState().active ?? activeProjectState().base;

/** Switches this single-user local Studio host after a folder-picker import has validated successfully. */
export const activateHarnessFile = (file: string) => {
  const state = activeProjectState();
  const projectRoot = realpathSync(dirname(state.base));
  const hiddenPath = join(projectRoot, ".harnest");
  mkdirSync(hiddenPath, { recursive: true, mode: 0o700 });
  const hidden = realpathSync(hiddenPath);
  const imports = realpathSync(join(hidden, "imports"));
  const active = realpathSync(resolveHarnessFileSync(file));
  if (!inside(imports, active) || lstatSync(active).isSymbolicLink() || !statSync(active).isFile()) {
    throw new Error("Studio can activate only a validated managed project import");
  }
  const relativeFile = relative(imports, active).split(sep).join("/");
  const target = join(hidden, "studio-active-project.json");
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ version: 1, file: relativeFile }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
  state.active = active;
  return active;
};

export const studioBaseHarnessFile = () => activeProjectState().base;

export async function fileExists(filePath: string) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function runtimeResourcesFor(spec: HarnessSpec, options: {
  readonly requestToolApproval?: RuntimeServices["requestToolApproval"];
  readonly sandboxWorkspace?: NodeRuntimeServiceOptions["sandboxWorkspace"];
} = {}) {
  const adapters = new AdapterRegistry();
  const components = createBuiltinComponentRegistry();
  const tools = new ToolRegistry();
  const projectDirectory = dirname(harnessFile());
  const capabilityPolicy = studioCapabilityPolicy(process.env);
  const providerUrl = process.env.HARNEST_PROVIDER_URL;
  const providerToken = process.env.HARNEST_PROVIDER_TOKEN;
  const services = new NodeRuntimeServices(projectDirectory, {
    ...runtimeServiceOptionsFor(spec, capabilityPolicy),
    harnessId: harnessFile(),
    ...(options.requestToolApproval ? { requestToolApproval: options.requestToolApproval as (
      request: ToolApprovalRequest,
      context: Parameters<NonNullable<RuntimeServices["requestToolApproval"]>>[1],
    ) => ToolApprovalDecision | Promise<ToolApprovalDecision> } : {}),
    ...(options.sandboxWorkspace ? { sandboxWorkspace: options.sandboxWorkspace } : {}),
  });
  try {
    for (const definition of await services.toolDefinitions()) if (!tools.has(definition.id)) tools.register(definition);
    const adapterLoad = await loadAdapterModules(
      spec,
      adapters,
      projectDirectory,
      capabilityPolicy.allowModules ? { allowModuleExecution: true } : undefined,
    );
    const runtimeLoad = await loadRuntimeModules(
      spec,
      { adapters, components, tools },
      projectDirectory,
      capabilityPolicy.allowModules ? { allowModuleExecution: true } : undefined,
    );
    for (const adapter of [openAIAdapter, anthropicAdapter, geminiAdapter, ollamaAdapter]) {
      if (!adapters.has(adapter.id)) adapters.register(adapter);
    }
    const runs = new FileRunStore(projectDirectory);
    const providerPairValid = Boolean(providerUrl) === Boolean(providerToken);
    const providers = providerUrl && providerToken
      ? createHttpHostProviders({ baseUrl: providerUrl, token: providerToken, runs })
      : undefined;
    const diagnostics = [
      ...adapterLoad.diagnostics,
      ...runtimeLoad.diagnostics,
      ...hostCapabilityDiagnosticsFor(spec, capabilityPolicy),
      ...(providerPairValid ? [] : [{
        code: "HOST_PROVIDER_CONFIG_INVALID",
        path: "$.runtime.providers",
        message: "HARNEST_PROVIDER_URL and HARNEST_PROVIDER_TOKEN must be configured together.",
        severity: "error" as const,
      }]),
      ...(providers?.connections ? [] : await services.connectionDiagnostics(spec, tools)),
    ]
      .filter((diagnostic, index, all) => all.findIndex((item) => item.code === diagnostic.code && item.path === diagnostic.path) === index);
    return {
      adapters,
      components,
      tools,
      toolStore: services.toolStore,
      services,
      runs,
      ...(providers ? { providers } : {}),
      diagnostics,
    };
  } catch (error) {
    await services.close();
    throw error;
  }
}

export type RuntimeResources = Awaited<ReturnType<typeof runtimeResourcesFor>>;

export const runtimeOptionsFor = (resources: RuntimeResources): RuntimeOptions => ({
  env: process.env,
  components: resources.components,
  tools: resources.tools,
  services: resources.services,
  ...(resources.providers ? { providers: resources.providers } : {}),
  eventSink: resources.runs,
});

export const hasErrors = (diagnostics: readonly Diagnostic[]) =>
  diagnostics.some((diagnostic) => diagnostic.severity === "error");

export const diagnosticResponse = (diagnostics: Diagnostic[], status = 422) =>
  Response.json({ ok: false, diagnostics }, { status });

export const requestDiagnostic = (message: string): Diagnostic => ({
  code: "REQUEST_INVALID",
  path: "$",
  message,
  severity: "error",
});
