import { dirname } from "node:path";
import { FileRunStore } from "@harnest/core/node";
import { diagnosticResponse, harnessFile, requestDiagnostic } from "@/lib/server";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const runId = url.searchParams.get("runId");
  const runs = new FileRunStore(dirname(harnessFile()));
  try {
    if (runId) {
      const events = await runs.read(runId);
      return Response.json({ run: { runId, events } });
    }
    const requestedLimit = Number(url.searchParams.get("limit") ?? 50);
    const limit = Number.isFinite(requestedLimit) ? requestedLimit : 50;
    return Response.json({ runs: await runs.list(limit) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load run history";
    const notFound = error && typeof error === "object" && "code" in error && error.code === "ENOENT";
    return diagnosticResponse([requestDiagnostic(message)], notFound ? 404 : 400);
  }
}
