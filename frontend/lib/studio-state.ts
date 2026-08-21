import {
  parseSpec,
  stringifySpec,
  validateSpec,
  type ComponentManifest,
  type Diagnostic,
  type GraphBody,
  type HarnessSpec,
} from "@harnest/core";
import type { Edge, Node } from "@xyflow/react";
import { catalogMap, validationRegistryFor } from "./component-catalog";

export type HarnessComponent = HarnessSpec["components"][number];
export type HarnessConnection = HarnessSpec["connections"][number];

export type NodeRunState = "idle" | "running" | "success" | "error";

export type HarnessNodeData = Record<string, unknown> & {
  component: HarnessComponent;
  manifest: ComponentManifest;
  diagnostics?: Diagnostic[];
  runState?: NodeRunState;
  iteration?: number;
  attempt?: number;
  onAddAttachment?: (nodeId: string, slot: "tools" | "skills") => void;
};

export type HarnessEdgeData = Record<string, unknown> & {
  connection: HarnessConnection;
  running?: boolean;
};

export type HarnessNode = Node<HarnessNodeData, "harness">;
export type HarnessEdge = Edge<HarnessEdgeData>;

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
}

export interface HarnessDraft {
  root: HarnessRoot;
  nodes: HarnessNode[];
  edges: HarnessEdge[];
  subgraphs: Record<string, HarnessSubgraphDraft>;
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
}

export type StudioDocumentAction =
  | { type: "replace-draft"; draft: HarnessDraft; touch: "none" | "layout" | "semantic" }
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
  | { type: "save-result"; revision: number };

const edgeId = (connection: HarnessConnection, index: number) =>
  connection.id ??
  `${connection.from.component}:${connection.from.port}->${connection.to.component}:${connection.to.port}:${index}`;

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
  const specSubgraphs = spec.version === "0.2" ? spec.subgraphs ?? {} : {};
  const subgraphPositions = spec.version === "0.2" ? spec.studio?.subgraphs ?? {} : {};
  const root = { ...rest } as typeof rest & { subgraphs?: unknown };
  delete root.subgraphs;

  const graphDraft = (graph: GraphBody, graphPositions: Readonly<Record<string, { x: number; y: number }>>): HarnessSubgraphDraft => ({
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
      graphDraft(graph, subgraphPositions[name]?.positions ?? {}),
    ])),
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
  }]));
  return {
    ...draft.root,
    components,
    connections,
    ...(Object.keys(subgraphs).length ? { subgraphs } : {}),
    studio: {
      positions,
      ...(Object.keys(studioSubgraphs).length ? { subgraphs: studioSubgraphs } : {}),
    },
  } as HarnessSpec;
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

      const spec = draftToSpec(action.draft);
      const validation = action.touch === "semantic" ? localValidation(spec, state.catalog) : null;
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
      return {
        ...state,
        draft: specToDraft(state.pendingSpec, state.catalog),
        yamlState: "synced",
        yamlDiagnostics: [],
        pendingSpec: null,
        diagnostics: validation.diagnostics,
        validationPhase: validation.phase,
        revision: state.revision + 1,
        semanticRevision: state.semanticRevision + 1,
        validatedSemanticRevision: null,
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
        draft: specToDraft(draftToSpec(state.draft), action.catalog),
      };
    case "save-result":
      return action.revision === state.revision
        ? { ...state, savedRevision: action.revision }
        : state;
  }
}

export function uniqueComponentId(type: string, existingIds: ReadonlySet<string>) {
  let index = 1;
  while (existingIds.has(`${type}_${index}`)) index += 1;
  return `${type}_${index}`;
}
