import { AdapterError, parseSse, readBoundedResponseText } from "@harnestai/core";
import type {
  AdapterContext,
  ModelAdapter,
  ModelEvent,
  ModelContentPart,
  ModelMessage,
  ModelRequest,
  PromptCacheEntry,
  TokenUsage,
} from "@harnestai/core";

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

const textContent = (content: string | readonly ModelContentPart[]): string => typeof content === "string"
  ? content : content.filter((part) => part.type === "text").map((part) => part.text).join("\n");

const contentParts = (content: string | readonly ModelContentPart[]): unknown[] => typeof content === "string"
  ? (content ? [{ text: content }] : [])
  : content.map((part) => part.type === "text"
    ? { text: part.text }
    : { inlineData: { mimeType: part.mimeType, data: part.data } });

function endpoint(baseUrl: string, version: string, model: string): URL {
  const modelId = model.startsWith("models/") ? model.slice("models/".length) : model;
  const path = `${version}/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`;
  return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
}

function cacheEndpoint(baseUrl: string, version: string, resource?: string): URL {
  const path = resource ? `${version}/${resource}` : `${version}/cachedContents`;
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
  const cachedInputTokens =
    typeof metadata.cachedContentTokenCount === "number" ? metadata.cachedContentTokenCount : undefined;
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
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
  const contextOverflow = /(?:maximum context|context (?:length|window)|prompt (?:is )?too long|too many tokens|(?:input|prompt|token).*(?:exceed|limit|maximum))/iu.test(message);
  throw new AdapterError(message, {
    adapterId,
    code: contextOverflow ? "context_overflow" : code,
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

function providerContents(messages: readonly ModelMessage[]): unknown[] {
  return messages
    .filter((message) => message.role !== "system")
    .map((message) => {
      if (message.role === "tool") return {
        role: "user",
        parts: [{
          functionResponse: {
            ...(message.toolCallId ? { id: message.toolCallId } : {}),
            name: message.name,
            response: { output: textContent(message.content) },
          },
        }],
      };
      return {
        role: message.role === "assistant" ? "model" : "user",
        parts: [
          ...contentParts(message.content),
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
    capabilities: {
      streaming: true,
      json: true,
      cancellation: true,
      tools: true,
      inputMedia: ["image", "audio", "video", "pdf"],
      promptCaching: ["automatic", "explicit"],
    },
    requiredCredentials: credential.startsWith("env:") ? [credential] : [],
    async *run(request: ModelRequest, context: AdapterContext): AsyncIterable<ModelEvent> {
      const requestId = requestSequence += 1;
      const apiKey = context.resolveSecret(request.apiKey ?? credential);
      const baseUrl = request.baseUrl ?? options.baseUrl ?? DEFAULT_BASE_URL;
      const apiVersion = options.apiVersion ?? "v1beta";
      const providerFetch = context.fetch ?? fetch;
      const headers = {
        "content-type": "application/json",
        ...(apiKey === undefined ? {} : { "x-goog-api-key": apiKey }),
      };
      const systemFor = (messages: readonly ModelMessage[]) => messages
        .filter((message) => message.role === "system")
        .map((message) => textContent(message.content))
        .join("\n\n");
      const providerTools = request.tools?.length ? [{ functionDeclarations: request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parametersJsonSchema: geminiToolSchema(tool.inputSchema),
      })) }] : undefined;
      const generationConfig = {
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.maxTokens === undefined ? {} : { maxOutputTokens: request.maxTokens }),
        ...(request.responseSchema === undefined || providerTools
          ? {}
          : { responseMimeType: "application/json", responseSchema: geminiToolSchema(request.responseSchema) }),
      };
      const regularBody = () => {
        const system = systemFor(request.messages);
        return {
          contents: providerContents(request.messages),
          ...(providerTools ? { tools: providerTools } : {}),
          ...(system.length === 0 ? {} : { systemInstruction: { parts: [{ text: system }] } }),
          ...(Object.keys(generationConfig).length === 0 ? {} : { generationConfig }),
        };
      };
      const send = (body: unknown) => providerFetch(endpoint(baseUrl, apiVersion, request.model), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: context.signal,
      });

      let explicitEntry: PromptCacheEntry | undefined;
      let cacheWriteInputTokens: number | undefined;
      if (request.promptCache?.mode === "explicit") {
        if (!context.promptCache) {
          yield { type: "cache", status: "bypass", mode: "explicit", reason: "The host has no prompt cache registry" };
        } else {
          const stored = await context.promptCache.get(request.promptCache.key);
          if (stored?.adapterId === id && stored.model === request.model) {
            explicitEntry = stored;
            yield {
              type: "cache",
              status: "hit",
              mode: "explicit",
              ...(stored.cachedInputTokens === undefined ? {} : { cachedInputTokens: stored.cachedInputTokens }),
            };
          } else {
            const prefix = request.messages.slice(0, request.promptCache.prefixMessageCount);
            const cacheSystem = systemFor(prefix);
            const cacheBody = {
              model: request.model.startsWith("models/") ? request.model : `models/${request.model}`,
              ...(providerContents(prefix).length ? { contents: providerContents(prefix) } : {}),
              ...(providerTools ? { tools: providerTools } : {}),
              ...(cacheSystem ? { systemInstruction: { parts: [{ text: cacheSystem }] } } : {}),
              ttl: "3600s",
            };
            let cacheResponse: Response;
            try {
              cacheResponse = await providerFetch(cacheEndpoint(baseUrl, apiVersion), {
                method: "POST",
                headers,
                body: JSON.stringify(cacheBody),
                signal: context.signal,
              });
            } catch (cause) {
              throw new AdapterError("Gemini explicit cache could not reach the provider", {
                adapterId: id,
                code: "network_error",
                retryable: true,
                cause,
              });
            }
            if (!cacheResponse.ok) {
              let cacheError: AdapterError | undefined;
              try { await throwHttpError(cacheResponse, id); } catch (cause) {
                cacheError = cause instanceof AdapterError ? cause : new AdapterError("Gemini cache creation failed", {
                  adapterId: id,
                  code: "provider_error",
                  cause,
                });
              }
              if (!cacheError) throw new AdapterError("Gemini cache creation failed", {
                adapterId: id,
                code: "provider_error",
              });
              if (cacheError.code === "context_overflow" || cacheError.retryable) throw cacheError;
              yield { type: "cache", status: "bypass", mode: "explicit", reason: cacheError.message };
            } else {
              let created: Record<string, unknown> | undefined;
              try { created = asRecord(JSON.parse(await readBoundedResponseText(cacheResponse)) as unknown); } catch { /* handled below */ }
              const resource = typeof created?.name === "string" && /^cachedContents\/[A-Za-z0-9._-]+$/u.test(created.name)
                ? created.name : undefined;
              const expiresAt = typeof created?.expireTime === "string" && Number.isFinite(Date.parse(created.expireTime))
                ? created.expireTime : new Date(Date.now() + 3_600_000).toISOString();
              const cacheUsage = asRecord(created?.usageMetadata);
              cacheWriteInputTokens = typeof cacheUsage?.totalTokenCount === "number"
                ? cacheUsage.totalTokenCount : undefined;
              if (!resource) throw new AdapterError("Gemini returned an invalid explicit cache resource", {
                adapterId: id,
                code: "invalid_response",
              });
              explicitEntry = {
                key: request.promptCache.key,
                adapterId: id,
                model: request.model,
                resource,
                createdAt: new Date().toISOString(),
                expiresAt,
                ...(cacheWriteInputTokens === undefined ? {} : { cachedInputTokens: cacheWriteInputTokens }),
              };
              await context.promptCache.set(explicitEntry);
              yield {
                type: "cache",
                status: "write",
                mode: "explicit",
                ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens }),
              };
            }
          }
        }
      }

      const explicitBody = explicitEntry && request.promptCache ? {
        cachedContent: explicitEntry.resource,
        contents: providerContents(request.messages.slice(request.promptCache.prefixMessageCount)),
        ...(Object.keys(generationConfig).length === 0 ? {} : { generationConfig }),
      } : undefined;

      let response: Response;
      try {
        response = await send(explicitBody ?? regularBody());
      } catch (cause) {
        throw new AdapterError("Gemini request could not reach the provider", {
          adapterId: id,
          code: "network_error",
          retryable: true,
          cause,
        });
      }
      if (response.status === 404 && explicitEntry && request.promptCache && context.promptCache) {
        await context.promptCache.delete(request.promptCache.key);
        yield { type: "cache", status: "bypass", mode: "explicit", reason: "The Provider cache expired; this request used the full prompt" };
        try { response = await send(regularBody()); } catch (cause) {
          throw new AdapterError("Gemini request could not reach the provider", {
            adapterId: id,
            code: "network_error",
            retryable: true,
            cause,
          });
        }
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
          const message = details.message ?? "Gemini stream failed";
          throw new AdapterError(message, {
            adapterId: id,
            code: /(?:maximum context|context (?:length|window)|prompt (?:is )?too long|too many tokens|(?:input|prompt|token).*(?:exceed|limit|maximum))/iu.test(message)
              ? "context_overflow" : details.code ?? "provider_error",
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

      if (cacheWriteInputTokens !== undefined) finalUsage = {
        ...(finalUsage ?? {}),
        inputTokens: (finalUsage?.inputTokens ?? 0) + cacheWriteInputTokens,
        totalTokens: (finalUsage?.totalTokens
          ?? (finalUsage?.inputTokens ?? 0) + (finalUsage?.outputTokens ?? 0)) + cacheWriteInputTokens,
        cacheWriteInputTokens,
      };
      if (finalUsage) yield { type: "usage", usage: finalUsage };
      if (request.promptCache?.mode === "automatic") yield {
        type: "cache",
        status: (finalUsage?.cachedInputTokens ?? 0) > 0 ? "hit" : "miss",
        mode: "automatic",
        ...(finalUsage?.cachedInputTokens === undefined ? {} : { cachedInputTokens: finalUsage.cachedInputTokens }),
      };
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
