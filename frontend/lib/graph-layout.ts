import type { XYPosition } from "@xyflow/react";
import ELK from "elkjs/lib/elk-api.js";
import type { LayoutEdgeInput, LayoutNodeInput } from "./graph-layout-core";
import { preservePinnedPositions } from "./graph-layout-core";
export { preservePinnedPositions, type LayoutEdgeInput, type LayoutNodeInput } from "./graph-layout-core";

const portId = (node: string, side: "input" | "output", handle: string) => `${node}::${side}::${handle}`;

export async function layoutGraph(input: {
  readonly nodes: readonly LayoutNodeInput[];
  readonly edges: readonly LayoutEdgeInput[];
  readonly direction: "RIGHT" | "DOWN";
  readonly density: "compact" | "comfortable";
}): Promise<Readonly<Record<string, XYPosition>>> {
  const elk = new ELK({ workerUrl: "/api/elk-worker" });
  const nodeIds = new Set(input.nodes.map(({ id }) => id));
  const spacing = input.density === "compact" ? 36 : 56;
  const layerSpacing = input.density === "compact" ? 72 : 108;
  try {
    const graph = await elk.layout({
      id: "root",
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": input.direction,
        "elk.edgeRouting": "ORTHOGONAL",
        "elk.spacing.nodeNode": String(spacing),
        "elk.layered.spacing.nodeNodeBetweenLayers": String(layerSpacing),
        "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
        "elk.layered.crossingMinimization.forceNodeModelOrder": "true",
        "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      },
      children: input.nodes.map((node) => ({
        id: node.id,
        width: node.width,
        height: node.height,
        layoutOptions: { "elk.portConstraints": "FIXED_ORDER" },
        ports: [
          ...node.inputs.map((handle) => ({
            id: portId(node.id, "input", handle), width: 8, height: 8,
            layoutOptions: { "elk.port.side": input.direction === "RIGHT" ? "WEST" : "NORTH" },
          })),
          ...node.outputs.map((handle) => ({
            id: portId(node.id, "output", handle), width: 8, height: 8,
            layoutOptions: { "elk.port.side": input.direction === "RIGHT" ? "EAST" : "SOUTH" },
          })),
        ],
      })),
      edges: input.edges.filter(({ source, target }) => nodeIds.has(source) && nodeIds.has(target)).map((edge) => ({
        id: edge.id,
        sources: [edge.sourceHandle ? portId(edge.source, "output", edge.sourceHandle) : edge.source],
        targets: [edge.targetHandle ? portId(edge.target, "input", edge.targetHandle) : edge.target],
      })),
    });
    const laidOut = Object.fromEntries((graph.children ?? []).map((node) => [node.id, { x: node.x ?? 0, y: node.y ?? 0 }]));
    return preservePinnedPositions(input.nodes, laidOut, input.direction, spacing);
  } finally {
    elk.terminateWorker();
  }
}
