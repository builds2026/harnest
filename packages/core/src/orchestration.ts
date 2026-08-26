import type { ArtifactReference } from "./component.js";
import { createHash } from "node:crypto";
import type { FinishReason, TokenUsage } from "./adapter.js";
import type { AgentTemplateSpec, TeamSpec } from "./spec.js";
import type { PermissionDecision, ToolBinding } from "./tool.js";

export type WorkStatus = "queued" | "running" | "waiting" | "blocked" | "completed" | "failed" | "cancelled" | "superseded";

export interface TaskRecord {
  readonly id: string;
  readonly teamId: string;
  readonly goal: string;
  readonly assignee: string;
  readonly dependsOn: readonly string[];
  readonly status: WorkStatus;
  readonly agentId?: string;
  readonly result?: unknown;
  readonly error?: string;
  readonly artifacts?: readonly ArtifactReference[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AgentInstance {
  readonly id: string;
  readonly teamId: string;
  readonly template: string;
  readonly parentId?: string;
  readonly taskId?: string;
  readonly depth: number;
  readonly status: WorkStatus;
  readonly usage?: TokenUsage;
  readonly costUsd?: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PlanOperation {
  readonly op: "add" | "update" | "cancel";
  readonly taskId: string;
  readonly goal?: string;
  readonly assignee?: string;
  readonly dependsOn?: readonly string[];
}

export interface PlanRevision {
  readonly revision: number;
  readonly author: string;
  readonly reason: string;
  readonly operations: readonly PlanOperation[];
  readonly createdAt: string;
}

export interface PlanProposal {
  readonly id: string;
  readonly teamId: string;
  readonly author: string;
  readonly baseRevision: number;
  readonly reason: string;
  readonly operations: readonly PlanOperation[];
  readonly status: "pending" | "accepted" | "rejected";
  readonly createdAt: string;
}

export interface AgentMessage {
  readonly id: string;
  readonly teamId?: string;
  readonly from: "user" | string;
  readonly to: { readonly kind: "run" | "team" | "agent"; readonly id?: string };
  readonly kind: "instruction" | "message" | "request" | "response" | "result";
  readonly content: string;
  readonly correlationId?: string;
  readonly taskId?: string;
  readonly artifacts?: readonly ArtifactReference[];
  readonly createdAt: string;
}

export interface AgentTurnCheckpoint {
  readonly nextTurn: number;
  readonly workingState: Readonly<Record<string, unknown>>;
  readonly usage: TokenUsage;
  readonly usageKnown: boolean;
  readonly costUsd: number;
  readonly costKnown: boolean;
  readonly finishReason: FinishReason;
  readonly toolCalls: number;
  readonly fallbackUsed: boolean;
  readonly pendingCalls?: readonly {
    readonly id: string;
    readonly name: string;
    readonly input: unknown;
    readonly providerMetadata?: Readonly<Record<string, unknown>>;
  }[];
  /** Call ids durably marked immediately before a non-read side effect begins. */
  readonly inFlightCalls?: readonly string[];
  readonly pendingAssistantText?: string;
  readonly siblingResults?: readonly {
    readonly callId: string;
    readonly name: string;
    readonly tool: string;
    readonly ok: boolean;
    readonly output?: unknown;
    readonly error?: string;
  }[];
  readonly completed?: boolean;
  readonly finalText?: string;
  readonly updatedAt: string;
}

export interface SideEffectCheckpoint {
  readonly nodeId: string;
  readonly iteration: number;
  readonly inputDigest: string;
  readonly status: "in_flight" | "completed";
  readonly result?: unknown;
  readonly updatedAt: string;
}

export type InteractionKind = "select" | "input" | "form" | "file" | "oauth" | "permission";

export interface InteractionRequest {
  readonly id: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly taskId?: string;
  readonly agentId?: string;
  readonly kind: InteractionKind;
  readonly requester: { readonly kind: "harness" | "agent" | "tool" | "mcp"; readonly id: string };
  readonly title: string;
  readonly message: string;
  readonly blocking: "task" | "run";
  readonly schema?: Readonly<Record<string, unknown>>;
  readonly data?: Readonly<Record<string, unknown>>;
  readonly checkpoint: { readonly revision: number; readonly sequence: number; readonly digest: string };
  readonly createdAt: string;
  readonly expiresAt?: string;
}

export interface InteractionResponse {
  readonly interactionId: string;
  readonly checkpointDigest: string;
  readonly action: "submit" | "decline" | "cancel";
  readonly value?: unknown;
  readonly permission?: PermissionDecision;
  readonly respondedAt?: string;
}

export type InteractionResolution = Pick<InteractionResponse, "interactionId" | "action" | "permission">;

export interface RunPermissionGrant {
  readonly toolId: string;
  readonly connectionId?: string;
  readonly action?: string;
  readonly permission?: "allow_once" | "allow_for_run" | "allow_always";
  readonly interactionId?: string;
  readonly createdAt: string;
}

export interface RunSnapshot {
  readonly runId: string;
  readonly sequence?: number;
  readonly revision: number;
  readonly status: "running" | "paused" | "succeeded" | "failed" | "cancelled";
  readonly tasks: readonly TaskRecord[];
  readonly agents: readonly AgentInstance[];
  readonly messages: readonly AgentMessage[];
  readonly revisions: readonly PlanRevision[];
  readonly proposals: readonly PlanProposal[];
  readonly commands?: readonly { readonly id: string; readonly error?: string }[];
  readonly mailboxes?: Readonly<Record<string, readonly string[]>>;
  readonly turnCheckpoints?: Readonly<Record<string, AgentTurnCheckpoint>>;
  /** Private recovery data for direct Tool/MCP component side effects. */
  readonly sideEffectCheckpoints?: Readonly<Record<string, SideEffectCheckpoint>>;
  readonly pendingInteractions?: readonly InteractionRequest[];
  readonly runGrants?: readonly RunPermissionGrant[];
  readonly processedInteractionIds?: readonly string[];
  /** Private recovery data. Interaction values are never copied into Run events. */
  readonly interactionResponses?: Readonly<Record<string, InteractionResponse>>;
  readonly updatedAt: string;
}

export type PublicRunSnapshot = Omit<RunSnapshot, "turnCheckpoints" | "sideEffectCheckpoints" | "interactionResponses">;

/** Snapshot safe for APIs, logs, and UI state. Recovery-only values stay in the private RunStore snapshot. */
export function publicRunSnapshot(snapshot: RunSnapshot): PublicRunSnapshot {
  const { turnCheckpoints, sideEffectCheckpoints, interactionResponses, ...rest } = structuredClone(snapshot);
  void turnCheckpoints;
  void sideEffectCheckpoints;
  void interactionResponses;
  const stripPrivateValues = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stripPrivateValues);
    if (!value || typeof value !== "object") return value;
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (/^context[-_]?ref$/iu.test(key)) continue;
      result[key] = /(?:api[-_]?key|authorization|secret|token|pass(?:word|phrase)|credentials?|cookies?|private[-_]?key)$/iu.test(key)
        ? "[REDACTED]"
        : stripPrivateValues(child);
    }
    return result;
  };
  return stripPrivateValues(rest) as PublicRunSnapshot;
}

export type RunCommand =
  | {
      readonly id?: string;
      readonly type: "message";
      readonly target: AgentMessage["to"];
      readonly content: string;
      readonly correlationId?: string;
    }
  | {
      readonly id?: string;
      readonly type: "task-directive";
      readonly taskId: string;
      readonly instruction: string;
    }
  | {
      readonly id?: string;
      readonly type: "plan-patch";
      readonly baseRevision: number;
      readonly reason: string;
      readonly operations: readonly PlanOperation[];
    }
  | {
      readonly id?: string;
      readonly type: "cancel";
      readonly scope: "run" | "task" | "agent";
      readonly targetId?: string;
    }
  | {
      readonly id?: string;
      readonly type: "interaction-response";
      readonly response: InteractionResponse;
    };

export type OrchestrationEvent =
  | { readonly type: "agent-spawned"; readonly agent: AgentInstance }
  | { readonly type: "agent-status"; readonly agent: AgentInstance }
  | { readonly type: "task-created" | "task-status"; readonly task: TaskRecord }
  | { readonly type: "agent-message"; readonly message: AgentMessage }
  | { readonly type: "plan-proposed"; readonly proposal: PlanProposal }
  | { readonly type: "plan-revised"; readonly revision: PlanRevision }
  | { readonly type: "command-applied" | "command-rejected"; readonly commandId: string; readonly message: string }
  | { readonly type: "interaction-requested"; readonly request: InteractionRequest }
  | { readonly type: "interaction-resolved"; readonly response: InteractionResolution }
  | { readonly type: "run-paused"; readonly paused: boolean; readonly interactionId?: string }
  | { readonly type: "run-snapshot"; readonly snapshot: RunSnapshot };

export interface ResolvedTeamLimits {
  readonly maxInstances: number;
  readonly maxDepth: number;
  readonly maxParallel: number;
  readonly maxMessages: number;
  readonly maxPlanRevisions: number;
}

export type TeamRuntimeDefinition = Omit<TeamSpec, "limits"> & { readonly limits: ResolvedTeamLimits };

export interface OrchestrationPlan {
  readonly agentTemplates: Readonly<Record<string, AgentTemplateSpec>>;
  readonly teams: Readonly<Record<string, TeamRuntimeDefinition>>;
}

export interface PlannedTask {
  readonly id: string;
  readonly goal: string;
  readonly agent: string;
  readonly dependsOn?: readonly string[];
}

export interface TeamPlanOutput {
  readonly status?: "direct" | "tasks" | "complete";
  readonly finalAnswer?: unknown;
  readonly tasks?: readonly PlannedTask[];
}

export interface AgentCheckpoint {
  readonly messages: readonly AgentMessage[];
  readonly task?: TaskRecord;
  readonly revision: number;
}

const ID = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const EXTERNAL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_TEXT_BYTES = 65_536;
const encoder = new TextEncoder();
const CREDENTIAL_FIELD = /(?:password|passphrase|secret|token|api[-_]?key|access[-_]?token|credential|private[-_]?key)/iu;

const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
const textBytes = (value: string) => encoder.encode(value).byteLength;
const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const addUsage = (left: TokenUsage = {}, right: TokenUsage = {}): TokenUsage => ({
  ...(left.inputTokens === undefined && right.inputTokens === undefined ? {} : { inputTokens: (left.inputTokens ?? 0) + (right.inputTokens ?? 0) }),
  ...(left.outputTokens === undefined && right.outputTokens === undefined ? {} : { outputTokens: (left.outputTokens ?? 0) + (right.outputTokens ?? 0) }),
  ...(left.totalTokens === undefined && right.totalTokens === undefined ? {} : { totalTokens: (left.totalTokens ?? 0) + (right.totalTokens ?? 0) }),
  ...(left.cachedInputTokens === undefined && right.cachedInputTokens === undefined ? {} : { cachedInputTokens: (left.cachedInputTokens ?? 0) + (right.cachedInputTokens ?? 0) }),
  ...(left.cacheWriteInputTokens === undefined && right.cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens: (left.cacheWriteInputTokens ?? 0) + (right.cacheWriteInputTokens ?? 0) }),
});

function boundedText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || textBytes(value) > MAX_TEXT_BYTES) {
    throw new Error(`${field} must contain 1-${MAX_TEXT_BYTES} UTF-8 bytes`);
  }
  return value;
}

function boundedId(value: unknown, field: string): string {
  if (typeof value !== "string" || !ID.test(value)) throw new Error(`${field} is invalid`);
  return value;
}

function boundedExternalId(value: unknown, field: string): string {
  if (typeof value !== "string" || !EXTERNAL_ID.test(value)) throw new Error(`${field} is invalid`);
  return value;
}

function jsonValue(value: unknown, field: string): unknown {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined || textBytes(serialized) > 1_048_576) throw new Error();
    return JSON.parse(serialized) as unknown;
  } catch {
    throw new Error(`${field} must be a JSON value no larger than 1 MiB`);
  }
}

function interactionResponse(value: unknown): InteractionResponse {
  const record = asRecord(value);
  if (!record) throw new Error("Interaction response must be an object");
  const interactionId = boundedExternalId(record.interactionId ?? record.requestId, "Interaction request id");
  const checkpointDigest = typeof record.checkpointDigest === "string" ? record.checkpointDigest : "";
  if (!/^[a-f0-9]{64}$/.test(checkpointDigest)) throw new Error("Interaction checkpoint digest is invalid");
  const action = record.action as InteractionResponse["action"];
  if (!["submit", "decline", "cancel"].includes(action)) throw new Error("Interaction response action is invalid");
  const permission = (record.permission ?? record.decision) === undefined
    ? undefined : String(record.permission ?? record.decision) as PermissionDecision;
  if (permission !== undefined && !["allow_once", "allow_for_run", "allow_always", "deny"].includes(permission)) {
    throw new Error("Interaction permission decision is invalid");
  }
  return {
    interactionId,
    checkpointDigest,
    action,
    ...(record.value === undefined ? {} : { value: jsonValue(record.value, "Interaction response") }),
    ...(permission === undefined ? {} : { permission }),
    respondedAt: now(),
  };
}

function validateInteractionSchema(kind: InteractionKind, value: unknown): void {
  if (value === undefined) return;
  const schema = asRecord(value);
  if (!schema) throw new Error("Interaction schema must be an object");
  const allowedPrimitiveKeys = new Set([
    "type", "title", "description", "enum", "minimum", "maximum", "minLength", "maxLength", "default",
  ]);
  const primitive = (candidate: unknown, field: string): void => {
    const item = asRecord(candidate);
    if (!item || !["string", "number", "integer", "boolean"].includes(String(item.type))) {
      throw new Error(`${field} must use a primitive interaction schema`);
    }
    if (Object.keys(item).some((key) => !allowedPrimitiveKeys.has(key))) throw new Error(`${field} contains an unsupported schema keyword`);
    if (item.enum !== undefined && (!Array.isArray(item.enum) || item.enum.length < 1 || item.enum.length > 100
      || item.enum.some((entry) => entry !== null && !["string", "number", "boolean"].includes(typeof entry)))) {
      throw new Error(`${field} enum is invalid`);
    }
  };
  if (kind === "form") {
    if (schema.type !== "object" || !asRecord(schema.properties) || schema.additionalProperties !== false) {
      throw new Error("Form interaction schema must be a closed object");
    }
    if (Object.keys(schema).some((key) => !["type", "title", "description", "properties", "required", "additionalProperties"].includes(key))) {
      throw new Error("Form interaction schema contains an unsupported keyword");
    }
    const properties = asRecord(schema.properties)!;
    if (Object.keys(properties).length > 50) throw new Error("Form interaction schema has too many fields");
    for (const [field, candidate] of Object.entries(properties)) {
      if (CREDENTIAL_FIELD.test(field)) throw new Error(`Credential field '${field}' must use an OAuth interaction`);
      primitive(candidate, `Form field '${field}'`);
    }
    if (schema.required !== undefined && (!Array.isArray(schema.required)
      || schema.required.some((field) => typeof field !== "string" || !Object.hasOwn(properties, field)))) {
      throw new Error("Form required fields are invalid");
    }
    return;
  }
  if (kind === "input" || kind === "select") primitive(schema, `${kind} interaction`);
  else if (Object.keys(schema).length) throw new Error(`${kind} interactions do not accept a form schema`);
}

function validateReferenceResponse(kind: InteractionKind, response: InteractionResponse): void {
  if (response.action !== "submit" || (kind !== "file" && kind !== "oauth")) return;
  const value = asRecord(response.value);
  if (!value) throw new Error(`${kind} interaction response must be an object`);
  if (kind === "file") {
    const allowed = ["fileRef", "mimeType", "size", "sha256"];
    if (Object.keys(value).some((key) => !allowed.includes(key)) || typeof value.fileRef !== "string"
      || typeof value.mimeType !== "string" || !Number.isSafeInteger(value.size) || Number(value.size) < 0
      || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/iu.test(value.sha256)) {
      throw new Error("File interaction response must contain only fileRef, MIME type, size, and SHA-256 metadata");
    }
  } else if (Object.keys(value).some((key) => key !== "connectionRef") || typeof value.connectionRef !== "string") {
    throw new Error("OAuth interaction response must contain only a connectionRef");
  }
}

function validateSubmittedValue(kind: InteractionKind, schemaValue: unknown, response: InteractionResponse): void {
  if (response.action !== "submit" || !["select", "input", "form"].includes(kind) || schemaValue === undefined) return;
  const primitive = (schema: Record<string, unknown>, value: unknown, field: string): void => {
    const type = schema.type;
    const validType = type === "string" ? typeof value === "string"
      : type === "boolean" ? typeof value === "boolean"
        : type === "integer" ? typeof value === "number" && Number.isInteger(value)
          : type === "number" ? typeof value === "number" && Number.isFinite(value)
            : false;
    if (!validType) throw new Error(`${field} does not match the interaction schema type`);
    if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => Object.is(candidate, value))) {
      throw new Error(`${field} is not an allowed interaction value`);
    }
    if (typeof value === "string") {
      const length = [...value].length;
      if (typeof schema.minLength === "number" && length < schema.minLength) throw new Error(`${field} is shorter than minLength`);
      if (typeof schema.maxLength === "number" && length > schema.maxLength) throw new Error(`${field} is longer than maxLength`);
    }
    if (typeof value === "number") {
      if (typeof schema.minimum === "number" && value < schema.minimum) throw new Error(`${field} is below minimum`);
      if (typeof schema.maximum === "number" && value > schema.maximum) throw new Error(`${field} is above maximum`);
    }
  };
  const schema = asRecord(schemaValue)!;
  if (kind !== "form") {
    primitive(schema, response.value, "Interaction response");
    return;
  }
  const value = asRecord(response.value);
  const properties = asRecord(schema.properties)!;
  if (!value) throw new Error("Form interaction response must be an object");
  if (Object.keys(value).some((field) => !Object.hasOwn(properties, field))) throw new Error("Form interaction response contains an unknown field");
  for (const field of Array.isArray(schema.required) ? schema.required : []) {
    if (typeof field === "string" && !Object.hasOwn(value, field)) throw new Error(`Form interaction response is missing '${field}'`);
  }
  for (const [field, candidate] of Object.entries(value)) primitive(asRecord(properties[field])!, candidate, `Form field '${field}'`);
}

function planOperation(value: unknown): PlanOperation {
  const record = asRecord(value);
  if (!record || !["add", "update", "cancel"].includes(String(record.op))) throw new Error("Plan operation is invalid");
  const op = record.op as PlanOperation["op"];
  const taskId = boundedId(record.taskId, "Task id");
  const goal = record.goal === undefined ? undefined : boundedText(record.goal, "Task goal");
  const assignee = record.assignee === undefined ? undefined : boundedId(record.assignee, "Task assignee");
  const dependsOn = record.dependsOn === undefined ? undefined : Array.isArray(record.dependsOn)
    && record.dependsOn.length <= 64 && record.dependsOn.every((item) => typeof item === "string" && ID.test(item))
      ? [...new Set(record.dependsOn as string[])] : (() => { throw new Error("Task dependencies are invalid"); })();
  if (op === "add" && (!goal || !assignee)) throw new Error("Add operation requires goal and assignee");
  return { op, taskId, ...(goal ? { goal } : {}), ...(assignee ? { assignee } : {}), ...(dependsOn ? { dependsOn } : {}) };
}

export function parseRunCommand(value: unknown): RunCommand {
  const input = asRecord(value);
  if (!input || typeof input.type !== "string") throw new Error("Run command must be an object");
  const commandId = input.id === undefined ? undefined : boundedExternalId(input.id, "Command id");
  if (input.type === "message") {
    const target = asRecord(input.target);
    if (!target || !["run", "team", "agent"].includes(String(target.kind))) throw new Error("Message target is invalid");
    const kind = target.kind as AgentMessage["to"]["kind"];
    const targetId = target.id === undefined ? undefined : boundedId(target.id, "Target id");
    if (kind !== "run" && !targetId) throw new Error("Team and Agent messages require a target id");
    return {
      ...(commandId ? { id: commandId } : {}),
      type: "message",
      target: { kind, ...(targetId ? { id: targetId } : {}) },
      content: boundedText(input.content, "Message"),
      ...(input.correlationId === undefined ? {} : { correlationId: boundedExternalId(input.correlationId, "Correlation id") }),
    };
  }
  if (input.type === "task-directive") return {
    ...(commandId ? { id: commandId } : {}),
    type: "task-directive",
    taskId: boundedId(input.taskId, "Task id"),
    instruction: boundedText(input.instruction, "Instruction"),
  };
  if (input.type === "plan-patch") {
    if (!Number.isInteger(input.baseRevision) || Number(input.baseRevision) < 0) throw new Error("Plan revision is invalid");
    if (!Array.isArray(input.operations) || input.operations.length < 1 || input.operations.length > 64) {
      throw new Error("Plan patch requires 1-64 operations");
    }
    return {
      ...(commandId ? { id: commandId } : {}),
      type: "plan-patch",
      baseRevision: Number(input.baseRevision),
      reason: boundedText(input.reason, "Plan reason"),
      operations: input.operations.map(planOperation),
    };
  }
  if (input.type === "cancel") {
    if (!["run", "task", "agent"].includes(String(input.scope))) throw new Error("Cancel scope is invalid");
    const scope = input.scope as Extract<RunCommand, { type: "cancel" }>["scope"];
    const targetId = input.targetId === undefined ? undefined : boundedId(input.targetId, "Cancel target");
    if (scope !== "run" && !targetId) throw new Error("Task and Agent cancellation require a target id");
    return { ...(commandId ? { id: commandId } : {}), type: "cancel", scope, ...(targetId ? { targetId } : {}) };
  }
  if (input.type === "interaction-response") return {
    ...(commandId ? { id: commandId } : {}),
    type: "interaction-response",
    response: interactionResponse(input.response),
  };
  throw new Error(`Unknown Run command '${input.type}'`);
}

const toolSchema = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object", properties, required, additionalProperties: false,
}) as const;

export const ORCHESTRATION_TOOLS: readonly ToolBinding[] = Object.freeze([
  {
    id: "harnest.message_agent", label: "Message Agent", description: "Send a direct message to another active Agent.",
    inputSchema: toolSchema({ target: { type: "string" }, content: { type: "string" }, correlationId: { type: "string" } }, ["target", "content"]),
    risk: "read", source: "builtin",
  },
  {
    id: "harnest.message_team", label: "Message Team", description: "Broadcast a concise update to the current Team.",
    inputSchema: toolSchema({ content: { type: "string" }, correlationId: { type: "string" } }, ["content"]),
    risk: "read", source: "builtin",
  },
  {
    id: "harnest.request_help", label: "Request Help", description: "Create a bounded follow-up task for an allowed Agent template.",
    inputSchema: toolSchema({ agent: { type: "string" }, goal: { type: "string" } }, ["agent", "goal"]),
    risk: "read", source: "builtin",
  },
  {
    id: "harnest.propose_plan_update", label: "Propose Plan Update", description: "Propose task changes for the orchestrator to review.",
    inputSchema: toolSchema({
      baseRevision: { type: "integer", minimum: 0 }, reason: { type: "string" },
      operations: { type: "array", minItems: 1, maxItems: 64, items: { type: "object" } },
    }, ["baseRevision", "reason", "operations"]),
    risk: "read", source: "builtin",
  },
  {
    id: "harnest.report_result", label: "Report Result", description: "Report a concise task result to the orchestrator and Team.",
    inputSchema: toolSchema({ content: { type: "string" } }, ["content"]),
    risk: "read", source: "builtin",
  },
  {
    id: "harnest.request_interaction", label: "Request Interaction", description: "Pause the run for bounded user input.",
    inputSchema: toolSchema({
      kind: { enum: ["input", "select", "form", "file", "oauth", "permission"] }, prompt: { type: "string" }, data: { type: "object" },
      options: { type: "array", minItems: 1, maxItems: 64, items: {
        type: "object", properties: { value: { type: "string" }, label: { type: "string" } },
        required: ["value", "label"], additionalProperties: false,
      } },
    }, ["kind", "prompt"]),
    risk: "read", source: "builtin",
  },
]);

export class RunControl {
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly #abort = new AbortController();
  readonly #tasks = new Map<string, TaskRecord>();
  readonly #agents = new Map<string, AgentInstance>();
  readonly #messages: AgentMessage[] = [];
  readonly #revisions: PlanRevision[] = [];
  readonly #proposals = new Map<string, PlanProposal>();
  readonly #inboxes = new Map<string, AgentMessage[]>();
  readonly #commands = new Map<string, string | undefined>();
  readonly #turnCheckpoints = new Map<string, AgentTurnCheckpoint>();
  readonly #sideEffectCheckpoints = new Map<string, SideEffectCheckpoint>();
  readonly #pendingInteractions = new Map<string, InteractionRequest>();
  readonly #interactionWaiters = new Map<string, Set<{
    resolve(response: InteractionResponse): void;
    reject(error: Error): void;
  }>>();
  readonly #interactionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #runPermissionGrants = new Map<string, RunPermissionGrant>();
  readonly #processedInteractionIds = new Set<string>();
  readonly #interactionResponses = new Map<string, InteractionResponse>();
  readonly #expiredInteractionIds = new Set<string>();
  readonly #taskControllers = new Map<string, AbortController>();
  readonly #teams = new Map<string, TeamRuntimeDefinition>();
  readonly #changeWaiters = new Set<() => void>();
  #status: RunSnapshot["status"] = "running";
  #revision = 0;
  #sequence = 0;
  #emit?: (event: OrchestrationEvent) => void;

  constructor(runId: string, resume?: RunSnapshot) {
    this.runId = runId;
    this.signal = this.#abort.signal;
    if (resume) {
      this.#revision = resume.revision;
      this.#sequence = resume.sequence ?? 0;
      for (const task of resume.tasks) this.#tasks.set(task.id, task.status === "running"
        ? { ...task, status: "blocked", error: "Interrupted work may have external side effects; send a Task directive to confirm a retry", updatedAt: now() }
        : structuredClone(task));
      for (const agent of resume.agents) this.#agents.set(agent.id, agent.status === "running"
        ? { ...agent, status: "blocked", updatedAt: now() }
        : structuredClone(agent));
      this.#messages.push(...structuredClone(resume.messages));
      this.#revisions.push(...structuredClone(resume.revisions));
      for (const proposal of resume.proposals) this.#proposals.set(proposal.id, structuredClone(proposal));
      for (const command of resume.commands ?? []) this.#commands.set(command.id, command.error);
      for (const [key, checkpoint] of Object.entries(resume.turnCheckpoints ?? {})) {
        this.#turnCheckpoints.set(key, structuredClone(checkpoint));
      }
      for (const [key, checkpoint] of Object.entries(resume.sideEffectCheckpoints ?? {})) {
        this.#sideEffectCheckpoints.set(key, structuredClone(checkpoint));
      }
      for (const request of resume.pendingInteractions ?? []) {
        this.#pendingInteractions.set(request.id, structuredClone(request));
        this.#armInteractionExpiry(request);
      }
      for (const grant of resume.runGrants ?? []) this.#runPermissionGrants.set(this.#grantKey(grant), structuredClone(grant));
      for (const interactionId of resume.processedInteractionIds ?? []) this.#processedInteractionIds.add(interactionId);
      for (const [interactionId, response] of Object.entries(resume.interactionResponses ?? {})) {
        this.#interactionResponses.set(interactionId, structuredClone(response));
      }
      if (this.#pendingInteractions.size) this.#refreshInteractionStatus();
      const messages = new Map(this.#messages.map((message) => [message.id, message]));
      for (const [agentId, messageIds] of Object.entries(resume.mailboxes ?? {})) {
        if (!this.#agents.has(agentId)) continue;
        this.#inboxes.set(agentId, messageIds.flatMap((messageId) => messages.get(messageId) ?? []));
      }
    }
  }

  attach(emit: (event: OrchestrationEvent) => void): void {
    this.#emit = emit;
  }

  snapshot(): RunSnapshot {
    return structuredClone({
      runId: this.runId,
      ...(this.#sequence ? { sequence: this.#sequence } : {}),
      revision: this.#revision,
      status: this.#status,
      tasks: [...this.#tasks.values()],
      agents: [...this.#agents.values()],
      messages: this.#messages,
      revisions: this.#revisions,
      proposals: [...this.#proposals.values()],
      commands: [...this.#commands].map(([commandId, error]) => ({ id: commandId, ...(error ? { error } : {}) })),
      mailboxes: Object.fromEntries([...this.#inboxes].map(([agentId, messages]) => [agentId, messages.map(({ id: messageId }) => messageId)])),
      turnCheckpoints: Object.fromEntries(this.#turnCheckpoints),
      sideEffectCheckpoints: Object.fromEntries(this.#sideEffectCheckpoints),
      pendingInteractions: [...this.#pendingInteractions.values()],
      runGrants: [...this.#runPermissionGrants.values()],
      processedInteractionIds: [...this.#processedInteractionIds],
      interactionResponses: Object.fromEntries(this.#interactionResponses),
      updatedAt: now(),
    });
  }

  turnCheckpoint(key: string): AgentTurnCheckpoint | undefined {
    const checkpoint = this.#turnCheckpoints.get(key);
    return checkpoint ? structuredClone(checkpoint) : undefined;
  }

  saveTurnCheckpoint(key: string, checkpoint: Omit<AgentTurnCheckpoint, "updatedAt">): void {
    if (!key || key.length > 512) throw new Error("Agent turn checkpoint key is invalid");
    this.#turnCheckpoints.set(key, { ...structuredClone(checkpoint), updatedAt: now() });
    this.#changed();
  }

  sideEffectCheckpoint(key: string): SideEffectCheckpoint | undefined {
    const checkpoint = this.#sideEffectCheckpoints.get(key);
    return checkpoint ? structuredClone(checkpoint) : undefined;
  }

  saveSideEffectCheckpoint(key: string, checkpoint: Omit<SideEffectCheckpoint, "updatedAt">): void {
    if (!key || key.length > 512) throw new Error("Side-effect checkpoint key is invalid");
    this.#sideEffectCheckpoints.set(key, { ...structuredClone(checkpoint), updatedAt: now() });
  }

  runPermission(tool: Pick<ToolBinding, "id" | "connectionId" | "action">, interactionId?: string): RunPermissionGrant | undefined {
    const scope = {
      toolId: tool.id,
      ...(tool.connectionId ? { connectionId: tool.connectionId } : {}),
      ...(tool.action ? { action: tool.action } : {}),
    };
    const grant = this.#runPermissionGrants.get(this.#grantKey(scope))
      ?? (interactionId === undefined ? undefined : this.#runPermissionGrants.get(this.#grantKey({ ...scope, interactionId })));
    return grant ? structuredClone(grant) : undefined;
  }

  hasRunPermission(tool: Pick<ToolBinding, "id" | "connectionId" | "action">, interactionId?: string): boolean {
    return this.runPermission(tool, interactionId) !== undefined;
  }

  requestInteraction(
    candidate: Omit<InteractionRequest, "id" | "runId" | "checkpoint" | "createdAt"> & Partial<Pick<InteractionRequest, "id">>,
  ): Promise<InteractionResponse> {
    if (candidate.id && this.#interactionResponses.has(candidate.id)) {
      return Promise.resolve(structuredClone(this.#interactionResponses.get(candidate.id)!));
    }
    const sequence = this.#sequence;
    const checkpoint = {
      revision: this.#revision,
      sequence,
      digest: createHash("sha256").update(`${this.runId}:${this.#revision}:${sequence}`).digest("hex"),
    };
    const request: InteractionRequest = {
      id: candidate.id === undefined ? id("interaction") : boundedExternalId(candidate.id, "Interaction id"),
      runId: this.runId,
      nodeId: boundedText(candidate.nodeId, "Interaction node id"),
      ...(candidate.taskId ? { taskId: boundedExternalId(candidate.taskId, "Interaction task id") } : {}),
      ...(candidate.agentId ? { agentId: boundedExternalId(candidate.agentId, "Interaction Agent id") } : {}),
      kind: candidate.kind,
      requester: {
        kind: candidate.requester.kind,
        id: boundedText(candidate.requester.id, "Interaction requester id"),
      },
      title: boundedText(candidate.title, "Interaction title"),
      message: boundedText(candidate.message, "Interaction message"),
      blocking: candidate.blocking,
      ...(candidate.schema ? { schema: jsonValue(candidate.schema, "Interaction schema") as Readonly<Record<string, unknown>> } : {}),
      ...(candidate.data ? { data: jsonValue(candidate.data, "Interaction data") as Readonly<Record<string, unknown>> } : {}),
      checkpoint,
      createdAt: now(),
      ...(candidate.expiresAt ? { expiresAt: candidate.expiresAt } : {}),
    };
    if (!["select", "input", "form", "file", "oauth", "permission"].includes(request.kind)) throw new Error("Interaction kind is invalid");
    if (!["harness", "agent", "tool", "mcp"].includes(request.requester.kind)) throw new Error("Interaction requester kind is invalid");
    if (!["task", "run"].includes(request.blocking)) throw new Error("Interaction blocking scope is invalid");
    validateInteractionSchema(request.kind, request.schema);
    if (this.#processedInteractionIds.has(request.id)) throw new Error(`Interaction '${request.id}' was already resolved`);
    const pending = this.#pendingInteractions.get(request.id);
    if (pending && JSON.stringify({ ...pending, createdAt: undefined, checkpoint: undefined })
      !== JSON.stringify({ ...request, createdAt: undefined, checkpoint: undefined })) {
      throw new Error(`Interaction '${request.id}' conflicts with the pending request`);
    }
    if (!pending) {
      this.#pendingInteractions.set(request.id, request);
      this.#armInteractionExpiry(request);
      this.#emit?.({ type: "interaction-requested", request });
      this.#refreshInteractionStatus(request.id);
      this.#changed();
    }
    return new Promise((resolve, reject) => {
      const waiters = this.#interactionWaiters.get(request.id) ?? new Set();
      waiters.add({ resolve, reject });
      this.#interactionWaiters.set(request.id, waiters);
      if (this.signal.aborted) reject(this.signal.reason);
      else this.signal.addEventListener("abort", () => reject(this.signal.reason), { once: true });
    });
  }

  resolveInteraction(candidate: InteractionResponse | unknown): InteractionResponse {
    const response = interactionResponse(candidate);
    if (this.#expiredInteractionIds.has(response.interactionId)) throw new Error(`Interaction '${response.interactionId}' expired`);
    if (this.#processedInteractionIds.has(response.interactionId)) {
      return structuredClone(this.#interactionResponses.get(response.interactionId) ?? response);
    }
    const request = this.#pendingInteractions.get(response.interactionId);
    if (!request) throw new Error(`Interaction '${response.interactionId}' is not pending`);
    if (request.expiresAt && Date.parse(request.expiresAt) <= Date.now()) {
      this.#expireInteraction(request.id);
      throw new Error(`Interaction '${request.id}' expired`);
    }
    if (response.checkpointDigest !== request.checkpoint.digest) throw new Error("Interaction response checkpoint is stale");
    if (request.kind === "permission" && response.permission === undefined) throw new Error("Permission interaction requires a decision");
    if (request.kind !== "permission" && response.permission !== undefined) throw new Error("Only permission interactions accept a decision");
    validateReferenceResponse(request.kind, response);
    validateSubmittedValue(request.kind, request.schema, response);
    if (response.permission === "allow_always") {
      const data = asRecord(request.data);
      if (data?.previewLimited !== false || data.resourceResolved !== true) {
        throw new Error("Persistent permission requires a complete preview and resolved resource");
      }
    }
    const permission = asRecord(request.data)?.permission;
    if (response.permission?.startsWith("allow_") && asRecord(permission) && typeof asRecord(permission)?.toolId === "string") {
      const scope = asRecord(permission)!;
      const grant: RunPermissionGrant = {
        toolId: scope.toolId as string,
        ...(typeof scope.connectionId === "string" ? { connectionId: scope.connectionId } : {}),
        ...(typeof scope.action === "string" ? { action: scope.action } : {}),
        permission: response.permission as Exclude<PermissionDecision, "deny">,
        ...(response.permission === "allow_once" ? { interactionId: response.interactionId } : {}),
        createdAt: response.respondedAt ?? now(),
      };
      this.#runPermissionGrants.set(this.#grantKey(grant), grant);
    }
    this.#pendingInteractions.delete(response.interactionId);
    clearTimeout(this.#interactionTimers.get(response.interactionId));
    this.#interactionTimers.delete(response.interactionId);
    this.#processedInteractionIds.add(response.interactionId);
    this.#interactionResponses.set(response.interactionId, structuredClone(response));
    this.#emit?.({ type: "interaction-resolved", response: {
      interactionId: response.interactionId,
      action: response.action,
      ...(response.permission ? { permission: response.permission } : {}),
    } });
    this.#refreshInteractionStatus();
    for (const waiter of this.#interactionWaiters.get(response.interactionId) ?? []) waiter.resolve(response);
    this.#interactionWaiters.delete(response.interactionId);
    this.#changed();
    return response;
  }

  #grantKey(grant: Pick<RunPermissionGrant, "toolId" | "connectionId" | "action" | "interactionId">): string {
    return JSON.stringify([grant.toolId, grant.connectionId ?? null, grant.action ?? null, grant.interactionId ?? null]);
  }

  #armInteractionExpiry(request: InteractionRequest): void {
    if (!request.expiresAt) return;
    const expires = Date.parse(request.expiresAt);
    if (!Number.isFinite(expires)) throw new Error("Interaction expiry is invalid");
    const timer = setTimeout(() => this.#expireInteraction(request.id), Math.max(0, expires - Date.now()));
    this.#interactionTimers.set(request.id, timer);
  }

  #expireInteraction(interactionId: string): void {
    const request = this.#pendingInteractions.get(interactionId);
    if (!request) return;
    this.#pendingInteractions.delete(interactionId);
    this.#processedInteractionIds.add(interactionId);
    this.#expiredInteractionIds.add(interactionId);
    clearTimeout(this.#interactionTimers.get(interactionId));
    this.#interactionTimers.delete(interactionId);
    const error = new Error(`Interaction '${interactionId}' expired`);
    this.#interactionResponses.set(interactionId, {
      interactionId,
      checkpointDigest: request.checkpoint.digest,
      action: "cancel",
      ...(request.kind === "permission" ? { permission: "deny" } : {}),
      respondedAt: now(),
    });
    for (const waiter of this.#interactionWaiters.get(interactionId) ?? []) waiter.reject(error);
    this.#interactionWaiters.delete(interactionId);
    this.#emit?.({ type: "interaction-resolved", response: {
      interactionId,
      action: "cancel",
      ...(request.kind === "permission" ? { permission: "deny" } : {}),
    } });
    this.#refreshInteractionStatus();
    this.#changed();
  }

  complete(status: "succeeded" | "failed" | "cancelled"): void {
    this.#status = status;
    this.#changed();
  }

  setSequence(sequence: number): void {
    this.#sequence = Math.max(this.#sequence, sequence);
  }

  registerTeam(teamId: string, team: TeamRuntimeDefinition): void {
    this.#teams.set(teamId, team);
  }

  cancel(reason = "Run cancelled"): void {
    if (!this.#abort.signal.aborted) this.#abort.abort(new Error(reason));
    this.#status = "cancelled";
    for (const controller of this.#taskControllers.values()) controller.abort(this.#abort.signal.reason);
    this.#changed();
  }

  async send(candidate: RunCommand | unknown): Promise<void> {
    const command = parseRunCommand(candidate);
    const commandId = command.id ?? id("command");
    if (this.#commands.has(commandId)) {
      const failure = this.#commands.get(commandId);
      if (failure) throw new Error(failure);
      return;
    }
    try {
      if (command.type === "message") this.message("user", command.target, "instruction", command.content, {
        ...(command.correlationId ? { correlationId: command.correlationId } : {}),
      });
      else if (command.type === "task-directive") {
        const task = this.#tasks.get(command.taskId);
        if (!task) throw new Error(`Task '${command.taskId}' does not exist`);
        if (task.status === "blocked") {
          this.#setTask({ ...task, status: "queued", updatedAt: now() });
        }
        this.message(
          "user",
          task.agentId ? { kind: "agent", id: task.agentId } : { kind: "team", id: task.teamId },
          "instruction",
          command.instruction,
          { teamId: task.teamId, taskId: task.id },
        );
      } else if (command.type === "plan-patch") {
        const teamId = this.#tasks.values().next().value?.teamId ?? this.#agents.values().next().value?.teamId;
        this.applyPlan("user", command.baseRevision, command.reason, command.operations, teamId);
      } else if (command.type === "interaction-response") this.resolveInteraction(command.response);
      else if (command.scope === "run") this.cancel("Run cancelled by user");
      else if (command.scope === "task") this.cancelTask(command.targetId!, "Task cancelled by user");
      else this.cancelAgent(command.targetId!, "Agent cancelled by user");
      this.#commands.set(commandId, undefined);
      this.#emit?.({ type: "command-applied", commandId, message: "Command applied" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Command rejected";
      this.#commands.set(commandId, message);
      this.#emit?.({ type: "command-rejected", commandId, message });
      throw error;
    } finally {
      this.#changed();
    }
  }

  createTask(teamId: string, task: PlannedTask): TaskRecord {
    if (this.#tasks.has(task.id)) throw new Error(`Task '${task.id}' already exists`);
    const timestamp = now();
    const record: TaskRecord = {
      id: boundedId(task.id, "Task id"), teamId, goal: boundedText(task.goal, "Task goal"),
      assignee: boundedId(task.agent, "Task agent"), dependsOn: [...new Set(task.dependsOn ?? [])],
      status: "queued", createdAt: timestamp, updatedAt: timestamp,
    };
    this.#tasks.set(record.id, record);
    this.#emit?.({ type: "task-created", task: record });
    this.#changed();
    return record;
  }

  spawnAgent(teamId: string, template: string, limits: TeamRuntimeDefinition["limits"], parentId?: string, taskId?: string): AgentInstance {
    const teamAgents = [...this.#agents.values()].filter((agent) => agent.teamId === teamId);
    if (teamAgents.length >= limits.maxInstances) throw new Error(`Team '${teamId}' exceeded ${limits.maxInstances} Agent instances`);
    const parent = parentId ? this.#agents.get(parentId) : undefined;
    const depth = parent ? parent.depth + 1 : 0;
    if (depth > limits.maxDepth) throw new Error(`Team '${teamId}' exceeded Agent spawn depth ${limits.maxDepth}`);
    const timestamp = now();
    const agent: AgentInstance = {
      id: id(template), teamId, template, ...(parentId ? { parentId } : {}), ...(taskId ? { taskId } : {}),
      depth, status: "queued", createdAt: timestamp, updatedAt: timestamp,
    };
    this.#agents.set(agent.id, agent);
    this.#inboxes.set(agent.id, this.#messages.filter((message) =>
      message.to.kind === "run"
      || (message.to.kind === "team" && message.to.id === teamId)
      || (taskId !== undefined && message.taskId === taskId)));
    this.#emit?.({ type: "agent-spawned", agent });
    this.#changed();
    return agent;
  }

  startTask(taskId: string, agentId: string, parentSignal: AbortSignal): AbortSignal {
    const task = this.#requireTask(taskId);
    const agent = this.#requireAgent(agentId);
    const controller = new AbortController();
    this.#taskControllers.set(taskId, controller);
    this.#setTask({ ...task, agentId, status: "running", updatedAt: now() });
    this.#setAgent({ ...agent, taskId, status: "running", updatedAt: now() });
    return AbortSignal.any([parentSignal, controller.signal, this.signal]);
  }

  finishTask(taskId: string, result: unknown, artifacts: readonly ArtifactReference[] = []): void {
    const task = this.#requireTask(taskId);
    this.#setTask({ ...task, status: "completed", result, ...(artifacts.length ? { artifacts } : {}), updatedAt: now() });
    if (task.agentId) this.#setAgent({ ...this.#requireAgent(task.agentId), status: "completed", updatedAt: now() });
    this.#taskControllers.delete(taskId);
  }

  finishAgent(agentId: string, status: "completed" | "failed" | "cancelled" = "completed"): void {
    const agent = this.#requireAgent(agentId);
    this.#setAgent({ ...agent, status, updatedAt: now() });
  }

  recordAgentUsage(agentId: string, usage?: TokenUsage, costUsd?: number): void {
    if (!usage && costUsd === undefined) return;
    const agent = this.#requireAgent(agentId);
    this.#setAgent({
      ...agent,
      ...(usage ? { usage: addUsage(agent.usage, usage) } : {}),
      ...(costUsd === undefined ? {} : { costUsd: (agent.costUsd ?? 0) + costUsd }),
      updatedAt: now(),
    });
  }

  startAgent(agentId: string): void {
    const agent = this.#requireAgent(agentId);
    this.#setAgent({ ...agent, status: "running", updatedAt: now() });
  }

  failTask(taskId: string, error: unknown): void {
    const task = this.#requireTask(taskId);
    const message = error instanceof Error ? error.message : "Task failed";
    this.#setTask({ ...task, status: "failed", error: message, updatedAt: now() });
    if (task.agentId) this.#setAgent({ ...this.#requireAgent(task.agentId), status: "failed", updatedAt: now() });
    this.#taskControllers.delete(taskId);
  }

  tasks(teamId: string): readonly TaskRecord[] {
    return [...this.#tasks.values()].filter((task) => task.teamId === teamId);
  }

  readyTasks(teamId: string): readonly TaskRecord[] {
    const tasks = this.tasks(teamId);
    const completed = new Set(tasks.filter((task) => task.status === "completed").map((task) => task.id));
    return tasks.filter((task) => task.status === "queued" && task.dependsOn.every((dependency) => completed.has(dependency)));
  }

  waitForChange(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const changed = () => {
        signal.removeEventListener("abort", aborted);
        this.#changeWaiters.delete(changed);
        resolve();
      };
      const aborted = () => {
        this.#changeWaiters.delete(changed);
        reject(signal.reason);
      };
      this.#changeWaiters.add(changed);
      signal.addEventListener("abort", aborted, { once: true });
    });
  }

  replacePlan(teamId: string, author: string, tasks: readonly PlannedTask[], reason: string): void {
    const operations = tasks.map((task): PlanOperation => ({
      op: "add", taskId: task.id, goal: task.goal, assignee: task.agent, dependsOn: task.dependsOn ?? [],
    }));
    this.applyPlan(author, this.#revision, reason, operations, teamId);
  }

  proposePlan(teamId: string, author: string, baseRevision: number, reason: string, operations: readonly PlanOperation[]): PlanProposal {
    const proposal: PlanProposal = {
      id: id("proposal"), teamId, author, baseRevision, reason: boundedText(reason, "Plan reason"),
      operations: operations.map(planOperation), status: "pending", createdAt: now(),
    };
    this.#proposals.set(proposal.id, proposal);
    this.#emit?.({ type: "plan-proposed", proposal });
    this.#changed();
    return proposal;
  }

  acceptPending(teamId: string, orchestratorId: string): void {
    for (const proposal of [...this.#proposals.values()].filter((item) => item.teamId === teamId && item.status === "pending")) {
      try {
        this.applyPlan(orchestratorId, proposal.baseRevision, proposal.reason, proposal.operations, teamId);
        this.#proposals.set(proposal.id, { ...proposal, status: "accepted" });
      } catch {
        this.#proposals.set(proposal.id, { ...proposal, status: "rejected" });
      }
    }
    this.#changed();
  }

  applyPlan(author: string, baseRevision: number, reason: string, operations: readonly PlanOperation[], teamId?: string): void {
    if (baseRevision !== this.#revision) throw new Error(`Plan changed from revision ${baseRevision} to ${this.#revision}`);
    const team = teamId ? this.#teams.get(teamId) : undefined;
    if (team && this.#revisions.filter((revision) => revision.author !== "user").length >= team.limits.maxPlanRevisions) {
      throw new Error(`Team '${teamId}' exceeded ${team.limits.maxPlanRevisions} plan revisions`);
    }
    const planReason = boundedText(reason, "Plan reason");
    const normalized = operations.map(planOperation);
    const preview = new Map(this.#tasks);
    for (const operation of normalized) {
      const existing = preview.get(operation.taskId);
      if (operation.op === "add") {
        if (!teamId) throw new Error("A Team id is required to add a task");
        if (existing) throw new Error(`Task '${operation.taskId}' already exists`);
        if (team && !team.members.includes(operation.assignee!)) {
          throw new Error(`Agent template '${operation.assignee}' is not allowed in Team '${teamId}'`);
        }
        const timestamp = now();
        preview.set(operation.taskId, {
          id: operation.taskId, teamId, goal: operation.goal!, assignee: operation.assignee!,
          dependsOn: operation.dependsOn ?? [], status: "queued", createdAt: timestamp, updatedAt: timestamp,
        });
      } else if (!existing) throw new Error(`Task '${operation.taskId}' does not exist`);
      else if (operation.op === "cancel") preview.set(existing.id, this.#cancelStatus(existing, `Cancelled by ${author}`));
      else {
        if (operation.assignee && team && !team.members.includes(operation.assignee)) {
          throw new Error(`Agent template '${operation.assignee}' is not allowed in Team '${teamId}'`);
        }
        preview.set(existing.id, {
          ...existing,
          ...(operation.goal ? { goal: operation.goal } : {}),
          ...(operation.assignee ? { assignee: operation.assignee } : {}),
          ...(operation.dependsOn ? { dependsOn: operation.dependsOn } : {}),
        });
      }
    }
    const teamTasks = [...preview.values()].filter((task) => !teamId || task.teamId === teamId);
    if (team && teamTasks.length > team.limits.maxInstances - 1) {
      throw new Error(`Team '${teamId}' exceeded ${team.limits.maxInstances - 1} planned Tasks`);
    }
    const teamTaskIds = new Set(teamTasks.map(({ id: taskId }) => taskId));
    for (const task of teamTasks) for (const dependency of task.dependsOn) {
      if (!teamTaskIds.has(dependency)) throw new Error(`Task '${task.id}' depends on missing Task '${dependency}'`);
      if (dependency === task.id) throw new Error(`Task '${task.id}' cannot depend on itself`);
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (taskId: string): void => {
      if (visiting.has(taskId)) throw new Error(`Plan contains a dependency cycle at Task '${taskId}'`);
      if (visited.has(taskId)) return;
      visiting.add(taskId);
      for (const dependency of preview.get(taskId)?.dependsOn ?? []) visit(dependency);
      visiting.delete(taskId);
      visited.add(taskId);
    };
    for (const task of teamTasks) visit(task.id);

    for (const operation of normalized) {
      const existing = this.#tasks.get(operation.taskId);
      if (operation.op === "add") {
        this.createTask(teamId!, {
          id: operation.taskId, goal: operation.goal!, agent: operation.assignee!, dependsOn: operation.dependsOn ?? [],
        });
      } else if (!existing) throw new Error(`Task '${operation.taskId}' does not exist`);
      else if (operation.op === "cancel") this.cancelTask(existing.id, `Cancelled by ${author}`);
      else this.#setTask({
        ...existing,
        ...(operation.goal ? { goal: operation.goal } : {}),
        ...(operation.assignee ? { assignee: operation.assignee } : {}),
        ...(operation.dependsOn ? { dependsOn: operation.dependsOn } : {}),
        updatedAt: now(),
      });
    }
    this.#revision += 1;
    const revision: PlanRevision = {
      revision: this.#revision, author, reason: planReason,
      operations: normalized, createdAt: now(),
    };
    this.#revisions.push(revision);
    this.#emit?.({ type: "plan-revised", revision });
    this.#changed();
  }

  message(
    from: AgentMessage["from"],
    to: AgentMessage["to"],
    kind: AgentMessage["kind"],
    content: string,
    details: Pick<AgentMessage, "teamId" | "correlationId" | "taskId" | "artifacts"> = {},
  ): AgentMessage {
    if (to.kind === "agent" && (!to.id || !this.#agents.has(to.id))) throw new Error(`Agent '${to.id ?? ""}' does not exist`);
    if (to.kind === "team" && (!to.id || !this.#teams.has(to.id))) throw new Error(`Team '${to.id ?? ""}' does not exist`);
    const message: AgentMessage = {
      id: id("message"), from, to, kind, content: boundedText(content, "Message"), createdAt: now(), ...details,
    };
    const duplicate = this.#messages.find((candidate) => message.correlationId && candidate.correlationId === message.correlationId
      && candidate.from === message.from && candidate.to.kind === message.to.kind && candidate.to.id === message.to.id
      && candidate.content === message.content);
    if (duplicate) return duplicate;
    if (this.#messages.length >= 1_000) throw new Error("Run exceeded 1,000 Agent messages");
    const team = details.teamId ? this.#teams.get(details.teamId) : undefined;
    if (team && this.#messages.filter((item) => item.teamId === details.teamId).length >= team.limits.maxMessages) {
      throw new Error(`Team '${details.teamId}' exceeded ${team.limits.maxMessages} messages`);
    }
    this.#messages.push(message);
    const recipients = to.kind === "agent" && to.id ? [to.id]
      : [...this.#agents.values()].filter((agent) => agent.id !== from
        && (to.kind === "run" || (to.kind === "team" && agent.teamId === to.id))).map((agent) => agent.id);
    for (const recipient of recipients) {
      const inbox = this.#inboxes.get(recipient) ?? [];
      inbox.push(message);
      this.#inboxes.set(recipient, inbox);
    }
    this.#emit?.({ type: "agent-message", message });
    this.#changed();
    return message;
  }

  checkpoint(agentId: string): AgentCheckpoint {
    const messages = this.#inboxes.get(agentId) ?? [];
    this.#inboxes.set(agentId, []);
    const agent = this.#agents.get(agentId);
    return {
      messages: [...messages],
      ...(agent?.taskId && this.#tasks.has(agent.taskId) ? { task: this.#tasks.get(agent.taskId)! } : {}),
      revision: this.#revision,
    };
  }

  async executeAgentTool(team: TeamRuntimeDefinition, agentId: string, toolId: string, input: unknown): Promise<unknown> {
    const agent = this.#requireAgent(agentId);
    const value = asRecord(input);
    if (!value) throw new Error("Agent control Tool input must be an object");
    if (toolId === "harnest.message_agent") {
      const target = boundedId(value.target, "Target Agent");
      if (!this.#agents.has(target)) throw new Error(`Agent '${target}' is not active`);
      if (target === agentId) throw new Error("An Agent cannot message itself");
      return this.message(agentId, { kind: "agent", id: target }, "message", boundedText(value.content, "Message"), {
        teamId: agent.teamId, ...(value.correlationId ? { correlationId: boundedExternalId(value.correlationId, "Correlation id") } : {}),
      });
    }
    if (toolId === "harnest.message_team") return this.message(
      agentId, { kind: "team", id: agent.teamId }, "message", boundedText(value.content, "Message"),
      { teamId: agent.teamId, ...(value.correlationId ? { correlationId: boundedExternalId(value.correlationId, "Correlation id") } : {}) },
    );
    if (toolId === "harnest.request_help") {
      const template = boundedId(value.agent, "Agent template");
      if (!team.members.includes(template)) throw new Error(`Agent template '${template}' is not allowed in this Team`);
      if (this.tasks(agent.teamId).length >= team.limits.maxInstances - 1) throw new Error("Team task limit reached");
      return this.createTask(agent.teamId, {
        id: id("task"), goal: boundedText(value.goal, "Help goal"), agent: template,
        ...(agent.taskId ? { dependsOn: [] } : {}),
      });
    }
    if (toolId === "harnest.propose_plan_update") {
      if (!Number.isInteger(value.baseRevision) || !Array.isArray(value.operations)) throw new Error("Plan proposal is invalid");
      return this.proposePlan(
        agent.teamId, agentId, Number(value.baseRevision), boundedText(value.reason, "Plan reason"), value.operations.map(planOperation),
      );
    }
    if (toolId === "harnest.report_result") return this.message(
      agentId, { kind: "team", id: agent.teamId }, "result", boundedText(value.content, "Result"),
      { teamId: agent.teamId, ...(agent.taskId ? { taskId: agent.taskId } : {}) },
    );
    if (toolId === "harnest.request_interaction") {
      if (!["input", "select", "form", "file", "oauth", "permission"].includes(String(value.kind))) throw new Error("Interaction kind is invalid");
      return this.requestInteraction({
        kind: value.kind as InteractionKind,
        nodeId: agentId,
        ...(agent.taskId ? { taskId: agent.taskId } : {}),
        agentId,
        requester: { kind: "agent", id: agentId },
        title: "Agent request",
        message: boundedText(value.prompt, "Interaction prompt"),
        blocking: agent.taskId ? "task" : "run",
        ...((value.options || asRecord(value.data)) ? { data: {
          ...(asRecord(value.data) ?? {}),
          ...(value.options ? { options: jsonValue(value.options, "Interaction options") } : {}),
        } } : {}),
      });
    }
    throw new Error(`Unknown orchestration Tool '${toolId}'`);
  }

  #cancelStatus(task: TaskRecord, reason: string): TaskRecord {
    return { ...task, status: "cancelled", error: reason, updatedAt: now() };
  }

  cancelTask(taskId: string, reason: string): void {
    const task = this.#requireTask(taskId);
    this.#taskControllers.get(taskId)?.abort(new Error(reason));
    this.#taskControllers.delete(taskId);
    this.#setTask(this.#cancelStatus(task, reason));
    if (task.agentId && this.#agents.has(task.agentId)) this.#setAgent({
      ...this.#requireAgent(task.agentId), status: "cancelled", updatedAt: now(),
    });
  }

  cancelAgent(agentId: string, reason: string): void {
    const agent = this.#requireAgent(agentId);
    if (agent.taskId && this.#tasks.has(agent.taskId)) this.cancelTask(agent.taskId, reason);
    else this.#setAgent({ ...agent, status: "cancelled", updatedAt: now() });
  }

  #requireTask(taskId: string): TaskRecord {
    const task = this.#tasks.get(taskId);
    if (!task) throw new Error(`Task '${taskId}' does not exist`);
    return task;
  }

  #requireAgent(agentId: string): AgentInstance {
    const agent = this.#agents.get(agentId);
    if (!agent) throw new Error(`Agent '${agentId}' does not exist`);
    return agent;
  }

  #setTask(task: TaskRecord): void {
    this.#tasks.set(task.id, task);
    this.#refreshInteractionStatus();
    this.#emit?.({ type: "task-status", task });
    this.#changed();
  }

  #setAgent(agent: AgentInstance): void {
    this.#agents.set(agent.id, agent);
    this.#refreshInteractionStatus();
    this.#emit?.({ type: "agent-status", agent });
    this.#changed();
  }

  #changed(): void {
    const snapshot = this.snapshot();
    this.#emit?.({ type: "run-snapshot", snapshot });
    for (const waiter of [...this.#changeWaiters]) waiter();
  }

  #refreshInteractionStatus(interactionId?: string): void {
    if (this.#status !== "running" && this.#status !== "paused") return;
    const before = this.#status;
    if (!this.#pendingInteractions.size) this.#status = "running";
    else if ([...this.#pendingInteractions.values()].some(({ blocking }) => blocking === "run")) this.#status = "paused";
    else {
      const blockedTasks = new Set([...this.#pendingInteractions.values()].flatMap(({ taskId }) => taskId ? [taskId] : []));
      const blockedAgents = new Set([...this.#pendingInteractions.values()].flatMap(({ agentId }) => agentId ? [agentId] : []));
      const runnableTask = [...this.#tasks.values()].some((task) =>
        (task.status === "queued" || task.status === "running") && !blockedTasks.has(task.id));
      const runnableAgent = [...this.#agents.values()].some((agent) =>
        (agent.status === "queued" || agent.status === "running") && !blockedAgents.has(agent.id)
        && (!agent.taskId || !blockedTasks.has(agent.taskId)));
      this.#status = runnableTask || runnableAgent ? "running" : "paused";
    }
    if (before !== this.#status) this.#emit?.({
      type: "run-paused",
      paused: this.#status === "paused",
      ...(this.#status === "paused" && interactionId ? { interactionId } : {}),
    });
  }
}
