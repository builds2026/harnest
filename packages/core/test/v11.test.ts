import { describe, expect, it } from "vitest";
import {
  AdapterRegistry,
  ComponentExecutionError,
  HarnessRuntime,
  ToolRegistry,
  createBuiltinComponentRegistry,
  evaluatePredicate,
  runHarnessTests,
  validateSpec,
  type ComponentDefinition,
  type ComponentRegistry,
  type HarnessSpecV02,
  type ModelAdapter,
  type RunEvent,
} from "../src/index.js";

const definition = (
  type: string,
  execute: ComponentDefinition["execute"],
  options: {
    inputs?: ComponentDefinition["ports"]["inputs"];
    retrySafe?: boolean;
    schema?: Readonly<Record<string, unknown>>;
    defaultConfig?: Readonly<Record<string, unknown>>;
  } = {},
): ComponentDefinition => ({
  type,
  label: type,
  category: "Test",
  ports: { inputs: options.inputs ?? {}, outputs: { value: { type: "any" } } },
  configSchema: options.schema ?? { type: "object", additionalProperties: true },
  inspector: [],
  defaultConfig: options.defaultConfig ?? {},
  ...(options.retrySafe === undefined ? {} : { retrySafe: options.retrySafe }),
  execute,
});

const registryWith = (...definitions: ComponentDefinition[]): ComponentRegistry => {
  const registry = createBuiltinComponentRegistry();
  for (const item of definitions) registry.register(item);
  return registry;
};

const spec = (
  components: HarnessSpecV02["components"],
  connections: HarnessSpecV02["connections"],
  entrypoint: string,
  extra: Partial<Pick<HarnessSpecV02, "subgraphs" | "runtime" | "tests">> = {},
): HarnessSpecV02 => ({ version: "0.2", components, connections, entrypoint, ...extra });

const source = definition(
  "test.source",
  (component) => ({ outputs: { value: component.config.value } }),
  {
    retrySafe: true,
    schema: {
      type: "object",
      properties: { value: {} },
      required: ["value"],
      additionalProperties: false,
    },
    defaultConfig: { value: "" },
  },
);

describe("v1.1 component registry and graph", () => {
  it("registers a custom component with a serializable manifest and validates its config", async () => {
    const components = registryWith(source);
    const valid = spec([{ id: "source", type: "test.source", config: { value: "ok" } }], [], "source");
    expect(validateSpec(valid, { components }).ok).toBe(true);
    await expect(new HarnessRuntime(valid, new AdapterRegistry(), { components }).invoke("ignored"))
      .resolves.toMatchObject({ output: "ok" });

    const manifest = components.catalog().find(({ type }) => type === "test.source");
    expect(manifest).toMatchObject({ type: "test.source", defaultConfig: { value: "" } });
    expect(manifest && "execute" in manifest).toBe(false);
    const invalid = spec([{ id: "source", type: "test.source", config: {} }], [], "source");
    expect(validateSpec(invalid, { components }).diagnostics.map(({ code }) => code)).toContain("COMPONENT_CONFIG_INVALID");
  });

  it("redacts declared secrets and sensitive keys before publishing run-start", async () => {
    const captured: RunEvent[] = [];
    const adapter: ModelAdapter = {
      id: "declared-secret",
      capabilities: { streaming: true, json: false, cancellation: true },
      requiredCredentials: ["env:ADAPTER_SECRET"],
      async *run() {
        yield { type: "finish", reason: "stop" };
      },
    };
    const graph = spec([{ id: "source", type: "test.source", config: { value: "env:CONFIG_SECRET" } }], [], "source");
    await new HarnessRuntime(graph, new AdapterRegistry().register(adapter), {
      components: registryWith(source),
      env: { ADAPTER_SECRET: "adapter-secret", CONFIG_SECRET: "config-secret" },
      eventSink: { append(event) { captured.push(event); } },
    }).invoke({
      note: "adapter-secret",
      nested: { note: "config-secret" },
      password: "ordinary-value",
      clientCredentials: "ordinary-value",
      sessionCookie: "ordinary-value",
    });
    expect(captured[0]).toMatchObject({
      type: "run-start",
      input: {
        note: "[REDACTED]",
        nested: { note: "[REDACTED]" },
        password: "[REDACTED]",
        clientCredentials: "[REDACTED]",
        sessionCookie: "[REDACTED]",
      },
    });
  });

  it("rejects unsafe regular expressions synchronously while preserving simple matches", () => {
    const started = performance.now();
    expect(() => evaluatePredicate(
      { op: "matches", value: "^(a+)+$" },
      `${"a".repeat(4_000)}!`,
    )).toThrow("groups and lookarounds");
    expect(performance.now() - started).toBeLessThan(100);
    expect(evaluatePredicate({ op: "matches", value: "^foo[0-9]+$" }, "foo123")).toBe(true);

    const graph = spec(
      [
        { id: "source", type: "test.source", config: { value: "foo123" } },
        { id: "evaluate", type: "evaluator", config: { type: "matches", value: "^(a+)+$" } },
        { id: "out", type: "output", config: { schema: { type: "string", pattern: "^(a+)+$" } } },
      ],
      [
        { from: { component: "source", port: "value" }, to: { component: "evaluate", port: "value" } },
        { from: { component: "evaluate", port: "value" }, to: { component: "out", port: "value" } },
      ],
      "out",
      {
        tests: [{
          id: "unsafe",
          input: "foo123",
          assertions: [
            { type: "matches", value: "^(a+)+$" },
            { type: "output-schema", schema: { patternProperties: { "^(a+)+$": { type: "string" } } } },
          ],
        }],
      },
    );
    expect(validateSpec(graph, { components: registryWith(source) }).diagnostics.map(({ code }) => code))
      .toEqual(expect.arrayContaining(["EVALUATOR_REGEX_UNSAFE", "SCHEMA_REGEX_UNSAFE", "TEST_REGEX_UNSAFE"]));
  });

  it("executes a topological layer in parallel and joins values deterministically", async () => {
    let active = 0;
    let maximum = 0;
    const delayed = definition("test.delayed", async (component) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, Number(component.config.delayMs)));
      active -= 1;
      return { outputs: { value: component.config.value } };
    }, {
      schema: {
        type: "object",
        properties: { value: {}, delayMs: { type: "integer", minimum: 1 } },
        required: ["value", "delayMs"],
        additionalProperties: false,
      },
    });
    const components = registryWith(delayed);
    const graph = spec(
      [
        { id: "a", type: "test.delayed", config: { value: "a", delayMs: 30 } },
        { id: "b", type: "test.delayed", config: { value: "b", delayMs: 30 } },
        { id: "join", type: "join", config: { mode: "array" } },
        { id: "out", type: "output", config: { format: "text" } },
      ],
      [
        { from: { component: "a", port: "value" }, to: { component: "join", port: "values" } },
        { from: { component: "b", port: "value" }, to: { component: "join", port: "values" } },
        { from: { component: "join", port: "value" }, to: { component: "out", port: "value" } },
      ],
      "out",
    );
    const result = await new HarnessRuntime(graph, new AdapterRegistry(), { components }).invoke(null);
    expect(maximum).toBe(2);
    expect(result.output).toEqual(["a", "b"]);
  });

  it("routes only the selected branch and traces active/inactive edges", async () => {
    const components = registryWith(source);
    const graph = spec(
      [
        { id: "source", type: "test.source", config: { value: 7 } },
        { id: "route", type: "router", config: { condition: { op: "gte", value: 5 } } },
        { id: "join", type: "join", config: { mode: "array" } },
        { id: "out", type: "output", config: {} },
      ],
      [
        { from: { component: "source", port: "value" }, to: { component: "route", port: "value" } },
        { id: "yes", from: { component: "route", port: "true" }, to: { component: "join", port: "values" } },
        { id: "no", from: { component: "route", port: "false" }, to: { component: "join", port: "values" } },
        { from: { component: "join", port: "value" }, to: { component: "out", port: "value" } },
      ],
      "out",
    );
    const result = await new HarnessRuntime(graph, new AdapterRegistry(), { components }).invoke(null);
    expect(result.output).toEqual([7]);
    expect(result.trace.filter((event) => event.type === "edge" && (event.edgeId === "yes" || event.edgeId === "no")))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ edgeId: "yes", active: true }),
        expect.objectContaining({ edgeId: "no", active: false }),
      ]));
  });

  it("keeps object Join keys aligned when an earlier conditional input is inactive", async () => {
    const components = registryWith(source);
    const graph = spec(
      [
        { id: "source", type: "test.source", config: { value: 1 } },
        { id: "route", type: "router", config: { condition: { op: "gte", value: 5 } } },
        { id: "join", type: "join", config: { mode: "object", keys: ["yes", "no"] } },
      ],
      [
        { from: { component: "source", port: "value" }, to: { component: "route", port: "value" } },
        { from: { component: "route", port: "true" }, to: { component: "join", port: "values" } },
        { from: { component: "route", port: "false" }, to: { component: "join", port: "values" } },
      ],
      "join",
    );
    await expect(new HarnessRuntime(graph, new AdapterRegistry(), { components }).invoke(null))
      .resolves.toMatchObject({ output: { no: 1 } });
  });

  it("preflights unreachable nodes, bad joins, and parallel state conflicts", () => {
    const pass = definition("test.pass", (_component, inputs) => ({ outputs: { value: inputs.value } }), {
      inputs: { value: { type: "any", required: true, maxConnections: 1 } },
      retrySafe: true,
    });
    const components = registryWith(source, pass);
    const graph = spec(
      [
        { id: "a", type: "test.source", config: { value: 1 } },
        { id: "b", type: "test.source", config: { value: 2 } },
        { id: "unused", type: "test.source", config: { value: 3 } },
        { id: "middle", type: "test.pass", config: {} },
        { id: "join", type: "join", config: { mode: "array" } },
      ],
      [
        {
          from: { component: "a", port: "value" }, to: { component: "middle", port: "value" },
        },
        {
          from: { component: "b", port: "value" }, to: { component: "join", port: "values" },
          state: { key: "answer", merge: "replace" },
        },
        {
          from: { component: "middle", port: "value" }, to: { component: "join", port: "values" },
          state: { key: "answer", merge: "replace" },
        },
      ],
      "join",
    );
    expect(validateSpec(graph, { components }).diagnostics.map(({ code }) => code)).toEqual(expect.arrayContaining([
      "GRAPH_UNREACHABLE",
      "STATE_WRITE_CONFLICT",
    ]));

    const sequential = structuredClone(graph);
    sequential.connections[0]!.state = { key: "answer", merge: "replace" };
    delete sequential.connections[2]!.state;
    expect(validateSpec(sequential, { components }).diagnostics.map(({ code }) => code)).not.toContain("STATE_WRITE_CONFLICT");

    graph.connections.pop();
    expect(validateSpec(graph, { components }).diagnostics.map(({ code }) => code)).toContain("JOIN_INPUTS_INSUFFICIENT");
  });

  it("preflights source-specific Context and MCP configuration", () => {
    const fileContext = spec([{ id: "context", type: "context", config: { source: "file" } }], [], "context");
    expect(validateSpec(fileContext).diagnostics.map(({ code }) => code)).toContain("CONTEXT_PATH_REQUIRED");

    const stdio = spec([{ id: "mcp", type: "mcp-tool", config: { transport: "stdio", tool: "sum" } }], [], "mcp");
    expect(validateSpec(stdio).diagnostics.map(({ code }) => code)).toContain("MCP_COMMAND_REQUIRED");

    const http = spec([{
      id: "mcp",
      type: "mcp-tool",
      config: { transport: "http", tool: "sum", headers: { Authorization: "Bearer literal" } },
    }], [], "mcp");
    expect(validateSpec(http).diagnostics.map(({ code }) => code)).toEqual(expect.arrayContaining([
      "MCP_URL_REQUIRED",
      "SECRET_LITERAL",
    ]));

    const router = spec([{
      id: "route",
      type: "router",
      config: { condition: { op: "matches", value: "[" } },
    }], [], "route");
    expect(validateSpec(router).diagnostics.map(({ code }) => code)).toContain("PREDICATE_REGEX_INVALID");
  });

  it("preflights type-specific Evaluator requirements and test schemas", () => {
    const components = registryWith(source);
    const codesFor = (config: Readonly<Record<string, unknown>>) => validateSpec(spec(
      [
        { id: "source", type: "test.source", config: { value: "value" } },
        { id: "evaluate", type: "evaluator", config },
      ],
      [{ from: { component: "source", port: "value" }, to: { component: "evaluate", port: "value" } }],
      "evaluate",
    ), { components }).diagnostics.map(({ code }) => code);

    expect(codesFor({ type: "equals" })).toContain("EVALUATOR_VALUE_REQUIRED");
    expect(codesFor({ type: "includes" })).toContain("EVALUATOR_VALUE_REQUIRED");
    expect(codesFor({ type: "matches" })).toContain("EVALUATOR_VALUE_REQUIRED");
    expect(codesFor({ type: "output-schema" })).toContain("EVALUATOR_SCHEMA_REQUIRED");
    expect(codesFor({ type: "output-schema", schema: { type: "not-a-json-schema-type" } }))
      .toContain("OUTPUT_SCHEMA_DEFINITION_INVALID");
    expect(codesFor({ type: "tool-called" })).toContain("EVALUATOR_TOOL_REQUIRED");
    expect(codesFor({ type: "latency", maxMs: 0 })).toContain("EVALUATOR_LATENCY_BOUND_REQUIRED");
    expect(codesFor({ type: "iterations" })).toContain("EVALUATOR_ITERATION_BOUND_REQUIRED");
    expect(codesFor({ type: "iterations", min: 2, max: 1 })).toContain("EVALUATOR_RANGE_INVALID");

    const invalidTestSchema = spec(
      [{ id: "source", type: "test.source", config: { value: "value" } }],
      [],
      "source",
      { tests: [{ id: "schema", input: "value", assertion: {
        type: "output-schema",
        schema: { type: "not-a-json-schema-type" },
      } }] },
    );
    expect(validateSpec(invalidTestSchema, { components }).diagnostics.map(({ code }) => code))
      .toContain("TEST_SCHEMA_DEFINITION_INVALID");
  });
});

describe("v1.1 subgraphs, loops, retry, and budgets", () => {
  const increment = definition("test.increment", (_component, _inputs, context) => {
    const previous = typeof context.runInput === "object" && context.runInput !== null
      && "count" in context.runInput && typeof context.runInput.count === "number"
      ? context.runInput.count
      : 0;
    return { outputs: { value: { count: previous + 1 } }, state: { count: previous + 1 } };
  }, { retrySafe: true });

  const loopSpec = (maxIterations: number, target: number): HarnessSpecV02 => spec(
    [
      {
        id: "loop",
        type: "loop",
        config: {
          subgraph: "increment",
          maxIterations,
          until: { source: "value", path: "/count", op: "gte", value: target },
        },
      },
      { id: "out", type: "output", config: {} },
    ],
    [{ from: { component: "loop", port: "value" }, to: { component: "out", port: "value" } }],
    "out",
    {
      subgraphs: {
        increment: {
          components: [{ id: "increment", type: "test.increment", config: {} }],
          connections: [],
          entrypoint: "increment",
        },
      },
    },
  );

  it("runs a named subgraph until the bounded exit condition is satisfied", async () => {
    const components = registryWith(increment);
    const result = await new HarnessRuntime(loopSpec(5, 3), new AdapterRegistry(), { components }).invoke({ count: 0 });
    expect(result.output).toEqual({ count: 3 });
    expect(result.iterations).toBe(3);
    expect(result.trace.filter((event) => event.type === "iteration" && event.phase === "end")).toHaveLength(3);
  });

  it("can rerun from a connected Evaluator result", async () => {
    const components = registryWith(increment);
    const graph = spec(
      [
        {
          id: "loop",
          type: "loop",
          config: {
            subgraph: "evaluate",
            maxIterations: 5,
            until: { path: "/evaluation/passed", op: "equals", value: true },
          },
        },
        { id: "out", type: "output", config: {} },
      ],
      [{ from: { component: "loop", port: "value" }, to: { component: "out", port: "value" } }],
      "out",
      {
        subgraphs: {
          evaluate: {
            components: [
              { id: "increment", type: "test.increment", config: {} },
              { id: "evaluation", type: "evaluator", config: { type: "matches", value: "\\\"count\\\":3" } },
            ],
            connections: [{ from: { component: "increment", port: "value" }, to: { component: "evaluation", port: "value" } }],
            entrypoint: "evaluation",
          },
        },
      },
    );
    const result = await new HarnessRuntime(graph, new AdapterRegistry(), { components }).invoke({ count: 0 });
    expect(result.output).toEqual({ count: 3 });
    expect(result.iterations).toBe(3);
    expect(result.trace).toContainEqual(expect.objectContaining({ type: "evaluation", passed: true }));
    expect(result.trace).toContainEqual(expect.objectContaining({
      type: "edge",
      edgeId: "loop/evaluate/increment:value->evaluation:value:0",
    }));
  });

  it("fails clearly when an exit condition never passes", async () => {
    const components = registryWith(increment);
    await expect(new HarnessRuntime(loopSpec(2, 10), new AdapterRegistry(), { components }).invoke({ count: 0 }))
      .rejects.toMatchObject({ code: "LOOP_ITERATION_LIMIT" });
  });

  it("does not pretend an active cost limit is enforceable when cost is unknown", async () => {
    const unknownCost = definition("test.unknown-cost", () => ({
      outputs: { value: "x" },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      costUsd: 0,
      costKnown: false,
    }));
    const components = registryWith(unknownCost);
    const graph = spec(
      [
        { id: "loop", type: "loop", config: { subgraph: "metered", maxIterations: 2, maxCostUsd: 1 } },
        { id: "out", type: "output", config: {} },
      ],
      [{ from: { component: "loop", port: "value" }, to: { component: "out", port: "value" } }],
      "out",
      { subgraphs: { metered: { components: [{ id: "meter", type: "test.unknown-cost", config: {} }], connections: [], entrypoint: "meter" } } },
    );
    await expect(new HarnessRuntime(graph, new AdapterRegistry(), { components }).invoke("x"))
      .rejects.toMatchObject({ code: "LOOP_COST_UNAVAILABLE" });
  });

  it("requires pricing for models inside a cost-limited loop", () => {
    const graph = spec(
      [
        { id: "loop", type: "loop", config: { subgraph: "model_step", maxIterations: 2, maxCostUsd: 1 } },
        { id: "out", type: "output", config: {} },
      ],
      [{ from: { component: "loop", port: "value" }, to: { component: "out", port: "value" } }],
      "out",
      {
        subgraphs: {
          model_step: {
            components: [{ id: "model", type: "model", config: { adapter: "fake", model: "fake" } }],
            connections: [],
            entrypoint: "model",
          },
        },
      },
    );
    expect(validateSpec(graph).diagnostics.map(({ code }) => code)).toContain("MODEL_PRICING_REQUIRED");
  });

  it("retries only retryable, retry-safe work before output is emitted", async () => {
    let attempts = 0;
    const flaky = definition("test.flaky", () => {
      attempts += 1;
      if (attempts === 1) throw new ComponentExecutionError("TRANSIENT", "try again", { retryable: true });
      return { outputs: { value: "ok" } };
    }, { retrySafe: true });
    const components = registryWith(flaky);
    const graph = spec(
      [{ id: "flaky", type: "test.flaky", config: {}, policy: { retry: { maxAttempts: 2, backoffMs: 0 } } }],
      [],
      "flaky",
    );
    const result = await new HarnessRuntime(graph, new AdapterRegistry(), { components }).invoke(null);
    expect(attempts).toBe(2);
    expect(result.trace).toContainEqual(expect.objectContaining({ type: "retry", code: "TRANSIENT" }));

    attempts = 0;
    const emitted = definition("test.emitted", (_component, _inputs, context) => {
      attempts += 1;
      context.emit({ type: "text-delta", text: "partial" });
      throw new ComponentExecutionError("TRANSIENT", "too late", { retryable: true });
    }, { retrySafe: true });
    const emittedComponents = registryWith(emitted);
    const emittedGraph = spec(
      [{ id: "emitted", type: "test.emitted", config: {}, policy: { retry: { maxAttempts: 3 } } }],
      [],
      "emitted",
    );
    await expect(new HarnessRuntime(emittedGraph, new AdapterRegistry(), { components: emittedComponents }).invoke(null))
      .rejects.toMatchObject({ code: "TRANSIENT" });
    expect(attempts).toBe(1);
  });

  it("charges usage and cost emitted by failed retry attempts", async () => {
    let attempts = 0;
    const metered = definition("test.metered-retry", (_component, _inputs, context) => {
      attempts += 1;
      if (attempts % 2 === 1) {
        context.emit({
          type: "usage",
          usage: { inputTokens: 10, outputTokens: 0, totalTokens: 10 },
          costUsd: 0.01,
        });
        throw new ComponentExecutionError("TRANSIENT", "retry", { retryable: true });
      }
      return {
        outputs: { value: "ok" },
        usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
        usageKnown: true,
        costUsd: 0.001,
        costKnown: true,
      };
    }, { retrySafe: true });
    const components = registryWith(metered);
    const base = spec(
      [{ id: "metered", type: "test.metered-retry", config: {}, policy: { retry: { maxAttempts: 2 } } }],
      [],
      "metered",
      { runtime: { budget: { maxTokens: 100, maxCostUsd: 1 } } },
    );
    const result = await new HarnessRuntime(base, new AdapterRegistry(), { components }).invoke(null);
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 0, totalTokens: 11 });
    expect(result.costUsd).toBeCloseTo(0.011);
    expect(result.trace.at(-1)).toMatchObject({ type: "run-end", usage: { totalTokens: 11 }, costUsd: 0.011 });

    const tokenLimited = structuredClone(base);
    tokenLimited.runtime = { budget: { maxTokens: 5 } };
    await expect(new HarnessRuntime(tokenLimited, new AdapterRegistry(), { components }).invoke(null))
      .rejects.toMatchObject({ code: "RUN_TOKEN_LIMIT" });

    const costLimited = structuredClone(base);
    costLimited.runtime = { budget: { maxCostUsd: 0.005 } };
    await expect(new HarnessRuntime(costLimited, new AdapterRegistry(), { components }).invoke(null))
      .rejects.toMatchObject({ code: "RUN_COST_LIMIT" });
  });
});

describe("v1.1 tools, evaluators, cost, and cancellation", () => {
  it("calls only a registered connected tool and evaluates five assertion kinds", async () => {
    const tools = new ToolRegistry().register({
      id: "sum",
      label: "Sum",
      description: "Adds a and b",
      risk: "read",
      inputSchema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"],
        additionalProperties: false,
      },
      execute(input) {
        const value = input as { a: number; b: number };
        return value.a + value.b;
      },
    });
    const graph = spec(
      [
        { id: "tool", type: "local-tool", config: { tool: "sum" } },
        { id: "evaluate", type: "evaluator", config: { type: "equals", value: 3 } },
        { id: "out", type: "output", config: {} },
      ],
      [
        { from: { component: "tool", port: "result" }, to: { component: "evaluate", port: "value" } },
        { from: { component: "evaluate", port: "value" }, to: { component: "out", port: "value" } },
      ],
      "out",
      {
        tests: [{
          id: "sum-test",
          input: { a: 1, b: 2 },
          assertions: [
            { type: "equals", value: "3" },
            { type: "output-schema", schema: { type: "number" } },
            { type: "tool-called", tool: "sum", minCalls: 1, maxCalls: 1 },
            { type: "latency", maxMs: 1_000 },
            { type: "iterations", min: 0, max: 0 },
          ],
        }],
      },
    );
    const report = await runHarnessTests(graph, new AdapterRegistry(), { tools });
    expect(report).toMatchObject({ ok: true, passed: 1, failed: 0 });
    expect(report.cases[0]?.assertions).toHaveLength(5);
  });

  it("computes model cost and enforces the global cost budget", async () => {
    const adapter: ModelAdapter = {
      id: "priced",
      capabilities: { streaming: true, json: false, cancellation: true },
      async *run() {
        yield { type: "text-delta", text: "ok" };
        yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
        yield { type: "finish", reason: "stop" };
      },
    };
    const graph = spec(
      [
        {
          id: "model",
          type: "model",
          config: { adapter: "priced", model: "priced", inputCostPerMillion: 1, outputCostPerMillion: 1 },
        },
        { id: "prompt", type: "prompt", config: { template: "{{input}}" } },
        { id: "agent", type: "agent", config: {} },
        { id: "out", type: "output", config: {} },
      ],
      [
        { from: { component: "model", port: "model" }, to: { component: "agent", port: "model" } },
        { from: { component: "prompt", port: "prompt" }, to: { component: "agent", port: "prompt" } },
        { from: { component: "agent", port: "response" }, to: { component: "out", port: "value" } },
      ],
      "out",
      { runtime: { budget: { maxCostUsd: 0.000001 } } },
    );
    await expect(new HarnessRuntime(graph, new AdapterRegistry().register(adapter)).invoke("hello"))
      .rejects.toMatchObject({ code: "RUN_COST_LIMIT" });
  });

  it("aborts work when a stream consumer stops early", async () => {
    let aborted = false;
    const persisted: RunEvent[] = [];
    const waiting = definition("test.wait", async (_component, _inputs, context) => {
      await new Promise<void>((_resolve, reject) => context.signal.addEventListener("abort", () => {
        aborted = true;
        reject(context.signal.reason);
      }, { once: true }));
      return { outputs: { value: "never" } };
    });
    const components = registryWith(waiting);
    const graph = spec([{ id: "wait", type: "test.wait", config: {} }], [], "wait");
    const iterator = new HarnessRuntime(graph, new AdapterRegistry(), {
      components,
      eventSink: { append(event) { persisted.push(event); } },
    }).stream(null)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: "run-start" });
    expect((await iterator.next()).value).toMatchObject({ type: "node-start" });
    await iterator.return?.();
    await Promise.resolve();
    expect(aborted).toBe(true);
    expect(persisted.at(-1)).toMatchObject({ type: "error", code: "RUN_CANCELLED" });
  });

  it("enforces node and run timeouts when a custom executor ignores AbortSignal", async () => {
    const stuck = definition("test.stuck", () => new Promise(() => undefined));
    const components = registryWith(stuck);
    const nodeLimited = spec(
      [{ id: "stuck", type: "test.stuck", config: {}, policy: { timeoutMs: 20 } }],
      [],
      "stuck",
      { runtime: { timeoutMs: 1_000 } },
    );
    const started = performance.now();
    await expect(new HarnessRuntime(nodeLimited, new AdapterRegistry(), { components }).invoke(null))
      .rejects.toMatchObject({ code: "NODE_TIMEOUT" });
    expect(performance.now() - started).toBeLessThan(500);

    const runLimited = spec(
      [{ id: "stuck", type: "test.stuck", config: {} }],
      [],
      "stuck",
      { runtime: { timeoutMs: 20 } },
    );
    await expect(new HarnessRuntime(runLimited, new AdapterRegistry(), { components }).invoke(null))
      .rejects.toMatchObject({ code: "RUN_TIMEOUT" });
  });
});
