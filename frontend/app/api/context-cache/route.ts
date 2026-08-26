import { dirname } from "node:path";
import { FilePromptCacheStore } from "@harnestai/core/node";
import { ApiRequestError, apiErrorResponse, assertSameOrigin } from "@/lib/api-server";
import { harnessFile } from "@/lib/server";

export const runtime = "nodejs";

const store = () => new FilePromptCacheStore(dirname(harnessFile()));

export async function GET() {
  try {
    const entries = await store().list();
    return Response.json({
      entries: entries.map(({ key: _key, resource: _resource, ...entry }) => entry),
      count: entries.length,
    });
  } catch (error) {
    return apiErrorResponse(new ApiRequestError(
      "CONTEXT_CACHE_READ_FAILED",
      error instanceof Error ? error.message : "Context cache status could not be loaded",
      500,
    ));
  }
}

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    const cleared = await store().clear();
    return Response.json({ ok: true, cleared });
  } catch (error) {
    return apiErrorResponse(error instanceof ApiRequestError ? error : new ApiRequestError(
      "CONTEXT_CACHE_CLEAR_FAILED",
      error instanceof Error ? error.message : "Context cache could not be cleared",
      500,
    ));
  }
}
