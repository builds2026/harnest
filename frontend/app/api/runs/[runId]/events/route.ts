import { dirname } from "node:path";
import { FileRunStore, type StoredRunEvent } from "@harnestai/core/node";
import { runRegistry } from "@/lib/run-registry";
import { harnessFile } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ runId: string }> }) {
  const { runId } = await context.params;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(runId)) {
    return Response.json({ ok: false, error: "Run id is invalid" }, { status: 400 });
  }
  const parsedAfter = Number(new URL(request.url).searchParams.get("after") ?? 0);
  if (!Number.isInteger(parsedAfter) || parsedAfter < 0) {
    return Response.json({ ok: false, error: "after must be a non-negative event sequence" }, { status: 400 });
  }
  const store = new FileRunStore(dirname(harnessFile()));
  let history: StoredRunEvent[];
  try {
    history = await store.read(runId);
  } catch (error) {
    const missing = error && typeof error === "object" && "code" in error && error.code === "ENOENT";
    if (missing && !runRegistry.has(runId)) return Response.json({ ok: false, error: "Run was not found" }, { status: 404 });
    if (!missing) return Response.json({ ok: false, error: error instanceof Error ? error.message : "Could not read Run events" }, { status: 500 });
    history = [];
  }
  const iterator = runRegistry.stream(runId, parsedAfter, history, request.signal)[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`));
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() { await iterator.return?.(); },
  }), {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    },
  });
}
