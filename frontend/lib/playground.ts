import type { HarnessSpec, TokenUsage } from "@harnestai/core";

export type PlaygroundMessageRole = "user" | "assistant";

export interface PlaygroundMessage {
  readonly id: string;
  readonly role: PlaygroundMessageRole;
  readonly content: string;
  readonly createdAt: string;
  readonly runId?: string;
  readonly usage?: TokenUsage;
  readonly costUsd?: number;
  readonly finishReason?: string;
  readonly fileIds?: readonly string[];
}

export interface PlaygroundSession {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
  readonly messages: readonly PlaygroundMessage[];
  /** Durable files reused by later messages until the user changes the selection. */
  readonly activeFileIds?: readonly string[];
}

export interface PlaygroundConversationCheckpoint {
  readonly originalRequest?: string;
  readonly decisions: readonly string[];
  readonly evidence: readonly string[];
  readonly currentResult?: string;
  readonly validation?: Readonly<Record<string, unknown>>;
  readonly remainingWork: readonly string[];
  readonly compactedMessages: number;
}

export interface PlaygroundSessionSummary extends Omit<PlaygroundSession, "messages"> {
  readonly messageCount: number;
  readonly preview?: string;
}

export interface PlaygroundFile {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly sha256?: string;
  readonly source: "upload" | "artifact" | "sandbox";
  readonly createdAt: string;
  readonly sandboxPath?: string;
  readonly runId?: string;
  readonly preview: "image" | "video" | "audio" | "pdf" | "text" | "none";
}

export interface PlaygroundPlugin {
  readonly componentKey: string;
  readonly componentId: string;
  readonly id: string;
  readonly label: string;
  readonly kind: "tool" | "mcp" | "skill";
  readonly risk?: string;
}

export interface PlaygroundModelOption {
  readonly componentKey: string;
  readonly componentId: string;
  readonly connectionId: string;
  readonly model?: string;
  readonly label: string;
  readonly fallback: boolean;
}

export interface PlaygroundCapabilities {
  readonly models: readonly PlaygroundModelOption[];
  readonly plugins: readonly PlaygroundPlugin[];
  readonly attachments: {
    readonly enabled: boolean;
    /** The graph can pass supported media directly to a multimodal Agent model. */
    readonly directModelInput: boolean;
    readonly maxFiles: number;
    readonly maxFileBytes: number;
    readonly accepted: string;
    readonly reason?: string;
  };
}

export interface PlaygroundOverrides {
  readonly disabledPluginKeys?: readonly string[];
  readonly model?: Pick<PlaygroundModelOption, "componentKey" | "connectionId">;
}

const graphBodies = (spec: Exclude<HarnessSpec, { version: "0.1" }>) => [
  { key: "root", body: spec },
  ...Object.entries(spec.subgraphs ?? {}).map(([name, body]) => ({ key: `subgraph:${name}`, body })),
];

const componentKey = (graph: string, id: string) => `${graph}/${id}`;

export function playgroundCapabilities(spec: HarnessSpec): PlaygroundCapabilities {
  if (spec.version === "0.1") return {
    models: [],
    plugins: [],
    attachments: {
      enabled: false,
      directModelInput: false,
      maxFiles: 32,
      maxFileBytes: 64 * 1_048_576,
      accepted: "image/*,video/*,audio/*,.pdf,.csv,.tsv,.json,.txt,.md,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip",
      reason: "Upgrade this harness to v0.2 and attach a Code Runner to work with files.",
    },
  };
  const components = graphBodies(spec).flatMap(({ key, body }) => body.components.map((component) => ({ graph: key, component })));
  const plugins = components.flatMap(({ graph, component }): PlaygroundPlugin[] => {
    if (component.type === "skill" && typeof component.config.skill === "string" && component.config.skill) return [{
      componentKey: componentKey(graph, component.id),
      componentId: component.id,
      id: component.config.skill,
      label: component.config.skill,
      kind: "skill",
    }];
    if (component.type !== "tool" || typeof component.config.tool !== "string" || !component.config.tool) return [];
    const source = component.config.source;
    return [{
      componentKey: componentKey(graph, component.id),
      componentId: component.id,
      id: component.config.tool,
      label: typeof component.config.action === "string" && component.config.action
        ? component.config.action : component.config.tool,
      kind: source === "mcp" ? "mcp" : "tool",
      ...(typeof component.config.risk === "string" ? { risk: component.config.risk } : {}),
    }];
  });
  const models = components.flatMap(({ graph, component }): PlaygroundModelOption[] => {
    if (component.type !== "model") return [];
    const current = typeof component.config.connectionId === "string" ? component.config.connectionId : undefined;
    const fallback = typeof component.config.fallbackConnectionId === "string"
      ? component.config.fallbackConnectionId : undefined;
    const model = typeof component.config.model === "string" ? component.config.model : undefined;
    return [
      ...(current ? [{
        componentKey: componentKey(graph, component.id),
        componentId: component.id,
        connectionId: current,
        ...(model ? { model } : {}),
        label: model ? `${model} · primary` : `${component.id} · primary`,
        fallback: false,
      }] : []),
      ...(fallback && fallback !== current ? [{
        componentKey: componentKey(graph, component.id),
        componentId: component.id,
        connectionId: fallback,
        ...(model ? { model } : {}),
        label: model ? `${model} · fallback` : `${component.id} · fallback`,
        fallback: true,
      }] : []),
    ];
  });
  const codeRunner = plugins.some((plugin) => plugin.id === "builtin.code-runner");
  const directModelInput = components.some(({ component }) => component.type === "agent"
    && component.config.multimodal !== false);
  return {
    models,
    plugins,
    attachments: {
      enabled: codeRunner || directModelInput,
      directModelInput,
      maxFiles: 32,
      maxFileBytes: 64 * 1_048_576,
      accepted: "image/*,video/*,audio/*,.pdf,.csv,.tsv,.json,.txt,.md,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip",
      ...(!codeRunner && !directModelInput
        ? { reason: "Enable multimodal input on an Agent or attach a Code Runner to work with files." }
        : {}),
    },
  };
}

export function applyPlaygroundOverrides(spec: HarnessSpec, overrides: PlaygroundOverrides): HarnessSpec {
  const copy = structuredClone(spec);
  const disabled = new Set(overrides.disabledPluginKeys ?? []);
  const knownPlugins = new Set(playgroundCapabilities(spec).plugins.map(({ componentKey }) => componentKey));
  for (const key of disabled) {
    if (!knownPlugins.has(key)) throw new Error(`Playground plugin '${key}' is not part of this harness`);
  }
  if (copy.version === "0.1") {
    if (overrides.model) throw new Error("Selected model is not declared by this harness");
    return copy;
  }
  for (const { key, body } of graphBodies(copy)) {
    body.components = body.components.filter((component) => !disabled.has(componentKey(key, component.id)));
    body.connections = body.connections.filter((connection) => !disabled.has(componentKey(key, connection.from.component))
      && !disabled.has(componentKey(key, connection.to.component)));
  }
  if (overrides.model) {
    const allowed = playgroundCapabilities(spec).models.some((option) => option.componentKey === overrides.model?.componentKey
      && option.connectionId === overrides.model?.connectionId);
    if (!allowed) throw new Error("Selected model is not declared by this harness");
    const model = graphBodies(copy).flatMap(({ key, body }) => body.components
      .map((component) => ({ key: componentKey(key, component.id), component })))
      .find(({ key, component }) => key === overrides.model?.componentKey && component.type === "model")?.component;
    if (!model) throw new Error("Selected model component is unavailable");
    model.config = { ...model.config, connectionId: overrides.model.connectionId };
  }
  return copy;
}

export function filePreview(mimeType: string, name: string): PlaygroundFile["preview"] {
  if (mimeType.startsWith("image/") && mimeType !== "image/svg+xml") return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType === "application/pdf" || name.toLocaleLowerCase().endsWith(".pdf")) return "pdf";
  if (mimeType.startsWith("text/") || /\.(?:csv|tsv|json|md|txt|log|ya?ml)$/i.test(name)) return "text";
  return "none";
}
