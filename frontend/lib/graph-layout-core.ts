import type { XYPosition } from "@xyflow/react";

export interface LayoutNodeInput {
  readonly id: string;
  readonly position: XYPosition;
  readonly width: number;
  readonly height: number;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly pinned: boolean;
}

export interface LayoutEdgeInput {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly sourceHandle?: string | null;
  readonly targetHandle?: string | null;
}

export function preservePinnedPositions(
  nodes: readonly LayoutNodeInput[],
  laidOut: Readonly<Record<string, XYPosition>>,
  direction: "RIGHT" | "DOWN",
  spacing: number,
): Readonly<Record<string, XYPosition>> {
  if (!nodes.length) return {};
  const oldMinX = Math.min(...nodes.map(({ position }) => position.x));
  const oldMinY = Math.min(...nodes.map(({ position }) => position.y));
  const next = Object.values(laidOut);
  const newMinX = next.length ? Math.min(...next.map(({ x }) => x)) : 0;
  const newMinY = next.length ? Math.min(...next.map(({ y }) => y)) : 0;
  const positions = new Map(nodes.filter(({ pinned }) => pinned).map((node) => [node.id, node.position]));
  const size = new Map(nodes.map((node) => [node.id, node]));
  const overlaps = (left: string, right: string) => {
    const a = positions.get(left)!;
    const b = positions.get(right)!;
    const aSize = size.get(left)!;
    const bSize = size.get(right)!;
    return a.x < b.x + bSize.width + 8 && a.x + aSize.width + 8 > b.x
      && a.y < b.y + bSize.height + 8 && a.y + aSize.height + 8 > b.y;
  };
  const unpinned = nodes.filter(({ pinned }) => !pinned).sort((left, right) => {
    const a = laidOut[left.id] ?? left.position;
    const b = laidOut[right.id] ?? right.position;
    return direction === "RIGHT" ? a.x - b.x || a.y - b.y : a.y - b.y || a.x - b.x;
  });
  for (const node of unpinned) {
    const position = laidOut[node.id] ?? node.position;
    positions.set(node.id, { x: position.x - newMinX + oldMinX, y: position.y - newMinY + oldMinY });
    for (let pass = 0; pass < nodes.length; pass += 1) {
      const blocker = [...positions.keys()].find((id) => id !== node.id && overlaps(node.id, id));
      if (!blocker) break;
      const blockerPosition = positions.get(blocker)!;
      const blockerSize = size.get(blocker)!;
      const current = positions.get(node.id)!;
      positions.set(node.id, direction === "RIGHT"
        ? { ...current, y: blockerPosition.y + blockerSize.height + spacing }
        : { ...current, x: blockerPosition.x + blockerSize.width + spacing });
    }
  }
  return Object.fromEntries(positions);
}
