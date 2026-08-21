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
});
