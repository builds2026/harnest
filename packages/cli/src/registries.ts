import { anthropicAdapter } from "@harnestai/adapter-anthropic";
import { geminiAdapter } from "@harnestai/adapter-gemini";
import { ollamaAdapter } from "@harnestai/adapter-local";
import { openAIAdapter } from "@harnestai/adapter-openai";
import { AdapterRegistry, ToolRegistry } from "@harnestai/core";
import { BUILTIN_TOOL_MANIFESTS } from "@harnestai/core/node";

export const shippedAdapters = [openAIAdapter, anthropicAdapter, geminiAdapter, ollamaAdapter] as const;

export const createShippedAdapterRegistry = (): AdapterRegistry => {
  const registry = new AdapterRegistry();
  for (const { id, capabilities, requiredCredentials } of shippedAdapters) registry.register({
    id,
    capabilities,
    ...(requiredCredentials ? { requiredCredentials } : {}),
    async *run() {
      yield await Promise.reject(new Error("Authoring validation cannot execute model adapters"));
    },
  });
  return registry;
};

export const createAuthoringToolRegistry = (): ToolRegistry => {
  const registry = new ToolRegistry();
  for (const manifest of BUILTIN_TOOL_MANIFESTS) registry.register({
    ...manifest,
    execute() {
      throw new Error("Authoring validation cannot execute Tools");
    },
  });
  return registry;
};
