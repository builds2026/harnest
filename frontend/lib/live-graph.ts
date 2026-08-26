import type { ComponentManifest, RunEvent, RunSnapshot, WorkStatus } from "@harnestai/core";
import type { HarnessComponent, HarnessEdge, HarnessNode, NodeRunState } from "./studio-state";

export function latestRunSnapshot(events: readonly RunEvent[]): RunSnapshot | undefined {
  return events.findLast((event): event is Extract<RunEvent, { type: "run-snapshot" }> => event.type === "run-snapshot")?.snapshot;
}

const runState = (status: WorkStatus): NodeRunState => status === "completed" ? "success"
  : status === "failed" || status === "blocked" ? "error"
    : status === "cancelled" || status === "superseded" ? "cancelled"
      : status === "waiting" ? "waiting"
        : status === "running" ? "running" : "idle";

const liveManifest = (base: ComponentManifest | undefined, label: string, category: string): ComponentManifest => ({
  type: base?.type ?? "agent",
  label,
  category,
  description: base?.description ?? label,
  ports: { inputs: {}, outputs: {} },
  configSchema: {},
  defaultConfig: {},
  inspector: [],
});

export interface LiveGraphLabels {
  readonly task: string;
  readonly agent: string;
  readonly assigned: string;
  readonly handoff: string;
  orchestrator(): string;
  workingOn(taskId: string): string;
  depth(value: number): string;
  tokens(value: number): string;
  status(value: WorkStatus): string;
}

const defaultLabels: LiveGraphLabels = {
  task: "Task", agent: "Agent", assigned: "assigned", handoff: "handoff",
  orchestrator: () => "Orchestrator",
  workingOn: (taskId) => `Working on ${taskId}`,
  depth: (value) => `Depth ${value}`,
  tokens: (value) => `${value} tokens`,
  status: (value) => value,
};

export function liveGraph(
  snapshot: RunSnapshot | undefined,
  manifests: ReadonlyMap<string, ComponentManifest>,
  labels: LiveGraphLabels = defaultLabels,
): { nodes: HarnessNode[]; edges: HarnessEdge[] } {
  if (!snapshot) return { nodes: [], edges: [] };
  const validTask = (task: RunSnapshot["tasks"][number]) => typeof task?.id === "string" && typeof task.goal === "string" && typeof task.assignee === "string";
  const validAgent = (agent: RunSnapshot["agents"][number]) => typeof agent?.id === "string" && typeof agent.template === "string" && typeof agent.depth === "number";
  const taskList = Array.isArray(snapshot.tasks) ? snapshot.tasks.filter(validTask) : [];
  const agentList = Array.isArray(snapshot.agents) ? snapshot.agents.filter(validAgent) : [];
  const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
  const tasks = new Map(taskList.map((task, index) => [task.id, { task, index }]));
  const agents = new Map(agentList.map((agent, index) => [agent.id, { agent, index }]));
  const nodes: HarnessNode[] = [
    ...taskList.map((task, index) => ({
      id: `task:${task.id}`,
      type: "harness" as const,
      position: { x: 420, y: 70 + index * 170 },
      data: {
        component: { id: `task:${task.id}`, type: "prompt", config: {} } as HarnessComponent,
        manifest: liveManifest(manifests.get("prompt"), labels.task, "Flow"),
        runState: runState(task.status),
        liveTitle: task.goal,
        liveSubtitle: `${task.id} · ${labels.status(task.status)}`,
        liveSummary: task.error ?? `Assigned to ${task.assignee}`,
      },
    })),
    ...agentList.map((agent, index) => {
      const taskIndex = agent.taskId ? tasks.get(agent.taskId)?.index : undefined;
      return {
        id: `agent:${agent.id}`,
        type: "harness" as const,
        position: {
          x: agent.taskId ? 780 : 70 + agent.depth * 260,
          y: taskIndex === undefined ? 70 + index * 150 : 70 + taskIndex * 170,
        },
        data: {
          component: { id: `agent:${agent.id}`, type: "agent", config: {} } as HarnessComponent,
          manifest: liveManifest(manifests.get("agent"), labels.agent, "Agent"),
          runState: runState(agent.status),
          liveTitle: agent.template,
          liveSubtitle: `${agent.id.slice(0, 18)} · ${labels.status(agent.status)}`,
          liveSummary: `${agent.taskId ? labels.workingOn(agent.taskId) : agent.depth === 0 ? labels.orchestrator() : labels.depth(agent.depth)}${agent.usage?.totalTokens === undefined ? "" : ` · ${labels.tokens(agent.usage.totalTokens)}`}`,
        },
      };
    }),
  ];
  const edges: HarnessEdge[] = [];
  for (const { agent } of agents.values()) {
    if (agent.parentId && agents.has(agent.parentId)) edges.push({
      id: `handoff:${agent.parentId}:${agent.id}`,
      source: `agent:${agent.parentId}`,
      target: `agent:${agent.id}`,
      type: "harness",
      label: labels.handoff,
      data: { kind: "handoff", running: agent.status === "running" },
    });
    if (agent.taskId && tasks.has(agent.taskId)) edges.push({
      id: `task:${agent.taskId}:${agent.id}`,
      source: `task:${agent.taskId}`,
      target: `agent:${agent.id}`,
      type: "harness",
      label: labels.assigned,
      data: { kind: "task", running: agent.status === "running" },
    });
  }
  for (const message of messages) {
    if (!message || typeof message.id !== "string" || typeof message.from !== "string" || !message.to || message.from === "user" || !agents.has(message.from)) continue;
    const recipients = message.to.kind === "agent" && message.to.id && agents.has(message.to.id) ? [message.to.id]
      : message.to.kind === "team" && message.to.id
        ? [...agents.values()].filter(({ agent }) => agent.teamId === message.to.id && agent.id !== message.from).map(({ agent }) => agent.id)
        : [];
    for (const recipient of recipients) edges.push({
      id: `message:${message.id}:${recipient}`,
      source: `agent:${message.from}`,
      target: `agent:${recipient}`,
      type: "harness",
      label: message.kind,
      data: { kind: "message" },
    });
  }
  return { nodes, edges };
}
