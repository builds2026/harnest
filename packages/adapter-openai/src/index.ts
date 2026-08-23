import { AdapterError, parseSse, readBoundedResponseText } from "@harnest/core";
import type {
  AdapterContext,
  ModelAdapter,
  ModelEvent,
  ModelRequest,
  TokenUsage,
} from "@harnest/core";

const DEFAULT_BASE_URL = "https://api.openai.com/v1/";
const DEFAULT_API_KEY = "env:OPENAI_API_KEY";
const MAX_PROVIDER_TOOL_CALLS = 128;
const MAX_TOOL_ARGUMENT_BYTES = 1_048_576;

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
    const parsed: unknown = JSON.parse(await readBoundedResponseText(response));
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

function messages(request: ModelRequest): unknown[] {
  return request.messages.map((message) => {
    if (message.role === "assistant" && message.toolCalls?.length) return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.input) },
      })),
    };
    if (message.role === "tool") return {
      role: "tool",
      content: message.content,
      tool_call_id: message.toolCallId,
    };
    return { role: message.role, content: message.content };
  });
}

export function createOpenAICompatibleAdapter(
  options: OpenAICompatibleAdapterOptions = {},
): ModelAdapter {
  const id = options.id ?? "openai";
  const credential = options.apiKey ?? DEFAULT_API_KEY;

  return {
    id,
    capabilities: { streaming: true, json: true, cancellation: true, tools: true },
    requiredCredentials: credential.startsWith("env:") ? [credential] : [],
    async *run(request: ModelRequest, context: AdapterContext): AsyncIterable<ModelEvent> {
      const apiKey = context.resolveSecret(request.apiKey ?? credential);
      const body: Record<string, unknown> = {
        model: request.model,
        messages: messages(request),
        stream: true,
        stream_options: { include_usage: true },
        ...(request.tools?.length ? {
          tools: request.tools.map((tool) => ({
            type: "function",
            function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
          })),
        } : {}),
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
        response = await (context.fetch ?? fetch)(endpoint(request.baseUrl ?? options.baseUrl ?? DEFAULT_BASE_URL), {
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
      const toolCalls = new Map<string, { id: string; name: string; arguments: string; argumentBytes: number }>();
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
          const deltas = Array.isArray(delta?.tool_calls) ? delta.tool_calls : [];
          for (let deltaIndex = 0; deltaIndex < deltas.length; deltaIndex += 1) {
            const value = deltas[deltaIndex];
            const call = asRecord(value);
            const fn = asRecord(call?.function);
            const choiceKey = typeof choice?.index === "number" ? choice.index : 0;
            const callKey = typeof call?.index === "number" ? `index:${call.index}`
              : typeof call?.id === "string" && call.id ? `id:${call.id}` : `position:${deltaIndex}`;
            const key = `${choiceKey}:${callKey}`;
            let current = toolCalls.get(key);
            if (!current) {
              if (toolCalls.size >= MAX_PROVIDER_TOOL_CALLS) throw new AdapterError(
                `OpenAI-compatible provider exceeded the ${MAX_PROVIDER_TOOL_CALLS} Tool-call limit`,
                { adapterId: id, code: "provider_response_limit" },
              );
              current = { id: "", name: "", arguments: "", argumentBytes: 0 };
              toolCalls.set(key, current);
            }
            if (typeof call?.id === "string") current.id += call.id;
            if (typeof fn?.name === "string") current.name += fn.name;
            if (typeof fn?.arguments === "string") {
              current.argumentBytes += new TextEncoder().encode(fn.arguments).byteLength;
              if (current.argumentBytes > MAX_TOOL_ARGUMENT_BYTES) throw new AdapterError(
                `OpenAI-compatible Tool arguments exceed the ${MAX_TOOL_ARGUMENT_BYTES}-byte limit`,
                { adapterId: id, code: "provider_response_limit" },
              );
              current.arguments += fn.arguments;
            }
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
      for (const call of toolCalls.values()) {
        if (!call.id || !call.name) throw new AdapterError("OpenAI-compatible provider returned an incomplete Tool call", {
          adapterId: id,
          code: "invalid_tool_call",
        });
        let input: unknown;
        try {
          input = call.arguments ? JSON.parse(call.arguments) as unknown : {};
        } catch (cause) {
          throw new AdapterError("OpenAI-compatible provider returned invalid Tool arguments", {
            adapterId: id,
            code: "invalid_tool_call",
            cause,
          });
        }
        yield { type: "tool-call", call: { id: call.id, name: call.name, input } };
      }
      yield { ...reason, model };
    },
  };
}

export const adapter = createOpenAICompatibleAdapter();
export const openAIAdapter = adapter;
export default adapter;
