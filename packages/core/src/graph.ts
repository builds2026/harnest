import { Ajv2020 } from "ajv/dist/2020.js";
import type { AdapterRegistry } from "./adapter.js";
import {
  createBuiltinComponentRegistry,
  evaluatePredicate,
  inspectSafeRegex,
  type ComponentPortDefinition,
  type ComponentRegistry,
  type PortDefinition,
} from "./component.js";
import {
  HarnessSpecSchema,
  diagnosticsFromZod,
  type ComponentPolicy,
  type ComponentSpec,
  type ConnectionSpec,
  type Diagnostic,
  type GraphBody,
  type HarnessSpec,
  type PredicateSpec,
  type RetryPolicy,
  type ValidationResult,
} from "./spec.js";
import type { ToolRegistry } from "./tool.js";

export type { ComponentPortDefinition, PortDefinition } from "./component.js";

const builtinRegistry = createBuiltinComponentRegistry();

/** Compatibility export; graph validation itself uses the supplied ComponentRegistry. */
export const PORT_DEFINITIONS: Readonly<Record<string, ComponentPortDefinition>> = Object.fromEntries(
  builtinRegistry.list().map((definition) => [definition.type, definition.ports]),
);

export interface ValidationOptions {
  registry?: AdapterRegistry;
  components?: ComponentRegistry;
  tools?: ToolRegistry;
  env?: Readonly<Record<string, string | undefined>>;
}

const diagnostic = (
  code: string,
  path: string,
  message: string,
  componentId?: string,
  hint?: string,
  severity: "error" | "warning" = "error",
): Diagnostic => ({
  code,
  path,
  message,
  ...(componentId === undefined ? {} : { componentId }),
  ...(hint === undefined ? {} : { hint }),
  severity,
});

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const hasModelPricing = (component: ComponentSpec): boolean => component.type !== "model"
  || (typeof component.config.inputCostPerMillion === "number"
    && typeof component.config.outputCostPerMillion === "number");

function unpricedModelsInSubgraph(
  name: string,
  subgraphs: Readonly<Record<string, GraphBody>>,
  visited = new Set<string>(),
): ComponentSpec[] {
  if (visited.has(name)) return [];
  visited.add(name);
  const body = subgraphs[name];
  if (!body) return [];
  return [
    ...body.components.filter((component) => component.type === "model" && !hasModelPricing(component)),
    ...body.components
      .filter((component) => component.type === "subgraph" || component.type === "loop")
      .flatMap((component) => typeof component.config.subgraph === "string"
        ? unpricedModelsInSubgraph(component.config.subgraph, subgraphs, visited)
        : []),
  ];
}

const endpointKey = (connection: ConnectionSpec): string =>
  `${connection.from.component}.${connection.from.port}>${connection.to.component}.${connection.to.port}`;

const compatible = (output: PortDefinition, input: PortDefinition): boolean =>
  output.type === "any" || input.type === "any" || output.type === input.type;

function cycleComponents(body: GraphBody, extra?: ConnectionSpec): string[] {
  const adjacency = new Map(body.components.map((component) => [component.id, [] as string[]]));
  for (const connection of extra ? [...body.connections, extra] : body.connections) {
    adjacency.get(connection.from.component)?.push(connection.to.component);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  let cycle: string[] = [];

  const visit = (id: string): boolean => {
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      cycle = [...stack.slice(start), id];
      return true;
    }
    if (visited.has(id)) return false;
    visiting.add(id);
    stack.push(id);
    for (const next of adjacency.get(id) ?? []) if (visit(next)) return true;
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return false;
  };

  for (const component of body.components) if (visit(component.id)) break;
  return cycle;
}

function graphLayers(body: GraphBody): string[][] {
  const indegree = new Map(body.components.map((component) => [component.id, 0]));
  const outgoing = new Map(body.components.map((component) => [component.id, [] as string[]]));
  for (const connection of body.connections) {
    indegree.set(connection.to.component, (indegree.get(connection.to.component) ?? 0) + 1);
    outgoing.get(connection.from.component)?.push(connection.to.component);
  }
  let queue = body.components.filter((component) => indegree.get(component.id) === 0).map(({ id }) => id);
  const layers: string[][] = [];
  while (queue.length > 0) {
    const layer = queue;
    layers.push(layer);
    const next: string[] = [];
    for (const id of layer) {
      for (const target of outgoing.get(id) ?? []) {
        const count = (indegree.get(target) ?? 0) - 1;
        indegree.set(target, count);
        if (count === 0) next.push(target);
      }
    }
    queue = next;
  }
  return layers;
}

function normalizeBody(spec: HarnessSpec): GraphBody {
  if (spec.version === "0.2") return {
    components: spec.components,
    connections: spec.connections,
    entrypoint: spec.entrypoint,
  };
  return {
    components: spec.components.map((component) => ({
      id: component.id,
      type: component.type,
      config: component.config as Record<string, unknown>,
    })),
    connections: spec.connections.map((connection) => ({ ...connection })),
    entrypoint: spec.entrypoint,
  };
}

export interface NormalizedHarnessSpec extends GraphBody {
  readonly sourceVersion: "0.1" | "0.2";
  readonly subgraphs: Readonly<Record<string, GraphBody>>;
  readonly runtime: {
    readonly timeoutMs: number;
    readonly adapters: readonly string[];
    readonly modules: readonly string[];
    readonly retry: RetryPolicy;
    readonly budget?: { readonly maxTokens?: number; readonly maxCostUsd?: number };
  };
}

export function normalizeSpec(spec: HarnessSpec): NormalizedHarnessSpec {
  const body = normalizeBody(spec);
  const runtime = spec.runtime;
  const advancedRuntime = spec.version === "0.2" ? spec.runtime : undefined;
  const budget = advancedRuntime?.budget;
  return {
    ...body,
    sourceVersion: spec.version,
    subgraphs: spec.version === "0.2" ? spec.subgraphs ?? {} : {},
    runtime: {
      timeoutMs: runtime?.timeoutMs ?? 30_000,
      adapters: runtime?.adapters ?? [],
      modules: advancedRuntime?.modules ?? [],
      retry: advancedRuntime?.retry ?? { maxAttempts: 1, backoffMs: 0 },
      ...(budget ? {
        budget: {
          ...(budget.maxTokens === undefined ? {} : { maxTokens: budget.maxTokens }),
          ...(budget.maxCostUsd === undefined ? {} : { maxCostUsd: budget.maxCostUsd }),
        },
      } : {}),
    },
  };
}

function validatePredicate(predicate: PredicateSpec, path: string, diagnostics: Diagnostic[]): void {
  if (predicate.op === "matches") {
    if (typeof predicate.value !== "string") {
      diagnostics.push(diagnostic("PREDICATE_VALUE_INVALID", `${path}.value`, "matches requires a string regular expression"));
    } else {
      const issue = inspectSafeRegex(predicate.value);
      if (issue) diagnostics.push(diagnostic(
        issue.code === "REGEX_INVALID" ? "PREDICATE_REGEX_INVALID" : "PREDICATE_REGEX_UNSAFE",
        `${path}.value`,
        issue.message,
      ));
    }
  }
  if (["gt", "gte", "lt", "lte"].includes(predicate.op) && typeof predicate.value !== "number") {
    diagnostics.push(diagnostic("PREDICATE_VALUE_INVALID", `${path}.value`, `${predicate.op} requires a numeric value`));
  }
  // Exercise the total predicate implementation at validation time without evaluating user code.
  if (predicate.op === "exists" || predicate.op === "truthy") evaluatePredicate(predicate, undefined);
}

function validateSchemaRegexes(
  schema: Readonly<Record<string, unknown>>,
  path: string,
  diagnostics: Diagnostic[],
  componentId?: string,
): void {
  const visited = new WeakSet<object>();
  const visit = (value: unknown, currentPath: string): void => {
    if (typeof value !== "object" || value === null || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${currentPath}[${index}]`));
      return;
    }
    const object = value as Readonly<Record<string, unknown>>;
    if (typeof object.pattern === "string") {
      const issue = inspectSafeRegex(object.pattern);
      if (issue) diagnostics.push(diagnostic(
        issue.code === "REGEX_INVALID" ? "SCHEMA_REGEX_INVALID" : "SCHEMA_REGEX_UNSAFE",
        `${currentPath}.pattern`,
        issue.message,
        componentId,
      ));
    }
    const patternProperties = asRecord(object.patternProperties);
    if (patternProperties) for (const pattern of Object.keys(patternProperties)) {
      const issue = inspectSafeRegex(pattern);
      if (issue) diagnostics.push(diagnostic(
        issue.code === "REGEX_INVALID" ? "SCHEMA_REGEX_INVALID" : "SCHEMA_REGEX_UNSAFE",
        `${currentPath}.patternProperties[${JSON.stringify(pattern)}]`,
        issue.message,
        componentId,
      ));
    }
    for (const [key, item] of Object.entries(object)) visit(item, `${currentPath}.${key}`);
  };
  visit(schema, path);
}

function validateConnection(
  connection: ConnectionSpec,
  path: string,
  componentMap: ReadonlyMap<string, ComponentSpec>,
  components: ComponentRegistry,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const source = componentMap.get(connection.from.component);
  const target = componentMap.get(connection.to.component);

  if (!source) diagnostics.push(diagnostic(
    "CONNECTION_SOURCE_MISSING",
    `${path}.from.component`,
    `Component '${connection.from.component}' does not exist`,
    connection.from.component,
  ));
  if (!target) diagnostics.push(diagnostic(
    "CONNECTION_TARGET_MISSING",
    `${path}.to.component`,
    `Component '${connection.to.component}' does not exist`,
    connection.to.component,
  ));
  if (!source || !target) return diagnostics;
  if (!components.has(source.type) || !components.has(target.type)) return diagnostics;

  const output = components.portsFor(source).outputs[connection.from.port];
  const input = components.portsFor(target).inputs[connection.to.port];
  if (!output) diagnostics.push(diagnostic(
    "PORT_SOURCE_MISSING",
    `${path}.from.port`,
    `'${source.id}' has no output port '${connection.from.port}'`,
    source.id,
  ));
  if (!input) diagnostics.push(diagnostic(
    "PORT_TARGET_MISSING",
    `${path}.to.port`,
    `'${target.id}' has no input port '${connection.to.port}'`,
    target.id,
  ));
  if (output && input && !compatible(output, input)) diagnostics.push(diagnostic(
    "PORT_TYPE_MISMATCH",
    path,
    `Cannot connect ${output.type} to ${input.type}`,
    target.id,
  ));
  if (connection.condition) validatePredicate(connection.condition, `${path}.condition`, diagnostics);
  if (connection.state && ["__proto__", "prototype", "constructor"].includes(connection.state.key)) {
    diagnostics.push(diagnostic("STATE_KEY_UNSAFE", `${path}.state.key`, "This state key is reserved", target.id));
  }
  return diagnostics;
}

function reachableToEntrypoint(body: GraphBody): Set<string> {
  const incoming = new Map(body.components.map((component) => [component.id, [] as string[]]));
  for (const connection of body.connections) incoming.get(connection.to.component)?.push(connection.from.component);
  const reachable = new Set<string>();
  const visit = (id: string) => {
    if (reachable.has(id)) return;
    reachable.add(id);
    for (const previous of incoming.get(id) ?? []) visit(previous);
  };
  visit(body.entrypoint);
  return reachable;
}

function validateGraphBody(
  body: GraphBody,
  path: string,
  options: Required<Pick<ValidationOptions, "components">> & ValidationOptions,
  subgraphs: Readonly<Record<string, GraphBody>>,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const componentMap = new Map<string, ComponentSpec>();
  const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });

  body.components.forEach((component, index) => {
    const componentPath = `${path}.components[${index}]`;
    if (componentMap.has(component.id)) diagnostics.push(diagnostic(
      "COMPONENT_ID_DUPLICATE",
      `${componentPath}.id`,
      `Component id '${component.id}' is duplicated`,
      component.id,
    ));
    else componentMap.set(component.id, component);

    if (!options.components.has(component.type)) {
      diagnostics.push(diagnostic(
        "COMPONENT_NOT_REGISTERED",
        `${componentPath}.type`,
        `Component '${component.type}' is not registered`,
        component.id,
        "Install its runtime module or choose a registered component",
      ));
      return;
    }
    const definition = options.components.get(component.type);
    const validate = ajv.compile(definition.configSchema);
    if (!validate(component.config)) diagnostics.push(diagnostic(
      "COMPONENT_CONFIG_INVALID",
      `${componentPath}.config`,
      ajv.errorsText(validate.errors),
      component.id,
    ));
    diagnostics.push(...definition.validate?.(component, { path: componentPath, subgraphs }) ?? []);
    const embeddedPredicate = component.type === "router"
      ? asRecord(component.config.condition)
      : component.type === "loop"
        ? asRecord(component.config.until)
        : undefined;
    if (embeddedPredicate) validatePredicate(
      embeddedPredicate as unknown as PredicateSpec,
      `${componentPath}.config.${component.type === "router" ? "condition" : "until"}`,
      diagnostics,
    );
    if (component.policy?.retry && component.policy.retry.maxBackoffMs !== undefined
      && component.policy.retry.backoffMs !== undefined
      && component.policy.retry.maxBackoffMs < component.policy.retry.backoffMs) {
      diagnostics.push(diagnostic(
        "RETRY_BACKOFF_INVALID",
        `${componentPath}.policy.retry.maxBackoffMs`,
        "maxBackoffMs must be at least backoffMs",
        component.id,
      ));
    }

    if (component.type === "model") {
      const adapter = component.config.adapter;
      if (typeof adapter === "string" && options.registry && !options.registry.has(adapter)) diagnostics.push(diagnostic(
        "ADAPTER_NOT_REGISTERED",
        `${componentPath}.config.adapter`,
        `Adapter '${adapter}' is not registered`,
        component.id,
        "Install and list its module under runtime.adapters, or register it through the SDK",
      ));
      const reference = component.config.apiKey;
      if (reference !== undefined) {
        if (typeof reference !== "string" || !/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(reference)) diagnostics.push(diagnostic(
          "SECRET_LITERAL",
          `${componentPath}.config.apiKey`,
          "apiKey must be an env:NAME reference, not a literal secret",
          component.id,
        ));
        else if (options.env && !options.env[reference.slice(4)]) diagnostics.push(diagnostic(
          "ENV_MISSING",
          `${componentPath}.config.apiKey`,
          `Environment variable '${reference.slice(4)}' is not set`,
          component.id,
        ));
      }
      if (reference === undefined && typeof adapter === "string" && options.env && options.registry?.has(adapter)) {
        for (const required of options.registry.get(adapter).requiredCredentials ?? []) {
          if (/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(required) && !options.env[required.slice(4)]) diagnostics.push(diagnostic(
            "ENV_MISSING",
            `${componentPath}.config.apiKey`,
            `Environment variable '${required.slice(4)}' is not set`,
            component.id,
          ));
        }
      }
    }
    if (component.type === "output" || (component.type === "evaluator" && component.config.type === "output-schema")) {
      const schema = asRecord(component.config.schema);
      if (schema) {
        validateSchemaRegexes(schema, `${componentPath}.config.schema`, diagnostics, component.id);
        try {
          if (!ajv.validateSchema(schema)) diagnostics.push(diagnostic(
            "OUTPUT_SCHEMA_DEFINITION_INVALID",
            `${componentPath}.config.schema`,
            `Invalid JSON Schema: ${ajv.errorsText(ajv.errors)}`,
            component.id,
          ));
        } catch (error) {
          diagnostics.push(diagnostic(
            "OUTPUT_SCHEMA_DEFINITION_INVALID",
            `${componentPath}.config.schema`,
            error instanceof Error ? error.message : "Invalid JSON Schema",
            component.id,
          ));
        }
      }
    }
    if ((component.type === "subgraph" || component.type === "loop")
      && (typeof component.config.subgraph !== "string" || !subgraphs[component.config.subgraph])) {
      diagnostics.push(diagnostic(
        "SUBGRAPH_NOT_FOUND",
        `${componentPath}.config.subgraph`,
        `Subgraph '${String(component.config.subgraph ?? "")}' does not exist`,
        component.id,
      ));
    }
    if (component.type === "loop" && typeof component.config.maxCostUsd === "number"
      && typeof component.config.subgraph === "string") {
      const unpriced = unpricedModelsInSubgraph(component.config.subgraph, subgraphs);
      if (unpriced.length > 0) diagnostics.push(diagnostic(
        "MODEL_PRICING_REQUIRED",
        `${componentPath}.config.maxCostUsd`,
        `Cost-limited loop references unpriced model(s): ${unpriced.map(({ id }) => id).join(", ")}`,
        component.id,
      ));
    }
    if ((component.type === "local-tool" || component.type === "tool") && typeof component.config.tool === "string"
      && typeof component.config.connectionId !== "string" && options.tools && !options.tools.has(component.config.tool)) {
      diagnostics.push(diagnostic(
        "TOOL_NOT_REGISTERED",
        `${componentPath}.config.tool`,
        `Tool '${component.config.tool}' is not registered`,
        component.id,
      ));
    }
    if ((component.type === "local-tool" || component.type === "tool") && typeof component.config.tool === "string"
      && options.tools?.has(component.config.tool)) validateSchemaRegexes(
      options.tools.get(component.config.tool).inputSchema,
      `${componentPath}.config.tool.inputSchema`,
      diagnostics,
      component.id,
    );
    if (component.type === "tool" && typeof component.config.tool === "string"
      && options.tools?.has(component.config.tool)
      && (options.tools.get(component.config.tool).connectionKinds?.length ?? 0) > 0
      && (typeof component.config.connectionId !== "string" || component.config.connectionId.length === 0)) {
      diagnostics.push(diagnostic(
        "TOOL_CONNECTION_REQUIRED",
        `${componentPath}.config.connectionId`,
        `Tool '${component.config.tool}' requires a compatible Connection`,
        component.id,
      ));
    }
    if (component.type === "local-tool" && typeof component.config.tool === "string"
      && options.tools?.has(component.config.tool)
      && (options.tools.get(component.config.tool).connectionKinds?.length ?? 0) > 0) {
      diagnostics.push(diagnostic(
        "TOOL_COMPONENT_REQUIRED",
        `${componentPath}.type`,
        `Tool '${component.config.tool}' requires a Connection and cannot use the legacy local-tool component`,
        component.id,
      ));
    }
    if (component.type === "tool") {
      for (const field of ["inputSchema", "outputSchema"] as const) {
        const schema = asRecord(component.config[field]);
        if (schema) validateSchemaRegexes(
          schema,
          `${componentPath}.config.${field}`,
          diagnostics,
          component.id,
        );
      }
    }
  });

  const connectionIds = new Set<string>();
  const endpoints = new Set<string>();
  body.connections.forEach((connection, index) => {
    const connectionPath = `${path}.connections[${index}]`;
    diagnostics.push(...validateConnection(connection, connectionPath, componentMap, options.components));
    if (connection.id !== undefined) {
      if (connectionIds.has(connection.id)) diagnostics.push(diagnostic(
        "CONNECTION_ID_DUPLICATE", `${connectionPath}.id`, `Connection id '${connection.id}' is duplicated`,
      ));
      connectionIds.add(connection.id);
    }
    const key = endpointKey(connection);
    if (endpoints.has(key)) diagnostics.push(diagnostic("CONNECTION_DUPLICATE", connectionPath, "Duplicate connection", connection.to.component));
    endpoints.add(key);
  });

  for (const component of body.components) {
    if (!options.components.has(component.type)) continue;
    const inputs = options.components.portsFor(component).inputs;
    for (const [port, definition] of Object.entries(inputs)) {
      const count = body.connections.filter((connection) => connection.to.component === component.id && connection.to.port === port).length;
      if (definition.required && count === 0) diagnostics.push(diagnostic(
        "PORT_REQUIRED", `${path}.components[${body.components.indexOf(component)}]`, `Required input '${component.id}.${port}' is not connected`, component.id,
      ));
      const max = definition.maxConnections ?? (definition.variadic ? Number.POSITIVE_INFINITY : 1);
      if (count > max) diagnostics.push(diagnostic(
        "PORT_FAN_IN_EXCEEDED", `${path}.connections`, `'${component.id}.${port}' accepts at most ${max} connection(s)`, component.id,
      ));
      if (definition.required && body.connections.some((connection) => connection.to.component === component.id
        && connection.to.port === port && connection.condition !== undefined)) {
        diagnostics.push(diagnostic(
          "PORT_CONDITIONAL",
          `${path}.connections`,
          `Required input '${component.id}.${port}' can be inactive; the node will be skipped on that branch`,
          component.id,
          undefined,
          "warning",
        ));
      }
    }
    if (component.type === "join") {
      const incoming = body.connections.filter((connection) => connection.to.component === component.id && connection.to.port === "values");
      if (incoming.length < 2) diagnostics.push(diagnostic(
        "JOIN_INPUTS_INSUFFICIENT", `${path}.components[${body.components.indexOf(component)}]`, "Join requires at least two incoming values", component.id,
      ));
      if (component.config.mode === "object" && Array.isArray(component.config.keys)
        && component.config.keys.length !== incoming.length) diagnostics.push(diagnostic(
          "JOIN_KEYS_MISMATCH", `${path}.components[${body.components.indexOf(component)}].config.keys`, "Object join keys must match the number of incoming values", component.id,
      ));
    }
  }

  const entrypoint = componentMap.get(body.entrypoint);
  if (!entrypoint) diagnostics.push(diagnostic(
    "ENTRYPOINT_MISSING", `${path}.entrypoint`, `Entrypoint '${body.entrypoint}' does not exist`, body.entrypoint,
  ));
  else if (body.connections.some((connection) => connection.from.component === entrypoint.id)) diagnostics.push(diagnostic(
    "ENTRYPOINT_NOT_TERMINAL", `${path}.entrypoint`, `Entrypoint '${entrypoint.id}' has an outgoing connection`, entrypoint.id,
  ));

  const cycle = cycleComponents(body);
  if (cycle.length > 0) diagnostics.push(diagnostic(
    "GRAPH_CYCLE", `${path}.connections`, `Graph contains a cycle: ${cycle.join(" -> ")}. Use a bounded Loop component for repetition.`, cycle[0],
  ));

  if (entrypoint) {
    const reachable = reachableToEntrypoint(body);
    for (const component of body.components) if (!reachable.has(component.id)) diagnostics.push(diagnostic(
      "GRAPH_UNREACHABLE",
      `${path}.components[${body.components.indexOf(component)}]`,
      `Component '${component.id}' cannot reach entrypoint '${body.entrypoint}'`,
      component.id,
    ));
  }

  if (cycle.length === 0) {
    const layerByNode = new Map(graphLayers(body).flatMap((layer, index) => layer.map((id) => [id, index] as const)));
    const writers = new Map<string, ConnectionSpec[]>();
    for (const connection of body.connections) {
      if (!connection.state || (connection.state.merge ?? "replace") !== "replace") continue;
      const key = `${layerByNode.get(connection.to.component) ?? -1}:${connection.state.key}`;
      const values = writers.get(key) ?? [];
      values.push(connection);
      writers.set(key, values);
    }
    for (const connections of writers.values()) if (connections.length > 1) diagnostics.push(diagnostic(
      "STATE_WRITE_CONFLICT",
      `${path}.connections`,
      `Parallel edges replace state '${connections[0]?.state?.key}'; use merge: append or distinct keys`,
      connections[0]?.to.component,
    ));
  }

  return diagnostics;
}

function validateSubgraphReferences(subgraphs: Readonly<Record<string, GraphBody>>): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const adjacency = new Map<string, string[]>();
  for (const [name, body] of Object.entries(subgraphs)) adjacency.set(name, body.components
    .filter((component) => component.type === "subgraph" || component.type === "loop")
    .map((component) => component.config.subgraph)
    .filter((value): value is string => typeof value === "string" && value in subgraphs));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const visit = (name: string): void => {
    if (visiting.has(name)) {
      const start = stack.indexOf(name);
      diagnostics.push(diagnostic(
        "SUBGRAPH_RECURSION", `$.subgraphs.${name}`, `Subgraph recursion is not allowed: ${[...stack.slice(start), name].join(" -> ")}`,
      ));
      return;
    }
    if (visited.has(name)) return;
    visiting.add(name);
    stack.push(name);
    for (const target of adjacency.get(name) ?? []) visit(target);
    stack.pop();
    visiting.delete(name);
    visited.add(name);
  };
  for (const name of Object.keys(subgraphs)) visit(name);
  return diagnostics;
}

export function validateCandidateConnection(
  spec: HarnessSpec,
  connection: ConnectionSpec,
  options: ValidationOptions = {},
): ValidationResult {
  const normalized = normalizeSpec(spec);
  const components = options.components ?? createBuiltinComponentRegistry();
  const componentMap = new Map(normalized.components.map((component) => [component.id, component]));
  const diagnostics = validateConnection(connection, "$.connections[candidate]", componentMap, components);
  if (normalized.connections.some((existing) => endpointKey(existing) === endpointKey(connection))) diagnostics.push(diagnostic(
    "CONNECTION_DUPLICATE", "$.connections[candidate]", "This connection already exists", connection.to.component,
  ));
  const target = componentMap.get(connection.to.component);
  if (target && components.has(target.type)) {
    const input = components.portsFor(target).inputs[connection.to.port];
    const count = normalized.connections.filter((existing) => existing.to.component === connection.to.component
      && existing.to.port === connection.to.port).length;
    const max = input?.maxConnections ?? (input?.variadic ? Number.POSITIVE_INFINITY : 1);
    if (input && count >= max) diagnostics.push(diagnostic(
      "PORT_FAN_IN_EXCEEDED", "$.connections[candidate].to.port", `'${target.id}.${connection.to.port}' accepts at most ${max} connection(s)`, target.id,
    ));
  }
  const cycle = cycleComponents(normalized, connection);
  if (cycle.length > 0) diagnostics.push(diagnostic(
    "GRAPH_CYCLE", "$.connections[candidate]", `Connection creates a cycle: ${cycle.join(" -> ")}. Use a bounded Loop component.`, connection.to.component,
  ));
  return { ok: !diagnostics.some((item) => item.severity === "error"), diagnostics };
}

export function validateSpec(candidate: unknown, options: ValidationOptions = {}): ValidationResult {
  const parsed = HarnessSpecSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, diagnostics: diagnosticsFromZod(parsed.error, candidate) };
  const spec = parsed.data;
  const normalized = normalizeSpec(spec);
  const components = options.components ?? createBuiltinComponentRegistry();
  const withComponents = { ...options, components };
  const diagnostics = validateGraphBody(normalized, "$", withComponents, normalized.subgraphs);
  if (spec.version === "0.1") {
    const legacyEntrypoint = spec.components.find((component) => component.id === spec.entrypoint);
    if (legacyEntrypoint && legacyEntrypoint.type !== "agent" && legacyEntrypoint.type !== "output") {
      diagnostics.push(diagnostic(
        "ENTRYPOINT_TYPE",
        "$.entrypoint",
        "HarnessSpec v0.1 entrypoint must reference a terminal agent or output component",
        legacyEntrypoint.id,
      ));
    }
  }
  for (const [name, body] of Object.entries(normalized.subgraphs)) {
    diagnostics.push(...validateGraphBody(body, `$.subgraphs.${name}`, withComponents, normalized.subgraphs));
  }
  diagnostics.push(...validateSubgraphReferences(normalized.subgraphs));

  if (normalized.runtime.retry.maxBackoffMs !== undefined && normalized.runtime.retry.backoffMs !== undefined
    && normalized.runtime.retry.maxBackoffMs < normalized.runtime.retry.backoffMs) diagnostics.push(diagnostic(
      "RETRY_BACKOFF_INVALID", "$.runtime.retry.maxBackoffMs", "maxBackoffMs must be at least backoffMs",
    ));
  if (normalized.runtime.budget?.maxCostUsd !== undefined) {
    const allModels = [
      ...normalized.components.map((component, index) => ({ component, path: `$.components[${index}].config` })),
      ...Object.entries(normalized.subgraphs).flatMap(([name, body]) => body.components
        .map((component, index) => ({ component, path: `$.subgraphs.${name}.components[${index}].config` }))),
    ].filter(({ component }) => component.type === "model");
    for (const { component, path } of allModels) {
      if (!hasModelPricing(component)) {
        diagnostics.push(diagnostic(
          "MODEL_PRICING_REQUIRED",
          path,
          "A cost-limited run requires model inputCostPerMillion or outputCostPerMillion",
          component.id,
        ));
      }
    }
  }

  const tests = spec.tests ?? [];
  tests.forEach((test, index) => {
    const assertions = "assertions" in test && test.assertions ? test.assertions : [test.assertion];
    for (const assertion of assertions) {
      if (assertion?.type === "matches") {
        const issue = inspectSafeRegex(assertion.value);
        if (issue) diagnostics.push(diagnostic(
          issue.code === "REGEX_INVALID" ? "TEST_REGEX_INVALID" : "TEST_REGEX_UNSAFE",
          `$.tests[${index}]`,
          `Test '${test.id}': ${issue.message}`,
        ));
      }
      if (assertion?.type === "output-schema") validateSchemaRegexes(
        assertion.schema,
        `$.tests[${index}].schema`,
        diagnostics,
      );
      if (assertion?.type === "output-schema") {
        const testAjv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
        try {
          if (!testAjv.validateSchema(assertion.schema)) diagnostics.push(diagnostic(
            "TEST_SCHEMA_DEFINITION_INVALID",
            `$.tests[${index}].schema`,
            `Test '${test.id}' has an invalid JSON Schema: ${testAjv.errorsText(testAjv.errors)}`,
          ));
        } catch (error) {
          diagnostics.push(diagnostic(
            "TEST_SCHEMA_DEFINITION_INVALID",
            `$.tests[${index}].schema`,
            error instanceof Error ? error.message : `Test '${test.id}' has an invalid JSON Schema`,
          ));
        }
      }
      if (assertion?.type === "tool-called" && assertion.maxCalls !== undefined
        && assertion.minCalls !== undefined && assertion.maxCalls < assertion.minCalls) diagnostics.push(diagnostic(
          "TEST_RANGE_INVALID", `$.tests[${index}]`, `Test '${test.id}' maxCalls must be at least minCalls`,
        ));
      if (assertion?.type === "iterations" && assertion.max !== undefined
        && assertion.min !== undefined && assertion.max < assertion.min) diagnostics.push(diagnostic(
          "TEST_RANGE_INVALID", `$.tests[${index}]`, `Test '${test.id}' max must be at least min`,
        ));
    }
  });

  return { ok: !diagnostics.some((item) => item.severity === "error"), diagnostics };
}

export interface RuntimeInput {
  readonly component: string;
  readonly port: string;
  readonly edgeId: string;
  readonly condition?: PredicateSpec;
  readonly select?: string;
  readonly state?: { readonly key: string; readonly merge?: "replace" | "append" };
}

export interface RuntimeNode {
  readonly id: string;
  readonly type: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly policy?: ComponentPolicy;
  readonly inputs: Readonly<Record<string, readonly RuntimeInput[]>>;
}

export interface RuntimeEdge extends ConnectionSpec {
  readonly id: string;
}

export interface RuntimeGraphPlan {
  readonly nodes: readonly RuntimeNode[];
  readonly edges: readonly RuntimeEdge[];
  readonly order: readonly string[];
  readonly layers: readonly (readonly string[])[];
  readonly entrypoint: string;
}

export interface RuntimePlan extends RuntimeGraphPlan {
  readonly version: "0.2";
  readonly sourceVersion: "0.1" | "0.2";
  readonly subgraphs: Readonly<Record<string, RuntimeGraphPlan>>;
  readonly runtime: NormalizedHarnessSpec["runtime"];
}

export type CompileResult =
  | { ok: true; plan: RuntimePlan; diagnostics: Diagnostic[] }
  | { ok: false; diagnostics: Diagnostic[] };

function compileBody(body: GraphBody): RuntimeGraphPlan {
  const edges: RuntimeEdge[] = body.connections.map((connection, index) => ({
    ...connection,
    id: connection.id ?? `${connection.from.component}:${connection.from.port}->${connection.to.component}:${connection.to.port}:${index}`,
  }));
  const layers = graphLayers(body);
  const nodes = body.components.map((component): RuntimeNode => {
    const inputs: Record<string, RuntimeInput[]> = {};
    for (const edge of edges.filter((connection) => connection.to.component === component.id)) {
      const values = inputs[edge.to.port] ?? [];
      values.push({
        component: edge.from.component,
        port: edge.from.port,
        edgeId: edge.id,
        ...(edge.condition ? { condition: edge.condition } : {}),
        ...(edge.select !== undefined ? { select: edge.select } : {}),
        ...(edge.state ? {
          state: {
            key: edge.state.key,
            ...(edge.state.merge === undefined ? {} : { merge: edge.state.merge }),
          },
        } : {}),
      });
      inputs[edge.to.port] = values;
    }
    return {
      id: component.id,
      type: component.type,
      config: component.config,
      ...(component.policy ? { policy: component.policy } : {}),
      inputs,
    };
  });
  return {
    nodes,
    edges,
    order: layers.flat(),
    layers,
    entrypoint: body.entrypoint,
  };
}

export function compileSpec(candidate: unknown, options: ValidationOptions = {}): CompileResult {
  const validation = validateSpec(candidate, options);
  if (!validation.ok) return { ok: false, diagnostics: validation.diagnostics };
  const spec = HarnessSpecSchema.parse(candidate);
  const normalized = normalizeSpec(spec);
  return {
    ok: true,
    plan: {
      version: "0.2",
      sourceVersion: normalized.sourceVersion,
      ...compileBody(normalized),
      subgraphs: Object.fromEntries(Object.entries(normalized.subgraphs).map(([name, body]) => [name, compileBody(body)])),
      runtime: normalized.runtime,
    },
    diagnostics: validation.diagnostics,
  };
}
