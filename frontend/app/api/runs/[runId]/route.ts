import { ApiRequestError, apiErrorResponse, assertSameOrigin } from "@/lib/api-server";
import { runRegistry } from "@/lib/run-registry";

export const runtime = "nodejs";

export async function DELETE(request: Request, context: { params: Promise<{ runId: string }> }) {
  try {
    assertSameOrigin(request);
    const { runId } = await context.params;
    if (!await runRegistry.cancel(runId)) throw new ApiRequestError("RUN_NOT_ACTIVE", "Run is not active", 409);
    return Response.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
