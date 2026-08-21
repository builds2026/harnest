import "server-only";

import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  AdapterRegistry,
  ToolRegistry,
  createBuiltinComponentRegistry,
  type Diagnostic,
  type HarnessSpec,
  type RuntimeOptions,
} from "@harnest/core";
import {
  FileRunStore,
  NodeRuntimeServices,
  loadAdapterModules,
  loadRuntimeModules,
} from "@harnest/core/node";
import {
  hostCapabilityDiagnosticsFor,
  runtimeServiceOptionsFor,
  studioCapabilityPolicy,
} from "./runtime-config";

export const harnessFile = () => process.env.HARNEST_FILE
  ? resolve(process.env.HARNEST_FILE)
  : join(process.cwd(), "harnest.yaml");

export async function fileExists(filePath: string) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function runtimeResourcesFor(spec: HarnessSpec) {
  const adapters = new AdapterRegistry();
  const components = createBuiltinComponentRegistry();
  const tools = new ToolRegistry();
  const projectDirectory = dirname(harnessFile());
  const capabilityPolicy = studioCapabilityPolicy(process.env);
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
  const services = new NodeRuntimeServices(projectDirectory, runtimeServiceOptionsFor(spec, capabilityPolicy));
  const runs = new FileRunStore(projectDirectory);
  const diagnostics = [...adapterLoad.diagnostics, ...runtimeLoad.diagnostics, ...hostCapabilityDiagnosticsFor(spec, capabilityPolicy)]
    .filter((diagnostic, index, all) => all.findIndex((item) => item.code === diagnostic.code && item.path === diagnostic.path) === index);
  return {
    adapters,
    components,
    tools,
    services,
    runs,
    diagnostics,
  };
}

export type RuntimeResources = Awaited<ReturnType<typeof runtimeResourcesFor>>;

export const runtimeOptionsFor = (resources: RuntimeResources): RuntimeOptions => ({
  env: process.env,
  components: resources.components,
  tools: resources.tools,
  services: resources.services,
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
