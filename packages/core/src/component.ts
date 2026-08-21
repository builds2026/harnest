import { Ajv2020 } from "ajv/dist/2020.js";
import type {
  AdapterRegistry,
  FinishReason,
  ModelEvent,
  ModelMessage,
  ModelRequest,
  TokenUsage,
} from "./adapter.js";
import type {
  ComponentSpec,
  Diagnostic,
  GraphBody,
  PredicateSpec,
} from "./spec.js";
import type { ToolRegistry } from "./tool.js";

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
  resolveSecret(reference: string): string | undefined;
}

export interface ServiceResult {
  readonly value: unknown;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly state?: Readonly<Record<string, unknown>>;
}

export interface RuntimeServices {
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
}

export type ComponentEvent =
  | { type: "text-delta"; text: string }
  | { type: "usage"; usage: TokenUsage; costUsd?: number }
  | { type: "context-use"; source: string; metadata?: Readonly<Record<string, unknown>> }
  | { type: "tool-call"; tool: string; input: unknown }
  | { type: "tool-result"; tool: string; ok: boolean; output?: unknown; error?: string; durationMs: number }
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
  readonly runInput: unknown;
  readonly state: Readonly<Record<string, unknown>>;
  readonly adapters: AdapterRegistry;
  readonly tools: ToolRegistry;
  readonly services: RuntimeServices;
  readonly metrics: RuntimeMetrics;
  readonly responseSchema?: Readonly<Record<string, unknown>>;
  resolveSecret(reference: string): string | undefined;
  emit(event: ComponentEvent): void;
  runSubgraph(name: string, input: unknown, options?: SubgraphRunOptions): Promise<ComponentExecutionResult>;
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

export const SAFE_REGEX_MAX_PATTERN_LENGTH = 256;
export const SAFE_REGEX_MAX_INPUT_LENGTH = 4_096;

export interface SafeRegexIssue {
  readonly code: "REGEX_INVALID" | "REGEX_UNSAFE";
  readonly message: string;
}

/**
 * Harnest intentionally supports a small, synchronous-safe RegExp subset.
 * It excludes grouping and multiple quantifiers, which are the common source
 * of exponential backtracking, while retaining simple anchored patterns.
 */
export function inspectSafeRegex(pattern: string): SafeRegexIssue | undefined {
  if (pattern.length > SAFE_REGEX_MAX_PATTERN_LENGTH) return {
    code: "REGEX_UNSAFE",
    message: `Regular expressions are limited to ${SAFE_REGEX_MAX_PATTERN_LENGTH} characters`,
  };

  let escaped = false;
  let inCharacterClass = false;
  let quantifiers = 0;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (escaped) {
      if ((character !== undefined && /[0-9]/.test(character))
        || (character === "k" && pattern[index + 1] === "<")) return {
        code: "REGEX_UNSAFE",
        message: "Regular expression backreferences are not supported",
      };
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (inCharacterClass) {
      if (character === "]") inCharacterClass = false;
      continue;
    }
    if (character === "[") {
      inCharacterClass = true;
      continue;
    }
    if (character === "(" || character === ")") return {
      code: "REGEX_UNSAFE",
      message: "Regular expression groups and lookarounds are not supported",
    };
    if (character === "*" || character === "+" || character === "?") {
      quantifiers += 1;
      continue;
    }
    if (character === "{") {
      const repetition = /^\{([0-9]+)(?:,([0-9]*))?\}/.exec(pattern.slice(index));
      if (!repetition) return {
        code: "REGEX_UNSAFE",
        message: "Unescaped braces are only supported as bounded quantifiers",
      };
      const lower = Number(repetition[1]);
      const upper = repetition[2] === undefined || repetition[2] === "" ? lower : Number(repetition[2]);
      if (lower > SAFE_REGEX_MAX_INPUT_LENGTH || upper > SAFE_REGEX_MAX_INPUT_LENGTH) return {
        code: "REGEX_UNSAFE",
        message: `Regular expression repetitions are limited to ${SAFE_REGEX_MAX_INPUT_LENGTH}`,
      };
      quantifiers += 1;
      index += repetition[0].length - 1;
      continue;
    }
    if (character === "}") return {
      code: "REGEX_UNSAFE",
      message: "Unescaped braces are only supported as bounded quantifiers",
    };
  }

  if (quantifiers > 1) return {
    code: "REGEX_UNSAFE",
    message: "Regular expressions may contain at most one quantifier",
  };
  try {
    new RegExp(pattern);
  } catch {
    return { code: "REGEX_INVALID", message: "Regular expression syntax is invalid" };
  }
  return undefined;
}

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

const asText = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

const mergedUsage = (current: TokenUsage, next: TokenUsage): TokenUsage => {
  const usage = { ...current, ...next };
  if (usage.totalTokens === undefined && usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
    usage.totalTokens = usage.inputTokens + usage.outputTokens;
  }
  return usage;
};

const sumUsage = (current: TokenUsage, next: TokenUsage): TokenUsage => ({
  inputTokens: (current.inputTokens ?? 0) + (next.inputTokens ?? 0),
  outputTokens: (current.outputTokens ?? 0) + (next.outputTokens ?? 0),
  totalTokens: (current.totalTokens ?? 0) + (next.totalTokens ?? 0),
});

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

const costFor = (usage: TokenUsage, model: Record<string, unknown>): number =>
  (usage.inputTokens ?? 0) * (typeof model.inputCostPerMillion === "number" ? model.inputCostPerMillion : 0) / 1_000_000
  + (usage.outputTokens ?? 0) * (typeof model.outputCostPerMillion === "number" ? model.outputCostPerMillion : 0) / 1_000_000;

const serviceContext = (context: ComponentExecutionContext): ServiceExecutionContext => ({
  signal: context.signal,
  runId: context.runId,
  nodeId: context.nodeId,
  iteration: context.iteration,
  resolveSecret: context.resolveSecret,
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

const agentExecutor: ComponentExecutor = async (component, inputs, context) => {
  const model = asRecord(inputs.model);
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
  const contextText = values(inputs.context).map(asText).filter(Boolean).join("\n\n");
  const memoryText = values(inputs.memory).map(asText).filter(Boolean).join("\n\n");
  const toolResults = values(inputs.toolResults).map(asText).filter(Boolean).join("\n\n");
  const enriched = [
    rendered,
    contextText ? `Context:\n${contextText}` : "",
    memoryText ? `Memory:\n${memoryText}` : "",
    toolResults ? `Connected tool results:\n${toolResults}` : "",
  ].filter(Boolean).join("\n\n");
  const messages: ModelMessage[] = [
    ...(typeof component.config.system === "string"
      ? [{ role: "system" as const, content: component.config.system }]
      : []),
    { role: "user", content: enriched },
  ];
  if (context.responseSchema) messages.unshift({
    role: "system",
    content: `Return only JSON matching this JSON Schema: ${JSON.stringify(context.responseSchema)}`,
  });
  const request: ModelRequest = {
    model: model.model,
    messages,
    ...(typeof model.baseUrl === "string" ? { baseUrl: model.baseUrl } : {}),
    ...(typeof model.apiKey === "string" ? { apiKey: model.apiKey } : {}),
    ...(typeof model.temperature === "number" ? { temperature: model.temperature } : {}),
    ...(typeof model.maxTokens === "number" ? { maxTokens: model.maxTokens } : {}),
    ...(context.responseSchema ? { responseSchema: context.responseSchema } : {}),
  };
  const iterator = context.adapters.get(model.adapter).run(request, {
    signal: context.signal,
    resolveSecret: context.resolveSecret,
  })[Symbol.asyncIterator]();
  let text = "";
  let usage: TokenUsage = {};
  let finishReason: FinishReason = "unknown";
  let finished = false;
  try {
    while (true) {
      const result = await nextWithSignal<ModelEvent>(iterator, context.signal);
      if (result.done) break;
      if (result.value.type === "text-delta") {
        text += result.value.text;
        context.emit({ type: "text-delta", text: result.value.text });
      } else if (result.value.type === "usage") {
        usage = mergedUsage(usage, result.value.usage);
        context.emit({ type: "usage", usage, costUsd: costFor(usage, model) });
      } else {
        finishReason = result.value.reason;
        finished = true;
      }
    }
  } finally {
    if (iterator.return) void iterator.return().catch(() => undefined);
  }
  if (!finished) throw new ComponentExecutionError("ADAPTER_STREAM_INCOMPLETE", "Adapter stream ended without a finish event");
  if (finishReason === "error") throw new ComponentExecutionError("MODEL_FINISH_ERROR", "Model stopped with an error");
  return {
    outputs: { response: text },
    usage,
    usageKnown: usage.totalTokens !== undefined
      || (usage.inputTokens !== undefined && usage.outputTokens !== undefined),
    costUsd: costFor(usage, model),
    costKnown: typeof model.inputCostPerMillion === "number"
      && typeof model.outputCostPerMillion === "number"
      && usage.inputTokens !== undefined
      && usage.outputTokens !== undefined,
    finishReason,
  };
};

const outputExecutor: ComponentExecutor = (component, inputs) => {
  let value = inputs.value;
  const schema = asRecord(component.config.schema);
  if (component.config.format === "json" || schema) {
    if (typeof value === "string") {
      try {
        value = JSON.parse(value) as unknown;
      } catch (cause) {
        throw new ComponentExecutionError("OUTPUT_JSON_INVALID", "Model output is not valid JSON", { cause });
      }
    }
  }
  if (schema) {
    const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
    if (!validate(value)) {
      throw new ComponentExecutionError(
        "OUTPUT_SCHEMA_INVALID",
        `Output does not match the JSON Schema: ${new Ajv2020().errorsText(validate.errors)}`,
      );
    }
  }
  return { outputs: { value } };
};

const contextExecutor: ComponentExecutor = async (component, _inputs, context) => {
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

const localToolExecutor: ComponentExecutor = async (component, inputs, context) => {
  const toolId = component.config.tool;
  if (typeof toolId !== "string") throw new ComponentExecutionError("TOOL_INVALID", "Local Tool requires config.tool");
  const tool = context.tools.get(toolId);
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(tool.inputSchema);
  const toolInput = inputs.arguments ?? context.runInput;
  if (!validate(toolInput)) {
    throw new ComponentExecutionError("TOOL_INPUT_INVALID", `Tool input is invalid: ${new Ajv2020().errorsText(validate.errors)}`);
  }
  const started = performance.now();
  context.emit({ type: "tool-call", tool: tool.id, input: toolInput });
  try {
    const output = await tool.execute(toolInput, serviceContext(context));
    context.emit({ type: "tool-result", tool: tool.id, ok: true, output, durationMs: performance.now() - started });
    return { outputs: { result: output } };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Tool call failed";
    context.emit({ type: "tool-result", tool: tool.id, ok: false, error: message, durationMs: performance.now() - started });
    throw new ComponentExecutionError("TOOL_CALL_FAILED", message, { cause });
  }
};

const mcpToolExecutor: ComponentExecutor = async (component, inputs, context) => {
  if (!context.services.callMcpTool) {
    throw new ComponentExecutionError("MCP_SERVICE_UNAVAILABLE", "This runtime does not provide MCP Tool execution");
  }
  const tool = typeof component.config.tool === "string" ? component.config.tool : "unknown";
  const toolInput = inputs.arguments ?? context.runInput;
  const started = performance.now();
  context.emit({ type: "tool-call", tool, input: toolInput });
  try {
    const result = await context.services.callMcpTool(component.config, toolInput, serviceContext(context));
    context.emit({ type: "tool-result", tool, ok: true, output: result.value, durationMs: performance.now() - started });
    return {
      outputs: { result: result.value },
      ...(result.state ? { state: result.state } : {}),
      traceOutput: result.metadata ?? { tool, ok: true },
    };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "MCP Tool call failed";
    context.emit({ type: "tool-result", tool, ok: false, error: message, durationMs: performance.now() - started });
    throw new ComponentExecutionError("MCP_TOOL_CALL_FAILED", message, { cause });
  }
};

const routerExecutor: ComponentExecutor = (component, inputs, context) => {
  const predicate = component.config.condition as PredicateSpec;
  const matched = evaluatePredicate(predicate, inputs.value, context.state, context.runInput);
  return { outputs: { [matched ? "true" : "false"]: inputs.value }, traceOutput: { branch: matched ? "true" : "false" } };
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
    else passed = Boolean(new Ajv2020({ strict: false }).compile(schema)(value));
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

const loopExecutor: ComponentExecutor = async (component, inputs, context) => {
  const name = component.config.subgraph;
  const maxIterations = component.config.maxIterations;
  if (typeof name !== "string" || typeof maxIterations !== "number") {
    throw new ComponentExecutionError("LOOP_INVALID", "Loop requires subgraph and maxIterations");
  }
  const timeout = typeof component.config.timeoutMs === "number" ? AbortSignal.timeout(component.config.timeoutMs) : undefined;
  const signal = timeout ? AbortSignal.any([context.signal, timeout]) : context.signal;
  let value = inputs.value ?? context.runInput;
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
    value = result.outputs.value;
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
  if (component.config.transport === "stdio"
    && (typeof component.config.command !== "string" || component.config.command.length === 0)) {
    diagnostics.push(componentDiagnostic("MCP_COMMAND_REQUIRED", `${context.path}.config.command`, "stdio MCP requires a command", component.id));
  }
  if (component.config.transport === "http") {
    if (typeof component.config.url !== "string" || component.config.url.length === 0) {
      diagnostics.push(componentDiagnostic("MCP_URL_REQUIRED", `${context.path}.config.url`, "HTTP MCP requires a URL", component.id));
    } else {
      try {
        const url = new URL(component.config.url);
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocol");
      } catch {
        diagnostics.push(componentDiagnostic("MCP_URL_INVALID", `${context.path}.config.url`, "MCP URL must use http or https", component.id));
      }
    }
  }
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
      adapter: { type: "string", minLength: 1 }, model: { type: "string", minLength: 1 }, apiKey: { type: "string" },
      baseUrl: { type: "string", format: "uri" }, temperature: { type: "number", minimum: 0, maximum: 2 },
      maxTokens: { type: "integer", minimum: 1 }, inputCostPerMillion: { type: "number", minimum: 0 },
      outputCostPerMillion: { type: "number", minimum: 0 },
    }, ["adapter", "model"]),
    inspector: [
      { path: "adapter", label: "Adapter", control: "text", required: true },
      { path: "model", label: "Model", control: "text", required: true },
      { path: "apiKey", label: "API key reference", control: "text" },
      { path: "temperature", label: "Temperature", control: "number" },
      { path: "maxTokens", label: "Max tokens", control: "number" },
      { path: "inputCostPerMillion", label: "Input $ / 1M", control: "number" },
      { path: "outputCostPerMillion", label: "Output $ / 1M", control: "number" },
    ],
    defaultConfig: { adapter: "ollama", model: "llama3.2" }, retrySafe: true, execute: modelExecutor,
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
        toolResults: { type: "any", variadic: true },
      },
      outputs: { response: { type: "text" } },
    },
    configSchema: objectSchema({ system: { type: "string" }, timeoutMs: { type: "integer", minimum: 1, maximum: 600000 } }),
    inspector: [
      { path: "system", label: "System prompt", control: "textarea" },
      { path: "timeoutMs", label: "Timeout (ms)", control: "number" },
    ],
    defaultConfig: {}, retrySafe: true,
    traceInputs: (inputs) => ({
      model: asRecord(inputs.model) ? { adapter: asRecord(inputs.model)?.adapter, model: asRecord(inputs.model)?.model } : undefined,
      prompt: inputs.prompt,
      contextCount: values(inputs.context).length,
      memoryConnected: inputs.memory !== undefined,
      toolResultCount: values(inputs.toolResults).length,
    }),
    execute: agentExecutor,
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
      source: { enum: ["text", "file", "directory"] }, text: { type: "string" }, path: { type: "string" },
      pattern: { type: "string" }, topK: { type: "integer", minimum: 1, maximum: 100 },
      maxBytes: { type: "integer", minimum: 1, maximum: 10000000 },
    }, ["source"]),
    inspector: [
      { path: "source", label: "Source", control: "select", required: true, options: [
        { label: "Static text", value: "text" }, { label: "File", value: "file" }, { label: "Directory", value: "directory" },
      ] },
      { path: "text", label: "Text", control: "textarea" }, { path: "path", label: "Path", control: "text" },
      { path: "pattern", label: "File pattern", control: "text" }, { path: "topK", label: "Top K", control: "number" },
    ],
    defaultConfig: { source: "text", text: "" }, retrySafe: true, validate: validateContextComponent, execute: contextExecutor,
  },
  {
    type: "memory", label: "Memory", category: "Knowledge", description: "Run or project memory read/write",
    ports: { inputs: { value: { type: "any", maxConnections: 1 } }, outputs: { memory: { type: "memory" } } },
    configSchema: objectSchema({
      key: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_.-]*$" },
      operation: { enum: ["read", "write", "append"] }, initial: {},
    }, ["key", "operation"]),
    inspector: [
      { path: "key", label: "Key", control: "text", required: true },
      { path: "operation", label: "Operation", control: "select", required: true, options: [
        { label: "Read", value: "read" }, { label: "Write", value: "write" }, { label: "Append", value: "append" },
      ] },
      { path: "initial", label: "Initial value", control: "json" },
    ],
    defaultConfig: { key: "conversation", operation: "read" }, execute: memoryExecutor,
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
      transport: { enum: ["stdio", "http"] }, protocol: { enum: ["legacy", "auto", "2026-07-28"] },
      tool: { type: "string", minLength: 1 }, command: { type: "string" }, args: { type: "array", items: { type: "string" } },
      url: { type: "string", format: "uri" }, headers: { type: "object", additionalProperties: { type: "string" } },
      timeoutMs: { type: "integer", minimum: 1, maximum: 600000 },
    }, ["transport", "tool"]),
    inspector: [
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
    type: "loop", label: "Loop", category: "Flow", description: "Runs a subgraph with mandatory bounds",
    ports: { inputs: { value: { type: "any", maxConnections: 1 } }, outputs: { value: { type: "any" } } },
    configSchema: objectSchema({
      subgraph: { type: "string", minLength: 1 }, maxIterations: { type: "integer", minimum: 1, maximum: 1000 },
      until: predicateJsonSchema, timeoutMs: { type: "integer", minimum: 1, maximum: 600000 },
      maxTokens: { type: "integer", minimum: 1 }, maxCostUsd: { type: "number", exclusiveMinimum: 0 },
    }, ["subgraph", "maxIterations"]),
    inspector: [
      { path: "subgraph", label: "Subgraph", control: "text", required: true },
      { path: "maxIterations", label: "Max iterations", control: "number", required: true },
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
