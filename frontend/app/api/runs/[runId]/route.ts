import { dirname } from "node:path";
import { FileRunStore } from "@harnestai/core/node";
import { ApiRequestError, apiErrorResponse, assertSameOrigin } from "@/lib/api-server";
import { runRegistry } from "@/lib/run-registry";
import { harnessFile } from "@/lib/server";

export const runtime = "nodejs";

export async function DELETE(request: Request, context: { params: Promise<{ runId: string }> }) {
  try {
    assertSameOrigin(request);
    const { runId } = await context.params;
    if (new URL(request.url).searchParams.get("persisted") === "1") {
      if (runRegistry.active(runId)) throw new ApiRequestError("RUN_ACTIVE", "An active run cannot be deleted", 409);
      const deleted = await new FileRunStore(dirname(harnessFile())).delete(runId);
      if (!deleted) throw new ApiRequestError("RUN_NOT_FOUND", "Persisted run was not found", 404);
      return Response.json({ ok: true, deleted: true });
    }
    if (!await runRegistry.cancel(runId)) throw new ApiRequestError("RUN_NOT_ACTIVE", "Run is not active", 409);
    return Response.json({ ok: true, cancelled: true });
  } catch (error) {
    if (error instanceof Error && /Run '.+' is already active/u.test(error.message)) {
      return apiErrorResponse(new ApiRequestError("RUN_ACTIVE", "An active run cannot be deleted", 409));
    }
    return apiErrorResponse(error);
  }
}
