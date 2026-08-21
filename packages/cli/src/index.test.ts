import { spawn, execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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

  it("discovers and calls a real MCP stdio server with an exact command allowlist", async () => {
    const denied = new NodeRuntimeServices(mcpDirectory);
    await expect(denied.callMcpTool(
      {
        transport: "stdio",
        protocol: "legacy",
        command: process.execPath,
        args: ["server.mjs"],
        tool: "lookup-city",
      },
      { city: "Seoul" },
      context("stdio-denied"),
    )).rejects.toThrow("not explicitly allowed");

    const services = new NodeRuntimeServices(mcpDirectory, {
      allowProcessCommands: [process.execPath],
    });
    try {
      await expect(services.callMcpTool(
        {
          transport: "stdio",
          protocol: "legacy",
          command: process.execPath,
          args: ["server.mjs"],
          tool: "lookup-city",
        },
        { city: "Seoul" },
        context("stdio-success"),
      )).resolves.toMatchObject({
        value: { city: "Seoul", country: "South Korea" },
        metadata: { transport: "stdio", tool: "lookup-city", isError: false },
      });
      await expect(services.callMcpTool(
        {
          transport: "stdio",
          protocol: "legacy",
          command: process.execPath,
          args: ["server.mjs"],
          tool: "fail-city",
        },
        {},
        context("stdio-error"),
      )).rejects.toThrow("returned an error result");
    } finally {
      await services.close();
    }
  });

  it("discovers and calls a real modern MCP Streamable HTTP server behind a host allowlist", async () => {
    const child = spawn(process.execPath, [join(mcpDirectory, "http-server.mjs")], {
      cwd: mcpDirectory,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const port = await new Promise<number>((resolvePort, reject) => {
      const timeout = setTimeout(() => reject(new Error("HTTP MCP fixture did not start")), 10_000);
      let output = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
        const match = /PORT (\d+)/u.exec(output);
        if (match?.[1]) {
          clearTimeout(timeout);
          resolvePort(Number(match[1]));
        }
      });
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`HTTP MCP fixture exited with ${code}`)));
    });
    const url = `http://127.0.0.1:${port}/mcp`;
    const denied = new NodeRuntimeServices(mcpDirectory);
    await expect(denied.callMcpTool(
      { transport: "http", protocol: "2026-07-28", url, tool: "lookup-city" },
      { city: "Seoul" },
      context("http-denied"),
    )).rejects.toThrow("not explicitly allowed");

    const services = new NodeRuntimeServices(mcpDirectory, {
      allowNetworkHosts: [`127.0.0.1:${port}`],
    });
    try {
      await expect(services.callMcpTool(
        {
          transport: "http",
          protocol: "2026-07-28",
          url,
          tool: "lookup-city",
          headers: { authorization: "Bearer literal-secret" },
        },
        { city: "Seoul" },
        context("http-literal-header"),
      )).rejects.toThrow("env:NAME secret reference");
      await expect(services.callMcpTool(
        { transport: "http", protocol: "2026-07-28", url, tool: "lookup-city" },
        { city: "Seoul" },
        context("http-success"),
      )).resolves.toMatchObject({
        value: { city: "Seoul", country: "South Korea" },
        metadata: { transport: "http", protocol: "2026-07-28", isError: false },
      });
    } finally {
      await services.close();
      child.kill();
    }
  });
});

describe("harnest CLI", () => {
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

  it("runs the RAG, MCP Tool Agent, and evaluation Loop examples end to end", async () => {
    const examples = await project("examples");
    const rag = join(examples, "rag");
    const mcp = join(examples, "mcp-tool-agent");
    const loop = join(examples, "evaluation-loop");
    await cp(join(root, "examples", "rag"), rag, { recursive: true });
    await cp(mcpDirectory, mcp, { recursive: true });
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
      "ignored",
      "--allow-process",
      "node",
      "--allow-modules",
    ], { cwd: root });
    expect(mcpRun.stdout).toContain("South Korea");

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

  it("returns a failure for an invalid graph", async () => {
    await expect(exec(process.execPath, [cli, "validate", "examples/invalid/harnest.yaml"], {
      cwd: root,
    })).rejects.toMatchObject({ code: 1 });
  });
});
