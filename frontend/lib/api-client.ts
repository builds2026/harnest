import { classifyApiError, type ApiErrorCategory, type ApiErrorDetails, type ApiErrorResponse } from "./api";
import type { Translator } from "@/i18n/core";
import type { MessageKey } from "@/i18n/messages/en-US";

export class ClientApiError extends Error {
  constructor(readonly details: ApiErrorDetails, readonly status = 0) {
    super(details.message);
    this.name = "ClientApiError";
  }
}

const parseError = async (response: Response): Promise<ApiErrorDetails> => {
  const payload = await response.json().catch(() => null) as Partial<ApiErrorResponse> | null;
  const code = payload?.error?.code ?? `HTTP_${response.status}`;
  const classified = classifyApiError(code, response.status);
  return {
    code,
    message: payload?.error?.message ?? `Request failed with ${response.status}`,
    category: payload?.error?.category ?? classified.category,
    recoverable: payload?.error?.recoverable ?? classified.recoverable,
    action: payload?.error?.action ?? classified.action,
    retryAfterMs: payload?.error?.retryAfterMs,
  };
};

const fetchWithTimeout = async (input: RequestInfo | URL, init: RequestInit, timeoutMs: number) => {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  try {
    return await fetch(input, { ...init, signal });
  } catch (error) {
    if (init.signal?.aborted) {
      throw new ClientApiError({ code: "REQUEST_ABORTED", message: "The request was canceled.", category: "network", recoverable: true, action: "retry" });
    }
    if (timeout.aborted) {
      throw new ClientApiError({ code: "REQUEST_TIMEOUT", message: "The request timed out.", category: "timeout", recoverable: true, action: "retry" });
    }
    throw new ClientApiError({
      code: "NETWORK_ERROR",
      message: error instanceof Error ? error.message : "The network request failed.",
      category: "network",
      recoverable: true,
      action: "retry",
    });
  }
};

export async function requestJson<T>(
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: Readonly<{ timeoutMs?: number; retryGet?: boolean }> = {},
): Promise<T> {
  const method = (init.method ?? "GET").toLocaleUpperCase();
  const attempts = method === "GET" && options.retryGet !== false ? 2 : 1;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchWithTimeout(input, init, options.timeoutMs ?? 20_000);
      if (!response.ok) throw new ClientApiError(await parseError(response), response.status);
      if (response.status === 204) return undefined as T;
      return await response.json() as T;
    } catch (error) {
      lastError = error;
      if (attempt + 1 >= attempts || (error instanceof ClientApiError && error.details.category !== "network" && error.details.category !== "timeout" && error.status < 500)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError;
}

const ERROR_MESSAGE_KEYS: Readonly<Record<ApiErrorCategory, MessageKey>> = {
  validation: "api.error.validation",
  auth: "api.error.auth",
  permission: "api.error.permission",
  timeout: "api.error.timeout",
  network: "api.error.network",
  conflict: "api.error.conflict",
  server: "api.error.server",
};

export const apiErrorMessage = (error: unknown, fallback: string, t?: Translator) => {
  if (error instanceof ClientApiError) {
    if (!t) return error.message;
    if (error.details.code === "REQUEST_ABORTED") return t("api.error.aborted");
    return t(ERROR_MESSAGE_KEYS[error.details.category ?? "server"]);
  }
  return error instanceof Error ? error.message : fallback;
};
