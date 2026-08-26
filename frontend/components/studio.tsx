"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  BUILTIN_COMPONENT_MANIFESTS,
  describeHarness,
  parseSpec,
  stringifySpec,
  skillConnectionRequirement,
  validateCandidateConnection,
  type ComponentManifest,
  type Diagnostic,
  type HarnessAssertion,
  type HarnessSpec,
  type HarnessTestCase,
  type RunEvent,
} from "@harnestai/core/browser";
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
  useStoreApi,
  type Connection,
  type IsValidConnection,
  type OnNodeDrag,
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
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  createDocumentState,
  compatiblePortInsertions,
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
  type CanvasPortAnchor,
  type CanvasPortInsertion,
} from "@/lib/studio-state";
import { catalogMap, colorFor, glyphFor, validationRegistryFor } from "@/lib/component-catalog";
import { EMPTY_SPEC } from "@/lib/default-spec";
import { HarnessNodeComponent } from "./harness-node";
import { HarnessEdgeComponent } from "./harness-edge";
import { Inspector } from "./inspector";
import {
  connectionCanRun,
  missingConnectionSetup,
  type ConnectionKind,
  type ConnectionSummary,
} from "@/lib/connections";
import { formatExperimentValue, parseExperimentValue } from "@/lib/experiments";
import { ClientApiError, requestJson, apiErrorMessage } from "@/lib/api-client";
import { buildReadiness } from "@/lib/readiness";
import { diagnosticFieldPath, diagnosticRecoveryAction } from "@/lib/diagnostics";
import { STUDIO_SURFACE_HREFS, surfaceFromPathname, type StudioSurface } from "@/lib/studio-route";
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
import { useI18n } from "./i18n-provider";
import { categoryLabel, componentLabel, connectionLabel } from "@/i18n/manifest";
import { JourneyAction, ReadinessTrail, SetupJourney, type SetupJourneyStep } from "./studio-guidance";
import { Button, ConfirmDialog } from "./ui/ui";
import type { SettingsPage } from "./studio-settings";
import { eventNodeId, eventSummary, IntegrationWorkspace, RunsWorkspace, type StoredRun } from "./studio-workspaces";
import { VersionHistory } from "./version-history";
import { ProjectFiles } from "./project-files";
import { layoutGraph } from "@/lib/graph-layout";
import { latestRunSnapshot, liveGraph } from "@/lib/live-graph";
import { readNdjson } from "@/lib/ndjson";
import { randomId } from "@/lib/random-id";

const nodeTypes = { harness: HarnessNodeComponent };
const edgeTypes = { harness: HarnessEdgeComponent };
const defaultEdgeOptions = { type: "harness", interactionWidth: 24 };
const LEGACY_COMPONENT_TYPES = new Set(["model", "prompt", "agent", "output"]);
function PlaygroundLoading() {
  const { t } = useI18n();
  return <div className="surface-loading" role="status"><span /><strong>{t("playground.loading")}</strong></div>;
}
const Playground = dynamic(() => import("./playground").then((module) => module.Playground), {
  loading: PlaygroundLoading,
});
const ConnectionManager = dynamic(() => import("./connection-manager").then((module) => module.ConnectionManager));
const CompatiblePicker = dynamic(() => import("./compatible-picker").then((module) => module.CompatiblePicker));
const CustomToolManager = dynamic(() => import("./custom-tool-manager").then((module) => module.CustomToolManager));
const SkillManager = dynamic(() => import("./skill-manager").then((module) => module.SkillManager));
const StudioSettings = dynamic(() => import("./studio-settings").then((module) => module.StudioSettings));

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

type DockTab = "project" | "yaml" | "problems" | "tests" | "experiments" | "trace";

type AttachmentPicker = { nodeId: string; slot: "tools" | "skills"; pendingItemId?: string };
type PendingSkillAttach = { nodeId: string; skillId: string };

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

const STRING_ASSERTION_TYPES: readonly HarnessAssertion["type"][] = ["includes", "equals", "matches"];
const TEST_ASSERTION_TYPES: readonly HarnessAssertion["type"][] = [
  "includes", "equals", "matches", "output-schema", "tool-called", "latency", "iterations",
];

const testAssertions = (test: HarnessTestCase): readonly HarnessAssertion[] => {
  if ("assertions" in test && test.assertions) return test.assertions;
  return test.assertion ? [test.assertion] : [];
};

const assertionForType = (type: HarnessAssertion["type"]): HarnessAssertion => {
  switch (type) {
    case "includes": case "equals": case "matches": return { type, value: "" };
    case "output-schema": return { type, schema: { type: "object" } };
    case "tool-called": return { type, tool: "", minCalls: 1 };
    case "latency": return { type, maxMs: 5_000 };
    case "iterations": return { type, max: 3 };
  }
};

const replaceTestAssertions = (
  test: HarnessTestCase,
  assertions: readonly HarnessAssertion[],
  version: HarnessSpec["version"],
): HarnessTestCase => {
  if (version === "0.1") return { ...test, assertion: assertions[0] as Extract<HarnessAssertion, { value: string }> } as HarnessTestCase;
  const next = { ...test, assertions: [...assertions] } as HarnessTestCase & { assertion?: HarnessAssertion };
  delete next.assertion;
  return next;
};

function TestJsonEditor({ label, value, disabled, onChange }: {
  label: string;
  value: unknown;
  disabled: boolean;
  onChange: (value: unknown) => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState("");
  useEffect(() => { setText(JSON.stringify(value, null, 2)); setError(""); }, [value]);
  return <label className="test-case-field"><span>{label}</span><textarea value={text} disabled={disabled} spellCheck={false} aria-invalid={Boolean(error)} onChange={(event) => setText(event.target.value)} onBlur={() => {
    try { onChange(JSON.parse(text) as unknown); setError(""); } catch { setError(t("inspector.jsonInvalid")); }
  }} />{error && <small className="field-error">{error}</small>}</label>;
}

function TestAssertionEditor({ assertion, disabled, removable, advanced, onChange, onRemove }: {
  assertion: HarnessAssertion;
  disabled: boolean;
  removable: boolean;
  advanced: boolean;
  onChange: (assertion: HarnessAssertion) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const number = (value: string) => value === "" ? undefined : Number(value);
  return <div className="test-expectation">
    <label><span>{t("tests.expect")}</span><select value={assertion.type} disabled={disabled} onChange={(event) => onChange(assertionForType(event.target.value as HarnessAssertion["type"]))}>{(advanced ? TEST_ASSERTION_TYPES : STRING_ASSERTION_TYPES).map((type) => <option value={type} key={type}>{type}</option>)}</select></label>
    {(assertion.type === "includes" || assertion.type === "equals" || assertion.type === "matches") && <label><span>{assertion.type === "matches" ? t("tests.pattern") : t("tests.expectedText")}</span><input value={assertion.value} disabled={disabled} onChange={(event) => onChange({ ...assertion, value: event.target.value })} /></label>}
    {assertion.type === "output-schema" && <TestJsonEditor label={t("tests.outputSchema")} value={assertion.schema} disabled={disabled} onChange={(schema) => onChange({ ...assertion, schema: schema as Record<string, unknown> })} />}
    {assertion.type === "tool-called" && <><label><span>{t("tests.tool")}</span><input required value={assertion.tool} disabled={disabled} onChange={(event) => onChange({ ...assertion, tool: event.target.value })} /></label><label><span>{t("tests.minCalls")}</span><input type="number" min={0} value={assertion.minCalls ?? ""} disabled={disabled} onChange={(event) => onChange({ ...assertion, minCalls: number(event.target.value) })} /></label><label><span>{t("tests.maxCalls")}</span><input type="number" min={0} value={assertion.maxCalls ?? ""} disabled={disabled} onChange={(event) => onChange({ ...assertion, maxCalls: number(event.target.value) })} /></label></>}
    {assertion.type === "latency" && <label><span>{t("tests.maxLatency")}</span><input type="number" min={0} value={assertion.maxMs} disabled={disabled} onChange={(event) => onChange({ ...assertion, maxMs: Number(event.target.value) })} /></label>}
    {assertion.type === "iterations" && <><label><span>{t("tests.minIterations")}</span><input type="number" min={0} value={assertion.min ?? ""} disabled={disabled} onChange={(event) => onChange({ ...assertion, min: number(event.target.value) })} /></label><label><span>{t("tests.maxIterations")}</span><input type="number" min={0} value={assertion.max ?? ""} disabled={disabled} onChange={(event) => onChange({ ...assertion, max: number(event.target.value) })} /></label></>}
    {removable && <button className="button" type="button" disabled={disabled} onClick={onRemove}>{t("tests.removeCheck")}</button>}
  </div>;
}

interface ExperimentResult {
  readonly id: string;
  readonly label: string;
  readonly ok: boolean;
  readonly runId?: string;
  readonly output?: unknown;
  readonly durationMs?: number;
  readonly usage?: Record<string, number>;
  readonly costUsd?: number;
  readonly quality?: { readonly passed: number; readonly total: number; readonly averageScore?: number };
  readonly error?: string;
  readonly diagnostics?: Diagnostic[];
}

interface NodeRunPresentation {
  readonly runState: NodeRunState;
  readonly lastRun?: NonNullable<HarnessNode["data"]["lastRun"]>;
}

interface DisplayNodeCacheEntry {
  readonly source: HarnessNode;
  readonly diagnostics: Diagnostic[];
  readonly run?: NodeRunPresentation;
  readonly locked: boolean;
  readonly pinned: boolean;
  readonly canInsertAtPort: NonNullable<HarnessNode["data"]["canInsertAtPort"]>;
  readonly getPortInsertions: NonNullable<HarnessNode["data"]["getPortInsertions"]>;
  readonly onInsertAtPort: NonNullable<HarnessNode["data"]["onInsertAtPort"]>;
  readonly onAddAttachment: NonNullable<HarnessNode["data"]["onAddAttachment"]>;
  readonly output: HarnessNode;
}

const EMPTY_NODE_DIAGNOSTICS: Diagnostic[] = [];

const PALETTE_LABEL_KEYS = {
  components: "builder.catalog.components",
  tools: "builder.catalog.tools",
  skills: "builder.catalog.skills",
  connections: "builder.catalog.connections",
  templates: "builder.catalog.templates",
} as const;

const DOCK_LABEL_KEYS = {
  project: "builder.dock.project",
  problems: "builder.dock.issues",
  tests: "builder.dock.tests",
  experiments: "builder.dock.compare",
  trace: "builder.dock.runs",
  yaml: "builder.dock.yaml",
} as const;

const chooseEntrypoint = (draft: HarnessDraft) => {
  const outgoing = new Set(draft.edges.map((edge) => edge.source));
  return draft.nodes.find((node) => node.data.manifest.category === "Output" && !outgoing.has(node.id))?.id
    ?? draft.nodes.find((node) => !outgoing.has(node.id))?.id
    ?? "";
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
  const { t } = useI18n();
  const error = state.phase === "error";
  return (
    <div className={error ? "studio-fatal" : "studio-loading"}>
      <div className="startup-card">
        <div className="startup-mark" />
        <h1>{error ? t("app.error.title") : t("app.loading.title")}</h1>
        <p>{error ? state.message : t("app.loading.description")}</p>
        {error && <Button variant="primary" style={{ marginTop: 18 }} onClick={onRetry}>{t("common.retry")}</Button>}
      </div>
    </div>
  );
}

export default function Studio() {
  const { t } = useI18n();
  const [boot, setBoot] = useState<BootState>({ phase: "loading" });
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setBoot({ phase: "loading" });
    requestJson<SpecPayload>("/api/spec", { signal: controller.signal })
      .then((payload) => setBoot({ phase: "ready", payload }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setBoot({ phase: "error", message: apiErrorMessage(error, t("builder.error.load"), t) });
      });
    return () => controller.abort();
  }, [loadAttempt, t]);

  if (boot.phase !== "ready") return <Startup state={boot} onRetry={() => setLoadAttempt((value) => value + 1)} />;

  return (
    <ReactFlowProvider>
      <StudioReady key={`${boot.payload.file}:${loadAttempt}`} initial={boot.payload} />
    </ReactFlowProvider>
  );
}

function StudioReady({ initial }: { initial: SpecPayload }) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t, locale, setLocale, formatDate, formatTime } = useI18n();
  const surface = surfaceFromPathname(pathname);
  const navigate = useCallback((next: StudioSurface) => router.push(STUDIO_SURFACE_HREFS[next]), [router]);
  const requestedSettingsPage = searchParams.get("section");
  const settingsPage: SettingsPage = requestedSettingsPage === "connections" || requestedSettingsPage === "tools" || requestedSettingsPage === "runtime"
    ? requestedSettingsPage : "general";
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
  const [activeDock, setActiveDockState] = useState<DockTab>("problems");
  const [dockOpen, setDockOpen] = useState(false);
  const setActiveDock = useCallback((tab: DockTab) => {
    setActiveDockState(tab);
    setDockOpen(true);
  }, []);
  const [welcomeDismissed, setWelcomeDismissed] = useState(initial.exists);
  const [setupDismissed, setSetupDismissed] = useState(initial.exists);
  const [confirmation, setConfirmation] = useState<{
    title: string;
    description: string;
    confirmLabel: string;
    onConfirm: () => void;
  }>();
  const [diagnosticFocus, setDiagnosticFocus] = useState<{ componentId?: string; path: string; version: number }>();
  const [paletteKind, setPaletteKind] = useState<PaletteKind>(initial.exists ? "components" : "templates");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteCategory, setPaletteCategory] = useState("all");
  const [pendingPlacement, setPendingPlacement] = useState<{ type: string; label: string }>();
  const [placementGhost, setPlacementGhost] = useState<{ x: number; y: number; label: string }>();
  const suppressPaletteClickUntil = useRef(0);
  const [layouting, setLayouting] = useState(false);
  const [canvasMode, setCanvasMode] = useState<"design" | "live">("design");
  const [liveRunPhase, setLiveRunPhase] = useState<"idle" | "starting" | "running" | "error">("idle");
  const [liveInput, setLiveInput] = useState("");
  const [liveInstruction, setLiveInstruction] = useState("");
  const [liveTarget, setLiveTarget] = useState("run");
  const [studioCatalog, setStudioCatalog] = useState<StudioCatalogPayload>({
    components: catalog,
    tools: [],
    skills: [],
    templates: TEMPLATE_CATALOG,
    connectionTypes: CONNECTION_TYPE_CATALOG,
  });
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [connectionsLoaded, setConnectionsLoaded] = useState(false);
  const [connectionManagerOpen, setConnectionManagerOpen] = useState(false);
  const [requestedConnectionKind, setRequestedConnectionKind] = useState<ConnectionKind>();
  const [requestedConnectionId, setRequestedConnectionId] = useState<string>();
  const [connectionTargetNodeId, setConnectionTargetNodeId] = useState<string>();
  const [attachmentPicker, setAttachmentPicker] = useState<AttachmentPicker>();
  const [pendingSkillAttach, setPendingSkillAttach] = useState<PendingSkillAttach>();
  const [customToolOpen, setCustomToolOpen] = useState(false);
  const [skillManagerOpen, setSkillManagerOpen] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState<TemplateCatalogItem["id"]>();
  const [favorites, setFavorites] = useState<ReadonlySet<string>>(new Set());
  const [recents, setRecents] = useState<readonly string[]>([]);
  const [savePhase, setSavePhase] = useState<"idle" | "saving" | "error">("idle");
  const [saveConflict, setSaveConflict] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<number>();
  const initialStatus = useCallback(() => initial.diagnostics?.some((item) => item.severity === "error")
    ? t("builder.status.hostIssues", { count: initial.diagnostics.length })
    : initial.exists ? t("builder.status.loaded") : t("builder.status.new"), [initial.diagnostics, initial.exists, t]);
  const [statusNote, setStatusNote] = useState(initialStatus);
  useEffect(() => setStatusNote(initialStatus()), [initialStatus, locale]);
  const [runInput, setRunInput] = useState("");
  const [runId, setRunId] = useState("");
  const [trace, setTrace] = useState<RunEvent[]>([]);
  const [testPhase, setTestPhase] = useState<"idle" | "running" | "error">("idle");
  const [testReport, setTestReport] = useState<TestReport>();
  const [experimentComponentId, setExperimentComponentId] = useState("");
  const [experimentField, setExperimentField] = useState("");
  const [experimentA, setExperimentA] = useState("");
  const [experimentB, setExperimentB] = useState("");
  const [experimentPhase, setExperimentPhase] = useState<"idle" | "running" | "error">("idle");
  const [experimentResults, setExperimentResults] = useState<ExperimentResult[]>([]);
  const [storedRuns, setStoredRuns] = useState<StoredRun[]>([]);
  const [storedRunPhase, setStoredRunPhase] = useState<"idle" | "loading" | "error">("idle");
  const runsRequested = useRef(false);
  const experimentAbortRef = useRef<AbortController | null>(null);
  const liveAbortRef = useRef<AbortController | null>(null);
  const saveAbortRef = useRef<AbortController | undefined>(undefined);
  const saveSessionIdRef = useRef(randomId());
  const lastSavedYamlRef = useRef(initial.yaml);
  const reviewedSkillScripts = useRef(new Set<string>());
  const confirmedTemplate = useRef<string | undefined>(undefined);
  const canvasRef = useRef<HTMLDivElement>(null);
  const fittedGraph = useRef<string | undefined>(undefined);
  const reactFlow = useReactFlow<HarnessNode, HarnessEdge>();
  const reactFlowStore = useStoreApi<HarnessNode, HarnessEdge>();
  const applyTheme = useCallback((next: "light" | "dark") => {
    setTheme(next);
    globalThis.document.documentElement.dataset.theme = next;
    localStorage.setItem("harnest.studio.theme", next);
  }, []);
  useEffect(() => {
    const stored = localStorage.getItem("harnest.studio.theme");
    const next = stored === "light" || stored === "dark"
      ? stored
      : window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    setTheme(next);
    globalThis.document.documentElement.dataset.theme = next;
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void requestJson<StudioCatalogPayload>("/api/catalog", { signal: controller.signal })
      .then((nextCatalog) => {
        setStudioCatalog(nextCatalog);
        if (nextCatalog.components.length) {
          setCatalog(nextCatalog.components);
          dispatch({ type: "set-catalog", catalog: nextCatalog.components });
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setStatusNote(apiErrorMessage(error, t("builder.error.catalog"), t));
      });
    void requestJson<{ connections: ConnectionSummary[] }>("/api/connections", { signal: controller.signal })
      .then((connectionPayload) => {
        setConnections(connectionPayload.connections);
        setConnectionsLoaded(true);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setConnectionsLoaded(true);
          setStatusNote(apiErrorMessage(error, t("builder.error.connections"), t));
        }
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

  useEffect(() => {
    const receiveRunEvent = (raw: Event) => {
      const event = (raw as CustomEvent<RunEvent>).detail;
      if (!event || typeof event !== "object") return;
      if (event.type === "run-start") {
        setRunId(event.runId);
        setTrace([event]);
        setLiveRunPhase("running");
        return;
      }
      setTrace((events) => events.some((candidate) => candidate.runId === event.runId && candidate.sequence === event.sequence)
        ? events : [...events, event]);
      if (event.type === "run-snapshot" && event.snapshot.agents.length) setCanvasMode("live");
      if (event.type === "run-end") setLiveRunPhase("idle");
      if (event.type === "error") setLiveRunPhase("error");
    };
    window.addEventListener("harnest-run-event", receiveRunEvent);
    return () => window.removeEventListener("harnest-run-event", receiveRunEvent);
  }, []);

  const refreshStudioCatalog = useCallback(async () => {
    const next = await requestJson<StudioCatalogPayload>("/api/catalog");
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
      void requestJson<{ connections: ConnectionSummary[] }>("/api/connections")
        .then((payload) => {
          setConnections(payload.connections);
          setStatusNote(t((event.data as { ok?: boolean }).ok ? "builder.oauth.completed" : "builder.oauth.cancelled"));
        })
        .catch(() => setStatusNote(t("builder.oauth.refreshFailed")));
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
    layout: activeGraph.layout,
  } : document.draft, [activeGraph, document.draft]);
  const documentDraftRef = useRef(document.draft);
  const viewDraftRef = useRef(viewDraft);
  documentDraftRef.current = document.draft;
  viewDraftRef.current = viewDraft;
  const integrationContractCache = useRef({
    semanticRevision: document.semanticRevision,
    contract: describeHarness(draftToSpec(document.draft)),
  });
  if (integrationContractCache.current.semanticRevision !== document.semanticRevision) {
    integrationContractCache.current = {
      semanticRevision: document.semanticRevision,
      contract: describeHarness(draftToSpec(document.draft)),
    };
  }
  const integrationContract = integrationContractCache.current.contract;
  const replaceViewDraft = useCallback((draft: HarnessDraft, touch: "none" | "transient" | "layout" | "semantic") => {
    if (!activeSubgraph) {
      dispatch({ type: "replace-draft", draft, touch });
      return;
    }
    dispatch({
      type: "replace-draft",
      draft: {
        ...documentDraftRef.current,
        root: { ...documentDraftRef.current.root, version: draft.root.version },
        subgraphs: {
          ...documentDraftRef.current.subgraphs,
          [activeSubgraph]: {
            entrypoint: draft.root.entrypoint,
            nodes: draft.nodes,
            edges: draft.edges,
            ...(draft.layout ? { layout: draft.layout } : {}),
          },
        },
      },
      touch,
    });
  }, [activeSubgraph]);

  const errorDiagnostics = document.diagnostics.filter((item) => item.severity === "error");
  const displayedDiagnostics = document.yamlState === "synced" ? document.diagnostics : document.yamlDiagnostics;
  const experimentRunning = experimentPhase === "running";
  const running = experimentRunning;
  const graphLocked = running || layouting || canvasMode === "live" || document.yamlState !== "synced";
  const dirty = document.revision !== document.savedRevision || document.yamlState !== "synced";
  const structuralValidationCache = useRef({
    semanticRevision: document.semanticRevision,
    valid: parseSpec(stringifySpec(draftToSpec(document.draft))).ok,
  });
  if (structuralValidationCache.current.semanticRevision !== document.semanticRevision) {
    structuralValidationCache.current = {
      semanticRevision: document.semanticRevision,
      valid: parseSpec(stringifySpec(draftToSpec(document.draft))).ok,
    };
  }
  const structurallyValid = document.yamlState === "synced" && structuralValidationCache.current.valid;
  const serverValidated = document.validatedSemanticRevision === document.semanticRevision
    && document.validationPhase === "server-valid";
  const canValidate = !running && !dirty && document.yamlState === "synced" && document.validationPhase !== "checking";
  const canSave = !running && structurallyValid && dirty && savePhase !== "saving";
  const canAutoSave = canSave && savePhase !== "error";
  const canRun = !running && !dirty && serverValidated;
  const canUndo = !graphLocked && document.historyPast.length > 0;
  const canRedo = !graphLocked && document.historyFuture.length > 0;
  useEffect(() => {
    const handleHistoryShortcut = (event: globalThis.KeyboardEvent) => {
      const target = event.target;
      if (!(event.ctrlKey || event.metaKey) || event.altKey || !(target instanceof HTMLElement)
        || target.matches("input, textarea, select, [contenteditable=true]")) return;
      const key = event.key.toLocaleLowerCase();
      if (key !== "z" && key !== "y") return;
      const redo = key === "y" || (key === "z" && event.shiftKey);
      if (redo ? !canRedo : !canUndo) return;
      event.preventDefault();
      dispatch({ type: redo ? "redo" : "undo" });
      setStatusNote(redo ? t("builder.redoDone") : t("builder.undoDone"));
    };
    window.addEventListener("keydown", handleHistoryShortcut);
    return () => window.removeEventListener("keydown", handleHistoryShortcut);
  }, [canRedo, canUndo, t]);
  const selectedNode = viewDraft.nodes.find((node) => node.selected);
  const selectedEdge = viewDraft.edges.find((edge) => edge.selected);
  const welcome = !welcomeDismissed && !initial.exists && viewDraft.nodes.length === 0;
  const experimentComponents = useMemo(() => viewDraft.nodes
    .map((node) => node.data.component)
    .filter((component) => Object.keys(component.config as Record<string, unknown>).length > 0), [viewDraft.nodes]);
  const experimentComponent = experimentComponents.find(({ id }) => id === experimentComponentId)
    ?? experimentComponents[0];
  const experimentFields = experimentComponent
    ? Object.keys(experimentComponent.config as Record<string, unknown>).sort()
    : [];
  const selectedExperimentField = experimentFields.includes(experimentField)
    ? experimentField
    : experimentFields[0] ?? "";
  const experimentSample = experimentComponent && selectedExperimentField
    ? (experimentComponent.config as Record<string, unknown>)[selectedExperimentField]
    : undefined;
  const canCompare = canRun && Boolean(experimentComponent && selectedExperimentField);
  const experimentSampleText = formatExperimentValue(experimentSample);
  useEffect(() => {
    setExperimentA(experimentSampleText);
    setExperimentB(typeof experimentSample === "number"
      ? formatExperimentValue(experimentSample + 0.5)
      : typeof experimentSample === "boolean"
        ? formatExperimentValue(!experimentSample)
        : experimentSampleText);
  }, [experimentComponent?.id, experimentSample, experimentSampleText, selectedExperimentField]);
  const paletteItems = useMemo<PaletteViewItem[]>(() => {
    if (paletteKind === "components") return catalog.map((manifest) => ({
      key: `components:${manifest.type}`, id: manifest.type, kind: paletteKind, label: componentLabel(t, manifest.type, manifest.label),
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
      description: `${connectionLabel(t, connection.kind)} · ${t(`connections.status.${connection.status}`)}`, category: connection.scope,
      available: true, payload: connection,
    }));
    return studioCatalog.templates.map((template) => ({
      key: `templates:${template.id}`, id: template.id, kind: paletteKind, label: template.label,
      description: template.description, category: template.category, available: true, payload: template,
    }));
  }, [catalog, connections, paletteKind, studioCatalog.skills, studioCatalog.templates, studioCatalog.tools, t]);
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

  const insertAtPort = useCallback((anchor: CanvasPortAnchor, insertion: CanvasPortInsertion) => {
    if (graphLocked) return;
    const current = viewDraftRef.current;
    const anchorNode = current.nodes.find((node) => node.id === anchor.nodeId);
    const manifest = manifests.get(insertion.type);
    if (!anchorNode || !manifest) {
      setStatusNote(t("builder.compatibleUnavailable"));
      return;
    }
    const id = uniqueComponentId(insertion.type, new Set(current.nodes.map((node) => node.id)));
    const component = { id, type: insertion.type, config: structuredClone(manifest.defaultConfig) } as HarnessComponent;
    const candidate: HarnessConnection = anchor.direction === "output" ? {
      from: { component: anchor.nodeId, port: anchor.port },
      to: { component: id, port: insertion.connectPort },
    } : {
      from: { component: id, port: insertion.connectPort },
      to: { component: anchor.nodeId, port: anchor.port },
    };
    const upgraded = current.root.version === "0.1" && !LEGACY_COMPONENT_TYPES.has(insertion.type);
    const root = {
      ...current.root,
      ...(upgraded ? { version: "0.2" as const } : {}),
      ...(manifest.category === "Output" ? { entrypoint: id } : {}),
    };
    const node: HarnessNode = {
      id,
      type: "harness",
      position: {
        x: anchorNode.position.x + (anchor.direction === "output" ? 360 : -360),
        y: anchorNode.position.y + Math.min(160, current.nodes.filter((item) => Math.abs(item.position.x - anchorNode.position.x) < 80).length * 24),
      },
      data: { component, manifest },
      selected: true,
    };
    const draft = {
      ...current,
      root,
      nodes: [...current.nodes.map((candidateNode) => ({ ...candidateNode, selected: false })), node],
    };
    const validation = validateCandidateConnection(draftToSpec(draft), candidate, { components: validationComponents });
    if (!validation.ok) {
      setStatusNote(validation.diagnostics[0]?.message ?? t("builder.portUnavailable"));
      return;
    }
    const connection = { ...candidate, id: `connection_${randomId().slice(0, 8)}` };
    const edge: HarnessEdge = {
      id: connection.id,
      type: "smoothstep",
      source: connection.from.component,
      sourceHandle: connection.from.port,
      target: connection.to.component,
      targetHandle: connection.to.port,
      data: { connection },
    };
    replaceViewDraft({ ...draft, edges: [...draft.edges, edge] }, "semantic");
    setStatusNote(t("builder.inserted", { name: componentLabel(t, manifest.type, manifest.label), id }));
  }, [graphLocked, manifests, replaceViewDraft, t, validationComponents]);

  const canInsertAtPort = useCallback((anchor: CanvasPortAnchor) => {
    const draft = viewDraftRef.current;
    if (anchor.direction === "output" && draft.root.entrypoint === anchor.nodeId) return false;
    const node = draft.nodes.find((candidate) => candidate.id === anchor.nodeId);
    if (!node) return false;
    const definition = anchor.direction === "input"
      ? node.data.manifest.ports.inputs[anchor.port]
      : node.data.manifest.ports.outputs[anchor.port];
    if (!definition) return false;
    if (anchor.direction === "input") {
      const count = draft.edges.filter((edge) => edge.target === anchor.nodeId && edge.targetHandle === anchor.port).length;
      const max = definition.maxConnections ?? (definition.variadic ? Number.POSITIVE_INFINITY : 1);
      if (count >= max) return false;
    }
    return true;
  }, []);
  const getPortInsertions = useCallback((anchor: CanvasPortAnchor) =>
    compatiblePortInsertions(viewDraftRef.current, catalog, anchor), [catalog]);
  const openAttachmentPicker = useCallback((nodeId: string, slot: "tools" | "skills") =>
    setAttachmentPicker({ nodeId, slot }), []);

  const diagnosticsByNode = useMemo(() => {
    const grouped = new Map<string, Diagnostic[]>();
    for (const diagnostic of document.diagnostics) {
      if (!diagnostic.componentId || (activeSubgraph
        ? !diagnostic.path.startsWith(`$.subgraphs.${activeSubgraph}.`)
        : diagnostic.path.startsWith("$.subgraphs."))) continue;
      const current = grouped.get(diagnostic.componentId) ?? [];
      current.push(diagnostic);
      grouped.set(diagnostic.componentId, current);
    }
    return grouped;
  }, [activeSubgraph, document.diagnostics]);
  const runByNode = useMemo(() => {
    const events = new Map<string, RunEvent[]>();
    for (const event of trace) {
      const nodeId = eventNodeId(event)?.split("/").at(-1);
      if (!nodeId) continue;
      const current = events.get(nodeId) ?? [];
      current.push(event);
      events.set(nodeId, current);
    }
    return new Map([...events].map(([nodeId, nodeEvents]) => {
      const ended = nodeEvents.findLast((event) => event.type === "node-end") as (RunEvent & { durationMs?: number }) | undefined;
      const failed = nodeEvents.findLast((event) => event.type === "error") as (RunEvent & { message?: string }) | undefined;
      const runState: NodeRunState = failed ? "error" : ended ? "success" : nodeEvents.some((event) => event.type === "node-start") ? "running" : "idle";
      return [nodeId, {
        runState,
        lastRun: {
          ...(runId ? { runId } : {}),
          state: runState,
          ...(typeof ended?.durationMs === "number" ? { durationMs: ended.durationMs } : {}),
          eventCount: nodeEvents.length,
          ...(failed?.message ? { error: failed.message } : {}),
        },
      } satisfies NodeRunPresentation] as const;
    }));
  }, [runId, trace]);
  const displayNodeCache = useRef(new Map<string, DisplayNodeCacheEntry>());
  const displayNodes = useMemo(() => {
    const nextCache = new Map<string, DisplayNodeCacheEntry>();
    const pinnedNodes = new Set(viewDraft.layout?.pinned ?? []);
    const nodes = viewDraft.nodes.map((node) => {
      const diagnostics = diagnosticsByNode.get(node.id) ?? EMPTY_NODE_DIAGNOSTICS;
      const run = runByNode.get(node.id);
      const cached = displayNodeCache.current.get(node.id);
      const pinned = pinnedNodes.has(node.id);
      if (cached?.source === node && cached.diagnostics === diagnostics && cached.run === run && cached.locked === graphLocked && cached.pinned === pinned
        && cached.canInsertAtPort === canInsertAtPort && cached.getPortInsertions === getPortInsertions
        && cached.onInsertAtPort === insertAtPort && cached.onAddAttachment === openAttachmentPicker) {
        nextCache.set(node.id, cached);
        return cached.output;
      }
      const output: HarnessNode = {
        ...node,
        data: {
          ...node.data,
          diagnostics,
          runState: run?.runState ?? "idle",
          lastRun: run?.lastRun,
          locked: graphLocked,
          pinned,
          canInsertAtPort,
          getPortInsertions,
          onInsertAtPort: insertAtPort,
          onAddAttachment: openAttachmentPicker,
        },
      };
      nextCache.set(node.id, {
        source: node,
        diagnostics,
        run,
        locked: graphLocked,
        pinned,
        canInsertAtPort,
        getPortInsertions,
        onInsertAtPort: insertAtPort,
        onAddAttachment: openAttachmentPicker,
        output,
      });
      return output;
    });
    displayNodeCache.current = nextCache;
    return nodes;
  }, [canInsertAtPort, diagnosticsByNode, getPortInsertions, graphLocked, insertAtPort, openAttachmentPicker, runByNode, viewDraft.layout?.pinned, viewDraft.nodes]);

  const displayEdges = useMemo(() => viewDraft.edges.map((edge) => ({
    ...edge,
    type: "harness",
    label: edge.data?.connection ? edgeLabel(edge.data.connection) : undefined,
    className: "",
    animated: false,
    data: {
      ...edge.data!,
      kind: edge.data?.connection && "condition" in edge.data.connection ? "condition" as const : "data" as const,
      running: false,
    },
  })), [viewDraft.edges]);

  const liveSnapshot = useMemo(() => latestRunSnapshot(trace), [trace]);
  const liveProjection = useMemo(() => liveGraph(liveSnapshot, manifests, {
    task: t("builder.live.task"),
    agent: t("builder.live.agent"),
    assigned: t("builder.live.edgeAssigned"),
    handoff: t("builder.live.edgeHandoff"),
    orchestrator: () => t("builder.live.orchestrator"),
    workingOn: (taskId) => t("builder.live.workingOn", { task: taskId }),
    depth: (value) => t("builder.live.depth", { count: value }),
    tokens: (value) => t("playground.tokens", { count: value }),
    status: (value) => ({
      queued: t("builder.live.status.queued"), running: t("builder.live.status.running"),
      waiting: t("builder.live.status.waiting"), blocked: t("builder.live.status.blocked"),
      completed: t("builder.live.status.completed"), failed: t("builder.live.status.failed"),
      cancelled: t("builder.live.status.cancelled"), superseded: t("builder.live.status.superseded"),
    })[value],
  }), [liveSnapshot, manifests, t]);
  const canvasNodes = canvasMode === "live" ? liveProjection.nodes : displayNodes;
  const canvasEdges = canvasMode === "live" ? liveProjection.edges : displayEdges;

  useEffect(() => {
    const store = reactFlowStore.getState();
    store.setNodes(canvasNodes);
    store.setEdges(canvasEdges);
  }, [canvasEdges, canvasNodes, reactFlowStore]);

  useEffect(() => {
    const graph = `${canvasMode}:${activeSubgraph ?? "root"}`;
    if (!canvasNodes.length || fittedGraph.current === graph) return undefined;
    const timer = window.setTimeout(() => {
      fittedGraph.current = graph;
      if (canvasMode === "design" && viewDraft.layout?.viewport) void reactFlow.setViewport(viewDraft.layout.viewport);
      else void reactFlow.fitView({ padding: 0.25 });
    }, 100);
    return () => window.clearTimeout(timer);
  }, [activeSubgraph, canvasMode, canvasNodes.length, reactFlow, viewDraft.layout?.viewport]);

  const onNodesChange: OnNodesChange<HarnessNode> = useCallback((changes) => {
    if (canvasMode === "live") return;
    if (graphLocked && changes.some((change) => change.type !== "select" && change.type !== "dimensions")) return;
    const persistentChanges = changes.filter((change) => change.type !== "position");
    if (!persistentChanges.length) return;
    const current = viewDraftRef.current;
    const nodes = applyNodeChanges(persistentChanges, current.nodes);
    const removed = persistentChanges.some((change) => change.type === "remove");
    const edges = removed ? current.edges.filter((edge) => nodes.some((node) => node.id === edge.source) && nodes.some((node) => node.id === edge.target)) : current.edges;
    let draft = { ...current, nodes, edges };
    if (removed && !nodes.some((node) => node.id === draft.root.entrypoint)) {
      draft = { ...draft, root: { ...draft.root, entrypoint: chooseEntrypoint(draft) } };
    }
    replaceViewDraft(draft, removed ? "semantic" : "none");
  }, [canvasMode, graphLocked, replaceViewDraft]);

  const onNodeDragStop: OnNodeDrag<HarnessNode> = useCallback(() => {
    const current = viewDraftRef.current;
    const positions = new Map(reactFlow.getNodes().map((node) => [node.id, node.position]));
    let changed = false;
    const nodes = current.nodes.map((node) => {
      const position = positions.get(node.id);
      if (!position || (position.x === node.position.x && position.y === node.position.y)) return node;
      changed = true;
      return { ...node, position };
    });
    if (changed) replaceViewDraft({ ...current, nodes }, "layout");
  }, [reactFlow, replaceViewDraft]);

  const autoLayout = useCallback(async () => {
    if (graphLocked) return;
    const current = viewDraftRef.current;
    const targets = current.nodes;
    if (targets.length < 2) return;
    const targetIds = new Set(targets.map(({ id }) => id));
    const rendered = new Map(reactFlow.getNodes().map((node) => [node.id, node]));
    const pinned = new Set(current.layout?.pinned ?? []);
    setLayouting(true);
    setStatusNote(t("builder.layout.running"));
    try {
      const positions = await layoutGraph({
        direction: "RIGHT",
        density: "comfortable",
        nodes: targets.map((node) => {
          const measured = rendered.get(node.id)?.measured;
          return {
            id: node.id,
            position: node.position,
            width: measured?.width ?? 260,
            height: measured?.height ?? 128,
            inputs: Object.keys(node.data.manifest.ports.inputs),
            outputs: Object.keys(node.data.manifest.ports.outputs),
            pinned: pinned.has(node.id),
          };
        }),
        edges: current.edges.filter((edge) => targetIds.has(edge.source) && targetIds.has(edge.target)).map((edge) => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          sourceHandle: edge.sourceHandle,
          targetHandle: edge.targetHandle,
        })),
      });
      const upgraded = current.root.version !== "0.3";
      replaceViewDraft({
        ...current,
        root: { ...current.root, version: "0.3" },
        nodes: current.nodes.map((node) => positions[node.id] ? { ...node, position: positions[node.id] } : node),
        layout: { ...current.layout, direction: "RIGHT" },
      }, upgraded ? "semantic" : "layout");
      window.setTimeout(() => setLayouting(false), 320);
      setStatusNote(t("builder.layout.done"));
      return;
    } catch (error) {
      setStatusNote(apiErrorMessage(error, t("builder.layout.failed"), t));
    }
    setLayouting(false);
  }, [graphLocked, reactFlow, replaceViewDraft, t]);

  const onEdgesChange: OnEdgesChange<HarnessEdge> = useCallback((changes) => {
    if (canvasMode === "live") return;
    if (graphLocked && changes.some((change) => change.type !== "select")) return;
    const current = viewDraftRef.current;
    const edges = applyEdgeChanges(changes, current.edges);
    const removed = changes.some((change) => change.type === "remove");
    const draft = { ...current, edges };
    replaceViewDraft(draft, removed ? "semantic" : "none");
  }, [canvasMode, graphLocked, replaceViewDraft]);

  const candidateConnection = useCallback((connection: Connection | HarnessEdge): HarnessConnection | null => {
    if (!connection.source || !connection.target || !connection.sourceHandle || !connection.targetHandle) return null;
    return {
      from: { component: connection.source, port: connection.sourceHandle },
      to: { component: connection.target, port: connection.targetHandle },
    };
  }, []);

  const isValidConnection: IsValidConnection<HarnessEdge> = useCallback((connection) => {
    const candidate = candidateConnection(connection);
    return candidate ? validateCandidateConnection(draftToSpec(viewDraftRef.current), candidate, { components: validationComponents }).ok : false;
  }, [candidateConnection, validationComponents]);

  const onConnect = useCallback((connection: Connection) => {
    if (graphLocked) return;
    const current = viewDraftRef.current;
    const candidate = candidateConnection(connection);
    if (!candidate) return;
    const validation = validateCandidateConnection(draftToSpec(current), candidate, { components: validationComponents });
    if (!validation.ok) {
      setStatusNote(validation.diagnostics[0]?.message ?? t("builder.incompatible"));
      return;
    }
    const id = `connection_${randomId().slice(0, 8)}`;
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
    const target = current.nodes.find((node) => node.id === complete.to.component);
    const root = target?.data.manifest.category === "Output"
      ? { ...current.root, entrypoint: target.id }
      : current.root;
    replaceViewDraft({ ...current, root, edges: [...current.edges, edge] }, "semantic");
    setStatusNote(t("builder.edgeConnected", {
      from: `${complete.from.component}.${complete.from.port}`,
      to: `${complete.to.component}.${complete.to.port}`,
    }));
  }, [candidateConnection, graphLocked, replaceViewDraft, t, validationComponents]);

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
        const connectionId = `connection_${randomId().slice(0, 8)}`;
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
    setStatusNote(`${t("builder.componentAdded", {
      name: componentLabel(t, manifest.type, manifest.label),
      id,
    })}${attachTo ? t("builder.componentAttached", { node: attachTo.nodeId }) : ""}${upgraded ? t("builder.specUpgraded") : ""}`);
  }, [graphLocked, manifests, replaceViewDraft, t, viewDraft]);

  const placeComponent = useCallback((type: string, x: number, y: number) => {
    if (!manifests.has(type)) return;
    addComponent(type, reactFlow.screenToFlowPosition({ x, y }));
  }, [addComponent, manifests, reactFlow]);

  const beginPointerPlacement = useCallback((item: PaletteViewItem, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (item.kind !== "components" || graphLocked || event.button !== 0) return;
    const start = { x: event.clientX, y: event.clientY };
    let moved = false;
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== event.pointerId) return;
      moved ||= Math.hypot(pointer.clientX - start.x, pointer.clientY - start.y) > 4;
      if (moved) setPlacementGhost({ x: pointer.clientX, y: pointer.clientY, label: item.label });
    };
    const up = (pointer: PointerEvent) => {
      if (pointer.pointerId !== event.pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setPlacementGhost(undefined);
      const bounds = canvasRef.current?.getBoundingClientRect();
      if (moved) suppressPaletteClickUntil.current = performance.now() + 500;
      if (moved && bounds && pointer.clientX >= bounds.left && pointer.clientX <= bounds.right
        && pointer.clientY >= bounds.top && pointer.clientY <= bounds.bottom) {
        placeComponent(item.id, pointer.clientX, pointer.clientY);
        setPendingPlacement(undefined);
      } else setPendingPlacement({ type: item.id, label: item.label });
    };
    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerup", up, { once: true });
    window.addEventListener("pointercancel", up, { once: true });
  }, [graphLocked, placeComponent]);

  const updateComponent = useCallback((component: HarnessComponent) => {
    if (graphLocked) return;
    const nodes = viewDraft.nodes.map((node) => node.id === component.id
      ? { ...node, data: { ...node.data, component } }
      : node);
    replaceViewDraft({ ...viewDraft, nodes }, "semantic");
  }, [graphLocked, replaceViewDraft, viewDraft]);

  const openConnections = useCallback((kind?: ConnectionKind, targetNodeId?: string, requestedId?: string) => {
    setRequestedConnectionKind(kind);
    setRequestedConnectionId(requestedId);
    setConnectionTargetNodeId(targetNodeId);
    setConnectionManagerOpen(true);
  }, []);

  const addTool = useCallback((
    tool: ToolCatalogItem,
    nodeId?: string,
    connection?: ConnectionSummary,
  ) => {
    if (!tool.installed) {
      setStatusNote(t("builder.toolUnavailable", { name: tool.label }));
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
    if (mcpPlaceholder && agentId) {
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
      setStatusNote(t("builder.toolEquipped", { name: tool.label, node: agentId }));
      return;
    }
    addComponent(type, position, config, agent ? { nodeId: agent.id, slot: "tools" } : undefined);
    markRecent(`tools:${tool.id}`);
    setAttachmentPicker(undefined);
  }, [addComponent, connections, markRecent, openConnections, reactFlow, replaceViewDraft, t, viewDraft]);

  const attachSkill = useCallback((skill: SkillCatalogItem, nodeId: string) => {
    const agent = viewDraft.nodes.find((node) => node.id === nodeId);
    if (!agent) return;
    const attached = viewDraft.edges.some((edge) => edge.target === nodeId && edge.targetHandle === "skills"
      && viewDraft.nodes.some((node) => node.id === edge.source && node.data.component.type === "skill"
        && node.data.component.config.skill === skill.id));
    if (attached) {
      setStatusNote(t("builder.skillEnabled", { name: skill.label, node: nodeId }));
      setAttachmentPicker(undefined);
      return;
    }
    const incoming = viewDraft.edges.filter((edge) => edge.target === nodeId)
      .flatMap((edge) => viewDraft.nodes.filter((node) => node.id === edge.source));
    const attachedToolIds = new Set(incoming.filter((node) => node.data.component.type === "tool")
      .map((node) => (node.data.component.config as Record<string, unknown>).tool)
      .filter((id): id is string => typeof id === "string"));
    const missingToolId = skill.requirements?.tools.find((id) => !attachedToolIds.has(id));
    if (missingToolId) {
      const tool = studioCatalog.tools.find((candidate) => candidate.id === missingToolId && candidate.installed);
      setPendingSkillAttach({ nodeId, skillId: skill.id });
      if (tool) {
        addTool(tool, nodeId);
        setStatusNote(t("builder.skillNeedsToolAdding", { skill: skill.label, tool: tool.label }));
      } else {
        setAttachmentPicker({ nodeId, slot: "tools" });
        setStatusNote(t("builder.skillNeedsTool", { skill: skill.label, tool: missingToolId }));
      }
      return;
    }
    const connectedIds = new Set(incoming.map((node) => (node.data.component.config as Record<string, unknown>).connectionId)
      .filter((id): id is string => typeof id === "string" && Boolean(id)));
    const missingConnection = skill.requirements?.connections.map((requirement) => ({
      requirement,
      ...skillConnectionRequirement(requirement),
    })).find(({ id }) => !connectedIds.has(id));
    if (missingConnection) {
      const saved = connections.find((connection) => connection.id === missingConnection.id);
      const kind = missingConnection.kind ?? saved?.kind;
      const target = incoming.find((node) => {
        if (kind === "provider") return node.data.component.type === "model";
        if (node.data.component.type !== "tool") return false;
        const toolId = (node.data.component.config as Record<string, unknown>).tool;
        const tool = studioCatalog.tools.find((candidate) => candidate.id === toolId);
        return Boolean(kind && tool?.connectionKinds?.includes(kind));
      });
      setAttachmentPicker({ nodeId, slot: "skills", pendingItemId: skill.id });
      openConnections(kind, target?.id, missingConnection.id);
      setStatusNote(t("builder.skillNeedsConnection", { skill: skill.label, id: missingConnection.id }));
      return;
    }
    if (skill.scriptsPresent && !reviewedSkillScripts.current.has(skill.id)) {
      setConfirmation({
        title: t("confirm.skill.title"),
        description: `${t("confirm.skill.description")} ${JSON.stringify(skill.provenance ?? { source: skill.source })}`,
        confirmLabel: t("confirm.skill.action"),
        onConfirm: () => {
          reviewedSkillScripts.current.add(skill.id);
          queueMicrotask(() => attachSkill(skill, nodeId));
        },
      });
      return;
    }
    const position = {
      x: agent.position.x - 300,
      y: agent.position.y + 230 + viewDraft.nodes.filter((node) => node.position.x < agent.position.x).length * 24,
    };
    addComponent("skill", position, { skill: skill.id }, { nodeId, slot: "skills" });
    markRecent(`skills:${skill.id}`);
    setPendingSkillAttach(undefined);
    setAttachmentPicker(undefined);
    const permissions = skill.requirements?.permissions ?? [];
    setStatusNote(permissions.length
      ? t("builder.skillEnabledWithPermissions", { name: skill.label, permissions: permissions.join(", ") })
      : t("builder.skillEnabledOnNode", { name: skill.label, node: nodeId }));
  }, [addComponent, addTool, connections, markRecent, openConnections, studioCatalog.tools, t, viewDraft.edges, viewDraft.nodes]);

  useEffect(() => {
    if (!pendingSkillAttach || connectionManagerOpen) return;
    const skill = studioCatalog.skills.find((candidate) => candidate.id === pendingSkillAttach.skillId);
    if (!skill) {
      setPendingSkillAttach(undefined);
      return;
    }
    const attachedTools = new Set(viewDraft.edges.filter((edge) => edge.target === pendingSkillAttach.nodeId)
      .flatMap((edge) => viewDraft.nodes.filter((node) => node.id === edge.source && node.data.component.type === "tool"))
      .map((node) => (node.data.component.config as Record<string, unknown>).tool)
      .filter((id): id is string => typeof id === "string"));
    if (skill.requirements?.tools.some((id) => !attachedTools.has(id))) return;
    setPendingSkillAttach(undefined);
    attachSkill(skill, pendingSkillAttach.nodeId);
  }, [attachSkill, connectionManagerOpen, pendingSkillAttach, studioCatalog.skills, viewDraft.edges, viewDraft.nodes]);

  const applyTemplate = useCallback((template: TemplateCatalogItem) => {
    const componentCount = document.draft.nodes.length
      + Object.values(document.draft.subgraphs).reduce((count, graph) => count + graph.nodes.length, 0);
    const subgraphCount = Object.keys(document.draft.subgraphs).length;
    if (componentCount && confirmedTemplate.current !== template.id) {
      setConfirmation({
        title: t("confirm.template.title"),
        description: t(dirty ? "confirm.template.descriptionUnsaved" : "confirm.template.descriptionSaved", {
          components: componentCount,
          subgraphs: subgraphCount,
        }),
        confirmLabel: t("confirm.template.action"),
        onConfirm: () => {
          confirmedTemplate.current = template.id;
          queueMicrotask(() => applyTemplate(template));
        },
      });
      return;
    }
    confirmedTemplate.current = undefined;
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
    if (next.version !== "0.1" && next.subgraphs) {
      for (const graph of Object.values(next.subgraphs)) graph.components = graph.components.map(equip) as typeof graph.components;
    }
    dispatch({ type: "replace-draft", draft: specToDraft(next, catalog), touch: "semantic" });
    setWelcomeDismissed(true);
    setActiveSubgraph(undefined);
    setSelectedTemplateId(template.id);
    setRunInput(template.sampleInput);
    setPaletteKind("connections");
    setPaletteCategory("all");
    setPaletteQuery("");
    markRecent(`templates:${template.id}`);
    const missing = template.connectionKinds?.find((kind) => !connections.some((connection) =>
      connection.kind === kind && connectionCanRun(connection)));
    setStatusNote(t(missing ? "builder.templateNeedsConnection" : "builder.templateAutoWired", { name: template.label }));
  }, [catalog, connections, dirty, document.draft.nodes.length, document.draft.subgraphs, markRecent, t]);

  const activatePaletteItem = useCallback((item: PaletteViewItem) => {
    markRecent(item.key);
    if (item.kind === "components") {
      setPendingPlacement({ type: item.id, label: item.label });
      setStatusNote(t("builder.placement.ready", { name: item.label }));
    }
    else if (item.kind === "tools") {
      const agent = selectedNode?.data.component.type === "agent" ? selectedNode.id : undefined;
      addTool(item.payload as ToolCatalogItem, agent);
    } else if (item.kind === "skills") {
      if (selectedNode?.data.component.type === "agent") attachSkill(item.payload as SkillCatalogItem, selectedNode.id);
      else setStatusNote(t("builder.selectAgentForSkill"));
    } else if (item.kind === "connections") openConnections();
    else applyTemplate(item.payload as TemplateCatalogItem);
  }, [addTool, applyTemplate, attachSkill, markRecent, openConnections, selectedNode, t]);

  const completeConnection = useCallback((connection: ConnectionSummary) => {
    if (connectionTargetNodeId) {
      const target = viewDraft.nodes.find((node) => node.id === connectionTargetNodeId);
      if (target) updateComponent({
        ...target.data.component,
        config: { ...(target.data.component.config as Record<string, unknown>), connectionId: connection.id },
      } as HarnessComponent);
    }
    if (!connectionTargetNodeId && (!attachmentPicker || attachmentPicker.slot === "skills")) {
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
        if (skill) setPendingSkillAttach({ nodeId: attachmentPicker.nodeId, skillId: skill.id });
      }
    }
    const needsMcpDiscovery = !attachmentPicker
      && selectedTemplateId === "mcp-agent"
      && (connection.kind === "mcp-http" || connection.kind === "mcp-stdio")
      && viewDraft.nodes.some((node) => node.data.component.type === "tool"
        && node.data.component.config.source === "mcp" && !node.data.component.config.tool);
    if (needsMcpDiscovery) {
      setRequestedConnectionKind(undefined);
      setRequestedConnectionId(undefined);
      setConnectionTargetNodeId(undefined);
      setStatusNote(t("builder.mcpConnected"));
      return;
    }
    setConnectionManagerOpen(false);
    setRequestedConnectionKind(undefined);
    setRequestedConnectionId(undefined);
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

  const selectDiagnostic = useCallback((diagnostic: Diagnostic) => {
    navigate("builder");
    selectComponent(diagnostic.componentId);
    setDiagnosticFocus((current) => ({
      componentId: diagnostic.componentId,
      path: diagnosticFieldPath(diagnostic.path) ?? diagnostic.path,
      version: (current?.version ?? 0) + 1,
    }));
  }, [navigate, selectComponent]);

  const showTraceComponent = useCallback((scopedId?: string) => {
    if (!scopedId) return;
    navigate("builder");
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
  }, [document.draft, navigate]);

  const editYaml = useCallback((text: string) => {
    const parsed = parseYamlDraft(text, catalog);
    dispatch({ type: "edit-yaml", text, pendingSpec: parsed.spec, diagnostics: parsed.diagnostics, parseOk: parsed.parseOk });
  }, [catalog]);

  const importYaml = useCallback(async (file?: File) => {
    if (!file || running) return;
    editYaml(await file.text());
    setActiveDock("yaml");
    setStatusNote(t("builder.yamlLoaded", { name: file.name }));
  }, [editYaml, running, t]);

  const openYaml = useCallback(async (file?: File) => {
    if (!file || running) return;
    const text = await file.text();
    const parsed = parseYamlDraft(text, catalog);
    dispatch({ type: "edit-yaml", text, pendingSpec: parsed.spec, diagnostics: parsed.diagnostics, parseOk: parsed.parseOk });
    if (parsed.spec) dispatch({ type: "apply-yaml" });
    setWelcomeDismissed(true);
    setActiveDock(parsed.spec ? "problems" : "yaml");
    setStatusNote(parsed.spec ? `${file.name} opened` : `${file.name} needs YAML fixes before it can be used`);
  }, [catalog, running]);

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
    setStatusNote(t("builder.status.validating"));
    try {
      const payload = await requestJson<{ ok: boolean; diagnostics: Diagnostic[]; catalog?: ComponentManifest[] }>("/api/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ yaml: stringifySpec(draftToSpec(document.draft)) }),
      }, { timeoutMs: 60_000 });
      dispatch({ type: "validation-result", semanticRevision, diagnostics: payload.diagnostics ?? [] });
      if (payload.catalog?.length) {
        setCatalog(payload.catalog);
        dispatch({ type: "set-catalog", catalog: payload.catalog });
      }
      if (!payload.ok) setActiveDock("problems");
      setStatusNote(payload.ok ? t("builder.status.valid") : t("save.issues", { count: payload.diagnostics.length }));
    } catch (error) {
      const diagnostic: Diagnostic = { code: "VALIDATE_REQUEST", path: "$", message: apiErrorMessage(error, t("builder.validationFailed"), t), severity: "error" };
      dispatch({ type: "validation-result", semanticRevision, diagnostics: [diagnostic] });
      setActiveDock("problems");
    }
  }, [canValidate, document.draft, document.semanticRevision, t]);

  const save = useCallback(async () => {
    if (!canSave) return;
    const revision = document.revision;
    const yaml = stringifySpec(draftToSpec(document.draft));
    if (yaml === lastSavedYamlRef.current) {
      dispatch({ type: "save-result", revision });
      setSavePhase("idle");
      return;
    }
    saveAbortRef.current?.abort();
    const controller = new AbortController();
    saveAbortRef.current = controller;
    setSavePhase("saving");
    setStatusNote(t("builder.status.saving"));
    try {
      const payload = await requestJson<{ diagnostics?: Diagnostic[]; superseded?: boolean; yaml?: string }>("/api/spec", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ yaml, baseYaml: lastSavedYamlRef.current, clientRevision: revision, saveSessionId: saveSessionIdRef.current }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (payload.superseded) { setSavePhase("idle"); return; }
      lastSavedYamlRef.current = payload.yaml ?? yaml;
      dispatch({ type: "save-result", revision });
      dispatch({ type: "host-diagnostics", diagnostics: payload.diagnostics ?? [] });
      setSavePhase("idle");
      setSaveConflict(false);
      setLastSavedAt(Date.now());
      if (payload.diagnostics?.length) setActiveDock("problems");
      setStatusNote(payload.diagnostics?.length
        ? t("builder.savedWithHostIssues", { count: payload.diagnostics.length })
        : t("builder.status.saved"));
    } catch (error) {
      if (controller.signal.aborted) return;
      setSavePhase("error");
      setSaveConflict(error instanceof ClientApiError && error.details.code === "SPEC_CONFLICT");
      setStatusNote(apiErrorMessage(error, t("builder.saveFailed"), t));
    } finally {
      if (saveAbortRef.current === controller) saveAbortRef.current = undefined;
    }
  }, [canSave, document.draft, document.revision, t]);

  const reloadProject = useCallback(async () => {
    const payload = await requestJson<SpecPayload>("/api/spec", { cache: "no-store" });
    saveAbortRef.current?.abort();
    if (payload.catalog?.length) setCatalog(payload.catalog);
    lastSavedYamlRef.current = payload.yaml;
    dispatch({ type: "load-saved", spec: payload.spec, yaml: payload.yaml });
    setActiveSubgraph(undefined);
    setSavePhase("idle");
    setSaveConflict(false);
    setLastSavedAt(Date.now());
    setStatusNote(t("project.saved"));
  }, [t]);

  const loadStoredRuns = useCallback(async () => {
    setStoredRunPhase("loading");
    try {
      const payload = await requestJson<{ runs?: StoredRun[] } | StoredRun[]>("/api/runs");
      setStoredRuns(Array.isArray(payload) ? payload : payload.runs ?? []);
      setStoredRunPhase("idle");
    } catch {
      setStoredRunPhase("error");
    }
  }, []);

  const startLiveRun = useCallback(async () => {
    if (!canRun || !liveInput.trim() || liveRunPhase === "starting" || liveRunPhase === "running") return;
    liveAbortRef.current?.abort();
    liveAbortRef.current = null;
    setLiveRunPhase("starting");
    setTrace([]);
    setCanvasMode("live");
    let controller: AbortController | undefined;
    try {
      const started = await requestJson<{ runId: string; events: string }>("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: liveInput }),
      }, { timeoutMs: 60_000 });
      setRunId(started.runId);
      controller = new AbortController();
      liveAbortRef.current = controller;
      setLiveRunPhase("running");
      const response = await fetch(started.events, { signal: controller.signal, cache: "no-store" });
      if (!response.ok) throw new Error(`Run event stream returned HTTP ${response.status}`);
      await readNdjson<RunEvent>(response, (event) => {
        setTrace((events) => events.some((candidate) => candidate.sequence === event.sequence) ? events : [...events, event]);
        if (event.type === "error") setLiveRunPhase("error");
        if (event.type === "run-end") setLiveRunPhase("idle");
      });
      setLiveRunPhase((phase) => phase === "running" ? "idle" : phase);
      void loadStoredRuns();
    } catch (error) {
      if (!controller?.signal.aborted) {
        setLiveRunPhase("error");
        setStatusNote(apiErrorMessage(error, t("builder.live.failed"), t));
      }
    } finally {
      if (liveAbortRef.current === controller) liveAbortRef.current = null;
    }
  }, [canRun, liveInput, liveRunPhase, loadStoredRuns, t]);

  const stopLiveRun = useCallback(async () => {
    if (!runId) return;
    await requestJson(`/api/runs/${encodeURIComponent(runId)}`, { method: "DELETE" }).catch(() => undefined);
    liveAbortRef.current?.abort();
    liveAbortRef.current = null;
    setLiveRunPhase("idle");
  }, [runId]);

  const sendLiveInstruction = useCallback(async () => {
    if (!runId || !liveInstruction.trim()) return;
    const snapshot = latestRunSnapshot(trace);
    const command = liveTarget.startsWith("task:")
      ? { type: "task-directive", taskId: liveTarget.slice(5), instruction: liveInstruction }
      : liveTarget.startsWith("agent:")
        ? { type: "message", target: { kind: "agent", id: liveTarget.slice(6) }, content: liveInstruction }
        : liveTarget.startsWith("team:")
          ? { type: "message", target: { kind: "team", id: liveTarget.slice(5) }, content: liveInstruction }
          : { type: "message", target: { kind: "run" }, content: liveInstruction };
    try {
      await requestJson(`/api/runs/${encodeURIComponent(runId)}/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
      });
      setLiveInstruction("");
      setStatusNote(t("builder.live.commandSent"));
      if (!snapshot) setLiveTarget("run");
    } catch (error) {
      setStatusNote(apiErrorMessage(error, t("builder.live.commandFailed"), t));
    }
  }, [liveInstruction, liveTarget, runId, t, trace]);

  const inspectStoredRun = useCallback(async (stored: StoredRun) => {
    setActiveDock("trace");
    if (stored.events) {
      setRunId(stored.runId);
      setTrace(stored.events);
      if (stored.events.some((event) => event.type === "run-snapshot")) setCanvasMode("live");
      return;
    }
    setStoredRunPhase("loading");
    try {
      const payload = await requestJson<{ run: StoredRun }>(`/api/runs?runId=${encodeURIComponent(stored.runId)}`);
      setRunId(payload.run.runId);
      setTrace(payload.run.events ?? []);
      if (payload.run.events?.some((event) => event.type === "run-snapshot")) setCanvasMode("live");
      setStoredRunPhase("idle");
    } catch {
      setStoredRunPhase("error");
    }
  }, []);

  useEffect(() => {
    if (surface !== "runs" || runsRequested.current) return;
    runsRequested.current = true;
    void loadStoredRuns();
  }, [loadStoredRuns, surface]);

  const runTests = useCallback(async () => {
    if (dirty || !serverValidated || testPhase === "running") return;
    setActiveDock("tests");
    setTestPhase("running");
    setStatusNote(t("tests.running"));
    try {
      const payload = await requestJson<TestReport>("/api/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }, { timeoutMs: 300_000 });
      setTestReport(payload);
      setTestPhase("idle");
      setStatusNote(t("tests.resultCounts", { passed: payload.passed, failed: payload.failed }));
      void loadStoredRuns();
    } catch (error) {
      setTestPhase("error");
      setStatusNote(apiErrorMessage(error, t("builder.testsFailed"), t));
    }
  }, [dirty, loadStoredRuns, serverValidated, t, testPhase]);

  const runExperiment = useCallback(async () => {
    if (!canCompare || !experimentComponent || !selectedExperimentField) return;
    let left: unknown;
    let right: unknown;
    try {
      left = parseExperimentValue(experimentA, experimentSample);
      right = parseExperimentValue(experimentB, experimentSample);
    } catch (error) {
      setExperimentPhase("error");
      setStatusNote(apiErrorMessage(error, t("compare.invalid"), t));
      return;
    }
    const controller = new AbortController();
    experimentAbortRef.current = controller;
    setActiveDock("experiments");
    setExperimentPhase("running");
    setExperimentResults([]);
    setStatusNote(t("compare.runningStatus", { target: `${experimentComponent.id}.${selectedExperimentField}` }));
    try {
      const payload = await requestJson<{ results: ExperimentResult[] }>("/api/experiments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          spec: draftToSpec(document.draft),
          input: runInput,
          variants: [
            { id: "a", label: "A", componentId: experimentComponent.id, config: { [selectedExperimentField]: left } },
            { id: "b", label: "B", componentId: experimentComponent.id, config: { [selectedExperimentField]: right } },
          ],
        }),
        signal: controller.signal,
      }, { timeoutMs: 300_000 });
      setExperimentResults(payload.results);
      setExperimentPhase(payload.results.every(({ ok }) => ok) ? "idle" : "error");
      setStatusNote(t("compare.finishedStatus", {
        completed: payload.results.filter(({ ok }) => ok).length,
        total: payload.results.length,
      }));
      void loadStoredRuns();
    } catch (error) {
      setExperimentPhase(controller.signal.aborted ? "idle" : "error");
      setStatusNote(controller.signal.aborted ? t("compare.cancelled") : apiErrorMessage(error, t("compare.failed"), t));
    } finally {
      if (experimentAbortRef.current === controller) experimentAbortRef.current = null;
    }
  }, [canCompare, document.draft, experimentA, experimentB, experimentComponent, experimentSample,
    loadStoredRuns, runInput, selectedExperimentField, t]);

  const cancelExperiment = useCallback(() => {
    experimentAbortRef.current?.abort();
  }, []);

  useEffect(() => () => {
    experimentAbortRef.current?.abort();
    liveAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    if (activeDock === "trace" && storedRunPhase === "idle" && storedRuns.length === 0) void loadStoredRuns();
  }, [activeDock, loadStoredRuns, storedRunPhase, storedRuns.length]);

  useEffect(() => {
    if (activeSubgraph && !document.draft.subgraphs[activeSubgraph]) setActiveSubgraph(undefined);
  }, [activeSubgraph, document.draft.subgraphs]);

  useEffect(() => {
    if (!paletteOpen && !pendingPlacement) return;
    const closePalette = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPaletteOpen(false);
        setPendingPlacement(undefined);
        setPlacementGhost(undefined);
      }
    };
    window.addEventListener("keydown", closePalette);
    return () => window.removeEventListener("keydown", closePalette);
  }, [paletteOpen, pendingPlacement]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      if (canSave) void save();
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [canSave, save]);

  useEffect(() => {
    if (!canAutoSave) return;
    const delay = document.historyPast.at(-1)?.touch === "layout" ? 1_200 : 850;
    const timer = setTimeout(() => void save(), delay);
    return () => clearTimeout(timer);
  }, [canAutoSave, document.historyPast, save]);

  useEffect(() => {
    const controller = saveAbortRef.current;
    if (!controller) return;
    controller.abort();
    saveAbortRef.current = undefined;
    setSavePhase("idle");
  }, [document.revision]);

  useEffect(() => () => saveAbortRef.current?.abort(), []);

  useEffect(() => {
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty && savePhase !== "error") return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [dirty, savePhase]);

  useEffect(() => {
    if (!canValidate || document.validatedSemanticRevision !== null || document.draft.nodes.length === 0) return;
    const timer = setTimeout(() => void validate(), 350);
    return () => clearTimeout(timer);
  }, [canValidate, document.draft.nodes.length, document.validatedSemanticRevision, validate]);

  const completedRun = trace.some((event) => event.type === "run-end");
  const liveOutcome = useMemo(() => {
    const terminal = trace.findLast((event) => event.type === "run-end" || event.type === "error");
    if (!terminal) return undefined;
    const data = terminal as unknown as Record<string, unknown>;
    const value = terminal.type === "run-end" ? data.output : data.message;
    return {
      ok: terminal.type === "run-end",
      text: typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value, null, 2),
    };
  }, [trace]);
  const templateReady = viewDraft.nodes.length > 0;
  const requiredConnectionKinds = selectedTemplateId
    ? studioCatalog.templates.find((template) => template.id === selectedTemplateId)?.connectionKinds ?? []
    : [];
  const draftComponents = [
    ...document.draft.nodes,
    ...Object.values(document.draft.subgraphs).flatMap((graph) => graph.nodes),
  ].map((node) => node.data.component);
  const configuredConnection = missingConnectionSetup(draftComponents, connections, studioCatalog.tools);
  const requiredConnectionKind = requiredConnectionKinds.find((kind) => !connections.some((connection) =>
    connection.kind === kind && connectionCanRun(connection)));
  const nextConnectionSetup = configuredConnection
    ?? (requiredConnectionKind ? { kind: requiredConnectionKind } : undefined);
  const connectionReady = !nextConnectionSetup;
  const savedTests = (document.draft.root.tests as HarnessTestCase[] | undefined) ?? [];
  const tested = completedRun || testReport?.ok === true || storedRuns.some((run) => run.status === "completed" || run.status === "success");
  const readiness = buildReadiness({
    dirty,
    saving: savePhase === "saving",
    saveError: savePhase === "error",
    connectionsLoaded,
    missingConnections: nextConnectionSetup ? 1 : 0,
    checkingValidation: document.validationPhase === "checking",
    validated: serverValidated,
    validationErrors: errorDiagnostics.length,
    tested,
  });
  const setupComplete = readiness.at(-1)?.status === "complete";
  const setupSteps: readonly SetupJourneyStep[] = [
    {
      id: "template",
      title: t("setup.template"),
      description: t("setup.template.description"),
      complete: templateReady,
      action: <JourneyAction onClick={() => { setPaletteKind("templates"); setPaletteOpen(true); }}>{t("setup.browseRecipes")}</JourneyAction>,
    },
    {
      id: "connections",
      title: t("setup.connections"),
      description: t("setup.connections.description"),
      complete: templateReady && connectionReady,
      action: <JourneyAction onClick={() => openConnections(nextConnectionSetup?.kind, undefined, "id" in (nextConnectionSetup ?? {}) ? (nextConnectionSetup as { id: string }).id : undefined)}>{t("setup.openServices")}</JourneyAction>,
    },
    {
      id: "validate",
      title: t("setup.validate"),
      description: t("setup.validate.description"),
      complete: serverValidated && errorDiagnostics.length === 0,
      action: <JourneyAction onClick={() => setActiveDock("problems")}>{t("setup.openIssues")}</JourneyAction>,
    },
    {
      id: "run",
      title: t("setup.run"),
      description: t("setup.run.description"),
      complete: tested,
      action: <JourneyAction onClick={() => navigate("playground")}>{t("setup.openTest")}</JourneyAction>,
    },
  ];
  const replaceTests = (tests: HarnessTestCase[]) => {
    const root = { ...document.draft.root };
    if (tests.length) root.tests = tests;
    else delete root.tests;
    setTestReport(undefined);
    dispatch({ type: "replace-draft", draft: { ...document.draft, root }, touch: "semantic" });
  };
  const updateTest = (index: number, update: (test: HarnessTestCase) => HarnessTestCase) => {
    replaceTests(savedTests.map((test, testIndex) => testIndex === index ? update(test) : test));
  };
  const addTest = () => {
    const id = uniqueComponentId("case", new Set(savedTests.map((test) => test.id)));
    const test = {
      id,
      input: runInput.trim() || "Hello",
      ...(document.draft.root.version === "0.1"
        ? { assertion: { type: "includes" as const, value: "expected text" } }
        : { assertions: [{ type: "includes" as const, value: "expected text" }] }),
    } as HarnessTestCase;
    replaceTests([...savedTests, test]);
    setActiveDock("tests");
  };
  const removeTest = (index: number) => {
    const id = savedTests[index]?.id ?? String(index + 1);
    setConfirmation({
      title: t("confirm.test.title"),
      description: `${id} · ${t("confirm.test.description")}`,
      confirmLabel: t("confirm.test.action"),
      onConfirm: () => replaceTests(savedTests.filter((_, testIndex) => testIndex !== index)),
    });
  };
  const statusClass = experimentPhase === "error" || savePhase === "error"
    || displayedDiagnostics.some((item) => item.severity === "error")
    ? "is-fault"
    : running || document.validationPhase === "checking"
      ? "is-signal"
      : serverValidated
        ? "is-pass"
        : "";

  const dockTools = activeDock === "yaml" && (
    <div className="dock-tools">
      <label className="button file-button">
        {t("common.import")}
        <input type="file" accept=".yaml,.yml,text/yaml" disabled={running} onChange={(event) => void importYaml(event.target.files?.[0])} />
      </label>
      <button className="button" onClick={exportYaml}>{t("common.export")}</button>
      {document.yamlState !== "synced" && <button className="button" onClick={() => dispatch({ type: "discard-yaml" })}>{t("common.discard")}</button>}
      <button className="button button-primary" disabled={!document.pendingSpec || running} onClick={() => dispatch({ type: "apply-yaml" })}>{t("common.apply")} YAML</button>
    </div>
  );
  const dockTabs: DockTab[] = ["problems", "tests", "experiments", "trace", "project", "yaml"];
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

  const managerDialogs = <>
    {connectionManagerOpen && <ConnectionManager
      open
      connections={connections}
      definitions={studioCatalog.connectionTypes.length ? studioCatalog.connectionTypes : CONNECTION_TYPE_CATALOG}
      requestedKind={requestedConnectionKind}
      requestedId={requestedConnectionId}
      onClose={() => { setConnectionManagerOpen(false); setRequestedConnectionKind(undefined); setRequestedConnectionId(undefined); setConnectionTargetNodeId(undefined); }}
      onChanged={(next) => {
        setConnections(next);
        void refreshStudioCatalog().catch(() => setStatusNote(t("builder.catalogRefresh.connection")));
      }}
      onComplete={completeConnection}
    />}
    {customToolOpen && <CustomToolManager
      open
      connections={connections}
      onClose={() => setCustomToolOpen(false)}
      onChanged={() => refreshStudioCatalog().catch(() => setStatusNote(t("builder.catalogRefresh.tool")))}
    />}
    {skillManagerOpen && <SkillManager
      open
      onClose={() => setSkillManagerOpen(false)}
      onChanged={() => refreshStudioCatalog().catch(() => setStatusNote(t("builder.catalogRefresh.skill")))}
    />}
  </>;

  return (
    <main className={`studio-shell ${paletteOpen ? "is-palette-open" : ""} ${dockOpen ? "is-dock-open" : ""} ${dockOpen && activeDock === "problems" && document.diagnostics.length <= 2 ? "is-dock-compact" : ""} ${surface === "playground" ? "is-playground" : surface === "runs" ? "is-runs" : surface === "integrate" ? "is-integrate" : surface === "settings" ? "is-settings" : welcome ? "is-welcome" : ""}`}>
      <header className="command-rail">
        <div className="brand-lockup">
          <span className="brand-name">{t("app.name")}</span>
          <span className="project-name" title={initial.file}>{initial.file.split(/[\\/]/).pop()}</span>
          {dirty && <span className="dirty-dot" title={t("save.unsaved")} />}
        </div>
        <nav className="surface-tabs" aria-label={t("builder.workspace")}>
          <Link href={STUDIO_SURFACE_HREFS.builder} className={surface === "builder" ? "is-active" : ""} aria-current={surface === "builder" ? "page" : undefined}>{t("nav.builder")}</Link>
          <Link href={STUDIO_SURFACE_HREFS.playground} className={surface === "playground" ? "is-active" : ""} aria-current={surface === "playground" ? "page" : undefined}>{t("nav.playground")}</Link>
          <Link href={STUDIO_SURFACE_HREFS.runs} className={surface === "runs" ? "is-active" : ""} aria-current={surface === "runs" ? "page" : undefined}>{t("nav.runs")}</Link>
          <Link href={STUDIO_SURFACE_HREFS.integrate} className={surface === "integrate" ? "is-active" : ""} aria-current={surface === "integrate" ? "page" : undefined}>{t("nav.integrate")}</Link>
        </nav>
        {surface === "playground" ? <div className="playground-rail-context"><span>{t("playground.immutableRuntime")}</span><strong>{serverValidated ? t("common.ready") : t("common.needsAttention")}</strong></div> : surface === "runs" ? <div className="playground-rail-context"><span>{t("runs.eyebrow")}</span><strong>{storedRuns.length} {t("nav.runs").toLocaleLowerCase(locale)}</strong></div> : surface === "integrate" ? <div className="playground-rail-context"><span>{t("integrate.contract")}</span><strong>{t("integrate.surfaces", { count: integrationContract.integrationSurfaces.length })}</strong></div> : welcome ? <div className="welcome-context"><span>{t("setup.eyebrow")}</span><strong>{t("setup.template")}</strong></div> : <>
          <ReadinessTrail steps={readiness} />
          <div className="rail-actions">
            {running ? (
              <button className="button button-danger" onClick={cancelExperiment}>{t("compare.cancel")}</button>
            ) : nextConnectionSetup ? (
              <button className="button button-primary" onClick={() => openConnections(
                nextConnectionSetup.kind,
                undefined,
                "id" in nextConnectionSetup ? nextConnectionSetup.id : undefined,
              )}>{t("common.connect")} {connectionLabel(t, nextConnectionSetup.kind)}</button>
            ) : errorDiagnostics.length ? (
              <button className="button button-primary" onClick={() => setActiveDock("problems")}>{t("builder.setupReview", { count: errorDiagnostics.length })}</button>
            ) : savePhase === "error" ? (
              <button className="button button-danger" onClick={() => void save()}>{t("save.retry")}</button>
            ) : dirty || savePhase === "saving" ? (
              <button className="button button-rail" disabled>{savePhase === "saving" ? t("save.saving") : t("save.queued")}</button>
            ) : document.validationPhase === "checking" || document.validatedSemanticRevision === null ? (
              <button className="button button-rail" disabled>{t("save.validating")}</button>
            ) : serverValidated ? (
              <button className="button button-primary" onClick={() => navigate("playground")}>{t("nav.openPlayground")}</button>
            ) : <button className="button button-rail" disabled>{t("common.preparing")}</button>}
          </div>
        </>}
        <Link className={`settings-trigger ${surface === "settings" ? "is-active" : ""}`} href={`${STUDIO_SURFACE_HREFS.settings}?section=general`} aria-label={t("nav.settings")} title={t("nav.settings")} aria-haspopup="dialog" aria-current={surface === "settings" ? "page" : undefined}>
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 8.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2Zm8 3.6-.1-1.3 1.8-1.4-2-3.4-2.2.9a8 8 0 0 0-2.2-1.3L15 3.1h-4l-.3 2.4a8 8 0 0 0-2.2 1.3l-2.2-.9-2 3.4 1.8 1.4L6 12l.1 1.3-1.8 1.4 2 3.4 2.2-.9a8 8 0 0 0 2.2 1.3l.3 2.4h4l.3-2.4a8 8 0 0 0 2.2-1.3l2.2.9 2-3.4-1.8-1.4L20 12Z" /></svg>
        </Link>
      </header>

      {surface === "playground" ? <Playground onOpenBuilder={() => navigate("builder")} /> : surface === "runs" ? <RunsWorkspace runs={storedRuns} phase={storedRunPhase} selectedRunId={runId} events={trace} onRefresh={() => void loadStoredRuns()} onInspect={(run) => void inspectStoredRun(run)} onShowComponent={showTraceComponent} onOpenPlayground={() => navigate("playground")} /> : surface === "integrate" ? <IntegrationWorkspace contract={integrationContract} diagnostics={document.diagnostics} connections={connections} connectionsLoaded={connectionsLoaded} verified={!dirty && serverValidated} file={initial.file} onOpenBuilder={() => navigate("builder")} onOpenConnections={() => openConnections()} /> : welcome ? (
        <section className="welcome-launchpad" aria-labelledby="welcome-title">
          <div className="welcome-intro">
            <span className="sheet-eyebrow">{t("welcome.eyebrow")}</span>
            <h1 id="welcome-title">{t("welcome.title")}</h1>
            <p>{t("welcome.description")}</p>
            <div className="welcome-steps" aria-label={t("builder.welcome.next")}>
              <span><strong>1</strong> {t("welcome.step.recipe")}</span>
              <span><strong>2</strong> {t("welcome.step.services")}</span>
              <span><strong>3</strong> {t("welcome.step.request")}</span>
            </div>
          </div>
          <div className="recipe-grid">
            {studioCatalog.templates.map((template) => (
              <button className="recipe-card" key={template.id} onClick={() => applyTemplate(template)}>
                <span className="recipe-meta"><span>{categoryLabel(t, template.category)}</span><span>{t("welcome.minutes", { count: Math.max(2, (template.connectionKinds?.length ?? 0) * 2) })}</span></span>
                <strong>{template.label}</strong>
                <span className="recipe-outcome">{template.description}</span>
                <span className="recipe-needs"><small>{t("welcome.needs")}</small>{template.connectionKinds?.map((kind) => connectionLabel(t, kind)).join(" + ") || t("common.none")}</span>
                <span className="recipe-sample"><small>{t("welcome.try")}</small>“{template.sampleInput}”</span>
                <span className="recipe-action">{t("welcome.useRecipe")} →</span>
              </button>
            ))}
          </div>
          <div className="welcome-alternatives">
            <span>{t("welcome.existing")}</span>
            <label className="button file-button">{t("welcome.openYaml")}<input type="file" accept=".yaml,.yml,text/yaml" onChange={(event) => void openYaml(event.target.files?.[0])} /></label>
            <button className="button" onClick={() => { setWelcomeDismissed(true); setPaletteKind("components"); setPaletteOpen(true); }}>{t("welcome.blank")}</button>
          </div>
        </section>
      ) : <>
      {paletteOpen && <aside className="palette-panel" aria-label={t("builder.catalog.title")}>
        <div className="panel-heading"><h2>{t("builder.catalog.title")}</h2><span><span className="panel-count">{visiblePalette.length}/{paletteItems.length}</span><button className="panel-close" type="button" aria-label={t("builder.catalog.close")} onClick={() => setPaletteOpen(false)}>×</button></span></div>
        <div className="palette-tabs" role="tablist" aria-label={t("builder.catalog.aria")}>
          {PALETTE_KINDS.map((kind) => <button
            key={kind}
            role="tab"
            aria-selected={paletteKind === kind}
            className={`palette-tab ${paletteKind === kind ? "is-active" : ""}`}
            onClick={() => { setPaletteKind(kind); setPaletteCategory("all"); setPaletteQuery(""); }}
          >{t(PALETTE_LABEL_KEYS[kind])}</button>)}
        </div>
        {(paletteKind === "tools" || paletteKind === "skills") && <div className="palette-create"><button className="button" onClick={() => paletteKind === "tools" ? setCustomToolOpen(true) : setSkillManagerOpen(true)}>{t(paletteKind === "tools" ? "builder.catalog.newTool" : "builder.catalog.manageSkills")}</button></div>}
        <div className="palette-filters">
          <label className="sr-only" htmlFor="palette-search">{t("builder.catalog.search")}</label>
          <input id="palette-search" type="search" placeholder={t("builder.catalog.search")} value={paletteQuery} onChange={(event) => setPaletteQuery(event.target.value)} />
          <label className="sr-only" htmlFor="palette-category">{t("builder.catalog.category")}</label>
          <select id="palette-category" value={paletteCategory} onChange={(event) => setPaletteCategory(event.target.value)}>
            <option value="all">{t("builder.catalog.all")}</option>
            {categories.map((category) => <option key={category} value={category}>{categoryLabel(t, category)}</option>)}
          </select>
        </div>
        <p className="palette-copy">{t(paletteKind === "components" ? "builder.catalog.dragHelp" : "builder.catalog.personalHelp")}</p>
        <div className="palette-list">
          {visiblePalette.length ? visiblePalette.map((item) => (
            <div className="palette-item-row" key={item.key}>
              <button
                className="palette-item"
                style={{ "--port-color": colorFor(item.category) } as CSSProperties}
                disabled={!item.available || (item.kind === "components" && graphLocked)}
                onClick={() => {
                  if (performance.now() < suppressPaletteClickUntil.current) return;
                  activatePaletteItem(item);
                }}
                onPointerDown={(event) => beginPointerPlacement(item, event)}
              >
                <span className="palette-glyph" aria-hidden="true">{glyphFor(item.label)}</span>
                <span><span className="palette-title">{item.label}</span><span className="palette-description">{categoryLabel(t, item.category)} · {item.description}</span></span>
                <span className="drag-grip" aria-hidden="true">{item.available ? item.kind === "components" ? "⠿" : "＋" : "—"}</span>
              </button>
              <button className={`palette-favorite ${favorites.has(item.key) ? "is-active" : ""}`} aria-label={t(favorites.has(item.key) ? "builder.catalog.favoriteRemove" : "builder.catalog.favoriteAdd", { name: item.label })} aria-pressed={favorites.has(item.key)} onClick={() => toggleFavorite(item.key)}>★</button>
            </div>
          )) : <div className="palette-empty">{t("builder.catalog.empty")}{paletteKind === "connections" && <button className="button button-primary" onClick={() => openConnections()}>{t("connections.add")}</button>}</div>}
        </div>
      </aside>}
      {placementGhost && <div className="canvas-drag-ghost" style={{ left: placementGhost.x, top: placementGhost.y }} aria-hidden="true">＋ {placementGhost.label}</div>}

      <section
        ref={canvasRef}
        className={`canvas-panel ${pendingPlacement ? "is-placing" : ""} ${layouting ? "is-auto-layouting" : ""}`}
        aria-label={t("builder.canvas")}
      >
        {!setupDismissed && !setupComplete && <SetupJourney steps={setupSteps} onDismiss={() => setSetupDismissed(true)} />}
        <div className="canvas-toolbar">
          <button className="catalog-toggle" type="button" aria-expanded={paletteOpen} onClick={() => setPaletteOpen((current) => !current)}>＋ {t("builder.add")}</button>
          <span className="canvas-mode" role="group" aria-label={t("builder.canvas.mode")}>
            <button type="button" className={canvasMode === "design" ? "is-active" : ""} aria-pressed={canvasMode === "design"} onClick={() => setCanvasMode("design")}>{t("builder.canvas.design")}</button>
            <button type="button" className={canvasMode === "live" ? "is-active" : ""} aria-pressed={canvasMode === "live"} onClick={() => setCanvasMode("live")}>{t("builder.canvas.live")}</button>
          </span>
          {canvasMode === "design" && <>
          <button className={`graph-crumb ${activeSubgraph ? "" : "is-active"}`} disabled={!activeSubgraph} onClick={() => setActiveSubgraph(undefined)}>{t("builder.root")}</button>
          {activeSubgraph && <><span aria-hidden="true">›</span><span className="graph-crumb is-active">{activeSubgraph}</span></>}
          {Object.keys(document.draft.subgraphs).length > 0 && (
            <select aria-label={t("builder.openGraph")} value={activeSubgraph ?? ""} onChange={(event) => setActiveSubgraph(event.target.value || undefined)}>
              <option value="">{t("builder.rootGraph")}</option>
              {Object.keys(document.draft.subgraphs).map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          )}
          <span className="canvas-history" role="group" aria-label={t("builder.history")}>
            <button type="button" disabled={!canUndo} aria-label={t("builder.undo")} title={`${t("builder.undo")} (Ctrl/⌘ Z)`} onClick={() => { dispatch({ type: "undo" }); setStatusNote(t("builder.undoDone")); }}>↶</button>
            <button type="button" disabled={!canRedo} aria-label={t("builder.redo")} title={`${t("builder.redo")} (Ctrl/⌘ Shift Z)`} onClick={() => { dispatch({ type: "redo" }); setStatusNote(t("builder.redoDone")); }}>↷</button>
          </span>
          <span className="canvas-layout-tools" role="group" aria-label={t("builder.layout.aria")}>
            <button type="button" disabled={graphLocked || viewDraft.nodes.length < 2} onClick={() => void autoLayout()}>{t("builder.layout.action")}</button>
          </span>
          <VersionHistory
            currentYaml={document.yamlState === "synced" ? document.yamlText : stringifySpec(draftToSpec(document.draft))}
            onRestored={(spec, yaml) => {
              saveAbortRef.current?.abort();
              lastSavedYamlRef.current = yaml;
              dispatch({ type: "load-saved", spec, yaml });
              setActiveSubgraph(undefined);
              setLastSavedAt(Date.now());
              setSavePhase("idle");
              setStatusNote(t("versions.restore"));
            }}
          />
          </>}
          <span className="utility-label">{canvasMode === "live"
            ? t("builder.live.summary", { agents: liveSnapshot?.agents.length ?? 0, tasks: liveSnapshot?.tasks.length ?? 0 })
            : t("builder.graphSummary", { components: viewDraft.nodes.length, connections: viewDraft.edges.length })}</span>
        </div>
        {canvasMode === "design" && viewDraft.nodes.length === 0 && <div className="commissioning-onboarding"><span className="sheet-eyebrow">{t("builder.blank.eyebrow")}</span><strong>{t("builder.blank.title")}</strong><span>{t("builder.blank.description")}</span><button className="onboarding-blank" onClick={() => { setPaletteKind("templates"); setPaletteOpen(true); }}>{t("setup.browseRecipes")}</button></div>}
        {canvasMode === "live" && canvasNodes.length === 0 && <div className="commissioning-onboarding"><span className="sheet-eyebrow">{t("builder.canvas.live")}</span><strong>{t("builder.live.empty")}</strong><span>{t("builder.live.emptyDescription")}</span></div>}
        <ReactFlow<HarnessNode, HarnessEdge>
          defaultNodes={canvasNodes}
          defaultEdges={canvasEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          defaultEdgeOptions={defaultEdgeOptions}
          onNodesChange={onNodesChange}
          onNodeDragStop={onNodeDragStop}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          isValidConnection={isValidConnection}
          onPaneClick={(event) => {
            if (canvasMode === "live") return;
            if (pendingPlacement) {
              placeComponent(pendingPlacement.type, event.clientX, event.clientY);
              setPendingPlacement(undefined);
              return;
            }
            const nodes = viewDraft.nodes.map((node) => ({ ...node, selected: false }));
            const edges = viewDraft.edges.map((edge) => ({ ...edge, selected: false }));
            replaceViewDraft({ ...viewDraft, nodes, edges }, "none");
          }}
          nodesDraggable={canvasMode === "design" && !graphLocked}
          nodesConnectable={canvasMode === "design" && !graphLocked}
          edgesReconnectable={false}
          deleteKeyCode={graphLocked ? null : ["Backspace", "Delete"]}
          snapToGrid={false}
          onMoveEnd={(_event, viewport) => {
            if (canvasMode !== "design" || viewDraft.root.version !== "0.3") return;
            const previous = viewDraft.layout?.viewport;
            if (previous && previous.x === viewport.x && previous.y === viewport.y && previous.zoom === viewport.zoom) return;
            replaceViewDraft({ ...viewDraft, layout: { ...viewDraft.layout, viewport } }, "layout");
          }}
          fitView={!viewDraft.layout?.viewport}
          defaultViewport={viewDraft.layout?.viewport}
          fitViewOptions={{ padding: 0.25 }}
          minZoom={0.25}
          maxZoom={1.8}
          panOnScroll
          selectionOnDrag
          onlyRenderVisibleElements
          nodesFocusable
          edgesFocusable
          autoPanOnNodeFocus
          ariaLabelConfig={{
            "controls.ariaLabel": t("builder.canvas.controls"),
            "minimap.ariaLabel": t("builder.canvas.overview"),
            "handle.ariaLabel": t("builder.canvas.port"),
          }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--canvas-grid)" />
          <Controls position="bottom-left" showInteractive={false} />
          <MiniMap position="bottom-right" pannable zoomable nodeColor={(node) => colorFor((node.data as HarnessNode["data"]).manifest.category)} maskColor="var(--minimap-mask)" />
        </ReactFlow>
      </section>

      <aside className="inspector-panel" aria-label={t("builder.inspector.aria")}>
        {canvasMode === "live" ? <>
          <div className="panel-heading"><h2>{t("builder.live.activity")}</h2><span className={`panel-count is-${liveRunPhase}`}>{liveSnapshot?.status ?? liveRunPhase}</span></div>
          <div className="live-activity" aria-live="polite">
            <section>
              <label htmlFor="live-run-input">{t("builder.live.request")}</label>
              <textarea id="live-run-input" value={liveInput} disabled={liveRunPhase === "starting" || liveRunPhase === "running"} placeholder={t("builder.live.requestPlaceholder")} onChange={(event) => setLiveInput(event.target.value)} />
              <div className="live-actions">
                <button className="button button-primary" disabled={!canRun || !liveInput.trim() || liveRunPhase === "starting" || liveRunPhase === "running"} onClick={() => void startLiveRun()}>{liveRunPhase === "starting" ? t("common.preparing") : t("builder.live.start")}</button>
                <button className="button button-danger" disabled={liveRunPhase !== "running"} onClick={() => void stopLiveRun()}>{t("builder.live.stop")}</button>
              </div>
            </section>
            {runId && <section className="live-run-identity"><span>{t("builder.live.runId")}</span><code>{runId}</code></section>}
            {liveOutcome && <section className={`live-result ${liveOutcome.ok ? "is-success" : "is-error"}`}>
              <h3>{t(liveOutcome.ok ? "builder.live.finalResult" : "builder.live.failureResult")}</h3>
              <pre>{liveOutcome.text || t("builder.live.emptyResult")}</pre>
            </section>}
            {liveSnapshot && <>
              <section className="live-metrics">
                <span><strong>{liveSnapshot.agents.length}</strong>{t("builder.live.agents")}</span>
                <span><strong>{liveSnapshot.tasks.length}</strong>{t("builder.live.tasks")}</span>
                <span><strong>{liveSnapshot.revision}</strong>{t("builder.live.revision")}</span>
              </section>
              <section>
                <label htmlFor="live-target">{t("builder.live.target")}</label>
                <select id="live-target" value={liveTarget} onChange={(event) => setLiveTarget(event.target.value)}>
                  <option value="run">{t("builder.live.everyone")}</option>
                  {[...new Set(liveSnapshot.agents.map((agent) => agent.teamId))].map((team) => <option key={`team:${team}`} value={`team:${team}`}>{t("builder.live.team")} · {team}</option>)}
                  {liveSnapshot.tasks.map((task) => <option key={`task:${task.id}`} value={`task:${task.id}`}>{t("builder.live.task")} · {task.id}</option>)}
                  {liveSnapshot.agents.map((agent) => <option key={`agent:${agent.id}`} value={`agent:${agent.id}`}>{t("builder.live.agent")} · {agent.template}</option>)}
                </select>
                <textarea value={liveInstruction} disabled={liveRunPhase !== "running"} placeholder={t("builder.live.instructionPlaceholder")} onChange={(event) => setLiveInstruction(event.target.value)} />
                <button className="button" disabled={liveRunPhase !== "running" || !liveInstruction.trim()} onClick={() => void sendLiveInstruction()}>{t("builder.live.send")}</button>
              </section>
              <section className="live-feed"><h3>{t("builder.live.feed")}</h3>
                {liveSnapshot.messages.slice(-12).toReversed().map((message) => <article key={message.id}><span>{message.from} → {message.to.kind}{message.to.id ? `:${message.to.id}` : ""}</span><p>{message.content}</p></article>)}
                {!liveSnapshot.messages.length && <p>{t("builder.live.noMessages")}</p>}
              </section>
            </>}
          </div>
        </> : <>
          <div className="panel-heading"><h2>{t("builder.inspector")}</h2><span className="panel-count">{selectedEdge ? t("builder.inspector.connection") : selectedNode?.data.component.type ?? t("builder.inspector.none")}</span></div>
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
          specVersion={document.draft.root.version}
          projectGraph={activeSubgraph}
          projectLocked={dirty || running}
          onProjectChanged={reloadProject}
          focusPath={diagnosticFocus && diagnosticFocus.componentId === selectedNode?.id ? diagnosticFocus.path : undefined}
          focusVersion={diagnosticFocus?.version}
          onOpenConnections={(kind) => openConnections(kind, selectedNode?.id)}
          onOpenSubgraph={(name) => {
            if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) {
              setStatusNote(t("builder.subgraphInvalid"));
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
              setStatusNote(t("builder.subgraphCreated", { name }));
            }
            setActiveSubgraph(name);
          }}
          />
        </>}
      </aside>

      <section className={`bottom-dock ${dockOpen ? "" : "is-collapsed"}`} aria-label={t("builder.dock.aria")}>
        <div className="dock-heading">
          <div className="dock-tabs" role="tablist" aria-label={t("builder.dock.label")}>
            {dockTabs.map((tab) => (
              <button
                key={tab}
                id={`dock-tab-${tab}`}
                role="tab"
                aria-controls={`dock-panel-${tab}`}
                aria-selected={activeDock === tab}
                aria-expanded={activeDock === tab ? dockOpen : undefined}
                tabIndex={activeDock === tab ? 0 : -1}
                className={`dock-tab ${activeDock === tab ? "is-active" : ""}`}
                onClick={() => setActiveDock(tab)}
                onKeyDown={(event) => moveDockFocus(event, tab)}
              >
                {t(DOCK_LABEL_KEYS[tab])}{tab === "problems" && displayedDiagnostics.length > 0 && <span className="tab-badge">{displayedDiagnostics.length}</span>}
              </button>
            ))}
          </div>
          {dockOpen && dockTools}
          <button className="dock-toggle" type="button" aria-label={dockOpen ? t("builder.dock.collapse") : t("builder.dock.expand")} aria-expanded={dockOpen} onClick={() => setDockOpen((current) => !current)}>{dockOpen ? "⌄" : "⌃"}</button>
        </div>
        <div id={`dock-panel-${activeDock}`} role="tabpanel" aria-labelledby={`dock-tab-${activeDock}`} className="dock-content" tabIndex={0}>
          {activeDock === "yaml" && (
            <div className="yaml-pane">
              <textarea className={`yaml-editor ${document.yamlState === "invalid" ? "is-invalid" : ""}`} aria-label="harnest.yaml" spellCheck={false} value={document.yamlText} disabled={running} onChange={(event) => editYaml(event.target.value)} />
              <div className={`yaml-message ${document.yamlState === "invalid" ? "is-error" : ""}`}>
                <strong>{document.yamlState === "synced" ? t("builder.yaml.synced") : document.yamlState === "pending" ? t("builder.yaml.pending") : t("builder.yaml.invalid")}</strong>
                {document.yamlState === "synced" ? t("builder.yaml.syncedHelp") : document.yamlDiagnostics[0]?.message ?? t("builder.yaml.pendingHelp")}
              </div>
            </div>
          )}
          {activeDock === "project" && <ProjectFiles locked={dirty || running} onChanged={reloadProject} />}
          {activeDock === "problems" && (displayedDiagnostics.length ? (
            <ul className="diagnostic-list">
              {displayedDiagnostics.map((diagnostic, index) => {
                const recovery = diagnosticRecoveryAction(diagnostic);
                return <li key={`${diagnostic.code}:${diagnostic.path}:${index}`} className="diagnostic-row">
                  <button className="diagnostic-item" onClick={() => selectDiagnostic(diagnostic)}>
                    <span className="diagnostic-code">{diagnostic.code}</span>
                    <span className="diagnostic-message">{diagnostic.message}{diagnostic.hint ? ` — ${diagnostic.hint}` : ""}</span>
                    <span className="diagnostic-path">{diagnostic.path}</span>
                    <span className="diagnostic-open">{t("diagnostics.openField")} →</span>
                  </button>
                  {recovery === "connect-service" && nextConnectionSetup && <button className="diagnostic-fix" onClick={() => openConnections(nextConnectionSetup.kind, diagnostic.componentId, "id" in nextConnectionSetup ? nextConnectionSetup.id : undefined)}>{t("diagnostics.fixConnection")}</button>}
                  {recovery === "open-runtime-settings" && <button className="diagnostic-fix" onClick={() => router.push(`${STUDIO_SURFACE_HREFS.settings}?section=runtime`)}>{t("nav.settings")}</button>}
                </li>;
              })}
            </ul>
          ) : <div className="empty-dock">{t("diagnostics.empty")}</div>)}
          {activeDock === "tests" && (
            <div className="tests-pane">
              <div className="tests-toolbar">
                <div><strong>{t("tests.title")}</strong><span>{t("tests.saved", { count: savedTests.length })}</span></div>
                <div className="tests-actions">
                  <button className="button" disabled={running || document.yamlState !== "synced"} onClick={addTest}>{t("tests.add")}</button>
                  <button className="button button-primary" disabled={!savedTests.length || dirty || !serverValidated || testPhase === "running"} onClick={() => void runTests()}>{testPhase === "running" ? t("tests.running") : t("tests.runAll")}</button>
                </div>
              </div>
              <div className="tests-workspace">
                <section className="test-case-list" aria-label={t("tests.aria")}>
                  {savedTests.length ? savedTests.map((test, index) => {
                    const assertions = testAssertions(test);
                    return <article className="test-case-editor" key={`${index}:${test.id}`}>
                      <div className="test-case-heading">
                        <label><span>{t("tests.caseId")}</span><input value={test.id} maxLength={64} disabled={running} onChange={(event) => updateTest(index, (current) => ({ ...current, id: event.target.value }))} /></label>
                        <button className="button" disabled={running} title={`${t("common.remove")} ${test.id}`} onClick={() => removeTest(index)}>{t("common.remove")}</button>
                      </div>
                      {typeof test.input === "string" ? <>
                        <label className="test-case-field"><span>{t("tests.request")}</span><textarea value={test.input} disabled={running} onChange={(event) => updateTest(index, (current) => ({ ...current, input: event.target.value }))} /></label>
                        {document.draft.root.version !== "0.1" && <button className="button" type="button" disabled={running} onClick={() => updateTest(index, (current) => ({ ...current, input: {} }))}>{t("tests.useJsonInput")}</button>}
                      </> : <>
                        <TestJsonEditor label={t("tests.structuredRequest")} value={test.input} disabled={running} onChange={(input) => updateTest(index, (current) => ({ ...current, input }))} />
                        <button className="button" type="button" disabled={running} onClick={() => updateTest(index, (current) => ({ ...current, input: JSON.stringify(current.input, null, 2) }))}>{t("tests.useTextInput")}</button>
                      </>}
                      {document.draft.root.version !== "0.1" && <button className="button" type="button" disabled={running} onClick={() => updateTest(index, (current) => replaceTestAssertions(current, [...testAssertions(current), assertionForType("includes")], "0.2"))}>{t("tests.addCheck")}</button>}
                      {assertions.map((assertion, assertionIndex) => <TestAssertionEditor key={`${assertionIndex}:${assertion.type}`} assertion={assertion} disabled={running} advanced={document.draft.root.version !== "0.1"} removable={document.draft.root.version !== "0.1" && assertions.length > 1} onChange={(next) => updateTest(index, (current) => replaceTestAssertions(current, testAssertions(current).map((candidate, candidateIndex) => candidateIndex === assertionIndex ? next : candidate), document.draft.root.version))} onRemove={() => updateTest(index, (current) => replaceTestAssertions(current, testAssertions(current).filter((_, candidateIndex) => candidateIndex !== assertionIndex), "0.2"))} />)}
                    </article>;
                  }) : <div className="empty-dock"><span>{t("tests.empty")}</span><button className="button button-primary" onClick={addTest}>{t("tests.addFirst")}</button></div>}
                </section>
                {testReport ? (
                  <div className="test-report">
                    <div className={`test-summary ${testReport.ok ? "is-pass" : "is-fault"}`}><strong>{t("tests.result", { percent: Math.round((testReport.passed / Math.max(1, testReport.passed + testReport.failed)) * 100) })}</strong><span>{t("tests.resultCounts", { passed: testReport.passed, failed: testReport.failed })}</span></div>
                    <ul className="test-list">
                      {testReport.cases.map((test) => (
                        <li key={test.id} className="test-item">
                          <span className={`test-state ${test.ok ? "is-pass" : "is-fault"}`}>{test.ok ? t("tests.pass") : t("tests.fail")}</span>
                          <span><strong>{test.id}</strong>{test.error && <small>{test.error}</small>}{test.assertions && <small>{JSON.stringify(test.assertions)}</small>}</span>
                          <span className="trace-meta">{Math.round(test.durationMs)}ms</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : <div className="empty-dock">{t(savedTests.length ? "tests.waitingToRun" : "tests.emptyHelp")}</div>}
              </div>
            </div>
          )}
          {activeDock === "experiments" && (
            <div className="experiment-pane">
              <div className="experiment-config">
                <div><span className="sheet-eyebrow">{t("compare.eyebrow")}</span><strong>{t("compare.title")}</strong><small>{t("compare.description")}</small></div>
                <label className="field-label" htmlFor="experiment-component">{t("compare.component")}</label>
                <select id="experiment-component" value={experimentComponent?.id ?? ""} disabled={experimentRunning} onChange={(event) => { setExperimentComponentId(event.target.value); setExperimentField(""); }}>
                  {experimentComponents.map((component) => <option key={component.id} value={component.id}>{component.id} · {component.type}</option>)}
                </select>
                <label className="field-label" htmlFor="experiment-field">{t("compare.setting")}</label>
                <select id="experiment-field" value={selectedExperimentField} disabled={experimentRunning} onChange={(event) => setExperimentField(event.target.value)}>
                  {experimentFields.map((field) => <option key={field} value={field}>{field}</option>)}
                </select>
                <div className="experiment-values">
                  <label><span>{t("compare.variantA")}</span><textarea value={experimentA} disabled={experimentRunning} onChange={(event) => setExperimentA(event.target.value)} /></label>
                  <label><span>{t("compare.variantB")}</span><textarea value={experimentB} disabled={experimentRunning} onChange={(event) => setExperimentB(event.target.value)} /></label>
                </div>
                <label className="field-label" htmlFor="experiment-input">{t("compare.sameInput")}</label>
                <textarea id="experiment-input" className="run-input" value={runInput} disabled={experimentRunning} placeholder={t("compare.placeholder")} onChange={(event) => setRunInput(event.target.value)} />
                {experimentRunning
                  ? <button className="button button-danger" onClick={cancelExperiment}>{t("compare.cancel")}</button>
                  : <button className="button button-primary" disabled={!canCompare} onClick={() => void runExperiment()}>{t("compare.run")}</button>}
                {!canCompare && !experimentRunning && <small className="run-guidance">{t("compare.blocked")}</small>}
              </div>
              <div className="experiment-results" aria-live="polite">
                {experimentResults.length ? experimentResults.map((result) => {
                  const tokens = result.usage?.totalTokens
                    ?? (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0);
                  return <article className={`experiment-result ${result.ok ? "is-pass" : "is-fault"}`} key={result.id}>
                    <header><span>{result.label}</span><strong>{result.ok ? `${Math.round(result.durationMs ?? 0)}ms` : t("common.needsAttention")}</strong></header>
                    <pre>{result.ok ? formatOutput(result.output) : result.error ?? result.diagnostics?.map(({ message }) => message).join("\n") ?? t("compare.variantFailed")}</pre>
                    <footer>{result.quality && <span>{t("compare.checks", { passed: result.quality.passed, total: result.quality.total })}{result.quality.averageScore === undefined ? "" : ` · ${t("compare.score", { score: result.quality.averageScore.toFixed(2) })}`}</span>}<span>{tokens ? t("playground.tokens", { count: tokens }) : t("compare.usageUnavailable")}</span><span>{result.costUsd ? `$${result.costUsd.toFixed(6)}` : t("compare.costZero")}</span>{result.runId && <span>{result.runId.slice(0, 12)}</span>}</footer>
                  </article>;
                }) : <div className="empty-dock">{t("compare.empty")}</div>}
              </div>
            </div>
          )}
          {activeDock === "trace" && (
            <div className="trace-pane">
              <aside className="run-history" aria-label={t("runs.title")}>
                <div className="run-history-heading"><strong>{t("runs.project")}</strong><button className="button" disabled={storedRunPhase === "loading"} onClick={() => void loadStoredRuns()}>{t("common.refresh")}</button></div>
                {storedRuns.length ? storedRuns.map((stored) => (
                  <button key={stored.runId} className={`run-history-item ${stored.runId === runId ? "is-active" : ""}`} onClick={() => void inspectStoredRun(stored)}>
                    <span>{stored.runId.slice(0, 12)}</span>
                    <small>{stored.startedAt ? formatDate(stored.startedAt, { dateStyle: "short", timeStyle: "medium" }) : stored.status ?? t("runs.stored")}</small>
                  </button>
                )) : <span className="run-history-empty">{storedRunPhase === "loading" ? t("runs.loading") : storedRunPhase === "error" ? t("runs.unavailable") : t("runs.empty.title")}</span>}
              </aside>
              <div className="trace-events">
                {trace.length ? (
                  <ul className="trace-list">
                    {trace.map((event, index) => (
                      <li key={`${event.type}:${event.timestamp}:${index}`}>
                        <details className="trace-detail">
                          <summary>
                            <span className="trace-time">{formatTime(event.timestamp)}</span>
                            <span className="trace-message">{eventSummary(event, t)}</span>
                            <span className="trace-meta">{event.type}</span>
                          </summary>
                          <pre>{JSON.stringify(event, null, 2)}</pre>
                          {eventNodeId(event) && <button className="button" onClick={() => showTraceComponent(eventNodeId(event))}>{t("runs.showComponent")}</button>}
                        </details>
                      </li>
                    ))}
                  </ul>
                ) : <div className="empty-dock">{t("runs.trace.empty")}</div>}
              </div>
            </div>
          )}
        </div>
      </section>

      <footer className="status-bar" aria-live="polite">
        <span className={`status-led ${statusClass}`} />
        <span className="status-copy">{statusNote}</span>
        <span className="status-spacer" />
        <span>{savePhase === "error" ? t("save.failed") : savePhase === "saving" ? t("save.saving") : dirty ? t("save.queued") : lastSavedAt ? t("save.saved", { time: formatTime(lastSavedAt, { hour: "2-digit", minute: "2-digit" }) }) : t("common.ready")}</span>
        <span>{document.yamlState === "synced" ? t("builder.yaml.statusSynced") : t("builder.yaml.statusPending")}</span>
        <span>{errorDiagnostics.length ? t("save.issues", { count: errorDiagnostics.length }) : document.validationPhase === "checking" ? t("save.validating") : serverValidated ? t("save.valid") : document.validationPhase}</span>
        {savePhase === "error" && <button className="status-retry" onClick={() => void (saveConflict ? reloadProject() : save())}>{t(saveConflict ? "common.refresh" : "common.retry")}</button>}
      </footer>
      </>}

      {surface === "settings" && <StudioSettings
        open
        page={settingsPage}
        theme={theme}
        locale={locale}
        file={initial.file}
        contract={integrationContract}
        diagnostics={document.diagnostics}
        connections={connections}
        toolCount={studioCatalog.tools.length}
        skillCount={studioCatalog.skills.length}
        specVersion={document.draft.root.version}
        runtimeConfig={document.draft.root.runtime && typeof document.draft.root.runtime === "object" && !Array.isArray(document.draft.root.runtime)
          ? document.draft.root.runtime as Readonly<Record<string, unknown>> : {}}
        runtimeLocked={running}
        onOpenChange={(open) => { if (!open) navigate("builder"); }}
        onPageChange={(page) => router.replace(`${STUDIO_SURFACE_HREFS.settings}?section=${page}`)}
        onThemeChange={applyTheme}
        onLocaleChange={setLocale}
        onManageConnections={() => openConnections()}
        onManageTools={() => setCustomToolOpen(true)}
        onManageSkills={() => setSkillManagerOpen(true)}
        onRuntimeChange={(runtime) => {
          const root = { ...documentDraftRef.current.root };
          if (runtime) root.runtime = runtime; else delete root.runtime;
          dispatch({ type: "replace-draft", draft: { ...documentDraftRef.current, root }, touch: "semantic" });
        }}
      >{managerDialogs}</StudioSettings>}
      {confirmation && <ConfirmDialog open title={confirmation.title} description={confirmation.description} confirmLabel={confirmation.confirmLabel} cancelLabel={t("common.cancel")} danger onConfirm={confirmation.onConfirm} onOpenChange={(open) => { if (!open) setConfirmation(undefined); }} />}
      {surface !== "settings" && managerDialogs}
      {attachmentPicker && !connectionManagerOpen && <CompatiblePicker
        open
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
      />}
    </main>
  );
}
