import { z } from "zod";

export const PROTOCOL_VERSION = "1.0" as const;

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const opaque = z.string().min(1).max(512);
const digest = z.string().min(16).max(256).regex(/^[A-Za-z0-9_-]+$/u);
const timestamp = z.iso.datetime({ offset: true });
const jsonObject = z.looseObject({});
const revision = z.union([z.string().min(1).max(512), z.number().finite()]);
const controlCharacters = Array.from({ length: 32 }, (_, index) => String.fromCharCode(index)).join("")
  + String.fromCharCode(127);
const opaqueHeader = new RegExp(`^[^${controlCharacters}]+$`, "u");

export const IdempotencyKeySchema = z.string().min(1).max(512).regex(opaqueHeader);

export const ExternalAttachmentSchema = z.strictObject({
  ref: opaque,
  name: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(127).regex(/^[\w.+-]+\/[\w.+-]+$/u),
  size: z.number().int().nonnegative().max(64 * 1_048_576),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

export const CreateRunContextSchema = z.strictObject({
  contextRef: opaque,
  revisions: z.strictObject({
    conversation: revision.optional(),
    memory: revision.optional(),
    pkm: revision.optional(),
  }).optional(),
  attachments: z.array(ExternalAttachmentSchema).max(32).optional(),
});

export const CreateRunRequestSchema = z.strictObject({
  input: z.unknown(),
  resumeRunId: id.optional(),
  context: CreateRunContextSchema.optional(),
});

export const RunEventSchema = z.looseObject({
  type: z.string().min(1),
  runId: id,
  timestamp,
  sequence: z.number().int().nonnegative().optional(),
});

const messageTarget = z.strictObject({ kind: z.enum(["run", "team", "agent"]), id: id.optional() });
const planOperation = z.strictObject({
  op: z.enum(["add", "update", "cancel"]),
  taskId: id,
  goal: z.string().min(1).max(65_536).optional(),
  assignee: id.optional(),
  dependsOn: z.array(id).max(64).optional(),
});

export const InteractionRequestSchema = z.strictObject({
  id,
  runId: id,
  nodeId: opaque,
  taskId: opaque.optional(),
  agentId: opaque.optional(),
  kind: z.enum(["select", "input", "form", "file", "oauth", "permission"]),
  requester: z.strictObject({ kind: z.enum(["harness", "agent", "tool", "mcp"]), id: opaque }),
  title: z.string().min(1).max(512),
  message: z.string().min(1).max(65_536),
  blocking: z.enum(["task", "run"]),
  schema: jsonObject.optional(),
  data: z.unknown().optional(),
  checkpoint: z.strictObject({
    revision: z.number().int().nonnegative(),
    sequence: z.number().int().nonnegative(),
    digest,
  }),
  createdAt: timestamp,
  expiresAt: timestamp.optional(),
});

export const InteractionResponseSchema = z.strictObject({
  interactionId: id,
  checkpointDigest: digest,
  action: z.enum(["submit", "decline", "cancel"]),
  value: z.unknown().optional(),
  permission: z.enum(["allow_once", "allow_for_run", "allow_always", "deny"]).optional(),
});

export const InteractionResolvedSchema = z.strictObject({
  interactionId: id,
  action: z.enum(["submit", "decline", "cancel"]),
  permission: z.enum(["allow_once", "allow_for_run", "allow_always", "deny"]).optional(),
});

export const PermissionScopeSchema = z.strictObject({
  harnessId: opaque,
  toolId: opaque,
  connectionId: opaque.optional(),
  capability: z.enum(["network", "process", "workspace-write"]),
  resource: z.string().min(1).max(512).optional(),
});

export const PermissionSchema = z.strictObject({
  scope: PermissionScopeSchema,
  effect: z.enum(["allow_for_run", "allow_always", "deny"]),
  createdAt: timestamp,
  expiresAt: timestamp.optional(),
});

const commonCommand = { commandId: id.optional() };
export const RunCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...commonCommand,
    type: z.literal("message"),
    target: messageTarget,
    content: z.string().min(1).max(65_536),
    correlationId: id.optional(),
  }),
  z.strictObject({
    ...commonCommand,
    type: z.literal("task-directive"),
    taskId: id,
    instruction: z.string().min(1).max(65_536),
  }),
  z.strictObject({
    ...commonCommand,
    type: z.literal("plan-patch"),
    baseRevision: z.number().int().nonnegative(),
    reason: z.string().min(1).max(65_536),
    operations: z.array(planOperation).min(1).max(64),
  }),
  z.strictObject({
    ...commonCommand,
    type: z.literal("cancel"),
    scope: z.enum(["run", "task", "agent"]),
    targetId: id.optional(),
  }),
  z.strictObject({
    ...commonCommand,
    type: z.literal("interaction.response"),
    response: InteractionResponseSchema,
  }),
]);

export const WireEnvelopeSchema = z.looseObject({
  protocolVersion: z.string().regex(/^1\.\d+$/u),
  eventId: id,
  runId: id,
  sequence: z.number().int().nonnegative(),
  time: timestamp,
  type: z.string().min(1).max(128).regex(/^[a-z][a-z0-9]*(?:\.[a-z0-9]+)*$/u),
  data: z.unknown(),
}).superRefine((envelope, context) => {
  const schema = envelope.type === "interaction.requested" ? InteractionRequestSchema
    : envelope.type === "interaction.resolved" ? InteractionResolvedSchema
    : envelope.type === "run.snapshot" ? jsonObject : undefined;
  const parsed = schema?.safeParse(envelope.data);
  if (parsed && !parsed.success) {
    for (const issue of parsed.error.issues) context.addIssue({ ...issue, path: ["data", ...issue.path] });
  }
});

export const CreateRunResponseSchema = z.looseObject({ runId: id });
export const SnapshotResponseSchema = z.looseObject({ snapshot: jsonObject, active: z.boolean() });
export const AckResponseSchema = z.looseObject({ ok: z.literal(true) });

export const protocolJsonSchema = z.toJSONSchema(WireEnvelopeSchema, {
  target: "draft-2020-12",
  unrepresentable: "any",
});
export const commandJsonSchema = z.toJSONSchema(RunCommandSchema, { target: "draft-2020-12", unrepresentable: "any" });
export const interactionJsonSchema = z.toJSONSchema(InteractionRequestSchema, { target: "draft-2020-12", unrepresentable: "any" });
export const permissionJsonSchema = z.toJSONSchema(PermissionSchema, { target: "draft-2020-12" });
export const createRunJsonSchema = z.toJSONSchema(CreateRunRequestSchema, { target: "draft-2020-12", unrepresentable: "any" });
export const idempotencyKeyJsonSchema = z.toJSONSchema(IdempotencyKeySchema, { target: "draft-2020-12" });
export const snapshotJsonSchema = z.toJSONSchema(SnapshotResponseSchema, { target: "draft-2020-12", unrepresentable: "any" });

export interface InternalEvent {
  readonly type: string;
  readonly runId: string;
  readonly timestamp: string;
  readonly sequence: number;
  readonly eventId?: string;
  readonly [key: string]: unknown;
}

const wireType = (type: string, event: InternalEvent): string => {
  if (type === "run-start") return "run.started";
  if (type === "run-end") return "run.completed";
  if (type === "error") return event.code === "RUN_CANCELLED" ? "run.cancelled" : "run.failed";
  if (type === "interaction-requested") return "interaction.requested";
  if (type === "interaction-resolved") return "interaction.resolved";
  if (type === "run-paused") return event.paused === false ? "run.resumed" : "run.paused";
  if (type === "run-snapshot") return "run.snapshot";
  return type.replaceAll("-", ".");
};

/** Converts a structural core event without importing the core or Node runtime. */
export function toWireEvent(event: InternalEvent): WireEnvelope {
  const type = wireType(event.type, event);
  const response = event.response && typeof event.response === "object" ? event.response as Record<string, unknown> : {};
  const data = event.type === "interaction-requested" ? event.request
    : event.type === "interaction-resolved"
      ? {
          interactionId: response.interactionId,
          action: response.action,
          ...(response.permission === undefined ? {} : { permission: response.permission }),
        }
    : event.type === "run-snapshot" ? event.snapshot
    : event;
  if (event.type === "interaction-requested") InteractionRequestSchema.parse(data);
  return WireEnvelopeSchema.parse({
    protocolVersion: PROTOCOL_VERSION,
    eventId: event.eventId ?? `${event.runId}.${event.sequence}`,
    runId: event.runId,
    sequence: event.sequence,
    time: event.timestamp,
    type,
    data,
  });
}

/** Maps the pre-v1 approval shape; canonical writers must use InteractionRequestSchema. */
export function legacyApprovalToInteraction(value: unknown): InteractionRequest {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const runId = String(input.runId ?? "");
  const nodeId = String(input.nodeId ?? "");
  const tool = input.tool && typeof input.tool === "object" ? input.tool as Record<string, unknown> : {};
  const toolId = String(input.toolId ?? tool.id ?? "");
  return InteractionRequestSchema.parse({
    id: input.id,
    runId,
    nodeId,
    kind: "permission",
    requester: { kind: "tool", id: toolId },
    title: input.title ?? `Allow ${toolId}?`,
    message: input.message ?? `Allow Tool '${toolId}' to continue?`,
    blocking: "run",
    data: input,
    checkpoint: input.checkpoint,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
  });
}

export type RunEvent = z.infer<typeof RunEventSchema>;
export type ExternalAttachment = z.infer<typeof ExternalAttachmentSchema>;
export type CreateRunContext = z.infer<typeof CreateRunContextSchema>;
export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>;
export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>;
export type RunCommand = z.infer<typeof RunCommandSchema>;
export type InteractionRequest = z.infer<typeof InteractionRequestSchema>;
export type InteractionResponse = z.infer<typeof InteractionResponseSchema>;
export type InteractionResolved = z.infer<typeof InteractionResolvedSchema>;
export type PermissionScope = z.infer<typeof PermissionScopeSchema>;
export type Permission = z.infer<typeof PermissionSchema>;
export type WireEnvelope = z.infer<typeof WireEnvelopeSchema>;
export type CreateRunResponse = z.infer<typeof CreateRunResponseSchema>;
export type SnapshotResponse = z.infer<typeof SnapshotResponseSchema>;
