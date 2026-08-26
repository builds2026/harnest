import "server-only";
import { timingSafeEqual } from "node:crypto";
import { hasLiteralStudioHost, isAllowedStudioHostname } from "./studio-host";
import { classifyApiError, type ApiErrorDetails } from "./api";

export class ApiRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly details: Partial<Pick<ApiErrorDetails, "category" | "recoverable" | "action" | "retryAfterMs">> = {},
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

const errorResponse = (
  code: string,
  message: string,
  status: number,
  overrides: Partial<Pick<ApiErrorDetails, "category" | "recoverable" | "action" | "retryAfterMs">> = {},
) => Response.json({
  ok: false,
  error: { code, message, ...classifyApiError(code, status), ...overrides },
}, { status });

export function assertSameOrigin(request: Request): void {
  const apiToken = process.env.HARNEST_API_TOKEN;
  const authorization = request.headers.get("authorization");
  if (apiToken && authorization?.startsWith("Bearer ")) {
    const supplied = Buffer.from(authorization.slice(7));
    const expected = Buffer.from(apiToken);
    if (supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected)) return;
  }
  const url = new URL(request.url);
  const host = request.headers.get("host");
  const origin = request.headers.get("origin");
  if (!host || !hasLiteralStudioHost(request)) {
    throw new ApiRequestError(
      "REQUEST_HOST_INVALID",
      "Request host must be an allowed Studio address matching this Studio",
      403,
    );
  }
  if (!origin) throw new ApiRequestError("REQUEST_ORIGIN_MISSING", "Mutation requests require an Origin header", 403);
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    throw new ApiRequestError("REQUEST_ORIGIN_INVALID", "Mutation request origin is invalid", 403);
  }
  if (!isAllowedStudioHostname(originUrl.hostname)
    || originUrl.host.toLocaleLowerCase() !== host.toLocaleLowerCase()
    || originUrl.protocol !== url.protocol) {
    throw new ApiRequestError("REQUEST_ORIGIN_INVALID", "Cross-origin mutation requests are not allowed", 403);
  }
}

export async function readJsonBody(request: Request, maxBytes = 65_536): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLocaleLowerCase().startsWith("application/json")) {
    throw new ApiRequestError("REQUEST_CONTENT_TYPE", "Request body must use application/json", 415);
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    throw new ApiRequestError("REQUEST_TOO_LARGE", `Request body exceeds ${maxBytes} bytes`, 413);
  }
  const reader = request.body?.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  if (reader) {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) {
          await reader.cancel();
          throw new ApiRequestError("REQUEST_TOO_LARGE", `Request body exceeds ${maxBytes} bytes`, 413);
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock();
    }
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiRequestError("REQUEST_JSON_INVALID", "Request body must be valid JSON");
  }
}

export const apiErrorResponse = (error: unknown) => {
  if (error instanceof ApiRequestError) {
    return errorResponse(error.code, error.message, error.status, error.details);
  }
  if (error && typeof error === "object" && "name" in error && error.name === "ConnectionError"
    && "code" in error && typeof error.code === "string" && "message" in error && typeof error.message === "string") {
    const status = error.code === "CONNECTION_NOT_FOUND" ? 404
      : error.code === "PROCESS_APPROVAL_REQUIRED" ? 409
        : error.code === "CREDENTIAL_BACKEND_UNAVAILABLE" || error.code === "CREDENTIAL_STORE_FAILED" ? 503
          : error.code === "CONNECTION_TEST_FAILED" ? 422
            : 400;
    return errorResponse(error.code, error.message, status);
  }
  if (error && typeof error === "object" && "name" in error
    && (error.name === "ToolStoreError" || error.name === "SkillStoreError" || error.name === "SkillParseError")
    && "code" in error && typeof error.code === "string" && "message" in error && typeof error.message === "string") {
    const status = /NOT_FOUND/.test(error.code) ? 404
      : /APPROVAL_REQUIRED|EXISTS/.test(error.code) ? 409
        : /CAPABILITY_REQUIRED/.test(error.code) ? 503
          : /EXECUTION|OUTPUT|INPUT/.test(error.code) ? 422
            : 400;
    return errorResponse(error.code, error.message, status);
  }
  return errorResponse("REQUEST_FAILED", "Request failed", 500);
};
