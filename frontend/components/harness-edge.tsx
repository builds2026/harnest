"use client";

import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from "@xyflow/react";
import type { HarnessEdge } from "@/lib/studio-state";

export function HarnessEdgeComponent({
  id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data, label, selected,
}: EdgeProps<HarnessEdge>) {
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 18, offset: 22,
  });
  const kind = data?.kind ?? "data";
  return <>
    <BaseEdge id={id} path={path} markerEnd={markerEnd} className={`h-edge is-${kind} ${data?.running ? "is-running" : ""} ${selected ? "is-selected" : ""}`} interactionWidth={24} />
    {label && <EdgeLabelRenderer><span className={`h-edge-label is-${kind}`} style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>{String(label)}</span></EdgeLabelRenderer>}
  </>;
}
