import { GET as legacyGet, POST as legacyPost } from "../../api/runs/route";

export const runtime = "nodejs";

export const GET = legacyGet;

export async function POST(request: Request) {
  const response = await legacyPost(request);
  if (!response.ok) return response;
  const payload = await response.json() as { runId: string };
  const runId = payload.runId;
  return Response.json({
    runId,
    events: `/v1/runs/${encodeURIComponent(runId)}/events`,
    snapshot: `/v1/runs/${encodeURIComponent(runId)}/snapshot`,
    commands: `/v1/runs/${encodeURIComponent(runId)}/commands`,
  }, { status: 202, headers: { "cache-control": "no-store" } });
}
