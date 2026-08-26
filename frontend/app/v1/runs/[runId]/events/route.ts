import { dirname } from "node:path";
import { toWireEvent, type InternalEvent } from "@harnestai/protocol";
import { FileRunStore, type StoredRunEvent } from "@harnestai/core/node";
import type { RunEvent } from "@harnestai/core";
import { runRegistry } from "@/lib/run-registry";
import { harnessFile } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const encoder = new TextEncoder();

export async function GET(request: Request, context: { params: Promise<{ runId: string }> }) {
  const { runId } = await context.params;
  if (!RUN_ID.test(runId)) return Response.json({ error: "Run id is invalid" }, { status: 400 });
  const url = new URL(request.url);
  const rawCursor = url.searchParams.get("after") ?? request.headers.get("last-event-id") ?? "0";
  const after = Number(rawCursor);
  if (!Number.isInteger(after) || after < 0) {
    return Response.json({ error: "after and Last-Event-ID must be a non-negative event sequence" }, { status: 400 });
  }
  const store = new FileRunStore(dirname(harnessFile()));
  let history: StoredRunEvent[] = [];
  try {
    history = await store.read(runId);
  } catch (error) {
    const missing = error && typeof error === "object" && "code" in error && error.code === "ENOENT";
    if (!missing) return Response.json({ error: error instanceof Error ? error.message : "Could not read Run events" }, { status: 500 });
    if (!runRegistry.has(runId)) return Response.json({ error: "Run was not found" }, { status: 404 });
  }
  const persistedSnapshot = await store.readSnapshot(runId);
  const latestSnapshot = runRegistry.snapshot(runId) ?? persistedSnapshot;
  const knownSequence = () => Math.max(0, ...history.map((event) => event.sequence ?? 0),
    ...runRegistry.events(runId).map((event) => event.sequence ?? 0));
  if (latestSnapshot?.status === "paused" && knownSequence() <= after) {
    return new Response(encoder.encode(": connected\n\n"), { headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    } });
  }
  const iterator = runRegistry.stream(runId, after, history, request.signal)[Symbol.asyncIterator]();
  let pending: Promise<IteratorResult<RunEvent | StoredRunEvent>> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode(": connected\n\n")); },
    async pull(controller) {
      try {
        pending ??= iterator.next();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const next = await Promise.race([
          pending.then((value) => ({ kind: "event" as const, value })),
          new Promise<{ kind: "heartbeat" }>((resolve) => { timer = setTimeout(() => resolve({ kind: "heartbeat" }), 15_000); }),
        ]);
        if (next.kind === "heartbeat") {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
          return;
        }
        if (timer) clearTimeout(timer);
        pending = undefined;
        if (next.value.done) { controller.close(); return; }
        const event = next.value.value;
        const sequence = event.sequence ?? 0;
        const envelope = toWireEvent({ ...event, runId, sequence } as InternalEvent);
        controller.enqueue(encoder.encode(`id: ${sequence}\nevent: ${envelope.type}\ndata: ${JSON.stringify(envelope)}\n\n`));
        const currentSnapshot = runRegistry.snapshot(runId) ?? latestSnapshot;
        if (currentSnapshot?.status === "paused" && sequence >= knownSequence()) {
          await iterator.return?.();
          controller.close();
        }
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() { await iterator.return?.(); },
  });
  return new Response(body, { headers: {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    "x-content-type-options": "nosniff",
  } });
}
