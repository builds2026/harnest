import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeRuntimeServices } from "@harnestai/core/node";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/api-server", async () => import("../../../lib/api-server"));
vi.mock("@/lib/server", async () => import("../../../lib/server"));

import { DELETE, GET } from "./route";

const roots: string[] = [];
const originalFile = process.env.HARNEST_FILE;

afterEach(async () => {
  if (originalFile === undefined) delete process.env.HARNEST_FILE;
  else process.env.HARNEST_FILE = originalFile;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Tool permission settings API", () => {
  it("lists and revokes the exact persisted grant", async () => {
    const project = await mkdtemp(join(tmpdir(), "harnest-permissions-route-"));
    roots.push(project);
    process.env.HARNEST_FILE = join(project, "harnest.yaml");
    const services = new NodeRuntimeServices(project, {
      harnessId: process.env.HARNEST_FILE,
      requestToolApproval: () => ({ approved: true, source: "user", mode: "always" }),
    });
    await services.requestToolApproval({
      runId: "run",
      nodeId: "agent",
      callId: "call",
      turn: 1,
      tool: {
        id: "builtin.shell",
        label: "Shell",
        description: "Run",
        inputSchema: { type: "object" },
        risk: "destructive",
        connectionId: "runtime_a",
      },
      input: {},
    }, {
      signal: new AbortController().signal,
      runId: "run",
      nodeId: "agent",
      iteration: 0,
      resolveSecret: () => undefined,
    });
    await services.close();

    await expect((await GET()).json()).resolves.toMatchObject({
      permissions: [expect.objectContaining({ toolId: "builtin.shell", connectionId: "runtime_a" })],
    });
    const removed = await DELETE(new Request("http://127.0.0.1:3000/api/tool-permissions", {
      method: "DELETE",
      headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "content-type": "application/json" },
      body: JSON.stringify({ toolId: "builtin.shell", connectionId: "runtime_a" }),
    }));
    expect(removed.status).toBe(200);
    await expect((await GET()).json()).resolves.toMatchObject({ permissions: [] });
  });
});
