import type { XYPosition } from "@xyflow/react";
import type { LayoutEdgeInput, LayoutNodeInput } from "./graph-layout-core";
import { randomId } from "./random-id";
export { preservePinnedPositions, type LayoutEdgeInput, type LayoutNodeInput } from "./graph-layout-core";

interface LayoutResponse {
  readonly id: string;
  readonly positions?: Readonly<Record<string, XYPosition>>;
  readonly error?: string;
}

export function layoutGraph(input: {
  readonly nodes: readonly LayoutNodeInput[];
  readonly edges: readonly LayoutEdgeInput[];
  readonly direction: "RIGHT" | "DOWN";
  readonly density: "compact" | "comfortable";
}): Promise<Readonly<Record<string, XYPosition>>> {
  const worker = new Worker(new URL("../workers/graph-layout.worker.ts", import.meta.url), { type: "module" });
  const id = randomId();
  return new Promise((resolve, reject) => {
    const finish = () => worker.terminate();
    worker.onmessage = ({ data }: MessageEvent<LayoutResponse>) => {
      if (data.id !== id) return;
      finish();
      if (data.error) reject(new Error(data.error));
      else resolve(data.positions ?? {});
    };
    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message || "Automatic layout failed"));
    };
    worker.postMessage({ id, ...input });
  });
}
