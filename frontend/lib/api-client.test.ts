import { afterEach, describe, expect, it, vi } from "vitest";
import { apiErrorMessage, ClientApiError, requestJson } from "./api-client";
import { classifyApiError } from "./api";
import { translate } from "../i18n/core";

describe("requestJson", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps structured recovery metadata from API errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      error: { code: "TOKEN_EXPIRED", message: "Expired", category: "auth", recoverable: true, action: "reauth" },
    }), { status: 401, headers: { "content-type": "application/json" } })));
    await expect(requestJson("/api/test", {}, { retryGet: false })).rejects.toMatchObject({
      details: { code: "TOKEN_EXPIRED", category: "auth", action: "reauth" },
      status: 401,
    });
  });

  it("does not blindly retry mutations", async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError("offline"); });
    vi.stubGlobal("fetch", fetchMock);
    await expect(requestJson("/api/test", { method: "POST" })).rejects.toBeInstanceOf(ClientApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("presents classified client failures in the active locale", () => {
    const error = new ClientApiError({ code: "REQUEST_TIMEOUT", message: "The request timed out.", category: "timeout", recoverable: true, action: "retry" });
    expect(apiErrorMessage(error, "fallback", (key, values) => translate("ko-KR", key, values))).toBe("서비스 응답 시간이 초과되었습니다. 다시 시도하세요.");
  });

  it("does not present a credential vault backend failure as an expired API key", () => {
    expect(classifyApiError("CREDENTIAL_BACKEND_UNAVAILABLE", 503)).toEqual({
      category: "server", recoverable: true, action: "open-settings",
    });
  });
});
