import { dirname } from "node:path";
import { publicRunSnapshot } from "@harnestai/core";
import { FileRunStore } from "@harnestai/core/node";
import { runRegistry } from "@/lib/run-registry";
import { harnessFile } from "@/lib/server";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ runId: string }> }) {
  const { runId } = await context.params;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(runId)) {
    return Response.json({ ok: false, error: "Run id is invalid" }, { status: 400 });
  }
  try {
    const snapshot = runRegistry.snapshot(runId) ?? await new FileRunStore(dirname(harnessFile())).readSnapshot(runId);
    return snapshot
      ? Response.json({ ok: true, snapshot: publicRunSnapshot(snapshot) })
      : Response.json({ ok: false, error: "Run snapshot was not found" }, { status: 404 });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "Could not read Run snapshot" }, { status: 500 });
  }
}
