import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  AdapterRegistry,
  createBuiltinComponentRegistry,
  ToolRegistry,
  type HarnessSpec,
  type ServiceExecutionContext,
} from "@harnest/core";
import {
  FileRunStore,
  loadRuntimeModules,
  NodeRuntimeServices,
  NodeToolStore,
} from "@harnest/core/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const mcpDirectory = join(root, "examples", "mcp-tool-agent");
let testRoot: string;

const context = (nodeId = "node"): ServiceExecutionContext => ({
  signal: new AbortController().signal,
  runId: "integration-run",
  nodeId,
  iteration: 0,
  resolveSecret: (reference) => reference === "env:FIXTURE_TOKEN" ? "fixture-secret" : undefined,
});

beforeAll(async () => {
  testRoot = await mkdtemp(join(root, ".test-harnest-"));
});

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

async function project(name: string): Promise<string> {
  const directory = join(testRoot, name);
  await mkdir(directory, { recursive: true });
  return directory;
}

async function cliToolProject(
  name: string,
  risk: "read" | "external",
  toolId = "custom.city",
): Promise<string> {
  const directory = await project(name);
  await writeFile(join(directory, "runtime.mjs"), `
    const adapter = {
      id: "cli-tool-agent",
      capabilities: { streaming: true, json: false, cancellation: true, tools: true },
      async *run(request, context) {
        context.signal.throwIfAborted();
        const result = [...request.messages].reverse().find((message) => message.role === "tool");
        if (!result) {
          const selected = request.tools?.[0];
          if (!selected) throw new Error("CLI did not register the connected Tool before execution");
          yield { type: "tool-call", call: { id: "city-call", name: selected.name, input: { city: "Seoul" } } };
          yield { type: "finish", reason: "tool" };
          return;
        }
        yield { type: "text-delta", text: "CLI Tool result: " + result.content };
        yield { type: "finish", reason: "stop" };
      },
    };
    export const tool = {
      id: "custom.city",
      label: "City lookup",
      description: "Return a deterministic city record",
      risk: ${JSON.stringify(risk)},
      source: "module",
      inputSchema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
        additionalProperties: false,
      },
      execute(input) { return { city: input.city, country: "South Korea" }; },
    };
    export default adapter;
  `, "utf8");
  await writeFile(join(directory, "harnest.yaml"), `
version: "0.2"
components:
  - id: city
    type: tool
    config: { tool: ${toolId}, source: module }
  - id: model
    type: model
    config: { adapter: cli-tool-agent, model: deterministic }
  - id: prompt
    type: prompt
    config: { template: "Use the connected Tool: {{input}}" }
  - id: agent
    type: agent
    config: {}
  - id: output
    type: output
    config: { format: text }
connections:
  - from: { component: city, port: tool }
    to: { component: agent, port: tools }
  - from: { component: model, port: model }
    to: { component: agent, port: model }
  - from: { component: prompt, port: prompt }
    to: { component: agent, port: prompt }
  - from: { component: agent, port: response }
    to: { component: output, port: value }
entrypoint: output
runtime:
  adapters: [./runtime.mjs]
  modules: [./runtime.mjs]
tests:
  - id: city-tool
    input: Find Seoul
    assertions:
      - { type: includes, value: South Korea }
      - { type: tool-called, tool: ${toolId}, minCalls: 1, maxCalls: 1 }
`, "utf8");
  return directory;
}

describe("Node runtime integration", () => {
  it("gates Context reads and blocks traversal, secret files, and junction escapes", async () => {
    const directory = await project("context");
    const docs = join(directory, "docs");
    const outside = await project("outside-context");
    await mkdir(docs, { recursive: true });
    await writeFile(join(docs, "guide.md"), "canonical project context", "utf8");
    await writeFile(join(directory, "public.txt"), "outside allowed root", "utf8");
    await writeFile(join(directory, ".env"), "PASSWORD=do-not-read", "utf8");
    await writeFile(join(directory, "id_ed25519"), "private-key", "utf8");
    await writeFile(join(outside, "secret.txt"), "outside-secret", "utf8");
    await symlink(outside, join(docs, "escape"), process.platform === "win32" ? "junction" : "dir");

    const denied = new NodeRuntimeServices(directory);
    await expect(denied.loadContext(
      { source: "file", path: "docs/guide.md" },
      "project",
      context(),
    )).rejects.toThrow("filesystem permission");

    const services = new NodeRuntimeServices(directory, {
      allowFileSystem: true,
      allowedContextRoots: ["docs"],
    });
    await expect(services.loadContext(
      { source: "file", path: "docs/guide.md" },
      "project",
      context(),
    )).resolves.toMatchObject({ value: "canonical project context" });
    await expect(services.loadContext(
      { source: "file", path: "public.txt" },
      "project",
      context(),
    )).rejects.toThrow("allowed Context roots");
    await expect(services.loadContext(
      { source: "file", path: "../outside-context/secret.txt" },
      "project",
      context(),
    )).rejects.toThrow("outside the Harness project");
    await expect(services.loadContext(
      { source: "file", path: ".env" },
      "project",
      context(),
    )).rejects.toThrow("common secret files");
    await expect(services.loadContext(
      { source: "file", path: "id_ed25519" },
      "project",
      context(),
    )).rejects.toThrow("common secret files");
    await expect(services.loadContext(
      { source: "file", path: "docs/escape/secret.txt" },
      "project",
      context(),
    )).rejects.toThrow("outside the Harness project");
  });

  it("persists project memory and safe, queryable NDJSON run events", async () => {
    const directory = await project("storage");
    const first = new NodeRuntimeServices(directory);
    await first.accessMemory({ key: "answer", operation: "write" }, { value: 42 }, context());
    const second = new NodeRuntimeServices(directory);
    await expect(second.accessMemory(
      { key: "answer", operation: "read" },
      undefined,
      context(),
    )).resolves.toMatchObject({ value: { value: 42 } });

    const store = new FileRunStore(directory);
    const runId = "safe-run";
    await store.append({
      type: "run-start",
      runId,
      timestamp: "2026-01-01T00:00:00.000Z",
      input: "question",
      specVersion: "0.2",
    });
    await store.append({
      type: "node-end",
      runId,
      timestamp: "2026-01-01T00:00:00.100Z",
      nodeId: "answer",
      outputs: { answer: "bounded result", apiKey: "must-not-persist" },
      stateChanges: { password: "must-not-persist", step: 1 },
      durationMs: 100,
      iteration: 0,
    });
    await store.append({
      type: "run-end",
      runId,
      timestamp: "2026-01-01T00:00:00.200Z",
      output: "bounded result",
      state: { step: 1 },
      usage: { totalTokens: 3 },
      costUsd: 0,
      iterations: 0,
      durationMs: 200,
      finishReason: "stop",
    });
    const events = await store.read(runId);
    expect(JSON.stringify(events)).toContain("bounded result");
    expect(JSON.stringify(events)).toContain("totalTokens");
    expect(JSON.stringify(events)).not.toContain("must-not-persist");
    expect(events[1]).toMatchObject({
      outputs: { answer: "bounded result", apiKey: "[REDACTED]" },
      stateChanges: { password: "[REDACTED]", step: 1 },
    });
    await expect(store.list()).resolves.toEqual([
      expect.objectContaining({ runId, status: "succeeded", eventCount: 3, durationMs: 200 }),
    ]);
  });

  it("bounds run trace reads and skips unsafe or corrupt traces", async () => {
    const directory = await project("bounded-runs");
    const store = new FileRunStore(directory);
    await store.append({
      type: "run-start",
      runId: "valid",
      timestamp: "2026-01-01T00:00:00.000Z",
      input: "safe",
      specVersion: "0.2",
    });
    const runs = join(directory, ".harnest", "runs");
    const event = (runId: string, payload = "") => JSON.stringify({
      type: "run-start",
      runId,
      timestamp: "2026-01-01T00:00:00.000Z",
      payload,
    });
    await writeFile(join(runs, "corrupt.ndjson"), "not-json\n", "utf8");
    await writeFile(join(runs, "long-line.ndjson"), `${event("long-line", "x".repeat(65_536))}\n`, "utf8");
    await writeFile(
      join(runs, "too-many.ndjson"),
      `${Array.from({ length: 10_001 }, () => event("too-many")).join("\n")}\n`,
      "utf8",
    );
    await writeFile(join(runs, "oversize.ndjson"), Buffer.alloc(8 * 1_048_576 + 1));
    const outside = await project("linked-run-outside");
    await symlink(outside, join(runs, "linked.ndjson"), process.platform === "win32" ? "junction" : "dir");
    const appendEvent = (runId: string, input: unknown = "safe") => store.append({
      type: "run-start",
      runId,
      timestamp: "2026-01-01T00:00:00.000Z",
      input,
      specVersion: "0.2",
    });

    await expect(store.read("long-line")).rejects.toThrow("64 KiB");
    await expect(store.read("too-many")).rejects.toThrow("10,000 event");
    await expect(store.read("oversize")).rejects.toThrow("8 MiB");
    await expect(store.read("linked")).rejects.toThrow("regular");
    const oversizeBytes = (await stat(join(runs, "oversize.ndjson"))).size;
    await expect(appendEvent("corrupt")).rejects.toThrow("Invalid run trace");
    await expect(appendEvent("long-line")).rejects.toThrow("64 KiB");
    await expect(appendEvent("too-many")).rejects.toThrow("10,000 event");
    await expect(appendEvent("oversize")).rejects.toThrow("8 MiB");
    await expect(appendEvent("linked")).rejects.toThrow("regular");
    await expect(appendEvent("append-long", { ["x".repeat(65_536)]: true })).rejects.toThrow("64 KiB");
    expect((await stat(join(runs, "oversize.ndjson"))).size).toBe(oversizeBytes);
    await expect(readdir(outside)).resolves.toEqual([]);
    expect(await readdir(runs)).not.toContain("append-long.ndjson");
    await expect(store.list()).resolves.toEqual([
      expect.objectContaining({ runId: "valid", eventCount: 1 }),
    ]);
    await writeFile(
      join(runs, "event-limit.ndjson"),
      `${Array.from({ length: 10_000 }, () => event("event-limit")).join("\n")}\n`,
      "utf8",
    );
    await writeFile(join(runs, "byte-limit.ndjson"), Buffer.alloc(8 * 1_048_576));
    const eventLimitBytes = (await stat(join(runs, "event-limit.ndjson"))).size;
    const byteLimitBytes = (await stat(join(runs, "byte-limit.ndjson"))).size;
    await expect(appendEvent("event-limit")).rejects.toThrow("10,000 event");
    await expect(appendEvent("byte-limit")).rejects.toThrow("8 MiB");
    expect((await stat(join(runs, "event-limit.ndjson"))).size).toBe(eventLimitBytes);
    expect((await stat(join(runs, "byte-limit.ndjson"))).size).toBe(byteLimitBytes);

    const linkedProject = await project("linked-storage");
    const linkedOutside = await project("linked-storage-outside");
    await symlink(linkedOutside, join(linkedProject, ".harnest"), process.platform === "win32" ? "junction" : "dir");
    await expect(new FileRunStore(linkedProject).list()).rejects.toThrow("unsafe link");
    await expect(readdir(linkedOutside)).resolves.toEqual([]);
  });

  it("loads custom tools only through the gated, project-bounded runtime module loader", async () => {
    const directory = await project("modules");
    const outside = await project("outside-modules");
    await writeFile(join(directory, "tool.mjs"), `
      export const tool = {
        id: "uppercase",
        label: "Uppercase",
        description: "Uppercase a value",
        inputSchema: {},
        execute: (value) => String(value).toUpperCase()
      };
      export const component = {
        type: "constant",
        label: "Constant",
        category: "Custom",
        ports: { inputs: {}, outputs: { value: { type: "any" } } },
        configSchema: {
          type: "object",
          properties: { value: {} },
          additionalProperties: false
        },
        inspector: [{ path: "value", label: "Value", control: "json" }],
        defaultConfig: { value: null },
        execute: (definition) => ({ outputs: { value: definition.config.value } })
      };
    `, "utf8");
    await writeFile(join(outside, "outside.mjs"), "export const tool = {};", "utf8");
    await symlink(outside, join(directory, "escape"), process.platform === "win32" ? "junction" : "dir");
    const spec = {
      version: "0.2",
      components: [{ id: "output", type: "output", config: {} }],
      connections: [],
      entrypoint: "output",
      runtime: { modules: ["./tool.mjs"] },
    } satisfies HarnessSpec;
    const registries = {
      adapters: new AdapterRegistry(),
      components: createBuiltinComponentRegistry(),
      tools: new ToolRegistry(),
    };
    await expect(loadRuntimeModules(spec, registries, directory)).resolves.toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "RUNTIME_MODULE_EXECUTION_DISABLED" })],
    });
    await expect(loadRuntimeModules(
      spec,
      registries,
      directory,
      { allowModuleExecution: true },
    )).resolves.toMatchObject({ ok: true });
    expect(await registries.tools.get("uppercase").execute("hello", context())).toBe("HELLO");
    expect(registries.components.has("constant")).toBe(true);

    await writeFile(join(directory, "harnest.yaml"), `
version: "0.2"
components:
  - id: custom
    type: constant
    config: { value: custom-component-ran }
  - id: output
    type: output
    config: { format: text }
connections:
  - from: { component: custom, port: value }
    to: { component: output, port: value }
entrypoint: output
runtime:
  modules: [./tool.mjs]
`, "utf8");
    const customRun = await exec(process.execPath, [
      cli,
      "run",
      join(directory, "harnest.yaml"),
      "--input",
      "ignored",
      "--allow-modules",
    ], { cwd: root });
    expect(customRun.stdout).toContain("custom-component-ran");

    const escaped = { ...spec, runtime: { modules: ["./escape/outside.mjs"] } } satisfies HarnessSpec;
    await expect(loadRuntimeModules(
      escaped,
      {
        adapters: new AdapterRegistry(),
        components: createBuiltinComponentRegistry(),
        tools: new ToolRegistry(),
      },
      directory,
      { allowModuleExecution: true },
    )).resolves.toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "RUNTIME_MODULE_UNTRUSTED" })],
    });
  });

  it("executes reviewed raw stdio MCP and keeps raw HTTP host-gated", async () => {
    const services = new NodeRuntimeServices(mcpDirectory, {
      allowProcessCommands: ["node"],
    });
    try {
      await expect(services.callMcpTool(
        {
          transport: "stdio",
          protocol: "legacy",
          command: "node",
          args: ["server.mjs"],
          tool: "lookup-city",
        },
        { city: "Seoul" },
        context("stdio-raw"),
      )).resolves.toMatchObject({ value: { city: "Seoul", country: "South Korea" } });
    } finally {
      await services.close();
    }
    const denied = new NodeRuntimeServices(mcpDirectory);
    try {
      await expect(denied.callMcpTool(
        { transport: "http", protocol: "2026-07-28", url: "http://127.0.0.1:12345/mcp", tool: "lookup-city" },
        { city: "Seoul" },
        context("http-raw"),
      )).rejects.toThrow("not explicitly allowed");
    } finally {
      await denied.close();
    }
  });
});

describe("harnest CLI", () => {
  it("does not validate a graph whose saved Connection is missing", async () => {
    const directory = await project("cli-missing-connection");
    const spec = join(directory, "harnest.yaml");
    await writeFile(spec, `
version: "0.2"
components:
  - { id: model, type: model, config: { connectionId: missing_provider } }
  - { id: prompt, type: prompt, config: { template: "{{input}}" } }
  - { id: agent, type: agent, config: {} }
  - { id: output, type: output, config: {} }
connections:
  - { from: { component: model, port: model }, to: { component: agent, port: model } }
  - { from: { component: prompt, port: prompt }, to: { component: agent, port: prompt } }
  - { from: { component: agent, port: response }, to: { component: output, port: value } }
entrypoint: output
`, "utf8");
    await expect(exec(process.execPath, [cli, "validate", spec], { cwd: root })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("CONNECTION_NOT_FOUND"),
    });
  });

  it("validates, runs, lists, and reads a persisted trace", async () => {
    const directory = await project("cli");
    await cp(join(root, "examples", "custom-adapter", "echo-adapter.mjs"), join(directory, "echo-adapter.mjs"));
    await cp(join(root, "examples", "custom-adapter", "harnest.yaml"), join(directory, "harnest.yaml"));
    const spec = join(directory, "harnest.yaml");
    await expect(exec(process.execPath, [cli, "validate", spec], { cwd: root }))
      .rejects.toMatchObject({ code: 1 });
    const validated = await exec(process.execPath, [cli, "validate", spec, "--allow-modules"], { cwd: root });
    expect(validated.stdout).toContain("Valid:");

    const executed = await exec(process.execPath, [
      cli,
      "run",
      spec,
      "--input",
      "hello",
      "--allow-modules",
    ], { cwd: root });
    expect(executed.stdout).toContain("Echo:");
    expect(executed.stdout).toContain("tokens ");
    const runId = /^runId (.+)$/mu.exec(executed.stdout)?.[1];
    expect(runId).toBeTruthy();

    const listed = await exec(process.execPath, [cli, "runs", spec], { cwd: root });
    expect(listed.stdout).toContain(`${runId}\tsucceeded`);
    const traced = await exec(process.execPath, [cli, "trace", runId!, spec, "--json"], { cwd: root });
    expect(JSON.parse(traced.stdout)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "run-end", runId }),
    ]));
  });

  it("runs the RAG, v1.1 MCP, safe custom Tool, and evaluation Loop examples end to end", async () => {
    const examples = await project("examples");
    const rag = join(examples, "rag");
    const mcp = join(examples, "mcp-tool-agent");
    const tool = await cliToolProject("examples-read-tool", "read");
    const loop = join(examples, "evaluation-loop");
    await cp(join(root, "examples", "rag"), rag, { recursive: true });
    await cp(join(root, "examples", "mcp-tool-agent"), mcp, { recursive: true });
    await cp(join(root, "examples", "evaluation-loop"), loop, { recursive: true });

    const ragRun = await exec(process.execPath, [
      cli,
      "run",
      join(rag, "harnest.yaml"),
      "--input",
      "How are Context paths protected?",
      "--allow-files",
      "--context-root",
      "knowledge",
      "--allow-modules",
    ], { cwd: root });
    expect(ragRun.stdout).toContain("realpath");

    const mcpRun = await exec(process.execPath, [
      cli,
      "run",
      join(mcp, "harnest.yaml"),
      "--input",
      "Which country contains the configured city?",
      "--allow-process",
      "node",
      "--allow-modules",
      "--approve-tool",
      "lookup-city",
    ], { cwd: root });
    expect(mcpRun.stdout).toContain("South Korea");
    const mcpTest = await exec(process.execPath, [
      cli, "test", join(mcp, "harnest.yaml"), "--allow-process", "node", "--allow-modules", "--approve-tool", "lookup-city",
    ], { cwd: root });
    expect(mcpTest.stdout).toContain("PASS finds-seoul");

    const toolRun = await exec(process.execPath, [
      cli,
      "run",
      join(tool, "harnest.yaml"),
      "--input",
      "Find Seoul",
      "--allow-modules",
    ], { cwd: root });
    expect(toolRun.stdout).toContain("South Korea");

    const loopRun = await exec(process.execPath, [
      cli,
      "run",
      join(loop, "harnest.yaml"),
      "--input",
      "Draft answer",
      "--allow-modules",
    ], { cwd: root });
    expect(loopRun.stdout).toContain("[PASS]");
    expect(loopRun.stdout).toContain("iterations 2");
  });

  it("denies risky Tools in non-TTY runs unless the exact id is pre-approved", async () => {
    const directory = await cliToolProject("cli-tool-approval", "external");
    const spec = join(directory, "harnest.yaml");
    const denied = await exec(process.execPath, [
      cli, "run", spec, "--input", "Find Seoul", "--allow-modules",
    ], { cwd: root });
    expect(denied.stdout).toContain("requires explicit approval");
    expect(denied.stdout).not.toContain("South Korea");

    const wrongId = await exec(process.execPath, [
      cli, "run", spec, "--input", "Find Seoul", "--allow-modules", "--approve-tool", "custom.other",
    ], { cwd: root });
    expect(wrongId.stdout).toContain("requires explicit approval");
    expect(wrongId.stdout).not.toContain("South Korea");

    const approved = await exec(process.execPath, [
      cli, "run", spec, "--input", "Find Seoul", "--allow-modules", "--approve-tool", "custom.city",
    ], { cwd: root });
    expect(approved.stdout).toContain("South Korea");

    const tested = await exec(process.execPath, [
      cli, "test", spec, "--allow-modules", "--approve-tool", "custom.city",
    ], { cwd: root });
    expect(tested.stdout).toContain("PASS city-tool");
    expect(tested.stdout).toContain("1 passed, 0 failed");

    await expect(exec(process.execPath, [
      cli, "run", spec, "--input", "Find Seoul", "--allow-modules", "--approve-tool", "*",
    ], { cwd: root })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("requires an exact Tool id"),
    });
  });

  it("registers stored Tool definitions for validation and reuses the module-enabled Node service", async () => {
    const directory = await cliToolProject("cli-stored-tool", "read", "custom.stored-city");
    await writeFile(join(directory, "stored-tool.mjs"), `
      export default function storedCity(input) {
        return { city: input.city, country: "South Korea", source: "stored Tool" };
      }
    `, "utf8");
    await new NodeToolStore({ projectDirectory: directory }).save({
      manifestVersion: "1",
      id: "custom.stored-city",
      label: "Stored city lookup",
      description: "Execute a reviewed project TypeScript Tool",
      inputSchema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          city: { type: "string" },
          country: { type: "string" },
          source: { type: "string" },
        },
        required: ["city", "country", "source"],
        additionalProperties: false,
      },
      risk: "destructive",
      kind: "typescript-module",
      source: "module",
      module: "./stored-tool.mjs",
      exportName: "default",
    });
    const spec = join(directory, "harnest.yaml");
    const executed = await exec(process.execPath, [
      cli,
      "run",
      spec,
      "--input",
      "Find Seoul",
      "--allow-modules",
      "--approve-tool",
      "custom.stored-city",
    ], { cwd: root });
    expect(executed.stdout).toContain("South Korea");
    expect(executed.stdout).toContain("stored Tool");
  });

  it("returns a failure for an invalid graph", async () => {
    await expect(exec(process.execPath, [cli, "validate", "examples/invalid/harnest.yaml"], {
      cwd: root,
    })).rejects.toMatchObject({ code: 1 });
  });
});
