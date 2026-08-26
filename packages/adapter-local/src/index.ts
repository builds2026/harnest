import { AdapterError, parseNdjson, readBoundedResponseText } from "@harnestai/core";
import type {
  AdapterContext,
  ModelAdapter,
  ModelEvent,
  ModelRequest,
  ModelContentPart,
  TokenUsage,
} from "@harnestai/core";

const DEFAULT_BASE_URL = "http://localhost:11434/";
const DEFAULT_API_KEY = "env:OLLAMA_API_KEY";
const MAX_PROVIDER_TOOL_CALLS = 128;
const MAX_TOOL_ARGUMENT_BYTES = 1_048_576;

export interface OllamaAdapterOptions {
  readonly id?: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
}

const localContent = (content: string | readonly ModelContentPart[]) => typeof content === "string"
  ? { content }
  : {
      content: content.filter((part) => part.type === "text").map((part) => part.text).join("\n"),
      images: content.filter((part): part is Extract<ModelContentPart, { type: "media" }> => part.type === "media" && part.mimeType.startsWith("image/"))
        .map((part) => part.data),
    };

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

function boundedToolInput(value: unknown, adapterId: string): unknown {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (cause) {
    throw new AdapterError("Ollama returned non-serializable Tool arguments", {
      adapterId,
      code: "invalid_tool_call",
      cause,
    });
  }
  if (serialized === undefined || new TextEncoder().encode(serialized).byteLength > MAX_TOOL_ARGUMENT_BYTES) {
    throw new AdapterError(`Ollama Tool arguments exceed the ${MAX_TOOL_ARGUMENT_BYTES}-byte limit`, {
      adapterId,
      code: "provider_response_limit",
    });
  }
  return value;
}

async function throwHttpError(response: Response, adapterId: string): Promise<never> {
  let message = `${adapterId} request failed with HTTP ${response.status}`;
  try {
    const text = await readBoundedResponseText(response);
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
  const contextOverflow = /(?:maximum context|context (?:length|window)|prompt (?:is )?too long|too many tokens|(?:input|prompt|token).*(?:exceed|limit|maximum))/iu.test(message);
  throw new AdapterError(message, {
    adapterId,
    code: contextOverflow ? "context_overflow" : `http_${response.status}`,
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

function providerMessages(request: ModelRequest): unknown[] {
  return request.messages.map((message) => {
    if (message.role === "assistant" && message.toolCalls?.length) return {
      role: "assistant",
      ...localContent(message.content),
      tool_calls: message.toolCalls.map((call) => ({
        function: { name: call.name, arguments: call.input },
      })),
    };
    if (message.role === "tool") return { role: "tool", ...localContent(message.content), tool_name: message.name };
    return { role: message.role, ...localContent(message.content) };
  });
}

export function createOllamaAdapter(options: OllamaAdapterOptions = {}): ModelAdapter {
  const id = options.id ?? "ollama";
  const credential = options.apiKey ?? DEFAULT_API_KEY;
  let requestSequence = 0;

  return {
    id,
    capabilities: {
      streaming: true,
      json: true,
      cancellation: true,
      tools: true,
      inputMedia: ["image"],
      promptCaching: ["automatic"],
    },
    requiredCredentials: options.apiKey?.startsWith("env:") ? [options.apiKey] : [],
    async *run(request: ModelRequest, context: AdapterContext): AsyncIterable<ModelEvent> {
      const requestId = requestSequence += 1;
      const apiKey = context.resolveSecret(request.apiKey ?? credential);
      if (request.promptCache) yield {
        type: "cache",
        status: "provider-managed",
        mode: "automatic",
        reason: "Ollama manages its KV cache without portable hit-token telemetry",
      };
      const modelOptions = {
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.maxTokens === undefined ? {} : { num_predict: request.maxTokens }),
      };
      const body = {
        model: request.model,
        messages: providerMessages(request),
        stream: true,
        ...(request.tools?.length ? {
          tools: request.tools.map((tool) => ({
            type: "function",
            function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
          })),
        } : {}),
        ...(Object.keys(modelOptions).length === 0 ? {} : { options: modelOptions }),
        ...(request.responseSchema === undefined ? {} : { format: request.responseSchema }),
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
      const toolCalls: Array<{ id: string; name: string; input: unknown }> = [];
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
          throw new AdapterError(providerError, {
            adapterId: id,
            code: /(?:maximum context|context (?:length|window)|prompt (?:is )?too long|too many tokens|(?:input|prompt|token).*(?:exceed|limit|maximum))/iu.test(providerError)
              ? "context_overflow" : "provider_error",
          });
        }
        if (typeof root.model === "string") model = root.model;
        const message = asRecord(root.message);
        if (typeof message?.content === "string" && message.content.length > 0) {
          yield { type: "text-delta", text: message.content };
        }
        const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
        for (const callValue of calls) {
          if (toolCalls.length >= MAX_PROVIDER_TOOL_CALLS) throw new AdapterError(
            `Ollama exceeded the ${MAX_PROVIDER_TOOL_CALLS} Tool-call limit`,
            { adapterId: id, code: "provider_response_limit" },
          );
          const call = asRecord(callValue);
          const fn = asRecord(call?.function);
          if (typeof fn?.name !== "string") throw new AdapterError("Ollama returned an invalid Tool call", {
            adapterId: id,
            code: "invalid_tool_call",
          });
          toolCalls.push({
            id: typeof call?.id === "string" ? call.id : `ollama-${requestId}-${toolCalls.length + 1}`,
            name: fn.name,
            input: boundedToolInput(fn.arguments ?? {}, id),
          });
        }
        if (root.done === true) {
          reason = mapFinishReason(root.done_reason);
          finalUsage = usage(root);
          break;
        }
      }

      if (finalUsage) yield { type: "usage", usage: finalUsage };
      if (!reason) throw new AdapterError("Ollama stream ended without a finish marker", {
        adapterId: id,
        code: "invalid_stream",
      });
      for (const call of toolCalls) yield { type: "tool-call", call };
      yield { ...reason, model };
    },
  };
}

export const createLocalAdapter = createOllamaAdapter;
export const adapter = createOllamaAdapter();
export const ollamaAdapter = adapter;
export const localAdapter = adapter;
export default adapter;
