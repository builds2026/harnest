import { AdapterError, parseSse } from "@harnest/core";
import type {
  AdapterContext,
  ModelAdapter,
  ModelEvent,
  ModelRequest,
  TokenUsage,
} from "@harnest/core";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/";
const DEFAULT_API_KEY = "env:GEMINI_API_KEY";

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

async function throwHttpError(response: Response, adapterId: string): Promise<never> {
  const requestId = response.headers.get("x-request-id") ?? undefined;
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

export function createGeminiAdapter(options: GeminiAdapterOptions = {}): ModelAdapter {
  const id = options.id ?? "gemini";
  const credential = options.apiKey ?? DEFAULT_API_KEY;

  return {
    id,
    capabilities: { streaming: true, json: true, cancellation: true },
    requiredCredentials: credential.startsWith("env:") ? [credential] : [],
    async *run(request: ModelRequest, context: AdapterContext): AsyncIterable<ModelEvent> {
      const apiKey = context.resolveSecret(request.apiKey ?? credential);
      const system = request.messages
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n\n");
      const contents = request.messages
        .filter((message) => message.role !== "system")
        .map((message) => ({
          role: message.role === "assistant" ? "model" : "user",
          parts: [{ text: message.content }],
        }));
      const generationConfig = {
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.maxTokens === undefined ? {} : { maxOutputTokens: request.maxTokens }),
        ...(request.responseSchema === undefined
          ? {}
          : { responseMimeType: "application/json", responseSchema: request.responseSchema }),
      };
      const body = {
        contents,
        ...(system.length === 0 ? {} : { systemInstruction: { parts: [{ text: system }] } }),
        ...(Object.keys(generationConfig).length === 0 ? {} : { generationConfig }),
      };

      let response: Response;
      try {
        response = await fetch(
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
          for (const partValue of parts) {
            const part = asRecord(partValue);
            if (typeof part?.text === "string" && part.text.length > 0) {
              yield { type: "text-delta", text: part.text };
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
      yield { ...reason, model: request.model };
    },
  };
}

export const adapter = createGeminiAdapter();
export const geminiAdapter = adapter;
export default adapter;
