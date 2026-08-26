import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/api-server", async () => import("../../../lib/api-server"));
vi.mock("@/lib/approval-broker", async () => import("../../../lib/approval-broker"));

import { approvalBroker } from "../../../lib/approval-broker";
import { POST } from "./route";

describe("Studio approval API", () => {
  it("accepts nested subgraph call IDs", async () => {
    const controller = new AbortController();
    const pending = approvalBroker.request({
      runId: "run-1",
      nodeId: "loop/subgraph/tool",
      callId: "loop/subgraph/tool:1:local",
      turn: 1,
      tool: {
        id: "demo.tool",
        label: "Demo",
        description: "Demo tool",
        inputSchema: { type: "object" },
        risk: "destructive",
      },
      input: {},
    }, controller.signal);

    const response = await POST(new Request("http://127.0.0.1:3000/api/approvals", {
      method: "POST",
      headers: {
        host: "127.0.0.1:3000",
        origin: "http://127.0.0.1:3000",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        action: "inspect",
        runId: "run-1",
        nodeId: "loop/subgraph/tool",
        callId: "loop/subgraph/tool:1:local",
        turn: 1,
      }),
    }));

    controller.abort();
    await pending;
    expect(response.status).toBe(200);
  });

  it("returns an always decision for the exact pending Tool call", async () => {
    const controller = new AbortController();
    const pending = approvalBroker.request({
      runId: "run-always",
      nodeId: "agent",
      callId: "call-always",
      turn: 1,
      tool: {
        id: "builtin.shell",
        label: "Shell",
        description: "Run a command",
        inputSchema: { type: "object" },
        risk: "destructive",
        connectionId: "runtime_a",
      },
      input: { command: "node" },
    }, controller.signal);
    const headers = {
      host: "127.0.0.1:3000",
      origin: "http://127.0.0.1:3000",
      "content-type": "application/json",
    };
    const inspected = await POST(new Request("http://127.0.0.1:3000/api/approvals", {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "inspect", runId: "run-always", nodeId: "agent", callId: "call-always", turn: 1 }),
    }));
    const view = await inspected.json() as { approval: { inputDigest: string; connectionId: string } };
    expect(view.approval.connectionId).toBe("runtime_a");
    const decided = await POST(new Request("http://127.0.0.1:3000/api/approvals", {
      method: "POST",
      headers,
      body: JSON.stringify({
        runId: "run-always",
        nodeId: "agent",
        callId: "call-always",
        turn: 1,
        inputDigest: view.approval.inputDigest,
        decision: "always",
      }),
    }));
    expect(decided.status).toBe(200);
    await expect(pending).resolves.toMatchObject({ approved: true, mode: "allow_always" });
  });
});
