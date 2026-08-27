import { describe, expect, it } from "vitest";
import type { RunEvent } from "@harnestai/core";
import { groupTraceEvents, traceViewKey, visibleActiveEdgeId, visibleTraceId } from "./trace-view";

describe("Studio scoped trace projection", () => {
  it("keeps root events out of a subgraph and nested events out of root", () => {
    expect(visibleTraceId("loop/revise/writer", undefined, new Set(["loop", "writer"]))).toBeUndefined();
    expect(visibleTraceId("loop", undefined, new Set(["loop"]))).toBe("loop");
    expect(visibleTraceId("writer", "revise", new Set(["writer"]))).toBeUndefined();
  });

  it("projects scoped node and edge identities only into their named graph lens", () => {
    expect(visibleTraceId("loop/revise/writer", "revise", new Set(["writer"]))).toBe("writer");
    expect(visibleTraceId("loop/other/writer", "revise", new Set(["writer"]))).toBeUndefined();
    expect(visibleTraceId("loop/revise/edge_1", "revise", new Set(["edge_1"]))).toBe("edge_1");
  });

  it("never pulses an inactive conditional branch", () => {
    const visible = new Set(["edge_1"]);
    expect(visibleActiveEdgeId({ edgeId: "edge_1", active: false }, undefined, visible)).toBeUndefined();
    expect(visibleActiveEdgeId({ edgeId: "edge_1", active: true }, undefined, visible)).toBe("edge_1");
  });

  it("keeps equal local IDs isolated between graph lenses", () => {
    expect(traceViewKey(undefined, "output")).toBe("$root/output");
    expect(traceViewKey("revise", "output")).toBe("revise/output");
  });

  it("groups consecutive text deltas while retaining their raw events", () => {
    const base = { runId: "run", timestamp: new Date(0).toISOString() };
    const events = [
      { ...base, type: "text-delta", nodeId: "agent", text: "Hel" },
      { ...base, type: "text-delta", nodeId: "agent", text: "lo" },
      { ...base, type: "usage", nodeId: "agent", usage: {} },
      { ...base, type: "text-delta", nodeId: "other", text: "!" },
    ] as unknown as RunEvent[];

    const grouped = groupTraceEvents(events);
    expect(grouped).toHaveLength(3);
    expect(grouped[0]?.event).toMatchObject({ type: "text-delta", text: "Hello" });
    expect(grouped[0]?.events).toHaveLength(2);
  });
});
