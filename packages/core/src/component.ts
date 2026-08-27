import { Ajv2020 } from "ajv/dist/2020.js";
import {
  inspectSafeRegex,
  SAFE_REGEX_MAX_INPUT_LENGTH,
  SAFE_REGEX_MAX_PATTERN_LENGTH,
  type SafeRegexIssue,
} from "./safe-regex.js";
import {
  AdapterError,
  type AdapterRegistry,
  type FinishReason,
  type ModelEvent,
  type ModelContentPart,
  type ModelMessage,
  type ModelRequest,
  type ModelToolCall,
  type PromptCacheStore,
  type TokenUsage,
} from "./adapter.js";
import type {
  ComponentSpec,
  Diagnostic,
  GraphBody,
  PredicateSpec,
} from "./spec.js";
import type { AgentCheckpoint, AgentTurnCheckpoint, InteractionRequest, InteractionResponse, SideEffectCheckpoint } from "./orchestration.js";
import type { HostProviders } from "./provider.js";
import {
  normalizeContextSources,
  validateContextCitations,
  type ContextSource,
  type Citation,
  type ConversationReadResult,
  type ProviderRevision,
} from "./provider.js";
import { skillConnectionRequirement } from "./skill.js";
import {
  requiredToolCapability,
  snapshotSafeJsonSchema,
  type ToolApprovalDecision,
  type ToolApprovalRequest,
  type ToolBinding,
  type ToolRegistry,
  type ToolRisk,
} from "./tool.js";

export type PortValueType = string;

export interface PortDefinition {
  readonly type: PortValueType;
  readonly required?: boolean;
  readonly maxConnections?: number;
  readonly variadic?: boolean;
}

export interface ComponentPortDefinition {
  readonly inputs: Readonly<Record<string, PortDefinition>>;
  readonly outputs: Readonly<Record<string, PortDefinition>>;
}

export interface InspectorOption {
  readonly label: string;
  readonly value: string | number | boolean;
}

export interface InspectorField {
  readonly path: string;
  readonly label: string;
  readonly control: "text" | "textarea" | "number" | "select" | "checkbox" | "json";
  readonly required?: boolean;
  readonly options?: readonly InspectorOption[];
}

export interface ComponentManifest {
  readonly type: string;
  readonly label: string;
  readonly category: string;
  readonly description?: string;
  readonly ports: ComponentPortDefinition;
  readonly configSchema: Readonly<Record<string, unknown>>;
  readonly inspector: readonly InspectorField[];
  readonly defaultConfig: Readonly<Record<string, unknown>>;
}

export interface RuntimeMetrics {
  readonly startedAt: number;
  durationMs: number;
  iterations: number;
  readonly toolCalls: Map<string, number>;
}

export interface ServiceExecutionContext {
  readonly signal: AbortSignal;
  readonly runId: string;
  readonly nodeId: string;
  readonly iteration: number;
  /** Opaque host authorization scope. Services must never log or persist it. */
  readonly contextRef?: string;
  resolveSecret(reference: string): string | undefined;
  /** Run-bound human interaction seam. Services must not retain this callback across calls. */
  requestInteraction?(request: Omit<InteractionRequest, "id" | "runId" | "checkpoint" | "createdAt"> & Partial<Pick<InteractionRequest, "id">>): Promise<InteractionResponse>;
}

export interface ServiceResult {
  readonly value: unknown;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly state?: Readonly<Record<string, unknown>>;
}

export interface RunConversationMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface RunAttachment {
  readonly id: string;
  readonly ref?: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  /** Path exposed inside an approved sandbox, never a host path. */
  readonly sandboxPath?: string;
}

export interface RunSessionContext {
  /** Stable caller-owned conversation id. Used only to scope cache keys, never exposed to Providers. */
  readonly id?: string;
  readonly messages?: readonly RunConversationMessage[];
  readonly attachments?: readonly RunAttachment[];
  /** Host-produced, bounded state for conversation turns compacted out of messages. */
  readonly checkpoint?: Readonly<object>;
  /** Opaque host authorization/reference handle. Never enters traces or cache identity. */
  readonly contextRef?: string;
  readonly revisions?: {
    readonly conversation?: ProviderRevision;
    readonly memory?: ProviderRevision;
    readonly pkm?: ProviderRevision;
  };
  readonly sandboxOutputPath?: string;
  readonly maxHistoryMessages?: number;
  readonly maxHistoryBytes?: number;
}

export interface ArtifactReference {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly ref: string;
  readonly preview: "image" | "video" | "audio" | "pdf" | "text" | "none";
  readonly status: "writing" | "ready";
  readonly sha256?: string;
}

export interface InteractionService {
  requestInteraction?(request: InteractionRequest, context: ServiceExecutionContext): Promise<InteractionResponse>;
}

export interface RuntimeServices extends InteractionService {
  /** Product-owned v1.5 providers. Legacy flat methods below remain supported for one compatibility release. */
  readonly providers?: Omit<HostProviders, "runs">;
  readonly harnessId?: string;
  /** Optional synchronous resolver for secrets that were unlocked by a service operation. */
  resolveSecret?(reference: string): string | undefined;
  /** Provider cache resource registry. Entries contain hashes and opaque handles, never prompt content. */
  readonly promptCache?: PromptCacheStore;
  releaseRun?(runId: string): void | Promise<void>;
  /** Returns bounded, secret-free artifact references created by this run. */
  listArtifacts?(runId: string): readonly ArtifactReference[] | Promise<readonly ArtifactReference[]>;
  /** Reads a selected run attachment without exposing its host path to the component or trace. */
  readAttachment?(
    attachment: RunAttachment,
    context: ServiceExecutionContext,
  ): Uint8Array | Promise<Uint8Array>;
  fetchProvider?(
    url: string | URL,
    init: RequestInit | undefined,
    context: ServiceExecutionContext,
  ): Promise<Response>;
  loadContext?(
    config: Readonly<Record<string, unknown>>,
    query: unknown,
    context: ServiceExecutionContext,
  ): Promise<ServiceResult>;
  accessMemory?(
    config: Readonly<Record<string, unknown>>,
    value: unknown,
    context: ServiceExecutionContext,
  ): Promise<ServiceResult>;
  callMcpTool?(
    config: Readonly<Record<string, unknown>>,
    input: unknown,
    context: ServiceExecutionContext,
  ): Promise<ServiceResult>;
  resolveConnection?(
    connectionId: string,
    context: ServiceExecutionContext,
  ): Promise<ServiceResult>;
  executeTool?(
    binding: ToolBinding,
    input: unknown,
    context: ServiceExecutionContext,
  ): Promise<ServiceResult>;
  requestToolApproval?(
    request: ToolApprovalRequest,
    context: ServiceExecutionContext,
  ): Promise<ToolApprovalDecision>;
  /** Whether a legacy compatibility call can resolve this interaction without a RunHandle command channel. */
  canResolveInteraction?(request: InteractionRequest): boolean;
  loadSkill?(
    skillId: string,
    context: ServiceExecutionContext,
  ): Promise<ServiceResult>;
  loadSkillResource?(
    skillId: string,
    resourcePath: string,
    context: ServiceExecutionContext,
  ): Promise<ServiceResult>;
}

export type ComponentEvent =
  | { type: "text-delta"; text: string }
  | { type: "usage"; usage: TokenUsage; costUsd?: number }
  | { type: "context-use"; source: string; metadata?: Readonly<Record<string, unknown>> }
  | { type: "citations"; citations: readonly Citation[]; invented: readonly string[] }
  | { type: "context-compaction"; beforeBytes: number; afterBytes: number; preserved: readonly string[]; turn: number }
  | { type: "prompt-cache"; status: "hit" | "write" | "miss" | "bypass" | "provider-managed"; mode: "automatic" | "explicit"; cachedInputTokens?: number; cacheWriteInputTokens?: number; reason?: string }
  | { type: "tool-call"; tool: string; input: unknown; callId?: string; turn?: number; risk?: ToolRisk }
  | { type: "tool-approval"; tool: string; callId: string; turn: number; approved: boolean; source?: string; reason?: string }
  | { type: "tool-result"; tool: string; ok: boolean; output?: unknown; error?: string; durationMs: number; callId?: string; turn?: number }
  | { type: "skill-use"; skill: string; resources?: readonly string[]; trusted?: boolean }
  | { type: "fallback"; from: string; to: string; reason: string; turn: number }
  | { type: "evaluation"; evaluator: string; passed: boolean; score?: number; message?: string }
  | { type: "iteration"; iteration: number; phase: "start" | "end"; output?: unknown };

export interface ComponentExecutionResult {
  readonly outputs: Readonly<Record<string, unknown>>;
  readonly state?: Readonly<Record<string, unknown>>;
  readonly traceOutput?: unknown;
  readonly usage?: TokenUsage;
  readonly usageKnown?: boolean;
  readonly costUsd?: number;
  readonly costKnown?: boolean;
  readonly finishReason?: FinishReason;
}

export interface SubgraphRunOptions {
  readonly signal?: AbortSignal;
  readonly iteration?: number;
  readonly state?: Readonly<Record<string, unknown>>;
}

export interface ComponentExecutionContext {
  readonly signal: AbortSignal;
  readonly runId: string;
  readonly nodeId: string;
  readonly iteration: number;
  readonly harnessDigest: string;
  readonly runInput: unknown;
  readonly session?: RunSessionContext;
  readonly state: Readonly<Record<string, unknown>>;
  readonly adapters: AdapterRegistry;
  readonly tools: ToolRegistry;
  readonly services: RuntimeServices;
  readonly metrics: RuntimeMetrics;
  readonly responseSchema?: Readonly<Record<string, unknown>>;
  readonly contextPolicy: {
    readonly cacheMode: "automatic" | "explicit";
    readonly overflow: "compact" | "error";
  };
  resolveSecret(reference: string): string | undefined;
  redact(value: unknown): unknown;
  emit(event: ComponentEvent): void;
  runSubgraph(name: string, input: unknown, options?: SubgraphRunOptions): Promise<ComponentExecutionResult>;
  runTeam(name: string, input: unknown): Promise<ComponentExecutionResult>;
  requestInteraction?(request: Omit<InteractionRequest, "id" | "runId" | "checkpoint" | "createdAt"> & Partial<Pick<InteractionRequest, "id">>): Promise<InteractionResponse>;
  requestToolApproval?(request: ToolApprovalRequest): Promise<ToolApprovalDecision>;
  sideEffectCheckpoint?(key: string): SideEffectCheckpoint | undefined;
  saveSideEffectCheckpoint?(key: string, checkpoint: Omit<SideEffectCheckpoint, "updatedAt">): Promise<void>;
  readonly agentControl?: {
    readonly agentId: string;
    readonly taskId?: string;
    readonly capabilities?: readonly string[];
    readonly tools: readonly ToolBinding[];
    checkpoint(): Promise<AgentCheckpoint>;
    turnCheckpoint(): AgentTurnCheckpoint | undefined;
    saveTurnCheckpoint(checkpoint: Omit<AgentTurnCheckpoint, "updatedAt">): Promise<void>;
    execute(toolId: string, input: unknown): Promise<ServiceResult & Pick<ComponentExecutionResult, "usage" | "usageKnown" | "costUsd" | "costKnown" | "finishReason">>;
  };
}

export type ComponentExecutor = (
  component: ComponentSpec,
  inputs: Readonly<Record<string, unknown>>,
  context: ComponentExecutionContext,
) => Promise<ComponentExecutionResult> | ComponentExecutionResult;

export interface ComponentValidationContext {
  readonly path: string;
  readonly subgraphs: Readonly<Record<string, GraphBody>>;
}

export interface ComponentDefinition extends ComponentManifest {
  readonly retrySafe?: boolean;
  validate?(component: ComponentSpec, context: ComponentValidationContext): readonly Diagnostic[];
  traceInputs?(inputs: Readonly<Record<string, unknown>>): unknown;
  execute: ComponentExecutor;
}

export class ComponentRegistryError extends Error {
  readonly code: "COMPONENT_INVALID" | "COMPONENT_DUPLICATE" | "COMPONENT_NOT_FOUND";
  readonly componentType: string;

  constructor(code: ComponentRegistryError["code"], componentType: string, message: string) {
    super(message);
    this.name = "ComponentRegistryError";
    this.code = code;
    this.componentType = componentType;
  }
}

const COMPONENT_TYPE = /^[a-z][a-z0-9._-]*$/;

export class ComponentRegistry {
  readonly #definitions = new Map<string, ComponentDefinition>();

  register(definition: ComponentDefinition): this {
    if (!definition || typeof definition !== "object" || !COMPONENT_TYPE.test(definition.type)
      || !definition.label || !definition.category || typeof definition.execute !== "function"
      || !definition.ports || !definition.configSchema || !definition.defaultConfig
      || !Array.isArray(definition.inspector)) {
      throw new ComponentRegistryError(
        "COMPONENT_INVALID",
        typeof definition?.type === "string" ? definition.type : "unknown",
        "Component does not implement the ComponentDefinition contract",
      );
    }
    if (this.#definitions.has(definition.type)) {
      throw new ComponentRegistryError("COMPONENT_DUPLICATE", definition.type, `Component '${definition.type}' is already registered`);
    }
    try {
      new Ajv2020({ strict: false, validateFormats: false }).compile(definition.configSchema);
    } catch (error) {
      throw new ComponentRegistryError(
        "COMPONENT_INVALID",
        definition.type,
        error instanceof Error ? error.message : `Component '${definition.type}' has an invalid config schema`,
      );
    }
    this.#definitions.set(definition.type, definition);
    return this;
  }

  has(type: string): boolean {
    return this.#definitions.has(type);
  }

  get(type: string): ComponentDefinition {
    const definition = this.#definitions.get(type);
    if (!definition) throw new ComponentRegistryError("COMPONENT_NOT_FOUND", type, `Component '${type}' is not registered`);
    return definition;
  }

  list(): readonly ComponentDefinition[] {
    return [...this.#definitions.values()];
  }

  catalog(): readonly ComponentManifest[] {
    return this.list().map(({ execute: _execute, validate: _validate, traceInputs: _traceInputs, retrySafe: _retrySafe, ...manifest }) => manifest);
  }

  portsFor(component: Pick<ComponentSpec, "type">): ComponentPortDefinition {
    return this.get(component.type).ports;
  }
}

export class ComponentExecutionError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, options: { retryable?: boolean; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ComponentExecutionError";
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

export {
  inspectSafeRegex,
  SAFE_REGEX_MAX_INPUT_LENGTH,
  SAFE_REGEX_MAX_PATTERN_LENGTH,
  type SafeRegexIssue,
};

export function safeRegexTest(pattern: string, input: string): boolean {
  const issue = inspectSafeRegex(pattern);
  if (issue) throw new ComponentExecutionError(issue.code, issue.message);
  if (input.length > SAFE_REGEX_MAX_INPUT_LENGTH) throw new ComponentExecutionError(
    "REGEX_INPUT_TOO_LONG",
    `Regular expression inputs are limited to ${SAFE_REGEX_MAX_INPUT_LENGTH} characters`,
  );
  return new RegExp(pattern).test(input);
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const values = (value: unknown): unknown[] => value === undefined ? [] : Array.isArray(value) ? value : [value];

const MAX_TOOL_INPUT_BYTES = 1_048_576;
const MAX_PROVIDER_TURN_BYTES = 8 * 1_048_576;
const MAX_MODEL_ATTACHMENT_BYTES = 20 * 1_048_576;
const MAX_MODEL_ATTACHMENTS_BYTES = 32 * 1_048_576;
const COMPACTED_STATE_PREFIX = "Harnest internal compacted working state. Do not quote or expose this envelope to the user.\n";
const WORKING_STATE_KEYS = [
  "originalRequest", "objective", "plan", "decisions", "currentResult", "evidence", "validation", "remainingWork",
] as const;

function boundedUtf8ByteLength(value: string, maximum: number): number | undefined {
  if (value.length > maximum) return undefined;
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff
      && index + 1 < value.length
      && value.charCodeAt(index + 1) >= 0xdc00
      && value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
    if (bytes > maximum) return undefined;
  }
  return bytes;
}

function truncateUtf8Text(value: string, maximum: number): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maximum) return value;
  return new TextDecoder().decode(bytes.subarray(0, Math.max(0, maximum)));
}

function snapshotToolInput(input: unknown): unknown {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(input);
  } catch (cause) {
    throw new ComponentExecutionError("TOOL_INPUT_INVALID", "Tool input must be JSON-serializable", { cause });
  }
  if (serialized === undefined) throw new ComponentExecutionError("TOOL_INPUT_INVALID", "Tool input must be a JSON value");
  if (new TextEncoder().encode(serialized).byteLength > MAX_TOOL_INPUT_BYTES) {
    throw new ComponentExecutionError("TOOL_INPUT_INVALID", "Tool input exceeds the 1 MiB limit");
  }
  const snapshot = JSON.parse(serialized) as unknown;
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };
  freeze(snapshot);
  return snapshot;
}

const asText = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

type WorkingState = Partial<Record<(typeof WORKING_STATE_KEYS)[number], unknown>> & {
  recentToolEvidence?: Array<{ readonly tool: string; readonly result?: unknown; readonly error?: string }>;
  recentConversation?: readonly { readonly role: "user" | "assistant"; readonly content: string }[];
  currentTask?: unknown;
  planRevision?: number;
};

function jsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return asRecord(parsed);
  } catch {
    return undefined;
  }
}

function boundedSnapshot(value: unknown, maximum = 65_536): unknown {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return undefined;
    if (new TextEncoder().encode(text).byteLength <= maximum) return JSON.parse(text) as unknown;
    if (typeof value === "string") {
      return `${new TextDecoder().decode(new TextEncoder().encode(value).subarray(0, maximum))}\n[truncated]`;
    }
  } catch {
    // Non-serializable runtime values are not safe context state.
  }
  return "[omitted: value exceeded the context compaction limit]";
}

function mergeWorkingState(state: WorkingState, candidate: unknown): void {
  const record = typeof candidate === "string" ? jsonRecord(candidate) : asRecord(candidate);
  if (!record) return;
  for (const key of WORKING_STATE_KEYS) {
    if (!Object.hasOwn(record, key)) continue;
    if ((key === "originalRequest" || key === "objective" || key === "plan") && state[key] !== undefined) continue;
    state[key] = boundedSnapshot(record[key]);
  }
}

function messageBytes(messages: readonly ModelMessage[]): number {
  try {
    return new TextEncoder().encode(JSON.stringify(messages)).byteLength;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function promptCacheKey(
  messages: readonly ModelMessage[],
  prefixMessageCount: number,
  tools: ModelRequest["tools"],
  model: Readonly<Record<string, unknown>>,
  context: ComponentExecutionContext,
  revisions?: RunSessionContext["revisions"],
): Promise<string> {
  return sha256(stableJson({
    version: 1,
    harnessDigest: context.harnessDigest,
    adapter: model.adapter,
    model: model.model,
    revisions: revisions ?? context.session?.revisions,
    messages: messages.slice(0, prefixMessageCount),
    tools: tools ?? [],
  }));
}

const mediaKind = (mimeType: string): "image" | "audio" | "video" | "pdf" | undefined => {
  if (mimeType.startsWith("image/") && mimeType !== "image/svg+xml") return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType === "application/pdf") return "pdf";
  return undefined;
};

const mergedUsage = (current: TokenUsage, next: TokenUsage): TokenUsage => {
  for (const field of ["inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "cacheWriteInputTokens"] as const) {
    const value = next[field];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new ComponentExecutionError(
        "PROVIDER_USAGE_INVALID",
        `Provider returned invalid ${field}`,
      );
    }
  }
  const usage = { ...current, ...next };
  if (usage.totalTokens === undefined && usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
    usage.totalTokens = usage.inputTokens + usage.outputTokens;
  }
  return usage;
};

const sumUsage = (current: TokenUsage, next: TokenUsage): TokenUsage => {
  const add = (left: number | undefined, right: number | undefined) => left === undefined && right === undefined
    ? undefined : (left ?? 0) + (right ?? 0);
  const inputTokens = add(current.inputTokens, next.inputTokens);
  const outputTokens = add(current.outputTokens, next.outputTokens);
  const totalTokens = add(current.totalTokens, next.totalTokens);
  const cachedInputTokens = add(current.cachedInputTokens, next.cachedInputTokens);
  const cacheWriteInputTokens = add(current.cacheWriteInputTokens, next.cacheWriteInputTokens);
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens }),
  };
};

const pointerSegment = (value: string): string => value.replaceAll("~1", "/").replaceAll("~0", "~");

export function valueAtPointer(value: unknown, pointer = ""): unknown {
  if (!pointer) return value;
  let current = value;
  for (const raw of pointer.slice(1).split("/")) {
    const segment = pointerSegment(raw);
    if (segment === "__proto__" || segment === "prototype" || segment === "constructor") return undefined;
    if (Array.isArray(current)) {
      const index = /^(?:0|[1-9][0-9]*)$/.test(segment) ? Number(segment) : -1;
      current = index >= 0 ? current[index] : undefined;
    } else {
      const object = asRecord(current);
      current = object ? object[segment] : undefined;
    }
  }
  return current;
}

export function evaluatePredicate(
  predicate: PredicateSpec,
  value: unknown,
  state: Readonly<Record<string, unknown>> = {},
  input: unknown = undefined,
): boolean {
  const root = predicate.source === "state" ? state : predicate.source === "input" ? input : value;
  const selected = valueAtPointer(root, predicate.path ?? "");
  switch (predicate.op) {
    case "equals": return Object.is(selected, predicate.value);
    case "notEquals": return !Object.is(selected, predicate.value);
    case "contains": return typeof selected === "string"
      ? selected.includes(asText(predicate.value))
      : Array.isArray(selected) && selected.some((item) => Object.is(item, predicate.value));
    case "matches": return typeof selected === "string" && typeof predicate.value === "string"
      && safeRegexTest(predicate.value, selected);
    case "exists": return selected !== undefined && selected !== null;
    case "truthy": return Boolean(selected);
    case "gt": return typeof selected === "number" && typeof predicate.value === "number" && selected > predicate.value;
    case "gte": return typeof selected === "number" && typeof predicate.value === "number" && selected >= predicate.value;
    case "lt": return typeof selected === "number" && typeof predicate.value === "number" && selected < predicate.value;
    case "lte": return typeof selected === "number" && typeof predicate.value === "number" && selected <= predicate.value;
  }
}

async function nextWithSignal<T>(iterator: AsyncIterator<T>, signal: AbortSignal): Promise<IteratorResult<T>> {
  if (signal.aborted) throw signal.reason;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    iterator.next().then(
      (result) => {
        signal.removeEventListener("abort", abort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

async function promiseWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return new Promise<T>((resolve, reject) => {
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

const costFor = (usage: TokenUsage, model: Record<string, unknown>): number => {
  const inputRate = typeof model.inputCostPerMillion === "number" ? model.inputCostPerMillion : 0;
  const cachedRate = typeof model.cachedInputCostPerMillion === "number" ? model.cachedInputCostPerMillion : inputRate;
  const writeRate = typeof model.cacheWriteCostPerMillion === "number" ? model.cacheWriteCostPerMillion : inputRate;
  const storageRate = typeof model.cacheStorageCostPerMillionHour === "number" ? model.cacheStorageCostPerMillionHour : 0;
  const cached = usage.cachedInputTokens ?? 0;
  const written = usage.cacheWriteInputTokens ?? 0;
  const uncached = Math.max(0, (usage.inputTokens ?? 0) - cached - written);
  return (uncached * inputRate + cached * cachedRate
    + written * (writeRate + (model.adapter === "gemini" ? storageRate : 0))
    + (usage.outputTokens ?? 0) * (typeof model.outputCostPerMillion === "number" ? model.outputCostPerMillion : 0)) / 1_000_000;
};

const serviceContext = (context: ComponentExecutionContext): ServiceExecutionContext => ({
  signal: context.signal,
  runId: context.runId,
  nodeId: context.nodeId,
  iteration: context.iteration,
  ...(context.session?.contextRef ? { contextRef: context.session.contextRef } : {}),
  resolveSecret: context.resolveSecret,
  ...(context.requestInteraction ? { requestInteraction: context.requestInteraction } : {}),
});

const modelExecutor: ComponentExecutor = (component) => ({
  outputs: { model: component.config },
  traceOutput: {
    adapter: component.config.adapter,
    model: component.config.model,
  },
});

const promptExecutor: ComponentExecutor = (component) => ({
  outputs: { prompt: component.config.template },
});

const toolRisk = (value: unknown): ToolRisk =>
  value === "read" || value === "write" || value === "destructive" ? value : "external";

function toolBinding(value: unknown): ToolBinding | undefined {
  const candidate = asRecord(value);
  if (!candidate || typeof candidate.id !== "string") return undefined;
  const inputSchema = snapshotSafeJsonSchema(
    candidate.inputSchema ?? { type: "object", additionalProperties: true },
  );
  const outputSchema = candidate.outputSchema === undefined
    ? undefined
    : snapshotSafeJsonSchema(candidate.outputSchema);
  if (!inputSchema || (candidate.outputSchema !== undefined && !outputSchema)) return undefined;
  const source = candidate.source === "builtin" || candidate.source === "module"
    || candidate.source === "custom" || candidate.source === "mcp" || candidate.source === "skill"
    ? candidate.source
    : undefined;
  const connectionKinds = Array.isArray(candidate.connectionKinds)
    ? candidate.connectionKinds.filter((item): item is string => typeof item === "string")
    : undefined;
  return {
    id: candidate.id,
    label: typeof candidate.label === "string" ? candidate.label : candidate.id,
    description: typeof candidate.description === "string" ? candidate.description : `Tool ${candidate.id}`,
    inputSchema,
    ...(outputSchema ? { outputSchema } : {}),
    ...(typeof candidate.category === "string" ? { category: candidate.category } : {}),
    risk: toolRisk(candidate.risk),
    ...(source ? { source } : {}),
    ...(connectionKinds?.length ? { connectionKinds } : {}),
    ...(typeof candidate.connectionId === "string" ? { connectionId: candidate.connectionId } : {}),
    ...(typeof candidate.action === "string" ? { action: candidate.action } : {}),
  };
}

function assertAgentToolCapability(context: ComponentExecutionContext, binding: ToolBinding): void {
  const required = requiredToolCapability(binding);
  if (required && context.agentControl?.capabilities && !context.agentControl.capabilities.includes(required)) {
    throw new ComponentExecutionError(
      "AGENT_CAPABILITY_DENIED",
      `Agent '${context.agentControl.agentId}' requires capability '${required}' to use Tool '${binding.id}'`,
    );
  }
}

const providerToolName = (id: string): string => {
  const normalized = id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return normalized || "tool";
};

async function resolveProviderModel(
  configured: Record<string, unknown>,
  connectionId: string | undefined,
  context: ComponentExecutionContext,
  primary: boolean,
): Promise<Record<string, unknown>> {
  if (!connectionId) return configured;
  if (!context.services.resolveConnection) {
    throw new ComponentExecutionError("CONNECTION_SERVICE_UNAVAILABLE", "This runtime cannot resolve saved Connections");
  }
  const resolved = asRecord((await context.services.resolveConnection(connectionId, serviceContext(context))).value);
  if (!resolved || resolved.connectionKind !== "provider") {
    throw new ComponentExecutionError("CONNECTION_INVALID", `Connection '${connectionId}' is not a Provider connection`);
  }
  const overrides = Object.fromEntries((primary
    ? [
        "model", "temperature", "maxTokens", "contextWindowTokens", "cacheDialect",
        "inputCostPerMillion", "outputCostPerMillion", "cachedInputCostPerMillion",
        "cacheWriteCostPerMillion", "cacheStorageCostPerMillionHour",
      ]
    : ["temperature", "maxTokens"]
  ).flatMap((key) => configured[key] !== undefined ? [[key, configured[key]]] : []));
  return { ...resolved, ...overrides, connectionId };
}

const agentExecutor: ComponentExecutor = async (component, inputs, context) => {
  const restoredTurn = context.agentControl?.turnCheckpoint();
  if (restoredTurn && (!Number.isInteger(restoredTurn.nextTurn) || restoredTurn.nextTurn < 1
    || typeof restoredTurn.workingState !== "object" || restoredTurn.workingState === null
    || typeof restoredTurn.costUsd !== "number" || !Number.isFinite(restoredTurn.costUsd)
    || !Number.isInteger(restoredTurn.toolCalls) || restoredTurn.toolCalls < 0)) {
    throw new ComponentExecutionError("AGENT_CHECKPOINT_INVALID", "Stored Agent turn checkpoint is invalid");
  }
  if (restoredTurn?.completed) {
    return {
      outputs: { response: restoredTurn.finalText ?? "" },
      usage: restoredTurn.usage,
      usageKnown: restoredTurn.usageKnown,
      costUsd: restoredTurn.costUsd,
      costKnown: restoredTurn.costKnown,
      finishReason: restoredTurn.finishReason,
    };
  }
  const configuredModel = asRecord(inputs.model);
  const primaryConnectionId = typeof configuredModel?.connectionId === "string" ? configuredModel.connectionId : undefined;
  const fallbackConnectionId = typeof configuredModel?.fallbackConnectionId === "string"
    ? configuredModel.fallbackConnectionId : undefined;
  let model = configuredModel
    ? await resolveProviderModel(configuredModel, primaryConnectionId, context, true)
    : undefined;
  if (!model || typeof model.adapter !== "string" || typeof model.model !== "string") {
    throw new ComponentExecutionError("AGENT_MODEL_INVALID", "Agent requires a model input");
  }
  if (typeof inputs.prompt !== "string") {
    throw new ComponentExecutionError("AGENT_PROMPT_INVALID", "Agent requires a prompt input");
  }
  const userInput = asText(context.runInput);
  const rendered = /\{\{\s*input\s*\}\}/.test(inputs.prompt)
    ? inputs.prompt.replace(/\{\{\s*input\s*\}\}/g, userInput)
    : `${inputs.prompt}\n\n${userInput}`;
  let contextText = values(inputs.context).map(asText).filter(Boolean).join("\n\n");
  const memoryText = values(inputs.memory).map(asText).filter(Boolean).join("\n\n");
  const toolResults = values(inputs.toolResults).map(asText).filter(Boolean).join("\n\n");
  const enriched = [
    rendered,
    memoryText ? `Memory:\n${memoryText}` : "",
    toolResults ? `Connected tool results:\n${toolResults}` : "",
  ].filter(Boolean).join("\n\n");
  const skillInstructions: string[] = [];
  const activeSkills: Array<{ id: string; payload: Record<string, unknown> | undefined }> = [];
  for (const reference of values(inputs.skills)) {
    const skill = asRecord(reference);
    const skillId = typeof skill?.id === "string" ? skill.id : undefined;
    if (!skillId) continue;
    if (!context.services.loadSkill) {
      throw new ComponentExecutionError("SKILL_SERVICE_UNAVAILABLE", "This runtime cannot load connected Skills");
    }
    const loaded = await context.services.loadSkill(skillId, serviceContext(context));
    const payload = asRecord(loaded.value);
    activeSkills.push({ id: skillId, payload });
    const instructions = typeof payload?.instructions === "string"
      ? payload.instructions
      : typeof loaded.value === "string" ? loaded.value : "";
    if (instructions) skillInstructions.push(`Skill '${skillId}':\n${instructions}`);
    const resources = Array.isArray(payload?.resources)
      ? payload.resources.filter((item): item is string => typeof item === "string")
      : undefined;
    context.emit({
      type: "skill-use",
      skill: skillId,
      ...(resources?.length ? { resources } : {}),
      ...(typeof payload?.trusted === "boolean" ? { trusted: payload.trusted } : {}),
    });
  }
  const system = [
    typeof component.config.system === "string" ? component.config.system : "",
    ...skillInstructions,
  ].filter(Boolean).join("\n\n");
  const requestedHistoryMessages = context.session?.maxHistoryMessages;
  const requestedHistoryBytes = context.session?.maxHistoryBytes;
  const contextWindowTokens = typeof model.contextWindowTokens === "number" ? Math.floor(model.contextWindowTokens) : 32_768;
  const outputReserveTokens = typeof model.maxTokens === "number"
    ? Math.floor(model.maxTokens) : Math.min(4_096, Math.floor(contextWindowTokens / 4));
  const runBudgetTokens = typeof component.config.maxTokens === "number"
    ? Math.floor(component.config.maxTokens) : contextWindowTokens;
  const adaptiveHistoryBytes = Math.min(
    4 * 1_048_576,
    Math.max(4_096, (Math.min(contextWindowTokens, runBudgetTokens) - outputReserveTokens) * 4),
  );
  const maxHistoryMessages = requestedHistoryMessages === undefined
    ? Number.POSITIVE_INFINITY : Math.min(100, Math.max(0, Math.floor(requestedHistoryMessages)));
  const maxHistoryBytes = requestedHistoryBytes === undefined
    ? adaptiveHistoryBytes : Math.min(4 * 1_048_576, Math.max(0, Math.floor(requestedHistoryBytes)));
  let providerConversation: ConversationReadResult | undefined;
  const contextCacheKey = context.session?.revisions && context.services.providers?.cache
    ? await sha256(stableJson({
      version: 1,
      harnessDigest: context.harnessDigest,
      model: { adapter: model.adapter, model: model.model },
      tools: values(inputs.tools),
      revisions: context.session.revisions,
    })) : undefined;
  const cachedContext = contextCacheKey ? asRecord((await context.services.providers!.cache!.get({
    namespace: "context", key: contextCacheKey,
  }, serviceContext(context)))?.value) : undefined;
  if (asRecord(cachedContext?.conversation)) providerConversation = cachedContext!.conversation as unknown as ConversationReadResult;
  if (!cachedContext && context.services.providers?.conversation && (context.session?.contextRef || context.session?.id)) {
    const messages: RunConversationMessage[] = [];
    const sources: Array<Omit<ContextSource, "label">> = [];
    let cursor: string | undefined;
    let revision = context.session.revisions?.conversation;
    let loadedBytes = 0;
    const seenCursors = new Set<string>();
    do {
      const page = await context.services.providers.conversation.read({
        ...(!context.session.contextRef && context.session.id ? { conversationId: context.session.id } : {}),
        ...(revision === undefined ? {} : { revision }),
        ...(cursor ? { cursor } : {}),
        ...(context.session.contextRef ? { contextRef: context.session.contextRef } : {}),
      }, serviceContext(context));
      messages.push(...page.messages);
      sources.push(...page.sources ?? []);
      loadedBytes += page.messages.reduce((total, message) => total + new TextEncoder().encode(message.content).byteLength, 0);
      revision = page.revision;
      cursor = page.cursor;
      if (!cursor || seenCursors.has(cursor)) break;
      seenCursors.add(cursor);
    } while (loadedBytes < maxHistoryBytes);
    providerConversation = { messages, sources, revision: revision ?? 0, ...(cursor ? { cursor } : {}) };
  }
  const memoryRevisions: Partial<Record<"user" | "conversation" | "pkm", ProviderRevision>> = {};
  const memorySources: Array<Omit<ContextSource, "label">> = [];
  if (cachedContext && Array.isArray(cachedContext.memorySources)) {
    memorySources.push(...cachedContext.memorySources as Array<Omit<ContextSource, "label">>);
    Object.assign(memoryRevisions, asRecord(cachedContext.memoryRevisions));
  } else if (context.services.providers?.memory && context.session?.contextRef) {
    for (const namespace of ["user", "conversation", "pkm"] as const) {
      const revision = namespace === "pkm" ? context.session.revisions?.pkm : context.session.revisions?.memory;
      const found = await context.services.providers.memory.search({
        namespace,
        query: userInput,
        ...(revision === undefined ? {} : { revision }),
        contextRef: context.session.contextRef,
      }, serviceContext(context));
      memoryRevisions[namespace] = found.revision;
      for (const record of found.records) memorySources.push({
        content: asText(context.redact(record.value)),
        provenance: { ...record.provenance, revision: record.provenance.revision ?? record.revision },
      });
    }
  }
  if (!cachedContext && contextCacheKey) await context.services.providers!.cache!.put({
    namespace: "context",
    key: contextCacheKey,
    value: { conversation: providerConversation, memorySources, memoryRevisions },
    ...(context.session!.revisions?.conversation === undefined ? {} : { revision: context.session!.revisions!.conversation }),
    ttlMs: 5 * 60_000,
  }, serviceContext(context));
  const normalizedProviderSources = normalizeContextSources([...(providerConversation?.sources ?? []), ...memorySources]);
  const fixedContextBytes = new TextEncoder().encode(`${system}\n${enriched}\n${stableJson(values(inputs.tools))}`).byteLength;
  let remainingContextBytes = Math.max(0, maxHistoryBytes - fixedContextBytes);
  contextText = truncateUtf8Text(contextText, remainingContextBytes);
  remainingContextBytes -= new TextEncoder().encode(contextText).byteLength;
  const providerSources: ContextSource[] = [];
  for (const source of normalizedProviderSources) {
    const renderedSource = `[${source.label}] ${source.provenance.title ?? source.provenance.source}\n${source.content}`;
    const bytes = new TextEncoder().encode(`${contextText ? "\n\n" : ""}${renderedSource}`).byteLength;
    if (bytes > remainingContextBytes) continue;
    contextText = `${contextText ? `${contextText}\n\n` : ""}${renderedSource}`;
    remainingContextBytes -= bytes;
    providerSources.push(source);
  }
  const effectiveRevisions: RunSessionContext["revisions"] = {
    ...context.session?.revisions,
    ...(providerConversation ? { conversation: providerConversation.revision } : {}),
    ...(memoryRevisions.user === undefined && memoryRevisions.conversation === undefined ? {} : {
      memory: stableJson({ user: memoryRevisions.user, conversation: memoryRevisions.conversation }),
    }),
    ...(memoryRevisions.pkm === undefined ? {} : { pkm: memoryRevisions.pkm }),
  };
  const validHistory = [...(providerConversation?.messages ?? []), ...(context.session?.messages ?? [])].flatMap((message) => {
    if ((message.role !== "user" && message.role !== "assistant") || typeof message.content !== "string") return [];
    return [{ role: message.role, content: asText(context.redact(message.content)) } satisfies ModelMessage];
  });
  let historyBytes = 0;
  const history = [...validHistory].reverse().flatMap((message) => {
    const content = asText(message.content);
    const bytes = boundedUtf8ByteLength(content, remainingContextBytes - historyBytes);
    if (bytes === undefined) return [];
    historyBytes += bytes;
    return [{ role: message.role, content } satisfies ModelMessage];
  }).slice(0, maxHistoryMessages).reverse();
  const attachments = (context.session?.attachments ?? []).slice(0, 32).flatMap((attachment) => {
    if (!attachment || typeof attachment.id !== "string" || typeof attachment.name !== "string"
      || typeof attachment.mimeType !== "string" || !Number.isFinite(attachment.size) || attachment.size < 0) return [];
    return [{
      id: attachment.id,
      ...(typeof attachment.ref === "string" ? { ref: attachment.ref } : {}),
      name: asText(context.redact(attachment.name)).slice(0, 255),
      mimeType: attachment.mimeType.slice(0, 127),
      size: Math.floor(attachment.size),
      ...(typeof attachment.sandboxPath === "string" ? { sandboxPath: attachment.sandboxPath } : {}),
    }];
  });
  for (const attachment of attachments) {
    const textual = attachment.mimeType.startsWith("text/")
      || ["application/json", "application/xml", "application/yaml", "application/x-yaml"].includes(attachment.mimeType);
    if (!textual || attachment.sandboxPath || attachment.size > 1_048_576) continue;
    if (!context.services.readAttachment) throw new ComponentExecutionError(
      "ATTACHMENT_READ_UNAVAILABLE", `This runtime cannot read text attachment '${attachment.name}'`,
    );
    const content = await context.services.readAttachment(attachment, serviceContext(context));
    if (content.byteLength !== attachment.size) throw new ComponentExecutionError(
      "ATTACHMENT_CHANGED", `Attachment '${attachment.name}' changed before model invocation`,
    );
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(content); }
    catch { throw new ComponentExecutionError("ATTACHMENT_ENCODING_INVALID", `Text attachment '${attachment.name}' is not valid UTF-8`); }
    const rendered = `${contextText ? "\n\n" : ""}[Attachment: ${attachment.name}]\n${text}`;
    const available = Math.max(0, remainingContextBytes - historyBytes);
    if (boundedUtf8ByteLength(rendered, available) === undefined) continue;
    contextText += rendered;
    remainingContextBytes -= new TextEncoder().encode(rendered).byteLength;
  }
  const attachmentInstruction = attachments.length ? [
    "Files selected by the user are available for this run. Supported media is attached directly to the model: analyze it directly and do not call File or Code Runner merely to inspect it. Use the listed sandbox paths only when the request actually requires a file transformation or code-based operation.",
    ...attachments.map((attachment) => `- ${JSON.stringify(attachment.name)} (${attachment.mimeType}, ${attachment.size} bytes)${attachment.sandboxPath ? ` at ${attachment.sandboxPath}` : ""}`),
    ...(context.session?.sandboxOutputPath
      ? [`Save files intended for the user under ${context.session.sandboxOutputPath}.`]
      : []),
  ].join("\n") : "";
  const sessionCheckpoint = context.session?.checkpoint && asRecord(context.session.checkpoint)
    ? boundedSnapshot(context.session.checkpoint) : undefined;
  const workingState: WorkingState = {};
  mergeWorkingState(workingState, sessionCheckpoint);
  for (const message of history) mergeWorkingState(workingState, message.content);
  mergeWorkingState(workingState, context.runInput);
  if (history.length) {
    let recentBytes = 0;
    const recentBudget = Math.max(4_096, Math.floor(maxHistoryBytes / 4));
    workingState.recentConversation = [...history].reverse().flatMap((message) => {
      const content = asText(message.content);
      const bytes = new TextEncoder().encode(content).byteLength;
      if (recentBytes + bytes > recentBudget) return [];
      recentBytes += bytes;
      return [{ role: message.role as "user" | "assistant", content }];
    }).reverse();
  }
  if (workingState.originalRequest === undefined && workingState.objective === undefined) {
    workingState.originalRequest = boundedSnapshot(userInput);
  }
  if (restoredTurn) Object.assign(workingState, structuredClone(restoredTurn.workingState));
  const allowedTools = Array.isArray(component.config.allowTools)
    ? new Set(component.config.allowTools.filter((item): item is string => typeof item === "string"))
    : undefined;
  const deniedTools = new Set(Array.isArray(component.config.denyTools)
    ? component.config.denyTools.filter((item): item is string => typeof item === "string")
    : []);
  const graphBindings = values(inputs.tools)
    .map(toolBinding)
    .filter((item): item is ToolBinding => Boolean(item))
    .filter((item) => (!allowedTools || allowedTools.has(item.id)) && !deniedTools.has(item.id));
  for (const binding of graphBindings) assertAgentToolCapability(context, binding);
  const connectedToolIds = new Set(graphBindings.map(({ id }) => id));
  const connectedConnectionIds = new Set([
    ...(typeof model.connectionId === "string" ? [model.connectionId] : []),
    ...(fallbackConnectionId ? [fallbackConnectionId] : []),
    ...graphBindings.flatMap(({ connectionId }) => connectionId ? [connectionId] : []),
  ]);
  for (const skill of activeSkills) {
    const requirements = asRecord(skill.payload?.requirements);
    const requiredTools = Array.isArray(requirements?.tools)
      ? requirements.tools.filter((item): item is string => typeof item === "string") : [];
    const requiredConnections = Array.isArray(requirements?.connections)
      ? requirements.connections.filter((item): item is string => typeof item === "string")
        .map((requirement) => ({ requirement, ...skillConnectionRequirement(requirement) })) : [];
    const requiredPermissions = Array.isArray(requirements?.permissions)
      ? requirements.permissions.filter((item): item is string => typeof item === "string") : [];
    const grantedPermissions = new Set(Array.isArray(skill.payload?.grantedPermissions)
      ? skill.payload.grantedPermissions.filter((item): item is string => typeof item === "string") : []);
    const missing = [
      ...requiredTools.filter((id) => !connectedToolIds.has(id)).map((id) => `tool:${id}`),
      ...requiredConnections.filter(({ id }) => !connectedConnectionIds.has(id))
        .map(({ requirement }) => `connection:${requirement}`),
      ...requiredPermissions.filter((id) => !grantedPermissions.has(id)
        || (context.agentControl?.capabilities !== undefined && !context.agentControl.capabilities.includes(id)))
        .map((id) => `permission:${id}`),
    ];
    if (missing.length) throw new ComponentExecutionError(
      "SKILL_REQUIREMENTS_MISSING",
      `Skill '${skill.id}' is missing ${missing.join(", ")}`,
    );
  }
  if (restoredTurn?.fallbackUsed && fallbackConnectionId && configuredModel) {
    const fallback = await resolveProviderModel(configuredModel, fallbackConnectionId, context, false);
    if (typeof fallback.adapter !== "string" || typeof fallback.model !== "string") {
      throw new ComponentExecutionError("AGENT_MODEL_INVALID", `Fallback Connection '${fallbackConnectionId}' has no model`);
    }
    model = fallback;
  }
  if (typeof model.adapter !== "string") throw new ComponentExecutionError("AGENT_MODEL_INVALID", "Agent model Adapter is invalid");
  let adapter = context.adapters.get(model.adapter);
  const resourceBindings: ToolBinding[] = adapter.capabilities.tools === true && context.services.loadSkillResource
    ? activeSkills.map(({ id }) => ({
        id: `skill-resource.${id}`,
        label: `${id} resource`,
        description: `Load one requested assets/, references/, or explicitly approved scripts/ resource from Skill '${id}'.`,
        inputSchema: {
          type: "object",
          properties: { path: { type: "string", pattern: "^(?:assets|references|scripts)/[^.].*" } },
          required: ["path"],
          additionalProperties: false,
        },
        risk: "read",
        source: "skill",
        action: id,
      }))
    : [];
  const controlBindings = context.agentControl?.tools ?? [];
  const controlToolIds = new Set(controlBindings.map(({ id }) => id));
  const bindings = [...graphBindings, ...resourceBindings, ...controlBindings];
  const names = new Map<string, ToolBinding>();
  const modelTools = bindings.map((binding) => {
    const base = providerToolName(binding.id);
    let name = base;
    let suffix = 2;
    while (names.has(name)) {
      name = `${base.slice(0, 58)}_${suffix}`;
      suffix += 1;
    }
    names.set(name, binding);
    if (controlToolIds.has(binding.id)) {
      const alias = providerToolName(binding.id.split(".").at(-1) ?? binding.id);
      if (!names.has(alias)) names.set(alias, binding);
    }
    return { name, description: binding.description, inputSchema: binding.inputSchema };
  });
  for (const [name, binding] of [...names]) {
    const alias = name.replaceAll("-", "_");
    if (!names.has(alias)) names.set(alias, binding);
  }
  if (modelTools.length && adapter.capabilities.tools !== true) {
    throw new ComponentExecutionError("ADAPTER_TOOLS_UNSUPPORTED", `Adapter '${model.adapter}' does not support Tool calling`);
  }
  const attachmentToolAvailable = graphBindings.some(({ id }) => id === "builtin.code-runner" || id === "builtin.file");
  const directMedia: ModelContentPart[] = [];
  let directMediaBytes = 0;
  if (component.config.multimodal !== false && attachments.length) {
    for (const attachment of attachments) {
      const kind = mediaKind(attachment.mimeType);
      if (!kind) continue;
      if (!adapter.capabilities.inputMedia?.includes(kind)) {
        if (!attachmentToolAvailable) throw new ComponentExecutionError(
          "ADAPTER_MEDIA_UNSUPPORTED",
          `Adapter '${model.adapter}' cannot receive ${kind} attachment '${attachment.name}' and no File or Code Runner Tool is connected`,
        );
        continue;
      }
      if (!context.services.readAttachment) throw new ComponentExecutionError(
        "ATTACHMENT_READ_UNAVAILABLE",
        `This runtime cannot provide attachment '${attachment.name}' to Adapter '${model.adapter}'`,
      );
      if (attachment.size > MAX_MODEL_ATTACHMENT_BYTES || directMediaBytes + attachment.size > MAX_MODEL_ATTACHMENTS_BYTES) {
        throw new ComponentExecutionError(
          "MODEL_ATTACHMENT_LIMIT",
          `Direct model attachments exceed the 20 MiB per-file or 32 MiB per-run limit`,
        );
      }
      const content = await context.services.readAttachment(attachment, serviceContext(context));
      if (content.byteLength !== attachment.size || content.byteLength > MAX_MODEL_ATTACHMENT_BYTES) {
        throw new ComponentExecutionError("ATTACHMENT_CHANGED", `Attachment '${attachment.name}' changed before model invocation`);
      }
      directMediaBytes += content.byteLength;
      directMedia.push({
        type: "media",
        mimeType: attachment.mimeType,
        data: Buffer.from(content).toString("base64"),
        name: attachment.name,
      });
    }
  }
  const stableMessages: ModelMessage[] = [
    ...(context.responseSchema ? [{
      role: "system" as const,
      content: `Return only JSON matching this JSON Schema: ${JSON.stringify(context.responseSchema)}`,
    }] : []),
    ...(system ? [{ role: "system" as const, content: system }] : []),
    ...(contextText ? [{ role: "system" as const, content: `Reference context:\n${contextText}` }] : []),
    ...(attachmentInstruction ? [{
      role: directMedia.length ? "user" as const : "system" as const,
      content: directMedia.length
        ? [{ type: "text" as const, text: attachmentInstruction }, ...directMedia]
        : attachmentInstruction,
    }] : []),
  ];
  const cachePrefixMessageCount = stableMessages.length;
  const messages: ModelMessage[] = [
    ...stableMessages,
    ...(sessionCheckpoint ? [{ role: "user" as const, content: `${COMPACTED_STATE_PREFIX}${JSON.stringify(sessionCheckpoint)}` }] : []),
    ...history,
    { role: "user", content: enriched },
  ];
  if (restoredTurn) messages.push({
    role: "user",
    content: `${COMPACTED_STATE_PREFIX}${JSON.stringify(restoredTurn.workingState)}\nContinue from completed model turn ${restoredTurn.nextTurn - 1}. Completed Tool evidence is authoritative; do not repeat it unless the user explicitly requests a retry.`,
  });
  let seenRevision = typeof workingState.planRevision === "number" ? workingState.planRevision : 0;
  const applyControlUpdates = async (target = messages): Promise<boolean> => {
    const checkpoint = await context.agentControl?.checkpoint();
    if (!checkpoint) return false;
    if (checkpoint.task) workingState.currentTask = boundedSnapshot(checkpoint.task);
    const revisionChanged = checkpoint.revision !== seenRevision;
    seenRevision = checkpoint.revision;
    workingState.planRevision = checkpoint.revision;
    if (revisionChanged) target.push({
      role: "user",
      content: `[Harnest plan updated]\nContinue against plan revision ${checkpoint.revision}; reconsider stale actions before using tools.`,
    });
    for (const message of checkpoint.messages) {
      target.push({
        role: "user",
        content: `[Harnest ${message.kind} from ${message.from}${message.taskId ? ` for ${message.taskId}` : ""}]\n${message.content}`,
      });
    }
    return revisionChanged || checkpoint.messages.length > 0;
  };
  const maxTurns = typeof component.config.maxTurns === "number" ? Math.floor(component.config.maxTurns) : 8;
  const maxToolCalls = typeof component.config.maxToolCalls === "number" ? Math.floor(component.config.maxToolCalls) : 32;
  const toolTimeoutMs = typeof component.config.toolTimeoutMs === "number" ? Math.floor(component.config.toolTimeoutMs) : 30_000;
  const recoverToolErrors = component.config.toolError !== "fail";
  const compactAtTokens = typeof component.config.compactAtTokens === "number"
    ? Math.floor(component.config.compactAtTokens) : undefined;
  let usage: TokenUsage = restoredTurn?.usage ?? {};
  let costUsd = restoredTurn?.costUsd ?? 0;
  let costKnown = restoredTurn?.costKnown ?? true;
  let finishReason: FinishReason = restoredTurn?.finishReason ?? "unknown";
  let toolCalls = restoredTurn?.toolCalls ?? 0;
  let finalText = restoredTurn?.finalText ?? "";
  let completed = false;
  let fallbackUsed = restoredTurn?.fallbackUsed ?? false;
  let usageKnown = restoredTurn?.usageKnown ?? true;
  const seenToolCallIds = new Set<string>();
  const compactMessages = (turn: number): boolean => {
    const beforeBytes = messageBytes(messages);
    const next: ModelMessage[] = [
      ...messages.slice(0, cachePrefixMessageCount),
      { role: "user", content: `${COMPACTED_STATE_PREFIX}${JSON.stringify(workingState)}` },
      {
        role: "user",
        content: "Continue the original objective from the preserved working state. Use tools only when needed, verify the result, and return only the requested user-facing output.",
      },
    ];
    const afterBytes = messageBytes(next);
    if (afterBytes >= beforeBytes) return false;
    messages.splice(0, messages.length, ...next);
    context.emit({
      type: "context-compaction",
      beforeBytes,
      afterBytes,
      preserved: Object.keys(workingState).sort(),
      turn,
    });
    return true;
  };
  const commitUsage = (turnUsage: TokenUsage, turnModel: Record<string, unknown>) => {
    usage = sumUsage(usage, turnUsage);
    const turnUsageKnown = turnUsage.totalTokens !== undefined
      || (turnUsage.inputTokens !== undefined && turnUsage.outputTokens !== undefined);
    const turnCostKnown = typeof turnModel.inputCostPerMillion === "number"
      && typeof turnModel.outputCostPerMillion === "number"
      && turnUsage.inputTokens !== undefined
      && turnUsage.outputTokens !== undefined;
    usageKnown = usageKnown && turnUsageKnown;
    costKnown = costKnown && turnCostKnown;
    costUsd += costFor(turnUsage, turnModel);
  };
  const saveTurnCheckpoint = async (
    nextTurn: number,
    done = false,
    pending: Pick<AgentTurnCheckpoint, "pendingCalls" | "pendingAssistantText" | "siblingResults" | "inFlightCalls"> = {},
  ) => {
    if (!context.agentControl) return;
    const safeWorkingState = Object.fromEntries(Object.entries(workingState)
      .map(([key, value]) => [key, boundedSnapshot(value, 262_144)]));
    await context.agentControl.saveTurnCheckpoint({
      nextTurn,
      workingState: safeWorkingState,
      usage,
      usageKnown,
      costUsd,
      costKnown,
      finishReason,
      toolCalls,
      fallbackUsed,
      ...pending,
      ...(done ? { completed: true, finalText } : {}),
    });
  };
  for (let turn = restoredTurn?.nextTurn ?? 1; turn <= maxTurns; turn += 1) {
    await applyControlUpdates();
    const resumedPending = turn === restoredTurn?.nextTurn && restoredTurn.pendingCalls?.length
      ? restoredTurn.pendingCalls.map((call) => structuredClone(call)) : undefined;
    let calls: ModelToolCall[] = resumedPending ?? [];
    let turnUsage: TokenUsage = {};
    let text = resumedPending ? restoredTurn?.pendingAssistantText ?? "" : "";
    let textBytes = 0;
    let finished = Boolean(resumedPending);
    while (!resumedPending) {
      const supportedCacheModes = model.cacheDialect === "none" ? [] : adapter.capabilities.promptCaching ?? [];
      const cacheMode = supportedCacheModes.includes(context.contextPolicy.cacheMode)
        ? context.contextPolicy.cacheMode
        : context.contextPolicy.cacheMode === "explicit" && supportedCacheModes.includes("automatic")
          ? "automatic" : undefined;
      const request: ModelRequest = {
        model: model.model as string,
        messages,
        ...(typeof model.baseUrl === "string" ? { baseUrl: model.baseUrl } : {}),
        ...(typeof model.apiKey === "string" ? { apiKey: model.apiKey } : {}),
        ...(typeof model.temperature === "number" ? { temperature: model.temperature } : {}),
        ...(typeof model.maxTokens === "number" ? { maxTokens: model.maxTokens } : {}),
        ...(context.responseSchema ? { responseSchema: context.responseSchema } : {}),
        ...(modelTools.length ? { tools: modelTools } : {}),
        ...(cacheMode && cachePrefixMessageCount > 0 ? {
          promptCache: {
            mode: cacheMode,
            key: await promptCacheKey(messages, cachePrefixMessageCount, modelTools, model, context, effectiveRevisions),
            prefixMessageCount: cachePrefixMessageCount,
          },
        } : {}),
      };
      if (!cacheMode && cachePrefixMessageCount > 0 && turn === 1) context.emit({
        type: "prompt-cache",
        status: "bypass",
        mode: context.contextPolicy.cacheMode,
        reason: `Adapter '${adapter.id}' does not support prompt caching`,
      });
      let iterator: AsyncIterator<ModelEvent> | undefined;
      try {
        iterator = adapter.run(request, {
          signal: context.signal,
          resolveSecret: context.resolveSecret,
          ...(context.services.fetchProvider ? {
            fetch: (url, init) => context.services.fetchProvider!(url, init, serviceContext(context)),
          } : {}),
          ...(context.services.promptCache ? { promptCache: context.services.promptCache } : {}),
        })[Symbol.asyncIterator]();
        while (true) {
          const result = await nextWithSignal<ModelEvent>(iterator, context.signal);
          if (result.done) break;
          if (result.value.type === "text-delta") {
            const deltaBytes = boundedUtf8ByteLength(result.value.text, MAX_PROVIDER_TURN_BYTES - textBytes);
            if (deltaBytes === undefined) throw new ComponentExecutionError(
              "AGENT_OUTPUT_LIMIT",
              "Provider output exceeded the 8 MiB per-turn limit",
            );
            textBytes += deltaBytes;
            text += result.value.text;
          } else if (result.value.type === "tool-call") {
            const call = result.value.call;
            if (toolCalls + calls.length >= maxToolCalls) throw new ComponentExecutionError(
              "AGENT_TOOL_CALL_LIMIT",
              `Agent exceeded ${maxToolCalls} Tool calls`,
            );
            if (!call.id || seenToolCallIds.has(call.id)
              || calls.some(({ id }) => id === call.id)) throw new ComponentExecutionError(
              "TOOL_CALL_DUPLICATE",
              `Provider returned a missing or duplicate Tool call id '${call.id}'`,
            );
            const providerMetadata = call.providerMetadata;
            if (providerMetadata !== undefined && !asRecord(providerMetadata)) throw new ComponentExecutionError(
              "TOOL_CALL_INVALID", "Provider Tool-call metadata must be a JSON object",
            );
            calls.push({
              id: call.id,
              name: call.name,
              input: snapshotToolInput(call.input),
              ...(providerMetadata === undefined ? {} : {
                providerMetadata: snapshotToolInput(providerMetadata) as Readonly<Record<string, unknown>>,
              }),
            });
          } else if (result.value.type === "usage") {
            turnUsage = mergedUsage(turnUsage, result.value.usage);
            const cumulativeUsage = sumUsage(usage, turnUsage);
            const cumulativeCost = costUsd + costFor(turnUsage, model);
            context.emit({ type: "usage", usage: cumulativeUsage, costUsd: cumulativeCost });
            if (typeof component.config.maxTokens === "number"
              && (cumulativeUsage.totalTokens ?? 0) > component.config.maxTokens) {
              throw new ComponentExecutionError("AGENT_TOKEN_LIMIT", `Agent exceeded ${component.config.maxTokens} tokens`);
            }
            if (typeof component.config.maxCostUsd === "number") {
              if (typeof model.inputCostPerMillion !== "number" || typeof model.outputCostPerMillion !== "number") {
                throw new ComponentExecutionError("AGENT_COST_UNAVAILABLE", "Agent cost limit requires model pricing");
              }
              if (cumulativeCost > component.config.maxCostUsd) {
                throw new ComponentExecutionError("AGENT_COST_LIMIT", `Agent exceeded $${component.config.maxCostUsd}`);
              }
            }
          } else if (result.value.type === "cache") {
            context.emit({
              type: "prompt-cache",
              status: result.value.status,
              mode: result.value.mode,
              ...(result.value.cachedInputTokens === undefined ? {} : { cachedInputTokens: result.value.cachedInputTokens }),
              ...(result.value.cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens: result.value.cacheWriteInputTokens }),
              ...(result.value.reason === undefined ? {} : { reason: asText(context.redact(result.value.reason)) }),
            });
          } else {
            finishReason = result.value.reason;
            finished = true;
          }
        }
        break;
      } catch (cause) {
        if (cause instanceof AdapterError && cause.code === "context_overflow"
          && context.contextPolicy.overflow === "compact" && textBytes === 0 && calls.length === 0
          && compactMessages(turn)) {
          if (Object.keys(turnUsage).length) commitUsage(turnUsage, model);
          turnUsage = {};
          finishReason = "unknown";
          continue;
        }
        if (!(cause instanceof AdapterError) || !cause.retryable || !fallbackConnectionId
          || fallbackUsed || !configuredModel || context.signal.aborted) throw cause;
        commitUsage(turnUsage, model);
        const from = typeof model.connectionId === "string" ? model.connectionId : `${adapter.id}:${String(model.model)}`;
        model = await resolveProviderModel(configuredModel, fallbackConnectionId, context, false);
        if (typeof model.adapter !== "string" || typeof model.model !== "string") {
          throw new ComponentExecutionError("AGENT_MODEL_INVALID", `Fallback Connection '${fallbackConnectionId}' has no model`);
        }
        adapter = context.adapters.get(model.adapter);
        if (modelTools.length && adapter.capabilities.tools !== true) {
          throw new ComponentExecutionError("ADAPTER_TOOLS_UNSUPPORTED", `Fallback Adapter '${model.adapter}' does not support Tool calling`);
        }
        if (directMedia.length && directMedia.some((part) => part.type === "media"
          && !adapter.capabilities.inputMedia?.includes(mediaKind(part.mimeType)!))) {
          throw new ComponentExecutionError(
            "ADAPTER_MEDIA_UNSUPPORTED",
            `Fallback Adapter '${model.adapter}' does not support the selected media attachments`,
          );
        }
        fallbackUsed = true;
        context.emit({
          type: "fallback",
          from,
          to: fallbackConnectionId,
          reason: asText(context.redact(cause.message)),
          turn,
        });
        calls = [];
        turnUsage = {};
        text = "";
        textBytes = 0;
        finished = false;
        finishReason = "unknown";
      } finally {
        if (iterator?.return) void iterator.return().catch(() => undefined);
      }
    }
    text = asText(context.redact(text));
    if (text.includes(COMPACTED_STATE_PREFIX) || text.includes("Harnest internal compacted working state")
      || /["']?(?:pendingInteractions|pendingCalls|siblingResults|processedInteractionIds|runGrants)["']?\s*:/u.test(text)) {
      throw new ComponentExecutionError("AGENT_INTERNAL_STATE_EXPOSED", "Provider attempted to expose internal compacted state");
    }
    const citations = validateContextCitations(text, providerSources);
    if (citations.valid.length || citations.invented.length) context.emit({
      type: "citations",
      citations: citations.valid.flatMap((label) => {
        const source = providerSources.find((candidate) => candidate.label === label);
        return source ? [{ label: source.label, provenance: source.provenance }] : [];
      }),
      invented: citations.invented,
    });
    if (citations.invented.length) context.emit({
      type: "context-use",
      source: "citation-validation",
      metadata: { valid: citations.valid, invented: citations.invented },
    });
    mergeWorkingState(workingState, text);
    if (text && !resumedPending) context.emit({ type: "text-delta", text });
    if (!finished) throw new ComponentExecutionError("ADAPTER_STREAM_INCOMPLETE", "Adapter stream ended without a finish event");
    if (finishReason === "error") throw new ComponentExecutionError("MODEL_FINISH_ERROR", "Model stopped with an error");
    commitUsage(turnUsage, model);
    for (const call of calls) seenToolCallIds.add(call.id);
    finalText = text;
    if (calls.length === 0) {
      if (finishReason === "tool") throw new ComponentExecutionError("TOOL_CALL_MISSING", "Provider stopped for a Tool call without returning one");
      completed = true;
      await saveTurnCheckpoint(turn + 1, true);
      break;
    }
    if (modelTools.length === 0) throw new ComponentExecutionError("TOOL_NOT_CONNECTED", "Provider attempted to call a Tool but none are connected");
    if (turn === maxTurns) throw new ComponentExecutionError("AGENT_TURN_LIMIT", `Agent exceeded ${maxTurns} model turns`);
    messages.push({ role: "assistant", content: text, toolCalls: calls });
    const deferredControlMessages: ModelMessage[] = [];
    const siblingResults = [...(resumedPending ? restoredTurn?.siblingResults ?? [] : [])];
    const inFlightCalls = [...(resumedPending ? restoredTurn?.inFlightCalls ?? [] : [])];
    await saveTurnCheckpoint(turn, false, { pendingCalls: calls, pendingAssistantText: text, siblingResults, inFlightCalls });
    for (const call of calls) {
      const completedSibling = siblingResults.find((result) => result.callId === call.id);
      if (completedSibling) {
        messages.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: completedSibling.ok ? asText(completedSibling.output) : JSON.stringify({ error: completedSibling.error }),
        });
        continue;
      }
      toolCalls += 1;
      if (toolCalls > maxToolCalls) throw new ComponentExecutionError("AGENT_TOOL_CALL_LIMIT", `Agent exceeded ${maxToolCalls} Tool calls`);
      const binding = names.get(call.name);
      if (!binding) throw new ComponentExecutionError("TOOL_NOT_CONNECTED", `Tool '${call.name}' is not connected to this Agent`);
      const validateInput = new Ajv2020({ allErrors: true, strict: false, validateFormats: false }).compile(binding.inputSchema);
      const superseded = await applyControlUpdates(deferredControlMessages);
      const inputError = superseded ? `Tool '${binding.id}' was superseded by a newer instruction or plan revision`
        : validateInput(call.input) ? undefined
        : `Tool '${binding.id}' input is invalid: ${new Ajv2020().errorsText(validateInput.errors)}`;
      const risk = binding.risk ?? "external";
      let recoverySkip = false;
      if (resumedPending && risk !== "read" && inFlightCalls.includes(call.id)) {
        if (!context.requestInteraction) throw new ComponentExecutionError(
          "TOOL_RECOVERY_REQUIRED",
          `Tool '${binding.id}' may have completed before the last durable checkpoint`,
        );
        const recovery = await context.requestInteraction({
          id: `recovery_${context.nodeId}_${context.iteration}_${call.id}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128),
          nodeId: context.nodeId,
          kind: "select",
          requester: { kind: binding.source === "mcp" ? "mcp" : "tool", id: binding.id },
          title: "Tool completion unknown",
          message: `Tool '${binding.label}' may already have completed. Retry only after checking its external state.`,
          blocking: "run",
          schema: { type: "string", enum: ["retry", "mark_completed"] },
          data: {
            reason: "recovery_required",
            toolId: binding.id,
            callId: call.id,
            risk,
            input: boundedSnapshot(context.redact(call.input), 16_384),
          },
        });
        if (recovery.action !== "submit") throw new ComponentExecutionError("TOOL_RECOVERY_CANCELLED", "Tool recovery was cancelled");
        if (recovery.value === "mark_completed") recoverySkip = true;
        else if (recovery.value !== "retry") throw new ComponentExecutionError("TOOL_RECOVERY_INVALID", "Tool recovery choice is invalid");
      }
      context.emit({ type: "tool-call", tool: binding.id, input: call.input, callId: call.id, turn, risk });
      if (risk !== "read") await saveTurnCheckpoint(turn, false, { pendingCalls: calls, pendingAssistantText: text, siblingResults });
      const decision: ToolApprovalDecision = recoverySkip
        ? { approved: true, source: "user", reason: "User confirmed the prior Tool completion" }
        : inputError
        ? { approved: false, source: "policy", reason: inputError }
        : controlToolIds.has(binding.id)
          ? { approved: true, source: "policy", reason: "Harnest orchestration control" }
        : await approveToolCall(binding, call.input, call.id, turn, context);
      if (!inputError && decision.approved && !recoverySkip && risk !== "read" && !inFlightCalls.includes(call.id)) {
        inFlightCalls.push(call.id);
        await saveTurnCheckpoint(turn, false, { pendingCalls: calls, pendingAssistantText: text, siblingResults, inFlightCalls });
      }
      const started = performance.now();
      let result: unknown;
      let error = inputError;
      if (recoverySkip) {
        result = "[Tool completion confirmed by user; prior output is unavailable]";
      } else if (!error && !decision.approved) {
        error = asText(context.redact(decision.reason ?? "Tool execution was denied"));
      } else if (!error) {
        const timeoutSignal = AbortSignal.timeout(toolTimeoutMs);
        const signal = AbortSignal.any([context.signal, timeoutSignal]);
        const executionContext = { ...serviceContext(context), signal };
        try {
          signal.throwIfAborted();
          if (controlToolIds.has(binding.id)) {
            if (!context.agentControl) throw new Error(`Orchestration Tool '${binding.id}' is unavailable`);
            const controlled = await context.agentControl.execute(binding.id, call.input);
            result = controlled.value;
            if (controlled.usage) usage = sumUsage(usage, controlled.usage);
            if (controlled.usageKnown === false) usageKnown = false;
            costUsd += controlled.costUsd ?? 0;
            if (controlled.costKnown === false) costKnown = false;
            if (controlled.finishReason && controlled.finishReason !== "unknown") finishReason = controlled.finishReason;
          } else if (binding.source === "skill") {
            const resourcePath = asRecord(call.input)?.path;
            if (typeof resourcePath !== "string" || !binding.action || !context.services.loadSkillResource) {
              throw new Error(`Skill resource Tool '${binding.id}' is unavailable`);
            }
            const loaded = await promiseWithSignal(
              context.services.loadSkillResource(binding.action, resourcePath, executionContext),
              signal,
            );
            result = loaded.value;
            context.emit({
              type: "skill-use",
              skill: binding.action,
              resources: [resourcePath],
              ...(typeof loaded.metadata?.trusted === "boolean" ? { trusted: loaded.metadata.trusted } : {}),
            });
          } else if (binding.connectionId || binding.connectionKinds?.length || !context.tools.has(binding.id)) {
            if (!context.services.executeTool) throw new Error(`Tool '${binding.id}' requires a runtime Tool service`);
            result = (await promiseWithSignal(context.services.executeTool(binding, call.input, executionContext), signal)).value;
          } else {
            result = await promiseWithSignal(
              Promise.resolve(context.tools.get(binding.id).execute(call.input, executionContext)),
              signal,
            );
          }
          if (binding.outputSchema) {
            const validateOutput = new Ajv2020({ allErrors: true, strict: false, validateFormats: false }).compile(binding.outputSchema);
            if (!validateOutput(result)) throw new Error(`Tool output is invalid: ${new Ajv2020().errorsText(validateOutput.errors)}`);
          }
          result = context.redact(result);
        } catch (cause) {
          const message = timeoutSignal.aborted && !context.signal.aborted
            ? `Tool timed out after ${toolTimeoutMs}ms`
            : cause instanceof Error ? cause.message : "Tool execution failed";
          error = asText(context.redact(message));
        }
      }
      context.emit({
        type: "tool-result",
        tool: binding.id,
        ok: error === undefined,
        ...(error === undefined ? { output: binding.id === "harnest.request_interaction" && asRecord(result)
          ? {
              interactionId: asRecord(result)?.interactionId,
              action: asRecord(result)?.action,
              ...(asRecord(result)?.permission ? { permission: asRecord(result)?.permission } : {}),
            }
          : result } : { error }),
        durationMs: performance.now() - started,
        callId: call.id,
        turn,
      });
      if (error && !recoverToolErrors) throw new ComponentExecutionError(
        superseded ? "TOOL_CALL_SUPERSEDED" : inputError ? "TOOL_INPUT_INVALID" : decision.approved ? "TOOL_CALL_FAILED" : "TOOL_APPROVAL_DENIED",
        error,
      );
      messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: error === undefined ? asText(result) : JSON.stringify({ error }),
      });
      const evidence = workingState.recentToolEvidence ??= [];
      evidence.push(error === undefined
        ? { tool: binding.id, result: boundedSnapshot(result, 16_384) }
        : { tool: binding.id, error });
      if (evidence.length > 8) evidence.splice(0, evidence.length - 8);
      siblingResults.push({
        callId: call.id,
        name: call.name,
        tool: binding.id,
        ok: error === undefined,
        ...(error === undefined ? { output: boundedSnapshot(result, 262_144) } : { error }),
      });
      const inFlightIndex = inFlightCalls.indexOf(call.id);
      if (inFlightIndex >= 0) inFlightCalls.splice(inFlightIndex, 1);
      await saveTurnCheckpoint(turn, false, { pendingCalls: calls, pendingAssistantText: text, siblingResults, inFlightCalls });
    }
    messages.push(...deferredControlMessages);
    await applyControlUpdates();
    if (compactAtTokens !== undefined && Math.ceil(messageBytes(messages) / 4) >= compactAtTokens) {
      compactMessages(turn);
    }
    await saveTurnCheckpoint(turn + 1);
  }
  if (!completed) throw new ComponentExecutionError("AGENT_TURN_LIMIT", `Agent exceeded ${maxTurns} model turns`);
  const totalTokens = usage.totalTokens ?? (usage.inputTokens !== undefined && usage.outputTokens !== undefined
    ? usage.inputTokens + usage.outputTokens : undefined);
  if (typeof component.config.maxTokens === "number") {
    if (!usageKnown || totalTokens === undefined) throw new ComponentExecutionError(
      "AGENT_TOKEN_USAGE_UNAVAILABLE",
      "Agent token limit requires Provider usage reporting",
    );
    if (totalTokens > component.config.maxTokens) throw new ComponentExecutionError(
      "AGENT_TOKEN_LIMIT",
      `Agent exceeded ${component.config.maxTokens} tokens`,
    );
  }
  if (typeof component.config.maxCostUsd === "number") {
    if (!costKnown) throw new ComponentExecutionError(
      "AGENT_COST_UNAVAILABLE",
      "Agent cost limit requires Provider usage reporting and model pricing",
    );
    if (costUsd > component.config.maxCostUsd) throw new ComponentExecutionError(
      "AGENT_COST_LIMIT",
      `Agent exceeded $${component.config.maxCostUsd}`,
    );
  }
  return {
    outputs: { response: finalText },
    usage,
    usageKnown,
    costUsd,
    costKnown,
    finishReason,
  };
};

const outputExecutor: ComponentExecutor = (component, inputs) => {
  let value = inputs.value;
  const schema = asRecord(component.config.schema);
  if (component.config.format === "json" || schema) {
    if (typeof value === "string") {
      try {
        const fenced = /^\s*```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/iu.exec(value);
        value = JSON.parse(fenced?.[1] ?? value) as unknown;
      } catch (cause) {
        throw new ComponentExecutionError("OUTPUT_JSON_INVALID", "Model output is not valid JSON", { cause });
      }
    }
  }
  if (schema) {
    const validate = new Ajv2020({ allErrors: true, strict: false, validateFormats: false }).compile(schema);
    if (!validate(value)) {
      throw new ComponentExecutionError(
        "OUTPUT_SCHEMA_INVALID",
        `Output does not match the JSON Schema: ${new Ajv2020().errorsText(validate.errors)}`,
      );
    }
  }
  return { outputs: { value } };
};

const interactionExecutor: ComponentExecutor = async (component, inputs, context) => {
  if (!context.requestInteraction) throw new ComponentExecutionError("INTERACTION_UNAVAILABLE", "This runtime cannot pause for interaction");
  const kind = component.config.kind as InteractionRequest["kind"];
  const configuredData = asRecord(component.config.data);
  const response = await context.requestInteraction({
    id: `interaction_${context.nodeId}_${context.iteration}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128),
    kind,
    nodeId: context.nodeId,
    requester: { kind: "harness", id: context.nodeId },
    title: asText(component.config.title ?? "Input required"),
    message: asText(component.config.message ?? "Provide the requested input."),
    blocking: component.config.blocking === "task" ? "task" : "run",
    ...(asRecord(component.config.schema) ? { schema: component.config.schema as Readonly<Record<string, unknown>> } : {}),
    ...((configuredData || inputs.value !== undefined) ? { data: {
      ...configuredData,
      ...(inputs.value === undefined ? {} : { value: boundedSnapshot(inputs.value) }),
    } } : {}),
  });
  return {
    outputs: { value: response.value, response },
    traceOutput: {
      interactionId: response.interactionId,
      action: response.action,
      ...(response.permission ? { permission: response.permission } : {}),
    },
  };
};

const contextExecutor: ComponentExecutor = async (component, _inputs, context) => {
  if (component.config.source === "external") {
    const provider = context.services.providers?.conversation;
    const conversationId = typeof component.config.conversationId === "string"
      ? component.config.conversationId : context.session?.id;
    const contextRef = context.session?.contextRef;
    if (!provider || (!contextRef && !conversationId)) throw new ComponentExecutionError(
      "CONTEXT_SERVICE_UNAVAILABLE", "External Context requires a Conversation Provider and opaque context reference",
    );
    const loaded = await provider.read({
      ...(!contextRef && conversationId ? { conversationId } : {}),
      ...(component.config.revision === undefined ? {} : { revision: component.config.revision as ProviderRevision }),
      ...(contextRef ? { contextRef } : {}),
    }, serviceContext(context));
    const sources = normalizeContextSources(loaded.sources ?? []);
    const rendered = sources.map((source) =>
      `[${source.label}] ${source.provenance.title ?? source.provenance.source}\n${source.content}`).join("\n\n");
    context.emit({ type: "context-use", source: "external", metadata: {
      revision: loaded.revision,
      sources: sources.map(({ label, provenance }) => ({ label, provenance })),
    } });
    return { outputs: { context: rendered }, traceOutput: { revision: loaded.revision, sourceCount: sources.length } };
  }
  if (!context.services.loadContext) {
    throw new ComponentExecutionError("CONTEXT_SERVICE_UNAVAILABLE", "This runtime does not provide Context loading");
  }
  const result = await context.services.loadContext(component.config, context.runInput, serviceContext(context));
  context.emit({
    type: "context-use",
    source: typeof component.config.source === "string" ? component.config.source : "unknown",
    ...(result.metadata ? { metadata: result.metadata } : {}),
  });
  return {
    outputs: { context: result.value },
    ...(result.state ? { state: result.state } : {}),
    traceOutput: result.metadata ?? { loaded: true },
  };
};

const memoryExecutor: ComponentExecutor = async (component, inputs, context) => {
  const provider = context.services.providers?.memory;
  if (provider) {
    const namespace = component.config.namespace === "user" || component.config.namespace === "pkm"
      ? component.config.namespace : "conversation";
    const operation = component.config.operation;
    if (operation === "read") {
      const result = await provider.search({
        namespace,
        query: component.config.key,
        ...(component.config.revision === undefined ? {} : { revision: component.config.revision as ProviderRevision }),
        ...(context.session?.contextRef ? { contextRef: context.session.contextRef } : {}),
      }, serviceContext(context));
      return { outputs: { memory: result.records.map(({ value }) => value) }, traceOutput: {
        namespace, revision: result.revision, count: result.records.length,
      } };
    }
    const record = await provider.upsert({
      namespace,
      id: String(component.config.key),
      value: inputs.value,
      provenance: { source: "harnest", sourceId: context.nodeId },
      ...(component.config.revision === undefined ? {} : { revision: component.config.revision as ProviderRevision }),
      ...(context.session?.contextRef ? { contextRef: context.session.contextRef } : {}),
    }, serviceContext(context));
    return { outputs: { memory: record.value }, traceOutput: { namespace, revision: record.revision, id: record.id } };
  }
  if (!context.services.accessMemory) {
    throw new ComponentExecutionError("MEMORY_SERVICE_UNAVAILABLE", "This runtime does not provide Memory storage");
  }
  const result = await context.services.accessMemory(component.config, inputs.value, serviceContext(context));
  return {
    outputs: { memory: result.value },
    ...(result.state ? { state: result.state } : {}),
    traceOutput: result.metadata ?? { key: component.config.key, operation: component.config.operation },
  };
};

const toolReferenceExecutor: ComponentExecutor = (component, _inputs, context) => {
  const id = component.config.tool;
  if (typeof id !== "string" || !id) throw new ComponentExecutionError("TOOL_INVALID", "Tool reference requires config.tool");
  const registered = context.tools.has(id) ? context.tools.get(id) : undefined;
  const connectionId = typeof component.config.connectionId === "string" ? component.config.connectionId : undefined;
  const action = typeof component.config.action === "string" && component.config.action
    && (!registered || registered.source === "mcp") ? component.config.action : undefined;
  const bindingId = id;
  const binding = toolBinding(registered ? {
    ...registered,
    id: bindingId,
    ...(registered.connectionKinds?.length && connectionId ? { connectionId } : {}),
    ...(action ? { action } : {}),
    risk: registered.risk ?? "external",
  } : {
    ...component.config,
    id: bindingId,
    label: component.config.label ?? id,
    description: component.config.description ?? `Tool ${id}`,
    inputSchema: component.config.inputSchema ?? { type: "object", additionalProperties: true },
    // Unregistered/MCP metadata may raise risk, never lower the external-call default.
    risk: component.config.risk === "destructive" ? "destructive" : "external",
  });
  if (!binding) throw new ComponentExecutionError("TOOL_INVALID", `Tool '${id}' could not be attached`);
  return { outputs: { tool: binding }, traceOutput: { tool: binding.id, connectionId: binding.connectionId, risk: binding.risk } };
};

const skillReferenceExecutor: ComponentExecutor = (component) => {
  const id = component.config.skill;
  if (typeof id !== "string" || !id) throw new ComponentExecutionError("SKILL_INVALID", "Skill reference requires config.skill");
  return { outputs: { skill: { id } }, traceOutput: { skill: id, progressive: true } };
};

async function approveToolCall(
  binding: ToolBinding,
  input: unknown,
  callId: string,
  turn: number,
  context: ComponentExecutionContext,
): Promise<ToolApprovalDecision> {
  const risk = binding.risk ?? "external";
  const decision: ToolApprovalDecision = risk === "read"
    ? { approved: true, source: "policy" }
    : context.requestToolApproval
      ? await promiseWithSignal(Promise.resolve(context.requestToolApproval({
          runId: context.runId,
          nodeId: context.nodeId,
          callId,
          turn,
          tool: binding,
          input,
        })), context.signal)
      : context.services.requestToolApproval
        ? await promiseWithSignal(Promise.resolve(context.services.requestToolApproval({
          runId: context.runId,
          nodeId: context.nodeId,
          callId,
          turn,
          tool: binding,
          input,
        }, serviceContext(context))), context.signal)
        : { approved: false, source: "policy", reason: `Tool risk '${risk}' requires explicit approval` };
  context.signal.throwIfAborted();
  context.emit({
    type: "tool-approval",
    tool: binding.id,
    callId,
    turn,
    approved: decision.approved,
    ...(decision.source ? { source: decision.source } : {}),
    ...(decision.reason ? { reason: decision.reason } : {}),
  });
  return decision;
}

async function directSideEffectRecovery(
  binding: ToolBinding,
  input: unknown,
  callId: string,
  context: ComponentExecutionContext,
): Promise<{
  readonly key?: string;
  readonly inputDigest?: string;
  readonly completed?: ComponentExecutionResult;
}> {
  if ((binding.risk ?? "external") === "read") return {};
  if (!context.sideEffectCheckpoint || !context.saveSideEffectCheckpoint) {
    throw new ComponentExecutionError("TOOL_CHECKPOINT_UNAVAILABLE", `Tool '${binding.id}' requires a durable side-effect checkpoint`);
  }
  const key = `${context.nodeId}:${context.iteration}:${callId}`;
  const inputDigest = await sha256(JSON.stringify(snapshotToolInput(input)) ?? "undefined");
  const saved = context.sideEffectCheckpoint(key);
  if (saved && saved.inputDigest !== inputDigest) {
    throw new ComponentExecutionError("TOOL_CHECKPOINT_CONFLICT", `Tool '${binding.id}' input changed after its durable checkpoint`);
  }
  if (saved?.status === "completed") {
    const result = asRecord(saved.result);
    if (!result || !asRecord(result.outputs)) throw new ComponentExecutionError(
      "TOOL_CHECKPOINT_INVALID", `Tool '${binding.id}' completed checkpoint is invalid`,
    );
    return { completed: result as unknown as ComponentExecutionResult };
  }
  if (saved?.status === "in_flight") {
    if (!context.requestInteraction) throw new ComponentExecutionError(
      "TOOL_RECOVERY_REQUIRED", `Tool '${binding.id}' may have completed before the last durable checkpoint`,
    );
    const recovery = await context.requestInteraction({
      id: `recovery_${context.nodeId}_${context.iteration}_${callId}`.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 128),
      nodeId: context.nodeId,
      kind: "select",
      requester: { kind: binding.source === "mcp" ? "mcp" : "tool", id: binding.id },
      title: "Tool completion unknown",
      message: `Tool '${binding.label}' may already have completed. Retry only after checking its external state.`,
      blocking: "run",
      schema: { type: "string", enum: ["retry", "mark_completed"] },
      data: {
        reason: "recovery_required",
        toolId: binding.id,
        callId,
        risk: binding.risk ?? "external",
        input: boundedSnapshot(context.redact(input), 16_384),
      },
    });
    if (recovery.action !== "submit") throw new ComponentExecutionError("TOOL_RECOVERY_CANCELLED", "Tool recovery was cancelled");
    if (recovery.value === "mark_completed") {
      const completed: ComponentExecutionResult = {
        outputs: { result: "[Tool completion confirmed by user; prior output is unavailable]" },
      };
      await context.saveSideEffectCheckpoint(key, {
        nodeId: context.nodeId, iteration: context.iteration, inputDigest, status: "completed", result: completed,
      });
      return { completed };
    }
    if (recovery.value !== "retry") throw new ComponentExecutionError("TOOL_RECOVERY_INVALID", "Tool recovery choice is invalid");
  }
  return { key, inputDigest };
}

async function checkpointDirectSideEffect(
  recovery: { readonly key?: string; readonly inputDigest?: string },
  status: "in_flight" | "completed",
  context: ComponentExecutionContext,
  result?: ComponentExecutionResult,
): Promise<void> {
  if (!recovery.key || !recovery.inputDigest || !context.saveSideEffectCheckpoint) return;
  const savedResult = result === undefined ? undefined : boundedSnapshot(result, 1_048_576);
  if (result !== undefined && (!asRecord(savedResult) || !asRecord(asRecord(savedResult)?.outputs))) {
    throw new ComponentExecutionError("TOOL_RESULT_CHECKPOINT_LIMIT", "Tool result is too large or non-serializable for safe recovery");
  }
  await context.saveSideEffectCheckpoint(recovery.key, {
    nodeId: context.nodeId,
    iteration: context.iteration,
    inputDigest: recovery.inputDigest,
    status,
    ...(savedResult === undefined ? {} : { result: savedResult }),
  });
}

const localToolExecutor: ComponentExecutor = async (component, inputs, context) => {
  const toolId = component.config.tool;
  if (typeof toolId !== "string") throw new ComponentExecutionError("TOOL_INVALID", "Local Tool requires config.tool");
  const tool = context.tools.get(toolId);
  if (tool.connectionKinds?.length) {
    throw new ComponentExecutionError(
      "TOOL_CONNECTION_REQUIRED",
      `Tool '${toolId}' requires a Connection and must use the Agent Tool attachment component`,
    );
  }
  const validate = new Ajv2020({ allErrors: true, strict: false, validateFormats: false }).compile(tool.inputSchema);
  const toolInput = snapshotToolInput(inputs.arguments ?? context.runInput);
  if (!validate(toolInput)) {
    throw new ComponentExecutionError("TOOL_INPUT_INVALID", `Tool input is invalid: ${new Ajv2020().errorsText(validate.errors)}`);
  }
  const started = performance.now();
  const callId = `${context.nodeId}:${context.iteration}:local`;
  const binding: ToolBinding = { ...tool, risk: tool.risk ?? "external" };
  assertAgentToolCapability(context, binding);
  const recovery = await directSideEffectRecovery(binding, toolInput, callId, context);
  if (recovery.completed) return recovery.completed;
  context.emit({ type: "tool-call", tool: tool.id, input: toolInput, callId, turn: 1, risk: binding.risk ?? "external" });
  const decision = await approveToolCall(binding, toolInput, callId, 1, context);
  if (!decision.approved) {
    const message = decision.reason ?? "Tool execution was denied";
    context.emit({ type: "tool-result", tool: tool.id, callId, turn: 1, ok: false, error: message, durationMs: performance.now() - started });
    throw new ComponentExecutionError("TOOL_APPROVAL_DENIED", message);
  }
  try {
    await checkpointDirectSideEffect(recovery, "in_flight", context);
    const output = await tool.execute(toolInput, serviceContext(context));
    const safeOutput = context.redact(output);
    const completed = { outputs: { result: safeOutput } } satisfies ComponentExecutionResult;
    await checkpointDirectSideEffect(recovery, "completed", context, completed);
    context.emit({ type: "tool-result", tool: tool.id, callId, turn: 1, ok: true, output: safeOutput, durationMs: performance.now() - started });
    return completed;
  } catch (cause) {
    const message = asText(context.redact(cause instanceof Error ? cause.message : "Tool call failed"));
    context.emit({ type: "tool-result", tool: tool.id, callId, turn: 1, ok: false, error: message, durationMs: performance.now() - started });
    throw new ComponentExecutionError("TOOL_CALL_FAILED", message, { cause });
  }
};

const mcpToolExecutor: ComponentExecutor = async (component, inputs, context) => {
  if (!context.services.callMcpTool) {
    throw new ComponentExecutionError("MCP_SERVICE_UNAVAILABLE", "This runtime does not provide MCP Tool execution");
  }
  const action = typeof component.config.tool === "string" ? component.config.tool : "unknown";
  const connectionId = typeof component.config.connectionId === "string" ? component.config.connectionId : undefined;
  const tool = action;
  const toolInput = snapshotToolInput(inputs.arguments ?? context.runInput);
  const started = performance.now();
  const callId = `${context.nodeId}:${context.iteration}:mcp`;
  const binding: ToolBinding = {
    id: tool,
    label: tool,
    description: `MCP Tool ${tool}`,
    inputSchema: { type: "object", additionalProperties: true },
    risk: component.config.risk === "destructive" ? "destructive" : "external",
    source: "mcp",
    ...(connectionId ? { connectionId, action } : {}),
  };
  assertAgentToolCapability(context, binding);
  const recovery = await directSideEffectRecovery(binding, toolInput, callId, context);
  if (recovery.completed) return recovery.completed;
  context.emit({ type: "tool-call", tool, input: toolInput, callId, turn: 1, risk: binding.risk ?? "external" });
  const decision = await approveToolCall(binding, toolInput, callId, 1, context);
  if (!decision.approved) {
    const message = decision.reason ?? "MCP Tool execution was denied";
    context.emit({ type: "tool-result", tool, callId, turn: 1, ok: false, error: message, durationMs: performance.now() - started });
    throw new ComponentExecutionError("TOOL_APPROVAL_DENIED", message);
  }
  try {
    await checkpointDirectSideEffect(recovery, "in_flight", context);
    const result = await context.services.callMcpTool(component.config, toolInput, serviceContext(context));
    const safeValue = context.redact(result.value);
    const completed = {
      outputs: { result: safeValue },
      ...(result.state ? { state: result.state } : {}),
      traceOutput: result.metadata ?? { tool, ok: true },
    } satisfies ComponentExecutionResult;
    await checkpointDirectSideEffect(recovery, "completed", context, completed);
    context.emit({ type: "tool-result", tool, callId, turn: 1, ok: true, output: safeValue, durationMs: performance.now() - started });
    return completed;
  } catch (cause) {
    const message = asText(context.redact(cause instanceof Error ? cause.message : "MCP Tool call failed"));
    context.emit({ type: "tool-result", tool, callId, turn: 1, ok: false, error: message, durationMs: performance.now() - started });
    throw new ComponentExecutionError("MCP_TOOL_CALL_FAILED", message, { cause });
  }
};

const routerExecutor: ComponentExecutor = (component, inputs, context) => {
  const predicate = component.config.condition as PredicateSpec;
  const matched = evaluatePredicate(predicate, inputs.value, context.state, context.runInput);
  return { outputs: { [matched ? "true" : "false"]: inputs.value }, traceOutput: { branch: matched ? "true" : "false" } };
};

const classifierExecutor: ComponentExecutor = async (component, inputs, context) => {
  const routes = Array.isArray(component.config.routes)
    ? component.config.routes.filter((route): route is string => typeof route === "string") : [];
  const fallback = typeof component.config.fallback === "string" ? component.config.fallback : routes[0];
  if (!fallback || !routes.includes(fallback)) throw new ComponentExecutionError("CLASSIFIER_INVALID", "Classifier fallback must be one of its routes");
  const value = inputs.value ?? context.runInput;
  const prompt = typeof inputs.prompt === "string" && inputs.prompt.trim()
    ? `${inputs.prompt}\n\nInput to classify:\n${asText(value)}`
    : `Classify the user request into exactly one route: ${routes.join(", ")}. Return JSON only.\n\nInput:\n${asText(value)}`;
  const responseSchema = {
    type: "object",
    properties: {
      route: { type: "string", enum: routes },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
    required: ["route", "confidence"],
    additionalProperties: false,
  } as const;
  const classified = await agentExecutor(
    { id: component.id, type: "agent", config: { maxTurns: 1, maxToolCalls: 1, multimodal: false } },
    { model: inputs.model, prompt },
    { ...context, responseSchema },
  );
  let decision: Record<string, unknown> | undefined;
  try {
    decision = asRecord(JSON.parse(asText(classified.outputs.response)));
  } catch {
    decision = undefined;
  }
  const confidence = typeof decision?.confidence === "number" ? decision.confidence : 0;
  const minimum = typeof component.config.minConfidence === "number" ? component.config.minConfidence : 0;
  const route = typeof decision?.route === "string" && routes.includes(decision.route) && confidence >= minimum
    ? decision.route : fallback;
  const normalized = { route, confidence, fallback: route === fallback && decision?.route !== fallback, value };
  return {
    ...classified,
    outputs: { value, route, decision: normalized },
    traceOutput: normalized,
  };
};

function evaluatorResult(component: ComponentSpec, value: unknown, context: ComponentExecutionContext) {
  const type = component.config.type;
  let passed = false;
  let message: string | undefined;
  if (type === "equals") passed = Object.is(value, component.config.value);
  else if (type === "includes") passed = asText(value).includes(asText(component.config.value));
  else if (type === "matches") passed = typeof component.config.value === "string"
    && safeRegexTest(component.config.value, asText(value));
  else if (type === "output-schema") {
    const schema = asRecord(component.config.schema);
    if (!schema) message = "Evaluator requires schema";
    else passed = Boolean(new Ajv2020({ strict: false, validateFormats: false }).compile(schema)(value));
  } else if (type === "tool-called") {
    const tool = typeof component.config.tool === "string" ? component.config.tool : "";
    const calls = context.metrics.toolCalls.get(tool) ?? 0;
    const min = typeof component.config.minCalls === "number" ? component.config.minCalls : 1;
    const max = typeof component.config.maxCalls === "number" ? component.config.maxCalls : Number.POSITIVE_INFINITY;
    passed = calls >= min && calls <= max;
  } else if (type === "latency") {
    passed = typeof component.config.maxMs === "number" && context.metrics.durationMs <= component.config.maxMs;
  } else if (type === "iterations") {
    const min = typeof component.config.min === "number" ? component.config.min : 0;
    const max = typeof component.config.max === "number" ? component.config.max : Number.POSITIVE_INFINITY;
    passed = context.metrics.iterations >= min && context.metrics.iterations <= max;
  }
  return { type: String(type), passed, ...(message ? { message } : {}) };
}

const evaluatorExecutor: ComponentExecutor = (component, inputs, context) => {
  const evaluation = evaluatorResult(component, inputs.value, context);
  context.emit({
    type: "evaluation",
    evaluator: evaluation.type,
    passed: evaluation.passed,
    ...(evaluation.message ? { message: evaluation.message } : {}),
  });
  return { outputs: { value: inputs.value, evaluation }, traceOutput: evaluation };
};

const joinExecutor: ComponentExecutor = (component, inputs) => {
  const joined = values(inputs.values);
  const mode = component.config.mode ?? "array";
  let value: unknown = joined;
  if (mode === "concat") value = joined.map(asText).join(typeof component.config.separator === "string" ? component.config.separator : "\n");
  if (mode === "object") {
    const keys = Array.isArray(component.config.keys) ? component.config.keys : [];
    value = Object.fromEntries(joined.flatMap((item, index) => item === undefined
      ? []
      : [[typeof keys[index] === "string" ? keys[index] : String(index), item]]));
  }
  return { outputs: { value } };
};

const subgraphExecutor: ComponentExecutor = async (component, inputs, context) => {
  const name = component.config.subgraph;
  if (typeof name !== "string") throw new ComponentExecutionError("SUBGRAPH_INVALID", "Subgraph requires config.subgraph");
  const result = await context.runSubgraph(name, inputs.value ?? context.runInput, { state: context.state });
  return {
    ...result,
    outputs: { value: result.outputs.value },
  };
};

const teamExecutor: ComponentExecutor = async (component, inputs, context) => {
  const name = component.config.team;
  if (typeof name !== "string") throw new ComponentExecutionError("TEAM_INVALID", "Team requires config.team");
  const result = await context.runTeam(name, inputs.value ?? context.runInput);
  return { ...result, outputs: { value: result.outputs.value } };
};

const loopExecutor: ComponentExecutor = async (component, inputs, context) => {
  const name = component.config.subgraph;
  const maxIterations = component.config.maxIterations;
  if (typeof name !== "string" || typeof maxIterations !== "number") {
    throw new ComponentExecutionError("LOOP_INVALID", "Loop requires subgraph and maxIterations");
  }
  const timeout = typeof component.config.timeoutMs === "number" ? AbortSignal.timeout(component.config.timeoutMs) : undefined;
  const signal = timeout ? AbortSignal.any([context.signal, timeout]) : context.signal;
  let value = inputs.value ?? context.runInput;
  const checkpoint = component.config.checkpoint === "structured";
  const initialCheckpoint = checkpoint ? asRecord(value) : undefined;
  const immutableCheckpoint = initialCheckpoint ? Object.fromEntries(
    ["originalRequest", "objective", "plan"].flatMap((key) => Object.hasOwn(initialCheckpoint, key)
      ? [[key, structuredClone(initialCheckpoint[key])]] : []),
  ) : {};
  let state = { ...context.state };
  let usage: TokenUsage = {};
  let usageKnown = true;
  let costUsd = 0;
  let costKnown = true;
  let exited = component.config.until === undefined;
  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    signal.throwIfAborted();
    context.metrics.iterations += 1;
    context.emit({ type: "iteration", iteration, phase: "start" });
    let result: ComponentExecutionResult;
    try {
      result = await context.runSubgraph(name, value, { signal, iteration, state });
    } catch (cause) {
      if (timeout?.aborted && !context.signal.aborted) {
        throw new ComponentExecutionError("LOOP_TIMEOUT", "Loop timed out", { cause });
      }
      throw cause;
    }
    const nextValue = result.outputs.value;
    value = component.config.carry === "merge"
      && asRecord(value) && asRecord(nextValue)
      ? { ...asRecord(value), ...asRecord(nextValue) }
      : nextValue;
    if (checkpoint) {
      const record = asRecord(value);
      if (!record) throw new ComponentExecutionError("LOOP_CHECKPOINT_INVALID", "Structured Loop iterations must return an object checkpoint");
      value = { ...record, ...immutableCheckpoint };
    }
    state = { ...state, ...result.state };
    usage = sumUsage(usage, result.usage ?? {});
    if (result.usageKnown === false
      || (result.usage !== undefined && result.usage.totalTokens === undefined
        && (result.usage.inputTokens === undefined || result.usage.outputTokens === undefined))) usageKnown = false;
    costUsd += result.costUsd ?? 0;
    if (result.costKnown === false) costKnown = false;
    context.emit({ type: "iteration", iteration, phase: "end", output: result.traceOutput ?? value });
    const maxTokens = component.config.maxTokens;
    if (typeof maxTokens === "number" && !usageKnown) {
      throw new ComponentExecutionError("LOOP_TOKEN_USAGE_UNAVAILABLE", "Loop token usage cannot be enforced because usage data is unavailable");
    }
    if (typeof maxTokens === "number" && (usage.totalTokens ?? 0) > maxTokens) {
      throw new ComponentExecutionError("LOOP_TOKEN_LIMIT", `Loop exceeded ${maxTokens} tokens`);
    }
    const maxCostUsd = component.config.maxCostUsd;
    if (typeof maxCostUsd === "number" && !costKnown) {
      throw new ComponentExecutionError("LOOP_COST_UNAVAILABLE", "Loop cost cannot be enforced because model pricing or token usage is unavailable");
    }
    if (typeof maxCostUsd === "number" && costUsd > maxCostUsd) {
      throw new ComponentExecutionError("LOOP_COST_LIMIT", `Loop exceeded $${maxCostUsd}`);
    }
    const conditionValue = Object.hasOwn(result.outputs, "evaluation") ? result.outputs : value;
    if (component.config.until !== undefined
      && evaluatePredicate(component.config.until as PredicateSpec, conditionValue, state, context.runInput)) {
      if (checkpoint) {
        const completed = asRecord(value);
        const validation = asRecord(completed?.validation);
        if (completed?.status !== "complete" || validation?.passed !== true
          || !Array.isArray(completed.remainingWork) || completed.remainingWork.length !== 0
          || typeof completed.finalAnswer !== "string" || !completed.finalAnswer.trim()) {
          throw new ComponentExecutionError(
            "LOOP_COMPLETION_INVALID",
            "Structured Loop completion requires status=complete, passed validation, no remaining work, and a non-empty final answer",
          );
        }
      }
      exited = true;
      break;
    }
  }
  if (!exited) throw new ComponentExecutionError("LOOP_ITERATION_LIMIT", `Loop did not satisfy its exit condition within ${maxIterations} iterations`);
  return { outputs: { value }, state, usage, usageKnown, costUsd, costKnown };
};

const objectSchema = (properties: Record<string, unknown>, required: string[] = []): Readonly<Record<string, unknown>> => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

const componentDiagnostic = (
  code: string,
  path: string,
  message: string,
  componentId: string,
): Diagnostic => ({ code, path, message, componentId, severity: "error" });

const MCP_CREDENTIAL_FIELD = /(?:password|passphrase|secret|token|api[-_]?key|access[-_]?token|credential|private[-_]?key)/iu;
const MCP_SECRET_VALUE = /(?:\bbearer\s+[A-Za-z0-9._~+/=-]+|\b(?:password|secret|token|api[-_]?key)\s*[=:]\s*\S+|\bsk-[A-Za-z0-9_-]{12,}|\benv:[A-Za-z_][A-Za-z0-9_]*)/i;

const validateModelComponent: NonNullable<ComponentDefinition["validate"]> = (component, context) => {
  const hasConnection = typeof component.config.connectionId === "string" && component.config.connectionId.length > 0;
  const hasLegacy = typeof component.config.adapter === "string" && component.config.adapter.length > 0
    && typeof component.config.model === "string" && component.config.model.length > 0;
  const diagnostics = hasConnection || hasLegacy ? [] : [componentDiagnostic(
      "MODEL_CONNECTION_REQUIRED",
      `${context.path}.config.connectionId`,
      "Model requires a saved Provider Connection or legacy adapter and model",
      component.id,
    )];
  if (hasConnection && component.config.fallbackConnectionId === component.config.connectionId) diagnostics.push(componentDiagnostic(
    "MODEL_FALLBACK_DUPLICATE",
    `${context.path}.config.fallbackConnectionId`,
    "Fallback Provider must differ from the primary Provider",
    component.id,
  ));
  return diagnostics;
};

const validateContextComponent: NonNullable<ComponentDefinition["validate"]> = (component, context) => {
  const source = component.config.source;
  if (source === "text" && (typeof component.config.text !== "string" || component.config.text.length === 0)) {
    return [componentDiagnostic("CONTEXT_TEXT_REQUIRED", `${context.path}.config.text`, "Static Context requires non-empty text", component.id)];
  }
  if ((source === "file" || source === "directory")
    && (typeof component.config.path !== "string" || component.config.path.length === 0)) {
    return [componentDiagnostic("CONTEXT_PATH_REQUIRED", `${context.path}.config.path`, `${source} Context requires a project-relative path`, component.id)];
  }
  return [];
};

const validateMcpComponent: NonNullable<ComponentDefinition["validate"]> = (component, context) => {
  const diagnostics: Diagnostic[] = [];
  const hasConnection = typeof component.config.connectionId === "string" && component.config.connectionId.length > 0;
  const headers = asRecord(component.config.headers);
  for (const [name, reference] of Object.entries(headers ?? {})) {
    if (typeof reference !== "string" || !/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(reference)) {
      diagnostics.push(componentDiagnostic(
        "SECRET_LITERAL",
        `${context.path}.config.headers.${name}`,
        "MCP header values must use env:NAME references",
        component.id,
      ));
    }
  }
  if (typeof component.config.url === "string" && component.config.url.length > 0) {
    try {
      const url = new URL(component.config.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocol");
      if (url.username || url.password) diagnostics.push(componentDiagnostic(
        "SECRET_LITERAL",
        `${context.path}.config.url`,
        "MCP URL must not contain embedded credentials",
        component.id,
      ));
      if ([...url.searchParams].some(([name, value]) => MCP_CREDENTIAL_FIELD.test(name) || MCP_SECRET_VALUE.test(value))) {
        diagnostics.push(componentDiagnostic(
          "SECRET_LITERAL",
          `${context.path}.config.url`,
          "MCP URL query parameters must not contain credentials",
          component.id,
        ));
      }
    } catch {
      diagnostics.push(componentDiagnostic("MCP_URL_INVALID", `${context.path}.config.url`, "MCP URL must use http or https", component.id));
    }
  }
  if (hasConnection) return diagnostics;
  if (component.config.transport === "stdio"
    && (typeof component.config.command !== "string" || component.config.command.length === 0)) {
    diagnostics.push(componentDiagnostic("MCP_COMMAND_REQUIRED", `${context.path}.config.command`, "stdio MCP requires a command", component.id));
  }
  if (component.config.transport === "http") {
    if (typeof component.config.url !== "string" || component.config.url.length === 0) {
      diagnostics.push(componentDiagnostic("MCP_URL_REQUIRED", `${context.path}.config.url`, "HTTP MCP requires a URL", component.id));
    }
  }
  return diagnostics;
};

const validateEvaluatorComponent: NonNullable<ComponentDefinition["validate"]> = (component, context) => {
  const diagnostics: Diagnostic[] = [];
  const type = component.config.type;
  if ((type === "equals" || type === "includes" || type === "matches")
    && !Object.hasOwn(component.config, "value")) diagnostics.push(componentDiagnostic(
    "EVALUATOR_VALUE_REQUIRED",
    `${context.path}.config.value`,
    `${String(type)} Evaluator requires a value`,
    component.id,
  ));
  if (type === "matches" && Object.hasOwn(component.config, "value")) {
    if (typeof component.config.value !== "string") diagnostics.push(componentDiagnostic(
      "EVALUATOR_VALUE_INVALID",
      `${context.path}.config.value`,
      "matches Evaluator requires a string pattern",
      component.id,
    ));
    else {
      const issue = inspectSafeRegex(component.config.value);
      if (issue) diagnostics.push(componentDiagnostic(
        issue.code === "REGEX_INVALID" ? "EVALUATOR_REGEX_INVALID" : "EVALUATOR_REGEX_UNSAFE",
        `${context.path}.config.value`,
        issue.message,
        component.id,
      ));
    }
  }
  if (type === "output-schema" && !asRecord(component.config.schema)) diagnostics.push(componentDiagnostic(
    "EVALUATOR_SCHEMA_REQUIRED",
    `${context.path}.config.schema`,
    "output-schema Evaluator requires a JSON Schema",
    component.id,
  ));
  if (type === "tool-called" && (typeof component.config.tool !== "string" || component.config.tool.length === 0)) {
    diagnostics.push(componentDiagnostic(
      "EVALUATOR_TOOL_REQUIRED",
      `${context.path}.config.tool`,
      "tool-called Evaluator requires a tool id",
      component.id,
    ));
  }
  if (type === "tool-called" && typeof component.config.minCalls === "number"
    && typeof component.config.maxCalls === "number" && component.config.maxCalls < component.config.minCalls) {
    diagnostics.push(componentDiagnostic(
      "EVALUATOR_RANGE_INVALID",
      `${context.path}.config.maxCalls`,
      "maxCalls must be at least minCalls",
      component.id,
    ));
  }
  if (type === "latency" && (typeof component.config.maxMs !== "number" || component.config.maxMs <= 0)) {
    diagnostics.push(componentDiagnostic(
      "EVALUATOR_LATENCY_BOUND_REQUIRED",
      `${context.path}.config.maxMs`,
      "latency Evaluator requires a positive maxMs",
      component.id,
    ));
  }
  if (type === "iterations" && typeof component.config.min !== "number" && typeof component.config.max !== "number") {
    diagnostics.push(componentDiagnostic(
      "EVALUATOR_ITERATION_BOUND_REQUIRED",
      `${context.path}.config`,
      "iterations Evaluator requires min or max",
      component.id,
    ));
  }
  if (type === "iterations" && typeof component.config.min === "number"
    && typeof component.config.max === "number" && component.config.max < component.config.min) {
    diagnostics.push(componentDiagnostic(
      "EVALUATOR_RANGE_INVALID",
      `${context.path}.config.max`,
      "max must be at least min",
      component.id,
    ));
  }
  return diagnostics;
};

const validateClassifierComponent: NonNullable<ComponentDefinition["validate"]> = (component, context) => {
  const routes = Array.isArray(component.config.routes)
    ? component.config.routes.filter((route): route is string => typeof route === "string") : [];
  return typeof component.config.fallback === "string" && routes.includes(component.config.fallback) ? [] : [componentDiagnostic(
    "CLASSIFIER_FALLBACK_INVALID",
    `${context.path}.config.fallback`,
    "Classifier fallback must be one of its routes",
    component.id,
  )];
};

const predicateJsonSchema = {
  type: "object",
  properties: {
    source: { enum: ["value", "state", "input"] },
    path: { type: "string", pattern: "^(?:|/.*)$" },
    op: { enum: ["equals", "notEquals", "contains", "matches", "exists", "truthy", "gt", "gte", "lt", "lte"] },
    value: {},
  },
  required: ["op"],
  additionalProperties: false,
} as const;

const definitions: readonly ComponentDefinition[] = [
  {
    type: "model", label: "Model", category: "Agent", description: "Provider-independent model configuration",
    ports: { inputs: {}, outputs: { model: { type: "model" } } },
    configSchema: objectSchema({
      connectionId: { type: "string", minLength: 1 }, fallbackConnectionId: { type: "string", minLength: 1 },
      adapter: { type: "string", minLength: 1 }, model: { type: "string", minLength: 1 }, apiKey: { type: "string" },
      baseUrl: { type: "string", format: "uri" }, temperature: { type: "number", minimum: 0, maximum: 2 },
      maxTokens: { type: "integer", minimum: 1 }, inputCostPerMillion: { type: "number", minimum: 0 },
      outputCostPerMillion: { type: "number", minimum: 0 }, contextWindowTokens: { type: "integer", minimum: 1 },
      cacheDialect: { enum: ["auto", "native", "none"] },
      cachedInputCostPerMillion: { type: "number", minimum: 0 },
      cacheWriteCostPerMillion: { type: "number", minimum: 0 },
      cacheStorageCostPerMillionHour: { type: "number", minimum: 0 },
    }),
    inspector: [
      { path: "connectionId", label: "Provider connection", control: "text" },
      { path: "fallbackConnectionId", label: "Fallback Provider connection", control: "text" },
      { path: "adapter", label: "Adapter", control: "text" },
      { path: "model", label: "Model", control: "text" },
      { path: "apiKey", label: "API key reference", control: "text" },
      { path: "baseUrl", label: "Custom endpoint", control: "text" },
      { path: "temperature", label: "Temperature", control: "number" },
      { path: "maxTokens", label: "Max tokens", control: "number" },
      { path: "contextWindowTokens", label: "Context window tokens", control: "number" },
      { path: "cacheDialect", label: "Prompt cache dialect", control: "select", options: [
        { label: "Automatic", value: "auto" }, { label: "Provider native", value: "native" }, { label: "Disabled", value: "none" },
      ] },
      { path: "inputCostPerMillion", label: "Input $ / 1M", control: "number" },
      { path: "outputCostPerMillion", label: "Output $ / 1M", control: "number" },
      { path: "cachedInputCostPerMillion", label: "Cached input $ / 1M", control: "number" },
      { path: "cacheWriteCostPerMillion", label: "Cache write $ / 1M", control: "number" },
      { path: "cacheStorageCostPerMillionHour", label: "Cache storage $ / 1M / hour", control: "number" },
    ],
    defaultConfig: { adapter: "ollama", model: "llama3.2" }, retrySafe: true, validate: validateModelComponent, execute: modelExecutor,
  },
  {
    type: "prompt", label: "Prompt", category: "Agent", description: "Prompt template with {{input}} interpolation",
    ports: { inputs: {}, outputs: { prompt: { type: "prompt" } } },
    configSchema: objectSchema({ template: { type: "string", minLength: 1 } }, ["template"]),
    inspector: [{ path: "template", label: "Template", control: "textarea", required: true }],
    defaultConfig: { template: "Answer the user clearly and directly.\n\n{{input}}" }, retrySafe: true, execute: promptExecutor,
  },
  {
    type: "agent", label: "Agent", category: "Agent", description: "Runs a model with connected prompt and resources",
    ports: {
      inputs: {
        model: { type: "model", required: true, maxConnections: 1 },
        prompt: { type: "prompt", required: true, maxConnections: 1 },
        context: { type: "context", variadic: true },
        memory: { type: "memory", maxConnections: 1 },
        tools: { type: "tool", variadic: true },
        skills: { type: "skill", variadic: true },
        toolResults: { type: "any", variadic: true },
      },
      outputs: { response: { type: "text" } },
    },
    configSchema: objectSchema({
      system: { type: "string" }, timeoutMs: { type: "integer", minimum: 1, maximum: 600000 },
      maxTurns: { type: "integer", minimum: 1, maximum: 32 }, maxToolCalls: { type: "integer", minimum: 1, maximum: 128 },
      toolTimeoutMs: { type: "integer", minimum: 1, maximum: 600000 }, toolError: { enum: ["model", "fail"] },
      compactAtTokens: { type: "integer", minimum: 256, maximum: 1000000 },
      multimodal: { type: "boolean" },
      maxTokens: { type: "integer", minimum: 1 }, maxCostUsd: { type: "number", exclusiveMinimum: 0 },
      allowTools: { type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true },
      denyTools: { type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true },
    }),
    inspector: [
      { path: "system", label: "System prompt", control: "textarea" },
      { path: "timeoutMs", label: "Timeout (ms)", control: "number" },
      { path: "maxTurns", label: "Max model turns", control: "number" },
      { path: "maxToolCalls", label: "Max Tool calls", control: "number" },
      { path: "toolTimeoutMs", label: "Tool timeout (ms)", control: "number" },
      { path: "compactAtTokens", label: "Compact context at tokens", control: "number" },
      { path: "multimodal", label: "Send supported media directly to the model", control: "checkbox" },
      { path: "maxTokens", label: "Agent token limit", control: "number" },
      { path: "maxCostUsd", label: "Agent cost limit ($)", control: "number" },
      { path: "allowTools", label: "Allowed Tools", control: "json" },
      { path: "denyTools", label: "Denied Tools", control: "json" },
      { path: "toolError", label: "Tool error recovery", control: "select", options: [
        { label: "Return error to model", value: "model" }, { label: "Fail run", value: "fail" },
      ] },
    ],
    defaultConfig: { maxTurns: 8, maxToolCalls: 32, toolTimeoutMs: 30000, toolError: "model", multimodal: true }, retrySafe: true,
    traceInputs: (inputs) => ({
      model: asRecord(inputs.model) ? { adapter: asRecord(inputs.model)?.adapter, model: asRecord(inputs.model)?.model } : undefined,
      prompt: inputs.prompt,
      contextCount: values(inputs.context).length,
      memoryConnected: inputs.memory !== undefined,
      connectedTools: values(inputs.tools).flatMap((value) => typeof asRecord(value)?.id === "string" ? [asRecord(value)?.id] : []),
      connectedSkills: values(inputs.skills).flatMap((value) => typeof asRecord(value)?.id === "string" ? [asRecord(value)?.id] : []),
      toolResultCount: values(inputs.toolResults).length,
    }),
    execute: agentExecutor,
  },
  {
    type: "interaction", label: "Interaction", category: "Flow", description: "Pauses for host or user input",
    ports: { inputs: { value: { type: "any", maxConnections: 1 } }, outputs: { value: { type: "any" }, response: { type: "any" } } },
    configSchema: objectSchema({
      kind: { enum: ["select", "input", "form", "file", "oauth", "permission"] },
      title: { type: "string", minLength: 1 }, message: { type: "string", minLength: 1 },
      blocking: { enum: ["task", "run"] }, schema: { type: "object" }, data: { type: "object" },
    }, ["kind", "title", "message"]),
    inspector: [
      { path: "kind", label: "Interaction kind", control: "select", required: true, options: [
        { label: "Input", value: "input" }, { label: "Select", value: "select" }, { label: "Form", value: "form" },
        { label: "File", value: "file" }, { label: "OAuth", value: "oauth" }, { label: "Permission", value: "permission" },
      ] },
      { path: "title", label: "Title", control: "text", required: true },
      { path: "message", label: "Message", control: "textarea", required: true },
      { path: "blocking", label: "Blocking scope", control: "select", options: [
        { label: "Run", value: "run" }, { label: "Task", value: "task" },
      ] },
      { path: "schema", label: "Response schema", control: "json" },
      { path: "data", label: "Host data", control: "json" },
    ],
    defaultConfig: { kind: "input", title: "Input required", message: "Provide the requested input.", blocking: "run" },
    execute: interactionExecutor,
  },
  {
    type: "output", label: "Output", category: "Output", description: "Final text or JSON Schema boundary",
    ports: { inputs: { value: { type: "any", required: true, maxConnections: 1 } }, outputs: { value: { type: "any" } } },
    configSchema: objectSchema({ format: { enum: ["text", "json"] }, schema: { type: "object" } }),
    inspector: [
      { path: "format", label: "Format", control: "select", options: [{ label: "Text", value: "text" }, { label: "JSON", value: "json" }] },
      { path: "schema", label: "JSON Schema", control: "json" },
    ],
    defaultConfig: { format: "text" }, retrySafe: true, execute: outputExecutor,
  },
  {
    type: "context", label: "Context", category: "Knowledge", description: "Static text, file, or directory context",
    ports: { inputs: {}, outputs: { context: { type: "context" } } },
    configSchema: objectSchema({
      source: { enum: ["text", "file", "directory", "external"] }, text: { type: "string" }, path: { type: "string" },
      conversationId: { type: "string", minLength: 1 }, revision: { anyOf: [{ type: "string" }, { type: "number" }] },
      pattern: { type: "string" }, topK: { type: "integer", minimum: 1, maximum: 100 },
      maxBytes: { type: "integer", minimum: 1, maximum: 10000000 },
    }, ["source"]),
    inspector: [
      { path: "source", label: "Source", control: "select", required: true, options: [
        { label: "Static text", value: "text" }, { label: "File", value: "file" }, { label: "Directory", value: "directory" },
        { label: "External provider", value: "external" },
      ] },
      { path: "text", label: "Text", control: "textarea" }, { path: "path", label: "Path", control: "text" },
      { path: "conversationId", label: "Conversation id", control: "text" },
      { path: "revision", label: "Provider revision", control: "text" },
      { path: "pattern", label: "File pattern", control: "text" }, { path: "topK", label: "Top K", control: "number" },
      { path: "maxBytes", label: "Maximum context bytes", control: "number" },
    ],
    defaultConfig: { source: "text", text: "" }, retrySafe: true, validate: validateContextComponent, execute: contextExecutor,
  },
  {
    type: "memory", label: "Memory", category: "Knowledge", description: "Run or project memory read/write",
    ports: { inputs: { value: { type: "any", maxConnections: 1 } }, outputs: { memory: { type: "memory" } } },
    configSchema: objectSchema({
      key: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_.-]*$" },
      operation: { enum: ["read", "write", "append"] }, namespace: { enum: ["user", "conversation", "pkm"] },
      revision: { anyOf: [{ type: "string" }, { type: "number" }] }, initial: {},
    }, ["key", "operation"]),
    inspector: [
      { path: "key", label: "Key", control: "text", required: true },
      { path: "operation", label: "Operation", control: "select", required: true, options: [
        { label: "Read", value: "read" }, { label: "Write", value: "write" }, { label: "Append", value: "append" },
      ] },
      { path: "namespace", label: "Namespace", control: "select", options: [
        { label: "Conversation", value: "conversation" }, { label: "User", value: "user" }, { label: "PKM", value: "pkm" },
      ] },
      { path: "revision", label: "Provider revision", control: "text" },
      { path: "initial", label: "Initial value", control: "json" },
    ],
    defaultConfig: { key: "conversation", operation: "read" }, execute: memoryExecutor,
  },
  {
    type: "tool", label: "Tool", category: "Tools", description: "Attaches one catalog Tool to an Agent",
    ports: { inputs: {}, outputs: { tool: { type: "tool" } } },
    configSchema: objectSchema({
      tool: { type: "string", minLength: 1 }, connectionId: { type: "string", minLength: 1 }, action: { type: "string" },
      label: { type: "string" }, description: { type: "string" }, inputSchema: { type: "object" }, outputSchema: { type: "object" },
      risk: { enum: ["read", "write", "external", "destructive"] }, source: { enum: ["builtin", "module", "custom", "mcp", "skill"] },
    }, ["tool"]),
    inspector: [
      { path: "tool", label: "Tool", control: "text", required: true },
      { path: "connectionId", label: "Connection", control: "text" },
      { path: "action", label: "Action", control: "text" },
      { path: "label", label: "Display name", control: "text" },
      { path: "description", label: "Description", control: "textarea" },
      { path: "source", label: "Source", control: "select", options: [
        { label: "Built-in", value: "builtin" }, { label: "Module", value: "module" },
        { label: "Custom", value: "custom" }, { label: "MCP", value: "mcp" }, { label: "Skill", value: "skill" },
      ] },
      { path: "risk", label: "Risk", control: "select", options: [
        { label: "Read", value: "read" }, { label: "Write", value: "write" },
        { label: "External transfer", value: "external" }, { label: "Destructive", value: "destructive" },
      ] },
      { path: "inputSchema", label: "Input schema", control: "json" },
      { path: "outputSchema", label: "Output schema", control: "json" },
    ],
    defaultConfig: { tool: "", risk: "external" }, retrySafe: true, execute: toolReferenceExecutor,
  },
  {
    type: "skill", label: "Skill", category: "Skills", description: "Progressively loads one Agent Skill",
    ports: { inputs: {}, outputs: { skill: { type: "skill" } } },
    configSchema: objectSchema({ skill: { type: "string", minLength: 1 } }, ["skill"]),
    inspector: [{ path: "skill", label: "Skill", control: "text", required: true }],
    defaultConfig: { skill: "" }, retrySafe: true, execute: skillReferenceExecutor,
  },
  {
    type: "local-tool", label: "Local Tool", category: "Tools", description: "Calls one explicitly registered local tool",
    ports: { inputs: { arguments: { type: "any", maxConnections: 1 } }, outputs: { result: { type: "any" } } },
    configSchema: objectSchema({ tool: { type: "string", minLength: 1 } }, ["tool"]),
    inspector: [{ path: "tool", label: "Registered tool", control: "text", required: true }],
    defaultConfig: { tool: "" }, execute: localToolExecutor,
  },
  {
    type: "mcp-tool", label: "MCP Tool", category: "Tools", description: "Discovers and calls one MCP tool",
    ports: { inputs: { arguments: { type: "any", maxConnections: 1 } }, outputs: { result: { type: "any" } } },
    configSchema: objectSchema({
      connectionId: { type: "string", minLength: 1 },
      transport: { enum: ["stdio", "http"] }, protocol: { enum: ["legacy", "auto", "2026-07-28"] },
      tool: { type: "string", minLength: 1 }, command: { type: "string" }, args: { type: "array", items: { type: "string" } },
      url: { type: "string", format: "uri" }, headers: { type: "object", additionalProperties: { type: "string" } },
      timeoutMs: { type: "integer", minimum: 1, maximum: 600000 },
    }, ["tool"]),
    inspector: [
      { path: "connectionId", label: "MCP connection", control: "text" },
      { path: "transport", label: "Transport", control: "select", required: true, options: [
        { label: "stdio", value: "stdio" }, { label: "Streamable HTTP", value: "http" },
      ] },
      { path: "protocol", label: "Protocol", control: "select", options: [
        { label: "Default", value: "auto" }, { label: "Legacy", value: "legacy" }, { label: "2026-07-28", value: "2026-07-28" },
      ] },
      { path: "tool", label: "Tool", control: "text", required: true }, { path: "command", label: "Command", control: "text" },
      { path: "args", label: "Arguments", control: "json" }, { path: "url", label: "URL", control: "text" },
      { path: "headers", label: "Headers", control: "json" }, { path: "timeoutMs", label: "Timeout (ms)", control: "number" },
    ],
    defaultConfig: { transport: "stdio", protocol: "legacy", tool: "" }, validate: validateMcpComponent, execute: mcpToolExecutor,
  },
  {
    type: "router", label: "Router / Condition", category: "Flow", description: "Routes a value through true or false",
    ports: { inputs: { value: { type: "any", required: true, maxConnections: 1 } }, outputs: { true: { type: "any" }, false: { type: "any" } } },
    configSchema: objectSchema({ condition: predicateJsonSchema }, ["condition"]),
    inspector: [{ path: "condition", label: "Condition", control: "json", required: true }],
    defaultConfig: { condition: { op: "truthy" } }, retrySafe: true, execute: routerExecutor,
  },
  {
    type: "classifier", label: "Intent Classifier", category: "Flow", description: "Classifies a request into one structured route",
    ports: {
      inputs: {
        model: { type: "model", required: true, maxConnections: 1 },
        prompt: { type: "prompt", maxConnections: 1 },
        value: { type: "any", maxConnections: 1 },
      },
      outputs: { value: { type: "any" }, route: { type: "text" }, decision: { type: "any" } },
    },
    configSchema: objectSchema({
      routes: { type: "array", minItems: 1, maxItems: 32, uniqueItems: true, items: { type: "string", minLength: 1 } },
      fallback: { type: "string", minLength: 1 },
      minConfidence: { type: "number", minimum: 0, maximum: 1 },
    }, ["routes", "fallback"]),
    inspector: [
      { path: "routes", label: "Routes", control: "json", required: true },
      { path: "fallback", label: "Fallback route", control: "text", required: true },
      { path: "minConfidence", label: "Minimum confidence", control: "number" },
    ],
    defaultConfig: { routes: ["direct", "team"], fallback: "team", minConfidence: 0.5 },
    retrySafe: true,
    validate: validateClassifierComponent,
    execute: classifierExecutor,
  },
  {
    type: "evaluator", label: "Evaluator", category: "Evaluation", description: "Evaluates output, tools, latency, or iterations",
    ports: { inputs: { value: { type: "any", required: true, maxConnections: 1 } }, outputs: { value: { type: "any" }, evaluation: { type: "evaluation" } } },
    configSchema: objectSchema({
      type: { enum: ["equals", "includes", "matches", "output-schema", "tool-called", "latency", "iterations"] },
      value: {}, schema: { type: "object" }, tool: { type: "string" }, minCalls: { type: "integer", minimum: 0 },
      maxCalls: { type: "integer", minimum: 0 }, maxMs: { type: "number", minimum: 0 },
      min: { type: "integer", minimum: 0 }, max: { type: "integer", minimum: 0 },
    }, ["type"]),
    inspector: [
      { path: "type", label: "Evaluator", control: "select", required: true, options: [
        { label: "Equals", value: "equals" }, { label: "Includes", value: "includes" },
        { label: "Matches", value: "matches" }, { label: "Output Schema", value: "output-schema" },
        { label: "Tool Called", value: "tool-called" }, { label: "Latency", value: "latency" },
        { label: "Iterations", value: "iterations" },
      ] },
      { path: "value", label: "Expected value", control: "json" }, { path: "schema", label: "JSON Schema", control: "json" },
      { path: "tool", label: "Tool", control: "text" }, { path: "maxMs", label: "Max latency (ms)", control: "number" },
      { path: "minCalls", label: "Minimum Tool calls", control: "number" },
      { path: "maxCalls", label: "Maximum Tool calls", control: "number" },
      { path: "min", label: "Min iterations", control: "number" }, { path: "max", label: "Max iterations", control: "number" },
    ],
    defaultConfig: { type: "includes", value: "" }, retrySafe: true, validate: validateEvaluatorComponent, execute: evaluatorExecutor,
  },
  {
    type: "join", label: "Join", category: "Flow", description: "Deterministically joins parallel values",
    ports: { inputs: { values: { type: "any", required: true, variadic: true } }, outputs: { value: { type: "any" } } },
    configSchema: objectSchema({
      mode: { enum: ["array", "object", "concat"] }, keys: { type: "array", items: { type: "string" } }, separator: { type: "string" },
    }),
    inspector: [
      { path: "mode", label: "Mode", control: "select", options: [
        { label: "Array", value: "array" }, { label: "Object", value: "object" }, { label: "Concatenate", value: "concat" },
      ] },
      { path: "keys", label: "Object keys", control: "json" }, { path: "separator", label: "Separator", control: "text" },
    ],
    defaultConfig: { mode: "array" }, retrySafe: true, execute: joinExecutor,
  },
  {
    type: "subgraph", label: "Subgraph", category: "Flow", description: "Runs a reusable named subgraph",
    ports: { inputs: { value: { type: "any", maxConnections: 1 } }, outputs: { value: { type: "any" } } },
    configSchema: objectSchema({ subgraph: { type: "string", minLength: 1 } }, ["subgraph"]),
    inspector: [{ path: "subgraph", label: "Subgraph", control: "text", required: true }],
    defaultConfig: { subgraph: "" }, execute: subgraphExecutor,
  },
  {
    type: "team", label: "Agent Team", category: "Flow", description: "Runs a bounded dynamic Team from HarnessSpec v0.3",
    ports: { inputs: { value: { type: "any", maxConnections: 1 } }, outputs: { value: { type: "any" } } },
    configSchema: objectSchema({ team: { type: "string", minLength: 1 } }, ["team"]),
    inspector: [{ path: "team", label: "Team", control: "text", required: true }],
    defaultConfig: { team: "" },
    execute: teamExecutor,
  },
  {
    type: "loop", label: "Loop", category: "Flow", description: "Runs a subgraph with mandatory bounds",
    ports: { inputs: { value: { type: "any", maxConnections: 1 } }, outputs: { value: { type: "any" } } },
    configSchema: objectSchema({
      subgraph: { type: "string", minLength: 1 }, maxIterations: { type: "integer", minimum: 1, maximum: 1000 },
      carry: { enum: ["replace", "merge"] },
      checkpoint: { enum: ["structured"] },
      until: predicateJsonSchema, timeoutMs: { type: "integer", minimum: 1, maximum: 600000 },
      maxTokens: { type: "integer", minimum: 1 }, maxCostUsd: { type: "number", exclusiveMinimum: 0 },
    }, ["subgraph", "maxIterations"]),
    inspector: [
      { path: "subgraph", label: "Subgraph", control: "text", required: true },
      { path: "maxIterations", label: "Max iterations", control: "number", required: true },
      { path: "carry", label: "Iteration state", control: "select", options: [
        { label: "Replace", value: "replace" }, { label: "Merge object fields", value: "merge" },
      ] },
      { path: "checkpoint", label: "Completion state", control: "select", options: [
        { label: "Structured agent checkpoint", value: "structured" },
      ] },
      { path: "until", label: "Exit condition", control: "json" }, { path: "timeoutMs", label: "Timeout (ms)", control: "number" },
      { path: "maxTokens", label: "Token limit", control: "number" }, { path: "maxCostUsd", label: "Cost limit ($)", control: "number" },
    ],
    defaultConfig: { subgraph: "", maxIterations: 3 }, execute: loopExecutor,
  },
];

export const BUILTIN_COMPONENT_MANIFESTS: readonly ComponentManifest[] = definitions.map(
  ({ execute: _execute, validate: _validate, traceInputs: _traceInputs, retrySafe: _retrySafe, ...manifest }) => manifest,
);

export function createBuiltinComponentRegistry(): ComponentRegistry {
  const registry = new ComponentRegistry();
  for (const definition of definitions) registry.register(definition);
  return registry;
}
