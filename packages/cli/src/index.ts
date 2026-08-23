#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { crc32 } from "node:zlib";
import { anthropicAdapter } from "@harnest/adapter-anthropic";
import { geminiAdapter } from "@harnest/adapter-gemini";
import { ollamaAdapter } from "@harnest/adapter-local";
import { openAIAdapter } from "@harnest/adapter-openai";
import { Harnest } from "@harnest/sdk";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import {
  AdapterRegistry,
  compileSpec,
  createBuiltinComponentRegistry,
  DEFAULT_PROVIDER_MODELS,
  DEFAULT_SANDBOX_IMAGES,
  FIRECRAWL_CONNECTION_CONFIG,
  HarnessRuntime,
  runHarnessTests,
  SEARXNG_CONNECTION_CONFIG,
  ToolRegistry,
  validateSpec,
  type ConnectionProfile,
  type Diagnostic,
  type HarnessSpec,
  type RunEndEvent,
  type ToolApprovalRequest,
  type TokenUsage,
} from "@harnest/core";
import {
  FileRunStore,
  ConnectionManager,
  detectContainerEngine,
  guardedFetch,
  loadAdapterModules,
  loadRuntimeModules,
  loadSpecFile,
  saveSpecFile,
  NodeRuntimeServices,
  NodeSkillStore,
  materializeRemoteSkill,
  remoteSkillSourceLabel,
  resolveRemoteSkillSource,
  skillInstallSourceKey,
  type NodeRuntimeServiceOptions,
} from "@harnest/core/node";

const HELP = `Harnest Visual AI Agent Harness

Usage:
  harnest init [directory]
  harnest bundle [file] [--output <file>]
  harnest validate <file>
  harnest inspect <file>
  harnest run <file> --input <value> [capabilities]
  harnest test <file> [capabilities]
  harnest runs [file] [--limit <number>]
  harnest trace <run-id> [file] [--json]
  harnest connections [file] [--json]
  harnest connect <preset> [file] [options]
  harnest connection <test|login|disconnect|revoke|delete> <id> [file]
  harnest skill <list|install|review|approve> [value] [file]
  harnest serve [file] [--port <number>] [capabilities]
  harnest mcp serve [file] [capabilities]
  harnest studio [file] [--port <number>]

Connection presets:
  gemini, openai, anthropic, ollama, provider, firecrawl, searxng,
  mcp-http, mcp-stdio, http, sandbox

Connect options:
  --id <id> --name <label> --scope <project|user> --model <id>
  --adapter <id> --url <https-url> --secret-env <ENV_NAME>
  --runtime <node|python> --image <image> --command <command> --arg <value>
  --auth <oauth|token|none> --config <json>

Secrets are read from --secret-env or a hidden TTY prompt and saved to the OS vault.

Runtime capabilities (denied by default):
  --allow-modules               Execute reviewed adapter/component/tool modules
  --allow-files                 Read non-secret Context files inside the project
  --context-root <path>         Restrict Context reads to a project-relative root (repeatable)
  --allow-process <command>     Allow one exact reviewed legacy local Tool command (repeatable)
  --allow-network <host>        Allow one exact MCP HTTP host[:port] (repeatable)
  --approve-tool <id>           Pre-approve one exact risky Tool id (repeatable)

Risky Tools otherwise prompt once per call in a TTY and are denied in non-interactive runs.
`;

const shippedAdapters = [openAIAdapter, anthropicAdapter, geminiAdapter, ollamaAdapter] as const;

async function init(directoryValue: string): Promise<void> {
  const directory = resolve(directoryValue);
  const file = join(directory, "harnest.yaml");
  await mkdir(directory, { recursive: true });
  try {
    await stat(file);
    throw new Error(`Refusing to replace existing ${file}`);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  const spec: HarnessSpec = {
    version: "0.2",
    components: [
      {
        id: "model",
        type: "model",
        config: {
          connectionId: "gemini-main",
          adapter: "gemini",
          model: DEFAULT_PROVIDER_MODELS.gemini,
          temperature: 0.2,
        },
      },
      { id: "prompt", type: "prompt", config: { template: "Answer this request clearly:\n\n{{input}}" } },
      { id: "agent", type: "agent", config: { system: "Be accurate, concise, and explicit about uncertainty." } },
      { id: "output", type: "output", config: { format: "text" } },
    ],
    connections: [
      { from: { component: "model", port: "model" }, to: { component: "agent", port: "model" } },
      { from: { component: "prompt", port: "prompt" }, to: { component: "agent", port: "prompt" } },
      { from: { component: "agent", port: "response" }, to: { component: "output", port: "value" } },
    ],
    entrypoint: "output",
    runtime: { timeoutMs: 60_000 },
    studio: {
      positions: {
        model: { x: 80, y: 80 },
        prompt: { x: 80, y: 260 },
        agent: { x: 430, y: 170 },
        output: { x: 780, y: 170 },
      },
    },
  };
  await saveSpecFile(file, spec);
  console.log(`Created ${file}`);
  console.log(`Next: harnest connect gemini "${file}" --id gemini-main`);
  console.log(`Then: harnest studio "${file}"`);
}

interface BundleEntry {
  readonly name: string;
  readonly content: Buffer;
}

const MAX_BUNDLE_FILES = 1_000;
const MAX_BUNDLE_BYTES = 64 * 1_048_576;

const inside = (root: string, target: string) => {
  const path = relative(root, target);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

async function bundleEntries(file: string): Promise<{ project: string; entries: BundleEntry[] }> {
  const requested = resolve(file);
  const link = await lstat(requested);
  if (link.isSymbolicLink() || !link.isFile()) throw new Error("Harness bundle source must be a regular file, not a link");
  const absolute = await realpath(requested);
  const project = await realpath(dirname(absolute));
  const entries: BundleEntry[] = [{ name: "harnest.yaml", content: await readFile(absolute) }];
  let totalBytes = entries[0]!.content.byteLength;
  const assets = join(project, "assets");
  const walk = async (directory: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const path = join(directory, child.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error(`Bundle assets cannot contain links: ${path}`);
      if (info.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!info.isFile()) throw new Error(`Bundle assets must be regular files: ${path}`);
      const canonical = await realpath(path);
      if (!inside(assets, canonical)) throw new Error(`Bundle asset is outside ${assets}`);
      const name = relative(project, canonical).split(sep).join("/");
      const content = await readFile(canonical);
      const current = await lstat(path);
      if (current.isSymbolicLink() || await realpath(path) !== canonical) throw new Error(`Bundle asset changed during packaging: ${path}`);
      if (name.includes("\\") || name.includes(":") || name.startsWith("/")
        || name.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
        throw new Error(`Bundle asset has an unsafe archive path: ${path}`);
      }
      entries.push({ name, content });
      totalBytes += content.byteLength;
      if (entries.length > MAX_BUNDLE_FILES) throw new Error(`Bundle exceeds ${MAX_BUNDLE_FILES} files`);
      if (totalBytes > MAX_BUNDLE_BYTES) {
        throw new Error(`Bundle exceeds ${MAX_BUNDLE_BYTES} bytes`);
      }
    }
  };
  try {
    const assetsInfo = await lstat(assets);
    if (assetsInfo.isSymbolicLink() || !assetsInfo.isDirectory()) throw new Error("Project assets must be a regular directory, not a link");
    await walk(await realpath(assets));
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (totalBytes > MAX_BUNDLE_BYTES) {
    throw new Error(`Bundle exceeds ${MAX_BUNDLE_BYTES} bytes`);
  }
  return { project, entries };
}

function zip(entries: readonly BundleEntry[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    if (name.byteLength > 65_535 || entry.content.byteLength > 0xffff_ffff) throw new Error(`Bundle entry is too large: ${entry.name}`);
    const checksum = crc32(entry.content) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(33, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(entry.content.byteLength, 18);
    header.writeUInt32LE(entry.content.byteLength, 22);
    header.writeUInt16LE(name.byteLength, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x0800, 8);
    directory.writeUInt16LE(0, 10);
    directory.writeUInt16LE(0, 12);
    directory.writeUInt16LE(33, 14);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(entry.content.byteLength, 20);
    directory.writeUInt32LE(entry.content.byteLength, 24);
    directory.writeUInt16LE(name.byteLength, 28);
    directory.writeUInt32LE(offset, 42);
    local.push(header, name, entry.content);
    central.push(directory, name);
    offset += header.byteLength + name.byteLength + entry.content.byteLength;
  }
  const centralSize = central.reduce((total, part) => total + part.byteLength, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

async function bundle(file: string, outputValue: string | undefined): Promise<void> {
  const parsed = await loadSpecFile(resolve(file));
  if (!parsed.ok) {
    printDiagnostics(parsed.diagnostics);
    throw new Error("Spec could not be loaded");
  }
  const validation = validateSpec(parsed.spec);
  if (!validation.ok) {
    printDiagnostics(validation.diagnostics);
    throw new Error("Spec is invalid");
  }
  const { project, entries } = await bundleEntries(file);
  const output = outputValue ? resolve(outputValue) : join(project, `${basename(project)}.harnest`);
  try {
    await writeFile(output, zip(entries), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw new Error(`Refusing to replace existing ${output}`, { cause: error });
    }
    throw error;
  }
  console.log(`Bundled ${entries.length} file${entries.length === 1 ? "" : "s"}: ${output}`);
}

function printDiagnostics(diagnostics: Diagnostic[]): void {
  for (const diagnostic of diagnostics) {
    const component = diagnostic.componentId ? ` [${diagnostic.componentId}]` : "";
    console.error(`${diagnostic.severity.toUpperCase()} ${diagnostic.code} ${diagnostic.path}${component}: ${diagnostic.message}`);
    if (diagnostic.hint) console.error(`  ${diagnostic.hint}`);
  }
}

async function load(file: string, options: {
  checkEnvironment?: boolean;
  loadModules?: boolean;
  allowModules?: boolean;
  nodeServices?: NodeRuntimeServiceOptions;
} = {}) {
  const { checkEnvironment = false, loadModules = true, allowModules = false, nodeServices = {} } = options;
  const absolute = resolve(file);
  const parsed = await loadSpecFile(absolute);
  if (!parsed.ok) {
    printDiagnostics(parsed.diagnostics);
    throw new Error("Spec could not be loaded");
  }

  const adapters = new AdapterRegistry();
  const components = createBuiltinComponentRegistry();
  const tools = new ToolRegistry();
  const services = new NodeRuntimeServices(dirname(absolute), {
    ...nodeServices,
    ...(allowModules ? { allowModuleExecution: true as const } : {}),
  });
  try {
    for (const definition of await services.toolDefinitions()) {
      if (!tools.has(definition.id)) tools.register(definition);
    }
    if (loadModules) {
      const adapterResult = await loadAdapterModules(
        parsed.spec,
        adapters,
        dirname(absolute),
        ...(allowModules ? [{ allowModuleExecution: true as const }] : []),
      );
      const runtimeResult = await loadRuntimeModules(
        parsed.spec,
        { adapters, components, tools },
        dirname(absolute),
        ...(allowModules ? [{ allowModuleExecution: true as const }] : []),
      );
      const diagnostics = [...adapterResult.diagnostics, ...runtimeResult.diagnostics];
      if (diagnostics.length > 0) {
        printDiagnostics(diagnostics);
        throw new Error("Runtime modules could not be loaded");
      }
    }
    for (const adapter of shippedAdapters) if (!adapters.has(adapter.id)) adapters.register(adapter);

    const validation = validateSpec(parsed.spec, {
      ...(loadModules ? { registry: adapters, components, tools } : {}),
      ...(checkEnvironment ? { env: process.env } : {}),
    });
    const diagnostics = [...validation.diagnostics, ...await services.connectionDiagnostics(parsed.spec, tools)];
    if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      printDiagnostics(diagnostics);
      throw new Error("Spec is invalid");
    }
    printDiagnostics(diagnostics.filter((diagnostic) => diagnostic.severity === "warning"));
    return { spec: parsed.spec, adapters, components, tools, services, absolute };
  } catch (error) {
    await services.close();
    throw error;
  }
}

async function validate(file: string, allowModules: boolean): Promise<void> {
  const loaded = await load(file, { checkEnvironment: true, allowModules });
  try {
    console.log(`Valid: ${resolve(file)}`);
  } finally {
    await loaded.services.close();
  }
}

async function inspect(file: string, allowModules: boolean): Promise<void> {
  const { spec, adapters, components, tools, services } = await load(file, { allowModules });
  try {
    const compiled = compileSpec(spec, { registry: adapters, components, tools });
    if (!compiled.ok) {
      printDiagnostics(compiled.diagnostics);
      throw new Error("Spec could not be compiled");
    }
    console.log(JSON.stringify(compiled.plan, null, 2));
  } finally {
    await services.close();
  }
}

function inputValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function usageText(usage: TokenUsage): string {
  return `${usage.inputTokens ?? 0} in / ${usage.outputTokens ?? 0} out / ${usage.totalTokens ?? 0} total`;
}

interface CapabilityValues {
  "allow-modules"?: boolean;
  "allow-files"?: boolean;
  "context-root"?: string[];
  "allow-process"?: string[];
  "allow-network"?: string[];
  "approve-tool"?: string[];
}

const capabilityOptions = {
  "allow-modules": { type: "boolean" as const },
  "allow-files": { type: "boolean" as const },
  "context-root": { type: "string" as const, multiple: true },
  "allow-process": { type: "string" as const, multiple: true },
  "allow-network": { type: "string" as const, multiple: true },
  "approve-tool": { type: "string" as const, multiple: true },
};

const TOOL_ID = /^[a-z][a-z0-9._-]{0,127}$/;

function approvedToolIds(values: CapabilityValues): string[] {
  const ids = [...new Set(values["approve-tool"] ?? [])];
  const invalid = ids.find((id) => !TOOL_ID.test(id));
  if (invalid) throw new Error(`--approve-tool requires an exact Tool id; received '${invalid}'`);
  return ids;
}

function approvalInput(request: ToolApprovalRequest): string {
  try {
    return JSON.stringify(request.input, null, 2) ?? "undefined";
  } catch {
    return "[unserializable input]";
  }
}

function serviceOptions(values: CapabilityValues): NodeRuntimeServiceOptions {
  const approved = approvedToolIds(values);
  const interactive = process.stdin.isTTY === true && process.stderr.isTTY === true;
  return {
    ...(values["allow-modules"] ? { allowModuleExecution: true as const } : {}),
    ...(values["allow-files"] ? { allowFileSystem: true as const } : {}),
    ...(values["context-root"]?.length ? { allowedContextRoots: values["context-root"] } : {}),
    ...(values["allow-process"]?.length ? { allowProcessCommands: values["allow-process"] } : {}),
    ...(values["allow-network"]?.length ? { allowNetworkHosts: values["allow-network"] } : {}),
    ...(approved.length ? { approvedToolIds: approved } : {}),
    ...(interactive ? {
      requestToolApproval: async (request, context) => {
        process.stderr.write([
          "\nTool approval requested",
          `tool  ${request.tool.id}`,
          ...(request.tool.connectionId ? [`connection  ${request.tool.connectionId}`] : []),
          ...(request.tool.action ? [`action  ${request.tool.action}`] : []),
          `risk  ${request.tool.risk ?? "external"}`,
          `call  ${request.callId} · turn ${request.turn}`,
          "input",
          approvalInput(request),
          "",
        ].join("\n"));
        const terminal = createInterface({ input: process.stdin, output: process.stderr });
        try {
          const answer = await terminal.question("Approve this call once? [y/N] ", { signal: context.signal });
          const permitted = /^(?:y|yes)$/i.test(answer.trim());
          return permitted
            ? { approved: true, source: "user" }
            : { approved: false, source: "user", reason: "Denied by the CLI operator" };
        } catch (error) {
          if (!context.signal.aborted) throw error;
          return { approved: false, source: "policy", reason: "Run cancelled before approval" };
        } finally {
          terminal.close();
        }
      },
    } : {}),
  };
}

async function run(file: string, rawInput: string, capabilities: CapabilityValues): Promise<void> {
  const { spec, adapters, components, tools, services, absolute } = await load(file, {
    checkEnvironment: true,
    allowModules: capabilities["allow-modules"] ?? false,
    nodeServices: serviceOptions(capabilities),
  });
  const project = dirname(absolute);
  const store = new FileRunStore(project);
  let end: RunEndEvent | undefined;
  let streamedText = "";
  try {
    const runtime = new HarnessRuntime(spec, adapters, {
      env: process.env,
      components,
      tools,
      services,
      eventSink: store,
    });
    for await (const event of runtime.stream(inputValue(rawInput))) {
      if (event.type === "text-delta") {
        streamedText += event.text;
        process.stdout.write(event.text);
      }
      if (event.type === "run-end") end = event;
    }
  } finally {
    await services.close();
  }

  if (!end) throw new Error("Runtime ended without a result");
  if (streamedText) process.stdout.write("\n");
  const finalOutput = typeof end.output === "string" ? end.output : JSON.stringify(end.output, null, 2);
  if (!streamedText) console.log(finalOutput);
  else if (streamedText !== end.output) console.log(`output ${finalOutput}`);
  console.log(`runId ${end.runId}`);
  console.log(`duration ${Math.round(end.durationMs)}ms`);
  console.log(`iterations ${end.iterations}`);
  console.log(`tokens ${usageText(end.usage)}`);
  console.log(`cost $${end.costUsd.toFixed(6)}`);
}

async function test(file: string, capabilities: CapabilityValues): Promise<void> {
  const { spec, adapters, components, tools, services, absolute } = await load(file, {
    checkEnvironment: true,
    allowModules: capabilities["allow-modules"] ?? false,
    nodeServices: serviceOptions(capabilities),
  });
  const project = dirname(absolute);
  const store = new FileRunStore(project);
  try {
    const report = await runHarnessTests(spec, adapters, {
      env: process.env,
      components,
      tools,
      services,
      eventSink: store,
    });
    for (const testCase of report.cases) {
      console.log(`${testCase.ok ? "PASS" : "FAIL"} ${testCase.id} ${Math.round(testCase.durationMs)}ms`);
      if (testCase.error) console.error(`  ${testCase.error}`);
    }
    console.log(`${report.passed} passed, ${report.failed} failed`);
    if (!report.ok) throw new Error(`${report.failed} harness test(s) failed`);
  } finally {
    await services.close();
  }
}

const parsedPort = (value: string, command: string): number => {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${command} --port must be an integer from 1 to 65535`);
  }
  return port;
};

const sdkOptions = (capabilities: CapabilityValues) => ({
  allowModuleExecution: capabilities["allow-modules"] ?? false,
  services: serviceOptions(capabilities),
});

async function requestInput(request: import("node:http").IncomingMessage): Promise<unknown> {
  if (!request.headers["content-type"]?.toLocaleLowerCase().startsWith("application/json")) {
    throw new Error("Request body must use application/json");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > 1_048_576) throw new Error("Request body exceeds 1 MiB");
    chunks.push(buffer);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Request body must be an object");
  const record = body as { input?: unknown; message?: unknown };
  if (Object.hasOwn(record, "input")) return record.input;
  if (typeof record.message === "string") return record.message;
  throw new Error("Request body requires input or message");
}

function writeJson(response: import("node:http").ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

async function serve(file: string, portValue: string, capabilities: CapabilityValues): Promise<void> {
  const port = parsedPort(portValue, "serve");
  const harness = await Harnest.load(file, sdkOptions(capabilities));
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (request.method === "GET" && pathname === "/health") {
      writeJson(response, 200, { ok: true, file: harness.file });
      return;
    }
    if (request.method !== "POST" || (pathname !== "/invoke" && pathname !== "/stream")) {
      writeJson(response, pathname === "/health" || pathname === "/invoke" || pathname === "/stream" ? 405 : 404, {
        ok: false,
        error: pathname === "/health" || pathname === "/invoke" || pathname === "/stream"
          ? "Method not allowed"
          : "Not found",
      });
      return;
    }
    let input: unknown;
    try {
      input = await requestInput(request);
    } catch (error) {
      writeJson(response, 400, { ok: false, error: error instanceof Error ? error.message : "Invalid request" });
      return;
    }
    const controller = new AbortController();
    response.once("close", () => controller.abort(new Error("Client disconnected")));
    if (pathname === "/stream") {
      response.writeHead(200, {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-content-type-options": "nosniff",
      });
      try {
        for await (const event of harness.stream(input, { signal: controller.signal })) {
          response.write(`${JSON.stringify(event)}\n`);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          console.error(error);
          response.write(`${JSON.stringify({ type: "error", message: "Harness invocation failed" })}\n`);
        }
      } finally {
        response.end();
      }
      return;
    }
    try {
      writeJson(response, 200, { ok: true, ...await harness.invoke(input, { signal: controller.signal }), trace: undefined });
    } catch (error) {
      if (!controller.signal.aborted) console.error(error);
      if (!response.headersSent) writeJson(response, 500, { ok: false, error: "Harness invocation failed" });
    }
  });
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolveListen());
    });
    console.log(`Harnest API ready at http://127.0.0.1:${port}`);
    console.log("POST /invoke or /stream with {\"input\": ...}");
    await new Promise<void>((resolveStop) => {
      process.once("SIGINT", resolveStop);
      process.once("SIGTERM", resolveStop);
    });
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await harness.close();
  }
}

const resultText = (value: unknown): string => typeof value === "string" ? value : JSON.stringify(value, null, 2);

async function mcpServe(file: string, capabilities: CapabilityValues): Promise<void> {
  const harness = await Harnest.load(file, sdkOptions(capabilities));
  const handle = serveStdio(() => {
    const server = new McpServer(
      { name: "harnest", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );
    server.registerTool("invoke_harness", {
      title: "Invoke harness",
      description: "Run the configured Harnest agent and return its final result.",
      inputSchema: z.object({
        message: z.string().optional().describe("A plain-text request for the harness"),
        input: z.unknown().optional().describe("A structured harness input"),
      }),
    }, async ({ message, input }) => {
      try {
        const result = await harness.invoke(input === undefined ? message ?? {} : input);
        const structuredContent = {
          runId: result.runId,
          output: result.output,
          usage: result.usage,
          costUsd: result.costUsd,
          durationMs: result.durationMs,
        };
        return {
          content: [{ type: "text", text: resultText(result.output) }],
          structuredContent,
        };
      } catch (error) {
        console.error(error);
        return { isError: true, content: [{ type: "text", text: "Harness invocation failed" }] };
      }
    });
    return server;
  }, { onerror: (error) => console.error(error) });
  console.error(`Serving ${resolve(file)} as MCP Tool 'invoke_harness' over stdio`);
  try {
    await new Promise<void>((resolveStop) => {
      process.stdin.once("end", resolveStop);
      process.once("SIGINT", resolveStop);
      process.once("SIGTERM", resolveStop);
    });
  } finally {
    await handle.close();
    await harness.close();
  }
}

async function runs(file: string, limit: string): Promise<void> {
  const parsedLimit = Number(limit);
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 500) {
    throw new Error("runs --limit must be an integer from 1 to 500");
  }
  const store = new FileRunStore(dirname(resolve(file)));
  const summaries = await store.list(parsedLimit);
  if (summaries.length === 0) {
    console.log("No stored runs.");
    return;
  }
  for (const summary of summaries) {
    const duration = summary.durationMs === undefined ? "-" : `${Math.round(summary.durationMs)}ms`;
    console.log(`${summary.runId}\t${summary.status}\t${summary.startedAt}\t${duration}\t${summary.eventCount} events`);
  }
}

async function trace(file: string, runId: string, json: boolean): Promise<void> {
  const events = await new FileRunStore(dirname(resolve(file))).read(runId);
  if (json) {
    console.log(JSON.stringify(events, null, 2));
    return;
  }
  for (const event of events) {
    const node = typeof event.nodeId === "string" ? ` ${event.nodeId}` : "";
    const details = Object.fromEntries(
      Object.entries(event).filter(([key]) => !["timestamp", "type", "runId", "nodeId"].includes(key)),
    );
    const suffix = Object.keys(details).length ? ` ${JSON.stringify(details)}` : "";
    console.log(`${event.timestamp} ${event.type}${node}${suffix}`);
  }
}

interface ConnectValues {
  id?: string;
  name?: string;
  scope?: string;
  model?: string;
  adapter?: string;
  url?: string;
  "secret-env"?: string;
  runtime?: string;
  image?: string;
  command?: string;
  arg?: string[];
  auth?: string;
  config?: string;
}

const connectionProject = (file: string): string => dirname(resolve(file));

function objectJson(raw: string | undefined, label: string): Record<string, unknown> {
  if (!raw) return {};
  if (raw.length > 65_536) throw new Error(`${label} exceeds 64 KiB`);
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("must be an object");
    return value as Record<string, unknown>;
  } catch (error) {
    throw new Error(`${label} must be a JSON object: ${error instanceof Error ? error.message : "invalid JSON"}`, { cause: error });
  }
}

async function hiddenSecret(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stderr.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error(`${label} is required; set it in an environment variable and pass --secret-env <NAME>`);
  }
  process.stderr.write(`${label} (hidden): `);
  const input = process.stdin;
  const previousRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");
  return new Promise<string>((resolvePromise, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      input.off("data", onData);
      input.setRawMode(previousRaw);
      input.pause();
      process.stderr.write("\n");
      if (error) reject(error);
      else resolvePromise(value);
    };
    const onData = (chunk: string | Buffer) => {
      for (const character of String(chunk)) {
        if (character === "\u0003") return finish(new Error("Credential entry cancelled"));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else if (character >= " ") value += character;
        if (Buffer.byteLength(value, "utf8") > 65_536) return finish(new Error("Credential is too large"));
      }
    };
    input.on("data", onData);
  });
}

async function connectionSecret(
  environmentName: string | undefined,
  label: string,
  required: boolean,
): Promise<string | undefined> {
  if (environmentName) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(environmentName)) throw new Error("--secret-env must be an exact environment variable name");
    const value = process.env[environmentName];
    if (!value) throw new Error(`Environment variable '${environmentName}' is empty or unavailable`);
    return value;
  }
  return required ? hiddenSecret(label) : undefined;
}

const presetLabels: Record<string, string> = {
  gemini: "Google AI Studio",
  openai: "OpenAI",
  anthropic: "Anthropic",
  ollama: "Ollama",
  provider: "Custom model provider",
  firecrawl: "Firecrawl",
  searxng: "SearXNG",
  "mcp-http": "MCP server",
  "mcp-stdio": "MCP stdio server",
  http: "HTTP API",
  sandbox: "Code sandbox",
};

async function connectionInput(
  preset: string,
  values: ConnectValues,
  current?: ConnectionProfile,
): Promise<{
  readonly kind: ConnectionProfile["kind"];
  readonly name: string;
  readonly scope: ConnectionProfile["scope"];
  readonly config: Record<string, unknown>;
  readonly credential?: { readonly field: "apiKey" | "token"; readonly label: string; readonly required: boolean };
}> {
  if (!(preset in presetLabels)) throw new Error(`Unknown Connection preset '${preset}'`);
  const scope = values.scope ?? current?.scope ?? "project";
  if (scope !== "project" && scope !== "user") throw new Error("--scope must be project or user");
  const name = values.name?.trim() || current?.name || presetLabels[preset]!;
  const override = objectJson(values.config, "--config");
  let kind: ConnectionProfile["kind"];
  let config: Record<string, unknown>;
  let credential: { field: "apiKey" | "token"; label: string; required: boolean } | undefined;
  if (["gemini", "openai", "anthropic", "ollama", "provider"].includes(preset)) {
    kind = "provider";
    const adapter = values.adapter ?? (preset === "provider" ? String(current?.config.adapter ?? "") : preset);
    const model = values.model ?? String(current?.config.model ?? DEFAULT_PROVIDER_MODELS[adapter as keyof typeof DEFAULT_PROVIDER_MODELS] ?? "");
    if (!adapter || !model) throw new Error("Provider Connections require --adapter and --model (built-in presets fill --adapter)");
    config = {
      ...(current?.config ?? {}),
      adapter,
      model,
      ...((values.url ?? current?.config.baseUrl) ? { baseUrl: values.url ?? current?.config.baseUrl } : {}),
      ...override,
    };
    credential = { field: "apiKey", label: `${name} API key`, required: adapter !== "ollama" };
  } else if (preset === "firecrawl" || preset === "searxng") {
    kind = "tool-service";
    config = {
      ...(preset === "firecrawl" ? FIRECRAWL_CONNECTION_CONFIG : SEARXNG_CONNECTION_CONFIG),
      ...(current?.config ?? {}),
      ...(values.url ? { url: values.url } : {}),
      ...override,
    };
    if (!config.url) throw new Error("SearXNG requires --url <search-endpoint>");
    if (preset === "firecrawl") {
      config.headerCredentials = { Authorization: "token" };
      credential = { field: "token", label: "Firecrawl API key", required: true };
    }
  } else if (preset === "mcp-http") {
    kind = "mcp";
    const authMode = values.auth ?? (current?.config.oauth === false ? "token" : "oauth");
    if (!['oauth', 'token', 'none'].includes(authMode)) throw new Error("--auth must be oauth, token, or none");
    const url = values.url ?? current?.config.url;
    if (typeof url !== "string" || !url) throw new Error("MCP HTTP requires --url <server-url>");
    config = {
      ...(current?.config ?? {}),
      transport: "http",
      url,
      oauth: authMode === "oauth",
      ...(authMode === "token" ? { headerCredentials: { Authorization: "token" } } : {}),
      ...override,
    };
    if (authMode !== "token") delete config.headerCredentials;
    if (authMode === "token") credential = { field: "token", label: "MCP bearer token", required: true };
  } else if (preset === "mcp-stdio") {
    kind = "mcp";
    const image = values.image ?? current?.config.image;
    const command = values.command ?? current?.config.command;
    if (typeof image !== "string" || !image || typeof command !== "string" || !command) {
      throw new Error("MCP stdio requires --image <container-image> and --command <in-image-command>");
    }
    config = {
      ...(current?.config ?? {}),
      transport: "stdio",
      sandbox: "container",
      engine: await detectContainerEngine(),
      image,
      command,
      args: values.arg ?? current?.config.args ?? [],
      network: "none",
      memoryMb: 256,
      cpus: 1,
      pids: 64,
      ...override,
    };
  } else if (preset === "sandbox") {
    kind = "local-runtime";
    const runtime = values.runtime ?? String(current?.config.runtime ?? "node");
    if (runtime !== "node" && runtime !== "python") throw new Error("--runtime must be node or python");
    config = {
      ...(current?.config ?? {}),
      sandbox: "container",
      engine: await detectContainerEngine(),
      runtime,
      image: values.image ?? current?.config.image ?? DEFAULT_SANDBOX_IMAGES[runtime],
      network: "none",
      memoryMb: 256,
      cpus: 1,
      pids: 64,
      ...override,
    };
  } else {
    kind = "http-api";
    const url = values.url ?? current?.config.url;
    if (typeof url !== "string" || !url) throw new Error("HTTP API requires --url <endpoint>");
    config = { ...(current?.config ?? {}), url, ...override };
    if (values["secret-env"]) {
      config.headerCredentials = { Authorization: "token" };
      credential = { field: "token", label: "HTTP bearer token", required: true };
    }
  }
  if (current && current.kind !== kind) throw new Error(`Connection '${current.id}' is ${current.kind}; preset '${preset}' creates ${kind}`);
  if (current && current.scope !== scope) throw new Error("A saved Connection's scope cannot be changed");
  return { kind, name, scope, config, ...(credential ? { credential } : {}) };
}

async function providerProbe(manager: ConnectionManager, profile: ConnectionProfile): Promise<string> {
  const adapterId = String(profile.config.adapter ?? "");
  const model = String(profile.config.model ?? "");
  const adapter = shippedAdapters.find((candidate) => candidate.id === adapterId);
  if (!adapter) throw new Error(`Adapter '${adapterId}' is not shipped by this CLI; test it through its runtime module`);
  const apiKey = await manager.resolveCredential(profile.id, "apiKey");
  const reference = apiKey === undefined ? undefined : manager.credentialReference(profile.id, "apiKey");
  let finished = false;
  for await (const event of adapter.run({
    model,
    messages: [{ role: "user", content: "Reply OK." }],
    maxTokens: 1,
    ...(typeof profile.config.baseUrl === "string" ? { baseUrl: profile.config.baseUrl } : {}),
    ...(reference ? { apiKey: reference } : {}),
  }, {
    signal: AbortSignal.timeout(typeof profile.config.timeoutMs === "number" ? profile.config.timeoutMs : 30_000),
    resolveSecret: (candidate) => candidate === reference ? apiKey : undefined,
    fetch: guardedFetch(true, { maxStreamBytes: 16 * 1_048_576 }),
  })) if (event.type === "finish") finished = true;
  if (!finished) throw new Error(`Adapter '${adapterId}' ended without a finish event`);
  return `${adapterId} · ${model} responded`;
}

async function testConnection(manager: ConnectionManager, id: string): Promise<ConnectionProfile> {
  const profile = await manager.require(id);
  const host = (profile.kind === "mcp" || profile.kind === "tool-service") && typeof profile.config.url === "string"
    ? new URL(profile.config.url).host : undefined;
  return manager.test(id, {
    ...(host ? { allowNetworkHosts: [host] } : {}),
    ...(profile.kind === "provider" ? { probe: (candidate) => providerProbe(manager, candidate) } : {}),
  });
}

function openBrowser(url: string): void {
  const command = process.platform === "win32" ? "C:\\Windows\\System32\\rundll32.exe"
    : process.platform === "darwin" ? "/usr/bin/open" : "/usr/bin/xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.once("error", () => undefined);
  child.unref();
}

async function loginConnection(manager: ConnectionManager, id: string): Promise<ConnectionProfile> {
  let redirectUrl = "";
  let settle: ((error?: Error) => void) | undefined;
  const completed = new Promise<void>((resolvePromise, reject) => {
    settle = (error) => error ? reject(error) : resolvePromise();
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", redirectUrl || "http://127.0.0.1");
    if (request.method !== "GET" || url.pathname !== "/oauth/callback") {
      response.writeHead(404).end();
      return;
    }
    void manager.finishOAuth(id, url.searchParams, { allowNetworkHosts: true }).then(() => {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
        "x-content-type-options": "nosniff",
      }).end("<!doctype html><title>Harnest connected</title><p>Connection complete. You can close this window.</p>");
      settle?.();
    }, (cause: unknown) => {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" })
        .end("Authorization failed. Return to the terminal.");
      settle?.(cause instanceof Error ? cause : new Error("OAuth callback failed"));
    });
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  try {
    const port = (server.address() as AddressInfo).port;
    redirectUrl = `http://127.0.0.1:${port}/oauth/callback`;
    const started = await manager.beginOAuth(id, { redirectUrl, allowNetworkHosts: true });
    if (started.status === "redirect" && started.authorizationUrl) {
      console.log(`Open this URL to authorize:\n${started.authorizationUrl}`);
      openBrowser(started.authorizationUrl);
      const timeout = setTimeout(() => settle?.(new Error("OAuth authorization timed out after 10 minutes")), 10 * 60_000);
      try { await completed; } finally { clearTimeout(timeout); }
    }
    return testConnection(manager, id);
  } finally {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  }
}

async function connect(preset: string, file: string, values: ConnectValues): Promise<void> {
  const manager = new ConnectionManager(connectionProject(file));
  const current = values.id ? await manager.get(values.id) : undefined;
  const input = await connectionInput(preset, values, current);
  const existingFields = current ? await manager.credentialPresence(current.id) : [];
  const secret = input.credential
    ? await connectionSecret(values["secret-env"], input.credential.label,
        input.credential.required && !existingFields.includes(input.credential.field))
    : undefined;
  const credentials = secret && input.credential ? { [input.credential.field]: secret } : undefined;
  const profile = current
    ? await manager.update(current.id, { name: input.name, config: input.config }, credentials)
    : await manager.create({
        ...(values.id ? { id: values.id } : {}),
        scope: input.scope,
        kind: input.kind,
        name: input.name,
        config: input.config,
      }, credentials);
  if ((profile.kind === "local-runtime" || (profile.kind === "mcp" && profile.config.transport === "stdio"))
    && profile.config.sandbox === "container") await manager.approveProcess(profile.id, { pullImage: true });
  const tested = profile.kind === "mcp" && profile.config.transport === "http" && profile.config.oauth === true
    ? await loginConnection(manager, profile.id) : await testConnection(manager, profile.id);
  console.log(`${tested.id}\t${tested.status.state}\t${tested.name}`);
}

async function connections(file: string, json: boolean): Promise<void> {
  const profiles = await new ConnectionManager(connectionProject(file)).list();
  if (json) {
    console.log(JSON.stringify(profiles, null, 2));
    return;
  }
  if (!profiles.length) {
    console.log("No saved Connections.");
    return;
  }
  for (const profile of profiles) console.log(`${profile.id}\t${profile.status.state}\t${profile.kind}\t${profile.scope}\t${profile.name}`);
}

async function connectionAction(action: string, id: string, file: string): Promise<void> {
  const manager = new ConnectionManager(connectionProject(file));
  if (action === "test") {
    const profile = await testConnection(manager, id);
    console.log(`${profile.id}\t${profile.status.state}\t${profile.status.message ?? "ready"}`);
    return;
  }
  if (action === "login") {
    const profile = await loginConnection(manager, id);
    console.log(`${profile.id}\t${profile.status.state}\t${profile.status.message ?? "authorized"}`);
    return;
  }
  if (action === "disconnect" || action === "revoke") {
    const profile = await manager.disconnect(id, { revoke: action === "revoke", allowNetworkHosts: true });
    console.log(`${profile.id}\t${profile.status.state}\t${profile.status.message ?? action}`);
    return;
  }
  if (action === "delete") {
    if (!await manager.delete(id)) throw new Error(`Connection '${id}' was not found`);
    console.log(`Deleted ${id}`);
    return;
  }
  throw new Error("connection action must be test, login, disconnect, revoke, or delete");
}

async function fileIsDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

async function skillCommand(
  action: string,
  value: string | undefined,
  file: string,
  values: { scope?: string; namespace?: string; version?: string; commit?: string; yes?: boolean },
): Promise<void> {
  const scope = values.scope ?? "project";
  const namespace = values.namespace ?? "harnest";
  if (scope !== "project" && scope !== "user") throw new Error("skill --scope must be project or user");
  if (namespace !== "harnest" && namespace !== "agents") throw new Error("skill --namespace must be harnest or agents");
  const store = new NodeSkillStore({ projectDirectory: connectionProject(file) });
  if (action === "list") {
    const catalog = await store.catalog();
    for (const skill of catalog.skills) console.log(`${skill.name}\t${skill.scope}\t${skill.provenance.kind}\t${skill.description}`);
    if (!catalog.skills.length) console.log("No installed Skills.");
    for (const warning of catalog.warnings) console.error(`Warning: ${warning}`);
    return;
  }
  if (!value) throw new Error(`skill ${action} requires a value`);
  if (action === "install") {
    if (await fileIsDirectory(resolve(value))) {
      const installed = await store.install({ kind: "local", directory: resolve(value) }, { scope, namespace });
      console.log(`${installed.name} installed from local folder`);
      return;
    }
    const unresolved = /^https:\/\//i.test(value)
      ? { kind: "git" as const, repository: value, ...(values.commit ? { commit: values.commit } : {}) }
      : { kind: "package" as const, package: value, ...(values.version ? { version: values.version } : {}) };
    const source = await resolveRemoteSkillSource(unresolved);
    const materialized = await materializeRemoteSkill(source);
    try {
      const remoteStore = new NodeSkillStore({
        projectDirectory: connectionProject(file),
        materializeRemote: () => materialized.directory,
      });
      const installed = await remoteStore.install(source, {
        scope,
        namespace,
        approval: { sourceKey: skillInstallSourceKey(source) },
      });
      console.log(`${installed.name} installed from ${remoteSkillSourceLabel(source)}`);
      if (installed.scriptsPresent) console.log(`Review scripts with: harnest skill review ${installed.name} ${file}`);
    } finally {
      await materialized.cleanup();
    }
    return;
  }
  const scripts = await store.reviewScripts(value);
  for (const script of scripts) {
    console.log(`\n${script.path}\n${script.sha256}\n${script.approved ? "APPROVED" : "NOT APPROVED"}\n${script.content}`);
  }
  if (!scripts.length) {
    console.log(`Skill '${value}' has no scripts.`);
    return;
  }
  if (action === "review") return;
  if (action !== "approve") throw new Error("skill action must be list, install, review, or approve");
  if (!values.yes) {
    if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error("Non-interactive script approval requires --yes");
    const terminal = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answer = await terminal.question("Approve the exact script hashes shown above? [y/N] ");
      if (!/^(?:y|yes)$/i.test(answer.trim())) throw new Error("Script approval cancelled");
    } finally {
      terminal.close();
    }
  }
  for (const script of scripts.filter((candidate) => !candidate.approved)) {
    await store.approveScript(value, script.path, script.sha256);
  }
  console.log(`Approved ${scripts.length} exact script hash(es) for ${value}`);
}

async function studio(file: string, port: string, capabilities: CapabilityValues): Promise<void> {
  const portNumber = parsedPort(port, "studio");
  const studioPackage = createRequire(import.meta.url).resolve("@harnest/studio/package.json");
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const preapprovedTools = approvedToolIds(capabilities);
  const child = spawn(
    command,
    ["run", "dev", "--", "--hostname", "127.0.0.1", "--port", String(portNumber)],
    {
      cwd: dirname(studioPackage),
      env: {
        ...process.env,
        HARNEST_FILE: resolve(file),
        ...(capabilities["allow-modules"] ? { HARNEST_ALLOW_MODULES: "1" } : {}),
        ...(capabilities["allow-files"] ? { HARNEST_ALLOW_FILES: "1" } : {}),
        ...(capabilities["context-root"]?.length
          ? { HARNEST_CONTEXT_ROOTS: capabilities["context-root"].join(",") }
          : {}),
        ...(capabilities["allow-process"]?.length
          ? { HARNEST_ALLOW_PROCESS: capabilities["allow-process"].join(",") }
          : {}),
        ...(capabilities["allow-network"]?.length
          ? { HARNEST_ALLOW_NETWORK: capabilities["allow-network"].join(",") }
          : {}),
        ...(preapprovedTools.length
          ? { HARNEST_APPROVE_TOOLS: preapprovedTools.join(",") }
          : {}),
      },
      stdio: "inherit",
      shell: process.platform === "win32",
    },
  );
  await new Promise<void>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal === "SIGINT" || code === 0) resolvePromise();
      else reject(new Error(`Studio exited with code ${code ?? signal}`));
    });
  });
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(HELP);
    return;
  }

  if (command === "init") {
    const { positionals } = parseArgs({ args, allowPositionals: true, strict: true });
    if (positionals.length > 1) throw new Error("init accepts at most one directory");
    await init(positionals[0] ?? ".");
    return;
  }

  if (command === "bundle") {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: { output: { type: "string", short: "o" } },
    });
    if (positionals.length > 1) throw new Error("bundle accepts at most one file");
    await bundle(positionals[0] ?? "harnest.yaml", values.output);
    return;
  }

  if (command === "validate" || command === "inspect") {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: { "allow-modules": capabilityOptions["allow-modules"] },
    });
    const file = positionals[0];
    if (!file) throw new Error(`${command} requires a file`);
    if (command === "validate") await validate(file, values["allow-modules"] ?? false);
    else await inspect(file, values["allow-modules"] ?? false);
    return;
  }

  if (command === "run" || command === "test") {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        ...(command === "run" ? { input: { type: "string" as const, short: "i" } } : {}),
        ...capabilityOptions,
      },
    });
    const file = positionals[0];
    if (!file) throw new Error(`${command} requires a file`);
    if (command === "run") {
      if (values.input === undefined) throw new Error("run requires --input <value>");
      await run(file, values.input as string, values as CapabilityValues);
    } else {
      await test(file, values as CapabilityValues);
    }
    return;
  }

  if (command === "serve") {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: { port: { type: "string", short: "p", default: "8787" }, ...capabilityOptions },
    });
    if (positionals.length > 1) throw new Error("serve accepts at most one file");
    await serve(positionals[0] ?? "harnest.yaml", values.port, values as CapabilityValues);
    return;
  }

  if (command === "mcp") {
    const [action, ...mcpArgs] = args;
    if (action !== "serve") throw new Error("mcp requires serve [file]");
    const { values, positionals } = parseArgs({
      args: mcpArgs,
      allowPositionals: true,
      strict: true,
      options: capabilityOptions,
    });
    if (positionals.length > 1) throw new Error("mcp serve accepts at most one file");
    await mcpServe(positionals[0] ?? "harnest.yaml", values as CapabilityValues);
    return;
  }

  if (command === "runs") {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: { limit: { type: "string", short: "n", default: "50" } },
    });
    await runs(positionals[0] ?? "harnest.yaml", values.limit);
    return;
  }

  if (command === "trace") {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: { json: { type: "boolean" } },
    });
    const runId = positionals[0];
    if (!runId) throw new Error("trace requires <run-id>");
    await trace(positionals[1] ?? "harnest.yaml", runId, values.json ?? false);
    return;
  }

  if (command === "connections") {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: { json: { type: "boolean" } },
    });
    await connections(positionals[0] ?? "harnest.yaml", values.json ?? false);
    return;
  }

  if (command === "connect") {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        id: { type: "string" },
        name: { type: "string" },
        scope: { type: "string" },
        model: { type: "string" },
        adapter: { type: "string" },
        url: { type: "string" },
        "secret-env": { type: "string" },
        runtime: { type: "string" },
        image: { type: "string" },
        command: { type: "string" },
        arg: { type: "string", multiple: true },
        auth: { type: "string" },
        config: { type: "string" },
      },
    });
    const preset = positionals[0];
    if (!preset) throw new Error("connect requires a preset");
    await connect(preset, positionals[1] ?? "harnest.yaml", values as ConnectValues);
    return;
  }

  if (command === "connection") {
    const { positionals } = parseArgs({ args, allowPositionals: true, strict: true });
    const [action, id, file = "harnest.yaml"] = positionals;
    if (!action || !id) throw new Error("connection requires <test|login|disconnect|revoke|delete> <id> [file]");
    await connectionAction(action, id, file);
    return;
  }

  if (command === "skill") {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        scope: { type: "string" },
        namespace: { type: "string" },
        version: { type: "string" },
        commit: { type: "string" },
        yes: { type: "boolean", short: "y" },
      },
    });
    const action = positionals[0];
    if (!action) throw new Error("skill requires list, install, review, or approve");
    const value = action === "list" ? undefined : positionals[1];
    const file = action === "list" ? positionals[1] ?? "harnest.yaml" : positionals[2] ?? "harnest.yaml";
    await skillCommand(action, value, file, values);
    return;
  }

  if (command === "studio") {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: { port: { type: "string", short: "p", default: "3000" }, ...capabilityOptions },
    });
    await studio(positionals[0] ?? "harnest.yaml", values.port, values as CapabilityValues);
    return;
  }

  throw new Error(`Unknown command: ${command}\n\n${HELP}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.startsWith("Spec ") && !message.startsWith("Runtime module")) {
    console.error(`Error: ${message}`);
  }
  process.exitCode = 1;
});
