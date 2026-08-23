import { AdapterError, parseSse, readBoundedResponseText } from "@harnest/core";
import type {
  AdapterContext,
  ModelAdapter,
  ModelEvent,
  ModelRequest,
  TokenUsage,
} from "@harnest/core";

const DEFAULT_BASE_URL = "https://api.anthropic.com/";
const DEFAULT_API_KEY = "env:ANTHROPIC_API_KEY";
const MAX_PROVIDER_TOOL_CALLS = 128;
const MAX_TOOL_ARGUMENT_BYTES = 1_048_576;

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

function assertToolArgumentSize(value: unknown, adapterId: string): void {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (cause) {
    throw new AdapterError("Anthropic returned non-serializable Tool arguments", {
      adapterId,
      code: "invalid_tool_call",
      cause,
    });
  }
  if (serialized !== undefined && new TextEncoder().encode(serialized).byteLength > MAX_TOOL_ARGUMENT_BYTES) {
    throw new AdapterError(`Anthropic Tool arguments exceed the ${MAX_TOOL_ARGUMENT_BYTES}-byte limit`, {
      adapterId,
      code: "provider_response_limit",
    });
  }
}

async function throwHttpError(response: Response, adapterId: string): Promise<never> {
  const requestId = response.headers.get("request-id") ?? undefined;
  let message = `${adapterId} request failed with HTTP ${response.status}`;
  let code = `http_${response.status}`;
  try {
    const details = errorDetails(JSON.parse(await readBoundedResponseText(response)) as unknown);
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

function providerMessages(request: ModelRequest): Array<{ role: "user" | "assistant"; content: unknown }> {
  const nonSystem = request.messages.filter((message) => message.role !== "system");
  if (!nonSystem.some((message) => message.role === "tool" || message.toolCalls?.length)) {
    return nonSystem.map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content,
    }));
  }
  const result: Array<{ role: "user" | "assistant"; content: unknown[] }> = [];
  for (const message of request.messages) {
    if (message.role === "system") continue;
    const role = message.role === "assistant" ? "assistant" : "user";
    const content = message.role === "tool"
      ? [{ type: "tool_result", tool_use_id: message.toolCallId, content: message.content }]
      : [
          ...(message.content ? [{ type: "text", text: message.content }] : []),
          ...(message.role === "assistant" ? (message.toolCalls ?? []).map((call) => ({
            type: "tool_use",
            id: call.id,
            name: call.name,
            input: call.input,
          })) : []),
        ];
    const previous = result.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else result.push({ role, content });
  }
  return result;
}

export function createAnthropicAdapter(options: AnthropicAdapterOptions = {}): ModelAdapter {
  const id = options.id ?? "anthropic";
  const credential = options.apiKey ?? DEFAULT_API_KEY;

  return {
    id,
    capabilities: { streaming: true, json: false, cancellation: true, tools: true },
    requiredCredentials: credential.startsWith("env:") ? [credential] : [],
    async *run(request: ModelRequest, context: AdapterContext): AsyncIterable<ModelEvent> {
      const apiKey = context.resolveSecret(request.apiKey ?? credential);
      const system = request.messages
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n\n");
      const messages = providerMessages(request);
      const body = {
        model: request.model,
        max_tokens: request.maxTokens ?? 1024,
        messages,
        stream: true,
        ...(request.tools?.length ? {
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
          })),
        } : {}),
        ...(system.length === 0 ? {} : { system }),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      };

      let response: Response;
      try {
        response = await (context.fetch ?? fetch)(endpoint(request.baseUrl ?? options.baseUrl ?? DEFAULT_BASE_URL), {
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
      const toolCalls = new Map<number, {
        id: string;
        name: string;
        initial: unknown;
        partial: string;
        partialBytes: number;
      }>();
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
        } else if (type === "content_block_start") {
          const block = asRecord(root?.content_block);
          if (block?.type === "tool_use" && typeof root?.index === "number"
            && typeof block.id === "string" && typeof block.name === "string") {
            if (!toolCalls.has(root.index) && toolCalls.size >= MAX_PROVIDER_TOOL_CALLS) throw new AdapterError(
              `Anthropic exceeded the ${MAX_PROVIDER_TOOL_CALLS} Tool-call limit`,
              { adapterId: id, code: "provider_response_limit" },
            );
            assertToolArgumentSize(block.input, id);
            toolCalls.set(root.index, {
              id: block.id,
              name: block.name,
              initial: block.input,
              partial: "",
              partialBytes: 0,
            });
          }
        } else if (type === "content_block_delta") {
          const delta = asRecord(root?.delta);
          if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
            yield { type: "text-delta", text: delta.text };
          } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string"
            && typeof root?.index === "number") {
            const call = toolCalls.get(root.index);
            if (!call) throw new AdapterError("Anthropic returned Tool arguments before Tool metadata", {
              adapterId: id,
              code: "invalid_tool_call",
            });
            call.partialBytes += new TextEncoder().encode(delta.partial_json).byteLength;
            if (call.partialBytes > MAX_TOOL_ARGUMENT_BYTES) throw new AdapterError(
              `Anthropic Tool arguments exceed the ${MAX_TOOL_ARGUMENT_BYTES}-byte limit`,
              { adapterId: id, code: "provider_response_limit" },
            );
            call.partial += delta.partial_json;
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
      for (const call of toolCalls.values()) {
        let input: unknown = call.initial ?? {};
        if (call.partial) {
          try {
            input = JSON.parse(call.partial) as unknown;
            assertToolArgumentSize(input, id);
          } catch (cause) {
            throw new AdapterError("Anthropic returned invalid Tool arguments", {
              adapterId: id,
              code: "invalid_tool_call",
              cause,
            });
          }
        }
        yield { type: "tool-call", call: { id: call.id, name: call.name, input } };
      }
      yield { ...reason, model };
    },
  };
}

export const adapter = createAnthropicAdapter();
export const anthropicAdapter = adapter;
export default adapter;
