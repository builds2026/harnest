import { describe, expect, it, vi } from "vitest";
import type { RunEvent, RunHandle, RunSnapshot } from "@harnestai/core";
import { runRegistry } from "./run-registry";

vi.mock("server-only", () => ({}));

const event = (sequence: number, type: "run-start" | "run-end" = "run-start"): RunEvent => type === "run-start" ? {
  type, sequence, runId: "registry_test", timestamp: new Date().toISOString(), input: "x", specVersion: "0.3",
} : {
  type, sequence, runId: "registry_test", timestamp: new Date().toISOString(), output: "ok", state: {}, usage: {}, costUsd: 0,
  iterations: 0, durationMs: 1, finishReason: "stop",
};

describe("Run registry", () => {
  it("fans out sequence-resumable events and keeps commands on the same handle", async () => {
    const send = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const snapshot: RunSnapshot = { runId: "registry_test", revision: 0, status: "running", tasks: [], agents: [], messages: [], revisions: [], proposals: [], updatedAt: new Date().toISOString() };
    const handle: RunHandle = {
      runId: "registry_test",
      events: { async *[Symbol.asyncIterator]() { yield event(1); yield event(2, "run-end"); } },
      send,
      cancel: async () => undefined,
      result: async () => { throw new Error("unused"); },
      snapshot: () => snapshot,
    };
    runRegistry.add(handle, close);
    await vi.waitFor(() => expect(close).toHaveBeenCalled());
    const values: RunEvent[] = [];
    for await (const value of runRegistry.stream("registry_test", 1, [event(1), event(2, "run-end")], new AbortController().signal)) {
      values.push(value as RunEvent);
    }
    expect(values.map(({ sequence }) => sequence)).toEqual([2]);
    expect(runRegistry.snapshot("registry_test")?.runId).toBe("registry_test");
    expect(await runRegistry.send("registry_test", { type: "message", target: { kind: "run" }, content: "update" })).toBe(false);
  });

  it("rejects a second active handle for the same resumable Run", async () => {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const snapshot: RunSnapshot = { runId: "registry_exclusive", revision: 0, status: "paused", tasks: [], agents: [], messages: [], revisions: [], proposals: [], updatedAt: new Date().toISOString() };
    const handle: RunHandle = {
      runId: "registry_exclusive",
      events: { async *[Symbol.asyncIterator]() { yield { ...event(1), runId: "registry_exclusive" }; await finished; } },
      send: async () => undefined,
      cancel: async () => { finish(); },
      result: async () => { throw new Error("unused"); },
      snapshot: () => snapshot,
    };
    await runRegistry.add(handle, () => undefined);
    expect(() => runRegistry.add(handle, () => undefined)).toThrow(/already active/u);
    await runRegistry.cancel(handle.runId);
  });
});
