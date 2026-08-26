export interface AdapterCapabilities {
  streaming: boolean;
  json: boolean;
  cancellation: boolean;
  /** Provider-native function/tool calling. Omitted by legacy adapters. */
  tools?: boolean;
  /** Media kinds this Adapter can send as first-class model input. */
  inputMedia?: readonly ("image" | "audio" | "video" | "pdf")[];
  /** Provider prompt-cache modes supported by this Adapter. */
  promptCaching?: readonly PromptCacheMode[];
}

export type PromptCacheMode = "automatic" | "explicit";
export type PromptCacheStatus = "hit" | "write" | "miss" | "bypass" | "provider-managed";

export interface PromptCacheRequest {
  readonly mode: PromptCacheMode;
  /** SHA-256 digest of the cacheable prefix and its non-secret execution scope. */
  readonly key: string;
  readonly prefixMessageCount: number;
}

export interface PromptCacheEntry {
  readonly key: string;
  readonly adapterId: string;
  readonly model: string;
  /** Opaque Provider resource name. Never contains prompt content or credentials. */
  readonly resource: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly cachedInputTokens?: number;
}

export interface PromptCacheStore {
  get(key: string): Promise<PromptCacheEntry | undefined>;
  set(entry: PromptCacheEntry): Promise<void>;
  delete(key: string): Promise<void>;
}

export type ModelContentPart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "media";
      readonly mimeType: string;
      readonly data: string;
      readonly name?: string;
    };

export interface ModelToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
  /** Opaque, bounded state that an Adapter must receive unchanged on the next model turn. */
  readonly providerMetadata?: Readonly<Record<string, unknown>>;
}

export interface ModelToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | readonly ModelContentPart[];
  toolCalls?: readonly ModelToolCall[];
  toolCallId?: string;
  name?: string;
}

export interface ModelRequest {
  model: string;
  messages: readonly ModelMessage[];
  baseUrl?: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  responseSchema?: Readonly<Record<string, unknown>>;
  tools?: readonly ModelToolDefinition[];
  promptCache?: PromptCacheRequest;
}

export interface AdapterContext {
  signal: AbortSignal;
  resolveSecret(reference: string): string | undefined;
  /** Host-supplied outbound boundary. Node hosts use DNS validation and connection pinning. */
  fetch?(url: string | URL, init?: RequestInit): Promise<Response>;
  /** Optional persistent registry for Provider-managed explicit cache resources. */
  promptCache?: PromptCacheStore;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
}

export type FinishReason = "stop" | "length" | "tool" | "error" | "unknown";

export type ModelEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; call: ModelToolCall }
  | { type: "usage"; usage: TokenUsage }
  | { type: "cache"; status: PromptCacheStatus; mode: PromptCacheMode; cachedInputTokens?: number; cacheWriteInputTokens?: number; reason?: string }
  | { type: "finish"; reason: FinishReason; model?: string };

export interface ModelAdapter {
  id: string;
  capabilities: AdapterCapabilities;
  requiredCredentials?: readonly string[];
  run(request: ModelRequest, context: AdapterContext): AsyncIterable<ModelEvent>;
}

export interface AdapterErrorOptions {
  adapterId: string;
  code: string;
  status?: number;
  requestId?: string;
  retryable?: boolean;
  cause?: unknown;
}

export class AdapterError extends Error {
  readonly adapterId: string;
  readonly code: string;
  readonly status: number | undefined;
  readonly requestId: string | undefined;
  readonly retryable: boolean;

  constructor(message: string, options: AdapterErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AdapterError";
    this.adapterId = options.adapterId;
    this.code = options.code;
    this.status = options.status;
    this.requestId = options.requestId;
    this.retryable = options.retryable ?? false;
  }
}

const ADAPTER_ID = /^[a-z][a-z0-9._-]*$/;

export class AdapterRegistry {
  readonly #adapters = new Map<string, ModelAdapter>();

  register(adapter: ModelAdapter): this {
    if (!adapter || typeof adapter !== "object" || !ADAPTER_ID.test(adapter.id)) {
      throw new AdapterError("Adapter id must use lowercase letters, numbers, '.', '_' or '-'", {
        adapterId: typeof adapter?.id === "string" ? adapter.id : "unknown",
        code: "ADAPTER_INVALID",
      });
    }
    if (this.#adapters.has(adapter.id)) {
      throw new AdapterError(`Adapter '${adapter.id}' is already registered`, {
        adapterId: adapter.id,
        code: "ADAPTER_DUPLICATE",
      });
    }
    const capabilities = adapter.capabilities;
    if (!capabilities || typeof capabilities.streaming !== "boolean"
      || typeof capabilities.json !== "boolean" || typeof capabilities.cancellation !== "boolean"
      || (capabilities.inputMedia !== undefined && (!Array.isArray(capabilities.inputMedia)
        || capabilities.inputMedia.some((kind) => !["image", "audio", "video", "pdf"].includes(kind))))
      || (capabilities.promptCaching !== undefined && (!Array.isArray(capabilities.promptCaching)
        || capabilities.promptCaching.some((mode) => !["automatic", "explicit"].includes(mode))))
      || (adapter.requiredCredentials !== undefined
        && (!Array.isArray(adapter.requiredCredentials)
          || adapter.requiredCredentials.some((reference) => typeof reference !== "string")))
      || typeof adapter.run !== "function") {
      throw new AdapterError(`Adapter '${adapter.id}' does not implement the ModelAdapter contract`, {
        adapterId: adapter.id,
        code: "ADAPTER_INVALID",
      });
    }
    this.#adapters.set(adapter.id, adapter);
    return this;
  }

  has(id: string): boolean {
    return this.#adapters.has(id);
  }

  get(id: string): ModelAdapter {
    const adapter = this.#adapters.get(id);
    if (!adapter) {
      throw new AdapterError(`Adapter '${id}' is not registered`, {
        adapterId: id,
        code: "ADAPTER_NOT_FOUND",
      });
    }
    return adapter;
  }

  list(): readonly ModelAdapter[] {
    return [...this.#adapters.values()];
  }
}
