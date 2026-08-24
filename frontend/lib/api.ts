export type ApiErrorCategory = "validation" | "auth" | "permission" | "timeout" | "network" | "conflict" | "server";
export type ApiErrorAction = "retry" | "reauth" | "open-settings" | "resolve-issues";

export interface ApiErrorDetails {
  readonly code: string;
  readonly message: string;
  readonly category?: ApiErrorCategory;
  readonly recoverable?: boolean;
  readonly action?: ApiErrorAction;
  readonly retryAfterMs?: number;
}

export interface ApiErrorResponse {
  readonly ok: false;
  readonly error: ApiErrorDetails;
}

export function classifyApiError(code: string, status: number): Required<Pick<ApiErrorDetails, "category" | "recoverable" | "action">> {
  if (/AUTH|CREDENTIAL|TOKEN|OAUTH/.test(code) || status === 401) return { category: "auth", recoverable: true, action: "reauth" };
  if (/SCOPE|PERMISSION|APPROVAL|HOST|ORIGIN/.test(code) || status === 403) return { category: "permission", recoverable: true, action: "open-settings" };
  if (/TIMEOUT/.test(code) || status === 408 || status === 504) return { category: "timeout", recoverable: true, action: "retry" };
  if (/CONFLICT|EXISTS|REVISION/.test(code) || status === 409) return { category: "conflict", recoverable: true, action: "resolve-issues" };
  if (/INVALID|VALIDATION|INPUT|SCHEMA|JSON|CONTENT_TYPE|TOO_LARGE|TEST_FAILED/.test(code) || status === 400 || status === 415 || status === 422) {
    return { category: "validation", recoverable: true, action: "resolve-issues" };
  }
  return { category: "server", recoverable: status >= 500, action: "retry" };
}
