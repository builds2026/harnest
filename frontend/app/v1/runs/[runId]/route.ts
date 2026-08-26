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
    if (await runRegistry.cancel(runId)) return Response.json({ ok: true });
    const snapshot = await new FileRunStore(dirname(harnessFile())).readSnapshot(runId);
    if (snapshot?.status === "paused") throw new ApiRequestError(
      "RUN_RECOVERY_REQUIRED",
      "Resume this Run with POST /v1/runs and the original context before cancelling it",
      409,
    );
    throw new ApiRequestError("RUN_NOT_ACTIVE", "Run is not active", 409);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
