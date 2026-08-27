import { mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AdapterError,
  AdapterRegistry,
  DiagnosticError,
  HarnessRuntime,
  BUILTIN_COMPONENT_MANIFESTS,
  compileSpec,
  parseNdjson,
  parseSpec,
  parseSse,
  readBoundedResponseText,
  runHarnessTests,
  stringifySpec,
  validateCandidateConnection,
  validateSpec,
  type HarnessSpec,
  type ModelAdapter,
  type ModelEvent,
  type RunEvent,
} from "../src/index.js";
import { loadAdapterModules, loadSpecFile, saveSpecFile } from "../src/node.js";

const validSpec = (): HarnessSpec => ({
  version: "0.1",
  components: [
    { id: "model", type: "model", config: { adapter: "fake", model: "test-model" } },
    { id: "prompt", type: "prompt", config: { template: "Answer {{input}}" } },
    { id: "agent", type: "agent", config: {} },
    {
      id: "output",
      type: "output",
      config: {
        format: "json",
        schema: {
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
          additionalProperties: false,
        },
      },
    },
  ],
  connections: [
    { from: { component: "model", port: "model" }, to: { component: "agent", port: "model" } },
    { from: { component: "prompt", port: "prompt" }, to: { component: "agent", port: "prompt" } },
    { from: { component: "agent", port: "response" }, to: { component: "output", port: "value" } },
  ],
  entrypoint: "output",
  studio: { positions: { model: { x: 1, y: 2 } } },
});

const stream = (...chunks: string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
};

function fakeAdapter(events: ModelEvent[], called = { count: 0 }): ModelAdapter {
  return {
    id: "fake",
    capabilities: { streaming: true, json: true, cancellation: true },
    async *run() {
      called.count += 1;
      yield* events;
    },
  };
}

describe("HarnessSpec", () => {
  it("exposes every built-in config property through Inspector metadata", () => {
    for (const manifest of BUILTIN_COMPONENT_MANIFESTS) {
      const properties = (manifest.configSchema.properties ?? {}) as Record<string, unknown>;
      const inspectorPaths = new Set(manifest.inspector.map(({ path }) => path.split(".")[0]));
      expect([...Object.keys(properties).filter((path) => !inspectorPaths.has(path))], manifest.type).toEqual([]);
    }
  });

  it("round-trips YAML and rejects duplicate keys", () => {
    const parsed = parseSpec(stringifySpec(validSpec()));
    expect(parsed.ok).toBe(true);
    expect(parseSpec("version: '0.1'\nversion: '0.1'\n").diagnostics[0]?.code).toBe("YAML_DUPLICATE_KEY");
  });

  it("reports references, required ports, port types, fan-in and cycles", () => {
    const missing = validSpec();
    missing.connections[0]!.from.component = "absent";
    const missingResult = validateSpec(missing);
    expect(missingResult.ok).toBe(false);
    expect(missingResult.diagnostics.map(({ code }) => code)).toContain("CONNECTION_SOURCE_MISSING");

    const incomplete = validSpec();
    incomplete.connections.splice(1, 1);
    expect(validateSpec(incomplete).diagnostics.map(({ code }) => code)).toContain("PORT_REQUIRED");

    const mismatch = validateCandidateConnection(validSpec(), {
      from: { component: "prompt", port: "prompt" },
      to: { component: "agent", port: "model" },
    });
    expect(mismatch.diagnostics.map(({ code }) => code)).toEqual(expect.arrayContaining([
      "PORT_TYPE_MISMATCH",
      "PORT_FAN_IN_EXCEEDED",
    ]));

    const cyclic = validSpec();
    cyclic.connections.push({
      from: { component: "output", port: "value" },
      to: { component: "agent", port: "model" },
    });
    expect(validateSpec(cyclic).diagnostics.map(({ code }) => code)).toContain("GRAPH_CYCLE");
  });

  it("blocks literal secrets, missing adapters and invalid output schemas", () => {
    const spec = validSpec();
    const model = spec.components[0];
    if (model?.type !== "model") throw new Error("fixture");
    model.config.apiKey = "sk-secret";
    const result = validateSpec(spec, { registry: new AdapterRegistry(), env: {} });
    expect(result.diagnostics.map(({ code }) => code)).toEqual(expect.arrayContaining([
      "SECRET_LITERAL",
      "ADAPTER_NOT_REGISTERED",
    ]));

    const output = spec.components[3];
    if (output?.type !== "output") throw new Error("fixture");
    output.config.schema = { type: "not-a-json-schema-type" };
    expect(validateSpec(spec).diagnostics.map(({ code }) => code)).toContain("OUTPUT_SCHEMA_DEFINITION_INVALID");

    const credentials = new AdapterRegistry().register({
      ...fakeAdapter([]),
      requiredCredentials: ["env:FAKE_API_KEY"],
    });
    model.config.apiKey = undefined;
    expect(validateSpec(spec, { registry: credentials, env: {} }).diagnostics.map(({ code }) => code))
      .toContain("ENV_MISSING");
    const connected = validSpec();
    connected.version = "0.2";
    const connectedModel = connected.components[0];
    if (connectedModel?.type !== "model") throw new Error("fixture");
    connectedModel.config.connectionId = "saved-provider";
    expect(validateSpec(connected, { registry: credentials, env: {} }).diagnostics.map(({ code }) => code))
      .not.toContain("ENV_MISSING");
    connectedModel.config.apiKey = "sk-connected-secret";
    expect(validateSpec(connected, { registry: credentials, env: {} }).diagnostics.map(({ code }) => code))
      .toContain("SECRET_LITERAL");
    connectedModel.config.apiKey = "env:CONNECTED_API_KEY";
    expect(validateSpec(connected, { registry: credentials, env: {} }).diagnostics.map(({ code }) => code))
      .not.toContain("ENV_MISSING");
    connectedModel.config.baseUrl = "https://user:password@example.test/v1?access_token=secret";
    expect(validateSpec(connected, { registry: credentials, env: {} }).diagnostics)
      .toContainEqual(expect.objectContaining({ code: "SECRET_LITERAL", path: "$.components[0].config.baseUrl" }));
    output.config.schema = { $schema: "https://example.invalid/schema" };
    expect(validateSpec(spec).diagnostics.map(({ code }) => code)).toContain("OUTPUT_SCHEMA_DEFINITION_INVALID");
  });

  it("compiles in topological order without studio data", () => {
    const result = compileSpec(validSpec());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.order.indexOf("model")).toBeLessThan(result.plan.order.indexOf("agent"));
    expect(result.plan.order.at(-1)).toBe("output");
    expect(JSON.stringify(result.plan)).not.toContain("positions");
  });
});

describe("adapters and runtime", () => {
  it("rejects duplicate and malformed adapters", () => {
    const registry = new AdapterRegistry().register(fakeAdapter([]));
    expect(() => registry.register(fakeAdapter([]))).toThrowError(AdapterError);
    expect(() => registry.register({ id: "BAD ID" } as ModelAdapter)).toThrowError(AdapterError);
  });

  it("streams, accumulates usage, validates JSON and records a trace", async () => {
    const called = { count: 0 };
    const registry = new AdapterRegistry().register(fakeAdapter([
      { type: "text-delta", text: '```json\n{"answer":' },
      { type: "text-delta", text: '"ok"}\n```' },
      { type: "usage", usage: { inputTokens: 3, outputTokens: 2 } },
      { type: "finish", reason: "stop", model: "test-model" },
    ], called));
    const result = await new HarnessRuntime(validSpec(), registry).invoke("question");
    expect(result.output).toEqual({ answer: "ok" });
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5 });
    expect(result.trace.some((event) => event.type === "text-delta")).toBe(true);
    expect(result.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(called.count).toBe(1);
  });

  it("publishes bounded artifact references before the final result", async () => {
    const artifact = {
      id: `artifact_${"a".repeat(24)}`,
      name: "chart.png",
      mimeType: "image/png",
      size: 128,
      sha256: "b".repeat(64),
      ref: `harnest-artifact:run/${`artifact_${"a".repeat(24)}`}`,
      preview: "image" as const,
      status: "ready" as const,
    };
    const runtime = new HarnessRuntime(validSpec(), new AdapterRegistry().register(fakeAdapter([
      { type: "text-delta", text: '{"answer":"done"}' },
      { type: "finish", reason: "stop" },
    ])), { services: { listArtifacts: () => [artifact] } });
    const result = await runtime.invoke("make a chart");
    expect(result.artifacts).toEqual([artifact]);
    const created = result.trace.findIndex((event) => event.type === "artifact-created");
    const ended = result.trace.findIndex((event) => event.type === "run-end");
    expect(created).toBeGreaterThan(0);
    expect(created).toBeLessThan(ended);
    expect(result.trace[created]).toMatchObject({ type: "artifact-created", artifact });
    expect(result.trace.slice(-2)).toEqual([
      expect.objectContaining({ type: "artifact", artifact }),
      expect.objectContaining({ type: "run-end", artifacts: [artifact] }),
    ]);
  });

  it("rejects an invalid spec before calling an adapter", () => {
    const called = { count: 0 };
    const registry = new AdapterRegistry().register(fakeAdapter([], called));
    const spec = validSpec();
    spec.connections.splice(1, 1);
    expect(() => new HarnessRuntime(spec, registry)).toThrowError(DiagnosticError);
    expect(called.count).toBe(0);
  });

  it("times out an adapter that does not produce another event", async () => {
    const adapter: ModelAdapter = {
      id: "fake",
      capabilities: { streaming: true, json: false, cancellation: true },
      async *run(_request, context) {
        await new Promise((_, reject) => context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true }));
        yield { type: "finish", reason: "unknown" };
      },
    };
    const spec = validSpec();
    const agent = spec.components[2];
    if (agent?.type !== "agent") throw new Error("fixture");
    agent.config.timeoutMs = 10;
    const events: RunEvent[] = [];
    await expect(async () => {
      for await (const event of new HarnessRuntime(spec, new AdapterRegistry().register(adapter)).stream("x")) events.push(event);
    }).rejects.toMatchObject({ code: "RUN_TIMEOUT" });
    expect(events.at(-1)).toMatchObject({ type: "error", code: "RUN_TIMEOUT" });
  });

  it("rejects incomplete/error finishes and redacts resolved secrets", async () => {
    const spec = validSpec();
    const output = spec.components[3];
    if (output?.type !== "output") throw new Error("fixture");
    output.config = { format: "text" };

    await expect(new HarnessRuntime(spec, new AdapterRegistry().register(fakeAdapter([]))).invoke("x"))
      .rejects.toMatchObject({ code: "ADAPTER_STREAM_INCOMPLETE" });
    await expect(new HarnessRuntime(spec, new AdapterRegistry().register(fakeAdapter([
      { type: "finish", reason: "error" },
    ]))).invoke("x")).rejects.toMatchObject({ code: "MODEL_FINISH_ERROR" });

    const leaking: ModelAdapter = {
      id: "fake",
      capabilities: { streaming: true, json: false, cancellation: true },
      requiredCredentials: ["env:FAKE_SECRET"],
      async *run(_request, context) {
        if (context.signal.aborted) yield { type: "finish", reason: "error" };
        throw new AdapterError(`provider echoed ${context.resolveSecret("env:FAKE_SECRET")}`, {
          adapterId: "fake",
          code: "provider_error",
          retryable: true,
        });
      },
    };
    const events: RunEvent[] = [];
    await expect(async () => {
      for await (const event of new HarnessRuntime(
        spec,
        new AdapterRegistry().register(leaking),
        { env: { FAKE_SECRET: "s3cr3t" } },
      ).stream("x")) events.push(event);
    }).rejects.not.toThrow("s3cr3t");
    expect(events.at(-1)).toMatchObject({
      type: "error",
      message: "provider echoed [REDACTED]",
      adapterId: "fake",
      retryable: true,
    });
  });

  it("runs declarative assertions", async () => {
    const spec = validSpec();
    const output = spec.components[3];
    if (output?.type !== "output") throw new Error("fixture");
    output.config = { format: "text" };
    spec.tests = [
      { id: "contains", input: "x", assertion: { type: "includes", value: "hello" } },
      { id: "matches", input: "x", assertion: { type: "matches", value: "world$" } },
    ];
    const registry = new AdapterRegistry().register(fakeAdapter([
      { type: "text-delta", text: "hello world" },
      { type: "finish", reason: "stop" },
    ]));
    const report = await runHarnessTests(spec, registry);
    expect(report).toMatchObject({ ok: true, passed: 2, failed: 0 });
  });

  it("treats JSON Schema formats as annotations without runtime warnings", async () => {
    const spec = validSpec();
    spec.version = "0.2";
    const output = spec.components[3];
    if (output?.type !== "output") throw new Error("fixture");
    output.config.schema = {
      type: "object",
      properties: { url: { type: "string", format: "uri" } },
      required: ["url"],
    };
    spec.tests = [{ id: "uri", input: "x", assertion: { type: "output-schema", schema: output.config.schema } }];
    const registry = new AdapterRegistry().register(fakeAdapter([
      { type: "text-delta", text: '{"url":"https://example.com"}' },
      { type: "finish", reason: "stop" },
    ]));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(runHarnessTests(spec, registry)).resolves.toMatchObject({ ok: true });
      expect(warning).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });
});

describe("stream parsers", () => {
  it("parses SSE fields and discards an event without a terminating blank line", async () => {
    const events = [];
    for await (const event of parseSse(stream("event: token\r", "\ndata: one\r\n\r\ndata: trailing"))) events.push(event);
    expect(events).toEqual([{ event: "token", data: "one" }]);
  });

  it("parses NDJSON split across chunks", async () => {
    const records = [];
    for await (const record of parseNdjson(stream('{"a":', "1}\n\n", '{"b":2}'))) records.push(record);
    expect(records).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("bounds provider stream lines, SSE events, total bytes, and error bodies", async () => {
    const drain = async (iterable: AsyncIterable<unknown>) => {
      for await (const value of iterable) {
        // Drain until the parser rejects the hostile input.
        void value;
      }
    };

    await expect(drain(parseNdjson(stream('{"long":true}\n'), { maxLineBytes: 8 })))
      .rejects.toThrow("line exceeds");
    await expect(drain(parseSse(stream("data: a\ndata: b\n\n"), { maxEventBytes: 12 })))
      .rejects.toThrow("SSE event exceeds");
    await expect(drain(parseNdjson(stream("{\"a\":1}\n"), { maxTotalBytes: 4 })))
      .rejects.toThrow("total limit");
    await expect(readBoundedResponseText(new Response("oversize"), 4))
      .rejects.toThrow("total limit");
  });
});

describe("node helpers", () => {
  it("atomically saves/loads specs and loads an explicit adapter module", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harnest-core-"));
    const outside = await mkdtemp(join(tmpdir(), "harnest-core-outside-"));
    try {
      const file = join(directory, "harnest.yaml");
      await saveSpecFile(file, validSpec());
      await saveSpecFile(file, validSpec());
      const loaded = await loadSpecFile(file);
      expect(loaded.ok).toBe(true);
      expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);

      const module = join(directory, "adapter.mjs");
      await writeFile(module, "export default { id: 'custom', capabilities: { streaming: true, json: false, cancellation: true }, async *run() {} };", "utf8");
      const spec = validSpec();
      spec.runtime = { adapters: ["./adapter.mjs"] };
      const registry = new AdapterRegistry();
      expect(await loadAdapterModules(spec, registry, directory))
        .toMatchObject({ ok: false, diagnostics: [{ code: "ADAPTER_MODULE_EXECUTION_DISABLED" }] });
      expect(await loadAdapterModules(spec, registry, directory, { allowModuleExecution: true }))
        .toEqual({ ok: true, diagnostics: [] });
      expect(registry.has("custom")).toBe(true);

      spec.runtime.adapters = ["data:text/javascript,export default {}"];
      expect(await loadAdapterModules(spec, new AdapterRegistry(), directory, { allowModuleExecution: true }))
        .toMatchObject({ ok: false, diagnostics: [{ code: "ADAPTER_MODULE_UNTRUSTED" }] });
      spec.runtime.adapters = ["ajv/../../outside.mjs"];
      expect(await loadAdapterModules(spec, new AdapterRegistry(), directory, { allowModuleExecution: true }))
        .toMatchObject({ ok: false, diagnostics: [{ code: "ADAPTER_MODULE_UNTRUSTED" }] });

      await writeFile(join(outside, "adapter.mjs"), "export default {};", "utf8");
      await symlink(outside, join(directory, "outside-link"), process.platform === "win32" ? "junction" : "dir");
      spec.runtime.adapters = ["./outside-link/adapter.mjs"];
      expect(await loadAdapterModules(spec, new AdapterRegistry(), directory, { allowModuleExecution: true }))
        .toMatchObject({ ok: false, diagnostics: [{ code: "ADAPTER_MODULE_UNTRUSTED" }] });
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
