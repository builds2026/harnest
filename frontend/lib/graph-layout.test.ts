import { describe, expect, it } from "vitest";
import { preservePinnedPositions, type LayoutNodeInput } from "./graph-layout";

const node = (id: string, x: number, y: number, pinned = false): LayoutNodeInput => ({
  id, position: { x, y }, width: 100, height: 60, inputs: [], outputs: [], pinned,
});

describe("graph layout", () => {
  it("keeps pinned nodes exact and moves generated positions out of their way", () => {
    const positions = preservePinnedPositions(
      [node("pinned", 100, 100, true), node("free", 0, 0)],
      { pinned: { x: 0, y: 0 }, free: { x: 100, y: 100 } },
      "RIGHT",
      36,
    );
    expect(positions.pinned).toEqual({ x: 100, y: 100 });
    expect(positions.free).toEqual({ x: 100, y: 196 });
  });
});
