import { AdapterError, parseNdjson } from "@harnest/core";
import type {
  AdapterContext,
  ModelAdapter,
  ModelEvent,
  ModelRequest,
  TokenUsage,
} from "@harnest/core";

const DEFAULT_BASE_URL = "http://localhost:11434/";
const DEFAULT_API_KEY = "env:OLLAMA_API_KEY";

export interface OllamaAdapterOptions {
  readonly id?: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function endpoint(baseUrl: string): URL {
  return new URL("api/chat", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
}

function mapFinishReason(value: unknown): ModelEvent & { type: "finish" } {
  return {
    type: "finish",
    reason: value === "stop" ? "stop" : value === "length" ? "length" : "unknown",
  };
}

function usage(value: Record<string, unknown>): TokenUsage | undefined {
  const inputTokens =
    typeof value.prompt_eval_count === "number" ? value.prompt_eval_count : undefined;
  const outputTokens = typeof value.eval_count === "number" ? value.eval_count : undefined;
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(inputTokens === undefined || outputTokens === undefined
      ? {}
      : { totalTokens: inputTokens + outputTokens }),
  };
}

function errorMessage(value: unknown): string | undefined {
  const root = asRecord(value);
  if (typeof root?.error === "string") return root.error;
  const error = asRecord(root?.error);
  return typeof error?.message === "string" ? error.message : undefined;
}

async function throwHttpError(response: Response, adapterId: string): Promise<never> {
  let message = `${adapterId} request failed with HTTP ${response.status}`;
  try {
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { error: text };
    }
    message = errorMessage(parsed) ?? message;
  } catch {
    // Keep the normalized HTTP fallback.
  }
  throw new AdapterError(message, {
    adapterId,
    code: `http_${response.status}`,
    status: response.status,
    retryable: response.status === 429 || response.status >= 500,
  });
}

function requireBody(response: Response, adapterId: string): ReadableStream<Uint8Array> {
  if (response.body) return response.body;
  throw new AdapterError(`${adapterId} returned an empty response body`, {
    adapterId,
    code: "empty_response",
  });
}

export function createOllamaAdapter(options: OllamaAdapterOptions = {}): ModelAdapter {
  const id = options.id ?? "ollama";
  const credential = options.apiKey ?? DEFAULT_API_KEY;

  return {
    id,
    capabilities: { streaming: true, json: true, cancellation: true },
    requiredCredentials: options.apiKey?.startsWith("env:") ? [options.apiKey] : [],
    async *run(request: ModelRequest, context: AdapterContext): AsyncIterable<ModelEvent> {
      const apiKey = context.resolveSecret(request.apiKey ?? credential);
      const modelOptions = {
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.maxTokens === undefined ? {} : { num_predict: request.maxTokens }),
      };
      const body = {
        model: request.model,
        messages: request.messages,
        stream: true,
        ...(Object.keys(modelOptions).length === 0 ? {} : { options: modelOptions }),
        ...(request.responseSchema === undefined ? {} : { format: request.responseSchema }),
      };
      let response: Response;
      try {
        response = await fetch(endpoint(request.baseUrl ?? options.baseUrl ?? DEFAULT_BASE_URL), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }),
          },
          body: JSON.stringify(body),
          signal: context.signal,
        });
      } catch (cause) {
        throw new AdapterError("Ollama request could not reach the provider", {
          adapterId: id,
          code: "network_error",
          retryable: true,
          cause,
        });
      }
      if (!response.ok) await throwHttpError(response, id);

      let reason: (ModelEvent & { type: "finish" }) | undefined;
      let finalUsage: TokenUsage | undefined;
      let model = request.model;
      for await (const value of parseNdjson(requireBody(response, id))) {
        const root = asRecord(value);
        if (!root) {
          throw new AdapterError("Ollama returned a non-object NDJSON record", {
            adapterId: id,
            code: "invalid_stream",
          });
        }
        const providerError = errorMessage(root);
        if (providerError) {
          throw new AdapterError(providerError, { adapterId: id, code: "provider_error" });
        }
        if (typeof root.model === "string") model = root.model;
        const message = asRecord(root.message);
        if (typeof message?.content === "string" && message.content.length > 0) {
          yield { type: "text-delta", text: message.content };
        }
        if (root.done === true) {
          reason = mapFinishReason(root.done_reason);
          finalUsage = usage(root);
        }
      }

      if (finalUsage) yield { type: "usage", usage: finalUsage };
      if (!reason) throw new AdapterError("Ollama stream ended without a finish marker", {
        adapterId: id,
        code: "invalid_stream",
      });
      yield { ...reason, model };
    },
  };
}

export const createLocalAdapter = createOllamaAdapter;
export const adapter = createOllamaAdapter();
export const ollamaAdapter = adapter;
export const localAdapter = adapter;
export default adapter;
