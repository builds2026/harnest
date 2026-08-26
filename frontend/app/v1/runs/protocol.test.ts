import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/api-server", async () => import("../../../lib/api-server"));
vi.mock("@/lib/run-registry", async () => import("../../../lib/run-registry"));
vi.mock("@/lib/server", async () => import("../../../lib/server"));

import type { RunEvent, RunHandle, RunSnapshot } from "@harnestai/core";
import { GET as capabilities } from "../capabilities/route";
import { POST as command } from "./[runId]/commands/route";
import { GET as events } from "./[runId]/events/route";
import { GET as snapshotRoute } from "./[runId]/snapshot/route";
import { runRegistry } from "../../../lib/run-registry";

const headers = {
  host: "127.0.0.1:3000",
  origin: "http://127.0.0.1:3000",
  "content-type": "application/json",
};

describe("Runtime protocol v1 routes", () => {
  it("advertises the stable interaction and permission surface", async () => {
    const response = capabilities();
    await expect(response.json()).resolves.toMatchObject({
      protocolVersion: "1.0",
      interactions: ["select", "input", "form", "file", "oauth", "permission"],
      permissions: ["allow_once", "allow_for_run", "allow_always", "deny"],
    });
  });

  it("maps interaction commands and reconnects SSE from Last-Event-ID", async () => {
    const runId = `v1_${crypto.randomUUID().replaceAll("-", "")}`;
    const sent: unknown[] = [];
    let finish: () => void = () => {};
    const wait = new Promise<void>((resolve) => { finish = resolve; });
    const started: RunEvent = { type: "run-start", runId, timestamp: "2026-08-25T00:00:00.000Z", sequence: 1, input: "hello", specVersion: "0.3" };
    const ended: RunEvent = { type: "run-end", runId, timestamp: "2026-08-25T00:00:01.000Z", sequence: 2, output: "done", state: {}, usage: {}, costUsd: 0, iterations: 0, durationMs: 1, finishReason: "stop", artifacts: [] };
    const snapshot: RunSnapshot = { runId, sequence: 2, revision: 0, status: "succeeded", tasks: [], agents: [], messages: [], revisions: [], proposals: [], updatedAt: ended.timestamp };
    const handle: RunHandle = {
      runId,
      events: { async *[Symbol.asyncIterator]() { yield started; await wait; yield ended; } },
      send: async (value) => { sent.push(value); },
      cancel: async () => { finish(); },
      snapshot: () => snapshot,
      result: async () => ({ runId, output: "done", state: {}, usage: {}, costUsd: 0, finishReason: "stop", iterations: 0, durationMs: 1, artifacts: [], trace: [started, ended] }),
    };
    runRegistry.add(handle, () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const response = await command(new Request(`http://127.0.0.1:3000/v1/runs/${runId}/commands`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        commandId: "command_1",
        type: "interaction.response",
        response: {
          interactionId: "interaction_1",
          checkpointDigest: "a234567890123456",
          action: "submit",
          permission: "allow_for_run",
        },
      }),
    }), { params: Promise.resolve({ runId }) });
    expect(response.status).toBe(200);
    expect(sent).toEqual([{ id: "command_1", type: "interaction-response", response: {
      interactionId: "interaction_1",
      checkpointDigest: "a234567890123456",
      action: "submit",
      permission: "allow_for_run",
    } }]);

    finish();
    const stream = await events(new Request(`http://127.0.0.1:3000/v1/runs/${runId}/events`, {
      headers: { "last-event-id": "1" },
    }), { params: Promise.resolve({ runId }) });
    const text = await stream.text();
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    expect(text).not.toContain("event: run.started");
    expect(text).toContain("id: 2\nevent: run.completed");
    expect(JSON.parse(text.match(/^data: (.+)$/mu)?.[1] ?? "null")).toMatchObject({
      protocolVersion: "1.0", runId, sequence: 2, type: "run.completed",
    });
  });

  it("never returns private checkpoint values from the public snapshot route", async () => {
    const runId = `v1_private_${crypto.randomUUID().replaceAll("-", "")}`;
    const snapshot: RunSnapshot = {
      runId, revision: 0, status: "paused", tasks: [], agents: [], messages: [], revisions: [], proposals: [],
      pendingInteractions: [{
        id: "interaction_private", runId, nodeId: "ask", kind: "input",
        requester: { kind: "harness", id: "ask" }, title: "Input", message: "Input",
        blocking: "run", checkpoint: { revision: 0, sequence: 1, digest: "a".repeat(64) },
        createdAt: "2026-08-25T00:00:00.000Z", data: { contextRef: "opaque-private" },
      }],
      interactionResponses: { interaction_private: {
        interactionId: "interaction_private", checkpointDigest: "a".repeat(64), action: "submit", value: "private-answer",
      } },
      turnCheckpoints: { "run:ask:0": {
        nextTurn: 1, workingState: {}, usage: {}, usageKnown: false, costUsd: 0, costKnown: false,
        finishReason: "unknown", toolCalls: 0, fallbackUsed: false, siblingResults: [], completed: false,
        updatedAt: "2026-08-25T00:00:00.000Z",
      } },
      updatedAt: "2026-08-25T00:00:00.000Z",
    };
    const handle: RunHandle = {
      runId, events: { async *[Symbol.asyncIterator]() { /* paused */ } },
      send: async () => undefined, cancel: async () => undefined, snapshot: () => snapshot,
      result: async () => { throw new Error("paused"); },
    };
    runRegistry.add(handle, () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const response = await snapshotRoute(new Request(`http://127.0.0.1:3000/v1/runs/${runId}/snapshot`), {
      params: Promise.resolve({ runId }),
    });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ active: false });
    expect(text).not.toContain("private-answer");
    expect(text).not.toContain("opaque-private");
    expect(text).not.toContain("turnCheckpoints");
    expect(text).not.toContain("interactionResponses");
  });

  it("closes a paused stream only after replaying events newer than historical pauses", async () => {
    const runId = `v1_pause_${crypto.randomUUID().replaceAll("-", "")}`;
    let finish: () => void = () => {};
    const wait = new Promise<void>((resolve) => { finish = resolve; });
    const timestamp = "2026-08-25T00:00:00.000Z";
    const trace: RunEvent[] = [
      { type: "run-paused", runId, timestamp, sequence: 2, paused: true, interactionId: "old" },
      { type: "run-paused", runId, timestamp, sequence: 3, paused: false },
      { type: "node-start", runId, timestamp, sequence: 4, nodeId: "agent", componentType: "agent", inputs: {}, state: {}, iteration: 0, attempt: 1 },
      { type: "run-paused", runId, timestamp, sequence: 5, paused: true, interactionId: "current" },
    ];
    const snapshot: RunSnapshot = {
      runId, sequence: 5, revision: 0, status: "paused", tasks: [], agents: [], messages: [],
      revisions: [], proposals: [], updatedAt: timestamp,
    };
    const handle: RunHandle = {
      runId,
      events: { async *[Symbol.asyncIterator]() { for (const event of trace) yield event; await wait; } },
      send: async () => undefined,
      cancel: async () => { finish(); },
      snapshot: () => snapshot,
      result: async () => { throw new Error("paused"); },
    };
    runRegistry.add(handle, () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const replay = await events(new Request(`http://127.0.0.1:3000/v1/runs/${runId}/events`), {
      params: Promise.resolve({ runId }),
    });
    const text = await replay.text();
    expect(text).toContain("id: 4\nevent: node.start");
    expect(text.match(/event: run\.paused/gu)).toHaveLength(2);
    expect(text).toContain("id: 5\nevent: run.paused");

    const alreadyPaused = await events(new Request(`http://127.0.0.1:3000/v1/runs/${runId}/events?after=5`), {
      params: Promise.resolve({ runId }),
    });
    await expect(alreadyPaused.text()).resolves.toBe(": connected\n\n");
    await handle.cancel();
  });
});
