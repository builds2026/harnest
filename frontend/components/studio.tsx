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
  specToDraft,
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
import { ConnectionManager } from "./connection-manager";
import { CompatiblePicker } from "./compatible-picker";
import { CustomToolManager } from "./custom-tool-manager";
import { SkillManager } from "./skill-manager";
import { connectionCanRun, type ConnectionKind, type ConnectionSummary } from "@/lib/connections";
import {
  CONNECTION_TYPE_CATALOG,
  TEMPLATE_CATALOG,
  templateSpec,
  type PaletteKind,
  type SkillCatalogItem,
  type StudioCatalogPayload,
  type TemplateCatalogItem,
  type ToolCatalogItem,
} from "@/lib/studio-catalog";

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

type AttachmentPicker = { nodeId: string; slot: "tools" | "skills"; pendingItemId?: string };

interface PaletteViewItem {
  readonly key: string;
  readonly id: string;
  readonly kind: PaletteKind;
  readonly label: string;
  readonly description: string;
  readonly category: string;
  readonly available: boolean;
  readonly payload: ComponentManifest | ToolCatalogItem | SkillCatalogItem | ConnectionSummary | TemplateCatalogItem;
}

const PALETTE_KINDS: readonly PaletteKind[] = ["components", "tools", "skills", "connections", "templates"];
const FAVORITES_KEY = "harnest.studio.favorites.v1";
const RECENTS_KEY = "harnest.studio.recents.v1";

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

interface PendingToolApproval {
  readonly runId: string;
  readonly nodeId: string;
  readonly callId: string;
  readonly turn: number;
  readonly tool: string;
  readonly risk: string;
  readonly input: unknown;
  readonly inputDigest: string;
  readonly inputBytes: number;
  readonly previewLimited: boolean;
}

const responseMessage = async (response: Response) => {
  const payload = await response.json().catch(() => null) as
    | { error?: string | { message?: string }; diagnostics?: Diagnostic[] }
    | null;
  return typeof payload?.error === "string"
    ? payload.error
    : payload?.error?.message ?? payload?.diagnostics?.[0]?.message ?? `Request failed with ${response.status}`;
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
    case "tool-call": return `${String(data.nodeId)} called ${String(data.tool ?? data.toolName ?? "tool")}${typeof data.turn === "number" ? ` · turn ${data.turn}` : ""}${data.risk ? ` · ${String(data.risk)}` : ""}`;
    case "tool-approval": return `${String(data.tool ?? "Tool")} ${data.approved === false ? "denied" : "approved"} · ${String(data.source ?? "policy")}`;
    case "tool-result": return `${String(data.tool ?? data.toolName ?? "Tool")} ${data.ok === false ? "failed" : "returned"}${typeof data.turn === "number" ? ` · turn ${data.turn}` : ""}`;
    case "tool-turn": return `${String(data.nodeId ?? "Agent")} tool turn ${String(data.turn ?? "")}`.trim();
    case "approval-request": return `Approval required · ${String(data.tool ?? data.toolName ?? "tool")} · turn ${String(data.turn ?? "")}`.trim();
    case "approval": return `${String(data.tool ?? data.toolName ?? "Tool")} ${data.approved === false ? "denied" : "approved"}`;
    case "skill-activate": return `${String(data.nodeId ?? "Agent")} activated ${String(data.skill ?? data.skillId ?? "skill")}`;
    case "skill-resource": return `${String(data.skill ?? data.skillId ?? "Skill")} loaded ${String(data.resource ?? "resource")}`;
    case "skill-use": return `${String(data.nodeId ?? "Agent")} activated ${String(data.skill ?? "skill")}${Array.isArray(data.resources) ? ` · ${data.resources.length} resource(s)` : ""}${data.trusted === false ? " · scripts untrusted" : ""}`;
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
  const [activeDock, setActiveDock] = useState<DockTab>(initial.exists ? "problems" : "run");
  const [paletteKind, setPaletteKind] = useState<PaletteKind>(initial.exists ? "components" : "templates");
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteCategory, setPaletteCategory] = useState("all");
  const [studioCatalog, setStudioCatalog] = useState<StudioCatalogPayload>({
    components: catalog,
    tools: [],
    skills: [],
    templates: TEMPLATE_CATALOG,
    connectionTypes: CONNECTION_TYPE_CATALOG,
  });
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [connectionManagerOpen, setConnectionManagerOpen] = useState(false);
  const [requestedConnectionKind, setRequestedConnectionKind] = useState<ConnectionKind>();
  const [connectionTargetNodeId, setConnectionTargetNodeId] = useState<string>();
  const [attachmentPicker, setAttachmentPicker] = useState<AttachmentPicker>();
  const [customToolOpen, setCustomToolOpen] = useState(false);
  const [skillManagerOpen, setSkillManagerOpen] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState<TemplateCatalogItem["id"]>();
  const [favorites, setFavorites] = useState<ReadonlySet<string>>(new Set());
  const [recents, setRecents] = useState<readonly string[]>([]);
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
  const [pendingApprovals, setPendingApprovals] = useState<PendingToolApproval[]>([]);
  const pendingApproval = pendingApprovals[0];
  const [approvalBusy, setApprovalBusy] = useState(false);
  const pulseTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const traceView = useRef<{ subgraph?: string; nodeIds: ReadonlySet<string>; edgeIds: ReadonlySet<string> }>({
    nodeIds: new Set(),
    edgeIds: new Set(),
  });
  const abortRef = useRef<AbortController | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const reactFlow = useReactFlow<HarnessNode, HarnessEdge>();
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/catalog", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await responseMessage(response));
        return response.json() as Promise<StudioCatalogPayload>;
      })
      .then((nextCatalog) => {
        setStudioCatalog(nextCatalog);
        if (nextCatalog.components.length) {
          setCatalog(nextCatalog.components);
          dispatch({ type: "set-catalog", catalog: nextCatalog.components });
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setStatusNote(error instanceof Error ? error.message : "Studio catalog could not be loaded");
      });
    void fetch("/api/connections", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await responseMessage(response));
        return response.json() as Promise<{ connections: ConnectionSummary[] }>;
      })
      .then((connectionPayload) => setConnections(connectionPayload.connections))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setStatusNote(error instanceof Error ? error.message : "Connections could not be loaded");
      });
    try {
      const storedFavorites = JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? "[]") as unknown;
      const storedRecents = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]") as unknown;
      if (Array.isArray(storedFavorites) && storedFavorites.every((value) => typeof value === "string")) setFavorites(new Set(storedFavorites));
      if (Array.isArray(storedRecents) && storedRecents.every((value) => typeof value === "string")) setRecents(storedRecents.slice(0, 12));
    } catch {
      localStorage.removeItem(FAVORITES_KEY);
      localStorage.removeItem(RECENTS_KEY);
    }
    return () => controller.abort();
  }, []);

  const refreshStudioCatalog = useCallback(async () => {
    const response = await fetch("/api/catalog");
    if (!response.ok) throw new Error(await responseMessage(response));
    const next = await response.json() as StudioCatalogPayload;
    setStudioCatalog(next);
    if (next.components.length) {
      setCatalog(next.components);
      dispatch({ type: "set-catalog", catalog: next.components });
    }
  }, []);

  useEffect(() => {
    const receiveOAuth = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || !event.data || typeof event.data !== "object"
        || (event.data as { type?: unknown }).type !== "harnest-oauth-complete") return;
      void fetch("/api/connections")
        .then(async (response) => {
          if (!response.ok) throw new Error(await responseMessage(response));
          return response.json() as Promise<{ connections: ConnectionSummary[] }>;
        })
        .then((payload) => {
          setConnections(payload.connections);
          setStatusNote((event.data as { ok?: boolean }).ok ? "OAuth authorization completed. Test the connection next." : "OAuth authorization was not completed.");
        })
        .catch(() => setStatusNote("Connection status could not be refreshed after authorization."));
    };
    window.addEventListener("message", receiveOAuth);
    return () => window.removeEventListener("message", receiveOAuth);
  }, []);

  const markRecent = useCallback((key: string) => {
    setRecents((current) => {
      const next = [key, ...current.filter((item) => item !== key)].slice(0, 12);
      localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const toggleFavorite = useCallback((key: string) => {
    setFavorites((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      localStorage.setItem(FAVORITES_KEY, JSON.stringify([...next]));
      return next;
    });
  }, []);
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
  const paletteItems = useMemo<PaletteViewItem[]>(() => {
    if (paletteKind === "components") return catalog.map((manifest) => ({
      key: `components:${manifest.type}`, id: manifest.type, kind: paletteKind, label: manifest.label,
      description: manifest.description ?? manifest.type, category: manifest.category, available: true, payload: manifest,
    }));
    if (paletteKind === "tools") return studioCatalog.tools.map((tool) => ({
      key: `tools:${tool.id}`, id: tool.id, kind: paletteKind, label: tool.label,
      description: tool.description, category: tool.category, available: tool.installed, payload: tool,
    }));
    if (paletteKind === "skills") return studioCatalog.skills.map((skill) => ({
      key: `skills:${skill.id}`, id: skill.id, kind: paletteKind, label: skill.label,
      description: skill.description, category: skill.category, available: true, payload: skill,
    }));
    if (paletteKind === "connections") return connections.map((connection) => ({
      key: `connections:${connection.id}`, id: connection.id, kind: paletteKind, label: connection.name,
      description: `${connection.kind} · ${connection.status.replaceAll("_", " ")}`, category: connection.scope,
      available: true, payload: connection,
    }));
    return studioCatalog.templates.map((template) => ({
      key: `templates:${template.id}`, id: template.id, kind: paletteKind, label: template.label,
      description: template.description, category: template.category, available: true, payload: template,
    }));
  }, [catalog, connections, paletteKind, studioCatalog.skills, studioCatalog.templates, studioCatalog.tools]);
  const categories = useMemo(() => [...new Set(paletteItems.map((item) => item.category))].sort(), [paletteItems]);
  const visiblePalette = useMemo(() => {
    const query = paletteQuery.trim().toLocaleLowerCase();
    const recentRank = new Map(recents.map((key, index) => [key, index]));
    return paletteItems.filter((item) => (paletteCategory === "all" || item.category === paletteCategory)
      && (!query || `${item.label} ${item.id} ${item.description} ${item.category}`.toLocaleLowerCase().includes(query)))
      .sort((left, right) => Number(favorites.has(right.key)) - Number(favorites.has(left.key))
        || (recentRank.get(left.key) ?? 999) - (recentRank.get(right.key) ?? 999)
        || left.label.localeCompare(right.label));
  }, [favorites, paletteCategory, paletteItems, paletteQuery, recents]);

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
      onAddAttachment: (nodeId: string, slot: "tools" | "skills") => setAttachmentPicker({ nodeId, slot }),
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

  const addComponent = useCallback((
    type: string,
    position: XYPosition,
    configOverride: Readonly<Record<string, unknown>> = {},
    attachTo?: { nodeId: string; slot: "tools" | "skills" },
  ) => {
    if (graphLocked) return;
    const manifest = manifests.get(type);
    if (!manifest) return;
    const id = uniqueComponentId(type, new Set(viewDraft.nodes.map((node) => node.id)));
    const component = { id, type, config: { ...structuredClone(manifest.defaultConfig), ...configOverride } } as HarnessComponent;
    const node: HarnessNode = { id, type: "harness", position, data: { component, manifest }, selected: true };
    const nodes = [...viewDraft.nodes.map((current) => ({ ...current, selected: false })), node];
    let edges = viewDraft.edges;
    if (attachTo) {
      const agent = viewDraft.nodes.find((current) => current.id === attachTo.nodeId);
      const sourcePort = Object.keys(manifest.ports.outputs).find((port) => port === (attachTo.slot === "skills" ? "skill" : "tool"))
        ?? Object.keys(manifest.ports.outputs)[0];
      const targetPort = agent && (attachTo.slot === "skills"
        ? ["skills", "skill"].find((port) => agent.data.manifest.ports.inputs[port])
        : ["tools", "toolResults", "tool"].find((port) => agent.data.manifest.ports.inputs[port]));
      if (sourcePort && targetPort) {
        const connectionId = `connection_${crypto.randomUUID().slice(0, 8)}`;
        const connection = {
          id: connectionId,
          from: { component: id, port: sourcePort },
          to: { component: agent.id, port: targetPort },
        } as HarnessConnection;
        edges = [...edges, {
          id: connectionId,
          type: "smoothstep",
          source: id,
          sourceHandle: sourcePort,
          target: agent.id,
          targetHandle: targetPort,
          data: { connection },
        }];
      }
    }
    const terminal = manifest.category === "Output";
    const upgraded = viewDraft.root.version === "0.1" && !LEGACY_COMPONENT_TYPES.has(type);
    const root = {
      ...viewDraft.root,
      ...(upgraded ? { version: "0.2" as const } : {}),
      entrypoint: terminal || !viewDraft.root.entrypoint ? id : viewDraft.root.entrypoint,
    };
    replaceViewDraft({ ...viewDraft, root, nodes, edges }, "semantic");
    setStatusNote(`${manifest.label} ${id} added${attachTo ? ` and connected to ${attachTo.nodeId}` : ""}${upgraded ? " · HarnessSpec upgraded to 0.2" : ""}`);
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

  const openConnections = useCallback((kind?: ConnectionKind, targetNodeId?: string) => {
    setRequestedConnectionKind(kind);
    setConnectionTargetNodeId(targetNodeId);
    setConnectionManagerOpen(true);
  }, []);

  const addTool = useCallback((
    tool: ToolCatalogItem,
    nodeId?: string,
    connection?: ConnectionSummary,
  ) => {
    if (!tool.installed) {
      setStatusNote(`${tool.label} is listed for discovery but its executable package is not installed.`);
      return;
    }
    const hasCompatibleConnection = tool.connectionKinds?.some((kind) => connections.some((item) =>
      item.kind === kind && connectionCanRun(item)));
    const requiredKind = tool.connectionKinds?.length && !hasCompatibleConnection ? tool.connectionKinds[0] : undefined;
    if (!connection && requiredKind) {
      if (nodeId) setAttachmentPicker({ nodeId, slot: "tools", pendingItemId: tool.id });
      openConnections(requiredKind);
      return;
    }
    const selectedConnection = connection
      ?? (tool.connectionId ? connections.find((item) => item.id === tool.connectionId) : undefined)
      ?? tool.connectionKinds?.flatMap((kind) => connections.filter((item) =>
        item.kind === kind && connectionCanRun(item)))[0];
    const mcp = selectedConnection?.kind === "mcp-http" || selectedConnection?.kind === "mcp-stdio" || tool.source === "mcp";
    const type = "tool";
    const agent = nodeId ? viewDraft.nodes.find((node) => node.id === nodeId) : undefined;
    const position = agent
      ? { x: agent.position.x - 300, y: agent.position.y + 150 + viewDraft.nodes.filter((node) => node.position.x < agent.position.x).length * 24 }
      : reactFlow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    const config = {
      tool: tool.id,
      label: tool.label,
      description: tool.description,
      risk: tool.risk ?? "external",
      source: mcp ? "mcp" : tool.source ?? "module",
      ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
      ...(selectedConnection ? { connectionId: selectedConnection.id, action: tool.action ?? (mcp ? tool.id : undefined) } : {}),
    };
    const agentId = agent?.id;
    const mcpPlaceholder = mcp && agentId ? viewDraft.nodes.find((node) =>
      node.data.component.type === "tool"
      && node.data.component.config.source === "mcp"
      && !node.data.component.config.tool
      && viewDraft.edges.some((edge) => edge.source === node.id && edge.target === agentId && edge.targetHandle === "tools")) : undefined;
    if (mcpPlaceholder) {
      replaceViewDraft({
        ...viewDraft,
        nodes: viewDraft.nodes.map((node) => node.id === mcpPlaceholder.id ? {
          ...node,
          data: {
            ...node.data,
            component: { ...node.data.component, config } as HarnessComponent,
          },
          selected: true,
        } : { ...node, selected: false }),
      }, "semantic");
      markRecent(`tools:${tool.id}`);
      setAttachmentPicker(undefined);
      setStatusNote(`${tool.label} equipped in the MCP template slot and connected to ${agentId}.`);
      return;
    }
    addComponent(type, position, config, agent ? { nodeId: agent.id, slot: "tools" } : undefined);
    markRecent(`tools:${tool.id}`);
    setAttachmentPicker(undefined);
  }, [addComponent, connections, markRecent, openConnections, reactFlow, replaceViewDraft, viewDraft]);

  const attachSkill = useCallback((skill: SkillCatalogItem, nodeId: string) => {
    const agent = viewDraft.nodes.find((node) => node.id === nodeId);
    if (!agent) return;
    if (skill.scriptsPresent && !window.confirm(
      `${skill.label} includes scripts from ${JSON.stringify(skill.provenance ?? { source: skill.source })}. `
      + "Attaching loads SKILL.md instructions only; scripts remain inaccessible without separate resource approval. Continue?",
    )) return;
    const attached = viewDraft.edges.some((edge) => edge.target === nodeId && edge.targetHandle === "skills"
      && viewDraft.nodes.some((node) => node.id === edge.source && node.data.component.type === "skill"
        && node.data.component.config.skill === skill.id));
    if (attached) {
      setStatusNote(`${skill.label} is already enabled on ${nodeId}.`);
      setAttachmentPicker(undefined);
      return;
    }
    const position = {
      x: agent.position.x - 300,
      y: agent.position.y + 230 + viewDraft.nodes.filter((node) => node.position.x < agent.position.x).length * 24,
    };
    addComponent("skill", position, { skill: skill.id }, { nodeId, slot: "skills" });
    markRecent(`skills:${skill.id}`);
    setAttachmentPicker(undefined);
    setStatusNote(`${skill.label} enabled on ${nodeId}. Validate its tools, connections, and trust before running.`);
  }, [addComponent, markRecent, viewDraft.edges, viewDraft.nodes]);

  const applyTemplate = useCallback((template: TemplateCatalogItem) => {
    if (dirty && document.draft.nodes.length && !window.confirm("Replace the current unsaved graph with this template?")) return;
    const next = templateSpec(template.id);
    const compatible = (kinds: readonly ConnectionKind[]) => connections.find((connection) =>
      kinds.includes(connection.kind) && connectionCanRun(connection));
    const equip = (component: HarnessSpec["components"][number]) => {
      const config = component.config as Record<string, unknown>;
      if (component.type === "model") {
        const provider = compatible(["provider"]);
        return provider ? { ...component, config: { ...config, connectionId: provider.id } } as typeof component : component;
      }
      if (component.type !== "tool") return component;
      const kinds: readonly ConnectionKind[] = config.source === "mcp"
        ? ["mcp-http", "mcp-stdio"]
        : config.tool === "builtin.code-runner" ? ["local-runtime"] : ["tool-service"];
      const selected = compatible(kinds);
      return selected ? { ...component, config: { ...config, connectionId: selected.id } } as typeof component : component;
    };
    next.components = next.components.map(equip) as HarnessSpec["components"];
    if (next.version === "0.2" && next.subgraphs) {
      for (const graph of Object.values(next.subgraphs)) graph.components = graph.components.map(equip) as typeof graph.components;
    }
    dispatch({ type: "replace-draft", draft: specToDraft(next, catalog), touch: "semantic" });
    setActiveSubgraph(undefined);
    setSelectedTemplateId(template.id);
    setRunInput(template.sampleInput);
    setPaletteKind("connections");
    setPaletteCategory("all");
    setPaletteQuery("");
    markRecent(`templates:${template.id}`);
    const missing = template.connectionKinds?.find((kind) => !connections.some((connection) =>
      connection.kind === kind && connectionCanRun(connection)));
    setStatusNote(missing
      ? `${template.label} commissioned · connect its remaining runtime requirement.`
      : `${template.label} commissioned · existing Connections were wired automatically.`);
    if (missing) openConnections(missing);
  }, [catalog, connections, dirty, document.draft.nodes.length, markRecent, openConnections]);

  const activatePaletteItem = useCallback((item: PaletteViewItem) => {
    markRecent(item.key);
    if (item.kind === "components") addAtCenter(item.id);
    else if (item.kind === "tools") {
      const agent = selectedNode?.data.component.type === "agent" ? selectedNode.id : undefined;
      addTool(item.payload as ToolCatalogItem, agent);
    } else if (item.kind === "skills") {
      if (selectedNode?.data.component.type === "agent") attachSkill(item.payload as SkillCatalogItem, selectedNode.id);
      else setStatusNote("Select an Agent, then add the Skill from its + Skill control.");
    } else if (item.kind === "connections") openConnections();
    else applyTemplate(item.payload as TemplateCatalogItem);
  }, [addAtCenter, addTool, applyTemplate, attachSkill, markRecent, openConnections, selectedNode]);

  const completeConnection = useCallback((connection: ConnectionSummary) => {
    if (connectionTargetNodeId) {
      const target = viewDraft.nodes.find((node) => node.id === connectionTargetNodeId);
      if (target) updateComponent({
        ...target.data.component,
        config: { ...(target.data.component.config as Record<string, unknown>), connectionId: connection.id },
      } as HarnessComponent);
    }
    if (!connectionTargetNodeId && !attachmentPicker) {
      const accepts = (component: HarnessComponent) => {
        const config = component.config as Record<string, unknown>;
        if (typeof config.connectionId === "string" && config.connectionId) return false;
        if (connection.kind === "provider") return component.type === "model";
        if (component.type !== "tool") return false;
        if (config.source === "mcp") return connection.kind === "mcp-http" || connection.kind === "mcp-stdio";
        if (config.tool === "builtin.code-runner" || config.tool === "builtin.file" || config.tool === "builtin.shell") {
          return connection.kind === "local-runtime";
        }
        if (config.tool === "builtin.web-search") return connection.kind === "tool-service";
        return connection.kind === "http-api" || connection.kind === "tool-service" || connection.kind === "local-runtime";
      };
      const connectNode = (node: HarnessNode): HarnessNode => accepts(node.data.component) ? {
        ...node,
        data: {
          ...node.data,
          component: {
            ...node.data.component,
            config: { ...(node.data.component.config as Record<string, unknown>), connectionId: connection.id },
          } as HarnessComponent,
        },
      } : node;
      dispatch({
        type: "replace-draft",
        touch: "semantic",
        draft: {
          ...document.draft,
          nodes: document.draft.nodes.map(connectNode),
          subgraphs: Object.fromEntries(Object.entries(document.draft.subgraphs).map(([name, graph]) => [name, {
            ...graph,
            nodes: graph.nodes.map(connectNode),
          }])),
        },
      });
    }
    if (attachmentPicker?.pendingItemId) {
      if (attachmentPicker.slot === "tools") {
        const tool = studioCatalog.tools.find((item) => item.id === attachmentPicker.pendingItemId);
        if (tool) addTool(tool, attachmentPicker.nodeId, connection);
      } else {
        const skill = studioCatalog.skills.find((item) => item.id === attachmentPicker.pendingItemId);
        if (skill) attachSkill(skill, attachmentPicker.nodeId);
      }
    }
    const needsMcpDiscovery = !attachmentPicker
      && selectedTemplateId === "mcp-agent"
      && (connection.kind === "mcp-http" || connection.kind === "mcp-stdio")
      && viewDraft.nodes.some((node) => node.data.component.type === "tool"
        && node.data.component.config.source === "mcp" && !node.data.component.config.tool);
    if (needsMcpDiscovery) {
      setRequestedConnectionKind(undefined);
      setConnectionTargetNodeId(undefined);
      setStatusNote("MCP connected · Test and Discover tools here, then equip the Agent from its + Tool picker.");
      return;
    }
    setConnectionManagerOpen(false);
    setRequestedConnectionKind(undefined);
    setConnectionTargetNodeId(undefined);
    if (!attachmentPicker && selectedTemplateId) {
      const requirements = studioCatalog.templates.find((template) => template.id === selectedTemplateId)?.connectionKinds ?? [];
      const available = [...connections.filter((item) => item.id !== connection.id), connection];
      const next = requirements.find((kind) => !available.some((item) => item.kind === kind && connectionCanRun(item)));
      if (next) queueMicrotask(() => openConnections(next));
    }
  }, [addTool, attachSkill, attachmentPicker, connectionTargetNodeId, connections, document.draft, openConnections, selectedTemplateId, studioCatalog.skills, studioCatalog.templates, studioCatalog.tools, updateComponent, viewDraft.nodes]);

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
      const payload = await response.json() as { ok: boolean; diagnostics: Diagnostic[]; catalog?: ComponentManifest[]; plan?: { nodeCount: number; layerCount: number; entrypoint: string } };
      dispatch({ type: "validation-result", semanticRevision, diagnostics: payload.diagnostics ?? [] });
      if (payload.catalog?.length) {
        setCatalog(payload.catalog);
        dispatch({ type: "set-catalog", catalog: payload.catalog });
      }
      if (!payload.ok) setActiveDock("problems");
      setStatusNote(payload.ok ? `Runtime compiled — ${payload.plan?.nodeCount ?? 0} node(s), ${payload.plan?.layerCount ?? 0} layer(s), entrypoint ${payload.plan?.entrypoint ?? "unknown"}` : `${payload.diagnostics.length} runtime issue(s) block running`);
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
      case "tool-call":
        if (data.risk !== "read" && typeof data.runId === "string" && typeof data.nodeId === "string"
          && typeof data.callId === "string" && typeof data.turn === "number") {
          setApprovalBusy(true);
          void fetch("/api/approvals", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              action: "inspect",
              runId: data.runId,
              nodeId: data.nodeId,
              callId: data.callId,
              turn: data.turn,
            }),
          }).then(async (response) => {
            if (!response.ok) throw new Error(await responseMessage(response));
            return response.json() as Promise<{ approval: PendingToolApproval }>;
          }).then(({ approval }) => {
            setPendingApprovals((current) => current.some((item) => item.runId === approval.runId
              && item.nodeId === approval.nodeId && item.turn === approval.turn && item.callId === approval.callId)
              ? current : [...current, approval]);
            setApprovalBusy(false);
          }).catch((error: unknown) => {
            setApprovalBusy(false);
            setStatusNote(error instanceof Error ? error.message : "Approval details could not be loaded.");
          });
        }
        break;
      case "tool-approval":
        if (typeof data.runId === "string" && typeof data.nodeId === "string"
          && typeof data.callId === "string" && typeof data.turn === "number") {
          setPendingApprovals((current) => current.filter((item) => !(item.runId === data.runId
            && item.nodeId === data.nodeId && item.turn === data.turn && item.callId === data.callId)));
          setApprovalBusy(false);
        }
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
        setPendingApprovals([]);
        setStatusNote(`Run ${String(data.runId)} completed in ${Math.round(Number(data.durationMs ?? 0))}ms`);
        void loadStoredRuns();
        break;
      case "error":
        if (scopedNodeId) {
          const key = traceViewKey(traceView.current.subgraph, scopedNodeId);
          setNodeRunStates((states) => ({ ...states, [key]: "error" }));
        }
        setRunPhase("error");
        setPendingApprovals([]);
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
    setPendingApprovals([]);
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
    setPendingApprovals([]);
    abortRef.current.abort();
  }, []);

  const decideApproval = useCallback(async (approved: boolean) => {
    if (!pendingApproval || approvalBusy) return;
    setApprovalBusy(true);
    try {
      const response = await fetch("/api/approvals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runId: pendingApproval.runId,
          nodeId: pendingApproval.nodeId,
          callId: pendingApproval.callId,
          turn: pendingApproval.turn,
          inputDigest: pendingApproval.inputDigest,
          approved,
        }),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      setStatusNote(`${pendingApproval.tool} ${approved ? "approved for this call" : "denied"}.`);
    } catch (error) {
      setApprovalBusy(false);
      setStatusNote(error instanceof Error ? error.message : "Approval decision could not be delivered.");
    }
  }, [approvalBusy, pendingApproval]);

  const runTests = useCallback(async () => {
    if (dirty || !serverValidated || testPhase === "running") return;
    setActiveDock("tests");
    setTestPhase("running");
    setStatusNote("Running saved harness tests…");
    try {
      const response = await fetch("/api/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
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
  const templateReady = Boolean(selectedTemplateId || initial.exists || viewDraft.nodes.length);
  const requiredConnectionKinds = selectedTemplateId
    ? studioCatalog.templates.find((template) => template.id === selectedTemplateId)?.connectionKinds ?? []
    : [];
  const connectionReady = requiredConnectionKinds.length
    ? requiredConnectionKinds.every((kind) => connections.some((connection) => connection.kind === kind && connectionCanRun(connection)))
    : connections.some(connectionCanRun);
  const traceReady = trace.length > 0 || storedRuns.length > 0;
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
  const dockTabs: DockTab[] = ["problems", "run", "tests", "trace", "yaml"];
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
        <div className="continuity-rail" aria-label="Commissioning progress">
          <span className={`continuity-step ${templateReady ? "is-pass" : "is-active"}`}><span>Template</span></span>
          <span className={`continuity-step ${connectionReady ? "is-pass" : templateReady ? "is-active" : ""}`}><span>Connect</span></span>
          <span className={`continuity-step ${wired ? "is-pass" : connectionReady ? "is-active" : ""}`}><span>Equip</span></span>
          <span className={`continuity-step ${serverValidated ? "is-pass" : wired ? "is-active" : ""}`}><span>Validate</span></span>
          <span className={`continuity-step ${running ? "is-active" : completedRun ? "is-pass" : serverValidated ? "is-active" : ""}`}><span>Run</span></span>
          <span className={`continuity-step ${traceReady ? "is-pass" : completedRun ? "is-active" : ""}`}><span>Trace</span></span>
        </div>
        <div className="rail-actions">
          <button className="button button-rail" disabled={!canSave} onClick={() => void save()}>{savePhase === "saving" ? "Saving…" : "Save"}</button>
          <button className="button button-rail" disabled={!canValidate} onClick={() => void validate()}>{document.validationPhase === "checking" ? "Checking…" : "Validate"}</button>
          {running
            ? <button className="button button-danger" disabled={runPhase === "cancelling"} onClick={cancelRun}>{runPhase === "cancelling" ? "Cancelling…" : "Cancel"}</button>
            : <button className="button button-rail button-primary" disabled={!canRun} onClick={() => void run()}>Run</button>}
        </div>
      </header>

      <aside className="palette-panel" aria-label="Studio palette">
        <div className="panel-heading"><h2>Palette</h2><span className="panel-count">{visiblePalette.length}/{paletteItems.length}</span></div>
        <div className="palette-tabs" role="tablist" aria-label="Palette catalogs">
          {PALETTE_KINDS.map((kind) => <button
            key={kind}
            role="tab"
            aria-selected={paletteKind === kind}
            className={`palette-tab ${paletteKind === kind ? "is-active" : ""}`}
            onClick={() => { setPaletteKind(kind); setPaletteCategory("all"); setPaletteQuery(""); }}
          >{kind}</button>)}
        </div>
        {(paletteKind === "tools" || paletteKind === "skills") && <div className="palette-create"><button className="button" onClick={() => paletteKind === "tools" ? setCustomToolOpen(true) : setSkillManagerOpen(true)}>{paletteKind === "tools" ? "New custom tool" : "Add skill"}</button></div>}
        <div className="palette-filters">
          <label className="sr-only" htmlFor="palette-search">Search palette</label>
          <input id="palette-search" type="search" placeholder={`Search ${paletteKind}`} value={paletteQuery} onChange={(event) => setPaletteQuery(event.target.value)} />
          <label className="sr-only" htmlFor="palette-category">Palette category</label>
          <select id="palette-category" value={paletteCategory} onChange={(event) => setPaletteCategory(event.target.value)}>
            <option value="all">All categories</option>
            {categories.map((category) => <option key={category} value={category}>{category}</option>)}
          </select>
        </div>
        <p className="palette-copy">{paletteKind === "components" ? "Drag onto the canvas or select to place." : "Favorites and recent items stay on this device."}</p>
        <div className="palette-list">
          {visiblePalette.length ? visiblePalette.map((item) => (
            <div className="palette-item-row" key={item.key}>
              <button
                className="palette-item"
                style={{ "--port-color": colorFor(item.category) } as CSSProperties}
                draggable={item.kind === "components" && !graphLocked}
                disabled={!item.available || (item.kind === "components" && graphLocked)}
                onClick={() => activatePaletteItem(item)}
                onDragStart={(event) => {
                  if (item.kind !== "components") return;
                  event.dataTransfer.setData(DND_MIME, item.id);
                  event.dataTransfer.effectAllowed = "copy";
                }}
              >
                <span className="palette-glyph" aria-hidden="true">{glyphFor(item.label)}</span>
                <span><span className="palette-title">{item.label}</span><span className="palette-description">{item.category} · {item.description}</span></span>
                <span className="drag-grip" aria-hidden="true">{item.available ? item.kind === "components" ? "⠿" : "＋" : "—"}</span>
              </button>
              <button className={`palette-favorite ${favorites.has(item.key) ? "is-active" : ""}`} aria-label={`${favorites.has(item.key) ? "Remove" : "Add"} ${item.label} ${favorites.has(item.key) ? "from" : "to"} favorites`} aria-pressed={favorites.has(item.key)} onClick={() => toggleFavorite(item.key)}>★</button>
            </div>
          )) : <div className="palette-empty">No {paletteKind} match this filter.{paletteKind === "connections" && <button className="button button-primary" onClick={() => openConnections()}>New connection</button>}</div>}
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
        {viewDraft.nodes.length === 0 && <div className="commissioning-onboarding"><span className="sheet-eyebrow">First commissioning</span><strong>Start with a proven harness</strong><span>Choose a template, connect its runtime, then validate before the first run.</span><div className="onboarding-templates">{studioCatalog.templates.map((template) => <button key={template.id} onClick={() => applyTemplate(template)}><strong>{template.label}</strong><small>{template.category}</small></button>)}</div><button className="onboarding-blank" onClick={() => setPaletteKind("components")}>Or build from components</button></div>}
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
          connections={connections}
          tools={studioCatalog.tools}
          onOpenConnections={(kind) => openConnections(kind, selectedNode?.id)}
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

      <section className="bottom-dock" aria-label="Diagnostics, run, tests, trace, and advanced YAML">
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
                {tab === "yaml" ? "Advanced" : tab}{tab === "problems" && displayedDiagnostics.length > 0 && <span className="tab-badge">{displayedDiagnostics.length}</span>}
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

      <ConnectionManager
        open={connectionManagerOpen}
        connections={connections}
        definitions={studioCatalog.connectionTypes.length ? studioCatalog.connectionTypes : CONNECTION_TYPE_CATALOG}
        requestedKind={requestedConnectionKind}
        onClose={() => { setConnectionManagerOpen(false); setRequestedConnectionKind(undefined); setConnectionTargetNodeId(undefined); }}
        onChanged={(next) => {
          setConnections(next);
          void refreshStudioCatalog().catch(() => setStatusNote("Connection saved, but the Tool catalog could not be refreshed."));
        }}
        onComplete={completeConnection}
      />
      <CompatiblePicker
        open={Boolean(attachmentPicker && !connectionManagerOpen)}
        slot={attachmentPicker?.slot ?? "tools"}
        nodeId={attachmentPicker?.nodeId ?? "agent"}
        tools={studioCatalog.tools}
        skills={studioCatalog.skills}
        connections={connections}
        onClose={() => setAttachmentPicker(undefined)}
        onTool={(tool) => { if (attachmentPicker) addTool(tool, attachmentPicker.nodeId); }}
        onSkill={(skill) => { if (attachmentPicker) attachSkill(skill, attachmentPicker.nodeId); }}
        onConnect={(kind, itemId) => {
          if (!attachmentPicker) return;
          setAttachmentPicker({ ...attachmentPicker, pendingItemId: itemId });
          openConnections(kind);
        }}
      />
      <CustomToolManager
        open={customToolOpen}
        connections={connections}
        onClose={() => setCustomToolOpen(false)}
        onChanged={() => refreshStudioCatalog().catch(() => setStatusNote("Tool saved, but the catalog could not be refreshed."))}
      />
      <SkillManager
        open={skillManagerOpen}
        onClose={() => setSkillManagerOpen(false)}
        onChanged={() => refreshStudioCatalog().catch(() => setStatusNote("Skill installed, but the catalog could not be refreshed."))}
      />
      {pendingApproval && <div className="approval-backdrop">
        <section className="approval-dialog" role="alertdialog" aria-modal="true" aria-labelledby="approval-title" aria-describedby="approval-description">
          <header><span className="sheet-eyebrow">One-call execution gate</span><h2 id="approval-title">Approve {pendingApproval.tool}?</h2></header>
          <div className="approval-body">
            <div className="approval-meter"><span>Risk</span><strong className={`risk-${pendingApproval.risk}`}>{pendingApproval.risk}</strong><span>Turn</span><strong>{pendingApproval.turn ?? "—"}</strong></div>
            <p id="approval-description">Review the model-generated argument preview. This decision is bound to the immutable JSON digest for this exact node, turn, and call.</p>
            <div className="approval-meter"><span>Bytes</span><strong>{pendingApproval.inputBytes}</strong><span>Preview</span><strong>{pendingApproval.previewLimited ? "redacted / bounded" : "exact"}</strong></div>
            {pendingApproval.previewLimited && <p className="field-error">Approval is disabled because the complete arguments cannot be displayed safely. Deny this call and reduce its input.</p>}
            <p><small>SHA-256 <code>{pendingApproval.inputDigest.slice(7)}</code></small></p>
            <pre>{JSON.stringify(pendingApproval.input, null, 2)}</pre>
          </div>
          <footer><button className="button" disabled={approvalBusy} onClick={() => void decideApproval(false)}>Deny</button><button className="button button-primary" disabled={approvalBusy || pendingApproval.previewLimited} onClick={() => void decideApproval(true)}>{approvalBusy ? "Sending…" : "Approve once"}</button></footer>
        </section>
      </div>}
    </main>
  );
}
