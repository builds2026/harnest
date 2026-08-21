/** Maps a scoped runtime identity onto the graph currently visible in Studio. */
export const traceViewKey = (activeSubgraph: string | undefined, localId: string) =>
  `${activeSubgraph ?? "$root"}/${localId}`;

export function visibleTraceId(
  scopedId: string,
  activeSubgraph: string | undefined,
  visibleIds: ReadonlySet<string>,
): string | undefined {
  const segments = scopedId.split("/");
  const localId = segments.at(-1);
  if (!localId || !visibleIds.has(localId)) return undefined;
  if (!activeSubgraph) return segments.length === 1 ? localId : undefined;
  return segments.slice(0, -1).includes(activeSubgraph) ? localId : undefined;
}

export function visibleActiveEdgeId(
  event: { edgeId: string; active: boolean },
  activeSubgraph: string | undefined,
  visibleIds: ReadonlySet<string>,
) {
  return event.active ? visibleTraceId(event.edgeId, activeSubgraph, visibleIds) : undefined;
}
