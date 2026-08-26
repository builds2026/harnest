import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AdapterRegistry,
  HarnessRuntime,
  RunControl,
  ToolRegistry,
  compileSpec,
  parseRunCommand,
  validateSpec,
  type HarnessSpecV03,
  type ModelAdapter,
  type ModelMessage,
  type ModelRequest,
  type RuntimeServices,
} from "../src/index.js";
import { FileRunStore } from "../src/node.js";

const graph = (prompt: string, schema?: Readonly<Record<string, unknown>>) => ({
  components: [
    { id: "model", type: "model", config: { adapter: "team-test", model: "test" } },
    { id: "prompt", type: "prompt", config: { template: prompt } },
    { id: "agent", type: "agent", config: { maxTurns: 4 } },
    { id: "output", type: "output", config: { format: schema ? "json" : "text", ...(schema ? { schema } : {}) } },
  ],
  connections: [
    { from: { component: "model", port: "model" }, to: { component: "agent", port: "model" } },
    { from: { component: "prompt", port: "prompt" }, to: { component: "agent", port: "prompt" } },
    { from: { component: "agent", port: "response" }, to: { component: "output", port: "value" } },
  ],
  entrypoint: "output",
}) satisfies HarnessSpecV03["subgraphs"][string];

const teamSpec = (): HarnessSpecV03 => ({
  version: "0.3",
  components: [
    { id: "team", type: "team", config: { team: "engineering" } },
    { id: "output", type: "output", config: { format: "text" } },
  ],
  connections: [
    { from: { component: "team", port: "value" }, to: { component: "output", port: "value" } },
  ],
  entrypoint: "output",
  subgraphs: {
    chief: graph("Coordinate this request: {{input}}", {
      type: "object",
      properties: {
        status: { enum: ["direct", "tasks", "complete"] },
        finalAnswer: {},
        tasks: { type: "array", items: { type: "object" } },
      },
      additionalProperties: false,
    }),
    researcher: graph("Complete this assigned work: {{input}}"),
  },
  agentTemplates: {
    chief: { description: "Coordinates work", runner: { subgraph: "chief" } },
    researcher: { description: "Researches and reports", capabilities: ["network"], runner: { subgraph: "researcher" } },
  },
  teams: {
    engineering: {
      orchestrator: "chief",
      members: ["researcher"],
      limits: { maxInstances: 4, maxDepth: 2, maxParallel: 2, maxMessages: 8, maxPlanRevisions: 4 },
    },
  },
  studio: { positions: { team: { x: 10, y: 20 }, output: { x: 400, y: 20 } }, pinned: ["team"], direction: "RIGHT" },
});

const content = (messages: readonly ModelMessage[]) => messages.map((message) => typeof message.content === "string"
  ? message.content : message.content.map((part) => part.type === "text" ? part.text : "").join("\n")).join("\n");

const teamAdapter = (requestHelp = false): ModelAdapter => ({
  id: "team-test",
  capabilities: { streaming: true, json: true, cancellation: true, tools: true },
  async *run(request: ModelRequest) {
    const messages = content(request.messages);
    const last = request.messages.at(-1);
    if ((request.responseSchema as { properties?: Record<string, unknown> } | undefined)?.properties?.route) {
      yield { type: "text-delta", text: JSON.stringify({ route: "direct", confidence: 0.99 }) };
      yield { type: "finish", reason: "stop" };
      return;
    }
    if (messages.includes('"phase":"plan"')) {
      yield { type: "text-delta", text: JSON.stringify({
        status: "tasks",
        tasks: [{ id: "research", goal: "Collect evidence", agent: "researcher", dependsOn: [] }],
      }) };
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } };
      yield { type: "finish", reason: "stop" };
      return;
    }
    if (messages.includes('"phase":"synthesize"')) {
      yield { type: "text-delta", text: JSON.stringify({ status: "complete", finalAnswer: "verified final answer" }) };
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
      yield { type: "finish", reason: "stop" };
      return;
    }
    if (requestHelp && messages.includes('"phase":"help"')) {
      yield { type: "text-delta", text: "helper verification" };
      yield { type: "usage", usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } };
      yield { type: "finish", reason: "stop" };
      return;
    }
    if (last?.role === "tool") {
      yield { type: "text-delta", text: "research complete" };
      yield { type: "usage", usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 } };
      yield { type: "finish", reason: "stop" };
      return;
    }
    yield {
      type: "tool-call",
      call: requestHelp
        ? { id: "help-1", name: "harnest_request_help", input: { agent: "researcher", goal: "Verify the evidence" } }
        : { id: "team-message-1", name: "message_team", input: { content: "Evidence collected" } },
    };
    yield { type: "finish", reason: "tool" };
  },
});

describe("HarnessSpec v0.3 and orchestration", () => {
  it("validates and compiles Team templates without changing v0.2 graph semantics", () => {
    const spec = teamSpec();
    const validation = validateSpec(spec, { registry: new AdapterRegistry().register(teamAdapter()) });
    expect(validation.diagnostics).toEqual([]);
    const compiled = compileSpec(spec, { registry: new AdapterRegistry().register(teamAdapter()) });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.plan.sourceVersion).toBe("0.3");
    expect(compiled.plan.teams.engineering?.limits.maxParallel).toBe(2);
    expect(compiled.plan.agentTemplates.researcher?.runner).toEqual({ subgraph: "researcher" });
  });

  it("rejects invalid commands and mediates revision-based plan changes", async () => {
    expect(() => parseRunCommand({ type: "message", target: { kind: "agent" }, content: "x" })).toThrow(/target id/i);
    expect(parseRunCommand({ id: "50b7db9f-d934-4a3b-8e5d-3502fb8371f0", type: "message", target: { kind: "run" }, content: "x" }).id)
      .toBe("50b7db9f-d934-4a3b-8e5d-3502fb8371f0");
    const control = new RunControl("run_1");
    const team = {
      orchestrator: "chief",
      members: ["researcher"],
      limits: { maxInstances: 4, maxDepth: 2, maxParallel: 2, maxMessages: 4, maxPlanRevisions: 2 },
    };
    control.registerTeam("engineering", team);
    await expect(control.send({ type: "message", target: { kind: "agent", id: "missing" }, content: "x" }))
      .rejects.toThrow(/does not exist/i);
    const chief = control.spawnAgent("engineering", "chief", team.limits);
    control.replacePlan("engineering", chief.id, [{ id: "task", goal: "Initial", agent: "researcher" }], "Initial");
    await control.send({
      type: "plan-patch",
      baseRevision: 1,
      reason: "User redirect",
      operations: [{ op: "update", taskId: "task", goal: "Updated" }],
    });
    expect(control.snapshot().revision).toBe(2);
    expect(control.snapshot().tasks[0]?.goal).toBe("Updated");
    await expect(control.send({
      type: "plan-patch",
      baseRevision: 1,
      reason: "Stale",
      operations: [{ op: "cancel", taskId: "task" }],
    })).rejects.toThrow(/revision 1 to 2/i);
    await expect(control.send({
      type: "plan-patch",
      baseRevision: 2,
      reason: "Atomic failure",
      operations: [
        { op: "update", taskId: "task", goal: "Must not stick" },
        { op: "update", taskId: "missing", goal: "Invalid" },
      ],
    })).rejects.toThrow(/does not exist/i);
    expect(control.snapshot().tasks[0]?.goal).toBe("Updated");
    await control.send({ id: "dedupe-1", type: "message", target: { kind: "run" }, content: "once" });
    await control.send({ id: "mail-1", type: "message", target: { kind: "agent", id: chief.id }, content: "after restart" });
    const resumed = new RunControl("run_1", control.snapshot());
    await resumed.send({ id: "dedupe-1", type: "message", target: { kind: "run" }, content: "once" });
    expect(resumed.snapshot().messages.filter(({ content }) => content === "once")).toHaveLength(1);
    expect(resumed.checkpoint(chief.id).messages.map(({ content }) => content)).toContain("after restart");
    expect(resumed.checkpoint(chief.id).messages).toEqual([]);
  });

  it("spawns a member, carries Agent messages, and synthesizes only the final answer", async () => {
    const runtime = new HarnessRuntime(teamSpec(), new AdapterRegistry().register(teamAdapter()));
    const handle = runtime.start("Investigate this");
    const events = [];
    for await (const event of handle.events) events.push(event);
    const result = await handle.result();
    expect(result.output).toBe("verified final answer");
    expect(events.some((event) => event.type === "agent-spawned" && event.agent.template === "researcher")).toBe(true);
    expect(events.some((event) => event.type === "agent-message" && event.message.content === "Evidence collected")).toBe(true);
    expect(events.filter((event) => event.sequence !== undefined).map((event) => event.sequence))
      .toEqual([...events.keys()].map((index) => index + 1));
    expect(result.usage.totalTokens).toBe(47);
    expect(handle.snapshot().agents.find(({ template }) => template === "researcher")?.usage?.totalTokens).toBe(12);
  });

  it("routes a simple request directly without creating the dynamic Team", async () => {
    const spec = teamSpec();
    spec.components = [
      { id: "model", type: "model", config: { adapter: "team-test", model: "test" } },
      { id: "prompt", type: "prompt", config: { template: "Choose direct or engineering" } },
      { id: "classify", type: "classifier", config: { routes: ["direct", "engineering"], fallback: "engineering" } },
      { id: "direct", type: "subgraph", config: { subgraph: "direct" } },
      { id: "team", type: "team", config: { team: "engineering" } },
      { id: "result", type: "join", config: { mode: "concat" } },
      { id: "output", type: "output", config: { format: "text" } },
    ];
    spec.connections = [
      { from: { component: "model", port: "model" }, to: { component: "classify", port: "model" } },
      { from: { component: "prompt", port: "prompt" }, to: { component: "classify", port: "prompt" } },
      { from: { component: "classify", port: "decision" }, to: { component: "direct", port: "value" }, condition: { path: "/route", op: "equals", value: "direct" } },
      { from: { component: "classify", port: "decision" }, to: { component: "team", port: "value" }, condition: { path: "/route", op: "equals", value: "engineering" } },
      { from: { component: "direct", port: "value" }, to: { component: "result", port: "values" } },
      { from: { component: "team", port: "value" }, to: { component: "result", port: "values" } },
      { from: { component: "result", port: "value" }, to: { component: "output", port: "value" } },
    ];
    spec.subgraphs!.direct = {
      components: [
        { id: "answer", type: "prompt", config: { template: "direct answer" } },
        { id: "output", type: "output", config: { format: "text" } },
      ],
      connections: [{ from: { component: "answer", port: "prompt" }, to: { component: "output", port: "value" } }],
      entrypoint: "output",
    };
    const handle = new HarnessRuntime(spec, new AdapterRegistry().register(teamAdapter())).start("hello");
    const events = [];
    for await (const event of handle.events) events.push(event);
    await expect(handle.result()).resolves.toMatchObject({ output: "direct answer" });
    expect(events.some((event) => event.type === "agent-spawned" && event.agent.teamId === "engineering")).toBe(false);
  });

  it("does not expose a child Tool beyond its declared capabilities", async () => {
    const spec = teamSpec();
    const researcher = spec.subgraphs!.researcher!;
    researcher.components.splice(2, 0, { id: "external", type: "tool", config: { tool: "external-test" } });
    researcher.connections.push({ from: { component: "external", port: "tool" }, to: { component: "agent", port: "tools" } });
    const tools = new ToolRegistry().register({
      id: "external-test", label: "External", description: "External test Tool", inputSchema: { type: "object" },
      risk: "external", execute: () => "unused",
    });
    const registry = new AdapterRegistry().register(teamAdapter());
    await expect(new HarnessRuntime(spec, registry, { tools }).invoke("Investigate"))
      .resolves.toMatchObject({ output: "verified final answer" });
    spec.agentTemplates!.researcher = { ...spec.agentTemplates!.researcher!, capabilities: [] };
    expect(validateSpec(spec, { registry, tools }).diagnostics).toContainEqual(expect.objectContaining({
      code: "AGENT_TEMPLATE_CAPABILITY_REQUIRED",
      message: expect.stringContaining("capability 'network'"),
    }));
    expect(() => new HarnessRuntime(spec, registry, { tools })).toThrow(/HarnessSpec is invalid/i);
  });

  it("lets an Agent synchronously request bounded help and receives the correlated result", async () => {
    const runtime = new HarnessRuntime(teamSpec(), new AdapterRegistry().register(teamAdapter(true)));
    const handle = runtime.start("Investigate with peer verification");
    const events = [];
    for await (const event of handle.events) events.push(event);
    await expect(handle.result()).resolves.toMatchObject({ output: "verified final answer" });
    expect(events.filter((event) => event.type === "task-created")).toHaveLength(2);
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool-result", tool: "harnest.request_help", ok: true, output: "helper verification",
    }));
  });

  it("normalizes model-authored Team Task ids and their dependencies", async () => {
    let plan = true;
    const adapter: ModelAdapter = {
      ...teamAdapter(),
      async *run(request) {
        if (plan && content(request.messages).includes('"phase":"plan"')) {
          plan = false;
          yield { type: "text-delta", text: JSON.stringify({ status: "tasks", tasks: [
            { id: "자료 조사", goal: "Collect", agent: "researcher", dependsOn: [] },
            { id: "2. review result", goal: "Review", agent: "researcher", dependsOn: ["자료 조사"] },
          ] }) };
          yield { type: "finish", reason: "stop" };
          return;
        }
        yield* teamAdapter().run(request);
      },
    };
    const events = [];
    const handle = new HarnessRuntime(teamSpec(), new AdapterRegistry().register(adapter)).start("Investigate");
    for await (const event of handle.events) events.push(event);
    await expect(handle.result()).resolves.toMatchObject({ output: "verified final answer" });
    expect(events.filter((event) => event.type === "task-created").map((event) => event.task.id)).toEqual(["task_1", "task_2_review_result"]);
  });

  it("persists new runs as a bundle and keeps the durable snapshot separate from trace events", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harnest-v03-"));
    try {
      const store = new FileRunStore(directory);
      await store.append({ type: "run-start", runId: "run_1", timestamp: new Date().toISOString(), sequence: 1, input: "x", specVersion: "0.3" });
      await store.saveSnapshot({
        runId: "run_1", revision: 0, status: "running", tasks: [], agents: [], messages: [], revisions: [], proposals: [], updatedAt: new Date().toISOString(),
      });
      await store.append({
        type: "run-end", runId: "run_1", timestamp: new Date().toISOString(), sequence: 2,
        output: "ok", state: {}, usage: {}, costUsd: 0, iterations: 0, durationMs: 1, finishReason: "stop",
      });
      expect(await readdir(join(directory, ".harnest", "runs", "run_1"))).toEqual(expect.arrayContaining(["events", "meta.json", "snapshot.json"]));
      expect((await store.read("run_1")).map(({ type }) => type)).toEqual(["run-start", "run-end"]);
      expect((await store.readSnapshot("run_1"))?.runId).toBe("run_1");
      expect((await store.list())[0]?.status).toBe("succeeded");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("discovers an A2A Agent Card and consumes a streamed remote Task without widening credentials", async () => {
    const spec = teamSpec();
    spec.agentTemplates!.researcher = {
      description: "Remote reviewer",
      runner: { a2a: { connection: "remote_reviewer" } },
    };
    const requests: Array<{ url: string; method: string; authorization?: string; body?: string }> = [];
    const services: RuntimeServices = {
      async resolveConnection() {
        return { value: {
          url: "https://remote.example/a2a",
          discoverAgentCard: true,
          credentialReferences: { token: "connection:remote_reviewer:token" },
        } };
      },
      resolveSecret: (reference) => reference === "connection:remote_reviewer:token" ? "secret-token" : undefined,
      async fetchProvider(url, init) {
        requests.push({
          url: String(url), method: init?.method ?? "GET",
          ...(new Headers(init?.headers).get("authorization") ? { authorization: new Headers(init?.headers).get("authorization")! } : {}),
          ...(typeof init?.body === "string" ? { body: init.body } : {}),
        });
        if ((init?.method ?? "GET") === "GET") return Response.json({
          name: "Remote reviewer", url: "https://remote.example/rpc", capabilities: { streaming: true },
        });
        return new Response('data: {"jsonrpc":"2.0","id":"1","result":{"message":{"parts":[{"kind":"text","text":"remote evidence"}]}}}\n\n', {
          headers: { "content-type": "text/event-stream" },
        });
      },
    };
    const result = await new HarnessRuntime(spec, new AdapterRegistry().register(teamAdapter()), { services }).invoke("Investigate remotely");
    expect(result.output).toBe("verified final answer");
    expect(requests.map(({ url }) => url)).toEqual([
      "https://remote.example/.well-known/agent-card.json",
      "https://remote.example/rpc",
    ]);
    expect(requests[1]?.authorization).toBe("Bearer secret-token");
    expect(JSON.parse(requests[1]!.body!).method).toBe("message/stream");
  });

  it("resumes after the last completed Task and waits for explicit confirmation before retrying interrupted work", async () => {
    const timestamp = new Date().toISOString();
    const snapshot = {
      runId: "resumable_run", sequence: 40, revision: 1, status: "running" as const, updatedAt: timestamp,
      tasks: [
        { id: "done", teamId: "engineering", goal: "Already done", assignee: "researcher", dependsOn: [], status: "completed" as const, result: "kept", createdAt: timestamp, updatedAt: timestamp },
        { id: "interrupted", teamId: "engineering", goal: "Retry after confirmation", assignee: "researcher", dependsOn: ["done"], status: "running" as const, agentId: "researcher_old", createdAt: timestamp, updatedAt: timestamp },
      ],
      agents: [
        { id: "chief_old", teamId: "engineering", template: "chief", depth: 0, status: "running" as const, createdAt: timestamp, updatedAt: timestamp },
        { id: "researcher_old", teamId: "engineering", template: "researcher", parentId: "chief_old", taskId: "interrupted", depth: 1, status: "running" as const, createdAt: timestamp, updatedAt: timestamp },
      ],
      messages: [], revisions: [{ revision: 1, author: "chief_old", reason: "Initial", operations: [], createdAt: timestamp }], proposals: [],
    };
    const runtime = new HarnessRuntime(teamSpec(), new AdapterRegistry().register(teamAdapter()));
    const handle = runtime.resume("Continue", snapshot);
    expect(handle.snapshot().tasks.find(({ id }) => id === "interrupted")?.status).toBe("blocked");
    await handle.send({ type: "task-directive", taskId: "interrupted", instruction: "External side effects were checked; retry now" });
    const events = [];
    for await (const event of handle.events) events.push(event);
    const result = await handle.result();
    expect(events[0]?.sequence).toBe(41);
    expect(result.output).toBe("verified final answer");
    expect(result.usage.totalTokens).toBe(27);
    expect(handle.snapshot().tasks.find(({ id }) => id === "done")?.result).toBe("kept");
  });

  it("resumes a static Agent after its last durable model turn without repeating a completed Tool call", async () => {
    let providerCalls = 0;
    let toolCalls = 0;
    let markSecondTurn!: () => void;
    const secondTurn = new Promise<void>((resolve) => { markSecondTurn = resolve; });
    const adapter: ModelAdapter = {
      id: "turn-resume",
      capabilities: { streaming: true, json: false, cancellation: true, tools: true },
      async *run(_request, context) {
        providerCalls += 1;
        if (providerCalls === 1) {
          yield { type: "tool-call", call: { id: "lookup-1", name: "lookup", input: {} } };
          yield { type: "usage", usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } };
          yield { type: "finish", reason: "tool" };
          return;
        }
        if (providerCalls === 2) {
          markSecondTurn();
          await new Promise<void>((_resolve, reject) => context.signal.addEventListener(
            "abort", () => reject(context.signal.reason), { once: true },
          ));
          return;
        }
        yield { type: "text-delta", text: "resumed answer" };
        yield { type: "usage", usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 } };
        yield { type: "finish", reason: "stop" };
      },
    };
    const spec: HarnessSpecV03 = {
      version: "0.3",
      components: [
        { id: "model", type: "model", config: { adapter: "turn-resume", model: "test" } },
        { id: "prompt", type: "prompt", config: { template: "Complete {{input}}" } },
        { id: "lookup", type: "tool", config: { tool: "lookup" } },
        { id: "agent", type: "agent", config: { maxTurns: 4 } },
        { id: "output", type: "output", config: { format: "text" } },
      ],
      connections: [
        { from: { component: "model", port: "model" }, to: { component: "agent", port: "model" } },
        { from: { component: "prompt", port: "prompt" }, to: { component: "agent", port: "prompt" } },
        { from: { component: "lookup", port: "tool" }, to: { component: "agent", port: "tools" } },
        { from: { component: "agent", port: "response" }, to: { component: "output", port: "value" } },
      ],
      entrypoint: "output",
    };
    const tools = new ToolRegistry().register({
      id: "lookup", label: "Lookup", description: "Read test evidence", risk: "read",
      inputSchema: { type: "object", additionalProperties: false },
      execute: () => { toolCalls += 1; return { evidence: "kept" }; },
    });
    const runtime = new HarnessRuntime(spec, new AdapterRegistry().register(adapter), { tools });
    const interrupted = runtime.start("the goal");
    await secondTurn;
    const snapshot = interrupted.snapshot();
    expect(Object.values(snapshot.turnCheckpoints ?? {})[0]).toMatchObject({ nextTurn: 2, toolCalls: 1 });
    await interrupted.cancel();

    const resumed = runtime.resume("the goal", snapshot);
    await expect(resumed.result()).resolves.toMatchObject({ output: "resumed answer", usage: { totalTokens: 7 } });
    expect(toolCalls).toBe(1);
  });

  it("refuses an unsafe restart when no durable Task checkpoint exists", () => {
    const timestamp = new Date().toISOString();
    const runtime = new HarnessRuntime(teamSpec(), new AdapterRegistry().register(teamAdapter()));
    expect(() => runtime.resume("Continue", {
      runId: "unsafe_resume", revision: 0, status: "running", updatedAt: timestamp,
      tasks: [], agents: [], messages: [], revisions: [], proposals: [],
    })).toThrow(/avoid repeating external side effects/i);
  });
});
