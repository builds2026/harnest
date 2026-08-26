import { GET as legacyGet } from "../../../../api/runs/[runId]/snapshot/route";
import { runRegistry } from "@/lib/run-registry";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ runId: string }> }) {
  const response = await legacyGet(request, context);
  if (!response.ok) return response;
  const { runId } = await context.params;
  const payload = await response.json() as Record<string, unknown>;
  return Response.json({ ...payload, active: runRegistry.active(runId) }, {
    status: response.status,
    headers: { "cache-control": "no-store" },
  });
}
