"use client";

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
  type HarnessIntegrationContract,
  type HarnessTestCase,
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
import { Inspector } from "./inspector";
import { ConnectionManager } from "./connection-manager";
import { CompatiblePicker } from "./compatible-picker";
import { CustomToolManager } from "./custom-tool-manager";
import { SkillManager } from "./skill-manager";
import { Playground } from "./playground";
import {
  connectionCanRun,
  connectionKindLabel,
  missingConnectionSetup,
  type ConnectionKind,
  type ConnectionSummary,
} from "@/lib/connections";
import { formatExperimentValue, parseExperimentValue } from "@/lib/experiments";
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

type DockTab = "yaml" | "problems" | "tests" | "experiments" | "trace";

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

type SimpleTestAssertion = Extract<HarnessAssertion, { value: string }>;

const SIMPLE_TEST_ASSERTIONS: readonly SimpleTestAssertion["type"][] = ["includes", "equals", "matches"];

const testAssertions = (test: HarnessTestCase): readonly HarnessAssertion[] => {
  if ("assertions" in test && test.assertions) return test.assertions;
  return test.assertion ? [test.assertion] : [];
};

const simpleTestAssertion = (test: HarnessTestCase) => testAssertions(test)
  .find((assertion): assertion is SimpleTestAssertion => "value" in assertion);

const replaceSimpleTestAssertion = (test: HarnessTestCase, assertion: SimpleTestAssertion): HarnessTestCase => {
  if ("assertions" in test && test.assertions) {
    const index = test.assertions.findIndex((candidate) => "value" in candidate);
    if (index < 0) return test;
    return { ...test, assertions: test.assertions.map((candidate, candidateIndex) => candidateIndex === index ? assertion : candidate) };
  }
  return { ...test, assertion };
};

interface StoredRun {
  runId: string;
  startedAt?: string;
  status?: string;
  durationMs?: number;
  usage?: unknown;
  costUsd?: number;
  events?: RunEvent[];
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

const PALETTE_LABELS: Readonly<Record<PaletteKind, string>> = {
  components: "Build",
  tools: "Tools",
  skills: "Skills",
  connections: "Services",
  templates: "Recipes",
};

const DOCK_LABELS: Readonly<Record<DockTab, string>> = {
  problems: "Setup",
  tests: "Tests",
  experiments: "Compare",
  trace: "Activity",
  yaml: "YAML",
};

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
    case "fallback": return `${String(data.from ?? "Primary provider")} → ${String(data.to ?? "fallback provider")} · turn ${String(data.turn ?? "")}`.trim();
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

function IntegrationWorkspace({
  contract,
  diagnostics,
  connections,
  connectionsLoaded,
  verified,
  file,
  onOpenBuilder,
  onOpenConnections,
}: {
  contract: HarnessIntegrationContract;
  diagnostics: readonly Diagnostic[];
  connections: readonly ConnectionSummary[];
  connectionsLoaded: boolean;
  verified: boolean;
  file: string;
  onOpenBuilder: () => void;
  onOpenConnections: () => void;
}) {
  const [copied, setCopied] = useState<string>();
  const filename = file.split(/[\\/]/).pop() ?? "harnest.yaml";
  const missingConnections = connectionsLoaded
    ? contract.requiredConnections.filter((id) => !connections.some((connection) => connection.id === id && connectionCanRun(connection)))
    : [];
  const errors = diagnostics.filter(({ severity }) => severity === "error");
  const ready = verified && missingConnections.length === 0 && errors.length === 0;
  const blockerCount = errors.length + missingConnections.length + Number(!verified);
  const snippets = [
    { id: "sdk", label: "TypeScript SDK", code: `const harness = await Harnest.load(${JSON.stringify(filename)});\nconst result = await harness.invoke(input);\nawait harness.close();` },
    { id: "cli", label: "CLI", code: `harnest validate ${filename}\nharnest run ${filename} --input '{"message":"hello"}'` },
    { id: "http", label: "HTTP", code: `harnest serve ${filename} --port 8787\ncurl -X POST http://127.0.0.1:8787/invoke \\\n  -H 'content-type: application/json' \\\n  -d '{"input":"hello"}'` },
    { id: "mcp", label: "MCP", code: `harnest mcp serve ${filename}` },
  ] as const;
  const copy = async (id: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(id);
    } catch {
      setCopied(`error:${id}`);
    }
    window.setTimeout(() => setCopied((current) => current === id || current === `error:${id}` ? undefined : current), 1_500);
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(contract, null, 2)], { type: "application/json" }));
    const link = globalThis.document.createElement("a");
    link.href = url;
    link.download = `${filename.replace(/\.ya?ml$/i, "")}.contract.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return <section className="integrate-workspace" aria-labelledby="integrate-title">
    <header className="integrate-hero">
      <div><span className="sheet-eyebrow">Portable Integration Contract</span><h1 id="integrate-title">One harness. Four production surfaces.</h1><p>This page is generated from the current HarnessSpec—not a deployment mock. Change the graph and the contract changes with it.</p></div>
      <div className={`contract-readiness ${ready ? "is-ready" : "is-blocked"}`}><span>{ready ? "Ready to integrate" : connectionsLoaded ? "Action required" : "Checking connections"}</span><strong>{ready ? `${contract.componentCount} components verified` : `${blockerCount} blocker(s)`}</strong><small>HarnessSpec {contract.specVersion} · contract v{contract.contractVersion}</small></div>
    </header>

    <div className="contract-metrics" aria-label="Harness contract summary">
      <div><span>Graph</span><strong>{contract.graphCount}</strong><small>{contract.componentCount} components · {contract.connectionCount} edges</small></div>
      <div><span>Tests</span><strong>{contract.tests.count}</strong><small>{contract.tests.assertionTypes.join(" · ") || "No assertions declared"}</small></div>
      <div><span>Services</span><strong>{contract.requiredConnections.length}</strong><small>{contract.requiredConnections.join(" · ") || "No named Connections"}</small></div>
      <div><span>Output</span><strong>{contract.output?.format ?? "custom"}</strong><small>{contract.output?.schemaDeclared ? "JSON Schema declared" : `Entrypoint · ${contract.entrypoint}`}</small></div>
    </div>

    <div className="contract-layout">
      <section className="contract-capabilities"><header><div><span className="sheet-eyebrow">Runtime truth</span><h2>Declared capabilities</h2></div><button className="button" onClick={download}>Download JSON</button></header>
        <div className="capability-grid">{contract.capabilities.length ? contract.capabilities.map((capability) => <span key={capability}>{capability.replaceAll("-", " ")}</span>) : <p>No optional runtime capabilities are declared.</p>}</div>
        {contract.capabilities.includes("code-sandbox") && <div className="sandbox-contract"><strong>File → Code Runner contract</strong><div><span>Upload</span><i>→</i><span>/mnt/data · read-only</span><i>→</i><span>isolated runner</span><i>→</i><span>/mnt/output · artifacts</span></div><p>Only files selected for a run are mounted. Generated files are indexed and returned to the Playground for preview or download.</p></div>}
        <div className="contract-list"><h3>Required Connections</h3>{contract.requiredConnections.length ? contract.requiredConnections.map((id) => {
          const connection = connections.find((candidate) => candidate.id === id);
          const running = connection ? connectionCanRun(connection) : false;
          return <div key={id}><span className={`contract-state ${running ? "is-ready" : "is-blocked"}`} aria-hidden="true" /><span><strong>{id}</strong><small>{connection ? `${connectionKindLabel(connection.kind)} · ${connection.status.replaceAll("_", " ")}` : "Connection has not been created"}</small></span>{!running && <button className="button" onClick={onOpenConnections}>Connect</button>}</div>;
        }) : <p>No named provider or tool Connections are required by this spec.</p>}</div>
        {!ready && <div className="contract-blockers" role="status"><strong>Integration blockers</strong><ul>{!verified && <li>{connectionsLoaded ? "Save and complete runtime validation for the current HarnessSpec." : "Reusable Connections are still loading."}</li>}{missingConnections.map((id) => <li key={id}>Connect and test <code>{id}</code>.</li>)}{errors.slice(0, 6).map((diagnostic, index) => <li key={`${diagnostic.code}:${index}`}>{diagnostic.message}</li>)}</ul><button className="button" onClick={onOpenBuilder}>Resolve in Builder</button></div>}
      </section>

      <section className="integration-snippets"><header><span className="sheet-eyebrow">Use the same contract anywhere</span><h2>Integration recipes</h2></header>{snippets.map((snippet) => <article key={snippet.id}><div><strong>{snippet.label}</strong><button type="button" onClick={() => void copy(snippet.id, snippet.code)}>{copied === snippet.id ? "Copied" : copied === `error:${snippet.id}` ? "Copy failed" : "Copy"}</button></div><pre><code>{snippet.code}</code></pre></article>)}</section>
    </div>
  </section>;
}

function StudioReady({ initial }: { initial: SpecPayload }) {
  const [surface, setSurface] = useState<"builder" | "playground" | "integrate">("builder");
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
  const [paletteKind, setPaletteKind] = useState<PaletteKind>(initial.exists ? "components" : "templates");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">("light");
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
  const [statusNote, setStatusNote] = useState(initial.diagnostics?.some((item) => item.severity === "error")
    ? `${initial.diagnostics.length} host capability or module issue(s)`
    : initial.exists ? "Harness loaded" : "New harness — add a component to begin");
  const [dropTarget, setDropTarget] = useState(false);
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
  const experimentAbortRef = useRef<AbortController | null>(null);
  const autoSetup = useRef(initial.exists);
  const autoSetupProgress = useRef(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const fittedGraph = useRef<string | undefined>(undefined);
  const reactFlow = useReactFlow<HarnessNode, HarnessEdge>();
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
      .then((connectionPayload) => {
        setConnections(connectionPayload.connections);
        setConnectionsLoaded(true);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setConnectionsLoaded(true);
          setStatusNote(error instanceof Error ? error.message : "Connections could not be loaded");
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
  const integrationContract = useMemo(() => describeHarness(draftToSpec(document.draft)), [document.draft]);
  const replaceViewDraft = useCallback((draft: HarnessDraft, touch: "none" | "transient" | "layout" | "semantic") => {
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
  const experimentRunning = experimentPhase === "running";
  const running = experimentRunning;
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
      setStatusNote(redo ? "Change restored" : "Change undone");
    };
    window.addEventListener("keydown", handleHistoryShortcut);
    return () => window.removeEventListener("keydown", handleHistoryShortcut);
  }, [canRedo, canUndo]);
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

  const insertAtPort = useCallback((anchor: CanvasPortAnchor, insertion: CanvasPortInsertion) => {
    if (graphLocked) return;
    const anchorNode = viewDraft.nodes.find((node) => node.id === anchor.nodeId);
    const manifest = manifests.get(insertion.type);
    if (!anchorNode || !manifest) {
      setStatusNote("The compatible component is no longer available. Refresh the catalog and try again.");
      return;
    }
    const id = uniqueComponentId(insertion.type, new Set(viewDraft.nodes.map((node) => node.id)));
    const component = { id, type: insertion.type, config: structuredClone(manifest.defaultConfig) } as HarnessComponent;
    const candidate: HarnessConnection = anchor.direction === "output" ? {
      from: { component: anchor.nodeId, port: anchor.port },
      to: { component: id, port: insertion.connectPort },
    } : {
      from: { component: id, port: insertion.connectPort },
      to: { component: anchor.nodeId, port: anchor.port },
    };
    const upgraded = viewDraft.root.version === "0.1" && !LEGACY_COMPONENT_TYPES.has(insertion.type);
    const root = {
      ...viewDraft.root,
      ...(upgraded ? { version: "0.2" as const } : {}),
      ...(manifest.category === "Output" ? { entrypoint: id } : {}),
    };
    const node: HarnessNode = {
      id,
      type: "harness",
      position: {
        x: anchorNode.position.x + (anchor.direction === "output" ? 360 : -360),
        y: anchorNode.position.y + Math.min(160, viewDraft.nodes.filter((item) => Math.abs(item.position.x - anchorNode.position.x) < 80).length * 24),
      },
      data: { component, manifest },
      selected: true,
    };
    const draft = {
      ...viewDraft,
      root,
      nodes: [...viewDraft.nodes.map((current) => ({ ...current, selected: false })), node],
    };
    const validation = validateCandidateConnection(draftToSpec(draft), candidate, { components: validationComponents });
    if (!validation.ok) {
      setStatusNote(validation.diagnostics[0]?.message ?? "That component can no longer be connected at this port.");
      return;
    }
    const connection = { ...candidate, id: `connection_${crypto.randomUUID().slice(0, 8)}` };
    const edge: HarnessEdge = {
      id: connection.id,
      type: "smoothstep",
      source: connection.from.component,
      sourceHandle: connection.from.port,
      target: connection.to.component,
      targetHandle: connection.to.port,
      data: { connection },
    };
    replaceViewDraft({ ...draft, edges: [...viewDraft.edges, edge] }, "semantic");
    setStatusNote(`${manifest.label} ${id} added and connected · Undo with Ctrl/⌘ Z`);
  }, [graphLocked, manifests, replaceViewDraft, validationComponents, viewDraft]);

  const portInsertions = useMemo(() => Object.fromEntries(viewDraft.nodes.flatMap((node) => [
    ...Object.keys(node.data.manifest.ports.inputs).map((port) => {
      const key = `${node.id}:input:${port}`;
      return [key, compatiblePortInsertions(viewDraft, catalog, { nodeId: node.id, direction: "input", port })] as const;
    }),
    ...Object.keys(node.data.manifest.ports.outputs).map((port) => {
      const key = `${node.id}:output:${port}`;
      return [key, compatiblePortInsertions(viewDraft, catalog, { nodeId: node.id, direction: "output", port })] as const;
    }),
  ])), [catalog, viewDraft]);

  const displayNodes = useMemo(() => viewDraft.nodes.map((node) => {
    const nodeEvents = trace.filter((event) => (event as RunEvent & { nodeId?: string }).nodeId?.split("/").at(-1) === node.id);
    const ended = nodeEvents.findLast((event) => event.type === "node-end") as (RunEvent & { durationMs?: number }) | undefined;
    const failed = nodeEvents.findLast((event) => event.type === "error") as (RunEvent & { message?: string }) | undefined;
    const runState: NodeRunState = failed ? "error" : ended ? "success" : nodeEvents.some((event) => event.type === "node-start") ? "running" : "idle";
    return {
      ...node,
      data: {
      ...node.data,
      diagnostics: document.diagnostics.filter((item) => item.componentId === node.id
        && (activeSubgraph
          ? item.path.startsWith(`$.subgraphs.${activeSubgraph}.`)
          : !item.path.startsWith("$.subgraphs."))),
      runState,
      ...(nodeEvents.length ? { lastRun: {
        ...(runId ? { runId } : {}),
        state: runState,
        ...(typeof ended?.durationMs === "number" ? { durationMs: ended.durationMs } : {}),
        eventCount: nodeEvents.length,
        ...(failed?.message ? { error: failed.message } : {}),
      } } : {}),
      locked: graphLocked,
      portInsertions: Object.fromEntries([
        ...Object.keys(node.data.manifest.ports.inputs).flatMap((port) => {
          const options = portInsertions[`${node.id}:input:${port}`];
          return options?.length ? [[`input:${port}`, options] as const] : [];
        }),
        ...Object.keys(node.data.manifest.ports.outputs).flatMap((port) => {
          const options = portInsertions[`${node.id}:output:${port}`];
          return options?.length ? [[`output:${port}`, options] as const] : [];
        }),
      ]),
      onInsertAtPort: insertAtPort,
      onAddAttachment: (nodeId: string, slot: "tools" | "skills") => setAttachmentPicker({ nodeId, slot }),
      },
    };
  }), [activeSubgraph, document.diagnostics, graphLocked, insertAtPort, portInsertions, runId, trace, viewDraft.nodes]);

  const displayEdges = useMemo(() => viewDraft.edges.map((edge) => ({
    ...edge,
    label: edge.data?.connection ? edgeLabel(edge.data.connection) : undefined,
    className: "",
    animated: false,
    data: { ...edge.data!, running: false },
  })), [viewDraft.edges]);

  useEffect(() => {
    const graph = activeSubgraph ?? "root";
    if (!viewDraft.nodes.length || fittedGraph.current === graph) return undefined;
    const timer = window.setTimeout(() => {
      fittedGraph.current = graph;
      void reactFlow.fitView({ padding: 0.25 });
    }, 100);
    return () => window.clearTimeout(timer);
  }, [activeSubgraph, reactFlow, viewDraft.nodes.length]);

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
    const dragging = changes.some((change) => change.type === "position" && change.dragging === true);
    replaceViewDraft(draft, removed ? "semantic" : finishedMove ? "layout" : dragging ? "transient" : "none");
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

  const openConnections = useCallback((kind?: ConnectionKind, targetNodeId?: string, requestedId?: string) => {
    setRequestedConnectionKind(kind);
    setRequestedConnectionId(requestedId);
    setConnectionTargetNodeId(targetNodeId);
    setConnectionManagerOpen(true);
  }, []);

  useEffect(() => {
    if (!autoSetup.current || !connectionsLoaded || connectionManagerOpen
      || attachmentPicker || customToolOpen || skillManagerOpen) return;
    const components = [
      ...document.draft.nodes,
      ...Object.values(document.draft.subgraphs).flatMap((graph) => graph.nodes),
    ].map((node) => node.data.component);
    const pending = missingConnectionSetup(components, connections, studioCatalog.tools);
    if (!pending) {
      if (autoSetupProgress.current) {
        autoSetup.current = false;
        setStatusNote("All declared Connections are ready.");
      }
      return;
    }
    autoSetupProgress.current = true;
    openConnections(pending.kind, undefined, pending.id);
    setStatusNote(`Setup needed · connect '${pending.id}'. Harnest will continue with the next requirement automatically.`);
  }, [attachmentPicker, connectionManagerOpen, connections, connectionsLoaded, customToolOpen,
    document.draft.nodes, document.draft.subgraphs, openConnections, skillManagerOpen, studioCatalog.tools]);

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
    const attached = viewDraft.edges.some((edge) => edge.target === nodeId && edge.targetHandle === "skills"
      && viewDraft.nodes.some((node) => node.id === edge.source && node.data.component.type === "skill"
        && node.data.component.config.skill === skill.id));
    if (attached) {
      setStatusNote(`${skill.label} is already enabled on ${nodeId}.`);
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
        setStatusNote(`${skill.label} needs ${tool.label}; adding and connecting it first.`);
      } else {
        setAttachmentPicker({ nodeId, slot: "tools" });
        setStatusNote(`${skill.label} needs Tool '${missingToolId}'. Install or select it, then Harnest will resume the Skill.`);
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
      setStatusNote(`${skill.label} needs Connection '${missingConnection.id}'. Connect it once; Skill setup will resume automatically.`);
      return;
    }
    if (skill.scriptsPresent && !window.confirm(
      `${skill.label} includes scripts from ${JSON.stringify(skill.provenance ?? { source: skill.source })}. `
      + "Only separately reviewed SHA-256 hashes can be loaded. Attach the instructions now?",
    )) return;
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
      ? `${skill.label} enabled · Validate host permissions: ${permissions.join(", ")}.`
      : `${skill.label} enabled on ${nodeId}.`);
  }, [addComponent, addTool, connections, markRecent, openConnections, studioCatalog.tools, viewDraft.edges, viewDraft.nodes]);

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
      setStatusNote("MCP connected · Test and Discover tools here, then equip the Agent from its + Tool picker.");
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

  const runExperiment = useCallback(async () => {
    if (!canCompare || !experimentComponent || !selectedExperimentField) return;
    let left: unknown;
    let right: unknown;
    try {
      left = parseExperimentValue(experimentA, experimentSample);
      right = parseExperimentValue(experimentB, experimentSample);
    } catch (error) {
      setExperimentPhase("error");
      setStatusNote(error instanceof Error ? error.message : "Comparison values are invalid");
      return;
    }
    const controller = new AbortController();
    experimentAbortRef.current = controller;
    setActiveDock("experiments");
    setExperimentPhase("running");
    setExperimentResults([]);
    setStatusNote(`Comparing ${experimentComponent.id}.${selectedExperimentField} with the same input…`);
    try {
      const response = await fetch("/api/experiments", {
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
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      const payload = await response.json() as { results: ExperimentResult[] };
      setExperimentResults(payload.results);
      setExperimentPhase(payload.results.every(({ ok }) => ok) ? "idle" : "error");
      setStatusNote(`Comparison finished · ${payload.results.filter(({ ok }) => ok).length}/${payload.results.length} variants completed`);
      void loadStoredRuns();
    } catch (error) {
      setExperimentPhase(controller.signal.aborted ? "idle" : "error");
      setStatusNote(controller.signal.aborted ? "Comparison cancelled" : error instanceof Error ? error.message : "Comparison failed");
    } finally {
      if (experimentAbortRef.current === controller) experimentAbortRef.current = null;
    }
  }, [canCompare, document.draft, experimentA, experimentB, experimentComponent, experimentSample,
    loadStoredRuns, runInput, selectedExperimentField]);

  const cancelExperiment = useCallback(() => {
    experimentAbortRef.current?.abort();
  }, []);

  useEffect(() => () => {
    experimentAbortRef.current?.abort();
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

  useEffect(() => {
    if (!canSave) return;
    const timer = setTimeout(() => void save(), 650);
    return () => clearTimeout(timer);
  }, [canSave, save]);

  useEffect(() => {
    if (!canValidate || document.validatedSemanticRevision !== null || document.draft.nodes.length === 0) return;
    const timer = setTimeout(() => void validate(), 350);
    return () => clearTimeout(timer);
  }, [canValidate, document.draft.nodes.length, document.validatedSemanticRevision, validate]);

  const completedRun = trace.some((event) => event.type === "run-end");
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
  const savedTests = draftToSpec(document.draft).tests ?? [];
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
    const test: HarnessTestCase = {
      id,
      input: runInput.trim() || "Hello",
      assertion: { type: "includes", value: "expected text" },
    };
    replaceTests([...savedTests, test]);
    setActiveDock("tests");
  };
  const removeTest = (index: number) => {
    if (!window.confirm(`Remove test '${savedTests[index]?.id ?? index + 1}'?`)) return;
    replaceTests(savedTests.filter((_, testIndex) => testIndex !== index));
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
        Import
        <input type="file" accept=".yaml,.yml,text/yaml" disabled={running} onChange={(event) => void importYaml(event.target.files?.[0])} />
      </label>
      <button className="button" onClick={exportYaml}>Export</button>
      {document.yamlState !== "synced" && <button className="button" onClick={() => dispatch({ type: "discard-yaml" })}>Discard</button>}
      <button className="button button-primary" disabled={!document.pendingSpec || running} onClick={() => dispatch({ type: "apply-yaml" })}>Apply YAML</button>
    </div>
  );
  const dockTabs: DockTab[] = ["problems", "tests", "experiments", "trace", "yaml"];
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
    <main className={`studio-shell ${paletteOpen ? "is-palette-open" : ""} ${dockOpen ? "is-dock-open" : ""} ${surface === "playground" ? "is-playground" : surface === "integrate" ? "is-integrate" : welcome ? "is-welcome" : ""}`}>
      <header className="command-rail">
        <div className="brand-lockup">
          <span className="brand-name">Harnest</span>
          <span className="project-name" title={initial.file}>{initial.file.split(/[\\/]/).pop()}</span>
          {dirty && <span className="dirty-dot" title="Unsaved changes" />}
        </div>
        <nav className="surface-tabs" aria-label="Harnest workspace">
          <button className={surface === "builder" ? "is-active" : ""} aria-current={surface === "builder" ? "page" : undefined} onClick={() => setSurface("builder")}>Builder</button>
          <button className={surface === "playground" ? "is-active" : ""} aria-current={surface === "playground" ? "page" : undefined} onClick={() => setSurface("playground")}>Harnest Playground</button>
          <button className={surface === "integrate" ? "is-active" : ""} aria-current={surface === "integrate" ? "page" : undefined} onClick={() => setSurface("integrate")}>Integrate</button>
        </nav>
        {surface === "playground" ? <div className="playground-rail-context"><span>Immutable runtime</span><strong>{serverValidated ? "Ready" : "Setup required"}</strong></div> : surface === "integrate" ? <div className="playground-rail-context"><span>Integration contract</span><strong>{integrationContract.integrationSurfaces.length} surfaces</strong></div> : welcome ? <div className="welcome-context"><span>First run</span><strong>Choose one outcome</strong></div> : <>
          <div className="continuity-rail" aria-label="Setup progress">
            <span className={`continuity-step ${templateReady ? "is-pass" : "is-active"}`}><span>Recipe</span></span>
            <span className={`continuity-step ${connectionReady ? "is-pass" : templateReady ? "is-active" : ""}`}><span>Services</span></span>
            <span className={`continuity-step ${serverValidated ? "is-pass" : connectionReady ? "is-active" : ""}`}><span>Ready</span></span>
            <span className={`continuity-step ${completedRun ? "is-pass" : serverValidated ? "is-active" : ""}`}><span>Result</span></span>
          </div>
          <div className="rail-actions">
            {running ? (
              <button className="button button-danger" onClick={cancelExperiment}>Cancel comparison</button>
            ) : nextConnectionSetup ? (
              <button className="button button-primary" onClick={() => openConnections(
                nextConnectionSetup.kind,
                undefined,
                "id" in nextConnectionSetup ? nextConnectionSetup.id : undefined,
              )}>Connect {connectionKindLabel(nextConnectionSetup.kind)}</button>
            ) : errorDiagnostics.length ? (
              <button className="button button-primary" onClick={() => setActiveDock("problems")}>Review {errorDiagnostics.length} setup issue{errorDiagnostics.length === 1 ? "" : "s"}</button>
            ) : dirty || savePhase === "saving" ? (
              <button className="button button-rail" disabled>{savePhase === "saving" ? "Saving changes…" : "Changes queued…"}</button>
            ) : document.validationPhase === "checking" || document.validatedSemanticRevision === null ? (
              <button className="button button-rail" disabled>Checking setup…</button>
            ) : serverValidated ? (
              <button className="button button-primary" onClick={() => setSurface("playground")}>Open Playground</button>
            ) : <button className="button button-rail" disabled>Preparing…</button>}
          </div>
        </>}
        <button
          className="theme-toggle"
          type="button"
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          onClick={() => setTheme((current) => {
            const next = current === "dark" ? "light" : "dark";
            globalThis.document.documentElement.dataset.theme = next;
            localStorage.setItem("harnest.studio.theme", next);
            return next;
          })}
        ><span aria-hidden="true">{theme === "dark" ? "☀" : "◐"}</span></button>
      </header>

      {surface === "playground" ? <Playground onOpenBuilder={() => setSurface("builder")} /> : surface === "integrate" ? <IntegrationWorkspace contract={integrationContract} diagnostics={document.diagnostics} connections={connections} connectionsLoaded={connectionsLoaded} verified={!dirty && serverValidated} file={initial.file} onOpenBuilder={() => setSurface("builder")} onOpenConnections={() => openConnections()} /> : welcome ? (
        <section className="welcome-launchpad" aria-labelledby="welcome-title">
          <div className="welcome-intro">
            <span className="sheet-eyebrow">Working harness in minutes</span>
            <h1 id="welcome-title">Start from the result you want.</h1>
            <p>Pick a recipe. Harnest builds the graph, asks only for the services it needs, and checks the setup automatically.</p>
            <div className="welcome-steps" aria-label="What happens next">
              <span><strong>1</strong> Choose a recipe</span>
              <span><strong>2</strong> Connect services</span>
              <span><strong>3</strong> Try a real request</span>
            </div>
          </div>
          <div className="recipe-grid">
            {studioCatalog.templates.map((template) => (
              <button className="recipe-card" key={template.id} onClick={() => applyTemplate(template)}>
                <span className="recipe-meta"><span>{template.category}</span><span>~{Math.max(2, (template.connectionKinds?.length ?? 0) * 2)} min</span></span>
                <strong>{template.label}</strong>
                <span className="recipe-outcome">{template.description}</span>
                <span className="recipe-needs"><small>Needs</small>{template.connectionKinds?.map(connectionKindLabel).join(" + ") || "No external service"}</span>
                <span className="recipe-sample"><small>Try</small>“{template.sampleInput}”</span>
                <span className="recipe-action">Use this recipe →</span>
              </button>
            ))}
          </div>
          <div className="welcome-alternatives">
            <span>Already have a harness?</span>
            <label className="button file-button">Open YAML<input type="file" accept=".yaml,.yml,text/yaml" onChange={(event) => void openYaml(event.target.files?.[0])} /></label>
            <button className="button" onClick={() => { setWelcomeDismissed(true); setPaletteKind("components"); setPaletteOpen(true); }}>Build from blank</button>
          </div>
        </section>
      ) : <>
      {paletteOpen && <aside className="palette-panel" aria-label="Studio palette">
        <div className="panel-heading"><h2>Component catalog</h2><span><span className="panel-count">{visiblePalette.length}/{paletteItems.length}</span><button className="panel-close" type="button" aria-label="Close component catalog" onClick={() => setPaletteOpen(false)}>×</button></span></div>
        <div className="palette-tabs" role="tablist" aria-label="Palette catalogs">
          {PALETTE_KINDS.map((kind) => <button
            key={kind}
            role="tab"
            aria-selected={paletteKind === kind}
            className={`palette-tab ${paletteKind === kind ? "is-active" : ""}`}
            onClick={() => { setPaletteKind(kind); setPaletteCategory("all"); setPaletteQuery(""); }}
          >{PALETTE_LABELS[kind]}</button>)}
        </div>
        {(paletteKind === "tools" || paletteKind === "skills") && <div className="palette-create"><button className="button" onClick={() => paletteKind === "tools" ? setCustomToolOpen(true) : setSkillManagerOpen(true)}>{paletteKind === "tools" ? "New custom tool" : "Manage skills"}</button></div>}
        <div className="palette-filters">
          <label className="sr-only" htmlFor="palette-search">Search palette</label>
          <input id="palette-search" type="search" placeholder={`Search ${PALETTE_LABELS[paletteKind].toLocaleLowerCase()}`} value={paletteQuery} onChange={(event) => setPaletteQuery(event.target.value)} />
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
      </aside>}

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
          <button className="catalog-toggle" type="button" aria-expanded={paletteOpen} onClick={() => setPaletteOpen((current) => !current)}>＋ Add</button>
          <button className={`graph-crumb ${activeSubgraph ? "" : "is-active"}`} disabled={!activeSubgraph} onClick={() => setActiveSubgraph(undefined)}>Root</button>
          {activeSubgraph && <><span aria-hidden="true">›</span><span className="graph-crumb is-active">{activeSubgraph}</span></>}
          {Object.keys(document.draft.subgraphs).length > 0 && (
            <select aria-label="Open graph" value={activeSubgraph ?? ""} onChange={(event) => setActiveSubgraph(event.target.value || undefined)}>
              <option value="">Root graph</option>
              {Object.keys(document.draft.subgraphs).map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          )}
          <span className="canvas-history" role="group" aria-label="Canvas history">
            <button type="button" disabled={!canUndo} aria-label="Undo last canvas change" title="Undo (Ctrl/⌘ Z)" onClick={() => { dispatch({ type: "undo" }); setStatusNote("Change undone"); }}>↶</button>
            <button type="button" disabled={!canRedo} aria-label="Redo last canvas change" title="Redo (Ctrl/⌘ Shift Z)" onClick={() => { dispatch({ type: "redo" }); setStatusNote("Change restored"); }}>↷</button>
          </span>
          <span className="utility-label">{viewDraft.nodes.length} components · {viewDraft.edges.length} connections</span>
        </div>
        {viewDraft.nodes.length === 0 && <div className="commissioning-onboarding"><span className="sheet-eyebrow">Blank harness</span><strong>Add the first building block</strong><span>Open the catalog, or start from a recipe for a working graph.</span><button className="onboarding-blank" onClick={() => { setPaletteKind("templates"); setPaletteOpen(true); }}>Browse recipes</button></div>}
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
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color={theme === "dark" ? "#353b47" : "#c7ced8"} />
          <Controls position="bottom-left" showInteractive={false} />
          <MiniMap position="bottom-right" pannable zoomable nodeColor={(node) => colorFor((node.data as HarnessNode["data"]).manifest.category)} maskColor={theme === "dark" ? "rgb(15 17 22 / 78%)" : "rgb(244 246 249 / 76%)"} />
        </ReactFlow>
      </section>

      <aside className="inspector-panel" aria-label="Component and connection inspector">
        <div className="panel-heading"><h2>Configure</h2><span className="panel-count">{selectedEdge ? "connection" : selectedNode?.data.component.type ?? "none"}</span></div>
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

      <section className={`bottom-dock ${dockOpen ? "" : "is-collapsed"}`} aria-label="Setup, tests, comparisons, activity, and YAML">
        <div className="dock-heading">
          <div className="dock-tabs" role="tablist" aria-label="Studio dock">
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
                {DOCK_LABELS[tab]}{tab === "problems" && displayedDiagnostics.length > 0 && <span className="tab-badge">{displayedDiagnostics.length}</span>}
              </button>
            ))}
          </div>
          {dockOpen && dockTools}
          <button className="dock-toggle" type="button" aria-label={dockOpen ? "Collapse workbench" : "Expand workbench"} aria-expanded={dockOpen} onClick={() => setDockOpen((current) => !current)}>{dockOpen ? "⌄" : "⌃"}</button>
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
          {activeDock === "tests" && (
            <div className="tests-pane">
              <div className="tests-toolbar">
                <div><strong>Test cases</strong><span>{savedTests.length} saved</span></div>
                <div className="tests-actions">
                  <button className="button" disabled={running || document.yamlState !== "synced"} onClick={addTest}>Add case</button>
                  <button className="button button-primary" disabled={!savedTests.length || dirty || !serverValidated || testPhase === "running"} onClick={() => void runTests()}>{testPhase === "running" ? "Running…" : "Run all"}</button>
                </div>
              </div>
              <div className="tests-workspace">
                <section className="test-case-list" aria-label="Editable test cases">
                  {savedTests.length ? savedTests.map((test, index) => {
                    const assertion = simpleTestAssertion(test);
                    const assertionCount = testAssertions(test).length;
                    return <article className="test-case-editor" key={`${index}:${test.id}`}>
                      <div className="test-case-heading">
                        <label><span>Case ID</span><input value={test.id} maxLength={64} disabled={running} onChange={(event) => updateTest(index, (current) => ({ ...current, id: event.target.value }))} /></label>
                        <button className="button" disabled={running} title={`Remove ${test.id}`} onClick={() => removeTest(index)}>Remove</button>
                      </div>
                      {typeof test.input === "string" ? <label className="test-case-field"><span>Request</span><textarea value={test.input} disabled={running} onChange={(event) => updateTest(index, (current) => ({ ...current, input: event.target.value }))} /></label>
                        : <div className="test-case-advanced"><span>Structured request</span><small>This input is preserved. Use YAML to edit objects or arrays.</small></div>}
                      {assertion ? <div className="test-expectation">
                        <label><span>Expect</span><select value={assertion.type} disabled={running} onChange={(event) => updateTest(index, (current) => replaceSimpleTestAssertion(current, { ...assertion, type: event.target.value as SimpleTestAssertion["type"] }))}>{SIMPLE_TEST_ASSERTIONS.map((type) => <option value={type} key={type}>{type === "includes" ? "contains text" : type === "equals" ? "equals text" : "matches pattern"}</option>)}</select></label>
                        <label><span>{assertion.type === "matches" ? "Pattern" : "Expected text"}</span><input value={assertion.value} disabled={running} onChange={(event) => updateTest(index, (current) => replaceSimpleTestAssertion(current, { ...assertion, value: event.target.value }))} /></label>
                        {assertionCount > 1 && <small>{assertionCount - 1} additional advanced check{assertionCount === 2 ? "" : "s"} stay unchanged.</small>}
                      </div> : <div className="test-case-advanced"><span>{assertionCount} advanced check{assertionCount === 1 ? "" : "s"}</span><small>This case will still run unchanged.</small><button className="button" onClick={() => setActiveDock("yaml")}>Edit in YAML</button></div>}
                    </article>;
                  }) : <div className="empty-dock"><span>No test cases yet.</span><button className="button button-primary" onClick={addTest}>Add your first case</button></div>}
                </section>
                {testReport ? (
                  <div className="test-report">
                    <div className={`test-summary ${testReport.ok ? "is-pass" : "is-fault"}`}><strong>{Math.round((testReport.passed / Math.max(1, testReport.passed + testReport.failed)) * 100)}% success</strong><span>{testReport.passed} passed · {testReport.failed} failed</span></div>
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
                ) : <div className="empty-dock">{savedTests.length ? "Run all after automatic saving and setup checks finish." : "Add a case to turn a good answer into a repeatable check."}</div>}
              </div>
            </div>
          )}
          {activeDock === "experiments" && (
            <div className="experiment-pane">
              <div className="experiment-config">
                <div><span className="sheet-eyebrow">A/B comparison</span><strong>Change one setting, keep the input fixed</strong><small>Both variants run against the current saved harness.</small></div>
                <label className="field-label" htmlFor="experiment-component">Component</label>
                <select id="experiment-component" value={experimentComponent?.id ?? ""} disabled={experimentRunning} onChange={(event) => { setExperimentComponentId(event.target.value); setExperimentField(""); }}>
                  {experimentComponents.map((component) => <option key={component.id} value={component.id}>{component.id} · {component.type}</option>)}
                </select>
                <label className="field-label" htmlFor="experiment-field">Setting</label>
                <select id="experiment-field" value={selectedExperimentField} disabled={experimentRunning} onChange={(event) => setExperimentField(event.target.value)}>
                  {experimentFields.map((field) => <option key={field} value={field}>{field}</option>)}
                </select>
                <div className="experiment-values">
                  <label><span>Variant A</span><textarea value={experimentA} disabled={experimentRunning} onChange={(event) => setExperimentA(event.target.value)} /></label>
                  <label><span>Variant B</span><textarea value={experimentB} disabled={experimentRunning} onChange={(event) => setExperimentB(event.target.value)} /></label>
                </div>
                <label className="field-label" htmlFor="experiment-input">Same input for both</label>
                <textarea id="experiment-input" className="run-input" value={runInput} disabled={experimentRunning} placeholder="Ask both variants the same thing…" onChange={(event) => setRunInput(event.target.value)} />
                {experimentRunning
                  ? <button className="button button-danger" onClick={cancelExperiment}>Cancel comparison</button>
                  : <button className="button button-primary" disabled={!canCompare} onClick={() => void runExperiment()}>Run A and B</button>}
                {!canCompare && !experimentRunning && <small className="run-guidance">The harness must be saved and ready before comparing variants.</small>}
              </div>
              <div className="experiment-results" aria-live="polite">
                {experimentResults.length ? experimentResults.map((result) => {
                  const tokens = result.usage?.totalTokens
                    ?? (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0);
                  return <article className={`experiment-result ${result.ok ? "is-pass" : "is-fault"}`} key={result.id}>
                    <header><span>{result.label}</span><strong>{result.ok ? `${Math.round(result.durationMs ?? 0)}ms` : "Needs attention"}</strong></header>
                    <pre>{result.ok ? formatOutput(result.output) : result.error ?? result.diagnostics?.map(({ message }) => message).join("\n") ?? "Variant failed"}</pre>
                    <footer>{result.quality && <span>{result.quality.passed}/{result.quality.total} checks{result.quality.averageScore === undefined ? "" : ` · score ${result.quality.averageScore.toFixed(2)}`}</span>}<span>{tokens ? `${tokens} tokens` : "Usage unavailable"}</span><span>{result.costUsd ? `$${result.costUsd.toFixed(6)}` : "$0 reported"}</span>{result.runId && <span>{result.runId.slice(0, 12)}</span>}</footer>
                  </article>;
                }) : <div className="empty-dock">Choose a component setting. Harnest will run A, then B, and show both answers with timing and usage.</div>}
              </div>
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
      </>}

      <ConnectionManager
        open={connectionManagerOpen}
        connections={connections}
        definitions={studioCatalog.connectionTypes.length ? studioCatalog.connectionTypes : CONNECTION_TYPE_CATALOG}
        requestedKind={requestedConnectionKind}
        requestedId={requestedConnectionId}
        onClose={() => { autoSetup.current = false; setConnectionManagerOpen(false); setRequestedConnectionKind(undefined); setRequestedConnectionId(undefined); setConnectionTargetNodeId(undefined); }}
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
    </main>
  );
}
