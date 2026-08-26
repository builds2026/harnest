import { describe, expect, it } from "vitest";
import { BUILTIN_COMPONENT_MANIFESTS, type RunSnapshot } from "@harnestai/core";
import { liveGraph } from "./live-graph";

describe("Live graph projection", () => {
  it("keeps runtime Agents, Tasks, handoffs, and messages out of the Design graph", () => {
    const timestamp = new Date().toISOString();
    const snapshot: RunSnapshot = {
      runId: "run_1", revision: 1, status: "running", updatedAt: timestamp, revisions: [], proposals: [],
      tasks: [{ id: "research", teamId: "engineering", goal: "Find evidence", assignee: "researcher", dependsOn: [], status: "running", agentId: "researcher_1", createdAt: timestamp, updatedAt: timestamp }],
      agents: [
        { id: "chief_1", teamId: "engineering", template: "chief", depth: 0, status: "running", createdAt: timestamp, updatedAt: timestamp },
        { id: "researcher_1", teamId: "engineering", template: "researcher", parentId: "chief_1", taskId: "research", depth: 1, status: "running", createdAt: timestamp, updatedAt: timestamp },
      ],
      messages: [
        { id: "message_1", teamId: "engineering", from: "chief_1", to: { kind: "agent", id: "researcher_1" }, kind: "instruction", content: "Check the source", createdAt: timestamp },
        { id: "message_2", teamId: "engineering", from: "chief_1", to: { kind: "team", id: "engineering" }, kind: "message", content: "Team update", createdAt: timestamp },
      ],
    };
    const manifests = new Map(BUILTIN_COMPONENT_MANIFESTS.map((manifest) => [manifest.type, manifest]));
    const graph = liveGraph(snapshot, manifests);
    expect(graph.nodes.map(({ id }) => id)).toEqual(["task:research", "agent:chief_1", "agent:researcher_1"]);
    expect(graph.edges.map(({ data }) => data?.kind)).toEqual(["handoff", "task", "message", "message"]);
    expect(graph.nodes.find(({ id }) => id === "agent:researcher_1")?.data.runState).toBe("running");
  });

  it("ignores shape-only records from legacy persisted snapshots", () => {
    const snapshot = {
      runId: "run_legacy", revision: 1, status: "failed", updatedAt: new Date().toISOString(), revisions: [], proposals: [],
      tasks: [{ type: "object", keys: ["id", "goal"] }], agents: [{ type: "object", keys: ["id", "template"] }], messages: [],
    } as unknown as RunSnapshot;
    expect(liveGraph(snapshot, new Map())).toEqual({ nodes: [], edges: [] });
  });
});
