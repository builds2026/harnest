import { AdapterError, parseSse } from "@harnest/core";
import type {
  AdapterContext,
  ModelAdapter,
  ModelEvent,
  ModelRequest,
  TokenUsage,
} from "@harnest/core";

const DEFAULT_BASE_URL = "https://api.openai.com/v1/";
const DEFAULT_API_KEY = "env:OPENAI_API_KEY";

export interface OpenAICompatibleAdapterOptions {
  readonly id?: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
}

function endpoint(baseUrl: string): URL {
  return new URL("chat/completions", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function tokenUsage(value: unknown): TokenUsage | undefined {
  const usage = asRecord(value);
  if (!usage) return undefined;

  const inputTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined;
  const outputTokens =
    typeof usage.completion_tokens === "number" ? usage.completion_tokens : undefined;
  const totalTokens = typeof usage.total_tokens === "number" ? usage.total_tokens : undefined;
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }

  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
}

function finishReason(value: unknown): ModelEvent & { type: "finish" } {
  const reason =
    value === "stop"
      ? "stop"
      : value === "length"
        ? "length"
        : value === "tool_calls" || value === "function_call"
          ? "tool"
          : "unknown";
  return { type: "finish", reason };
}

function providerMessage(value: unknown): string | undefined {
  const payload = asRecord(value);
  const error = asRecord(payload?.error);
  return typeof error?.message === "string" ? error.message : undefined;
}

async function throwHttpError(response: Response, adapterId: string): Promise<never> {
  const requestId = response.headers.get("x-request-id") ?? undefined;
  let message = `${adapterId} request failed with HTTP ${response.status}`;
  try {
    const parsed: unknown = JSON.parse(await response.text());
    message = providerMessage(parsed) ?? message;
  } catch {
    // The status still provides a stable normalized error when the body is not JSON.
  }

  throw new AdapterError(message, {
    adapterId,
    code: `http_${response.status}`,
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

export function createOpenAICompatibleAdapter(
  options: OpenAICompatibleAdapterOptions = {},
): ModelAdapter {
  const id = options.id ?? "openai";
  const credential = options.apiKey ?? DEFAULT_API_KEY;

  return {
    id,
    capabilities: { streaming: true, json: true, cancellation: true },
    requiredCredentials: credential.startsWith("env:") ? [credential] : [],
    async *run(request: ModelRequest, context: AdapterContext): AsyncIterable<ModelEvent> {
      const apiKey = context.resolveSecret(request.apiKey ?? credential);
      const body: Record<string, unknown> = {
        model: request.model,
        messages: request.messages,
        stream: true,
        stream_options: { include_usage: true },
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
        ...(request.responseSchema === undefined
          ? {}
          : {
              response_format: {
                type: "json_schema",
                json_schema: {
                  name: "response",
                  strict: true,
                  schema: request.responseSchema,
                },
              },
            }),
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
        throw new AdapterError("OpenAI-compatible request could not reach the provider", {
          adapterId: id,
          code: "network_error",
          retryable: true,
          cause,
        });
      }
      if (!response.ok) await throwHttpError(response, id);

      let reason: (ModelEvent & { type: "finish" }) | undefined;
      let model = request.model;
      for await (const event of parseSse(requireBody(response, id))) {
        if (event.data === "[DONE]") break;

        let payload: unknown;
        try {
          payload = JSON.parse(event.data);
        } catch (cause) {
          throw new AdapterError("OpenAI-compatible provider returned invalid SSE JSON", {
            adapterId: id,
            code: "invalid_stream",
            cause,
          });
        }

        const root = asRecord(payload);
        const errorMessage = providerMessage(root);
        if (errorMessage) {
          throw new AdapterError(errorMessage, { adapterId: id, code: "provider_error" });
        }
        if (typeof root?.model === "string") model = root.model;

        const usage = tokenUsage(root?.usage);
        if (usage) yield { type: "usage", usage };

        const choices = Array.isArray(root?.choices) ? root.choices : [];
        for (const choiceValue of choices) {
          const choice = asRecord(choiceValue);
          const delta = asRecord(choice?.delta);
          if (typeof delta?.content === "string" && delta.content.length > 0) {
            yield { type: "text-delta", text: delta.content };
          }
          if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
            reason = finishReason(choice.finish_reason);
          }
        }
      }

      if (!reason) throw new AdapterError("OpenAI-compatible stream ended without a finish reason", {
        adapterId: id,
        code: "invalid_stream",
      });
      yield { ...reason, model };
    },
  };
}

export const adapter = createOpenAICompatibleAdapter();
export const openAIAdapter = adapter;
export default adapter;
