import { Ajv2020 } from "ajv/dist/2020.js";
import { inspectSafeRegex } from "./safe-regex.js";

export interface ToolExecutionContext {
  readonly signal: AbortSignal;
  readonly runId: string;
  readonly nodeId: string;
  readonly iteration: number;
  resolveSecret(reference: string): string | undefined;
}

export type ToolRisk = "read" | "write" | "external" | "destructive";

export interface ToolManifest {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly category?: string;
  readonly risk?: ToolRisk;
  readonly source?: "builtin" | "module" | "custom" | "mcp" | "skill";
  readonly connectionKinds?: readonly string[];
}

/** Serializable reference carried by a graph edge; executors stay in registries/services. */
export interface ToolBinding extends ToolManifest {
  readonly connectionId?: string;
  readonly action?: string;
}

export function requiredToolCapability(
  tool: Pick<ToolManifest, "id" | "risk" | "source">,
): "network" | "process" | "workspace-write" | undefined {
  if (tool.id === "builtin.shell" || tool.id === "builtin.code-runner") return "process";
  if (tool.id === "builtin.file") return "workspace-write";
  if (tool.source === "mcp" || tool.risk === "external") return "network";
  if (tool.risk === "write") return "workspace-write";
  if (tool.risk === "destructive") return "process";
  return undefined;
}

export interface ToolApprovalRequest {
  readonly runId: string;
  readonly nodeId: string;
  readonly callId: string;
  readonly turn: number;
  readonly tool: ToolBinding;
  readonly input: unknown;
}

export interface ToolApprovalDecision {
  readonly approved: boolean;
  readonly source?: "policy" | "user";
  readonly reason?: string;
  /** Legacy values are accepted at host boundaries and normalized before use. */
  readonly mode?: PermissionDecision;
}

export type PermissionDecision = "allow_once" | "allow_for_run" | "allow_always" | "deny";
export type LegacyPermissionDecision = "once" | "always" | "deny";

export function normalizePermissionDecision(
  mode: PermissionDecision | LegacyPermissionDecision | undefined,
  approved: boolean,
): PermissionDecision {
  if (!approved || mode === "deny") return "deny";
  if (mode === "always") return "allow_always";
  if (mode === "once" || mode === undefined) return "allow_once";
  return mode;
}

export interface ToolDefinition extends ToolManifest {
  execute(input: unknown, context: ToolExecutionContext): Promise<unknown> | unknown;
}

export class ToolRegistryError extends Error {
  readonly code: "TOOL_INVALID" | "TOOL_DUPLICATE" | "TOOL_NOT_FOUND";
  readonly toolId: string;

  constructor(code: ToolRegistryError["code"], toolId: string, message: string) {
    super(message);
    this.name = "ToolRegistryError";
    this.code = code;
    this.toolId = toolId;
  }
}

const TOOL_ID = /^[a-z][a-z0-9._-]*$/;
const MAX_SCHEMA_BYTES = 262_144;
const schemaValidator = new Ajv2020({ strict: false, validateSchema: true });

export function snapshotSafeJsonSchema(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const seen = new WeakSet<object>();
  const stack: Array<{ value: object; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const current = stack.pop()!;
    if (seen.has(current.value) || current.depth > 64 || ++nodes > 10_000) return undefined;
    seen.add(current.value);
    const record = current.value as Record<string, unknown>;
    if (typeof record.pattern === "string" && inspectSafeRegex(record.pattern)) return undefined;
    if (record.patternProperties && typeof record.patternProperties === "object" && !Array.isArray(record.patternProperties)
      && Object.keys(record.patternProperties).some((pattern) => inspectSafeRegex(pattern))) return undefined;
    for (const child of Object.values(current.value)) {
      if (child && typeof child === "object") stack.push({ value: child, depth: current.depth + 1 });
    }
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return undefined;
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_SCHEMA_BYTES) return undefined;
  const snapshot = JSON.parse(serialized) as Record<string, unknown>;
  try {
    if (!schemaValidator.validateSchema(snapshot)) return undefined;
  } catch {
    return undefined;
  }
  const freeze = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== "object" || Object.isFrozen(candidate)) return;
    for (const child of Object.values(candidate)) freeze(child);
    Object.freeze(candidate);
  };
  freeze(snapshot);
  return snapshot;
}

export class ToolRegistry {
  readonly #tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): this {
    const inputSchema = snapshotSafeJsonSchema(tool?.inputSchema);
    const outputSchema = tool?.outputSchema === undefined ? undefined : snapshotSafeJsonSchema(tool.outputSchema);
    if (!tool || typeof tool !== "object" || !TOOL_ID.test(tool.id)
      || !tool.label || !tool.description || typeof tool.execute !== "function"
      || !inputSchema || (tool.outputSchema !== undefined && !outputSchema)
      || (tool.risk !== undefined && !["read", "write", "external", "destructive"].includes(tool.risk))
      || (tool.source !== undefined && !["builtin", "module", "custom", "mcp", "skill"].includes(tool.source))
      || (tool.connectionKinds !== undefined
        && (!Array.isArray(tool.connectionKinds) || tool.connectionKinds.some((kind) => typeof kind !== "string")))) {
      throw new ToolRegistryError("TOOL_INVALID", typeof tool?.id === "string" ? tool.id : "unknown", "Tool does not implement the ToolDefinition contract");
    }
    if (this.#tools.has(tool.id)) {
      throw new ToolRegistryError("TOOL_DUPLICATE", tool.id, `Tool '${tool.id}' is already registered`);
    }
    const snapshot: ToolDefinition = Object.freeze({
      id: tool.id,
      label: tool.label,
      description: tool.description,
      inputSchema,
      ...(outputSchema ? { outputSchema } : {}),
      ...(tool.category ? { category: tool.category } : {}),
      ...(tool.risk ? { risk: tool.risk } : {}),
      ...(tool.source ? { source: tool.source } : {}),
      ...(tool.connectionKinds ? { connectionKinds: Object.freeze([...tool.connectionKinds]) } : {}),
      execute: tool.execute,
    });
    this.#tools.set(tool.id, snapshot);
    return this;
  }

  has(id: string): boolean {
    return this.#tools.has(id);
  }

  get(id: string): ToolDefinition {
    const tool = this.#tools.get(id);
    if (!tool) throw new ToolRegistryError("TOOL_NOT_FOUND", id, `Tool '${id}' is not registered`);
    return tool;
  }

  list(): readonly ToolDefinition[] {
    return [...this.#tools.values()];
  }

  catalog(): readonly ToolManifest[] {
    return this.list().map(({
      id,
      label,
      description,
      inputSchema,
      outputSchema,
      category,
      risk,
      source,
      connectionKinds,
    }) => ({
      id,
      label,
      description,
      inputSchema: structuredClone(inputSchema),
      ...(outputSchema ? { outputSchema: structuredClone(outputSchema) } : {}),
      ...(category ? { category } : {}),
      ...(risk ? { risk } : {}),
      ...(source ? { source } : {}),
      ...(connectionKinds ? { connectionKinds: [...connectionKinds] } : {}),
    }));
  }
}
