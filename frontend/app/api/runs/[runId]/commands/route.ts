import { ApiRequestError, apiErrorResponse, assertSameOrigin, readJsonBody } from "@/lib/api-server";
import { runRegistry } from "@/lib/run-registry";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ runId: string }> }) {
  try {
    assertSameOrigin(request);
    const { runId } = await context.params;
    const command = await readJsonBody(request, 1_048_576);
    if (!await runRegistry.send(runId, command)) {
      throw new ApiRequestError("RUN_NOT_ACTIVE", "Run is not active", 409);
    }
    return Response.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
