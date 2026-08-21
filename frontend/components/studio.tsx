"use client";

import {
  BUILTIN_COMPONENT_MANIFESTS,
  parseSpec,
  stringifySpec,
  validateCandidateConnection,
  type ComponentManifest,
  type Diagnostic,
  type HarnessSpec,
  type RunEvent,
} from "@harnest/core";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type IsValidConnection,
  type OnEdgesChange,
  type OnNodesChange,
  type XYPosition,
} from "@xyflow/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  createDocumentState,
  draftToSpec,
  isEntrypointCandidate,
  parseYamlDraft,
  studioDocumentReducer,
  uniqueComponentId,
  type HarnessComponent,
  type HarnessConnection,
  type HarnessDraft,
  type HarnessEdge,
  type HarnessNode,
  type NodeRunState,
} from "@/lib/studio-state";
import { catalogMap, colorFor, glyphFor, validationRegistryFor } from "@/lib/component-catalog";
import { EMPTY_SPEC } from "@/lib/default-spec";
import { readNdjson } from "@/lib/ndjson";
import { traceViewKey, visibleActiveEdgeId, visibleTraceId } from "@/lib/trace-view";
import { HarnessNodeComponent } from "./harness-node";
import { Inspector } from "./inspector";

const DND_MIME = "application/x-harnest-component";
const nodeTypes = { harness: HarnessNodeComponent };
const defaultEdgeOptions = { type: "smoothstep", interactionWidth: 24 };
const snapGrid: [number, number] = [16, 16];
const LEGACY_COMPONENT_TYPES = new Set(["model", "prompt", "agent", "output"]);

interface SpecPayload {
  spec: HarnessSpec;
  yaml: string;
  file: string;
  exists: boolean;
  catalog?: ComponentManifest[];
  diagnostics?: Diagnostic[];
}

type BootState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; payload: SpecPayload };

type RunPhase = "idle" | "starting" | "streaming" | "cancelling" | "cancelled" | "success" | "error";
type DockTab = "yaml" | "problems" | "run" | "tests" | "trace";

interface TestCaseResult {
  id: string;
  ok: boolean;
  durationMs: number;
  output?: unknown;
  error?: string;
  assertions?: Array<{ type: string; ok: boolean; message?: string }>;
}

interface TestReport {
  ok: boolean;
  passed: number;
  failed: number;
  cases: TestCaseResult[];
}

interface StoredRun {
  runId: string;
  startedAt?: string;
  status?: string;
  durationMs?: number;
  usage?: unknown;
  costUsd?: number;
  events?: RunEvent[];
}

const responseMessage = async (response: Response) => {
  const payload = await response.json().catch(() => null) as
    | { error?: string; diagnostics?: Diagnostic[] }
    | null;
  return payload?.error ?? payload?.diagnostics?.[0]?.message ?? `Request failed with ${response.status}`;
};

const chooseEntrypoint = (draft: HarnessDraft) => {
  const outgoing = new Set(draft.edges.map((edge) => edge.source));
  return draft.nodes.find((node) => node.data.manifest.category === "Output" && !outgoing.has(node.id))?.id
    ?? draft.nodes.find((node) => !outgoing.has(node.id))?.id
    ?? "";
};

const eventData = (event: RunEvent) => event as unknown as Record<string, unknown>;
const eventNodeId = (event: RunEvent) => {
  const value = eventData(event).nodeId;
  return typeof value === "string" ? value : undefined;
};

const eventSummary = (event: RunEvent) => {
  const data = eventData(event);
  switch (data.type) {
    case "run-start": return `Run ${String(data.runId)} started`;
    case "node-start": return `${String(data.nodeId)} started${typeof data.iteration === "number" ? ` · iteration ${data.iteration}` : ""}`;
    case "text-delta": return String(data.text ?? "");
    case "usage": return `${String(data.nodeId)} reported token usage`;
    case "node-end": return `${String(data.nodeId)} completed in ${Math.round(Number(data.durationMs ?? 0))}ms`;
    case "edge": {
      const from = data.from as { component?: unknown; port?: unknown } | undefined;
      const to = data.to as { component?: unknown; port?: unknown } | undefined;
      return `${String(from?.component ?? "edge")}.${String(from?.port ?? "output")} → ${String(to?.component ?? "next")}.${String(to?.port ?? "input")}`;
    }
    case "node-skip": return `${String(data.nodeId)} skipped`;
    case "retry": return `${String(data.nodeId)} retry ${String(data.attempt ?? "")}`.trim();
    case "iteration": return `${String(data.nodeId ?? "Loop")} iteration ${String(data.iteration ?? "")}`.trim();
    case "context-use": return `${String(data.nodeId)} used ${String(data.source ?? data.contextId ?? "context")}`;
    case "tool-call": return `${String(data.nodeId)} called ${String(data.tool ?? data.toolName ?? "tool")}`;
    case "tool-result": return `${String(data.tool ?? data.toolName ?? "Tool")} returned`;
    case "evaluation": return `${String(data.nodeId ?? "Evaluator")}: ${data.passed === false ? "failed" : "passed"}`;
    case "run-end": return `Run completed in ${Math.round(Number(data.durationMs ?? 0))}ms`;
    case "error": return String(data.message ?? "Run failed");
    default: return String(data.type ?? "event");
  }
};

const edgeLabel = (connection: HarnessConnection) => {
  const value = connection as HarnessConnection & {
    condition?: { path?: string; op?: string; value?: unknown };
    select?: string;
    state?: { key?: string; merge?: string };
  };
  const condition = value.condition
    ? [value.condition.path, value.condition.op, value.condition.value === undefined ? undefined : JSON.stringify(value.condition.value)].filter(Boolean).join(" ")
    : "";
  const flow = [value.select, value.state?.key ? `→ ${value.state.key}` : undefined].filter(Boolean).join(" ");
  return [condition, flow].filter(Boolean).join(" · ");
};

const formatOutput = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value, null, 2);

function Startup({ state, onRetry }: { state: BootState; onRetry: () => void }) {
  const error = state.phase === "error";
  return (
    <div className={error ? "studio-fatal" : "studio-loading"}>
      <div className="startup-card">
        <div className="startup-mark" />
        <h1>{error ? "Studio could not open the harness" : "Checking harness continuity"}</h1>
        <p>{error ? state.message : "Loading the current harnest.yaml and its visual layout."}</p>
        {error && <button className="button button-primary" style={{ marginTop: 18 }} onClick={onRetry}>Try again</button>}
      </div>
    </div>
  );
}

export default function Studio() {
  const [boot, setBoot] = useState<BootState>({ phase: "loading" });
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setBoot({ phase: "loading" });
    fetch("/api/spec", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await responseMessage(response));
        return response.json() as Promise<SpecPayload>;
      })
      .then((payload) => setBoot({ phase: "ready", payload }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setBoot({ phase: "error", message: error instanceof Error ? error.message : "The harness could not be loaded." });
      });
    return () => controller.abort();
  }, [loadAttempt]);

  if (boot.phase !== "ready") return <Startup state={boot} onRetry={() => setLoadAttempt((value) => value + 1)} />;

  return (
    <ReactFlowProvider>
      <StudioReady key={`${boot.payload.file}:${loadAttempt}`} initial={boot.payload} />
    </ReactFlowProvider>
  );
}

function StudioReady({ initial }: { initial: SpecPayload }) {
  const [catalog, setCatalog] = useState<readonly ComponentManifest[]>(
    () => initial.catalog?.length ? initial.catalog : BUILTIN_COMPONENT_MANIFESTS,
  );
  const manifests = useMemo(() => catalogMap(catalog), [catalog]);
  const validationComponents = useMemo(() => validationRegistryFor(catalog), [catalog]);
  const [document, dispatch] = useReducer(
    studioDocumentReducer,
    undefined,
    () => createDocumentState(initial.spec ?? EMPTY_SPEC, catalog, initial.yaml, initial.diagnostics),
  );
  const [activeSubgraph, setActiveSubgraph] = useState<string>();
  const [activeDock, setActiveDock] = useState<DockTab>("yaml");
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteCategory, setPaletteCategory] = useState("all");
  const [savePhase, setSavePhase] = useState<"idle" | "saving" | "error">("idle");
  const [statusNote, setStatusNote] = useState(initial.diagnostics?.some((item) => item.severity === "error")
    ? `${initial.diagnostics.length} host capability or module issue(s)`
    : initial.exists ? "Harness loaded" : "New harness — add a component to begin");
  const [dropTarget, setDropTarget] = useState(false);
  const [runInput, setRunInput] = useState("");
  const [runPhase, setRunPhase] = useState<RunPhase>("idle");
  const [runId, setRunId] = useState("");
  const [runOutput, setRunOutput] = useState("");
  const [runUsage, setRunUsage] = useState<unknown>();
  const [trace, setTrace] = useState<RunEvent[]>([]);
  const [nodeRunStates, setNodeRunStates] = useState<Record<string, NodeRunState>>({});
  const [nodeIterations, setNodeIterations] = useState<Record<string, number>>({});
  const [nodeAttempts, setNodeAttempts] = useState<Record<string, number>>({});
  const [activeEdgeIds, setActiveEdgeIds] = useState<ReadonlySet<string>>(new Set());
  const [testPhase, setTestPhase] = useState<"idle" | "running" | "error">("idle");
  const [testReport, setTestReport] = useState<TestReport>();
  const [storedRuns, setStoredRuns] = useState<StoredRun[]>([]);
  const [storedRunPhase, setStoredRunPhase] = useState<"idle" | "loading" | "error">("idle");
  const pulseTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const traceView = useRef<{ subgraph?: string; nodeIds: ReadonlySet<string>; edgeIds: ReadonlySet<string> }>({
    nodeIds: new Set(),
    edgeIds: new Set(),
  });
  const abortRef = useRef<AbortController | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const reactFlow = useReactFlow<HarnessNode, HarnessEdge>();
  const activeGraph = activeSubgraph ? document.draft.subgraphs[activeSubgraph] : undefined;
  const viewDraft = useMemo<HarnessDraft>(() => activeGraph ? {
    ...document.draft,
    root: { ...document.draft.root, entrypoint: activeGraph.entrypoint },
    nodes: activeGraph.nodes,
    edges: activeGraph.edges,
  } : document.draft, [activeGraph, document.draft]);
  useEffect(() => {
    traceView.current = {
      ...(activeSubgraph ? { subgraph: activeSubgraph } : {}),
      nodeIds: new Set(viewDraft.nodes.map((node) => node.id)),
      edgeIds: new Set(viewDraft.edges.map((edge) => edge.id)),
    };
  }, [activeSubgraph, viewDraft.edges, viewDraft.nodes]);
  const replaceViewDraft = useCallback((draft: HarnessDraft, touch: "none" | "layout" | "semantic") => {
    if (!activeSubgraph) {
      dispatch({ type: "replace-draft", draft, touch });
      return;
    }
    dispatch({
      type: "replace-draft",
      draft: {
        ...document.draft,
        subgraphs: {
          ...document.draft.subgraphs,
          [activeSubgraph]: { entrypoint: draft.root.entrypoint, nodes: draft.nodes, edges: draft.edges },
        },
      },
      touch,
    });
  }, [activeSubgraph, document.draft]);

  const errorDiagnostics = document.diagnostics.filter((item) => item.severity === "error");
  const displayedDiagnostics = document.yamlState === "synced" ? document.diagnostics : document.yamlDiagnostics;
  const running = runPhase === "starting" || runPhase === "streaming" || runPhase === "cancelling";
  const graphLocked = running || document.yamlState !== "synced";
  const dirty = document.revision !== document.savedRevision || document.yamlState !== "synced";
  const structurallyValid = useMemo(
    () => document.yamlState === "synced" && parseSpec(stringifySpec(draftToSpec(document.draft))).ok,
    [document.draft, document.yamlState],
  );
  const serverValidated = document.validatedSemanticRevision === document.semanticRevision
    && document.validationPhase === "server-valid";
  const canValidate = !running && !dirty && document.yamlState === "synced" && document.validationPhase !== "checking";
  const canSave = !running && structurallyValid && dirty && savePhase !== "saving";
  const canRun = !running && !dirty && serverValidated;
  const selectedNode = viewDraft.nodes.find((node) => node.selected);
  const selectedEdge = viewDraft.edges.find((edge) => edge.selected);
  const categories = useMemo(() => [...new Set(catalog.map((manifest) => manifest.category))].sort(), [catalog]);
  const visibleCatalog = useMemo(() => {
    const query = paletteQuery.trim().toLocaleLowerCase();
    return catalog.filter((manifest) => (paletteCategory === "all" || manifest.category === paletteCategory)
      && (!query || `${manifest.label} ${manifest.type} ${manifest.description ?? ""} ${manifest.category}`.toLocaleLowerCase().includes(query)));
  }, [catalog, paletteCategory, paletteQuery]);

  const displayNodes = useMemo(() => viewDraft.nodes.map((node) => ({
    ...node,
    data: {
      ...node.data,
      diagnostics: document.diagnostics.filter((item) => item.componentId === node.id
        && (activeSubgraph
          ? item.path.startsWith(`$.subgraphs.${activeSubgraph}.`)
          : !item.path.startsWith("$.subgraphs."))),
      runState: nodeRunStates[traceViewKey(activeSubgraph, node.id)] ?? "idle",
      iteration: nodeIterations[traceViewKey(activeSubgraph, node.id)],
      attempt: nodeAttempts[traceViewKey(activeSubgraph, node.id)],
    },
  })), [activeSubgraph, document.diagnostics, nodeAttempts, nodeIterations, nodeRunStates, viewDraft.nodes]);

  const displayEdges = useMemo(() => viewDraft.edges.map((edge) => ({
    ...edge,
    label: edge.data?.connection ? edgeLabel(edge.data.connection) : undefined,
    className: activeEdgeIds.has(traceViewKey(activeSubgraph, edge.id)) ? "is-running" : "",
    animated: activeEdgeIds.has(traceViewKey(activeSubgraph, edge.id)),
    data: { ...edge.data!, running: activeEdgeIds.has(traceViewKey(activeSubgraph, edge.id)) },
  })), [activeEdgeIds, activeSubgraph, viewDraft.edges]);

  const onNodesChange: OnNodesChange<HarnessNode> = useCallback((changes) => {
    if (graphLocked && changes.some((change) => change.type !== "select" && change.type !== "dimensions")) return;
    const nodes = applyNodeChanges(changes, viewDraft.nodes);
    const removed = changes.some((change) => change.type === "remove");
    const finishedMove = changes.some((change) => change.type === "position" && change.dragging !== true);
    const edges = removed ? viewDraft.edges.filter((edge) => nodes.some((node) => node.id === edge.source) && nodes.some((node) => node.id === edge.target)) : viewDraft.edges;
    let draft = { ...viewDraft, nodes, edges };
    if (removed && !nodes.some((node) => node.id === draft.root.entrypoint)) {
      draft = { ...draft, root: { ...draft.root, entrypoint: chooseEntrypoint(draft) } };
    }
    replaceViewDraft(draft, removed ? "semantic" : finishedMove ? "layout" : "none");
  }, [graphLocked, replaceViewDraft, viewDraft]);

  const onEdgesChange: OnEdgesChange<HarnessEdge> = useCallback((changes) => {
    if (graphLocked && changes.some((change) => change.type !== "select")) return;
    const edges = applyEdgeChanges(changes, viewDraft.edges);
    const removed = changes.some((change) => change.type === "remove");
    const draft = { ...viewDraft, edges };
    replaceViewDraft(draft, removed ? "semantic" : "none");
  }, [graphLocked, replaceViewDraft, viewDraft]);

  const candidateConnection = useCallback((connection: Connection | HarnessEdge): HarnessConnection | null => {
    if (!connection.source || !connection.target || !connection.sourceHandle || !connection.targetHandle) return null;
    return {
      from: { component: connection.source, port: connection.sourceHandle },
      to: { component: connection.target, port: connection.targetHandle },
    };
  }, []);

  const isValidConnection: IsValidConnection<HarnessEdge> = useCallback((connection) => {
    const candidate = candidateConnection(connection);
    return candidate ? validateCandidateConnection(draftToSpec(viewDraft), candidate, { components: validationComponents }).ok : false;
  }, [candidateConnection, validationComponents, viewDraft]);

  const onConnect = useCallback((connection: Connection) => {
    if (graphLocked) return;
    const candidate = candidateConnection(connection);
    if (!candidate) return;
    const validation = validateCandidateConnection(draftToSpec(viewDraft), candidate, { components: validationComponents });
    if (!validation.ok) {
      setStatusNote(validation.diagnostics[0]?.message ?? "That connection is not compatible.");
      return;
    }
    const id = `connection_${crypto.randomUUID().slice(0, 8)}`;
    const complete = { ...candidate, id };
    const edge: HarnessEdge = {
      id,
      type: "smoothstep",
      source: complete.from.component,
      sourceHandle: complete.from.port,
      target: complete.to.component,
      targetHandle: complete.to.port,
      data: { connection: complete },
    };
    const target = viewDraft.nodes.find((node) => node.id === complete.to.component);
    const root = target?.data.manifest.category === "Output"
      ? { ...viewDraft.root, entrypoint: target.id }
      : viewDraft.root;
    replaceViewDraft({ ...viewDraft, root, edges: [...viewDraft.edges, edge] }, "semantic");
    setStatusNote(`Connected ${complete.from.component}.${complete.from.port} to ${complete.to.component}.${complete.to.port}`);
  }, [candidateConnection, graphLocked, replaceViewDraft, validationComponents, viewDraft]);

  const addComponent = useCallback((type: string, position: XYPosition) => {
    if (graphLocked) return;
    const manifest = manifests.get(type);
    if (!manifest) return;
    const id = uniqueComponentId(type, new Set(viewDraft.nodes.map((node) => node.id)));
    const component = { id, type, config: structuredClone(manifest.defaultConfig) } as HarnessComponent;
    const node: HarnessNode = { id, type: "harness", position, data: { component, manifest }, selected: true };
    const nodes = [...viewDraft.nodes.map((current) => ({ ...current, selected: false })), node];
    const terminal = manifest.category === "Output";
    const upgraded = viewDraft.root.version === "0.1" && !LEGACY_COMPONENT_TYPES.has(type);
    const root = {
      ...viewDraft.root,
      ...(upgraded ? { version: "0.2" as const } : {}),
      entrypoint: terminal || !viewDraft.root.entrypoint ? id : viewDraft.root.entrypoint,
    };
    replaceViewDraft({ ...viewDraft, root, nodes }, "semantic");
    setStatusNote(`${manifest.label} ${id} added${upgraded ? " · HarnessSpec upgraded to 0.2" : ""}`);
  }, [graphLocked, manifests, replaceViewDraft, viewDraft]);

  const addAtCenter = useCallback((type: string) => {
    const bounds = canvasRef.current?.getBoundingClientRect();
    const center = reactFlow.screenToFlowPosition({
      x: bounds ? bounds.left + bounds.width / 2 : window.innerWidth / 2,
      y: bounds ? bounds.top + bounds.height / 2 : window.innerHeight / 2,
    });
    const index = viewDraft.nodes.length;
    addComponent(type, {
      x: center.x - 250 + (index % 2) * 270,
      y: center.y - 90 + Math.floor(index / 2) * 160,
    });
  }, [addComponent, reactFlow, viewDraft.nodes.length]);

  const handleDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDropTarget(false);
    const type = event.dataTransfer.getData(DND_MIME);
    if (!manifests.has(type)) return;
    addComponent(type, reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
  }, [addComponent, manifests, reactFlow]);

  const updateComponent = useCallback((component: HarnessComponent) => {
    if (graphLocked) return;
    const nodes = viewDraft.nodes.map((node) => node.id === component.id
      ? { ...node, data: { ...node.data, component } }
      : node);
    replaceViewDraft({ ...viewDraft, nodes }, "semantic");
  }, [graphLocked, replaceViewDraft, viewDraft]);

  const updateConnection = useCallback((connection: HarnessConnection) => {
    if (graphLocked) return;
    const edges = viewDraft.edges.map((edge) => edge.id === selectedEdge?.id
      ? { ...edge, data: { ...edge.data!, connection } }
      : edge);
    const root = viewDraft.root.version === "0.1"
      ? { ...viewDraft.root, version: "0.2" as const }
      : viewDraft.root;
    replaceViewDraft({ ...viewDraft, root, edges }, "semantic");
  }, [graphLocked, replaceViewDraft, selectedEdge?.id, viewDraft]);

  const deleteSelected = useCallback(() => {
    if (!selectedNode || graphLocked) return;
    const nodes = viewDraft.nodes.filter((node) => node.id !== selectedNode.id);
    const edges = viewDraft.edges.filter((edge) => edge.source !== selectedNode.id && edge.target !== selectedNode.id);
    let draft = { ...viewDraft, nodes, edges };
    if (draft.root.entrypoint === selectedNode.id) draft = { ...draft, root: { ...draft.root, entrypoint: chooseEntrypoint(draft) } };
    replaceViewDraft(draft, "semantic");
  }, [graphLocked, replaceViewDraft, selectedNode, viewDraft]);

  const deleteSelectedEdge = useCallback(() => {
    if (!selectedEdge || graphLocked) return;
    const edges = viewDraft.edges.filter((edge) => edge.id !== selectedEdge.id);
    replaceViewDraft({ ...viewDraft, edges }, "semantic");
  }, [graphLocked, replaceViewDraft, selectedEdge, viewDraft]);

  const setEntrypoint = useCallback(() => {
    if (!selectedNode || graphLocked) return;
    replaceViewDraft({ ...viewDraft, root: { ...viewDraft.root, entrypoint: selectedNode.id } }, "semantic");
  }, [graphLocked, replaceViewDraft, selectedNode, viewDraft]);

  const selectComponent = useCallback((id?: string) => {
    if (!id) return;
    const nodes = viewDraft.nodes.map((node) => ({ ...node, selected: node.id === id }));
    const edges = viewDraft.edges.map((edge) => ({ ...edge, selected: false }));
    replaceViewDraft({ ...viewDraft, nodes, edges }, "none");
  }, [replaceViewDraft, viewDraft]);

  const showTraceComponent = useCallback((scopedId?: string) => {
    if (!scopedId) return;
    const segments = scopedId.split("/");
    const localId = segments.at(-1)!;
    const graphName = [...segments.slice(0, -1)].reverse().find((name) => document.draft.subgraphs[name]);
    if (graphName) {
      const graph = document.draft.subgraphs[graphName];
      if (!graph.nodes.some((node) => node.id === localId)) return;
      dispatch({
        type: "replace-draft",
        draft: {
          ...document.draft,
          subgraphs: {
            ...document.draft.subgraphs,
            [graphName]: {
              ...graph,
              nodes: graph.nodes.map((node) => ({ ...node, selected: node.id === localId })),
              edges: graph.edges.map((edge) => ({ ...edge, selected: false })),
            },
          },
        },
        touch: "none",
      });
      setActiveSubgraph(graphName);
      return;
    }
    if (!document.draft.nodes.some((node) => node.id === localId)) return;
    dispatch({
      type: "replace-draft",
      draft: {
        ...document.draft,
        nodes: document.draft.nodes.map((node) => ({ ...node, selected: node.id === localId })),
        edges: document.draft.edges.map((edge) => ({ ...edge, selected: false })),
      },
      touch: "none",
    });
    setActiveSubgraph(undefined);
  }, [document.draft]);

  const editYaml = useCallback((text: string) => {
    const parsed = parseYamlDraft(text, catalog);
    dispatch({ type: "edit-yaml", text, pendingSpec: parsed.spec, diagnostics: parsed.diagnostics, parseOk: parsed.parseOk });
  }, [catalog]);

  const importYaml = useCallback(async (file?: File) => {
    if (!file || running) return;
    editYaml(await file.text());
    setActiveDock("yaml");
    setStatusNote(`${file.name} loaded into the YAML draft. Apply it to update the canvas.`);
  }, [editYaml, running]);

  const exportYaml = useCallback(() => {
    const blob = new Blob([document.yamlText], { type: "application/yaml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = window.document.createElement("a");
    link.href = url;
    link.download = "harnest.yaml";
    link.click();
    URL.revokeObjectURL(url);
  }, [document.yamlText]);

  const validate = useCallback(async () => {
    if (!canValidate) return;
    const semanticRevision = document.semanticRevision;
    dispatch({ type: "validation-start" });
    setStatusNote("Validating harness and installed adapters…");
    try {
      const response = await fetch("/api/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ yaml: stringifySpec(draftToSpec(document.draft)) }),
      });
      const payload = await response.json() as { ok: boolean; diagnostics: Diagnostic[]; catalog?: ComponentManifest[] };
      dispatch({ type: "validation-result", semanticRevision, diagnostics: payload.diagnostics ?? [] });
      if (payload.catalog?.length) {
        setCatalog(payload.catalog);
        dispatch({ type: "set-catalog", catalog: payload.catalog });
      }
      if (!payload.ok) setActiveDock("problems");
      setStatusNote(payload.ok ? "Runtime valid — ready to run" : `${payload.diagnostics.length} runtime issue(s) block running`);
    } catch (error) {
      const diagnostic: Diagnostic = { code: "VALIDATE_REQUEST", path: "$", message: error instanceof Error ? error.message : "Validation request failed", severity: "error" };
      dispatch({ type: "validation-result", semanticRevision, diagnostics: [diagnostic] });
      setActiveDock("problems");
    }
  }, [canValidate, document.draft, document.semanticRevision]);

  const save = useCallback(async () => {
    if (!canSave) return;
    const revision = document.revision;
    setSavePhase("saving");
    setStatusNote("Saving harnest.yaml…");
    try {
      const response = await fetch("/api/spec", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ yaml: stringifySpec(draftToSpec(document.draft)) }),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      const payload = await response.json() as { diagnostics?: Diagnostic[] };
      dispatch({ type: "save-result", revision });
      dispatch({ type: "host-diagnostics", diagnostics: payload.diagnostics ?? [] });
      setSavePhase("idle");
      if (payload.diagnostics?.length) setActiveDock("problems");
      setStatusNote(payload.diagnostics?.length
        ? `Saved harnest.yaml · ${payload.diagnostics.length} host capability issue(s)`
        : "Saved harnest.yaml");
    } catch (error) {
      setSavePhase("error");
      setStatusNote(error instanceof Error ? error.message : "harnest.yaml could not be saved");
    }
  }, [canSave, document.draft, document.revision]);

  const pulseEdge = useCallback((edgeId: string) => {
    setActiveEdgeIds((current) => new Set(current).add(edgeId));
    const timer = setTimeout(() => {
      setActiveEdgeIds((current) => {
        const next = new Set(current);
        next.delete(edgeId);
        return next;
      });
      pulseTimers.current.delete(timer);
    }, 700);
    pulseTimers.current.add(timer);
  }, []);

  const loadStoredRuns = useCallback(async () => {
    setStoredRunPhase("loading");
    try {
      const response = await fetch("/api/runs");
      if (!response.ok) throw new Error(await responseMessage(response));
      const payload = await response.json() as { runs?: StoredRun[] } | StoredRun[];
      setStoredRuns(Array.isArray(payload) ? payload : payload.runs ?? []);
      setStoredRunPhase("idle");
    } catch {
      setStoredRunPhase("error");
    }
  }, []);

  const inspectStoredRun = useCallback(async (stored: StoredRun) => {
    setActiveDock("trace");
    if (stored.events) {
      setRunId(stored.runId);
      setTrace(stored.events);
      return;
    }
    setStoredRunPhase("loading");
    try {
      const response = await fetch(`/api/runs?runId=${encodeURIComponent(stored.runId)}`);
      if (!response.ok) throw new Error(await responseMessage(response));
      const payload = await response.json() as { run: StoredRun };
      setRunId(payload.run.runId);
      setTrace(payload.run.events ?? []);
      setStoredRunPhase("idle");
    } catch {
      setStoredRunPhase("error");
    }
  }, []);

  const applyRunEvent = useCallback((event: RunEvent) => {
    setTrace((events) => [...events, event]);
    const data = eventData(event);
    const scopedNodeId = typeof data.nodeId === "string"
      ? visibleTraceId(data.nodeId, traceView.current.subgraph, traceView.current.nodeIds)
      : undefined;
    switch (data.type) {
      case "run-start":
        setRunId(String(data.runId));
        setRunPhase("streaming");
        break;
      case "node-start": {
        if (!scopedNodeId) break;
        const nodeId = traceViewKey(traceView.current.subgraph, scopedNodeId);
        setNodeRunStates((states) => ({ ...states, [nodeId]: "running" }));
        if (typeof data.iteration === "number") setNodeIterations((values) => ({ ...values, [nodeId]: data.iteration as number }));
        if (typeof data.attempt === "number") setNodeAttempts((values) => ({ ...values, [nodeId]: data.attempt as number }));
        break;
      }
      case "text-delta":
        setRunOutput((output) => output + String(data.text ?? ""));
        break;
      case "usage":
        setRunUsage(data.usage);
        break;
      case "node-end": {
        if (!scopedNodeId) break;
        const nodeId = traceViewKey(traceView.current.subgraph, scopedNodeId);
        setNodeRunStates((states) => ({ ...states, [nodeId]: "success" }));
        if (typeof data.iteration === "number") setNodeIterations((values) => ({ ...values, [nodeId]: data.iteration as number }));
        break;
      }
      case "node-skip":
        if (scopedNodeId) {
          const key = traceViewKey(traceView.current.subgraph, scopedNodeId);
          setNodeRunStates((states) => ({ ...states, [key]: "idle" }));
        }
        break;
      case "retry":
        if (scopedNodeId && typeof data.attempt === "number") {
          const key = traceViewKey(traceView.current.subgraph, scopedNodeId);
          setNodeAttempts((values) => ({ ...values, [key]: data.attempt as number }));
        }
        break;
      case "iteration":
        if (scopedNodeId && typeof data.iteration === "number") {
          const key = traceViewKey(traceView.current.subgraph, scopedNodeId);
          setNodeIterations((values) => ({ ...values, [key]: data.iteration as number }));
        }
        break;
      case "edge": {
        const edgeId = typeof data.edgeId === "string" && typeof data.active === "boolean"
          ? visibleActiveEdgeId(
            { edgeId: data.edgeId, active: data.active },
            traceView.current.subgraph,
            traceView.current.edgeIds,
          )
          : undefined;
        if (edgeId) pulseEdge(traceViewKey(traceView.current.subgraph, edgeId));
        break;
      }
      case "run-end":
        setRunOutput(formatOutput(data.output));
        setRunUsage(data.usage);
        setRunPhase("success");
        setStatusNote(`Run ${String(data.runId)} completed in ${Math.round(Number(data.durationMs ?? 0))}ms`);
        void loadStoredRuns();
        break;
      case "error":
        if (scopedNodeId) {
          const key = traceViewKey(traceView.current.subgraph, scopedNodeId);
          setNodeRunStates((states) => ({ ...states, [key]: "error" }));
        }
        setRunPhase("error");
        setStatusNote(String(data.message ?? "Run failed"));
        break;
    }
  }, [loadStoredRuns, pulseEdge]);

  const run = useCallback(async () => {
    if (!canRun) {
      setActiveDock("run");
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setActiveDock("run");
    setRunPhase("starting");
    setRunId("");
    setRunOutput("");
    setRunUsage(undefined);
    setTrace([]);
    setNodeRunStates({});
    setNodeIterations({});
    setNodeAttempts({});
    setActiveEdgeIds(new Set());
    setStatusNote("Starting saved harness…");
    let terminalEvent = false;
    try {
      const response = await fetch("/api/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: runInput }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      await readNdjson<RunEvent>(response, (event) => {
        if (event.type === "run-end" || event.type === "error") terminalEvent = true;
        applyRunEvent(event);
      });
      if (!terminalEvent && !controller.signal.aborted) {
        setRunPhase("error");
        setStatusNote("The run stream ended before a final event arrived.");
      }
    } catch (error) {
      if (controller.signal.aborted) {
        setRunPhase("cancelled");
        setStatusNote("Run cancelled");
      } else {
        setRunPhase("error");
        setStatusNote(error instanceof Error ? error.message : "Run failed");
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [applyRunEvent, canRun, runInput]);

  const cancelRun = useCallback(() => {
    if (!abortRef.current) return;
    setRunPhase("cancelling");
    setStatusNote("Cancelling run…");
    abortRef.current.abort();
  }, []);

  const runTests = useCallback(async () => {
    if (dirty || !serverValidated || testPhase === "running") return;
    setActiveDock("tests");
    setTestPhase("running");
    setStatusNote("Running saved harness tests…");
    try {
      const response = await fetch("/api/test", { method: "POST" });
      if (!response.ok) throw new Error(await responseMessage(response));
      const payload = await response.json() as TestReport;
      setTestReport(payload);
      setTestPhase("idle");
      setStatusNote(`${payload.passed} passed · ${payload.failed} failed`);
      void loadStoredRuns();
    } catch (error) {
      setTestPhase("error");
      setStatusNote(error instanceof Error ? error.message : "Harness tests failed");
    }
  }, [dirty, loadStoredRuns, serverValidated, testPhase]);

  useEffect(() => () => {
    abortRef.current?.abort();
    for (const timer of pulseTimers.current) clearTimeout(timer);
    pulseTimers.current.clear();
  }, []);

  useEffect(() => {
    if (activeDock === "trace" && storedRunPhase === "idle" && storedRuns.length === 0) void loadStoredRuns();
  }, [activeDock, loadStoredRuns, storedRunPhase, storedRuns.length]);

  useEffect(() => {
    if (activeSubgraph && !document.draft.subgraphs[activeSubgraph]) setActiveSubgraph(undefined);
  }, [activeSubgraph, document.draft.subgraphs]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      if (canSave) void save();
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [canSave, save]);

  const wired = viewDraft.nodes.length > 0 && !errorDiagnostics.some((diagnostic) =>
    /^(?:PORT_|CONNECTION_|GRAPH_|ENTRYPOINT_)/.test(diagnostic.code));
  const completedRun = runPhase === "success";
  const statusClass = runPhase === "error" || savePhase === "error" || displayedDiagnostics.some((item) => item.severity === "error")
    ? "is-fault"
    : running || document.validationPhase === "checking"
      ? "is-signal"
      : serverValidated
        ? "is-pass"
        : "";

  const dockTools = activeDock === "yaml" && (
    <div className="dock-tools">
      <label className="button file-button">
        Import
        <input type="file" accept=".yaml,.yml,text/yaml" disabled={running} onChange={(event) => void importYaml(event.target.files?.[0])} />
      </label>
      <button className="button" onClick={exportYaml}>Export</button>
      {document.yamlState !== "synced" && <button className="button" onClick={() => dispatch({ type: "discard-yaml" })}>Discard</button>}
      <button className="button button-primary" disabled={!document.pendingSpec || running} onClick={() => dispatch({ type: "apply-yaml" })}>Apply YAML</button>
    </div>
  );
  const dockTabs: DockTab[] = ["yaml", "problems", "run", "tests", "trace"];
  const moveDockFocus = (event: ReactKeyboardEvent<HTMLButtonElement>, tab: DockTab) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const current = dockTabs.indexOf(tab);
    const next = event.key === "Home" ? 0
      : event.key === "End" ? dockTabs.length - 1
        : (current + (event.key === "ArrowRight" ? 1 : -1) + dockTabs.length) % dockTabs.length;
    setActiveDock(dockTabs[next]);
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus();
  };

  return (
    <main className="studio-shell">
      <header className="command-rail">
        <div className="brand-lockup">
          <span className="brand-name">Harnest</span>
          <span className="project-name" title={initial.file}>{initial.file.split(/[\\/]/).pop()}</span>
          {dirty && <span className="dirty-dot" title="Unsaved changes" />}
        </div>
        <div className="continuity-rail" aria-label="Harness readiness">
          <span className={`continuity-step ${document.draft.nodes.length ? "is-active" : ""}`}><span>Draft</span></span>
          <span className={`continuity-step ${wired ? "is-pass" : ""}`}><span>Wired</span></span>
          <span className={`continuity-step ${!dirty && document.draft.nodes.length ? "is-pass" : ""}`}><span>Saved</span></span>
          <span className={`continuity-step ${serverValidated ? "is-pass" : ""}`}><span>Valid</span></span>
          <span className={`continuity-step ${running ? "is-active" : completedRun ? "is-pass" : ""}`}><span>Run</span></span>
        </div>
        <div className="rail-actions">
          <button className="button button-rail" disabled={!canSave} onClick={() => void save()}>{savePhase === "saving" ? "Saving…" : "Save"}</button>
          <button className="button button-rail" disabled={!canValidate} onClick={() => void validate()}>{document.validationPhase === "checking" ? "Checking…" : "Validate"}</button>
          {running
            ? <button className="button button-danger" disabled={runPhase === "cancelling"} onClick={cancelRun}>{runPhase === "cancelling" ? "Cancelling…" : "Cancel"}</button>
            : <button className="button button-rail button-primary" disabled={!canRun} onClick={() => void run()}>Run</button>}
        </div>
      </header>

      <aside className="palette-panel" aria-label="Component palette">
        <div className="panel-heading"><h2>Components</h2><span className="panel-count">{visibleCatalog.length}/{catalog.length}</span></div>
        <div className="palette-filters">
          <label className="sr-only" htmlFor="component-search">Search components</label>
          <input id="component-search" type="search" placeholder="Search components" value={paletteQuery} onChange={(event) => setPaletteQuery(event.target.value)} />
          <label className="sr-only" htmlFor="component-category">Component category</label>
          <select id="component-category" value={paletteCategory} onChange={(event) => setPaletteCategory(event.target.value)}>
            <option value="all">All categories</option>
            {categories.map((category) => <option key={category} value={category}>{category}</option>)}
          </select>
        </div>
        <p className="palette-copy">Drag onto the canvas, or select a component to place it in view.</p>
        <div className="palette-list">
          {visibleCatalog.length ? visibleCatalog.map((manifest) => (
              <button
                key={manifest.type}
                className="palette-item"
                style={{ "--port-color": colorFor(manifest.category) } as CSSProperties}
                draggable={!graphLocked}
                disabled={graphLocked}
                onClick={() => addAtCenter(manifest.type)}
                onDragStart={(event) => {
                  event.dataTransfer.setData(DND_MIME, manifest.type);
                  event.dataTransfer.effectAllowed = "copy";
                }}
              >
                <span className="palette-glyph" aria-hidden="true">{glyphFor(manifest.label)}</span>
                <span><span className="palette-title">{manifest.label}</span><span className="palette-description">{manifest.category} · {manifest.description ?? manifest.type}</span></span>
                <span className="drag-grip" aria-hidden="true">⠿</span>
              </button>
          )) : <div className="palette-empty">No components match this filter.</div>}
        </div>
      </aside>

      <section
        ref={canvasRef}
        className={`canvas-panel ${dropTarget ? "is-drop-target" : ""}`}
        aria-label="Harness canvas"
        onDragEnter={(event) => { event.preventDefault(); if (!graphLocked) setDropTarget(true); }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(false); }}
        onDragOver={(event) => { if (!graphLocked) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } }}
        onDrop={handleDrop}
      >
        <div className="canvas-toolbar">
          <button className={`graph-crumb ${activeSubgraph ? "" : "is-active"}`} disabled={!activeSubgraph} onClick={() => setActiveSubgraph(undefined)}>Root</button>
          {activeSubgraph && <><span aria-hidden="true">›</span><span className="graph-crumb is-active">{activeSubgraph}</span></>}
          {Object.keys(document.draft.subgraphs).length > 0 && (
            <select aria-label="Open graph" value={activeSubgraph ?? ""} onChange={(event) => setActiveSubgraph(event.target.value || undefined)}>
              <option value="">Root graph</option>
              {Object.keys(document.draft.subgraphs).map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          )}
          <span className="utility-label">{viewDraft.nodes.length} components · {viewDraft.edges.length} connections</span>
        </div>
        {viewDraft.nodes.length === 0 && <div className="empty-canvas"><strong>Place the first component</strong><span>Drag from the palette, or select a component to add it to this graph.</span></div>}
        <ReactFlow<HarnessNode, HarnessEdge>
          nodes={displayNodes}
          edges={displayEdges}
          nodeTypes={nodeTypes}
          defaultEdgeOptions={defaultEdgeOptions}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          isValidConnection={isValidConnection}
          onPaneClick={() => {
            const nodes = viewDraft.nodes.map((node) => ({ ...node, selected: false }));
            const edges = viewDraft.edges.map((edge) => ({ ...edge, selected: false }));
            replaceViewDraft({ ...viewDraft, nodes, edges }, "none");
          }}
          nodesDraggable={!graphLocked}
          nodesConnectable={!graphLocked}
          edgesReconnectable={false}
          deleteKeyCode={graphLocked ? null : ["Backspace", "Delete"]}
          snapToGrid
          snapGrid={snapGrid}
          fitView
          fitViewOptions={{ padding: 0.25 }}
          minZoom={0.25}
          maxZoom={1.8}
          panOnScroll
          selectionOnDrag
          nodesFocusable
          edgesFocusable
          autoPanOnNodeFocus
          ariaLabelConfig={{
            "controls.ariaLabel": "Canvas controls",
            "minimap.ariaLabel": "Harness overview",
            "handle.ariaLabel": "Typed connection port",
          }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#b7c2c8" />
          <Controls position="bottom-left" showInteractive={false} />
          <MiniMap position="bottom-right" pannable zoomable nodeColor={(node) => colorFor((node.data as HarnessNode["data"]).manifest.category)} maskColor="rgb(231 236 239 / 72%)" />
        </ReactFlow>
      </section>

      <aside className="inspector-panel" aria-label="Component and connection inspector">
        <div className="panel-heading"><h2>Inspector</h2><span className="panel-count">{selectedEdge ? "connection" : selectedNode?.data.component.type ?? "none"}</span></div>
        <Inspector
          node={selectedNode}
          edge={selectedEdge}
          entrypoint={viewDraft.root.entrypoint}
          canSetEntrypoint={Boolean(selectedNode && isEntrypointCandidate(selectedNode, viewDraft.edges))}
          locked={graphLocked}
          onChange={updateComponent}
          onEdgeChange={updateConnection}
          onDelete={deleteSelected}
          onDeleteEdge={deleteSelectedEdge}
          onSetEntrypoint={setEntrypoint}
          subgraphs={Object.keys(document.draft.subgraphs)}
          onOpenSubgraph={(name) => {
            if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) {
              setStatusNote("Subgraph names must start with a letter and contain only letters, digits, _ or -.");
              return;
            }
            if (!document.draft.subgraphs[name]) {
              dispatch({
                type: "replace-draft",
                draft: {
                  ...document.draft,
                  subgraphs: { ...document.draft.subgraphs, [name]: { entrypoint: "", nodes: [], edges: [] } },
                },
                touch: "semantic",
              });
              setStatusNote(`Subgraph '${name}' created — add its first component.`);
            }
            setActiveSubgraph(name);
          }}
        />
      </aside>

      <section className="bottom-dock" aria-label="YAML, diagnostics, run, tests, and trace">
        <div className="dock-heading">
          <div className="dock-tabs" role="tablist" aria-label="Studio dock">
            {dockTabs.map((tab) => (
              <button
                key={tab}
                id={`dock-tab-${tab}`}
                role="tab"
                aria-controls={`dock-panel-${tab}`}
                aria-selected={activeDock === tab}
                tabIndex={activeDock === tab ? 0 : -1}
                className={`dock-tab ${activeDock === tab ? "is-active" : ""}`}
                onClick={() => setActiveDock(tab)}
                onKeyDown={(event) => moveDockFocus(event, tab)}
              >
                {tab}{tab === "problems" && displayedDiagnostics.length > 0 && <span className="tab-badge">{displayedDiagnostics.length}</span>}
              </button>
            ))}
          </div>
          {dockTools}
        </div>
        <div id={`dock-panel-${activeDock}`} role="tabpanel" aria-labelledby={`dock-tab-${activeDock}`} className="dock-content" tabIndex={0}>
          {activeDock === "yaml" && (
            <div className="yaml-pane">
              <textarea className={`yaml-editor ${document.yamlState === "invalid" ? "is-invalid" : ""}`} aria-label="harnest.yaml" spellCheck={false} value={document.yamlText} disabled={running} onChange={(event) => editYaml(event.target.value)} />
              <div className={`yaml-message ${document.yamlState === "invalid" ? "is-error" : ""}`}>
                <strong>{document.yamlState === "synced" ? "Canvas and YAML are synchronized" : document.yamlState === "pending" ? "Valid YAML, not applied" : "YAML cannot be applied"}</strong>
                {document.yamlState === "synced" ? "Canvas edits update this document. Edit here, then Apply YAML to replace the canvas." : document.yamlDiagnostics[0]?.message ?? "Apply or discard the YAML draft before editing the canvas."}
              </div>
            </div>
          )}
          {activeDock === "problems" && (displayedDiagnostics.length ? (
            <ul className="diagnostic-list">
              {displayedDiagnostics.map((diagnostic, index) => (
                <li key={`${diagnostic.code}:${diagnostic.path}:${index}`}>
                  <button className="diagnostic-item" onClick={() => selectComponent(diagnostic.componentId)}>
                    <span className="diagnostic-code">{diagnostic.code}</span>
                    <span className="diagnostic-message">{diagnostic.message}{diagnostic.hint ? ` — ${diagnostic.hint}` : ""}</span>
                    <span className="diagnostic-path">{diagnostic.path}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : <div className="empty-dock">No validation issues in the current harness.</div>)}
          {activeDock === "run" && (
            <div className="run-pane">
              <div className="run-controls">
                <label className="field-label" htmlFor="run-input">Run input</label>
                <textarea id="run-input" className="run-input" value={runInput} disabled={running} placeholder="Ask the harness something…" onChange={(event) => setRunInput(event.target.value)} />
                {running
                  ? <button className="button button-danger" onClick={cancelRun}>Cancel run</button>
                  : <button className="button button-primary" disabled={!canRun} onClick={() => void run()}>Run saved harness</button>}
                <div className="run-meta"><span>{runPhase}</span>{runId && <span>{runId}</span>}{runUsage !== undefined && <span>{JSON.stringify(runUsage)}</span>}</div>
              </div>
              <pre className="run-output" aria-live="polite">{runOutput || (running ? "Waiting for the first streamed event…" : "Run output will stream here.")}</pre>
            </div>
          )}
          {activeDock === "tests" && (
            <div className="tests-pane">
              <div className="tests-toolbar">
                <div><strong>Saved harness tests</strong><span>{draftToSpec(document.draft).tests?.length ?? 0} cases</span></div>
                <button className="button button-primary" disabled={dirty || !serverValidated || testPhase === "running"} onClick={() => void runTests()}>{testPhase === "running" ? "Running…" : "Run tests"}</button>
              </div>
              {testReport ? (
                <div className="test-report">
                  <div className={`test-summary ${testReport.ok ? "is-pass" : "is-fault"}`}>{testReport.passed} passed · {testReport.failed} failed</div>
                  <ul className="test-list">
                    {testReport.cases.map((test) => (
                      <li key={test.id} className="test-item">
                        <span className={`test-state ${test.ok ? "is-pass" : "is-fault"}`}>{test.ok ? "pass" : "fail"}</span>
                        <span><strong>{test.id}</strong>{test.error && <small>{test.error}</small>}{test.assertions && <small>{JSON.stringify(test.assertions)}</small>}</span>
                        <span className="trace-meta">{Math.round(test.durationMs)}ms</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : <div className="empty-dock">Run the saved cases to inspect evaluator results.</div>}
            </div>
          )}
          {activeDock === "trace" && (
            <div className="trace-pane">
              <aside className="run-history" aria-label="Persisted runs">
                <div className="run-history-heading"><strong>Project runs</strong><button className="button" disabled={storedRunPhase === "loading"} onClick={() => void loadStoredRuns()}>Refresh</button></div>
                {storedRuns.length ? storedRuns.map((stored) => (
                  <button key={stored.runId} className={`run-history-item ${stored.runId === runId ? "is-active" : ""}`} onClick={() => void inspectStoredRun(stored)}>
                    <span>{stored.runId.slice(0, 12)}</span>
                    <small>{stored.startedAt ? new Date(stored.startedAt).toLocaleString() : stored.status ?? "stored"}</small>
                  </button>
                )) : <span className="run-history-empty">{storedRunPhase === "loading" ? "Loading runs…" : storedRunPhase === "error" ? "Run history is unavailable." : "No persisted runs yet."}</span>}
              </aside>
              <div className="trace-events">
                {trace.length ? (
                  <ul className="trace-list">
                    {trace.map((event, index) => (
                      <li key={`${event.type}:${event.timestamp}:${index}`}>
                        <details className="trace-detail">
                          <summary>
                            <span className="trace-time">{new Date(event.timestamp).toLocaleTimeString()}</span>
                            <span className="trace-message">{eventSummary(event)}</span>
                            <span className="trace-meta">{event.type}</span>
                          </summary>
                          <pre>{JSON.stringify(event, null, 2)}</pre>
                          {eventNodeId(event) && <button className="button" onClick={() => showTraceComponent(eventNodeId(event))}>Show component</button>}
                        </details>
                      </li>
                    ))}
                  </ul>
                ) : <div className="empty-dock">Run a saved harness or select a persisted run to inspect its trace.</div>}
              </div>
            </div>
          )}
        </div>
      </section>

      <footer className="status-bar" aria-live="polite">
        <span className={`status-led ${statusClass}`} />
        <span className="status-copy">{statusNote}</span>
        <span className="status-spacer" />
        <span>{document.yamlState === "synced" ? "YAML synced" : "YAML pending"}</span>
        <span>{errorDiagnostics.length ? `${errorDiagnostics.length} errors` : document.validationPhase}</span>
        {dirty && <span>unsaved</span>}
      </footer>
    </main>
  );
}
