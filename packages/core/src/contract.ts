import type { ConnectionSpec, HarnessAssertion, HarnessSpec } from "./spec.js";

export type HarnessPlanSummary = {
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly layerCount: number;
  readonly entrypoint: string;
  readonly sourceVersion: "0.1" | "0.2";
  readonly timeoutMs?: number;
};

export interface HarnessIntegrationContract {
  readonly contractVersion: "1";
  readonly specVersion: HarnessSpec["version"];
  readonly entrypoint: string;
  readonly graphCount: number;
  readonly componentCount: number;
  readonly connectionCount: number;
  readonly plan: HarnessPlanSummary;
  readonly componentTypes: Readonly<Record<string, number>>;
  readonly providers: readonly {
    readonly component: string;
    readonly adapter?: string;
    readonly model?: string;
    readonly connectionId?: string;
  }[];
  readonly tools: readonly {
    readonly component: string;
    readonly tool?: string;
    readonly source?: string;
    readonly risk?: string;
    readonly connectionId?: string;
  }[];
  readonly capabilities: readonly string[];
  readonly tests: { readonly count: number; readonly assertionTypes: readonly string[] };
  readonly requiredConnections: readonly string[];
  readonly output?: { readonly component: string; readonly format: "text" | "json"; readonly schemaDeclared: boolean };
  readonly policy: {
    readonly timeoutMs?: number;
    readonly retryAttempts?: number;
    readonly maxTokens?: number;
    readonly maxCostUsd?: number;
  };
  readonly integrationSurfaces: readonly {
    readonly id: "sdk" | "cli" | "http" | "mcp";
    readonly label: string;
    readonly example: string;
  }[];
}

const text = (value: unknown) => typeof value === "string" && value ? value : undefined;
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;

const layerCount = (componentIds: readonly string[], connections: readonly ConnectionSpec[]): number => {
  const remaining = new Set(componentIds);
  const inbound = new Map(componentIds.map((id) => [id, 0]));
  const outbound = new Map(componentIds.map((id) => [id, [] as string[]]));
  for (const connection of connections) {
    if (!remaining.has(connection.from.component) || !remaining.has(connection.to.component)) continue;
    inbound.set(connection.to.component, (inbound.get(connection.to.component) ?? 0) + 1);
    outbound.get(connection.from.component)?.push(connection.to.component);
  }
  let count = 0;
  while (remaining.size) {
    const ready = [...remaining].filter((id) => (inbound.get(id) ?? 0) === 0);
    if (!ready.length) return count;
    count += 1;
    for (const id of ready) {
      remaining.delete(id);
      for (const target of outbound.get(id) ?? []) inbound.set(target, (inbound.get(target) ?? 0) - 1);
    }
  }
  return count;
};

const summarizePlan = (spec: HarnessSpec): HarnessPlanSummary => {
  const componentIds = spec.components.map(({ id }) => id);
  const timeoutMs = number(spec.runtime?.timeoutMs);
  return {
    nodeCount: spec.components.length,
    edgeCount: spec.connections.length,
    layerCount: layerCount(componentIds, spec.connections),
    entrypoint: spec.entrypoint,
    sourceVersion: spec.version,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
};

/** A stable, secret-free description of what one HarnessSpec can expose. */
export function describeHarness(spec: HarnessSpec): HarnessIntegrationContract {
  const graphs = [
    { name: "root", components: spec.components, connections: spec.connections },
    ...(spec.version !== "0.1" ? Object.entries(spec.subgraphs ?? {}).map(([name, graph]) => ({ name, ...graph })) : []),
  ];
  const components = graphs.flatMap((graph) => graph.components.map((component) => ({
    graph: graph.name,
    component,
    config: component.config as Readonly<Record<string, unknown>>,
  })));
  const componentTypes: Record<string, number> = {};
  for (const { component } of components) componentTypes[component.type] = (componentTypes[component.type] ?? 0) + 1;

  const providers = components.filter(({ component }) => component.type === "model").map(({ graph, component, config }) => {
    const adapter = text(config.adapter);
    const model = text(config.model);
    const connectionId = text(config.connectionId);
    return {
      component: graph === "root" ? component.id : `${graph}/${component.id}`,
      ...(adapter ? { adapter } : {}),
      ...(model ? { model } : {}),
      ...(connectionId ? { connectionId } : {}),
    };
  });
  const tools = components.filter(({ component }) => ["tool", "local-tool", "mcp-tool"].includes(component.type))
    .map(({ graph, component, config }) => {
      const tool = text(config.tool);
      const source = text(config.source);
      const risk = text(config.risk);
      const connectionId = text(config.connectionId);
      return {
        component: graph === "root" ? component.id : `${graph}/${component.id}`,
        ...(tool ? { tool } : {}),
        ...(source ? { source } : {}),
        ...(risk ? { risk } : {}),
        ...(connectionId ? { connectionId } : {}),
      };
    });
  const capabilities = new Set<string>();
  const hasType = (type: string) => components.some(({ component }) => component.type === type);
  if (hasType("agent")) capabilities.add("conversation");
  if (hasType("memory")) capabilities.add("memory");
  if (hasType("evaluator") || (spec.tests?.length ?? 0) > 0) capabilities.add("evaluation");
  if (hasType("router") || hasType("join") || hasType("loop") || hasType("subgraph")) capabilities.add("control-flow");
  if (hasType("skill")) capabilities.add("skills");
  if (components.some(({ component, config }) => component.type === "context" && ["file", "directory"].includes(text(config.source) ?? ""))) capabilities.add("file-context");
  if (tools.some(({ tool }) => tool === "builtin.code-runner")) {
    capabilities.add("file-attachments");
    capabilities.add("code-sandbox");
    capabilities.add("artifacts");
  }
  if (tools.some(({ tool }) => tool === "builtin.web-search")) capabilities.add("web-search");
  if (hasType("mcp-tool") || tools.some(({ source }) => source === "mcp")) capabilities.add("mcp");
  if (hasType("classifier")) capabilities.add("intent-routing");
  if (hasType("team")) capabilities.add("dynamic-multi-agent");

  const assertions = (spec.tests ?? []).flatMap((test): readonly HarnessAssertion[] =>
    "assertions" in test && test.assertions ? test.assertions : test.assertion ? [test.assertion] : []);
  const requiredConnections = [...new Set(components.flatMap(({ config }) =>
    [text(config.connectionId), text(config.fallbackConnectionId)].filter((value): value is string => Boolean(value))))].sort();
  const outputComponent = components.find(({ graph, component }) => graph === "root" && component.id === spec.entrypoint && component.type === "output");
  const retry = spec.version !== "0.1" ? spec.runtime?.retry : undefined;
  const budget = spec.version !== "0.1" ? spec.runtime?.budget : undefined;
  const timeoutMs = number(spec.runtime?.timeoutMs);
  const retryAttempts = number(retry?.maxAttempts);
  const maxTokens = number(budget?.maxTokens);
  const maxCostUsd = number(budget?.maxCostUsd);

  return {
    contractVersion: "1",
    specVersion: spec.version,
    entrypoint: spec.entrypoint,
    graphCount: graphs.length,
    componentCount: components.length,
    connectionCount: graphs.reduce((total, graph) => total + graph.connections.length, 0),
    plan: summarizePlan(spec),
    componentTypes: Object.fromEntries(Object.entries(componentTypes).sort(([left], [right]) => left.localeCompare(right))),
    providers,
    tools,
    capabilities: [...capabilities].sort(),
    tests: { count: spec.tests?.length ?? 0, assertionTypes: [...new Set(assertions.map(({ type }) => type))].sort() },
    requiredConnections,
    ...(outputComponent ? { output: {
      component: outputComponent.component.id,
      format: outputComponent.config.format === "json" ? "json" : "text",
      schemaDeclared: Boolean(outputComponent.config.schema),
    } } : {}),
    policy: {
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(retryAttempts !== undefined ? { retryAttempts } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    },
    integrationSurfaces: [
      { id: "sdk", label: "TypeScript SDK", example: "await Harnest.load(file).then(h => h.invoke(input))" },
      { id: "cli", label: "CLI", example: "harnest run <file> --input <value>" },
      { id: "http", label: "HTTP service", example: "harnest serve <file>" },
      { id: "mcp", label: "MCP server", example: "harnest mcp serve <file>" },
    ],
  };
}
