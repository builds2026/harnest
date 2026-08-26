import ELK from "elkjs/lib/elk.bundled.js";
import { preservePinnedPositions, type LayoutEdgeInput, type LayoutNodeInput } from "../lib/graph-layout-core";

const elk = new ELK();
const worker = globalThis as unknown as {
  onmessage: ((event: MessageEvent<{
    id: string;
    nodes: LayoutNodeInput[];
    edges: LayoutEdgeInput[];
    direction: "RIGHT" | "DOWN";
    density: "compact" | "comfortable";
  }>) => void) | null;
  postMessage(value: unknown): void;
};

const portId = (node: string, side: "input" | "output", handle: string) => `${node}::${side}::${handle}`;

worker.onmessage = async ({ data }) => {
  try {
    const nodeIds = new Set(data.nodes.map(({ id }) => id));
    const spacing = data.density === "compact" ? 36 : 56;
    const layerSpacing = data.density === "compact" ? 72 : 108;
    const graph = await elk.layout({
      id: "root",
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": data.direction,
        "elk.edgeRouting": "ORTHOGONAL",
        "elk.spacing.nodeNode": String(spacing),
        "elk.layered.spacing.nodeNodeBetweenLayers": String(layerSpacing),
        "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
        "elk.layered.crossingMinimization.forceNodeModelOrder": "true",
        "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      },
      children: data.nodes.map((node) => ({
        id: node.id,
        width: node.width,
        height: node.height,
        layoutOptions: { "elk.portConstraints": "FIXED_ORDER" },
        ports: [
          ...node.inputs.map((handle) => ({
            id: portId(node.id, "input", handle), width: 8, height: 8,
            layoutOptions: { "elk.port.side": data.direction === "RIGHT" ? "WEST" : "NORTH" },
          })),
          ...node.outputs.map((handle) => ({
            id: portId(node.id, "output", handle), width: 8, height: 8,
            layoutOptions: { "elk.port.side": data.direction === "RIGHT" ? "EAST" : "SOUTH" },
          })),
        ],
      })),
      edges: data.edges.filter(({ source, target }) => nodeIds.has(source) && nodeIds.has(target)).map((edge) => ({
        id: edge.id,
        sources: [edge.sourceHandle ? portId(edge.source, "output", edge.sourceHandle) : edge.source],
        targets: [edge.targetHandle ? portId(edge.target, "input", edge.targetHandle) : edge.target],
      })),
    });
    const laidOut = Object.fromEntries((graph.children ?? []).map((node) => [node.id, { x: node.x ?? 0, y: node.y ?? 0 }]));
    const positions = preservePinnedPositions(data.nodes, laidOut, data.direction, spacing);
    worker.postMessage({ id: data.id, positions });
  } catch (error) {
    worker.postMessage({ id: data.id, error: error instanceof Error ? error.message : "Automatic layout failed" });
  }
};

export {};
