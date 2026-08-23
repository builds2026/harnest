import { AdapterError, parseSse, readBoundedResponseText } from "@harnest/core";
import type {
  AdapterContext,
  ModelAdapter,
  ModelEvent,
  ModelRequest,
  TokenUsage,
} from "@harnest/core";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/";
const DEFAULT_API_KEY = "env:GEMINI_API_KEY";
const MAX_PROVIDER_TOOL_CALLS = 128;
const MAX_TOOL_ARGUMENT_BYTES = 1_048_576;

export interface GeminiAdapterOptions {
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

function endpoint(baseUrl: string, version: string, model: string): URL {
  const modelId = model.startsWith("models/") ? model.slice("models/".length) : model;
  const path = `${version}/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`;
  return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
}

function mapFinishReason(value: unknown): ModelEvent & { type: "finish" } {
  const reason =
    value === "STOP"
      ? "stop"
      : value === "MAX_TOKENS"
        ? "length"
        : value === "SAFETY" ||
            value === "RECITATION" ||
            value === "BLOCKLIST" ||
            value === "PROHIBITED_CONTENT" ||
            value === "SPII"
          ? "error"
          : "unknown";
  return { type: "finish", reason };
}

function usage(value: unknown): TokenUsage | undefined {
  const metadata = asRecord(value);
  if (!metadata) return undefined;
  const inputTokens =
    typeof metadata.promptTokenCount === "number" ? metadata.promptTokenCount : undefined;
  const outputTokens =
    typeof metadata.candidatesTokenCount === "number" ? metadata.candidatesTokenCount : undefined;
  const totalTokens =
    typeof metadata.totalTokenCount === "number" ? metadata.totalTokenCount : undefined;
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
}

function errorDetails(value: unknown): { message?: string; code?: string } {
  const root = asRecord(value);
  const error = asRecord(root?.error);
  return {
    ...(typeof error?.message === "string" ? { message: error.message } : {}),
    ...(typeof error?.status === "string" ? { code: error.status } : {}),
  };
}

function boundedToolInput(value: unknown, adapterId: string): unknown {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (cause) {
    throw new AdapterError("Gemini returned non-serializable Tool arguments", {
      adapterId,
      code: "invalid_tool_call",
      cause,
    });
  }
  if (serialized === undefined || new TextEncoder().encode(serialized).byteLength > MAX_TOOL_ARGUMENT_BYTES) {
    throw new AdapterError(`Gemini Tool arguments exceed the ${MAX_TOOL_ARGUMENT_BYTES}-byte limit`, {
      adapterId,
      code: "provider_response_limit",
    });
  }
  return value;
}

async function throwHttpError(response: Response, adapterId: string): Promise<never> {
  const requestId = response.headers.get("x-request-id") ?? undefined;
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

function providerContents(request: ModelRequest): unknown[] {
  return request.messages
    .filter((message) => message.role !== "system")
    .map((message) => {
      if (message.role === "tool") return {
        role: "user",
        parts: [{
          functionResponse: {
            ...(message.toolCallId ? { id: message.toolCallId } : {}),
            name: message.name,
            response: { output: message.content },
          },
        }],
      };
      return {
        role: message.role === "assistant" ? "model" : "user",
        parts: [
          ...(message.content ? [{ text: message.content }] : []),
          ...(message.role === "assistant" ? (message.toolCalls ?? []).map((call) => {
            const metadata = asRecord(call.providerMetadata);
            return {
              functionCall: { id: call.id, name: call.name, args: call.input },
              ...(typeof metadata?.thoughtSignature === "string"
                ? { thoughtSignature: metadata.thoughtSignature }
                : {}),
            };
          }) : []),
        ],
      };
    });
}

const SCHEMA_MAP_KEYWORDS = new Set([
  "$defs", "definitions", "dependentSchemas", "dependencies", "patternProperties", "properties",
]);
const SCHEMA_LITERAL_KEYWORDS = new Set([
  "const", "default", "dependentRequired", "discriminator", "enum", "example", "examples", "externalDocs", "xml",
]);

function geminiToolSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(geminiToolSchema);
  const record = asRecord(value);
  if (!record) return value;
  // Gemini currently rejects this valid JSON Schema keyword in function declarations;
  // Harnest still enforces the original schema before executing the Tool.
  return Object.fromEntries(Object.entries(record)
    .filter(([key]) => key !== "additionalProperties")
    .map(([key, entry]) => {
      const entries = SCHEMA_MAP_KEYWORDS.has(key) ? asRecord(entry) : undefined;
      if (entries) return [key, Object.fromEntries(Object.entries(entries)
        .map(([name, schema]) => [name, Array.isArray(schema) ? schema : geminiToolSchema(schema)]))];
      return [key, SCHEMA_LITERAL_KEYWORDS.has(key) || key.startsWith("x-") ? entry : geminiToolSchema(entry)];
    }));
}

export function createGeminiAdapter(options: GeminiAdapterOptions = {}): ModelAdapter {
  const id = options.id ?? "gemini";
  const credential = options.apiKey ?? DEFAULT_API_KEY;
  let requestSequence = 0;

  return {
    id,
    capabilities: { streaming: true, json: true, cancellation: true, tools: true },
    requiredCredentials: credential.startsWith("env:") ? [credential] : [],
    async *run(request: ModelRequest, context: AdapterContext): AsyncIterable<ModelEvent> {
      const requestId = requestSequence += 1;
      const apiKey = context.resolveSecret(request.apiKey ?? credential);
      const system = request.messages
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n\n");
      const contents = providerContents(request);
      const generationConfig = {
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.maxTokens === undefined ? {} : { maxOutputTokens: request.maxTokens }),
        ...(request.responseSchema === undefined
          ? {}
          : { responseMimeType: "application/json", responseSchema: request.responseSchema }),
      };
      const body = {
        contents,
        ...(request.tools?.length ? {
          tools: [{ functionDeclarations: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parametersJsonSchema: geminiToolSchema(tool.inputSchema),
          })) }],
        } : {}),
        ...(system.length === 0 ? {} : { systemInstruction: { parts: [{ text: system }] } }),
        ...(Object.keys(generationConfig).length === 0 ? {} : { generationConfig }),
      };

      let response: Response;
      try {
        response = await (context.fetch ?? fetch)(
          endpoint(
            request.baseUrl ?? options.baseUrl ?? DEFAULT_BASE_URL,
            options.apiVersion ?? "v1beta",
            request.model,
          ),
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(apiKey === undefined ? {} : { "x-goog-api-key": apiKey }),
            },
            body: JSON.stringify(body),
            signal: context.signal,
          },
        );
      } catch (cause) {
        throw new AdapterError("Gemini request could not reach the provider", {
          adapterId: id,
          code: "network_error",
          retryable: true,
          cause,
        });
      }
      if (!response.ok) await throwHttpError(response, id);

      let reason: (ModelEvent & { type: "finish" }) | undefined;
      let finalUsage: TokenUsage | undefined;
      const toolCalls = new Map<string, { id: string; name: string; input: unknown }>();
      for await (const event of parseSse(requireBody(response, id))) {
        let payload: unknown;
        try {
          payload = JSON.parse(event.data);
        } catch (cause) {
          throw new AdapterError("Gemini returned invalid SSE JSON", {
            adapterId: id,
            code: "invalid_stream",
            cause,
          });
        }
        const root = asRecord(payload);
        if (root?.error !== undefined) {
          const details = errorDetails(root);
          throw new AdapterError(details.message ?? "Gemini stream failed", {
            adapterId: id,
            code: details.code ?? "provider_error",
          });
        }

        const candidates = Array.isArray(root?.candidates) ? root.candidates : [];
        for (const candidateValue of candidates) {
          const candidate = asRecord(candidateValue);
          const content = asRecord(candidate?.content);
          const parts = Array.isArray(content?.parts) ? content.parts : [];
          for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
            const partValue = parts[partIndex];
            const part = asRecord(partValue);
            if (typeof part?.text === "string" && part.text.length > 0) {
              yield { type: "text-delta", text: part.text };
            }
            const call = asRecord(part?.functionCall);
            if (typeof call?.name === "string") {
              const key = typeof call.id === "string" ? call.id : `${candidates.indexOf(candidateValue)}:${partIndex}:${call.name}`;
              if (!toolCalls.has(key) && toolCalls.size >= MAX_PROVIDER_TOOL_CALLS) throw new AdapterError(
                `Gemini exceeded the ${MAX_PROVIDER_TOOL_CALLS} Tool-call limit`,
                { adapterId: id, code: "provider_response_limit" },
              );
              toolCalls.set(key, {
                id: typeof call.id === "string" ? call.id : `gemini-${requestId}-${key}`,
                name: call.name,
                input: boundedToolInput(call.args ?? {}, id),
                ...(typeof part?.thoughtSignature === "string"
                  ? { providerMetadata: boundedToolInput({ thoughtSignature: part.thoughtSignature }, id) as Readonly<Record<string, unknown>> }
                  : {}),
              });
            }
          }
          if (candidate?.finishReason !== undefined) reason = mapFinishReason(candidate.finishReason);
        }
        finalUsage = usage(root?.usageMetadata) ?? finalUsage;
      }

      if (finalUsage) yield { type: "usage", usage: finalUsage };
      if (!reason) throw new AdapterError("Gemini stream ended without a finish reason", {
        adapterId: id,
        code: "invalid_stream",
      });
      for (const call of toolCalls.values()) yield { type: "tool-call", call };
      yield { ...reason, model: request.model };
    },
  };
}

export const adapter = createGeminiAdapter();
export const geminiAdapter = adapter;
export default adapter;
