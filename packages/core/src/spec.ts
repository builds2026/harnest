import { parseDocument, stringify } from "yaml";
import { z } from "zod";

export type DiagnosticSeverity = "error" | "warning";

export interface Diagnostic {
  code: string;
  path: string;
  message: string;
  componentId?: string;
  hint?: string;
  severity: DiagnosticSeverity;
}

export const ComponentIdSchema = z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
export const ComponentTypeSchema = z.string().min(1).max(96).regex(/^[a-z][a-z0-9._-]*$/);
const stateKey = z.string().min(1).max(128).regex(/^[A-Za-z][A-Za-z0-9_.-]*$/);
const jsonPointer = z.string().max(512).regex(/^(?:|\/.*)$/);
const config = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const record = z.record(z.string(), z.unknown());

export const ModelComponentSchema = z.object({
  id: ComponentIdSchema,
  type: z.literal("model"),
  config: config({
    adapter: z.string().min(1),
    model: z.string().min(1),
    apiKey: z.string().min(1).optional(),
    baseUrl: z.string().url().optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().optional(),
  }),
}).strict();

export const PromptComponentSchema = z.object({
  id: ComponentIdSchema,
  type: z.literal("prompt"),
  config: config({ template: z.string().min(1) }),
}).strict();

export const AgentComponentSchema = z.object({
  id: ComponentIdSchema,
  type: z.literal("agent"),
  config: config({
    system: z.string().optional(),
    timeoutMs: z.number().int().positive().max(600_000).optional(),
  }),
}).strict();

export const OutputComponentSchema = z.object({
  id: ComponentIdSchema,
  type: z.literal("output"),
  config: config({
    format: z.enum(["text", "json"]).optional(),
    schema: record.optional(),
  }),
}).strict();

/** The original v0.1 component schema remains public and strict. */
export const ComponentSchema = z.discriminatedUnion("type", [
  ModelComponentSchema,
  PromptComponentSchema,
  AgentComponentSchema,
  OutputComponentSchema,
]);

export const ConnectionSchema = z.object({
  id: ComponentIdSchema.optional(),
  from: z.object({ component: ComponentIdSchema, port: ComponentIdSchema }).strict(),
  to: z.object({ component: ComponentIdSchema, port: ComponentIdSchema }).strict(),
}).strict();

export const PredicateSchema = z.object({
  source: z.enum(["value", "state", "input"]).optional(),
  path: jsonPointer.optional(),
  op: z.enum([
    "equals",
    "notEquals",
    "contains",
    "matches",
    "exists",
    "truthy",
    "gt",
    "gte",
    "lt",
    "lte",
  ]),
  value: z.unknown().optional(),
}).strict();

export const RetryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(10),
  backoffMs: z.number().int().min(0).max(60_000).optional(),
  maxBackoffMs: z.number().int().min(0).max(60_000).optional(),
}).strict();

export const ComponentPolicySchema = z.object({
  timeoutMs: z.number().int().positive().max(600_000).optional(),
  retry: RetryPolicySchema.optional(),
}).strict();

export const V02ComponentSchema = z.object({
  id: ComponentIdSchema,
  type: ComponentTypeSchema,
  config: record,
  policy: ComponentPolicySchema.optional(),
}).strict();

export const V02ConnectionSchema = ConnectionSchema.extend({
  condition: PredicateSchema.optional(),
  select: jsonPointer.optional(),
  state: z.object({
    key: stateKey,
    merge: z.enum(["replace", "append"]).optional(),
  }).strict().optional(),
}).strict();

export const StringAssertionSchema = z.object({
  type: z.enum(["includes", "equals", "matches"]),
  value: z.string(),
}).strict();

export const OutputSchemaAssertionSchema = z.object({
  type: z.literal("output-schema"),
  schema: record,
}).strict();

export const ToolCalledAssertionSchema = z.object({
  type: z.literal("tool-called"),
  tool: z.string().min(1),
  minCalls: z.number().int().min(0).optional(),
  maxCalls: z.number().int().min(0).optional(),
}).strict();

export const LatencyAssertionSchema = z.object({
  type: z.literal("latency"),
  maxMs: z.number().nonnegative(),
}).strict();

export const IterationAssertionSchema = z.object({
  type: z.literal("iterations"),
  min: z.number().int().min(0).optional(),
  max: z.number().int().min(0).optional(),
}).strict();

export const HarnessAssertionSchema = z.discriminatedUnion("type", [
  StringAssertionSchema,
  OutputSchemaAssertionSchema,
  ToolCalledAssertionSchema,
  LatencyAssertionSchema,
  IterationAssertionSchema,
]);

export const HarnessTestCaseSchema = z.object({
  id: ComponentIdSchema,
  input: z.string(),
  assertion: StringAssertionSchema,
}).strict();

export const HarnessTestCaseV02Schema = z.object({
  id: ComponentIdSchema,
  input: z.unknown(),
  assertion: HarnessAssertionSchema.optional(),
  assertions: z.array(HarnessAssertionSchema).min(1).optional(),
}).strict().superRefine((test, context) => {
  if (test.assertion === undefined && test.assertions === undefined) {
    context.addIssue({ code: "custom", message: "A test requires assertion or assertions", path: ["assertions"] });
  }
});

export const HarnessSpecV01Schema = z.object({
  version: z.literal("0.1"),
  components: z.array(ComponentSchema).min(1),
  connections: z.array(ConnectionSchema),
  entrypoint: ComponentIdSchema,
  runtime: z.object({
    timeoutMs: z.number().int().positive().max(600_000).optional(),
    adapters: z.array(z.string().min(1)).optional(),
  }).strict().optional(),
  tests: z.array(HarnessTestCaseSchema).optional(),
  studio: z.object({
    positions: z.record(ComponentIdSchema, z.object({ x: z.number(), y: z.number() }).strict()),
  }).strict().optional(),
}).strict();

export const GraphBodySchema = z.object({
  components: z.array(V02ComponentSchema).min(1),
  connections: z.array(V02ConnectionSchema),
  entrypoint: ComponentIdSchema,
}).strict();

const AdvancedRuntimeSchema = z.object({
    timeoutMs: z.number().int().positive().max(600_000).optional(),
    adapters: z.array(z.string().min(1)).optional(),
    modules: z.array(z.string().min(1)).optional(),
    retry: RetryPolicySchema.optional(),
    budget: z.object({
      maxTokens: z.number().int().positive().optional(),
      maxCostUsd: z.number().positive().optional(),
    }).strict().optional(),
    context: z.object({
      cacheMode: z.enum(["automatic", "explicit"]).optional(),
      overflow: z.enum(["compact", "error"]).optional(),
    }).strict().optional(),
  }).strict();

const StudioViewportSchema = z.object({
  x: z.number(),
  y: z.number(),
  zoom: z.number().positive(),
}).strict();

const StudioGraphLayoutSchema = z.object({
    positions: z.record(ComponentIdSchema, z.object({ x: z.number(), y: z.number() }).strict()),
    pinned: z.array(ComponentIdSchema).optional(),
    viewport: StudioViewportSchema.optional(),
    direction: z.enum(["RIGHT", "DOWN"]).optional(),
  }).strict();

export const HarnessSpecV02Schema = GraphBodySchema.extend({
  version: z.literal("0.2"),
  subgraphs: z.record(ComponentIdSchema, GraphBodySchema).optional(),
  runtime: AdvancedRuntimeSchema.optional(),
  tests: z.array(HarnessTestCaseV02Schema).optional(),
  studio: z.object({
    positions: z.record(ComponentIdSchema, z.object({ x: z.number(), y: z.number() }).strict()),
    subgraphs: z.record(ComponentIdSchema, z.object({
      positions: z.record(ComponentIdSchema, z.object({ x: z.number(), y: z.number() }).strict()),
    }).strict()).optional(),
  }).strict().optional(),
}).strict();

export const AgentTemplateSchema = z.object({
  description: z.string().min(1).max(2_000),
  capabilities: z.array(z.string().min(1).max(128)).max(32).optional(),
  runner: z.union([
    z.object({ subgraph: ComponentIdSchema }).strict(),
    z.object({
      a2a: z.object({ connection: z.string().min(1).max(128) }).strict(),
    }).strict(),
  ]),
}).strict();

export const TeamLimitsSchema = z.object({
  maxInstances: z.number().int().min(1).max(64).optional(),
  maxDepth: z.number().int().min(1).max(8).optional(),
  maxParallel: z.number().int().min(1).max(16).optional(),
  maxMessages: z.number().int().min(1).max(1_000).optional(),
  maxPlanRevisions: z.number().int().min(1).max(100).optional(),
}).strict();

export const TeamSchema = z.object({
  orchestrator: ComponentIdSchema,
  members: z.array(ComponentIdSchema).min(1).max(32),
  limits: TeamLimitsSchema.optional(),
}).strict();

export const HarnessSpecV03Schema = GraphBodySchema.extend({
  version: z.literal("0.3"),
  subgraphs: z.record(ComponentIdSchema, GraphBodySchema).optional(),
  agentTemplates: z.record(ComponentIdSchema, AgentTemplateSchema).optional(),
  teams: z.record(ComponentIdSchema, TeamSchema).optional(),
  runtime: AdvancedRuntimeSchema.optional(),
  tests: z.array(HarnessTestCaseV02Schema).optional(),
  studio: StudioGraphLayoutSchema.extend({
    subgraphs: z.record(ComponentIdSchema, StudioGraphLayoutSchema).optional(),
  }).strict().optional(),
}).strict();

export const HarnessSpecSchema = z.discriminatedUnion("version", [
  HarnessSpecV01Schema,
  HarnessSpecV02Schema,
  HarnessSpecV03Schema,
]);

export type ModelComponent = z.infer<typeof ModelComponentSchema>;
export type PromptComponent = z.infer<typeof PromptComponentSchema>;
export type AgentComponent = z.infer<typeof AgentComponentSchema>;
export type OutputComponent = z.infer<typeof OutputComponentSchema>;
export type LegacyComponentSpec = z.infer<typeof ComponentSchema>;
export type ComponentSpec = z.infer<typeof V02ComponentSchema>;
export type ConnectionSpec = z.infer<typeof V02ConnectionSchema>;
export type PredicateSpec = z.infer<typeof PredicateSchema>;
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;
export type ComponentPolicy = z.infer<typeof ComponentPolicySchema>;
export type HarnessAssertion = z.infer<typeof HarnessAssertionSchema>;
export type HarnessTestCaseV01 = z.infer<typeof HarnessTestCaseSchema>;
export type HarnessTestCaseV02 = z.infer<typeof HarnessTestCaseV02Schema>;
export type HarnessTestCase = HarnessTestCaseV01 | HarnessTestCaseV02;
export type GraphBody = z.infer<typeof GraphBodySchema>;
export type HarnessSpecV01 = z.infer<typeof HarnessSpecV01Schema>;
export type HarnessSpecV02 = z.infer<typeof HarnessSpecV02Schema>;
export type HarnessSpecV03 = z.infer<typeof HarnessSpecV03Schema>;
export type AgentTemplateSpec = z.infer<typeof AgentTemplateSchema>;
export type TeamSpec = z.infer<typeof TeamSchema>;
export type TeamLimits = z.infer<typeof TeamLimitsSchema>;
export type HarnessSpec = z.infer<typeof HarnessSpecSchema>;
export type ComponentType = string;

export type ParseResult =
  | { ok: true; spec: HarnessSpec; diagnostics: [] }
  | { ok: false; diagnostics: Diagnostic[] };

export interface ValidationResult {
  ok: boolean;
  diagnostics: Diagnostic[];
}

export class DiagnosticError extends Error {
  readonly diagnostics: Diagnostic[];

  constructor(message: string, diagnostics: Diagnostic[]) {
    super(message);
    this.name = "DiagnosticError";
    this.diagnostics = diagnostics;
  }
}

const pathString = (path: PropertyKey[]): string => path.reduce<string>(
  (result, part) => typeof part === "number" ? `${result}[${part}]` : `${result}.${String(part)}`,
  "$",
);

export function diagnosticsFromZod(error: z.ZodError, candidate?: unknown): Diagnostic[] {
  return error.issues.map((issue) => {
    const index = issue.path[0] === "components" && typeof issue.path[1] === "number"
      ? issue.path[1]
      : undefined;
    const components = candidate && typeof candidate === "object"
      ? (candidate as { components?: unknown }).components
      : undefined;
    const component = index !== undefined && Array.isArray(components) ? components[index] : undefined;
    const componentId = component && typeof component === "object" && "id" in component
      && typeof component.id === "string" ? component.id : undefined;

    return {
      code: "SPEC_SCHEMA",
      path: pathString(issue.path),
      message: issue.message,
      ...(componentId === undefined ? {} : { componentId }),
      severity: "error" as const,
    };
  });
}

export function parseSpec(text: string): ParseResult {
  const document = parseDocument(text, {
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
    version: "1.2",
  });

  if (document.errors.length > 0) {
    return {
      ok: false,
      diagnostics: document.errors.map((error) => ({
        code: error.code === "DUPLICATE_KEY" ? "YAML_DUPLICATE_KEY" : "YAML_PARSE",
        path: "$",
        message: error.message,
        severity: "error",
      })),
    };
  }

  let candidate: unknown;
  try {
    candidate = document.toJS({ maxAliasCount: 100 });
  } catch (error) {
    return {
      ok: false,
      diagnostics: [{
        code: "YAML_ALIAS_LIMIT",
        path: "$",
        message: error instanceof Error ? error.message : "Could not materialize YAML document",
        severity: "error",
      }],
    };
  }

  const parsed = HarnessSpecSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, diagnostics: diagnosticsFromZod(parsed.error, candidate) };
  return { ok: true, spec: parsed.data, diagnostics: [] };
}

export function stringifySpec(spec: HarnessSpec): string {
  return stringify(spec, { aliasDuplicateObjects: false, lineWidth: 0 });
}
