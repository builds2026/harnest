import { dirname } from "node:path";
import { StudioConnectionService } from "@/lib/connections-server";
import { harnessFile } from "@/lib/server";

export const runtime = "nodejs";

const completionPage = (id: string, ok: boolean) => {
  const event = JSON.stringify({ type: "harnest-oauth-complete", id, ok })
    .replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Harnest authorization</title></head><body><main><h1>${ok ? "Authorization complete" : "Authorization failed"}</h1><p>${ok ? "You can return to Harnest Studio." : "Return to Harnest Studio and try again."}</p></main><script>window.opener?.postMessage(${event}, location.origin);window.close();</script></body></html>`, {
    status: ok ? 200 : 400,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
    },
  });
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id") ?? "";
  const callback = new URLSearchParams(url.searchParams);
  callback.delete("id");
  try {
    await new StudioConnectionService(dirname(harnessFile())).finishOAuth(id, callback);
    return completionPage(id, true);
  } catch {
    return completionPage(id, false);
  }
}
