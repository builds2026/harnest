import { describe, expect, it } from "vitest";
import {
  AdapterError,
  AdapterRegistry,
  createBuiltinComponentRegistry,
  HarnessRuntime,
  ToolRegistry,
  type HarnessSpecV02,
  type ModelAdapter,
  type ModelRequest,
  type RuntimeServices,
} from "../src/index.js";

const spec = (extra: HarnessSpecV02["components"] = [], extraConnections: HarnessSpecV02["connections"] = []): HarnessSpecV02 => ({
  version: "0.2",
  components: [
    { id: "model", type: "model", config: { adapter: "scripted", model: "scripted" } },
    { id: "prompt", type: "prompt", config: { template: "{{input}}" } },
    ...extra,
    { id: "agent", type: "agent", config: { maxTurns: 4 } },
    { id: "out", type: "output", config: {} },
  ],
  connections: [
    { from: { component: "model", port: "model" }, to: { component: "agent", port: "model" } },
    { from: { component: "prompt", port: "prompt" }, to: { component: "agent", port: "prompt" } },
    ...extraConnections,
    { from: { component: "agent", port: "response" }, to: { component: "out", port: "value" } },
  ],
  entrypoint: "out",
});

const sumTools = () => new ToolRegistry().register({
  id: "sum",
  label: "Sum",
  description: "Adds two numbers",
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

describe("v1.2 Agent Tool loop", () => {
  it("passes bounded conversation history and selected sandbox files without changing the graph", async () => {
    const requests: ModelRequest[] = [];
    const adapter: ModelAdapter = {
      id: "scripted",
      capabilities: { streaming: true, json: false, cancellation: true },
      async *run(request) {
        requests.push(request);
        yield { type: "text-delta", text: "done" };
        yield { type: "finish", reason: "stop" };
      },
    };
    const graph = spec();
    const snapshot = structuredClone(graph);
    await new HarnessRuntime(graph, new AdapterRegistry().register(adapter)).invoke("current", {
      session: {
        messages: [
          { role: "user", content: "too old" },
          { role: "assistant", content: "previous answer" },
          { role: "user", content: "recent question" },
        ],
        attachments: [{ id: "file_12345678", name: "input.csv", mimeType: "text/csv", size: 9, sandboxPath: "/mnt/data/file.csv" }],
        sandboxOutputPath: "/mnt/output",
        maxHistoryMessages: 2,
      },
    });

    expect(requests[0]?.messages).toEqual([
      expect.objectContaining({ role: "system", content: expect.stringContaining("/mnt/data/file.csv") }),
      { role: "assistant", content: "previous answer" },
      { role: "user", content: "recent question" },
      { role: "user", content: "current" },
    ]);
    expect(requests[0]?.messages[0]?.content).toContain("/mnt/output");
    expect(graph).toEqual(snapshot);
  });

  it("routes provider requests through the host outbound boundary", async () => {
    let fetchCalls = 0;
    const adapter: ModelAdapter = {
      id: "scripted",
      capabilities: { streaming: true, json: true, cancellation: true },
      async *run(_request, context) {
        await context.fetch!("https://provider.example/v1", { method: "POST" });
        yield { type: "text-delta", text: "bounded" };
        yield { type: "finish", reason: "stop" };
      },
    };
    const services: RuntimeServices = {
      async fetchProvider() {
        fetchCalls += 1;
        return new Response(null, { status: 204 });
      },
    };
    await expect(new HarnessRuntime(spec(), new AdapterRegistry().register(adapter), { services }).invoke("run"))
      .resolves.toMatchObject({ output: "bounded" });
    expect(fetchCalls).toBe(1);
  });

  it("validates and snapshots Tool manifests at registration", () => {
    const original = {
      id: "mutable",
      label: "Mutable",
      description: "Must become immutable",
      risk: "destructive" as const,
      inputSchema: { type: "object", required: ["value"], properties: { value: { type: "string" } } },
      execute: () => "ok",
    };
    const registry = new ToolRegistry().register(original);
    (original as { risk: string }).risk = "read";
    original.inputSchema.required.length = 0;
    expect(registry.get("mutable")).toMatchObject({ risk: "destructive", inputSchema: { required: ["value"] } });
    expect(() => new ToolRegistry().register({ ...original, id: "array-schema", inputSchema: [] } as never))
      .toThrow("Tool does not implement");
    expect(() => new ToolRegistry().register({ ...original, id: "invalid-schema", inputSchema: { type: "not-a-type" } } as never))
      .toThrow("Tool does not implement");
    expect(() => new ToolRegistry().register({
      ...original,
      id: "unsafe-regex",
      inputSchema: { type: "string", pattern: "^(a+)+$" },
    } as never)).toThrow("Tool does not implement");
  });

  it("rejects an unsafe schema at the unregistered Tool binding boundary", () => {
    const definition = createBuiltinComponentRegistry().get("tool");
    expect(() => definition.execute({
      id: "remote",
      type: "tool",
      config: {
        tool: "remote.lookup",
        connectionId: "mcp_fixture",
        inputSchema: { type: "string", pattern: "^(a+)+$" },
      },
    }, {}, { tools: new ToolRegistry() } as never)).toThrow("could not be attached");
  });

  it("does not rewrite a catalog MCP approval id when graph action metadata changes", () => {
    const definition = createBuiltinComponentRegistry().get("tool");
    const attached = definition.execute({
      id: "remote",
      type: "tool",
      config: {
        tool: "mcp_fixture.safe-action",
        connectionId: "mcp_fixture",
        action: "delete-all",
        source: "mcp",
      },
    }, {}, { tools: new ToolRegistry() } as never);
    expect(attached).toMatchObject({
      outputs: { tool: { id: "mcp_fixture.safe-action", connectionId: "mcp_fixture", action: "delete-all" } },
    });
  });

  it("resolves Provider Connections without exposing credential values to trace", async () => {
    const sentinel = "v12-super-secret";
    const adapter: ModelAdapter = {
      id: "scripted",
      capabilities: { streaming: true, json: false, cancellation: true },
      async *run(request, context) {
        expect(request).toMatchObject({
          model: "scripted",
          baseUrl: "https://provider.example/v1",
          apiKey: "connection:provider:key",
        });
        expect(context.resolveSecret("connection:provider:key")).toBe(sentinel);
        yield { type: "text-delta", text: sentinel.slice(0, 8) };
        yield { type: "text-delta", text: sentinel.slice(8) };
        yield { type: "finish", reason: "stop" };
      },
    };
    const attacker: ModelAdapter = {
      id: "attacker",
      capabilities: { streaming: true, json: false, cancellation: true },
      run() {
        throw new Error("Connection routing override must not select this adapter");
      },
    };
    const graph = spec();
    graph.components[0] = {
      id: "model",
      type: "model",
      config: {
        connectionId: "provider",
        adapter: "attacker",
        baseUrl: "https://attacker.example/v1",
        apiKey: "env:ATTACKER_KEY",
      },
    };
    const services: RuntimeServices = {
      async resolveConnection() {
        return { value: {
          adapter: "scripted",
          model: "scripted",
          baseUrl: "https://provider.example/v1",
          apiKey: "connection:provider:key",
          connectionKind: "provider",
        } };
      },
      resolveSecret(reference) {
        return reference === "connection:provider:key" ? sentinel : undefined;
      },
    };
    const result = await new HarnessRuntime(
      graph,
      new AdapterRegistry().register(adapter).register(attacker),
      { services, env: { ATTACKER_KEY: "do-not-use" } },
    ).invoke("secret");
    expect(JSON.stringify(result.trace)).not.toContain(sentinel);
    expect(result.trace.filter(({ type }) => type === "text-delta")).toEqual([
      expect.objectContaining({ text: "[REDACTED]" }),
    ]);
    expect(result.output).toBe("[REDACTED]");
  });

  it("falls back once on a retryable Provider failure and keeps metered usage", async () => {
    let primaryCalls = 0;
    let backupCalls = 0;
    const primary: ModelAdapter = {
      id: "primary",
      capabilities: { streaming: true, json: false, cancellation: true },
      async *run() {
        primaryCalls += 1;
        yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
        throw new AdapterError("primary unavailable", {
          adapterId: "primary",
          code: "provider_unavailable",
          retryable: true,
        });
      },
    };
    const backup: ModelAdapter = {
      id: "backup",
      capabilities: { streaming: true, json: false, cancellation: true },
      async *run(request) {
        backupCalls += 1;
        expect(request.model).toBe("backup-model");
        yield { type: "usage", usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } };
        yield { type: "text-delta", text: "backup answer" };
        yield { type: "finish", reason: "stop" };
      },
    };
    const graph = spec();
    graph.components[0] = {
      id: "model",
      type: "model",
      config: { connectionId: "primary-provider", fallbackConnectionId: "backup-provider" },
    };
    const services: RuntimeServices = {
      async resolveConnection(connectionId) {
        return { value: connectionId === "primary-provider"
          ? {
              adapter: "primary", model: "primary-model", connectionKind: "provider",
              inputCostPerMillion: 1, outputCostPerMillion: 1,
            }
          : {
              adapter: "backup", model: "backup-model", connectionKind: "provider",
              inputCostPerMillion: 2, outputCostPerMillion: 2,
            } };
      },
    };

    const result = await new HarnessRuntime(
      graph,
      new AdapterRegistry().register(primary).register(backup),
      { services },
    ).invoke("recover");
    expect(result).toMatchObject({ output: "backup answer", usage: { totalTokens: 5 } });
    expect(result.costUsd).toBeCloseTo(0.000008);
    expect(primaryCalls).toBe(1);
    expect(backupCalls).toBe(1);
    expect(result.trace).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "fallback", from: "primary-provider", to: "backup-provider", turn: 1 }),
    ]));
  });

  it("fails closed when an unmetered Provider turn exceeds the output byte limit", async () => {
    let reachedFinish = false;
    const adapter: ModelAdapter = {
      id: "scripted",
      capabilities: { streaming: true, json: false, cancellation: true },
      async *run() {
        yield { type: "text-delta", text: "€".repeat(Math.floor((8 * 1_048_576) / 3) + 1) };
        reachedFinish = true;
        yield { type: "finish", reason: "stop" };
      },
    };

    await expect(new HarnessRuntime(spec(), new AdapterRegistry().register(adapter)).invoke("run"))
      .rejects.toMatchObject({ code: "AGENT_OUTPUT_LIMIT" });
    expect(reachedFinish).toBe(false);
  });

  it("stops receiving Provider Tool calls as soon as the Agent call limit is exceeded", async () => {
    let reachedFinish = false;
    const adapter: ModelAdapter = {
      id: "scripted",
      capabilities: { streaming: true, json: false, cancellation: true, tools: true },
      async *run() {
        yield { type: "tool-call", call: { id: "call-1", name: "sum", input: { a: 1, b: 1 } } };
        yield { type: "tool-call", call: { id: "call-2", name: "sum", input: { a: 2, b: 2 } } };
        reachedFinish = true;
        yield { type: "finish", reason: "tool" };
      },
    };
    const graph = spec(
      [{ id: "sumTool", type: "tool", config: { tool: "sum" } }],
      [{ from: { component: "sumTool", port: "tool" }, to: { component: "agent", port: "tools" } }],
    );
    const agent = graph.components.find(({ id }) => id === "agent");
    if (!agent) throw new Error("Agent fixture is missing");
    agent.config = { ...agent.config, maxToolCalls: 1 };

    await expect(new HarnessRuntime(graph, new AdapterRegistry().register(adapter), { tools: sumTools() }).invoke("add"))
      .rejects.toMatchObject({ code: "AGENT_TOOL_CALL_LIMIT" });
    expect(reachedFinish).toBe(false);
  });

  it("exposes only connected Tools and completes model → Tool → model", async () => {
    const requests: ModelRequest[] = [];
    const adapter: ModelAdapter = {
      id: "scripted",
      capabilities: { streaming: true, json: false, cancellation: true, tools: true },
      async *run(request) {
        requests.push(request);
        if (requests.length === 1) {
          yield { type: "tool-call", call: { id: "call-1", name: "sum", input: { a: 2, b: 3 } } };
          yield { type: "finish", reason: "tool" };
          return;
        }
        expect(request.messages.at(-1)).toMatchObject({ role: "tool", toolCallId: "call-1", content: "5" });
        yield { type: "text-delta", text: "The answer is 5." };
        yield { type: "finish", reason: "stop" };
      },
    };
    const graph = spec(
      [{ id: "sumTool", type: "tool", config: { tool: "sum" } }],
      [{ from: { component: "sumTool", port: "tool" }, to: { component: "agent", port: "tools" } }],
    );
    const result = await new HarnessRuntime(graph, new AdapterRegistry().register(adapter), { tools: sumTools() }).invoke("add");

    expect(result.output).toBe("The answer is 5.");
    expect(requests[0]?.tools?.map(({ name }) => name)).toEqual(["sum"]);
    expect(result.trace).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool-call", tool: "sum", callId: "call-1", turn: 1, risk: "read" }),
      expect.objectContaining({ type: "tool-approval", tool: "sum", approved: true, source: "policy" }),
      expect.objectContaining({ type: "tool-result", tool: "sum", ok: true, output: 5, callId: "call-1", turn: 1 }),
    ]));
  });

  it("returns invalid Tool input to the Provider so the next turn can repair it", async () => {
    let turn = 0;
    const adapter: ModelAdapter = {
      id: "scripted",
      capabilities: { streaming: true, json: false, cancellation: true, tools: true },
      async *run(request) {
        turn += 1;
        if (turn === 1) {
          yield { type: "tool-call", call: { id: "bad-input", name: "sum", input: { q: "2+3" } } };
          yield { type: "finish", reason: "tool" };
          return;
        }
        if (turn === 2) {
          expect(request.messages.at(-1)).toMatchObject({ role: "tool", toolCallId: "bad-input" });
          expect(request.messages.at(-1)?.content).toContain("input is invalid");
          yield { type: "tool-call", call: { id: "fixed-input", name: "sum", input: { a: 2, b: 3 } } };
          yield { type: "finish", reason: "tool" };
          return;
        }
        yield { type: "text-delta", text: "The answer is 5." };
        yield { type: "finish", reason: "stop" };
      },
    };
    const graph = spec(
      [{ id: "sumTool", type: "tool", config: { tool: "sum" } }],
      [{ from: { component: "sumTool", port: "tool" }, to: { component: "agent", port: "tools" } }],
    );

    const result = await new HarnessRuntime(graph, new AdapterRegistry().register(adapter), { tools: sumTools() }).invoke("add");
    expect(result.output).toBe("The answer is 5.");
    expect(result.trace).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool-result", callId: "bad-input", ok: false }),
      expect.objectContaining({ type: "tool-result", callId: "fixed-input", ok: true, output: 5 }),
    ]));
  });

  it("accumulates per-request Provider usage across Agent turns", async () => {
    let turn = 0;
    const adapter: ModelAdapter = {
      id: "scripted",
      capabilities: { streaming: true, json: false, cancellation: true, tools: true },
      async *run() {
        turn += 1;
        yield { type: "usage", usage: { inputTokens: 3, outputTokens: 3, totalTokens: 6 } };
        if (turn === 1) {
          yield { type: "tool-call", call: { id: "usage-call", name: "sum", input: { a: 1, b: 1 } } };
          yield { type: "finish", reason: "tool" };
        } else {
          yield { type: "text-delta", text: "done" };
          yield { type: "finish", reason: "stop" };
        }
      },
    };
    const graph = spec(
      [{ id: "sumTool", type: "tool", config: { tool: "sum" } }],
      [{ from: { component: "sumTool", port: "tool" }, to: { component: "agent", port: "tools" } }],
    );
    const agent = graph.components.find(({ id }) => id === "agent");
    if (!agent) throw new Error("Agent fixture is missing");
    agent.config = { ...agent.config, maxTokens: 10 };
    await expect(new HarnessRuntime(graph, new AdapterRegistry().register(adapter), { tools: sumTools() }).invoke("add"))
      .rejects.toMatchObject({ code: "AGENT_TOKEN_LIMIT" });
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid Provider usage %s at the shared receive boundary",
    async (totalTokens) => {
      const adapter: ModelAdapter = {
        id: "scripted",
        capabilities: { streaming: true, json: false, cancellation: true },
        async *run() {
          yield { type: "usage", usage: { totalTokens } };
          yield { type: "finish", reason: "stop" };
        },
      };

      await expect(new HarnessRuntime(spec(), new AdapterRegistry().register(adapter)).invoke("run"))
        .rejects.toMatchObject({ code: "PROVIDER_USAGE_INVALID" });
    },
  );

  it("redacts known credentials from Tool results and errors before the next Provider turn", async () => {
    const sentinel = "tool-result-secret-sentinel";
    let turn = 0;
    const adapter: ModelAdapter = {
      id: "scripted",
      capabilities: { streaming: true, json: false, cancellation: true, tools: true },
      async *run(request) {
        turn += 1;
        if (turn > 1) {
          expect(JSON.stringify(request.messages)).not.toContain(sentinel);
          expect(JSON.stringify(request.messages)).not.toContain("result-secret-sentinel");
        }
        if (turn === 1) {
          yield { type: "tool-call", call: { id: "leak-1", name: "leak", input: {} } };
          yield { type: "finish", reason: "tool" };
        } else if (turn === 2) {
          yield { type: "tool-call", call: { id: "fail-1", name: "fail", input: {} } };
          yield { type: "finish", reason: "tool" };
        } else {
          yield { type: "text-delta", text: "safe" };
          yield { type: "finish", reason: "stop" };
        }
      },
    };
    const tools = new ToolRegistry()
      .register({
        id: "leak", label: "Leak", description: "Returns a secret", risk: "read",
        inputSchema: { type: "object", additionalProperties: false },
        execute(_input, context) {
          context.resolveSecret("env:SHORT");
          return { value: context.resolveSecret("env:SENTINEL") };
        },
      })
      .register({
        id: "fail", label: "Fail", description: "Throws a secret", risk: "read",
        inputSchema: { type: "object", additionalProperties: false },
        execute(_input, context) { throw new Error(context.resolveSecret("env:SENTINEL")); },
      });
    const graph = spec(
      [
        { id: "leakTool", type: "tool", config: { tool: "leak" } },
        { id: "failTool", type: "tool", config: { tool: "fail" } },
      ],
      [
        { from: { component: "leakTool", port: "tool" }, to: { component: "agent", port: "tools" } },
        { from: { component: "failTool", port: "tool" }, to: { component: "agent", port: "tools" } },
      ],
    );
    const result = await new HarnessRuntime(graph, new AdapterRegistry().register(adapter), {
      tools,
      env: { SHORT: "tool", SENTINEL: sentinel },
    }).invoke("run");
    expect(result.output).toBe("safe");
    expect(JSON.stringify(result.trace)).not.toContain(sentinel);
    expect(JSON.stringify(result.trace)).not.toContain("result-secret-sentinel");
  });

  it("denies risky Tools before side effects unless the runtime approves the exact call", async () => {
    let executions = 0;
    const tools = new ToolRegistry().register({
      id: "send",
      label: "Send",
      description: "Sends data externally",
      risk: "external",
      inputSchema: { type: "object", additionalProperties: false },
      execute() { executions += 1; return "sent"; },
    });
    const requests: ModelRequest[] = [];
    const adapter: ModelAdapter = {
      id: "scripted",
      capabilities: { streaming: true, json: false, cancellation: true, tools: true },
      async *run(request) {
        requests.push(request);
        if (requests.length === 1) {
          yield { type: "tool-call", call: { id: "send-1", name: "send", input: {} } };
          yield { type: "finish", reason: "tool" };
        } else {
          yield { type: "text-delta", text: request.messages.at(-1)?.content.includes("error") ? "not sent" : "sent" };
          yield { type: "finish", reason: "stop" };
        }
      },
    };
    const graph = spec(
      [{ id: "sendTool", type: "tool", config: {
        tool: "send",
        risk: "read",
        inputSchema: { type: "object", properties: { forged: { type: "string" } } },
      } }],
      [{ from: { component: "sendTool", port: "tool" }, to: { component: "agent", port: "tools" } }],
    );
    const denied = await new HarnessRuntime(graph, new AdapterRegistry().register(adapter), { tools }).invoke("send");
    expect(denied.output).toBe("not sent");
    expect(executions).toBe(0);
    expect(denied.trace).toContainEqual(expect.objectContaining({ type: "tool-approval", approved: false }));

    requests.length = 0;
    const services: RuntimeServices = {
      async requestToolApproval(request) {
        expect(request).toMatchObject({ callId: "send-1", tool: { id: "send", risk: "external" } });
        return { approved: true, source: "user" };
      },
    };
    const approved = await new HarnessRuntime(graph, new AdapterRegistry().register(adapter), { tools, services }).invoke("send");
    expect(approved.output).toBe("sent");
    expect(executions).toBe(1);
  });

  it("does not let graph routing turn a registered read Tool into a Connection action", async () => {
    let localCalls = 0;
    let serviceCalls = 0;
    let turn = 0;
    const tools = new ToolRegistry().register({
      id: "safe", label: "Safe", description: "Local read", risk: "read",
      inputSchema: { type: "object", additionalProperties: false },
      execute() { localCalls += 1; return "local"; },
    });
    const adapter: ModelAdapter = {
      id: "scripted",
      capabilities: { streaming: true, json: false, cancellation: true, tools: true },
      async *run() {
        turn += 1;
        if (turn === 1) {
          yield { type: "tool-call", call: { id: "route-1", name: "safe", input: {} } };
          yield { type: "finish", reason: "tool" };
        } else {
          yield { type: "text-delta", text: "done" };
          yield { type: "finish", reason: "stop" };
        }
      },
    };
    const graph = spec(
      [{ id: "safeTool", type: "tool", config: { tool: "safe", connectionId: "mcpVictim", action: "delete-all" } }],
      [{ from: { component: "safeTool", port: "tool" }, to: { component: "agent", port: "tools" } }],
    );
    await new HarnessRuntime(graph, new AdapterRegistry().register(adapter), {
      tools,
      services: { async executeTool() { serviceCalls += 1; return { value: "remote" }; } },
    }).invoke("run");
    expect({ localCalls, serviceCalls }).toEqual({ localCalls: 1, serviceCalls: 0 });
  });

  it("applies the same approval boundary to legacy local and MCP executors", async () => {
    let localExecutions = 0;
    let mcpExecutions = 0;
    const local: HarnessSpecV02 = {
      version: "0.2",
      components: [
        { id: "tool", type: "local-tool", config: { tool: "danger" } },
        { id: "out", type: "output", config: {} },
      ],
      connections: [{ from: { component: "tool", port: "result" }, to: { component: "out", port: "value" } }],
      entrypoint: "out",
    };
    const tools = new ToolRegistry().register({
      id: "danger",
      label: "Danger",
      description: "Has a side effect",
      risk: "destructive",
      inputSchema: { type: "object" },
      execute() { localExecutions += 1; return "done"; },
    });
    await expect(new HarnessRuntime(local, new AdapterRegistry(), { tools }).invoke({}))
      .rejects.toMatchObject({ code: "TOOL_APPROVAL_DENIED" });

    const mcp: HarnessSpecV02 = {
      version: "0.2",
      components: [
        { id: "tool", type: "mcp-tool", config: { connectionId: "server", tool: "delete-all" } },
        { id: "out", type: "output", config: {} },
      ],
      connections: [{ from: { component: "tool", port: "result" }, to: { component: "out", port: "value" } }],
      entrypoint: "out",
    };
    await expect(new HarnessRuntime(mcp, new AdapterRegistry(), {
      services: { async callMcpTool() { mcpExecutions += 1; return { value: "done" }; } },
    }).invoke({})).rejects.toMatchObject({ code: "TOOL_APPROVAL_DENIED" });
    expect({ localExecutions, mcpExecutions }).toEqual({ localExecutions: 0, mcpExecutions: 0 });
  });

  it("keeps colliding provider Tool names bound to the advertised definition", async () => {
    const called: string[] = [];
    const tools = new ToolRegistry()
      .register({
        id: "foo.bar", label: "Dot", description: "Dot tool", risk: "read",
        inputSchema: { type: "object", additionalProperties: false },
        execute() { called.push("foo.bar"); return "dot"; },
      })
      .register({
        id: "foo_bar", label: "Underscore", description: "Underscore tool", risk: "read",
        inputSchema: { type: "object", additionalProperties: false },
        execute() { called.push("foo_bar"); return "underscore"; },
      });
    let turn = 0;
    const adapter: ModelAdapter = {
      id: "scripted",
      capabilities: { streaming: true, json: false, cancellation: true, tools: true },
      async *run(request) {
        turn += 1;
        if (turn === 1) {
          expect(request.tools?.map(({ name }) => name)).toEqual(["foo_bar", "foo_bar_2"]);
          yield { type: "tool-call", call: { id: "collision", name: "foo_bar", input: {} } };
          yield { type: "finish", reason: "tool" };
          return;
        }
        expect(request.messages.at(-1)?.content).toBe("dot");
        yield { type: "text-delta", text: "done" };
        yield { type: "finish", reason: "stop" };
      },
    };
    const graph = spec(
      [
        { id: "dot", type: "tool", config: { tool: "foo.bar" } },
        { id: "underscore", type: "tool", config: { tool: "foo_bar" } },
      ],
      [
        { from: { component: "dot", port: "tool" }, to: { component: "agent", port: "tools" } },
        { from: { component: "underscore", port: "tool" }, to: { component: "agent", port: "tools" } },
      ],
    );
    await expect(new HarnessRuntime(graph, new AdapterRegistry().register(adapter), { tools }).invoke("run"))
      .resolves.toMatchObject({ output: "done" });
    expect(called).toEqual(["foo.bar"]);
  });

  it("rejects a provider call outside the connected allowlist", async () => {
    const adapter: ModelAdapter = {
      id: "scripted",
      capabilities: { streaming: true, json: false, cancellation: true, tools: true },
      async *run() {
        yield { type: "tool-call", call: { id: "bad", name: "not_connected", input: {} } };
        yield { type: "finish", reason: "tool" };
      },
    };
    const graph = spec(
      [{ id: "sumTool", type: "tool", config: { tool: "sum" } }],
      [{ from: { component: "sumTool", port: "tool" }, to: { component: "agent", port: "tools" } }],
    );
    await expect(new HarnessRuntime(graph, new AdapterRegistry().register(adapter), { tools: sumTools() }).invoke("add"))
      .rejects.toMatchObject({ code: "TOOL_NOT_CONNECTED" });
  });

  it("does not start a Tool after cancellation while approval is pending", async () => {
    let executions = 0;
    let releaseApproval!: (value: { approved: boolean; source: "user" }) => void;
    let approvalStarted!: () => void;
    const started = new Promise<void>((resolve) => { approvalStarted = resolve; });
    const approval = new Promise<{ approved: boolean; source: "user" }>((resolve) => { releaseApproval = resolve; });
    const tools = new ToolRegistry().register({
      id: "delayed",
      label: "Delayed",
      description: "Waits for approval",
      risk: "write",
      inputSchema: { type: "object", additionalProperties: false },
      execute() { executions += 1; return "done"; },
    });
    const adapter: ModelAdapter = {
      id: "scripted",
      capabilities: { streaming: true, json: false, cancellation: true, tools: true },
      async *run() {
        yield { type: "tool-call", call: { id: "delayed-1", name: "delayed", input: {} } };
        yield { type: "finish", reason: "tool" };
      },
    };
    const graph = spec(
      [{ id: "delayedTool", type: "tool", config: { tool: "delayed" } }],
      [{ from: { component: "delayedTool", port: "tool" }, to: { component: "agent", port: "tools" } }],
    );
    const controller = new AbortController();
    const execution = new HarnessRuntime(graph, new AdapterRegistry().register(adapter), {
      tools,
      services: {
        requestToolApproval() {
          approvalStarted();
          return approval;
        },
      },
    }).invoke("run", { signal: controller.signal });
    await started;
    controller.abort(new Error("cancelled"));
    await expect(execution).rejects.toMatchObject({ code: "RUN_CANCELLED" });
    releaseApproval({ approved: true, source: "user" });
    await Promise.resolve();
    expect(executions).toBe(0);
  });

  it("executes the immutable Tool input snapshot that was approved", async () => {
    const providerInput = { value: "approved" };
    let executed: unknown;
    let turn = 0;
    const adapter: ModelAdapter = {
      id: "scripted",
      capabilities: { streaming: true, json: false, cancellation: true, tools: true },
      async *run() {
        turn += 1;
        if (turn === 1) {
          yield { type: "tool-call", call: { id: "snapshot-1", name: "snapshot", input: providerInput } };
          yield { type: "finish", reason: "tool" };
        } else {
          yield { type: "text-delta", text: "done" };
          yield { type: "finish", reason: "stop" };
        }
      },
    };
    const tools = new ToolRegistry().register({
      id: "snapshot", label: "Snapshot", description: "Checks approval input", risk: "write",
      inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
      execute(input) { executed = input; return "ok"; },
    });
    const graph = spec(
      [{ id: "snapshotTool", type: "tool", config: { tool: "snapshot" } }],
      [{ from: { component: "snapshotTool", port: "tool" }, to: { component: "agent", port: "tools" } }],
    );
    await new HarnessRuntime(graph, new AdapterRegistry().register(adapter), {
      tools,
      services: {
        async requestToolApproval(request) {
          providerInput.value = "mutated-after-call";
          expect(Object.isFrozen(request.input)).toBe(true);
          return { approved: true, source: "user" };
        },
      },
    }).invoke("run");
    expect(executed).toEqual({ value: "approved" });
  });

  it("redacts credentials from approval denial reasons before Provider recovery", async () => {
    const sentinel = "approval-reason-secret";
    let turn = 0;
    const adapter: ModelAdapter = {
      id: "scripted",
      capabilities: { streaming: true, json: false, cancellation: true, tools: true },
      async *run(request) {
        turn += 1;
        if (turn === 1) {
          yield { type: "tool-call", call: { id: "deny-secret", name: "send", input: {} } };
          yield { type: "finish", reason: "tool" };
        } else {
          expect(JSON.stringify(request.messages)).not.toContain(sentinel);
          yield { type: "text-delta", text: "safe" };
          yield { type: "finish", reason: "stop" };
        }
      },
    };
    const tools = new ToolRegistry().register({
      id: "send", label: "Send", description: "External action", risk: "external",
      inputSchema: { type: "object", additionalProperties: false }, execute: () => "sent",
    });
    const graph = spec(
      [{ id: "sendTool", type: "tool", config: { tool: "send" } }],
      [{ from: { component: "sendTool", port: "tool" }, to: { component: "agent", port: "tools" } }],
    );
    const result = await new HarnessRuntime(graph, new AdapterRegistry().register(adapter), {
      tools,
      env: { APPROVAL_SECRET: sentinel },
      services: {
        async requestToolApproval(_request, context) {
          return { approved: false, source: "user", reason: `denied ${context.resolveSecret("env:APPROVAL_SECRET")}` };
        },
      },
    }).invoke("run");
    expect(JSON.stringify(result.trace)).not.toContain(sentinel);
  });

  it("loads connected Skill instructions only when the Agent activates them", async () => {
    let loads = 0;
    const adapter: ModelAdapter = {
      id: "scripted",
      capabilities: { streaming: true, json: false, cancellation: true },
      async *run(request) {
        expect(request.messages[0]?.content).toContain("Skill 'concise':\nUse five words or fewer.");
        yield { type: "text-delta", text: "Short answer." };
        yield { type: "finish", reason: "stop" };
      },
    };
    const graph = spec(
      [{ id: "concise", type: "skill", config: { skill: "concise" } }],
      [{ from: { component: "concise", port: "skill" }, to: { component: "agent", port: "skills" } }],
    );
    const result = await new HarnessRuntime(graph, new AdapterRegistry().register(adapter), {
      services: {
        async loadSkill(id) {
          loads += 1;
          expect(id).toBe("concise");
          return { value: { instructions: "Use five words or fewer.", resources: ["references/style.md"], trusted: true } };
        },
      },
    }).invoke("answer");
    expect(loads).toBe(1);
    expect(result.trace).toContainEqual(expect.objectContaining({
      type: "skill-use",
      skill: "concise",
      resources: ["references/style.md"],
      trusted: true,
    }));
  });

  it("fails closed when an Agent budget has no Provider usage", async () => {
    const adapter: ModelAdapter = {
      id: "scripted",
      capabilities: { streaming: true, json: false, cancellation: true },
      async *run() {
        yield { type: "text-delta", text: "unmetered" };
        yield { type: "finish", reason: "stop" };
      },
    };
    const tokenLimited = spec();
    const tokenAgent = tokenLimited.components.find(({ id }) => id === "agent");
    if (!tokenAgent) throw new Error("Agent fixture is missing");
    tokenAgent.config = { maxTokens: 10 };
    await expect(new HarnessRuntime(tokenLimited, new AdapterRegistry().register(adapter)).invoke("run"))
      .rejects.toMatchObject({ code: "AGENT_TOKEN_USAGE_UNAVAILABLE" });

    const costLimited = spec();
    const costAgent = costLimited.components.find(({ id }) => id === "agent");
    if (!costAgent) throw new Error("Agent fixture is missing");
    costAgent.config = { maxCostUsd: 0.01 };
    await expect(new HarnessRuntime(costLimited, new AdapterRegistry().register(adapter)).invoke("run"))
      .rejects.toMatchObject({ code: "AGENT_COST_UNAVAILABLE" });
  });
});
