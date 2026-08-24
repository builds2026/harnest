import type { MessageKey } from "./messages/en-US";
import type { ConnectionKind } from "@/lib/connections";

type Translator = (key: MessageKey) => string;

const componentKeys = {
  model: "component.model",
  prompt: "component.prompt",
  agent: "component.agent",
  output: "component.output",
  context: "component.context",
  memory: "component.memory",
  tool: "component.tool",
  skill: "component.skill",
  "local-tool": "component.local-tool",
  "mcp-tool": "component.mcp-tool",
  router: "component.router",
  evaluator: "component.evaluator",
  join: "component.join",
  subgraph: "component.subgraph",
  loop: "component.loop",
} as const satisfies Readonly<Record<string, MessageKey>>;

const fieldKeys = {
  connectionId: "field.connectionId", adapter: "field.adapter", model: "field.model", apiKey: "field.apiKey",
  temperature: "field.temperature", maxTokens: "field.maxTokens", inputCostPerMillion: "field.inputCostPerMillion",
  outputCostPerMillion: "field.outputCostPerMillion", template: "field.template", system: "field.system",
  timeoutMs: "field.timeoutMs", maxTurns: "field.maxTurns", maxToolCalls: "field.maxToolCalls",
  toolTimeoutMs: "field.toolTimeoutMs", maxCostUsd: "field.maxCostUsd", allowTools: "field.allowTools",
  denyTools: "field.denyTools", toolError: "field.toolError", format: "field.format", schema: "field.schema",
  source: "field.source", text: "field.text", path: "field.path", pattern: "field.pattern", topK: "field.topK",
  key: "field.key", operation: "field.operation", initial: "field.initial", tool: "field.tool", action: "field.action",
  risk: "field.risk", inputSchema: "field.inputSchema", outputSchema: "field.outputSchema", skill: "field.skill",
  transport: "field.transport", protocol: "field.protocol", command: "field.command", args: "field.args", url: "field.url",
  headers: "field.headers", condition: "field.condition", type: "field.type", value: "field.value", maxMs: "field.maxMs",
  min: "field.min", max: "field.max", mode: "field.mode", keys: "field.keys", separator: "field.separator",
  subgraph: "field.subgraph", maxIterations: "field.maxIterations", until: "field.until",
} as const satisfies Readonly<Record<string, MessageKey>>;

const connectionKeys: Readonly<Record<ConnectionKind, MessageKey>> = {
  provider: "connections.kind.provider",
  "mcp-http": "connections.kind.mcp-http",
  "mcp-stdio": "connections.kind.mcp-stdio",
  "http-api": "connections.kind.http-api",
  "tool-service": "connections.kind.tool-service",
  "local-runtime": "connections.kind.local-runtime",
};

const categoryKeys = {
  Agent: "category.agent", Output: "category.output", Knowledge: "category.knowledge", Tools: "category.tools",
  Skills: "category.skills", Flow: "category.flow", Evaluation: "category.evaluation", Research: "category.research",
  Development: "category.development", Model: "category.model", Local: "category.local", Web: "category.web",
  project: "category.project", user: "category.user",
} as const satisfies Readonly<Record<string, MessageKey>>;

export const componentLabel = (t: Translator, type: string, fallback: string) =>
  type in componentKeys ? t(componentKeys[type as keyof typeof componentKeys]) : fallback;

export const fieldLabel = (t: Translator, path: string, fallback: string) =>
  path in fieldKeys ? t(fieldKeys[path as keyof typeof fieldKeys]) : fallback;

export const connectionLabel = (t: Translator, kind: ConnectionKind) => t(connectionKeys[kind]);

export const categoryLabel = (t: Translator, category: string) =>
  category in categoryKeys ? t(categoryKeys[category as keyof typeof categoryKeys]) : category;
