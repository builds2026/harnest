import type { RunEvent } from "@harnestai/core";

/** Maps a scoped runtime identity onto the graph currently visible in Studio. */
export const traceViewKey = (activeSubgraph: string | undefined, localId: string) =>
  `${activeSubgraph ?? "$root"}/${localId}`;

export interface TraceEventGroup {
  readonly event: RunEvent;
  readonly events: readonly RunEvent[];
}

const traceScope = (event: RunEvent) => {
  const data = event as unknown as Record<string, unknown>;
  return `${event.runId}:${String(data.nodeId ?? "")}`;
};

/** Coalesces streaming chunks without hiding any raw events from technical details. */
export function groupTraceEvents(events: readonly RunEvent[]): TraceEventGroup[] {
  const groups: Array<{ event: RunEvent; events: RunEvent[] }> = [];
  for (const event of events) {
    const previous = groups.at(-1);
    if (event.type === "text-delta" && previous?.event.type === "text-delta"
      && traceScope(event) === traceScope(previous.event)) {
      previous.events.push(event);
      previous.event = { ...previous.event, text: previous.events.map((item) => item.type === "text-delta" ? item.text : "").join("") };
    } else groups.push({ event, events: [event] });
  }
  return groups;
}

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
