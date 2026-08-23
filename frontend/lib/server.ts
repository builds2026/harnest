import "server-only";

import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import anthropicAdapter from "@harnest/adapter-anthropic";
import geminiAdapter from "@harnest/adapter-gemini";
import ollamaAdapter from "@harnest/adapter-local";
import openAIAdapter from "@harnest/adapter-openai";
import {
  AdapterRegistry,
  ToolRegistry,
  createBuiltinComponentRegistry,
  type Diagnostic,
  type HarnessSpec,
  type RuntimeOptions,
  type RuntimeServices,
  type ToolApprovalRequest,
  type ToolApprovalDecision,
} from "@harnest/core";
import {
  FileRunStore,
  NodeRuntimeServices,
  loadAdapterModules,
  loadRuntimeModules,
  type NodeRuntimeServiceOptions,
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

export async function runtimeResourcesFor(spec: HarnessSpec, options: {
  readonly requestToolApproval?: RuntimeServices["requestToolApproval"];
  readonly sandboxWorkspace?: NodeRuntimeServiceOptions["sandboxWorkspace"];
} = {}) {
  const adapters = new AdapterRegistry();
  const components = createBuiltinComponentRegistry();
  const tools = new ToolRegistry();
  const projectDirectory = dirname(harnessFile());
  const capabilityPolicy = studioCapabilityPolicy(process.env);
  const services = new NodeRuntimeServices(projectDirectory, {
    ...runtimeServiceOptionsFor(spec, capabilityPolicy),
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
    const diagnostics = [
      ...adapterLoad.diagnostics,
      ...runtimeLoad.diagnostics,
      ...hostCapabilityDiagnosticsFor(spec, capabilityPolicy),
      ...await services.connectionDiagnostics(spec, tools),
    ]
      .filter((diagnostic, index, all) => all.findIndex((item) => item.code === diagnostic.code && item.path === diagnostic.path) === index);
    return {
      adapters,
      components,
      tools,
      toolStore: services.toolStore,
      services,
      runs,
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
