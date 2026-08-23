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
  type RuntimeMetrics,
  type RunSessionContext,
  type RuntimeServices,
} from "./component.js";
import {
  compileSpec,
  validateSpec,
  type RuntimeGraphPlan,
  type RuntimeNode,
  type RuntimePlan,
} from "./graph.js";
import { DiagnosticError, type ComponentSpec, type ComponentType, type HarnessSpec } from "./spec.js";
import { ToolRegistry } from "./tool.js";

interface RunEventBase {
  runId: string;
  timestamp: string;
}

export type RunEvent =
  | (RunEventBase & { type: "run-start"; input: unknown; specVersion: "0.1" | "0.2" })
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
  })
  | (RunEventBase & {
    type: "error";
    code: string;
    message: string;
    nodeId?: string;
    adapterId?: string;
    retryable?: boolean;
  });

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
  trace: RunEvent[];
}

export interface RunEventSink {
  append(event: RunEvent): void | Promise<void>;
}

export interface RuntimeOptions {
  env?: Readonly<Record<string, string | undefined>>;
  resolveSecret?: (reference: string) => string | undefined;
  components?: ComponentRegistry;
  tools?: ToolRegistry;
  services?: RuntimeServices;
  eventSink?: RunEventSink;
}

export interface RunOptions {
  signal?: AbortSignal;
  initialState?: Readonly<Record<string, unknown>>;
  /** Host-provided conversation and file metadata. It never changes HarnessSpec. */
  session?: RunSessionContext;
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
  readonly session?: RunSessionContext;
}

interface PreparedNode {
  readonly node: RuntimeNode;
  readonly inputs: Readonly<Record<string, unknown>>;
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<(result: IteratorResult<T>) => void> = [];
  #closed = false;

  push(value: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.#values.push(value);
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.#values.shift();
        if (value !== undefined) return Promise.resolve({ done: false, value });
        if (this.#closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

const timestamp = (): string => new Date().toISOString();
const elapsed = (started: number): number => Math.max(0, performance.now() - started);
const defaultEnvironment = (): Readonly<Record<string, string | undefined>> =>
  typeof process === "undefined" ? {} : process.env;

const ENV_REFERENCE = /^env:[A-Za-z_][A-Za-z0-9_]*$/;

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
  return {
    ...(inputTokens === 0 && current.inputTokens === undefined && next.inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === 0 && current.outputTokens === undefined && next.outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === 0 && current.totalTokens === undefined && next.totalTokens === undefined ? {} : { totalTokens }),
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
    result[key] = /(?:api[-_]?key|authorization|secret|token|pass(?:word|phrase)|credentials?|cookies?|private[-_]?key)$/i.test(key)
      ? "[REDACTED]"
      : sanitize(item, secrets, seen, depth + 1, maxStringLength);
  }
  return result;
}

function sanitizeEvent(event: RunEvent, secrets: ReadonlySet<string>): RunEvent {
  return sanitize(event, secrets, new WeakSet<object>(), 0, event.type === "run-end" ? Number.POSITIVE_INFINITY : 4_000) as RunEvent;
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
  readonly #resolveConfiguredSecret: (reference: string) => string | undefined;

  constructor(spec: HarnessSpec, registry: AdapterRegistry, options: RuntimeOptions = {}) {
    this.#registry = registry;
    this.#components = options.components ?? createBuiltinComponentRegistry();
    this.#tools = options.tools ?? new ToolRegistry();
    this.#services = options.services ?? {};
    this.#eventSink = options.eventSink;
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

  stream(input: unknown, options: RunOptions = {}): AsyncIterable<RunEvent> {
    return this.#execute(input, options);
  }

  async invoke(input: unknown, options: RunOptions = {}): Promise<RunResult> {
    const trace: RunEvent[] = [];
    let finalEvent: RunEndEvent | undefined;
    for await (const event of this.stream(input, options)) {
      trace.push(event);
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
      trace,
    };
  }

  async #publish(event: RunEvent): Promise<void> {
    await this.#eventSink?.append(event);
  }

  async *#execute(input: unknown, options: RunOptions): AsyncIterable<RunEvent> {
    const runId = globalThis.crypto.randomUUID();
    const started = performance.now();
    const timeoutSignal = AbortSignal.timeout(this.#plan.runtime.timeoutMs);
    const controller = new AbortController();
    const signals = [controller.signal, timeoutSignal, ...(options.signal ? [options.signal] : [])];
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
    const emit = (event: RunEvent) => queue.push(sanitizeEvent(event, secrets));
    const context: RunContext = {
      runId,
      signal,
      secrets,
      metrics,
      emit,
      resolveSecret,
      redact,
      ...(options.session ? { session: options.session } : {}),
    };
    const startEvent = sanitizeEvent({
      type: "run-start",
      runId,
      timestamp: timestamp(),
      input,
      specVersion: this.#plan.sourceVersion,
    }, secrets);
    let terminalPublished = false;
    try {
      await this.#publish(startEvent);
      yield startEvent;

      const execution = this.#runGraph(
        this.#plan,
        input,
        options.initialState ?? {},
        "",
        0,
        context,
      );
      void execution.then(() => queue.close(), () => queue.close());

      for await (const event of queue) {
        await this.#publish(event);
        yield event;
      }
      const result = await execution;
      metrics.durationMs = elapsed(started);
      const endEvent = sanitizeEvent({
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
      }, secrets);
      await this.#publish(endEvent);
      terminalPublished = true;
      yield endEvent;
    } catch (error) {
      controller.abort(error);
      const failure = this.#normalizeRunError(error, signal, timeoutSignal, options.signal);
      const errorEvent = sanitizeEvent({
        type: "error",
        runId,
        timestamp: timestamp(),
        code: failure.code,
        message: failure.message,
        ...(failure.nodeId === undefined ? {} : { nodeId: failure.nodeId }),
        ...(failure.adapterId === undefined ? {} : { adapterId: failure.adapterId }),
        ...(failure.retryable ? { retryable: true } : {}),
      }, secrets);
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
      const cancelled = new RuntimeError("RUN_CANCELLED", "Harness stream consumer stopped");
      controller.abort(cancelled);
      queue.close();
      if (!terminalPublished) {
        const cancelEvent = sanitizeEvent({
          type: "error",
          runId,
          timestamp: timestamp(),
          code: cancelled.code,
          message: cancelled.message,
        }, secrets);
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
          return await this.#runNode(plan, node, nodeInputs, state, input, scope, iteration, layerSignal, run);
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
  ): Promise<ComponentExecutionResult> {
    const definition = this.#components.get(node.type);
    const nodeId = this.#scoped(scope, node.id);
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
            );
          },
        })), signal);
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

  #emitComponentEvent(event: ComponentEvent, nodeId: string, iteration: number, run: RunContext): void {
    const base = { runId: run.runId, timestamp: timestamp(), nodeId, iteration };
    if (event.type === "text-delta") run.emit({ ...base, type: "text-delta", text: event.text });
    else if (event.type === "usage") run.emit({ ...base, type: "usage", usage: event.usage, ...(event.costUsd === undefined ? {} : { costUsd: event.costUsd }) });
    else if (event.type === "context-use") run.emit({ ...base, type: "context-use", source: event.source, ...(event.metadata ? { metadata: event.metadata } : {}) });
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
    signal: AbortSignal,
    timeoutSignal: AbortSignal,
    externalSignal: AbortSignal | undefined,
  ): RuntimeError {
    if (timeoutSignal.aborted && !externalSignal?.aborted) return new RuntimeError("RUN_TIMEOUT", "Harness run timed out", undefined, error);
    if (externalSignal?.aborted) return new RuntimeError("RUN_CANCELLED", "Harness run was cancelled", undefined, error);
    if (error instanceof RuntimeError) return error;
    if (signal.aborted) return new RuntimeError("RUN_CANCELLED", "Harness run was cancelled", undefined, error);
    return new RuntimeError("RUN_FAILED", error instanceof Error ? error.message : "Harness run failed", undefined, error);
  }
}
