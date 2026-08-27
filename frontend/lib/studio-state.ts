import {
  parseSpec,
  stringifySpec,
  validateCandidateConnection,
  validateSpec,
  type ComponentManifest,
  type Diagnostic,
  type GraphBody,
  type HarnessSpec,
  type AgentTemplateSpec,
  type TeamSpec,
} from "@harnestai/core/browser";
import type { Edge, Node } from "@xyflow/react";
import { catalogMap, validationRegistryFor } from "./component-catalog";

export type HarnessComponent = HarnessSpec["components"][number];
export type HarnessConnection = HarnessSpec["connections"][number];

export type NodeRunState = "idle" | "running" | "waiting" | "success" | "error" | "cancelled";

export type HarnessNodeData = Record<string, unknown> & {
  component: HarnessComponent;
  manifest: ComponentManifest;
  diagnostics?: Diagnostic[];
  runState?: NodeRunState;
  iteration?: number;
  attempt?: number;
  pinned?: boolean;
  liveTitle?: string;
  liveSubtitle?: string;
  liveSummary?: string;
  lastRun?: {
    readonly runId?: string;
    readonly state: NodeRunState;
    readonly durationMs?: number;
    readonly eventCount: number;
    readonly error?: string;
  };
  onAddAttachment?: (nodeId: string, slot: "tools" | "skills") => void;
  canInsertAtPort?: (anchor: CanvasPortAnchor) => boolean;
  getPortInsertions?: (anchor: CanvasPortAnchor) => readonly CanvasPortInsertion[];
  onInsertAtPort?: (anchor: CanvasPortAnchor, insertion: CanvasPortInsertion) => void;
  locked?: boolean;
};

export type HarnessEdgeData = Record<string, unknown> & {
  connection?: HarnessConnection;
  running?: boolean;
  kind?: "data" | "condition" | "task" | "handoff" | "message";
};

export type HarnessNode = Node<HarnessNodeData, "harness">;
export type HarnessEdge = Edge<HarnessEdgeData>;

export interface CanvasPortAnchor {
  readonly nodeId: string;
  readonly direction: "input" | "output";
  readonly port: string;
}

export interface CanvasPortInsertion {
  readonly type: string;
  readonly label: string;
  readonly description: string;
  readonly category: string;
  readonly connectPort: string;
  readonly connectType: string;
}

export const isEntrypointCandidate = (node: HarnessNode, edges: readonly HarnessEdge[]) =>
  node.data.manifest.category === "Output" || !edges.some((edge) => edge.source === node.id);

type HarnessRoot = Record<string, unknown> & {
  version: HarnessSpec["version"];
  entrypoint: string;
};

export interface HarnessSubgraphDraft {
  entrypoint: string;
  nodes: HarnessNode[];
  edges: HarnessEdge[];
  layout?: HarnessGraphLayout;
}

export interface HarnessGraphLayout {
  readonly pinned?: readonly string[];
  readonly viewport?: { readonly x: number; readonly y: number; readonly zoom: number };
  readonly direction?: "RIGHT" | "DOWN";
}

export interface HarnessDraft {
  root: HarnessRoot;
  nodes: HarnessNode[];
  edges: HarnessEdge[];
  subgraphs: Record<string, HarnessSubgraphDraft>;
  layout?: HarnessGraphLayout;
}

export function replaceConnectionReferences(draft: HarnessDraft, fromId: string, toId: string): HarnessDraft {
  const replaceNode = (node: HarnessNode): HarnessNode => {
    const config = node.data.component.config as Record<string, unknown>;
    if (config.connectionId !== fromId && config.fallbackConnectionId !== fromId) return node;
    const nextConfig = {
      ...config,
      connectionId: config.connectionId === fromId ? toId : config.connectionId,
      fallbackConnectionId: config.fallbackConnectionId === fromId ? toId : config.fallbackConnectionId,
    };
    if (nextConfig.fallbackConnectionId === nextConfig.connectionId) delete nextConfig.fallbackConnectionId;
    return {
      ...node,
      data: {
        ...node.data,
        component: { ...node.data.component, config: nextConfig } as HarnessComponent,
      },
    };
  };
  return {
    ...draft,
    nodes: draft.nodes.map(replaceNode),
    subgraphs: Object.fromEntries(Object.entries(draft.subgraphs).map(([name, graph]) => [name, {
      ...graph,
      nodes: graph.nodes.map(replaceNode),
    }])),
  };
}

export type ValidationPhase =
  | "local-valid"
  | "local-invalid"
  | "checking"
  | "server-valid"
  | "server-invalid";

export interface StudioDocumentState {
  catalog: readonly ComponentManifest[];
  draft: HarnessDraft;
  yamlText: string;
  yamlState: "synced" | "pending" | "invalid";
  yamlDiagnostics: Diagnostic[];
  pendingSpec: HarnessSpec | null;
  diagnostics: Diagnostic[];
  validationPhase: ValidationPhase;
  revision: number;
  semanticRevision: number;
  savedRevision: number;
  validatedSemanticRevision: number | null;
  historyPast: readonly StudioHistoryEntry[];
  historyFuture: readonly StudioHistoryEntry[];
  transientDraft?: HarnessDraft;
}

export interface StudioHistoryEntry {
  readonly draft: HarnessDraft;
  readonly touch: "layout" | "semantic";
}

export type StudioDocumentAction =
  | { type: "replace-draft"; draft: HarnessDraft; touch: "none" | "transient" | "layout" | "semantic" }
  | {
      type: "edit-yaml";
      text: string;
      pendingSpec: HarnessSpec | null;
      diagnostics: Diagnostic[];
      parseOk: boolean;
    }
  | { type: "discard-yaml" }
  | { type: "apply-yaml" }
  | { type: "validation-start" }
  | { type: "validation-result"; semanticRevision: number; diagnostics: Diagnostic[] }
  | { type: "host-diagnostics"; diagnostics: Diagnostic[] }
  | { type: "set-catalog"; catalog: readonly ComponentManifest[] }
  | { type: "save-result"; revision: number }
  | { type: "load-saved"; spec: HarnessSpec; yaml: string }
  | { type: "undo" }
  | { type: "redo" };

const MAX_HISTORY = 100;

const edgeId = (connection: HarnessConnection, index: number) =>
  connection.id ??
  `${connection.from.component}:${connection.from.port}->${connection.to.component}:${connection.to.port}:${index}`;

const draftId = /^[A-Za-z][A-Za-z0-9_-]*$/u;
const recordValue = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const assertDraftId = (value: string) => {
  if (!draftId.test(value) || value.length > 64) throw new Error("INVALID_DRAFT_ID");
};

export function renameDraftComponent(draft: HarnessDraft, fromId: string, toId: string): HarnessDraft {
  assertDraftId(toId);
  if (!draft.nodes.some(({ id }) => id === fromId)) throw new Error("COMPONENT_NOT_FOUND");
  if (fromId !== toId && draft.nodes.some(({ id }) => id === toId)) throw new Error("COMPONENT_ID_COLLISION");
  if (fromId === toId) return draft;
  const nodes = draft.nodes.map((node) => node.id === fromId ? {
    ...node,
    id: toId,
    data: { ...node.data, component: { ...node.data.component, id: toId } as HarnessComponent },
  } : node);
  const edges = draft.edges.map((edge, index) => {
    const connection = edge.data?.connection;
    const nextConnection = connection ? {
      ...connection,
      from: { ...connection.from, component: connection.from.component === fromId ? toId : connection.from.component },
      to: { ...connection.to, component: connection.to.component === fromId ? toId : connection.to.component },
    } as HarnessConnection : undefined;
    return {
      ...edge,
      id: nextConnection && !nextConnection.id ? edgeId(nextConnection, index) : edge.id,
      source: edge.source === fromId ? toId : edge.source,
      target: edge.target === fromId ? toId : edge.target,
      ...(nextConnection ? { data: { ...edge.data, connection: nextConnection } } : {}),
    };
  });
  const pinned = draft.layout?.pinned?.map((id) => id === fromId ? toId : id);
  return {
    ...draft,
    root: { ...draft.root, entrypoint: draft.root.entrypoint === fromId ? toId : draft.root.entrypoint },
    nodes,
    edges,
    ...(draft.layout ? { layout: { ...draft.layout, ...(pinned ? { pinned: [...new Set(pinned)] } : {}) } } : {}),
  };
}

const mapSubgraphReference = (node: HarnessNode, fromName: string, toName: string): HarnessNode => {
  if (node.data.component.type !== "subgraph" && node.data.component.type !== "loop") return node;
  const config = node.data.component.config as Record<string, unknown>;
  const keys = ["subgraph", "ref", "name"].filter((key) => config[key] === fromName);
  if (!keys.length) return node;
  const nextConfig = { ...config };
  for (const key of keys) nextConfig[key] = toName;
  return { ...node, data: { ...node.data, component: { ...node.data.component, config: nextConfig } as HarnessComponent } };
};

const renameAgentTemplateReferences = (root: HarnessRoot, fromName: string, toName: string): HarnessRoot => {
  const templates = recordValue(root.agentTemplates);
  if (!templates) return root;
  let changed = false;
  const next = Object.fromEntries(Object.entries(templates).map(([id, value]) => {
    const template = recordValue(value);
    const runner = recordValue(template?.runner);
    if (!template || !runner || runner.subgraph !== fromName) return [id, value];
    changed = true;
    return [id, { ...template, runner: { ...runner, subgraph: toName } }];
  }));
  return changed ? { ...root, agentTemplates: next } : root;
};

export interface SubgraphReferenceSummary {
  readonly components: number;
  readonly agentTemplates: number;
  readonly teams: number;
}

export function subgraphReferenceSummary(draft: HarnessDraft, name: string): SubgraphReferenceSummary {
  const nodes = [draft.nodes, ...Object.values(draft.subgraphs).map(({ nodes: graphNodes }) => graphNodes)].flat();
  const components = nodes.filter((node) => (node.data.component.type === "subgraph" || node.data.component.type === "loop")
    && ["subgraph", "ref", "name"].some((key) => (node.data.component.config as Record<string, unknown>)[key] === name)).length;
  const templates = recordValue(draft.root.agentTemplates) ?? {};
  const removedTemplates = new Set(Object.entries(templates).flatMap(([id, value]) =>
    recordValue(recordValue(value)?.runner)?.subgraph === name ? [id] : []));
  const teams = recordValue(draft.root.teams) ?? {};
  const affectedTeams = Object.values(teams).filter((value) => {
    const team = recordValue(value);
    return Boolean(team && (removedTemplates.has(String(team.orchestrator))
      || (Array.isArray(team.members) && team.members.some((id) => removedTemplates.has(String(id))))));
  }).length;
  return { components, agentTemplates: removedTemplates.size, teams: affectedTeams };
}

export function renameDraftSubgraph(draft: HarnessDraft, fromName: string, toName: string): HarnessDraft {
  assertDraftId(toName);
  if (!draft.subgraphs[fromName]) throw new Error("SUBGRAPH_NOT_FOUND");
  if (fromName !== toName && draft.subgraphs[toName]) throw new Error("SUBGRAPH_ID_COLLISION");
  if (fromName === toName) return draft;
  const renameNodes = (nodes: HarnessNode[]) => nodes.map((node) => mapSubgraphReference(node, fromName, toName));
  const subgraphs = Object.fromEntries(Object.entries(draft.subgraphs).map(([name, graph]) => [
    name === fromName ? toName : name,
    { ...graph, nodes: renameNodes(graph.nodes) },
  ]));
  return {
    ...draft,
    root: renameAgentTemplateReferences(draft.root, fromName, toName),
    nodes: renameNodes(draft.nodes),
    subgraphs,
  };
}

const removeSubgraphComponents = <Graph extends { entrypoint: string; nodes: HarnessNode[]; edges: HarnessEdge[]; layout?: HarnessGraphLayout }>(
  graph: Graph,
  name: string,
): Graph => {
  const removed = new Set(graph.nodes.filter((node) => (node.data.component.type === "subgraph" || node.data.component.type === "loop")
    && ["subgraph", "ref", "name"].some((key) => (node.data.component.config as Record<string, unknown>)[key] === name)).map(({ id }) => id));
  if (!removed.size) return graph;
  const nodes = graph.nodes.filter(({ id }) => !removed.has(id));
  const pinned = graph.layout?.pinned?.filter((id) => !removed.has(id));
  return {
    ...graph,
    entrypoint: removed.has(graph.entrypoint) ? nodes[0]?.id ?? "" : graph.entrypoint,
    nodes,
    edges: graph.edges.filter((edge) => !removed.has(edge.source) && !removed.has(edge.target)),
    ...(graph.layout ? { layout: { ...graph.layout, ...(pinned?.length ? { pinned } : { pinned: undefined }) } } : {}),
  };
};

const removeAgentTemplateReferences = (root: HarnessRoot, subgraphName: string): HarnessRoot => {
  const templates = recordValue(root.agentTemplates);
  if (!templates) return root;
  const removed = new Set(Object.entries(templates).flatMap(([id, value]) =>
    recordValue(recordValue(value)?.runner)?.subgraph === subgraphName ? [id] : []));
  if (!removed.size) return root;
  const nextTemplates = Object.fromEntries(Object.entries(templates).filter(([id]) => !removed.has(id)));
  const teams = recordValue(root.teams);
  const nextTeams = teams ? Object.fromEntries(Object.entries(teams).flatMap(([id, value]) => {
    const team = recordValue(value);
    if (!team || removed.has(String(team.orchestrator))) return [];
    const members = Array.isArray(team.members) ? team.members.filter((member) => !removed.has(String(member))) : [];
    return members.length ? [[id, { ...team, members }]] : [];
  })) : undefined;
  return {
    ...root,
    ...(Object.keys(nextTemplates).length ? { agentTemplates: nextTemplates } : { agentTemplates: undefined }),
    ...(nextTeams && Object.keys(nextTeams).length ? { teams: nextTeams } : teams ? { teams: undefined } : {}),
  };
};

export function deleteDraftSubgraph(draft: HarnessDraft, name: string): HarnessDraft {
  if (!draft.subgraphs[name]) throw new Error("SUBGRAPH_NOT_FOUND");
  const rootGraph = removeSubgraphComponents({
    entrypoint: draft.root.entrypoint,
    nodes: draft.nodes,
    edges: draft.edges,
    layout: draft.layout,
  }, name);
  return {
    ...draft,
    root: { ...removeAgentTemplateReferences(draft.root, name), entrypoint: rootGraph.entrypoint },
    nodes: rootGraph.nodes,
    edges: rootGraph.edges,
    ...(rootGraph.layout ? { layout: rootGraph.layout } : {}),
    subgraphs: Object.fromEntries(Object.entries(draft.subgraphs).flatMap(([graphName, graph]) => graphName === name
      ? []
      : [[graphName, removeSubgraphComponents(graph, name)]])),
  };
}

const definitions = <Value>(value: unknown) => recordValue(value) as Record<string, Value> | undefined;

const validateAgentTemplate = (draft: HarnessDraft, template: AgentTemplateSpec) => {
  if (!template.description.trim() || template.description.length > 2_000) throw new Error("AGENT_TEMPLATE_INVALID");
  if (template.capabilities && (template.capabilities.length > 32 || template.capabilities.some((value) => !value || value.length > 128))) {
    throw new Error("AGENT_TEMPLATE_INVALID");
  }
  if ("subgraph" in template.runner && !draft.subgraphs[template.runner.subgraph]) throw new Error("AGENT_TEMPLATE_SUBGRAPH_MISSING");
  if ("a2a" in template.runner && (!template.runner.a2a.connection || template.runner.a2a.connection.length > 128)) throw new Error("AGENT_TEMPLATE_INVALID");
};

export function upsertAgentTemplate(
  draft: HarnessDraft,
  previousId: string | undefined,
  id: string,
  template: AgentTemplateSpec,
): HarnessDraft {
  if (draft.root.version !== "0.3") throw new Error("DEFINITIONS_REQUIRE_V03");
  assertDraftId(id);
  validateAgentTemplate(draft, template);
  const current = definitions<AgentTemplateSpec>(draft.root.agentTemplates) ?? {};
  if (id !== previousId && current[id]) throw new Error("AGENT_TEMPLATE_ID_COLLISION");
  if (previousId && !current[previousId]) throw new Error("AGENT_TEMPLATE_NOT_FOUND");
  const next = { ...current };
  if (previousId && previousId !== id) delete next[previousId];
  next[id] = {
    ...template,
    description: template.description.trim(),
    ...(template.capabilities?.length ? { capabilities: [...new Set(template.capabilities.map((value) => value.trim()).filter(Boolean))] } : { capabilities: undefined }),
  };
  const teams = definitions<TeamSpec>(draft.root.teams);
  const renamedTeams = previousId && previousId !== id && teams ? Object.fromEntries(Object.entries(teams).map(([name, team]) => [name, {
    ...team,
    orchestrator: team.orchestrator === previousId ? id : team.orchestrator,
    members: team.members.map((member) => member === previousId ? id : member),
  }])) : teams;
  return { ...draft, root: { ...draft.root, agentTemplates: next, ...(renamedTeams ? { teams: renamedTeams } : {}) } };
}

const removeTeamComponents = (draft: HarnessDraft, removedTeams: ReadonlySet<string>): HarnessDraft => {
  const remove = <Graph extends { entrypoint: string; nodes: HarnessNode[]; edges: HarnessEdge[]; layout?: HarnessGraphLayout }>(graph: Graph): Graph => {
    const removed = new Set(graph.nodes.filter((node) => node.data.component.type === "team"
      && removedTeams.has(String((node.data.component.config as Record<string, unknown>).team))).map(({ id }) => id));
    if (!removed.size) return graph;
    const nodes = graph.nodes.filter(({ id }) => !removed.has(id));
    const pinned = graph.layout?.pinned?.filter((id) => !removed.has(id));
    return {
      ...graph,
      entrypoint: removed.has(graph.entrypoint) ? nodes[0]?.id ?? "" : graph.entrypoint,
      nodes,
      edges: graph.edges.filter((edge) => !removed.has(edge.source) && !removed.has(edge.target)),
      ...(graph.layout ? { layout: { ...graph.layout, ...(pinned?.length ? { pinned } : { pinned: undefined }) } } : {}),
    };
  };
  const root = remove({ entrypoint: draft.root.entrypoint, nodes: draft.nodes, edges: draft.edges, layout: draft.layout });
  return {
    ...draft,
    root: { ...draft.root, entrypoint: root.entrypoint },
    nodes: root.nodes,
    edges: root.edges,
    ...(root.layout ? { layout: root.layout } : {}),
    subgraphs: Object.fromEntries(Object.entries(draft.subgraphs).map(([name, graph]) => [name, remove(graph)])),
  };
};

export function deleteAgentTemplate(draft: HarnessDraft, id: string): HarnessDraft {
  const templates = definitions<AgentTemplateSpec>(draft.root.agentTemplates) ?? {};
  if (!templates[id]) throw new Error("AGENT_TEMPLATE_NOT_FOUND");
  const nextTemplates = Object.fromEntries(Object.entries(templates).filter(([name]) => name !== id));
  const teams = definitions<TeamSpec>(draft.root.teams) ?? {};
  const removedTeams = new Set<string>();
  const nextTeams = Object.fromEntries(Object.entries(teams).flatMap(([name, team]) => {
    if (team.orchestrator === id) {
      removedTeams.add(name);
      return [];
    }
    const members = team.members.filter((member) => member !== id);
    if (!members.length) {
      removedTeams.add(name);
      return [];
    }
    return [[name, { ...team, members }]];
  }));
  return removeTeamComponents({
    ...draft,
    root: {
      ...draft.root,
      ...(Object.keys(nextTemplates).length ? { agentTemplates: nextTemplates } : { agentTemplates: undefined }),
      ...(Object.keys(nextTeams).length ? { teams: nextTeams } : { teams: undefined }),
    },
  }, removedTeams);
}

const limitRanges: Readonly<Record<string, readonly [number, number]>> = {
  maxInstances: [1, 64], maxDepth: [1, 8], maxParallel: [1, 16], maxMessages: [1, 1_000], maxPlanRevisions: [1, 100],
};

const validateTeam = (draft: HarnessDraft, team: TeamSpec) => {
  const templates = definitions<AgentTemplateSpec>(draft.root.agentTemplates) ?? {};
  if (!templates[team.orchestrator] || !team.members.length || team.members.length > 32
    || team.members.some((member) => !templates[member]) || new Set(team.members).size !== team.members.length) throw new Error("TEAM_REFERENCE_INVALID");
  for (const [key, value] of Object.entries(team.limits ?? {})) {
    const range = limitRanges[key];
    if (!range || !Number.isInteger(value) || value < range[0] || value > range[1]) throw new Error("TEAM_LIMIT_INVALID");
  }
};

export function upsertTeam(draft: HarnessDraft, previousId: string | undefined, id: string, team: TeamSpec): HarnessDraft {
  if (draft.root.version !== "0.3") throw new Error("DEFINITIONS_REQUIRE_V03");
  assertDraftId(id);
  validateTeam(draft, team);
  const current = definitions<TeamSpec>(draft.root.teams) ?? {};
  if (id !== previousId && current[id]) throw new Error("TEAM_ID_COLLISION");
  if (previousId && !current[previousId]) throw new Error("TEAM_NOT_FOUND");
  const next = { ...current };
  if (previousId && previousId !== id) delete next[previousId];
  next[id] = team;
  const renameNodes = (nodes: HarnessNode[]) => previousId && previousId !== id ? nodes.map((node) => {
    if (node.data.component.type !== "team" || (node.data.component.config as Record<string, unknown>).team !== previousId) return node;
    return { ...node, data: { ...node.data, component: { ...node.data.component, config: { ...node.data.component.config, team: id } } as HarnessComponent } };
  }) : nodes;
  return {
    ...draft,
    root: { ...draft.root, teams: next },
    nodes: renameNodes(draft.nodes),
    subgraphs: Object.fromEntries(Object.entries(draft.subgraphs).map(([name, graph]) => [name, { ...graph, nodes: renameNodes(graph.nodes) }])),
  };
}

export function deleteTeam(draft: HarnessDraft, id: string): HarnessDraft {
  const teams = definitions<TeamSpec>(draft.root.teams) ?? {};
  if (!teams[id]) throw new Error("TEAM_NOT_FOUND");
  const next = Object.fromEntries(Object.entries(teams).filter(([name]) => name !== id));
  return removeTeamComponents({
    ...draft,
    root: { ...draft.root, ...(Object.keys(next).length ? { teams: next } : { teams: undefined }) },
  }, new Set([id]));
}

const unknownManifest = (type: string): ComponentManifest => ({
  type,
  label: type,
  category: "Custom",
  description: "Manifest unavailable — validate the registered component module.",
  ports: { inputs: {}, outputs: {} },
  configSchema: {},
  defaultConfig: {},
  inspector: [],
});

export function specToDraft(spec: HarnessSpec, catalog: readonly ComponentManifest[]): HarnessDraft {
  const { components, connections, studio, ...rest } = spec;
  const positions = studio?.positions ?? {};
  const manifests = catalogMap(catalog);
  const specSubgraphs = spec.version !== "0.1" ? spec.subgraphs ?? {} : {};
  const subgraphPositions = spec.version !== "0.1" ? spec.studio?.subgraphs ?? {} : {};
  const studioV3 = spec.version === "0.3" ? spec.studio : undefined;
  const root = { ...rest } as typeof rest & { subgraphs?: unknown };
  delete root.subgraphs;

  const graphDraft = (
    graph: GraphBody,
    graphPositions: Readonly<Record<string, { x: number; y: number }>>,
    layout?: HarnessGraphLayout,
  ): HarnessSubgraphDraft => ({
    entrypoint: graph.entrypoint,
    nodes: graph.components.map((component, index) => ({
      id: component.id,
      type: "harness",
      position: graphPositions[component.id] ?? { x: 80 + (index % 2) * 320, y: 80 + Math.floor(index / 2) * 170 },
      data: { component, manifest: manifests.get(component.type) ?? unknownManifest(component.type) },
    })),
    edges: graph.connections.map((connection, index) => ({
      id: edgeId(connection, index),
      type: "smoothstep",
      source: connection.from.component,
      sourceHandle: connection.from.port,
      target: connection.to.component,
      targetHandle: connection.to.port,
      data: { connection },
    })),
    ...(layout ? { layout } : {}),
  });

  return {
    root: root as HarnessRoot,
    nodes: components.map((component, index) => ({
      id: component.id,
      type: "harness",
      position: positions[component.id] ?? {
        x: 80 + (index % 2) * 320,
        y: 80 + Math.floor(index / 2) * 170,
      },
      data: { component, manifest: manifests.get(component.type) ?? unknownManifest(component.type) },
    })),
    edges: connections.map((connection, index) => ({
      id: edgeId(connection, index),
      type: "smoothstep",
      source: connection.from.component,
      sourceHandle: connection.from.port,
      target: connection.to.component,
      targetHandle: connection.to.port,
      data: { connection },
    })),
    subgraphs: Object.fromEntries(Object.entries(specSubgraphs).map(([name, graph]) => [
      name,
      graphDraft(graph, subgraphPositions[name]?.positions ?? {}, spec.version === "0.3" ? {
        ...(studioV3?.subgraphs?.[name]?.pinned ? { pinned: studioV3.subgraphs[name].pinned } : {}),
        ...(studioV3?.subgraphs?.[name]?.viewport ? { viewport: studioV3.subgraphs[name].viewport } : {}),
        ...(studioV3?.subgraphs?.[name]?.direction ? { direction: studioV3.subgraphs[name].direction } : {}),
      } : undefined),
    ])),
    ...(spec.version === "0.3" ? { layout: {
      ...(studioV3?.pinned ? { pinned: studioV3.pinned } : {}),
      ...(studioV3?.viewport ? { viewport: studioV3.viewport } : {}),
      ...(studioV3?.direction ? { direction: studioV3.direction } : {}),
    } } : {}),
  };
}

function draftWithCatalog(draft: HarnessDraft, catalog: readonly ComponentManifest[]): HarnessDraft {
  const manifests = catalogMap(catalog);
  const updateNodes = (nodes: HarnessNode[]) => nodes.map((node) => ({
    ...node,
    data: {
      ...node.data,
      manifest: manifests.get(node.data.component.type) ?? unknownManifest(node.data.component.type),
    },
  }));
  return {
    ...draft,
    nodes: updateNodes(draft.nodes),
    subgraphs: Object.fromEntries(Object.entries(draft.subgraphs).map(([name, graph]) => [name, {
      ...graph,
      nodes: updateNodes(graph.nodes),
    }])),
  };
}

export function draftToSpec(draft: HarnessDraft): HarnessSpec {
  const components = draft.nodes.map((node) => node.data.component);
  const connections = draft.edges.map((edge) => edge.data?.connection).filter(Boolean) as HarnessConnection[];
  const positions = Object.fromEntries(draft.nodes.map((node) => [node.id, node.position]));
  if (draft.root.version === "0.1") return {
    ...draft.root,
    components,
    connections,
    studio: { positions },
  } as HarnessSpec;

  const subgraphs = Object.fromEntries(Object.entries(draft.subgraphs).map(([name, graph]) => [name, {
    components: graph.nodes.map((node) => node.data.component),
    connections: graph.edges.map((edge) => edge.data?.connection).filter(Boolean),
    entrypoint: graph.entrypoint,
  }]));
  const studioSubgraphs = Object.fromEntries(Object.entries(draft.subgraphs).map(([name, graph]) => [name, {
    positions: Object.fromEntries(graph.nodes.map((node) => [node.id, node.position])),
    ...(draft.root.version === "0.3" && graph.layout?.pinned ? { pinned: [...graph.layout.pinned] } : {}),
    ...(draft.root.version === "0.3" && graph.layout?.viewport ? { viewport: graph.layout.viewport } : {}),
    ...(draft.root.version === "0.3" && graph.layout?.direction ? { direction: graph.layout.direction } : {}),
  }]));
  return {
    ...draft.root,
    components,
    connections,
    ...(Object.keys(subgraphs).length ? { subgraphs } : {}),
    studio: {
      positions,
      ...(draft.root.version === "0.3" && draft.layout?.pinned ? { pinned: [...draft.layout.pinned] } : {}),
      ...(draft.root.version === "0.3" && draft.layout?.viewport ? { viewport: draft.layout.viewport } : {}),
      ...(draft.root.version === "0.3" && draft.layout?.direction ? { direction: draft.layout.direction } : {}),
      ...(Object.keys(studioSubgraphs).length ? { subgraphs: studioSubgraphs } : {}),
    },
  } as HarnessSpec;
}

export function compatiblePortInsertions(
  draft: HarnessDraft,
  catalog: readonly ComponentManifest[],
  anchor: CanvasPortAnchor,
): CanvasPortInsertion[] {
  const source = draft.nodes.find((node) => node.id === anchor.nodeId);
  if (!source) return [];
  const base = draftToSpec(draft);
  if (anchor.direction === "output" && base.entrypoint === anchor.nodeId) return [];
  const anchorType = (anchor.direction === "output"
    ? source.data.manifest.ports.outputs[anchor.port]
    : source.data.manifest.ports.inputs[anchor.port])?.type;
  const registry = validationRegistryFor(catalog);
  const existingIds = new Set(draft.nodes.map((node) => node.id));
  return catalog.flatMap((manifest): CanvasPortInsertion[] => {
    const id = uniqueComponentId(manifest.type, existingIds);
    const component = { id, type: manifest.type, config: structuredClone(manifest.defaultConfig) } as HarnessComponent;
    const candidateSpec = { ...base, components: [...base.components, component] } as HarnessSpec;
    const ports = anchor.direction === "output" ? manifest.ports.inputs : manifest.ports.outputs;
    return Object.entries(ports).flatMap(([port, definition]) => {
      const connection: HarnessConnection = anchor.direction === "output"
        ? { from: { component: anchor.nodeId, port: anchor.port }, to: { component: id, port } }
        : { from: { component: id, port }, to: { component: anchor.nodeId, port: anchor.port } };
      return validateCandidateConnection(candidateSpec, connection, { components: registry }).ok ? [{
        type: manifest.type,
        label: manifest.label,
        description: manifest.description ?? manifest.type,
        category: manifest.category,
        connectPort: port,
        connectType: definition.type,
      }] : [];
    });
  }).sort((left, right) => Number(right.connectType === anchorType) - Number(left.connectType === anchorType)
    || left.category.localeCompare(right.category) || left.label.localeCompare(right.label));
}

function localValidation(spec: HarnessSpec, catalog: readonly ComponentManifest[]) {
  const result = validateSpec(spec, { components: validationRegistryFor(catalog) });
  return {
    diagnostics: result.diagnostics,
    phase: (result.ok ? "local-valid" : "local-invalid") as ValidationPhase,
  };
}

export function createDocumentState(
  spec: HarnessSpec,
  catalog: readonly ComponentManifest[],
  yamlText = stringifySpec(spec),
  initialDiagnostics: readonly Diagnostic[] = [],
): StudioDocumentState {
  const validation = localValidation(spec, catalog);
  const diagnostics = [...initialDiagnostics, ...validation.diagnostics];
  return {
    catalog,
    draft: specToDraft(spec, catalog),
    yamlText,
    yamlState: "synced",
    yamlDiagnostics: [],
    pendingSpec: null,
    diagnostics,
    validationPhase: diagnostics.some((item) => item.severity === "error") ? "local-invalid" : validation.phase,
    revision: 0,
    semanticRevision: 0,
    savedRevision: 0,
    validatedSemanticRevision: null,
    historyPast: [],
    historyFuture: [],
  };
}

export function parseYamlDraft(text: string, catalog: readonly ComponentManifest[]) {
  const parsed = parseSpec(text);
  if (!parsed.ok) {
    return { parseOk: false, spec: null, diagnostics: parsed.diagnostics };
  }

  const validation = validateSpec(parsed.spec, { components: validationRegistryFor(catalog) });
  return {
    parseOk: true,
    spec: parsed.spec,
    diagnostics: validation.diagnostics,
  };
}

export function studioDocumentReducer(
  state: StudioDocumentState,
  action: StudioDocumentAction,
): StudioDocumentState {
  switch (action.type) {
    case "replace-draft": {
      if (action.touch === "none") return { ...state, draft: action.draft };
      if (action.touch === "transient") return {
        ...state,
        draft: action.draft,
        transientDraft: state.transientDraft ?? state.draft,
      };

      const spec = draftToSpec(action.draft);
      const validation = action.touch === "semantic" ? localValidation(spec, state.catalog) : null;
      const previous = state.transientDraft ?? state.draft;
      return {
        ...state,
        draft: action.draft,
        yamlText: stringifySpec(spec),
        yamlState: "synced",
        yamlDiagnostics: [],
        pendingSpec: null,
        diagnostics: validation?.diagnostics ?? state.diagnostics,
        validationPhase: validation?.phase ?? state.validationPhase,
        revision: state.revision + 1,
        semanticRevision: state.semanticRevision + (action.touch === "semantic" ? 1 : 0),
        validatedSemanticRevision:
          action.touch === "semantic" ? null : state.validatedSemanticRevision,
        historyPast: [...state.historyPast, { draft: previous, touch: action.touch }].slice(-MAX_HISTORY),
        historyFuture: [],
        transientDraft: undefined,
      };
    }
    case "edit-yaml":
      return {
        ...state,
        yamlText: action.text,
        yamlState: action.parseOk ? "pending" : "invalid",
        yamlDiagnostics: action.diagnostics,
        pendingSpec: action.pendingSpec,
      };
    case "discard-yaml":
      return {
        ...state,
        yamlText: stringifySpec(draftToSpec(state.draft)),
        yamlState: "synced",
        yamlDiagnostics: [],
        pendingSpec: null,
      };
    case "apply-yaml": {
      if (!state.pendingSpec) return state;
      const validation = localValidation(state.pendingSpec, state.catalog);
      const draft = specToDraft(state.pendingSpec, state.catalog);
      return {
        ...state,
        draft,
        yamlText: stringifySpec(state.pendingSpec),
        yamlState: "synced",
        yamlDiagnostics: [],
        pendingSpec: null,
        diagnostics: validation.diagnostics,
        validationPhase: validation.phase,
        revision: state.revision + 1,
        semanticRevision: state.semanticRevision + 1,
        validatedSemanticRevision: null,
        historyPast: [...state.historyPast, { draft: state.draft, touch: "semantic" as const }].slice(-MAX_HISTORY),
        historyFuture: [],
        transientDraft: undefined,
      };
    }
    case "validation-start":
      return { ...state, validationPhase: "checking" };
    case "validation-result": {
      if (action.semanticRevision !== state.semanticRevision) return state;
      const valid = !action.diagnostics.some((diagnostic) => diagnostic.severity === "error");
      return {
        ...state,
        diagnostics: action.diagnostics,
        validationPhase: valid ? "server-valid" : "server-invalid",
        validatedSemanticRevision: action.semanticRevision,
      };
    }
    case "host-diagnostics": {
      const local = localValidation(draftToSpec(state.draft), state.catalog);
      const diagnostics = [...action.diagnostics, ...local.diagnostics];
      return {
        ...state,
        diagnostics,
        validationPhase: diagnostics.some((item) => item.severity === "error") ? "local-invalid" : local.phase,
        validatedSemanticRevision: null,
      };
    }
    case "set-catalog":
      return {
        ...state,
        catalog: action.catalog,
        draft: draftWithCatalog(state.draft, action.catalog),
        historyPast: state.historyPast.map((entry) => ({
          ...entry,
          draft: draftWithCatalog(entry.draft, action.catalog),
        })),
        historyFuture: state.historyFuture.map((entry) => ({
          ...entry,
          draft: draftWithCatalog(entry.draft, action.catalog),
        })),
        ...(state.transientDraft ? { transientDraft: draftWithCatalog(state.transientDraft, action.catalog) } : {}),
      };
    case "save-result":
      return action.revision === state.revision
        ? { ...state, savedRevision: action.revision }
        : state;
    case "load-saved":
      return createDocumentState(action.spec, state.catalog, action.yaml);
    case "undo": {
      const previous = state.historyPast.at(-1);
      if (!previous) return state;
      const spec = draftToSpec(previous.draft);
      const validation = previous.touch === "semantic" ? localValidation(spec, state.catalog) : null;
      return {
        ...state,
        draft: previous.draft,
        yamlText: stringifySpec(spec),
        yamlState: "synced",
        yamlDiagnostics: [],
        pendingSpec: null,
        diagnostics: validation?.diagnostics ?? state.diagnostics,
        validationPhase: validation?.phase ?? state.validationPhase,
        revision: state.revision + 1,
        semanticRevision: state.semanticRevision + (previous.touch === "semantic" ? 1 : 0),
        validatedSemanticRevision: previous.touch === "semantic" ? null : state.validatedSemanticRevision,
        historyPast: state.historyPast.slice(0, -1),
        historyFuture: [...state.historyFuture, { draft: state.draft, touch: previous.touch }].slice(-MAX_HISTORY),
        transientDraft: undefined,
      };
    }
    case "redo": {
      const next = state.historyFuture.at(-1);
      if (!next) return state;
      const spec = draftToSpec(next.draft);
      const validation = next.touch === "semantic" ? localValidation(spec, state.catalog) : null;
      return {
        ...state,
        draft: next.draft,
        yamlText: stringifySpec(spec),
        yamlState: "synced",
        yamlDiagnostics: [],
        pendingSpec: null,
        diagnostics: validation?.diagnostics ?? state.diagnostics,
        validationPhase: validation?.phase ?? state.validationPhase,
        revision: state.revision + 1,
        semanticRevision: state.semanticRevision + (next.touch === "semantic" ? 1 : 0),
        validatedSemanticRevision: next.touch === "semantic" ? null : state.validatedSemanticRevision,
        historyPast: [...state.historyPast, { draft: state.draft, touch: next.touch }].slice(-MAX_HISTORY),
        historyFuture: state.historyFuture.slice(0, -1),
        transientDraft: undefined,
      };
    }
  }
}

export function uniqueComponentId(type: string, existingIds: ReadonlySet<string>) {
  let index = 1;
  while (existingIds.has(`${type}_${index}`)) index += 1;
  return `${type}_${index}`;
}
