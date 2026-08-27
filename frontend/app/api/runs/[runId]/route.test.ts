import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileRunStore } from "@harnestai/core/node";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/api-server", async () => import("../../../../lib/api-server"));
vi.mock("@/lib/run-registry", async () => import("../../../../lib/run-registry"));
vi.mock("@/lib/server", async () => import("../../../../lib/server"));

import { DELETE } from "./route";

const roots: string[] = [];
const originalFile = process.env.HARNEST_FILE;

afterEach(async () => {
  if (originalFile === undefined) delete process.env.HARNEST_FILE;
  else process.env.HARNEST_FILE = originalFile;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const deleteRequest = (runId: string, persisted = false) => new Request(
  `http://127.0.0.1:3000/api/runs/${runId}${persisted ? "?persisted=1" : ""}`,
  { method: "DELETE", headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" } },
);

describe("run DELETE API", () => {
  it("deletes a persisted run and reports a missing run", async () => {
    const root = await mkdtemp(join(tmpdir(), "harnest-run-route-"));
    roots.push(root);
    process.env.HARNEST_FILE = join(root, "harnest.yaml");
    const runId = "run_delete_route";
    const store = new FileRunStore(dirname(process.env.HARNEST_FILE));
    await store.append({
      type: "run-end", runId, timestamp: new Date().toISOString(), sequence: 1,
      output: "done", state: {}, usage: {}, costUsd: 0, iterations: 1, durationMs: 10, finishReason: "stop",
    });

    const removed = await DELETE(deleteRequest(runId, true), { params: Promise.resolve({ runId }) });
    expect(removed.status).toBe(200);
    await expect(removed.json()).resolves.toMatchObject({ ok: true, deleted: true });
    await expect(store.list()).resolves.toEqual([]);

    const missing = await DELETE(deleteRequest(runId, true), { params: Promise.resolve({ runId }) });
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({ error: { code: "RUN_NOT_FOUND" } });
  });

  it("preserves the existing active-run cancellation contract", async () => {
    const response = await DELETE(deleteRequest("run_not_active"), {
      params: Promise.resolve({ runId: "run_not_active" }),
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "RUN_NOT_ACTIVE" } });
  });
});
