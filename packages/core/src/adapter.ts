export interface AdapterCapabilities {
  streaming: boolean;
  json: boolean;
  cancellation: boolean;
}

export interface ModelMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelRequest {
  model: string;
  messages: readonly ModelMessage[];
  baseUrl?: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  responseSchema?: Readonly<Record<string, unknown>>;
}

export interface AdapterContext {
  signal: AbortSignal;
  resolveSecret(reference: string): string | undefined;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export type FinishReason = "stop" | "length" | "tool" | "error" | "unknown";

export type ModelEvent =
  | { type: "text-delta"; text: string }
  | { type: "usage"; usage: TokenUsage }
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
