import { AdapterError, parseSse } from "@harnest/core";
import type {
  AdapterContext,
  ModelAdapter,
  ModelEvent,
  ModelRequest,
  TokenUsage,
} from "@harnest/core";

const DEFAULT_BASE_URL = "https://api.anthropic.com/";
const DEFAULT_API_KEY = "env:ANTHROPIC_API_KEY";

export interface AnthropicAdapterOptions {
  readonly id?: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly apiVersion?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function endpoint(baseUrl: string): URL {
  return new URL("v1/messages", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
}

function mapFinishReason(value: unknown): ModelEvent & { type: "finish" } {
  const reason =
    value === "end_turn" || value === "stop_sequence" || value === "pause_turn"
      ? "stop"
      : value === "max_tokens"
        ? "length"
        : value === "tool_use"
          ? "tool"
          : value === "refusal"
            ? "error"
            : "unknown";
  return { type: "finish", reason };
}

function errorDetails(value: unknown): { message?: string; code?: string } {
  const root = asRecord(value);
  const error = asRecord(root?.error);
  return {
    ...(typeof error?.message === "string" ? { message: error.message } : {}),
    ...(typeof error?.type === "string" ? { code: error.type } : {}),
  };
}

async function throwHttpError(response: Response, adapterId: string): Promise<never> {
  const requestId = response.headers.get("request-id") ?? undefined;
  let message = `${adapterId} request failed with HTTP ${response.status}`;
  let code = `http_${response.status}`;
  try {
    const details = errorDetails(JSON.parse(await response.text()) as unknown);
    message = details.message ?? message;
    code = details.code ?? code;
  } catch {
    // Keep the normalized HTTP fallback.
  }

  throw new AdapterError(message, {
    adapterId,
    code,
    status: response.status,
    retryable: response.status === 429 || response.status >= 500,
    ...(requestId === undefined ? {} : { requestId }),
  });
}

function requireBody(response: Response, adapterId: string): ReadableStream<Uint8Array> {
  if (response.body) return response.body;
  throw new AdapterError(`${adapterId} returned an empty response body`, {
    adapterId,
    code: "empty_response",
  });
}

function usage(inputTokens: number | undefined, outputTokens: number | undefined): TokenUsage | undefined {
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(inputTokens === undefined || outputTokens === undefined
      ? {}
      : { totalTokens: inputTokens + outputTokens }),
  };
}

export function createAnthropicAdapter(options: AnthropicAdapterOptions = {}): ModelAdapter {
  const id = options.id ?? "anthropic";
  const credential = options.apiKey ?? DEFAULT_API_KEY;

  return {
    id,
    capabilities: { streaming: true, json: false, cancellation: true },
    requiredCredentials: credential.startsWith("env:") ? [credential] : [],
    async *run(request: ModelRequest, context: AdapterContext): AsyncIterable<ModelEvent> {
      const apiKey = context.resolveSecret(request.apiKey ?? credential);
      const system = request.messages
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n\n");
      const messages = request.messages
        .filter((message) => message.role !== "system")
        .map(({ role, content }) => ({ role, content }));
      const body = {
        model: request.model,
        max_tokens: request.maxTokens ?? 1024,
        messages,
        stream: true,
        ...(system.length === 0 ? {} : { system }),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      };

      let response: Response;
      try {
        response = await fetch(endpoint(request.baseUrl ?? options.baseUrl ?? DEFAULT_BASE_URL), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "anthropic-version": options.apiVersion ?? "2023-06-01",
            ...(apiKey === undefined ? {} : { "x-api-key": apiKey }),
          },
          body: JSON.stringify(body),
          signal: context.signal,
        });
      } catch (cause) {
        throw new AdapterError("Anthropic request could not reach the provider", {
          adapterId: id,
          code: "network_error",
          retryable: true,
          cause,
        });
      }
      if (!response.ok) await throwHttpError(response, id);

      let reason: (ModelEvent & { type: "finish" }) | undefined;
      let model = request.model;
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      for await (const event of parseSse(requireBody(response, id))) {
        let payload: unknown;
        try {
          payload = JSON.parse(event.data);
        } catch (cause) {
          throw new AdapterError("Anthropic returned invalid SSE JSON", {
            adapterId: id,
            code: "invalid_stream",
            cause,
          });
        }

        const root = asRecord(payload);
        const type = typeof root?.type === "string" ? root.type : event.event;
        if (type === "error") {
          const details = errorDetails(root);
          throw new AdapterError(details.message ?? "Anthropic stream failed", {
            adapterId: id,
            code: details.code ?? "provider_error",
          });
        }
        if (type === "message_start") {
          const message = asRecord(root?.message);
          const startUsage = asRecord(message?.usage);
          if (typeof message?.model === "string") model = message.model;
          if (typeof startUsage?.input_tokens === "number") inputTokens = startUsage.input_tokens;
        } else if (type === "content_block_delta") {
          const delta = asRecord(root?.delta);
          if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
            yield { type: "text-delta", text: delta.text };
          }
        } else if (type === "message_delta") {
          const delta = asRecord(root?.delta);
          const finalUsage = asRecord(root?.usage);
          if (typeof finalUsage?.output_tokens === "number") outputTokens = finalUsage.output_tokens;
          reason = mapFinishReason(delta?.stop_reason);
        } else if (type === "message_stop") {
          break;
        }
      }

      const finalUsage = usage(inputTokens, outputTokens);
      if (finalUsage) yield { type: "usage", usage: finalUsage };
      if (!reason) throw new AdapterError("Anthropic stream ended without a finish reason", {
        adapterId: id,
        code: "invalid_stream",
      });
      yield { ...reason, model };
    },
  };
}

export const adapter = createAnthropicAdapter();
export const anthropicAdapter = adapter;
export default adapter;
