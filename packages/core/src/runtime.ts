import { createHash } from "node:crypto";
import {
  AdapterError,
  type AdapterRegistry,
  type FinishReason,
  type TokenUsage,
} from "./adapter.js";
import {
  ComponentExecutionError,
  createBuiltinComponentRegistry,
  evaluatePredicate,
  valueAtPointer,
  type ComponentEvent,
  type ComponentExecutionResult,
  type ComponentRegistry,
  type ArtifactReference,
  type RuntimeMetrics,
  type RunSessionContext,
  type RuntimeServices,
  type ServiceExecutionContext,
} from "./component.js";
import {
  compileSpec,
  validateSpec,
  type RuntimeGraphPlan,
  type RuntimeNode,
  type RuntimePlan,
} from "./graph.js";
import {
  ORCHESTRATION_TOOLS,
  publicRunSnapshot,
  RunControl,
  type AgentInstance,
  type OrchestrationEvent,
  type InteractionRequest,
  type InteractionResponse,
  type RunCommand,
  type RunSnapshot,
  type SideEffectCheckpoint,
  type TaskRecord,
  type TeamPlanOutput,
  type TeamRuntimeDefinition,
} from "./orchestration.js";
import { DiagnosticError, type ComponentSpec, type ComponentType, type HarnessSpec } from "./spec.js";
import { runtimeServicesFromProviders, type Citation, type HostProviders, type PersistentPermissionScope } from "./provider.js";
import {
  normalizePermissionDecision,
  requiredToolCapability,
  ToolRegistry,
  type ToolApprovalDecision,
  type ToolApprovalRequest,
} from "./tool.js";

interface RunEventBase {
  runId: string;
  timestamp: string;
  /** Present on all newly produced events; optional only for legacy stored traces. */
  sequence?: number;
}

type OrchestrationRunEvent = OrchestrationEvent extends infer Event
  ? Event extends object ? RunEventBase & Event : never
  : never;

export type RunEvent =
  | (RunEventBase & { type: "run-start"; input: unknown; specVersion: HarnessSpec["version"] })
  | (RunEventBase & {
    type: "node-start";
    nodeId: string;
    componentType: ComponentType;
    inputs: unknown;
    state: unknown;
    iteration: number;
    attempt: number;
  })
  | (RunEventBase & { type: "text-delta"; nodeId: string; text: string; iteration: number })
  | (RunEventBase & { type: "usage"; nodeId: string; usage: TokenUsage; costUsd?: number; iteration: number })
  | (RunEventBase & {
    type: "edge";
    edgeId: string;
    from: { component: string; port: string };
    to: { component: string; port: string };
    active: boolean;
    value?: unknown;
    iteration: number;
  })
  | (RunEventBase & { type: "node-skip"; nodeId: string; reason: string; iteration: number })
  | (RunEventBase & { type: "retry"; nodeId: string; attempt: number; delayMs: number; code: string; iteration: number })
  | (RunEventBase & { type: "iteration"; nodeId: string; iteration: number; phase: "start" | "end"; output?: unknown })
  | (RunEventBase & {
    type: "context-use";
    nodeId: string;
    source: string;
    metadata?: Readonly<Record<string, unknown>>;
    iteration: number;
  })
  | (RunEventBase & { type: "citations"; nodeId: string; citations: readonly Citation[]; invented: readonly string[]; iteration: number })
  | (RunEventBase & {
    type: "context-compaction";
    nodeId: string;
    beforeBytes: number;
    afterBytes: number;
    preserved: readonly string[];
    turn: number;
    iteration: number;
  })
  | (RunEventBase & {
    type: "prompt-cache";
    nodeId: string;
    status: "hit" | "write" | "miss" | "bypass" | "provider-managed";
    mode: "automatic" | "explicit";
    cachedInputTokens?: number;
    cacheWriteInputTokens?: number;
    reason?: string;
    iteration: number;
  })
  | (RunEventBase & {
    type: "tool-call";
    nodeId: string;
    tool: string;
    input: unknown;
    iteration: number;
    callId?: string;
    turn?: number;
    risk?: string;
  })
  | (RunEventBase & {
    type: "tool-approval";
    nodeId: string;
    tool: string;
    callId: string;
    turn: number;
    approved: boolean;
    source?: string;
    reason?: string;
    iteration: number;
  })
  | (RunEventBase & {
    type: "tool-result";
    nodeId: string;
    tool: string;
    ok: boolean;
    output?: unknown;
    error?: string;
    durationMs: number;
    iteration: number;
    callId?: string;
    turn?: number;
  })
  | (RunEventBase & {
    type: "skill-use";
    nodeId: string;
    skill: string;
    resources?: readonly string[];
    trusted?: boolean;
    iteration: number;
  })
  | (RunEventBase & {
    type: "fallback";
    nodeId: string;
    from: string;
    to: string;
    reason: string;
    turn: number;
    iteration: number;
  })
  | (RunEventBase & {
    type: "evaluation";
    nodeId: string;
    evaluator: string;
    passed: boolean;
    score?: number;
    message?: string;
    iteration: number;
  })
  | (RunEventBase & {
    type: "artifact";
    artifact: ArtifactReference;
  })
  | (RunEventBase & {
    type: "artifact-created" | "artifact-updated";
    nodeId: string;
    artifact: ArtifactReference;
  })
  | (RunEventBase & {
    type: "node-end";
    nodeId: string;
    outputs: unknown;
    stateChanges: unknown;
    durationMs: number;
    iteration: number;
  })
  | (RunEventBase & {
    type: "run-end";
    output: unknown;
    state: Readonly<Record<string, unknown>>;
    usage: TokenUsage;
    costUsd: number;
    iterations: number;
    durationMs: number;
    finishReason: FinishReason;
    artifacts?: readonly ArtifactReference[];
  })
  | (RunEventBase & {
    type: "error";
    code: string;
    message: string;
    nodeId?: string;
    adapterId?: string;
    retryable?: boolean;
  })
  | OrchestrationRunEvent;

export type RunStartEvent = Extract<RunEvent, { type: "run-start" }>;
export type NodeStartEvent = Extract<RunEvent, { type: "node-start" }>;
export type TextDeltaEvent = Extract<RunEvent, { type: "text-delta" }>;
export type UsageEvent = Extract<RunEvent, { type: "usage" }>;
export type NodeEndEvent = Extract<RunEvent, { type: "node-end" }>;
export type RunEndEvent = Extract<RunEvent, { type: "run-end" }>;
export type RunErrorEvent = Extract<RunEvent, { type: "error" }>;

export interface RunResult {
  runId: string;
  output: unknown;
  state: Readonly<Record<string, unknown>>;
  usage: TokenUsage;
  costUsd: number;
  iterations: number;
  durationMs: number;
  finishReason: FinishReason;
  artifacts: readonly ArtifactReference[];
  trace: RunEvent[];
}

export interface RunEventSink {
  append(event: RunEvent): void | Promise<void>;
  saveSnapshot?(snapshot: RunSnapshot): void | Promise<void>;
  /** Durably orders an event and its resulting snapshot as one store transaction. */
  commit?(event: RunEvent, snapshot: RunSnapshot): void | Promise<void>;
}

export interface RunStore extends RunEventSink {
  commit(event: RunEvent, snapshot: RunSnapshot): void | Promise<void>;
  readEvents(runId: string, afterSequence?: number): Promise<readonly Readonly<Record<string, unknown>>[]>;
  readSnapshot(runId: string): Promise<RunSnapshot | undefined>;
}

export interface RuntimeOptions {
  env?: Readonly<Record<string, string | undefined>>;
  resolveSecret?: (reference: string) => string | undefined;
  components?: ComponentRegistry;
  tools?: ToolRegistry;
  services?: RuntimeServices;
  eventSink?: RunEventSink;
  providers?: HostProviders;
  harnessId?: string;
}

export interface RunOptions {
  signal?: AbortSignal;
  initialState?: Readonly<Record<string, unknown>>;
  /** Host-provided conversation and file metadata. It never changes HarnessSpec. */
  session?: RunSessionContext;
}

export interface RunHandle {
  readonly runId: string;
  readonly events: AsyncIterable<RunEvent>;
  send(command: RunCommand | unknown): Promise<void>;
  cancel(): Promise<void>;
  result(): Promise<RunResult>;
  snapshot(): RunSnapshot;
}

export class RuntimeError extends Error {
  readonly code: string;
  readonly nodeId: string | undefined;
  readonly adapterId: string | undefined;
  readonly retryable: boolean;

  constructor(
    code: string,
    message: string,
    nodeId?: string,
    cause?: unknown,
    adapterId?: string,
    retryable = false,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RuntimeError";
    this.code = code;
    this.nodeId = nodeId;
    this.adapterId = adapterId;
    this.retryable = retryable;
  }
}

interface GraphExecutionResult extends ComponentExecutionResult {
  readonly state: Readonly<Record<string, unknown>>;
  readonly usage: TokenUsage;
  readonly usageKnown: boolean;
  readonly costUsd: number;
  readonly costKnown: boolean;
  readonly finishReason: FinishReason;
}

interface RunContext {
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly secrets: Set<string>;
  readonly metrics: RuntimeMetrics;
  readonly emit: (event: RunEvent) => void;
  readonly resolveSecret: (reference: string) => string | undefined;
  readonly redact: (value: unknown) => unknown;
  readonly artifactVersions: Map<string, string>;
  readonly control: RunControl;
  readonly staticAgents: Map<string, AgentInstance>;
  readonly session?: RunSessionContext;
  readonly compatibility: boolean;
  readonly sideEffectCheckpoint: (key: string) => SideEffectCheckpoint | undefined;
  readonly saveSideEffectCheckpoint: (key: string, checkpoint: Omit<SideEffectCheckpoint, "updatedAt">) => Promise<void>;
}

interface AgentRuntimeBinding {
  readonly agent: AgentInstance;
  readonly team: TeamRuntimeDefinition;
  readonly capabilities?: readonly string[];
  readonly controlTools?: readonly typeof ORCHESTRATION_TOOLS[number][];
}

interface PreparedNode {
  readonly node: RuntimeNode;
  readonly inputs: Readonly<Record<string, unknown>>;
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<{
    resolve(result: IteratorResult<T>): void;
    reject(error: unknown): void;
  }> = [];
  #closed = false;
  #error: unknown;

  push(value: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ done: false, value });
    else this.#values.push(value);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
  }

  fail(error: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#error = error;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.#values.shift();
        if (value !== undefined) return Promise.resolve({ done: false, value });
        if (this.#error !== undefined) return Promise.reject(this.#error);
        if (this.#closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
      },
    };
  }
}

class RuntimeRunHandle implements RunHandle {
  readonly runId: string;
  readonly events: AsyncIterable<RunEvent>;
  readonly #control: RunControl;
  readonly #queue = new AsyncEventQueue<RunEvent>();
  readonly #result: Promise<RunResult>;

  constructor(runId: string, control: RunControl, source: AsyncIterable<RunEvent>) {
    this.runId = runId;
    this.#control = control;
    this.events = this.#queue;
    this.#result = this.#consume(source);
    void this.#result.catch(() => undefined);
  }

  send(command: RunCommand | unknown): Promise<void> {
    return this.#control.send(command);
  }

  async cancel(): Promise<void> {
    this.#control.cancel("Run cancelled by caller");
    await this.#result.catch(() => undefined);
  }

  result(): Promise<RunResult> {
    return this.#result;
  }

  snapshot(): RunSnapshot {
    return this.#control.snapshot();
  }

  async #consume(source: AsyncIterable<RunEvent>): Promise<RunResult> {
    const trace: RunEvent[] = [];
    let finalEvent: RunEndEvent | undefined;
    try {
      for await (const event of source) {
        trace.push(event);
        this.#queue.push(event);
        if (event.type === "run-end") finalEvent = event;
      }
      if (!finalEvent) throw new RuntimeError("RUN_INCOMPLETE", "Harness run ended without a result");
      return {
        runId: finalEvent.runId,
        output: finalEvent.output,
        state: finalEvent.state,
        usage: finalEvent.usage,
        costUsd: finalEvent.costUsd,
        iterations: finalEvent.iterations,
        durationMs: finalEvent.durationMs,
        finishReason: finalEvent.finishReason,
        artifacts: finalEvent.artifacts ?? [],
        trace,
      };
    } catch (error) {
      this.#queue.fail(error);
      throw error;
    } finally {
      this.#queue.close();
    }
  }
}

const timestamp = (): string => new Date().toISOString();
const elapsed = (started: number): number => Math.max(0, performance.now() - started);
const defaultEnvironment = (): Readonly<Record<string, string | undefined>> =>
  typeof process === "undefined" ? {} : process.env;

const ENV_REFERENCE = /^env:[A-Za-z_][A-Za-z0-9_]*$/;
const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

function collectEnvReferences(value: unknown, references: Set<string>, seen = new WeakSet<object>()): void {
  if (typeof value === "string") {
    if (ENV_REFERENCE.test(value)) references.add(value);
    return;
  }
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectEnvReferences(item, references, seen);
    return;
  }
  for (const item of Object.values(value)) collectEnvReferences(item, references, seen);
}

const sumUsage = (current: TokenUsage, next: TokenUsage): TokenUsage => {
  const inputTokens = (current.inputTokens ?? 0) + (next.inputTokens ?? 0);
  const outputTokens = (current.outputTokens ?? 0) + (next.outputTokens ?? 0);
  const total = (usage: TokenUsage) => usage.totalTokens
    ?? (usage.inputTokens !== undefined && usage.outputTokens !== undefined
      ? usage.inputTokens + usage.outputTokens
      : usage.inputTokens ?? usage.outputTokens ?? 0);
  const totalTokens = total(current) + total(next);
  const cachedInputTokens = (current.cachedInputTokens ?? 0) + (next.cachedInputTokens ?? 0);
  const cacheWriteInputTokens = (current.cacheWriteInputTokens ?? 0) + (next.cacheWriteInputTokens ?? 0);
  return {
    ...(inputTokens === 0 && current.inputTokens === undefined && next.inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === 0 && current.outputTokens === undefined && next.outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === 0 && current.totalTokens === undefined && next.totalTokens === undefined ? {} : { totalTokens }),
    ...(cachedInputTokens === 0 && current.cachedInputTokens === undefined && next.cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(cacheWriteInputTokens === 0 && current.cacheWriteInputTokens === undefined && next.cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens }),
  };
};

function sanitize(
  value: unknown,
  secrets: ReadonlySet<string>,
  seen = new WeakSet<object>(),
  depth = 0,
  maxStringLength = 4_000,
): unknown {
  if (typeof value === "string") {
    let result = value;
    for (const secret of [...secrets].filter(Boolean).sort((left, right) => right.length - left.length)) {
      result = result.replaceAll(secret, "[REDACTED]");
    }
    return result.length > maxStringLength ? `${result.slice(0, maxStringLength)}…[truncated]` : result;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean" || value === undefined) return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return "[Function]";
  if (value instanceof Error) return { name: value.name, message: sanitize(value.message, secrets, seen, depth + 1, maxStringLength) };
  if (typeof value !== "object" || depth >= 8) return "[Unserializable]";
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitize(item, secrets, seen, depth + 1, maxStringLength));
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    result[key] = /(?:api[-_]?key|authorization|secret|token|pass(?:word|phrase)|credentials?|cookies?|private[-_]?key|context[-_]?ref)$/i.test(key)
      ? "[REDACTED]"
      : sanitize(item, secrets, seen, depth + 1, maxStringLength);
  }
  return result;
}

function sanitizeEvent(event: RunEvent, secrets: ReadonlySet<string>): RunEvent {
  const traceEvent = event.type === "run-snapshot" ? {
    ...event,
    snapshot: publicRunSnapshot(event.snapshot),
  } : event;
  return sanitize(traceEvent, secrets, new WeakSet<object>(), 0, event.type === "run-end" ? Number.POSITIVE_INFINITY : 4_000) as RunEvent;
}

function permissionPreview(value: unknown, redact: (value: unknown) => unknown): { readonly value: unknown; readonly limited: boolean } {
  const safe = redact(value);
  let limited = false;
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): unknown => {
    if (depth > 5 || ++nodes > 100) { limited = true; return "[truncated]"; }
    if (typeof candidate === "string") {
      if (candidate.length <= 1_024) return candidate;
      limited = true;
      return `${candidate.slice(0, 1_024)}…[truncated]`;
    }
    if (Array.isArray(candidate)) {
      if (candidate.length > 25) limited = true;
      return candidate.slice(0, 25).map((item) => visit(item, depth + 1));
    }
    if (!candidate || typeof candidate !== "object") return candidate;
    const entries = Object.entries(candidate);
    if (entries.length > 25) limited = true;
    return Object.fromEntries(entries.slice(0, 25).map(([key, item]) => [key, visit(item, depth + 1)]));
  };
  const preview = visit(safe, 0);
  try {
    const serialized = JSON.stringify(preview);
    if (new TextEncoder().encode(serialized).byteLength > 8_192) {
      limited = true;
      return { value: `${serialized.slice(0, 8_192)}…[truncated]`, limited };
    }
  } catch { return { value: "[unavailable]", limited: true }; }
  return { value: preview, limited };
}

function selectedOutput(outputs: Readonly<Record<string, unknown>>): unknown {
  if (Object.hasOwn(outputs, "value")) return outputs.value;
  if (Object.hasOwn(outputs, "response")) return outputs.response;
  const values = Object.values(outputs);
  return values.length === 1 ? values[0] : outputs;
}

function retryDelay(policy: { backoffMs?: number | undefined; maxBackoffMs?: number | undefined }, attempt: number): number {
  const initial = policy.backoffMs ?? 0;
  return Math.min(initial * 2 ** Math.max(0, attempt - 1), policy.maxBackoffMs ?? Number.POSITIVE_INFINITY);
}

function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function withSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export class HarnessRuntime {
  readonly #plan: RuntimePlan;
  readonly #registry: AdapterRegistry;
  readonly #components: ComponentRegistry;
  readonly #tools: ToolRegistry;
  readonly #services: RuntimeServices;
  readonly #eventSink: RunEventSink | undefined;
  readonly #privateSnapshots = new Map<string, RunSnapshot>();
  readonly #providers: HostProviders | undefined;
  readonly #harnessId: string;
  readonly #harnessDigest: string;
  readonly #resolveConfiguredSecret: (reference: string) => string | undefined;

  constructor(spec: HarnessSpec, registry: AdapterRegistry, options: RuntimeOptions = {}) {
    this.#registry = registry;
    this.#components = options.components ?? createBuiltinComponentRegistry();
    this.#tools = options.tools ?? new ToolRegistry();
    this.#providers = options.providers;
    this.#services = options.providers
      ? runtimeServicesFromProviders(options.providers, options.services)
      : options.services ?? {};
    this.#eventSink = options.eventSink ?? options.providers?.runs;
    this.#harnessId = options.harnessId ?? this.#services.harnessId ?? "embedded";
    this.#harnessDigest = createHash("sha256").update(JSON.stringify(spec)).digest("hex");
    const env = options.env ?? defaultEnvironment();
    this.#resolveConfiguredSecret = options.resolveSecret ?? ((reference) =>
      options.services?.resolveSecret?.(reference)
      ?? (reference.startsWith("env:") ? env[reference.slice(4)] : reference));
    const validation = validateSpec(spec, { registry, components: this.#components, tools: this.#tools, env });
    if (!validation.ok) throw new DiagnosticError("HarnessSpec is invalid", validation.diagnostics);
    const compiled = compileSpec(spec, { registry, components: this.#components, tools: this.#tools, env });
    if (!compiled.ok) throw new DiagnosticError("HarnessSpec could not be compiled", compiled.diagnostics);
    this.#plan = compiled.plan;
  }

  start(input: unknown, options: RunOptions = {}, reservedRunId?: string): RunHandle {
    const runId = reservedRunId ?? globalThis.crypto.randomUUID();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId)) throw new Error("Run id is invalid");
    const control = new RunControl(runId);
    return new RuntimeRunHandle(runId, control, this.#execute(input, options, runId, control));
  }

  resume(input: unknown, snapshot: RunSnapshot, options: RunOptions = {}): RunHandle {
    if (snapshot.status !== "running" && snapshot.status !== "paused") {
      throw new Error(`Run '${snapshot.runId}' is not resumable because it is ${snapshot.status}`);
    }
    if (!snapshot.tasks.length && !Object.keys(snapshot.turnCheckpoints ?? {}).length
      && !Object.keys(snapshot.sideEffectCheckpoints ?? {}).length
      && !snapshot.pendingInteractions?.length) throw new RuntimeError(
      "RUN_RESUME_CHECKPOINT_MISSING",
      `Run '${snapshot.runId}' has no durable Task or model-turn checkpoint; restart it explicitly to avoid repeating external side effects`,
    );
    const control = new RunControl(snapshot.runId, snapshot);
    return new RuntimeRunHandle(snapshot.runId, control, this.#execute(input, options, snapshot.runId, control));
  }

  stream(input: unknown, options: RunOptions = {}): AsyncIterable<RunEvent> {
    const runId = globalThis.crypto.randomUUID();
    const control = new RunControl(runId);
    const handle = new RuntimeRunHandle(runId, control, this.#execute(input, options, runId, control, true));
    const canResolveInteraction = (request: InteractionRequest) => Boolean(
      this.#services.requestInteraction
      || (request.kind === "permission" && this.#services.requestToolApproval
        && (this.#services.canResolveInteraction?.(request) ?? true)),
    );
    return {
      async *[Symbol.asyncIterator]() {
        let finished = false;
        try {
          for await (const event of handle.events) {
            if (event.type === "interaction-requested" && !canResolveInteraction(event.request)) {
              await handle.cancel();
              throw new RuntimeError(
                "RUN_INTERACTION_REQUIRED",
                "This compatibility stream requires user input; use start() and RunHandle.send(), or the HTTP v1 Run API",
              );
            }
            yield event;
            if (event.type === "run-end" || event.type === "error") finished = true;
          }
        } finally {
          if (!finished) await handle.cancel();
        }
      },
    };
  }

  async invoke(input: unknown, options: RunOptions = {}): Promise<RunResult> {
    const runId = globalThis.crypto.randomUUID();
    const control = new RunControl(runId);
    const handle = new RuntimeRunHandle(runId, control, this.#execute(input, options, runId, control, true));
    for await (const event of handle.events) {
      if (event.type === "interaction-requested" && !this.#services.requestInteraction
        && !(event.request.kind === "permission" && this.#services.requestToolApproval
          && (this.#services.canResolveInteraction?.(event.request) ?? true))) {
        await handle.cancel();
        throw new RuntimeError(
          "RUN_INTERACTION_REQUIRED",
          "This compatibility invocation requires user input; use start() and RunHandle.send(), or the HTTP v1 Run API",
        );
      }
    }
    return handle.result();
  }

  async #publish(event: RunEvent): Promise<void> {
    if (event.type === "run-snapshot" || event.type === "interaction-requested") {
      const key = `${event.runId}:${event.sequence ?? 0}`;
      const snapshot = this.#privateSnapshots.get(key)
        ?? (event.type === "run-snapshot"
          ? { ...event.snapshot, ...(event.sequence === undefined ? {} : { sequence: event.sequence }) }
          : undefined);
      if (!snapshot) throw new Error("Interaction checkpoint was not captured before publication");
      try {
        if (this.#eventSink?.commit) return void await this.#eventSink.commit(event, snapshot);
        await this.#eventSink?.append(event);
        await this.#eventSink?.saveSnapshot?.(snapshot);
        return;
      } finally { this.#privateSnapshots.delete(key); }
    }
    await this.#eventSink?.append(event);
  }

  #requestInteraction(
    run: RunContext,
    request: Parameters<RunControl["requestInteraction"]>[0],
    context: ServiceExecutionContext,
  ): Promise<InteractionResponse> {
    const pendingBefore = new Set(run.control.snapshot().pendingInteractions?.map(({ id }) => id));
    const waiting = run.control.requestInteraction(request);
    const interaction = run.control.snapshot().pendingInteractions?.find(({ id }) =>
      id === request.id || !pendingBefore.has(id));
    const requestFromService = this.#services.requestInteraction;
    if (interaction && requestFromService) void (async () => {
      try {
        run.control.resolveInteraction(await requestFromService(interaction, context));
      } catch {
        run.control.resolveInteraction({
          interactionId: interaction.id,
          checkpointDigest: interaction.checkpoint.digest,
          action: "cancel",
          ...(interaction.kind === "permission" ? { permission: "deny" } : {}),
        });
      }
    })();
    return waiting;
  }

  async #approveTool(run: RunContext, request: ToolApprovalRequest): Promise<ToolApprovalDecision> {
    const interactionId = `permission_${request.nodeId}_${request.callId}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
    const context = {
      signal: run.signal,
      runId: run.runId,
      nodeId: request.nodeId,
      iteration: 0,
      resolveSecret: run.resolveSecret,
      ...(run.session?.contextRef ? { contextRef: run.session.contextRef } : {}),
    };
    const capability = requiredToolCapability(request.tool)
      ?? (request.tool.risk === "write" ? "workspace-write" : request.tool.risk === "destructive" ? "process" : "network");
    const persistentScope: PersistentPermissionScope = {
      harnessId: this.#harnessId,
      toolId: request.tool.id,
      ...(request.tool.connectionId ? { connectionId: request.tool.connectionId } : {}),
      capability,
      resource: request.tool.action ?? request.tool.id,
    };
    const permissions = this.#providers?.permissions ?? this.#services.providers?.permissions;
    const preview = permissionPreview(request.input, run.redact);
    const resourceResolved = Boolean(persistentScope.resource && persistentScope.resource !== "*" && persistentScope.resource !== "[invalid]");
    const runGrant = run.control.runPermission(request.tool, interactionId);
    if (runGrant) {
      return { approved: true, source: "user", mode: runGrant.permission ?? "allow_for_run", reason: "Allowed by the resolved interaction" };
    }
    if (await permissions?.find(persistentScope, context)) {
      return { approved: true, source: "policy", mode: "allow_always", reason: "Allowed by persistent host policy" };
    }
    const waiting = run.control.requestInteraction({
      id: interactionId,
      nodeId: request.nodeId,
      kind: "permission",
      requester: { kind: request.tool.source === "mcp" ? "mcp" : "tool", id: request.tool.id },
      title: "Tool permission",
      message: `Allow Tool '${request.tool.label}' to run?`,
      blocking: "run",
      data: {
        permission: {
          toolId: request.tool.id,
          ...(request.tool.connectionId ? { connectionId: request.tool.connectionId } : {}),
          ...(request.tool.action ? { action: request.tool.action } : {}),
          capability,
          resource: persistentScope.resource,
        },
        callId: request.callId,
        turn: request.turn,
        risk: request.tool.risk ?? "external",
        input: preview.value,
        previewLimited: preview.limited,
        resourceResolved,
      },
    });
    const interaction = run.control.snapshot().pendingInteractions?.find(({ id }) => id === interactionId) as InteractionRequest | undefined;
    if (interaction) void (async () => {
      try {
        if (this.#services.requestInteraction) {
          run.control.resolveInteraction(await this.#services.requestInteraction(interaction, context));
        } else if (run.compatibility && this.#services.requestToolApproval
          && (this.#services.canResolveInteraction?.(interaction) ?? true)) {
          const decision = await this.#services.requestToolApproval(request, context);
          const permission = normalizePermissionDecision(decision.mode, decision.approved);
          run.control.resolveInteraction({
            interactionId,
            checkpointDigest: interaction.checkpoint.digest,
            action: decision.approved ? "submit" : "decline",
            permission,
            ...(decision.reason ? { value: { reason: decision.reason } } : {}),
          });
        }
      } catch {
        run.control.resolveInteraction({
          interactionId,
          checkpointDigest: interaction.checkpoint.digest,
          action: "decline",
          permission: "deny",
        });
      }
    })();
    const response = await waiting;
    if (response.action === "submit" && response.permission === "allow_always" && permissions) {
      await permissions.grant({ scope: persistentScope, effect: "allow_always" }, context);
    }
    const reason = asRecord(response.value)?.reason;
    return {
      approved: response.action === "submit" && response.permission !== "deny",
      source: "user",
      mode: response.permission ?? "deny",
      ...(typeof reason === "string" ? { reason } : {}),
    };
  }

  async *#execute(
    input: unknown,
    options: RunOptions,
    runId: string,
    control: RunControl,
    compatibility = false,
  ): AsyncIterable<RunEvent> {
    const started = performance.now();
    const timeoutController = new AbortController();
    let timeoutRemaining = this.#plan.runtime.timeoutMs;
    let timeoutStartedAt = 0;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const armTimeout = () => {
      if (timeout || timeoutController.signal.aborted) return;
      timeoutStartedAt = performance.now();
      timeout = setTimeout(() => timeoutController.abort(new DOMException("The operation timed out", "TimeoutError")), timeoutRemaining);
    };
    const pauseTimeout = () => {
      if (!timeout) return;
      clearTimeout(timeout);
      timeout = undefined;
      timeoutRemaining = Math.max(0, timeoutRemaining - (performance.now() - timeoutStartedAt));
    };
    if (control.snapshot().status !== "paused") armTimeout();
    const timeoutSignal = timeoutController.signal;
    const controller = new AbortController();
    const signals = [controller.signal, control.signal, timeoutSignal, ...(options.signal ? [options.signal] : [])];
    const signal = AbortSignal.any(signals);
    const secrets = new Set<string>();
    const queue = new AsyncEventQueue<RunEvent>();
    const metrics: RuntimeMetrics = { startedAt: started, durationMs: 0, iterations: 0, toolCalls: new Map() };
    const resolveSecret = (reference: string) => {
      const value = this.#resolveConfiguredSecret(reference);
      if (value) secrets.add(value);
      return value;
    };
    const declaredReferences = new Set<string>();
    for (const graph of [this.#plan, ...Object.values(this.#plan.subgraphs)]) {
      for (const node of graph.nodes) collectEnvReferences(node.config, declaredReferences);
    }
    for (const adapter of this.#registry.list()) {
      for (const reference of adapter.requiredCredentials ?? []) {
        if (ENV_REFERENCE.test(reference)) declaredReferences.add(reference);
      }
    }
    for (const reference of declaredReferences) resolveSecret(reference);
    const redact = (value: unknown) => sanitize(value, secrets, new WeakSet<object>(), 0, 64_000);
    let sequence = control.snapshot().sequence ?? 0;
    const stamp = (event: RunEvent): RunEvent => {
      const stamped = { ...event, sequence: event.sequence ?? ++sequence };
      control.setSequence(stamped.sequence);
      return stamped;
    };
    const emit = (event: RunEvent) => {
      if (event.type === "run-paused") {
        if (event.paused) pauseTimeout();
        else armTimeout();
      }
      const safe = sanitizeEvent(stamp(event), secrets);
      queue.push(safe);
      return safe;
    };
    const saveSideEffectCheckpoint = async () => {
      const snapshot = control.snapshot();
      if (this.#eventSink?.saveSnapshot) {
        await this.#eventSink.saveSnapshot(snapshot);
      } else if (this.#eventSink?.commit) {
        const event = sanitizeEvent(stamp({
          type: "run-snapshot",
          runId,
          timestamp: timestamp(),
          snapshot,
        }), secrets);
        if (event.type !== "run-snapshot" || event.sequence === undefined) throw new Error("Side-effect checkpoint event is invalid");
        this.#privateSnapshots.set(`${runId}:${event.sequence}`, { ...snapshot, sequence: event.sequence });
        await this.#publish(event);
      }
    };
    const context: RunContext = {
      runId,
      signal,
      secrets,
      metrics,
      emit,
      resolveSecret,
      redact,
      artifactVersions: new Map(),
      control,
      sideEffectCheckpoint: (key) => control.sideEffectCheckpoint(key),
      saveSideEffectCheckpoint: async (key, checkpoint) => {
        control.saveSideEffectCheckpoint(key, checkpoint);
        await saveSideEffectCheckpoint();
      },
      staticAgents: new Map(),
      compatibility,
      ...(options.session ? { session: options.session } : {}),
    };
    const startEvent = sanitizeEvent(stamp({
      type: "run-start",
      runId,
      timestamp: timestamp(),
      input,
      specVersion: this.#plan.sourceVersion,
    }), secrets);
    let terminalPublished = false;
    try {
      await this.#publish(startEvent);
      yield startEvent;
      control.attach(
        (event) => {
          const emitted = emit({ ...event, runId, timestamp: timestamp() } as RunEvent);
          if ((event.type === "run-snapshot" || event.type === "interaction-requested") && emitted.sequence !== undefined) {
            this.#privateSnapshots.set(`${runId}:${emitted.sequence}`, {
              ...(event.type === "run-snapshot" ? event.snapshot : control.snapshot()),
              sequence: emitted.sequence,
            });
          }
        },
      );

      const execution = this.#runGraph(
        this.#plan,
        input,
        options.initialState ?? {},
        "",
        0,
        context,
      );
      void execution.then(
        () => { control.complete("succeeded"); queue.close(); },
        () => { control.complete(control.signal.aborted ? "cancelled" : "failed"); queue.close(); },
      );

      for await (const event of queue) {
        await this.#publish(event);
        yield event;
      }
      const result = await execution;
      metrics.durationMs = elapsed(started);
      const artifacts = [...await this.#services.listArtifacts?.(runId) ?? []];
      for (const artifact of artifacts) {
        const artifactEvent = sanitizeEvent(stamp({
          type: "artifact",
          runId,
          timestamp: timestamp(),
          artifact,
        }), secrets);
        await this.#publish(artifactEvent);
        yield artifactEvent;
      }
      const endEvent = sanitizeEvent(stamp({
        type: "run-end",
        runId,
        timestamp: timestamp(),
        output: result.outputs.value,
        state: result.state,
        usage: result.usage,
        costUsd: result.costUsd,
        iterations: metrics.iterations,
        durationMs: metrics.durationMs,
        finishReason: result.finishReason,
        artifacts,
      }), secrets);
      await this.#publish(endEvent);
      terminalPublished = true;
      yield endEvent;
    } catch (error) {
      controller.abort(error);
      const failure = this.#normalizeRunError(error, control.signal, timeoutSignal, options.signal);
      const errorEvent = sanitizeEvent(stamp({
        type: "error",
        runId,
        timestamp: timestamp(),
        code: failure.code,
        message: failure.message,
        ...(failure.nodeId === undefined ? {} : { nodeId: failure.nodeId }),
        ...(failure.adapterId === undefined ? {} : { adapterId: failure.adapterId }),
        ...(failure.retryable ? { retryable: true } : {}),
      }), secrets);
      await this.#publish(errorEvent);
      terminalPublished = true;
      yield errorEvent;
      throw new RuntimeError(
        failure.code,
        errorEvent.type === "error" ? errorEvent.message : failure.message,
        failure.nodeId,
        undefined,
        failure.adapterId,
        failure.retryable,
      );
    } finally {
      pauseTimeout();
      const cancelled = new RuntimeError("RUN_CANCELLED", "Harness stream consumer stopped");
      controller.abort(cancelled);
      queue.close();
      if (!terminalPublished) {
        const cancelEvent = sanitizeEvent(stamp({
          type: "error",
          runId,
          timestamp: timestamp(),
          code: cancelled.code,
          message: cancelled.message,
        }), secrets);
        await this.#publish(cancelEvent);
      }
      await this.#services.releaseRun?.(runId);
    }
  }

  async #runGraph(
    plan: RuntimeGraphPlan,
    input: unknown,
    initialState: Readonly<Record<string, unknown>>,
    scope: string,
    iteration: number,
    run: RunContext,
    agentBinding?: AgentRuntimeBinding,
  ): Promise<GraphExecutionResult> {
    let state: Record<string, unknown> = { ...initialState };
    let usage: TokenUsage = {};
    let usageKnown = true;
    let costUsd = 0;
    let costKnown = true;
    let finishReason: FinishReason = "unknown";
    const outputs = new Map<string, Readonly<Record<string, unknown>>>();
    const skipped = new Set<string>();
    const nodes = new Map(plan.nodes.map((node) => [node.id, node]));

    for (const layer of plan.layers) {
      run.signal.throwIfAborted();
      run.metrics.durationMs = elapsed(run.metrics.startedAt);
      const prepared: PreparedNode[] = [];
      const stateWrites = new Map<string, { value: unknown; merge: "replace" | "append" }[]>();

      for (const nodeId of layer) {
        const node = nodes.get(nodeId);
        if (!node) throw new RuntimeError("PLAN_INVALID", `Plan references missing node '${nodeId}'`);
        const definition = this.#components.get(node.type);
        const inputValues: Record<string, unknown[]> = {};
        let activeEdges = 0;
        const incoming = plan.edges.filter((edge) => edge.to.component === node.id);
        for (const edge of incoming) {
          const source = outputs.get(edge.from.component);
          const hasValue = source !== undefined && Object.hasOwn(source, edge.from.port) && !skipped.has(edge.from.component);
          const raw = hasValue ? source[edge.from.port] : undefined;
          const active = hasValue && (!edge.condition || evaluatePredicate(edge.condition, raw, state, input));
          const value = active ? valueAtPointer(raw, edge.select ?? "") : undefined;
          run.emit({
            type: "edge",
            runId: run.runId,
            timestamp: timestamp(),
            edgeId: this.#scoped(scope, edge.id),
            from: edge.from,
            to: edge.to,
            active,
            ...(active ? { value } : {}),
            iteration,
          });
          if (!active) {
            if (node.type === "join" && node.config.mode === "object"
              && definition.ports.inputs[edge.to.port]?.variadic) {
              const values = inputValues[edge.to.port] ?? [];
              values.push(undefined);
              inputValues[edge.to.port] = values;
            }
            continue;
          }
          activeEdges += 1;
          const values = inputValues[edge.to.port] ?? [];
          values.push(value);
          inputValues[edge.to.port] = values;
          if (edge.state) {
            const writes = stateWrites.get(edge.state.key) ?? [];
            writes.push({ value, merge: edge.state.merge ?? "replace" });
            stateWrites.set(edge.state.key, writes);
          }
        }

        const inputs: Record<string, unknown> = {};
        for (const [port, values] of Object.entries(inputValues)) {
          inputs[port] = definition.ports.inputs[port]?.variadic ? values : values[0];
        }
        const missingRequired = Object.entries(definition.ports.inputs)
          .some(([port, portDefinition]) => portDefinition.required && inputValues[port]?.length === undefined);
        if ((incoming.length > 0 && activeEdges === 0) || missingRequired) {
          skipped.add(node.id);
          run.emit({
            type: "node-skip",
            runId: run.runId,
            timestamp: timestamp(),
            nodeId: this.#scoped(scope, node.id),
            reason: missingRequired ? "required input is inactive" : "all incoming edges are inactive",
            iteration,
          });
          continue;
        }
        prepared.push({ node, inputs });
      }

      for (const [key, writes] of stateWrites) {
        const replacements = writes.filter((write) => write.merge === "replace");
        if (replacements.length > 1) throw new RuntimeError(
          "STATE_WRITE_CONFLICT",
          `Parallel edges attempted to replace state '${key}'`,
        );
        if (replacements[0]) state[key] = replacements[0].value;
        const appended = writes.filter((write) => write.merge === "append").map(({ value }) => value);
        if (appended.length > 0) state[key] = [...(Array.isArray(state[key]) ? state[key] as unknown[] : []), ...appended];
      }

      const layerController = new AbortController();
      const layerSignal = AbortSignal.any([run.signal, layerController.signal]);
      let firstError: unknown;
      const settled = await Promise.allSettled(prepared.map(async ({ node, inputs: nodeInputs }) => {
        try {
          return await this.#runNode(plan, node, nodeInputs, state, input, scope, iteration, layerSignal, run, agentBinding);
        } catch (error) {
          if (firstError === undefined) {
            firstError = error;
            layerController.abort(error);
          }
          throw error;
        }
      }));
      if (firstError !== undefined) throw firstError;

      const stateChanges = new Map<string, unknown>();
      for (let index = 0; index < prepared.length; index += 1) {
        const execution = settled[index];
        if (!execution || execution.status !== "fulfilled") continue;
        const node = prepared[index]?.node;
        if (!node) continue;
        outputs.set(node.id, execution.value.outputs);
        usage = sumUsage(usage, execution.value.usage ?? {});
        if (execution.value.usageKnown === false
          || (execution.value.usage !== undefined && execution.value.usage.totalTokens === undefined
            && (execution.value.usage.inputTokens === undefined || execution.value.usage.outputTokens === undefined))) usageKnown = false;
        costUsd += execution.value.costUsd ?? 0;
        if (execution.value.costKnown === false) costKnown = false;
        if (execution.value.finishReason && execution.value.finishReason !== "unknown") finishReason = execution.value.finishReason;
        for (const [key, value] of Object.entries(execution.value.state ?? {})) {
          if (stateChanges.has(key)) throw new RuntimeError(
            "STATE_WRITE_CONFLICT", `Parallel nodes attempted to write state '${key}'`, this.#scoped(scope, node.id),
          );
          stateChanges.set(key, value);
        }
      }
      state = { ...state, ...Object.fromEntries(stateChanges) };

      const budget = this.#plan.runtime.budget;
      if (budget?.maxTokens !== undefined && (usage.totalTokens ?? 0) > budget.maxTokens) {
        throw new RuntimeError("RUN_TOKEN_LIMIT", `Run exceeded ${budget.maxTokens} tokens`);
      }
      if (budget?.maxTokens !== undefined && !usageKnown) {
        throw new RuntimeError("RUN_TOKEN_USAGE_UNAVAILABLE", "Run token budget cannot be enforced because usage data is unavailable");
      }
      if (budget?.maxCostUsd !== undefined && costUsd > budget.maxCostUsd) {
        throw new RuntimeError("RUN_COST_LIMIT", `Run exceeded $${budget.maxCostUsd}`);
      }
      if (budget?.maxCostUsd !== undefined && !costKnown) {
        throw new RuntimeError("RUN_COST_UNAVAILABLE", "Run cost cannot be enforced because model pricing or token usage is unavailable");
      }
    }

    if (skipped.has(plan.entrypoint)) throw new RuntimeError("ENTRYPOINT_SKIPPED", "The entrypoint was skipped because its branch was inactive", this.#scoped(scope, plan.entrypoint));
    const entrypointOutput = outputs.get(plan.entrypoint);
    if (!entrypointOutput) throw new RuntimeError("RUN_INCOMPLETE", "Graph ended without an entrypoint output", this.#scoped(scope, plan.entrypoint));
    const output = selectedOutput(entrypointOutput);
    return {
      outputs: Object.hasOwn(entrypointOutput, "value")
        ? entrypointOutput
        : { ...entrypointOutput, value: output },
      state,
      usage,
      usageKnown,
      costUsd,
      costKnown,
      finishReason: finishReason === "unknown" ? "stop" : finishReason,
      traceOutput: output,
    };
  }

  async #runNode(
    plan: RuntimeGraphPlan,
    node: RuntimeNode,
    inputs: Readonly<Record<string, unknown>>,
    state: Readonly<Record<string, unknown>>,
    graphInput: unknown,
    scope: string,
    iteration: number,
    parentSignal: AbortSignal,
    run: RunContext,
    agentBinding?: AgentRuntimeBinding,
  ): Promise<ComponentExecutionResult> {
    const definition = this.#components.get(node.type);
    const nodeId = this.#scoped(scope, node.id);
    let effectiveAgent = agentBinding;
    let staticAgent = false;
    if (!effectiveAgent && node.type === "agent" && this.#plan.sourceVersion === "0.3") {
      const team: TeamRuntimeDefinition = {
        orchestrator: node.id,
        members: [],
        limits: { maxInstances: 128, maxDepth: 1, maxParallel: 1, maxMessages: 128, maxPlanRevisions: 1 },
      };
      run.control.registerTeam("run", team);
      let agent = run.staticAgents.get(nodeId);
      if (!agent) {
        agent = run.control.spawnAgent("run", node.id, team.limits);
        run.staticAgents.set(nodeId, agent);
      }
      run.control.startAgent(agent.id);
      effectiveAgent = { agent, team, controlTools: [] };
      staticAgent = true;
    }
    const started = performance.now();
    const configuredTimeout = node.policy?.timeoutMs
      ?? (node.type === "agent" && typeof node.config.timeoutMs === "number" ? node.config.timeoutMs : undefined);
    const timeoutSignal = configuredTimeout === undefined ? undefined : AbortSignal.timeout(configuredTimeout);
    const signal = timeoutSignal ? AbortSignal.any([parentSignal, timeoutSignal]) : parentSignal;
    const retry = node.policy?.retry ?? this.#plan.runtime.retry;
    let retriedUsage: TokenUsage = {};
    let retriedUsageSeen = false;
    let retriedUsageKnown = true;
    let retriedCostUsd = 0;
    let retriedCostKnown = true;

    for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
      let emittedOutput = false;
      let attemptUsage: TokenUsage | undefined;
      let attemptCostUsd: number | undefined;
      run.emit({
        type: "node-start",
        runId: run.runId,
        timestamp: timestamp(),
        nodeId,
        componentType: node.type,
        inputs: definition.traceInputs?.(inputs) ?? inputs,
        state,
        iteration,
        attempt,
      });
      try {
        const responseSchema = this.#responseSchema(plan, node.id);
        const result = await withSignal(Promise.resolve().then(() => definition.execute(node as ComponentSpec, inputs, {
          signal,
          runId: run.runId,
          nodeId,
          iteration,
          runInput: graphInput,
          ...(run.session ? { session: run.session } : {}),
          state,
          adapters: this.#registry,
          tools: this.#tools,
          services: this.#services,
          metrics: run.metrics,
          harnessDigest: this.#harnessDigest,
          contextPolicy: this.#plan.runtime.context,
          ...(responseSchema ? { responseSchema } : {}),
          resolveSecret: run.resolveSecret,
          redact: run.redact,
          emit: (event) => {
            if (event.type === "text-delta" || event.type === "tool-call" || event.type === "tool-result") emittedOutput = true;
            if (event.type === "usage") {
              attemptUsage = event.usage;
              attemptCostUsd = event.costUsd;
            }
            this.#emitComponentEvent(event, nodeId, iteration, run);
          },
          runSubgraph: async (name, subgraphInput, options = {}) => {
            const subgraph = this.#plan.subgraphs[name];
            if (!subgraph) throw new ComponentExecutionError("SUBGRAPH_NOT_FOUND", `Subgraph '${name}' does not exist`);
            return this.#runGraph(
              subgraph,
              subgraphInput,
              options.state ?? state,
              `${nodeId}/${name}`,
              options.iteration ?? iteration,
              { ...run, signal: options.signal ?? signal },
              effectiveAgent,
            );
          },
          runTeam: (name, teamInput) => this.#runTeam(
            name,
            teamInput,
            state,
            `${nodeId}/${name}`,
            iteration,
            signal,
            run,
          ),
          requestInteraction: (request) => this.#requestInteraction(run, request, {
            signal,
            runId: run.runId,
            nodeId,
            iteration,
            resolveSecret: run.resolveSecret,
            ...(run.session?.contextRef ? { contextRef: run.session.contextRef } : {}),
          }),
          requestToolApproval: (request) => this.#approveTool(run, request),
          sideEffectCheckpoint: run.sideEffectCheckpoint,
          saveSideEffectCheckpoint: run.saveSideEffectCheckpoint,
          ...(effectiveAgent ? {
            agentControl: {
              agentId: effectiveAgent.agent.id,
              ...(effectiveAgent.agent.taskId ? { taskId: effectiveAgent.agent.taskId } : {}),
              ...(effectiveAgent.capabilities ? { capabilities: effectiveAgent.capabilities } : {}),
              tools: effectiveAgent.controlTools ?? ORCHESTRATION_TOOLS,
              checkpoint: async () => run.control.checkpoint(effectiveAgent!.agent.id),
              turnCheckpoint: () => run.control.turnCheckpoint(
                `${effectiveAgent!.agent.taskId ?? "run"}:${nodeId}:${iteration}`,
              ),
              saveTurnCheckpoint: async (checkpoint) => {
                run.control.saveTurnCheckpoint(
                  `${effectiveAgent!.agent.taskId ?? "run"}:${nodeId}:${iteration}`,
                  checkpoint,
                );
                await this.#eventSink?.saveSnapshot?.(run.control.snapshot());
              },
              execute: async (toolId: string, toolInput: unknown) => {
                if (toolId === "harnest.request_help") {
                  const help = await this.#requestAgentHelp(
                    effectiveAgent!, toolInput, state, nodeId, iteration, signal, run,
                  );
                  return {
                    value: selectedOutput(help.outputs),
                    ...(help.usage ? { usage: help.usage } : {}),
                    ...(help.usageKnown === undefined ? {} : { usageKnown: help.usageKnown }),
                    ...(help.costUsd === undefined ? {} : { costUsd: help.costUsd }),
                    ...(help.costKnown === undefined ? {} : { costKnown: help.costKnown }),
                    ...(help.finishReason ? { finishReason: help.finishReason } : {}),
                  };
                }
                return { value: await run.control.executeAgentTool(effectiveAgent!.team, effectiveAgent!.agent.id, toolId, toolInput) };
              },
            },
          } : {}),
        })), signal);
        if (staticAgent && effectiveAgent) run.control.finishAgent(effectiveAgent.agent.id);
        run.emit({
          type: "node-end",
          runId: run.runId,
          timestamp: timestamp(),
          nodeId,
          outputs: result.traceOutput ?? result.outputs,
          stateChanges: result.state ?? {},
          durationMs: elapsed(started),
          iteration,
        });
        await this.#discoverArtifacts(run, nodeId);
        const successfulUsage = result.usage ?? attemptUsage;
        const usageSeen = retriedUsageSeen || successfulUsage !== undefined || result.usageKnown !== undefined;
        const successfulUsageKnown = result.usageKnown
          ?? (successfulUsage === undefined || successfulUsage.totalTokens !== undefined
            || (successfulUsage.inputTokens !== undefined && successfulUsage.outputTokens !== undefined));
        const successfulCost = result.costUsd ?? attemptCostUsd;
        const costSeen = retriedUsageSeen || successfulCost !== undefined || result.costKnown !== undefined;
        const successfulCostKnown = result.costKnown ?? (successfulCost !== undefined);
        return {
          ...result,
          ...(usageSeen ? {
            usage: sumUsage(retriedUsage, successfulUsage ?? {}),
            usageKnown: retriedUsageKnown && successfulUsageKnown,
          } : {}),
          ...(costSeen ? {
            costUsd: retriedCostUsd + (successfulCost ?? 0),
            costKnown: retriedCostKnown && successfulCostKnown,
          } : {}),
        };
      } catch (error) {
        if (staticAgent && effectiveAgent) run.control.finishAgent(effectiveAgent.agent.id, signal.aborted ? "cancelled" : "failed");
        const failure = timeoutSignal?.aborted && !parentSignal.aborted
          ? new RuntimeError(
              this.#plan.sourceVersion === "0.1" && node.type === "agent" && node.policy === undefined ? "RUN_TIMEOUT" : "NODE_TIMEOUT",
              this.#plan.sourceVersion === "0.1" && node.type === "agent" && node.policy === undefined
                ? "Harness run timed out"
                : `Node '${nodeId}' timed out`,
              nodeId,
              error,
            )
          : this.#normalizeNodeError(error, nodeId);
        const canRetry = definition.retrySafe === true && failure.retryable && !emittedOutput && attempt < retry.maxAttempts;
        if (!canRetry) throw failure;
        if (attemptUsage !== undefined) {
          retriedUsage = sumUsage(retriedUsage, attemptUsage);
          retriedUsageSeen = true;
          retriedUsageKnown = retriedUsageKnown && (attemptUsage.totalTokens !== undefined
            || (attemptUsage.inputTokens !== undefined && attemptUsage.outputTokens !== undefined));
          retriedCostUsd += attemptCostUsd ?? 0;
          retriedCostKnown = retriedCostKnown && attemptCostUsd !== undefined;
        }
        const delayMs = retryDelay(retry, attempt);
        run.emit({
          type: "retry",
          runId: run.runId,
          timestamp: timestamp(),
          nodeId,
          attempt: attempt + 1,
          delayMs,
          code: failure.code,
          iteration,
        });
        await waitFor(delayMs, signal);
      }
    }
    throw new RuntimeError("RETRY_EXHAUSTED", `Node '${nodeId}' exhausted retries`, nodeId);
  }

  async #requestAgentHelp(
    requester: AgentRuntimeBinding,
    input: unknown,
    state: Readonly<Record<string, unknown>>,
    scope: string,
    iteration: number,
    signal: AbortSignal,
    run: RunContext,
  ): Promise<ComponentExecutionResult> {
    const activeWorkers = run.control.snapshot().agents.filter((agent) =>
      agent.teamId === requester.agent.teamId && agent.taskId && agent.status === "running").length;
    if (activeWorkers >= requester.team.limits.maxParallel) {
      throw new ComponentExecutionError(
        "TEAM_PARALLEL_LIMIT",
        `Team '${requester.agent.teamId}' cannot synchronously add help beyond ${requester.team.limits.maxParallel} parallel Agents`,
      );
    }
    const task = await run.control.executeAgentTool(
      requester.team,
      requester.agent.id,
      "harnest.request_help",
      input,
    ) as TaskRecord;
    const agent = run.control.spawnAgent(
      requester.agent.teamId,
      task.assignee,
      requester.team.limits,
      requester.agent.id,
      task.id,
    );
    const taskSignal = run.control.startTask(task.id, agent.id, signal);
    try {
      const result = await this.#runAgentTemplate(
        task.assignee,
        { phase: "help", originalRequest: input, task, requestedBy: requester.agent.id },
        state,
        `${scope}/${agent.id}`,
        iteration,
        taskSignal,
        run,
        { agent, team: requester.team },
      );
      run.control.recordAgentUsage(agent.id, result.usage, result.costUsd);
      run.control.finishTask(task.id, selectedOutput(result.outputs), await this.#services.listArtifacts?.(run.runId) ?? []);
      return result;
    } catch (error) {
      run.control.failTask(task.id, error);
      throw error;
    }
  }

  async #runTeam(
    name: string,
    input: unknown,
    state: Readonly<Record<string, unknown>>,
    scope: string,
    iteration: number,
    signal: AbortSignal,
    run: RunContext,
  ): Promise<ComponentExecutionResult> {
    const team = this.#plan.teams[name];
    if (!team) throw new ComponentExecutionError("TEAM_NOT_FOUND", `Team '${name}' does not exist`);
    run.control.registerTeam(name, team);
    const resumedTasks = run.control.tasks(name);
    const orchestrator = run.control.snapshot().agents.findLast((agent) => agent.teamId === name && agent.template === team.orchestrator)
      ?? run.control.spawnAgent(name, team.orchestrator, team.limits);
    run.control.startAgent(orchestrator.id);

    let usage: TokenUsage = {};
    let usageKnown = true;
    let costUsd = 0;
    let costKnown = true;
    let finishReason: FinishReason = "unknown";
    const accumulate = (result: ComponentExecutionResult) => {
      usage = sumUsage(usage, result.usage ?? {});
      if (result.usageKnown === false) usageKnown = false;
      costUsd += result.costUsd ?? 0;
      if (result.costKnown === false) costKnown = false;
      if (result.finishReason && result.finishReason !== "unknown") finishReason = result.finishReason;
    };

    try {
      const planned = resumedTasks.length ? undefined : await this.#runAgentTemplate(
        team.orchestrator,
        {
          phase: "plan",
          originalRequest: input,
          instruction: "Return either a direct finalAnswer or a bounded task list using only allowed member template ids.",
          team: { id: name, members: team.members, limits: team.limits },
        },
        state,
        `${scope}/${orchestrator.id}`,
        iteration,
        signal,
        run,
        { agent: orchestrator, team },
      );
      if (planned) {
        run.control.recordAgentUsage(orchestrator.id, planned.usage, planned.costUsd);
        accumulate(planned);
        const planValue = selectedOutput(planned.outputs);
        const plan = this.#teamPlan(planValue);
        if (!plan.tasks?.length) {
          run.control.finishAgent(orchestrator.id);
          return {
            outputs: { value: plan.finalAnswer ?? planValue },
            usage,
            usageKnown,
            costUsd,
            costKnown,
            finishReason: finishReason === "unknown" ? "stop" : finishReason,
          };
        }
        if (plan.tasks.length > team.limits.maxInstances - 1) throw new ComponentExecutionError(
          "TEAM_INSTANCE_LIMIT",
          `Team '${name}' planned ${plan.tasks.length} tasks but allows ${team.limits.maxInstances - 1}`,
        );
        for (const task of plan.tasks) {
          if (!team.members.includes(task.agent)) throw new ComponentExecutionError(
            "TEAM_MEMBER_NOT_ALLOWED",
            `Team '${name}' cannot assign Agent template '${task.agent}'`,
          );
        }
        const taskIds = new Set(plan.tasks.map(({ id }) => id));
        for (const task of plan.tasks) for (const dependency of task.dependsOn ?? []) if (!taskIds.has(dependency)) {
          throw new ComponentExecutionError("TEAM_DEPENDENCY_MISSING", `Task '${task.id}' depends on missing Task '${dependency}'`);
        }
        run.control.replacePlan(name, orchestrator.id, plan.tasks, "Initial Team plan");
      }

      while (true) {
        signal.throwIfAborted();
        run.control.acceptPending(name, orchestrator.id);
        if (!run.control.tasks(name).some((task) => task.status === "queued" || task.status === "blocked")) break;
        const ready = run.control.readyTasks(name).slice(0, team.limits.maxParallel);
        if (!ready.length) {
          if (run.control.tasks(name).some((task) => task.status === "blocked")) {
            await run.control.waitForChange(signal);
            continue;
          }
          throw new ComponentExecutionError("TEAM_TASKS_BLOCKED", `Team '${name}' has no runnable Task; check dependencies`);
        }
        const settled = await Promise.all(ready.map(async (task) => {
          const agent = run.control.spawnAgent(name, task.assignee, team.limits, orchestrator.id, task.id);
          const taskSignal = run.control.startTask(task.id, agent.id, signal);
          try {
            const result = await this.#runAgentTemplate(
              task.assignee,
              {
                phase: "execute",
                originalRequest: input,
                task,
                planRevision: run.control.snapshot().revision,
                completedTasks: run.control.tasks(name).filter((candidate) => candidate.status === "completed")
                  .map(({ id: taskId, result: taskResult }) => ({ id: taskId, result: taskResult })),
              },
              state,
              `${scope}/${agent.id}`,
              iteration,
              taskSignal,
              run,
              { agent, team },
            );
            const value = selectedOutput(result.outputs);
            run.control.recordAgentUsage(agent.id, result.usage, result.costUsd);
            run.control.finishTask(task.id, value, await this.#services.listArtifacts?.(run.runId) ?? []);
            return { ok: true as const, result };
          } catch (error) {
            run.control.failTask(task.id, error);
            return { ok: false as const, error };
          }
        }));
        for (const result of settled) if (result.ok) accumulate(result.result);
        const failure = settled.find((result) => !result.ok);
        if (failure && !failure.ok) throw new ComponentExecutionError(
          "TEAM_TASK_FAILED",
          failure.error instanceof Error ? failure.error.message : `Team '${name}' Task failed`,
          { cause: failure.error },
        );
      }

      const synthesized = await this.#runAgentTemplate(
        team.orchestrator,
        {
          phase: "synthesize",
          originalRequest: input,
          instruction: "Produce only the final user-facing answer. Do not expose internal plans, messages, or Agent state.",
          results: run.control.tasks(name).map(({ id: taskId, goal, status, result, error }) => ({ taskId, goal, status, result, error })),
        },
        state,
        `${scope}/${orchestrator.id}/synthesize`,
        iteration,
        signal,
        run,
        { agent: orchestrator, team },
      );
      run.control.recordAgentUsage(orchestrator.id, synthesized.usage, synthesized.costUsd);
      accumulate(synthesized);
      run.control.finishAgent(orchestrator.id);
      const finalValue = selectedOutput(synthesized.outputs);
      const finalPlan = this.#teamPlan(finalValue);
      return {
        outputs: { value: finalPlan.finalAnswer ?? finalValue },
        usage,
        usageKnown,
        costUsd,
        costKnown,
        finishReason: finishReason === "unknown" ? "stop" : finishReason,
      };
    } catch (error) {
      run.control.finishAgent(orchestrator.id, signal.aborted ? "cancelled" : "failed");
      throw error;
    }
  }

  #teamPlan(value: unknown): TeamPlanOutput {
    let candidate = value;
    if (typeof candidate === "string") {
      try { candidate = JSON.parse(candidate) as unknown; } catch { return { status: "direct", finalAnswer: value }; }
    }
    const record = asRecord(candidate);
    if (!record) return { status: "direct", finalAnswer: value };
    const rawTasks = Array.isArray(record.tasks) ? record.tasks : [];
    const usedIds = new Set<string>();
    const normalizedIds = new Map<string, string>();
    const parsed = rawTasks.map((item, index) => {
      const task = asRecord(item);
      if (!task || typeof task.goal !== "string" || typeof task.agent !== "string") {
        throw new ComponentExecutionError("TEAM_PLAN_INVALID", `Team plan Task ${index + 1} is invalid`);
      }
      const originalId = typeof task.id === "string" ? task.id : `task_${index + 1}`;
      let base = originalId.trim().replace(/[^A-Za-z0-9_-]+/gu, "_").replace(/^[_-]+|[_-]+$/gu, "");
      if (!/^[A-Za-z]/u.test(base)) base = `task_${base || index + 1}`;
      base = base.slice(0, 120);
      let id = base;
      for (let suffix = 2; usedIds.has(id); suffix += 1) id = `${base.slice(0, 120)}_${suffix}`;
      usedIds.add(id);
      if (!normalizedIds.has(originalId)) normalizedIds.set(originalId, id);
      return {
        id,
        goal: task.goal,
        agent: task.agent,
        ...(Array.isArray(task.dependsOn) ? { dependsOn: task.dependsOn.filter((id): id is string => typeof id === "string") } : {}),
      };
    });
    const tasks = parsed.map((task) => ({
      ...task,
      ...(task.dependsOn ? { dependsOn: task.dependsOn.map((dependency) => normalizedIds.get(dependency) ?? dependency) } : {}),
    }));
    return {
      ...(record.status === "direct" || record.status === "tasks" || record.status === "complete" ? { status: record.status } : {}),
      ...(Object.hasOwn(record, "finalAnswer") ? { finalAnswer: record.finalAnswer } : {}),
      ...(tasks.length ? { tasks } : {}),
    };
  }

  async #runAgentTemplate(
    templateId: string,
    input: unknown,
    state: Readonly<Record<string, unknown>>,
    scope: string,
    iteration: number,
    signal: AbortSignal,
    run: RunContext,
    binding: AgentRuntimeBinding,
  ): Promise<ComponentExecutionResult> {
    const template = this.#plan.agentTemplates[templateId];
    if (!template) throw new ComponentExecutionError("AGENT_TEMPLATE_NOT_FOUND", `Agent template '${templateId}' does not exist`);
    const effectiveBinding: AgentRuntimeBinding = { ...binding, capabilities: template.capabilities ?? [] };
    if ("subgraph" in template.runner) {
      const graph = this.#plan.subgraphs[template.runner.subgraph];
      if (!graph) throw new ComponentExecutionError("AGENT_TEMPLATE_SUBGRAPH_MISSING", `Subgraph '${template.runner.subgraph}' does not exist`);
      return this.#runGraph(graph, input, state, `${scope}/${template.runner.subgraph}`, iteration, { ...run, signal }, effectiveBinding);
    }
    return this.#runA2A(template.runner.a2a.connection, input, scope, iteration, signal, run);
  }

  async #runA2A(
    connectionId: string,
    input: unknown,
    nodeId: string,
    iteration: number,
    signal: AbortSignal,
    run: RunContext,
  ): Promise<ComponentExecutionResult> {
    if (!this.#services.resolveConnection || !this.#services.fetchProvider) {
      throw new ComponentExecutionError("A2A_SERVICE_UNAVAILABLE", "This runtime cannot call remote A2A Agents");
    }
    const serviceContext = { signal, runId: run.runId, nodeId, iteration, resolveSecret: run.resolveSecret };
    const resolved = await this.#services.resolveConnection(connectionId, serviceContext);
    const config = asRecord(resolved.value);
    const endpoint = typeof config?.url === "string" ? config.url
      : typeof config?.baseUrl === "string" ? config.baseUrl : undefined;
    if (!endpoint) throw new ComponentExecutionError("A2A_ENDPOINT_MISSING", `Connection '${connectionId}' has no A2A endpoint`);
    let url: URL;
    try { url = new URL(endpoint); } catch { throw new ComponentExecutionError("A2A_ENDPOINT_INVALID", `Connection '${connectionId}' endpoint is invalid`); }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new ComponentExecutionError("A2A_ENDPOINT_INVALID", "A2A endpoint must use HTTP or HTTPS");
    }
    const headers = new Headers({ "content-type": "application/json", accept: "application/json, text/event-stream" });
    const credentialOrigin = url.origin;
    const references = asRecord(config?.credentialReferences);
    const authorizationReference = references?.authorization ?? references?.token ?? references?.apiKey;
    if (typeof authorizationReference === "string") {
      const secret = run.resolveSecret(authorizationReference);
      if (secret) headers.set("authorization", /^\S+\s+/u.test(secret) ? secret : `Bearer ${secret}`);
    }
    let streaming = false;
    let cardUrl: URL;
    try {
      cardUrl = typeof config?.agentCardUrl === "string" ? new URL(config.agentCardUrl)
        : new URL("/.well-known/agent-card.json", url);
    } catch {
      throw new ComponentExecutionError("A2A_CARD_INVALID", `Connection '${connectionId}' Agent Card URL is invalid`);
    }
    if (config?.discoverAgentCard !== false) {
      try {
        const cardHeaders = new Headers(headers);
        if (cardUrl.origin !== credentialOrigin) cardHeaders.delete("authorization");
        const cardResponse = await this.#services.fetchProvider(cardUrl, { headers: cardHeaders, signal, redirect: "error" }, serviceContext);
        if (cardResponse.ok) {
          const card = asRecord(JSON.parse(await cardResponse.text()) as unknown);
          if (typeof card?.url === "string") url = new URL(card.url, cardUrl);
          if (headers.has("authorization") && url.origin !== credentialOrigin) throw new ComponentExecutionError(
            "A2A_ENDPOINT_ORIGIN_CHANGED", "A2A Agent Card cannot redirect Connection credentials to another origin",
          );
          streaming = asRecord(card?.capabilities)?.streaming === true;
        } else if (typeof config?.agentCardUrl === "string") {
          throw new ComponentExecutionError("A2A_CARD_FAILED", `A2A Agent Card returned HTTP ${cardResponse.status}`);
        }
      } catch (error) {
        if (typeof config?.agentCardUrl === "string" || error instanceof ComponentExecutionError) throw error;
        // Optional discovery falls back to the explicitly configured task endpoint.
      }
    }
    const messageId = globalThis.crypto.randomUUID();
    const requestBody = (method: "message/send" | "message/stream") => JSON.stringify({
      jsonrpc: "2.0",
      id: messageId,
      method,
      params: {
        message: {
          role: "user",
          messageId,
          parts: [{ kind: "text", text: typeof input === "string" ? input : JSON.stringify(input) }],
        },
      },
    });
    let response = await this.#services.fetchProvider(url, {
      method: "POST", headers, body: requestBody(streaming ? "message/stream" : "message/send"), signal, redirect: "error",
    }, serviceContext);
    if (streaming && (response.status === 404 || response.status === 405 || response.status === 501)) response = await this.#services.fetchProvider(url, {
      method: "POST", headers, body: requestBody("message/send"), signal, redirect: "error",
    }, serviceContext);
    const body = await response.text();
    if (response.status === 401) throw new ComponentExecutionError("A2A_AUTH_REQUIRED", "A2A authentication is missing or expired");
    if (response.status === 403) throw new ComponentExecutionError("A2A_SCOPE_REQUIRED", "A2A connection does not have the required scope");
    if (!response.ok) throw new ComponentExecutionError(
      response.status === 408 || response.status === 504 ? "A2A_TIMEOUT" : "A2A_REQUEST_FAILED",
      `A2A Agent returned HTTP ${response.status}: ${body.slice(0, 500)}`,
      { retryable: response.status === 408 || response.status === 429 || response.status >= 500 },
    );
    let payload: unknown;
    try {
      if (response.headers.get("content-type")?.toLocaleLowerCase().includes("text/event-stream")) {
        const values = body.split(/\r?\n/u).filter((line) => line.startsWith("data:"))
          .map((line) => JSON.parse(line.slice(5).trim()) as unknown);
        payload = values.findLast((value) => asRecord(value)?.result !== undefined) ?? values.at(-1);
      } else payload = JSON.parse(body) as unknown;
    } catch {
      throw new ComponentExecutionError("A2A_RESPONSE_INVALID", "A2A Agent returned invalid JSON or event data");
    }
    const envelope = asRecord(payload);
    if (envelope?.error) throw new ComponentExecutionError("A2A_REMOTE_ERROR", JSON.stringify(envelope.error).slice(0, 1_000));
    const result = envelope?.result;
    return { outputs: { value: this.#a2aText(result) ?? result }, traceOutput: { connectionId, remote: true } };
  }

  #a2aText(value: unknown, depth = 0): string | undefined {
    if (depth > 6 || value === null || value === undefined) return undefined;
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      const parts = value.flatMap((item) => this.#a2aText(item, depth + 1) ?? []);
      return parts.length ? parts.join("\n") : undefined;
    }
    const record = asRecord(value);
    if (!record) return undefined;
    if (typeof record.text === "string") return record.text;
    for (const key of ["parts", "message", "status", "artifacts"]) {
      const text = this.#a2aText(record[key], depth + 1);
      if (text) return text;
    }
    return undefined;
  }

  #emitComponentEvent(event: ComponentEvent, nodeId: string, iteration: number, run: RunContext): void {
    const base = { runId: run.runId, timestamp: timestamp(), nodeId, iteration };
    if (event.type === "text-delta") run.emit({ ...base, type: "text-delta", text: event.text });
    else if (event.type === "usage") run.emit({ ...base, type: "usage", usage: event.usage, ...(event.costUsd === undefined ? {} : { costUsd: event.costUsd }) });
    else if (event.type === "context-use") run.emit({ ...base, type: "context-use", source: event.source, ...(event.metadata ? { metadata: event.metadata } : {}) });
    else if (event.type === "citations") run.emit({ ...base, type: "citations", citations: event.citations, invented: event.invented });
    else if (event.type === "context-compaction") run.emit({
      ...base,
      type: "context-compaction",
      beforeBytes: event.beforeBytes,
      afterBytes: event.afterBytes,
      preserved: event.preserved,
      turn: event.turn,
    });
    else if (event.type === "prompt-cache") run.emit({
      ...base,
      type: "prompt-cache",
      status: event.status,
      mode: event.mode,
      ...(event.cachedInputTokens === undefined ? {} : { cachedInputTokens: event.cachedInputTokens }),
      ...(event.cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens: event.cacheWriteInputTokens }),
      ...(event.reason === undefined ? {} : { reason: event.reason }),
    });
    else if (event.type === "tool-call") {
      run.metrics.toolCalls.set(event.tool, (run.metrics.toolCalls.get(event.tool) ?? 0) + 1);
      run.emit({
        ...base,
        type: "tool-call",
        tool: event.tool,
        input: event.input,
        ...(event.callId === undefined ? {} : { callId: event.callId }),
        ...(event.turn === undefined ? {} : { turn: event.turn }),
        ...(event.risk === undefined ? {} : { risk: event.risk }),
      });
    } else if (event.type === "tool-approval") run.emit({
      ...base,
      type: "tool-approval",
      tool: event.tool,
      callId: event.callId,
      turn: event.turn,
      approved: event.approved,
      ...(event.source === undefined ? {} : { source: event.source }),
      ...(event.reason === undefined ? {} : { reason: event.reason }),
    });
    else if (event.type === "tool-result") run.emit({
      ...base,
      type: "tool-result",
      tool: event.tool,
      ok: event.ok,
      ...(event.output === undefined ? {} : { output: event.output }),
      ...(event.error === undefined ? {} : { error: event.error }),
      durationMs: event.durationMs,
      ...(event.callId === undefined ? {} : { callId: event.callId }),
      ...(event.turn === undefined ? {} : { turn: event.turn }),
    });
    else if (event.type === "skill-use") run.emit({
      ...base,
      type: "skill-use",
      skill: event.skill,
      ...(event.resources === undefined ? {} : { resources: event.resources }),
      ...(event.trusted === undefined ? {} : { trusted: event.trusted }),
    });
    else if (event.type === "fallback") run.emit({
      ...base,
      type: "fallback",
      from: event.from,
      to: event.to,
      reason: event.reason,
      turn: event.turn,
    });
    else if (event.type === "evaluation") run.emit({
      ...base,
      type: "evaluation",
      evaluator: event.evaluator,
      passed: event.passed,
      ...(event.score === undefined ? {} : { score: event.score }),
      ...(event.message === undefined ? {} : { message: event.message }),
    });
    else run.emit({
      ...base,
      type: "iteration",
      iteration: event.iteration,
      phase: event.phase,
      ...(event.output === undefined ? {} : { output: event.output }),
    });
  }

  async #discoverArtifacts(run: RunContext, nodeId: string): Promise<void> {
    if (!this.#services.listArtifacts) return;
    const artifacts = await this.#services.listArtifacts(run.runId);
    for (const artifact of artifacts) {
      const version = `${artifact.status}:${artifact.sha256 ?? ""}:${artifact.size}`;
      const previous = run.artifactVersions.get(artifact.id);
      if (previous === version) continue;
      run.artifactVersions.set(artifact.id, version);
      run.emit({
        type: previous === undefined ? "artifact-created" : "artifact-updated",
        runId: run.runId,
        timestamp: timestamp(),
        nodeId,
        artifact,
      });
    }
  }

  #responseSchema(plan: RuntimeGraphPlan, nodeId: string): Readonly<Record<string, unknown>> | undefined {
    const outputEdge = plan.edges.find((edge) => edge.from.component === nodeId
      && plan.nodes.find((node) => node.id === edge.to.component)?.type === "output");
    const output = outputEdge ? plan.nodes.find((node) => node.id === outputEdge.to.component) : undefined;
    return output?.config.schema && typeof output.config.schema === "object"
      ? output.config.schema as Readonly<Record<string, unknown>>
      : undefined;
  }

  #scoped(scope: string, nodeId: string): string {
    return scope ? `${scope}/${nodeId}` : nodeId;
  }

  #normalizeNodeError(error: unknown, nodeId: string): RuntimeError {
    if (error instanceof RuntimeError) return error.nodeId ? error : new RuntimeError(
      error.code, error.message, nodeId, error, error.adapterId, error.retryable,
    );
    if (error instanceof AdapterError) return new RuntimeError(
      error.code, error.message, nodeId, error, error.adapterId, error.retryable,
    );
    if (error instanceof ComponentExecutionError) return new RuntimeError(
      error.code, error.message, nodeId, error, undefined, error.retryable,
    );
    return new RuntimeError("NODE_FAILED", error instanceof Error ? error.message : "Node execution failed", nodeId, error);
  }

  #normalizeRunError(
    error: unknown,
    controlSignal: AbortSignal,
    timeoutSignal: AbortSignal,
    externalSignal: AbortSignal | undefined,
  ): RuntimeError {
    if (timeoutSignal.aborted && !externalSignal?.aborted) return new RuntimeError("RUN_TIMEOUT", "Harness run timed out", undefined, error);
    if (externalSignal?.aborted) return new RuntimeError("RUN_CANCELLED", "Harness run was cancelled", undefined, error);
    if (controlSignal.aborted) return new RuntimeError("RUN_CANCELLED", "Harness run was cancelled", undefined, error);
    if (error instanceof RuntimeError) return error;
    return new RuntimeError("RUN_FAILED", error instanceof Error ? error.message : "Harness run failed", undefined, error);
  }
}
