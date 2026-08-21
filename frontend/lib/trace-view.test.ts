import { describe, expect, it } from "vitest";
import { traceViewKey, visibleActiveEdgeId, visibleTraceId } from "./trace-view";

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
});
