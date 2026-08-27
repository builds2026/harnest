#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { crc32 } from "node:zlib";
import { Harnest } from "@harnestai/sdk/node";
import {
  CreateRunRequestSchema,
  PROTOCOL_VERSION,
  RunCommandSchema,
  toWireEvent,
  type CreateRunContext,
  type InternalEvent,
  type RunCommand as WireRunCommand,
} from "@harnestai/protocol";
import {
  AdapterRegistry,
  compileSpec,
  createBuiltinComponentRegistry,
  describeHarness,
  DEFAULT_PROVIDER_MODELS,
  DEFAULT_SANDBOX_IMAGES,
  FIRECRAWL_CONNECTION_CONFIG,
  publicRunSnapshot,
  SEARXNG_CONNECTION_CONFIG,
  ToolRegistry,
  validateSpec,
  type ConnectionProfile,
  type Diagnostic,
  type HarnessSpec,
  type RunCommand,
  type RunEndEvent,
  type RunEvent,
  type RunHandle,
  type RunOptions,
  type ToolApprovalDecision,
  type ToolApprovalRequest,
  type TokenUsage,
} from "@harnestai/core";
import {
  FileRunStore,
  abandonIdempotentRun,
  acquireRunExecutionLease,
  ConnectionManager,
  detectContainerEngine,
  guardedFetch,
  initializeHarnestProject,
  listPortableProjectFiles,
  loadAdapterModules,
  loadRuntimeModules,
  loadSpecFile,
  resolveHarnessFile,
  saveSpecFile,
  NodeRuntimeServices,
  NodeSkillStore,
  materializeRemoteSkill,
  markIdempotentRunStarted,
  remoteSkillSourceLabel,
  resolveRemoteSkillSource,
  reserveIdempotentRun,
  releaseRunExecutionLease,
  skillInstallSourceKey,
  waitForIdempotentRun,
  writeProjectEnvExample,
  type NodeRuntimeServiceOptions,
  type StoredRunEvent,
} from "@harnestai/core/node";
import { serveAuthoringMcp } from "./authoring-mcp.js";
import { shippedAdapters } from "./registries.js";

const HELP = `Harnest Visual AI Agent Harness

Usage:
  harnest init [directory]
  harnest bundle [file] [--output <file>]
  harnest validate <file>
  harnest inspect <file>
  harnest contract <file> [--json]
  harnest run <file> --input <value> [capabilities]
  harnest test <file> [capabilities]
  harnest runs [file] [--limit <number>]
  harnest trace <run-id> [file] [--json]
  harnest connections [file] [--json]
  harnest permissions <list|revoke> [tool-id] [file] [--connection <id>] [--json]
  harnest connect <preset> [file] [options]
  harnest connection <test|login|disconnect|revoke|delete> <id> [file]
  harnest skill <list|install|review|approve> [value] [file]
  harnest serve [file] [--port <number>] [capabilities]
  harnest mcp serve [workspace] [--transport <stdio|http>] [--host <host>] [--port <number>]
    [--allowed-host <hostname>] [--allowed-origin <hostname>]
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

Authoring MCP:
  Serves HarnessSpec docs and secret-free static validation. HTTP binds to
  127.0.0.1 by default; remote binding requires repeatable --allowed-host values.
  Browser Origins are separately allowed with repeatable --allowed-origin values.

Studio network access:
  Studio binds to 127.0.0.1 by default. For a reviewed private-network demo, set
  HARNEST_STUDIO_HOST=0.0.0.0 and HARNEST_STUDIO_ALLOWED_HOSTS to the exact
  comma-separated browser-visible hostnames or IPs. Files still require
  --allow-files and project-relative --context-root values.
`;

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
  const prompt = "Answer this request clearly:\n\n{{input}}";
  const positions = {
    model: { x: 80, y: 80 },
    prompt: { x: 80, y: 260 },
    agent: { x: 430, y: 170 },
    output: { x: 780, y: 170 },
  };
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
      { id: "prompt", type: "prompt", config: { template: prompt } },
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
    studio: { positions },
  };
  await saveSpecFile(file, spec);
  await initializeHarnestProject(file, {
    version: 1,
    harness: "harnest.yaml",
    bindings: [{ kind: "prompt", component: "prompt", path: "prompts/main.md" }],
    studio: "studio.json",
  }, {
    "prompts/main.md": `${prompt}\n`,
    "studio.json": `${JSON.stringify({ positions }, null, 2)}\n`,
  });
  await writeProjectEnvExample(file, spec);
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
  const requested = await resolveHarnessFile(file);
  const link = await lstat(requested);
  if (link.isSymbolicLink() || !link.isFile()) throw new Error("Harness bundle source must be a regular file, not a link");
  const absolute = await realpath(requested);
  const project = await realpath(dirname(absolute));
  const entries: BundleEntry[] = [{ name: basename(absolute), content: await readFile(absolute) }];
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
  for (const portable of await listPortableProjectFiles(absolute)) {
    if (entries.some(({ name }) => name === portable.archivePath)) continue;
    const content = await readFile(portable.path);
    if (content.byteLength !== portable.size
      || createHash("sha256").update(content).digest("hex") !== portable.sha256) {
      throw new Error(`Portable project asset changed during packaging: ${portable.archivePath}`);
    }
    entries.push({ name: portable.archivePath, content });
    totalBytes += content.byteLength;
    if (entries.length > MAX_BUNDLE_FILES) throw new Error(`Bundle exceeds ${MAX_BUNDLE_FILES} files`);
    if (totalBytes > MAX_BUNDLE_BYTES) throw new Error(`Bundle exceeds ${MAX_BUNDLE_BYTES} bytes`);
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
  const parsed = await loadSpecFile(file);
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
  const absolute = await resolveHarnessFile(file);
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
    harnessId: absolute,
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
    console.log(`Valid: ${loaded.absolute}`);
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

async function contract(file: string, json: boolean): Promise<void> {
  const loaded = await loadSpecFile(file);
  if (!loaded.ok) {
    printDiagnostics(loaded.diagnostics);
    throw new Error("Spec could not be loaded");
  }
  const value = describeHarness(loaded.spec);
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  console.log(`HarnessSpec ${value.specVersion} · ${value.componentCount} components · ${value.graphCount} graph(s)`);
  console.log(`Capabilities: ${value.capabilities.join(", ") || "none"}`);
  console.log(`Connections: ${value.requiredConnections.join(", ") || "none"}`);
  console.log(`Tests: ${value.tests.count} · ${value.tests.assertionTypes.join(", ") || "none"}`);
  console.log("Integrate:");
  for (const surface of value.integrationSurfaces) console.log(`  ${surface.label}: ${surface.example}`);
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

interface HttpApprovalView {
  readonly runId: string;
  readonly nodeId: string;
  readonly callId: string;
  readonly turn: number;
  readonly toolId: string;
  readonly connectionId?: string;
  readonly risk: string;
  readonly input: unknown;
  readonly inputDigest: string;
  readonly expiresAt: string;
}

class HttpApprovalBroker {
  readonly #pending = new Map<string, {
    readonly view: HttpApprovalView;
    readonly resolve: (decision: ToolApprovalDecision) => void;
    readonly signal: AbortSignal;
    readonly abort: () => void;
    readonly timer: ReturnType<typeof setTimeout>;
  }>();

  request(request: ToolApprovalRequest, signal: AbortSignal): Promise<ToolApprovalDecision> {
    const key = this.#key(request.runId, request.nodeId, request.turn, request.callId);
    const serialized = JSON.stringify(request.input) ?? "null";
    const preview = JSON.parse(serialized, (name, value: unknown) =>
      /(?:api[-_]?key|authorization|secret|token|pass(?:word|phrase)|credentials?|cookies?|private[-_]?key)$/i.test(name)
        ? "[REDACTED]" : value) as unknown;
    const view: HttpApprovalView = {
      runId: request.runId,
      nodeId: request.nodeId,
      callId: request.callId,
      turn: request.turn,
      toolId: request.tool.id,
      ...(request.tool.connectionId ? { connectionId: request.tool.connectionId } : {}),
      risk: request.tool.risk ?? "external",
      input: preview,
      inputDigest: createHash("sha256").update(serialized).digest("hex"),
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    };
    this.#finish(key, { approved: false, source: "policy", mode: "deny", reason: "Superseded approval request" });
    return new Promise<ToolApprovalDecision>((resolveDecision) => {
      const abort = () => this.#finish(key, { approved: false, source: "policy", mode: "deny", reason: "Run cancelled" });
      const timer = setTimeout(() => this.#finish(key, {
        approved: false, source: "policy", mode: "deny", reason: "Approval timed out",
      }), 120_000);
      this.#pending.set(key, { view, resolve: resolveDecision, signal, abort, timer });
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  }

  list(): HttpApprovalView[] {
    return [...this.#pending.values()].map(({ view }) => structuredClone(view));
  }

  close(): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.signal.removeEventListener("abort", pending.abort);
    }
    this.#pending.clear();
  }

  decide(candidate: Record<string, unknown>): boolean {
    const { runId, nodeId, callId, turn, inputDigest, decision } = candidate;
    const mode = decision === "once" ? "allow_once" : decision === "always" ? "allow_always" : decision;
    if (typeof runId !== "string" || typeof nodeId !== "string" || typeof callId !== "string"
      || !Number.isInteger(turn) || typeof inputDigest !== "string"
      || !["allow_once", "allow_for_run", "allow_always", "deny"].includes(String(mode))) return false;
    const key = this.#key(runId, nodeId, turn as number, callId);
    const pending = this.#pending.get(key);
    if (!pending || pending.view.inputDigest !== inputDigest) return false;
    return this.#finish(key, {
      approved: mode !== "deny",
      source: "user",
      mode: mode as NonNullable<ToolApprovalDecision["mode"]>,
      ...(mode === "deny" ? { reason: "Denied by the API operator" } : {}),
    });
  }

  #key(runId: string, nodeId: string, turn: number, callId: string) {
    return `${runId}\u0000${nodeId}\u0000${turn}\u0000${callId}`;
  }

  #finish(key: string, decision: ToolApprovalDecision): boolean {
    const pending = this.#pending.get(key);
    if (!pending) return false;
    this.#pending.delete(key);
    clearTimeout(pending.timer);
    pending.signal.removeEventListener("abort", pending.abort);
    pending.resolve(decision);
    return true;
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
          const answer = await terminal.question("Allow [o]nce, for this [r]un, [a]lways for this Harness/Tool/Connection, or [d]eny? [d] ", { signal: context.signal });
          const choice = answer.trim().toLocaleLowerCase();
          if (choice === "o" || choice === "once" || choice === "y" || choice === "yes") {
            return { approved: true, source: "user", mode: "allow_once" };
          }
          if (choice === "r" || choice === "run" || choice === "allow_for_run") {
            return { approved: true, source: "user", mode: "allow_for_run" };
          }
          if (choice === "a" || choice === "always") {
            return { approved: true, source: "user", mode: "allow_always" };
          }
          return { approved: false, source: "user", mode: "deny", reason: "Denied by the CLI operator" };
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
  const harness = await Harnest.load(file, sdkOptions(capabilities));
  let end: RunEndEvent | undefined;
  let streamedText = "";
  try {
    for await (const event of harness.stream(inputValue(rawInput))) {
      if (event.type === "text-delta") {
        streamedText += event.text;
        process.stdout.write(event.text);
      }
      if (event.type === "run-end") end = event;
    }
  } finally {
    await harness.close();
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
  for (const artifact of end.artifacts ?? []) {
    console.log(`artifact ${artifact.ref}\t${artifact.mimeType}\t${artifact.size}\t${artifact.name}`);
  }
}

async function test(file: string, capabilities: CapabilityValues): Promise<void> {
  const harness = await Harnest.load(file, sdkOptions(capabilities));
  try {
    const report = await harness.test();
    for (const testCase of report.cases) {
      console.log(`${testCase.ok ? "PASS" : "FAIL"} ${testCase.id} ${Math.round(testCase.durationMs)}ms`);
      if (testCase.error) console.error(`  ${testCase.error}`);
    }
    console.log(`${report.passed} passed, ${report.failed} failed`);
    if (!report.ok) throw new Error(`${report.failed} harness test(s) failed`);
  } finally {
    await harness.close();
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

async function requestObject(request: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
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
  return body as Record<string, unknown>;
}

async function requestInput(request: import("node:http").IncomingMessage): Promise<unknown> {
  const record = await requestObject(request) as { input?: unknown; message?: unknown };
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

interface ManagedRun {
  readonly handle: RunHandle;
  readonly events: RunEvent[];
  readonly listeners: Set<(event?: RunEvent) => void>;
  readonly ready: Promise<void>;
  done: boolean;
}

function manageRun(handle: RunHandle, runs: Map<string, ManagedRun>, onDone?: () => void | Promise<void>): ManagedRun {
  if (runs.get(handle.runId)?.done === false) throw new Error(`Run '${handle.runId}' is already active`);
  let markReady: () => void = () => undefined;
  const ready = new Promise<void>((resolveReady) => { markReady = resolveReady; });
  const run: ManagedRun = { handle, events: [], listeners: new Set(), ready, done: false };
  runs.set(handle.runId, run);
  void (async () => {
    let started = false;
    try {
      for await (const event of handle.events) {
        run.events.push(event);
        if (run.events.length > 10_000) run.events.shift();
        for (const listener of run.listeners) listener(event);
        if (!started) {
          started = true;
          setImmediate(markReady);
        }
      }
    } catch (error) {
      if (run.events.at(-1)?.type !== "error") {
        const failure: RunEvent = {
          type: "error", runId: handle.runId, timestamp: new Date().toISOString(),
          sequence: (handle.snapshot().sequence ?? 0) + 1,
          code: error && typeof error === "object" && "code" in error ? String(error.code) : "RUN_FAILED",
          message: error instanceof Error ? error.message : "Harness run failed",
        };
        run.events.push(failure);
        for (const listener of run.listeners) listener(failure);
      }
    } finally {
      markReady();
      run.done = true;
      for (const listener of run.listeners) listener();
      try { await onDone?.(); } catch (error) { console.error("Could not release Run resources", error); }
    }
  })();
  return run;
}

function streamManagedRun(
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
  run: ManagedRun,
  after: number,
): void {
  response.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "x-content-type-options": "nosniff",
  });
  let cursor = after;
  const write = (event?: RunEvent) => {
    if (!event) { response.end(); return; }
    const sequence = event.sequence ?? cursor + 1;
    if (sequence <= cursor) return;
    cursor = sequence;
    response.write(`${JSON.stringify(event)}\n`);
  };
  run.listeners.add(write);
  for (const event of run.events) write(event);
  if (run.done) response.end();
  response.once("close", () => run.listeners.delete(write));
}

function streamManagedRunSse(
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
  run: ManagedRun,
  after: number,
  history: readonly StoredRunEvent[] = [],
): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "x-accel-buffering": "no",
    "x-content-type-options": "nosniff",
  });
  response.write(": connected\n\n");
  let cursor = after;
  let replaying = true;
  let closed = false;
  const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
  heartbeat.unref();
  const cleanup = () => {
    clearInterval(heartbeat);
    run.listeners.delete(write);
  };
  const close = () => {
    if (closed) return;
    closed = true;
    cleanup();
    response.end();
  };
  const write = (event?: RunEvent | StoredRunEvent) => {
    if (!event) { close(); return; }
    const sequence = event.sequence ?? cursor + 1;
    if (sequence <= cursor) return;
    cursor = sequence;
    const envelope = toWireEvent({ ...event, sequence } as InternalEvent);
    response.write(`id: ${sequence}\nevent: ${envelope.type}\ndata: ${JSON.stringify(envelope)}\n\n`);
    if (!replaying && envelope.type === "run.paused" && run.handle.snapshot().status === "paused") close();
  };
  run.listeners.add(write);
  for (const event of [...history, ...run.events].sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0))) write(event);
  replaying = false;
  const snapshot = run.handle.snapshot();
  if (run.done || (snapshot.status === "paused" && snapshot.sequence !== undefined && cursor >= snapshot.sequence)) close();
  response.once("close", cleanup);
  request.once("aborted", cleanup);
}

function streamStoredRunSse(
  response: import("node:http").ServerResponse,
  events: readonly StoredRunEvent[],
  after: number,
): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "x-accel-buffering": "no",
    "x-content-type-options": "nosniff",
  });
  response.write(": connected\n\n");
  let cursor = after;
  for (const event of [...events].sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0))) {
    const sequence = event.sequence ?? cursor + 1;
    if (sequence <= cursor) continue;
    cursor = sequence;
    const envelope = toWireEvent({ ...event, sequence } as InternalEvent);
    response.write(`id: ${sequence}\nevent: ${envelope.type}\ndata: ${JSON.stringify(envelope)}\n\n`);
  }
  response.end();
}

function eventCursor(request: import("node:http").IncomingMessage, url: URL): number {
  const raw = url.searchParams.get("after") ?? (Array.isArray(request.headers["last-event-id"])
    ? request.headers["last-event-id"][0] : request.headers["last-event-id"]) ?? "0";
  const after = Number(raw);
  if (!Number.isInteger(after) || after < 0) throw new Error("after and Last-Event-ID must be a non-negative sequence");
  return after;
}

function coreRunCommand(command: WireRunCommand): RunCommand {
  const { commandId, ...rest } = command;
  if (rest.type === "interaction.response") return {
    ...(commandId ? { id: commandId } : {}),
    type: "interaction-response",
    response: {
      interactionId: rest.response.interactionId,
      checkpointDigest: rest.response.checkpointDigest,
      action: rest.response.action,
      ...(rest.response.value === undefined ? {} : { value: rest.response.value }),
      ...(rest.response.permission === undefined ? {} : { permission: rest.response.permission }),
    },
  };
  return { ...rest, ...(commandId ? { id: commandId } : {}) } as RunCommand;
}

function sessionFromContext(context: CreateRunContext): NonNullable<RunOptions["session"]> {
  const revisions = context.revisions ? {
    ...(context.revisions.conversation === undefined ? {} : { conversation: context.revisions.conversation }),
    ...(context.revisions.memory === undefined ? {} : { memory: context.revisions.memory }),
    ...(context.revisions.pkm === undefined ? {} : { pkm: context.revisions.pkm }),
  } : undefined;
  return {
    contextRef: context.contextRef,
    ...(revisions ? { revisions } : {}),
    ...(context.attachments ? { attachments: context.attachments.map((attachment) => ({
      id: attachment.ref,
      ref: attachment.ref,
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.size,
    })) } : {}),
  };
}

function createIdempotencyKey(request: import("node:http").IncomingMessage): string | undefined {
  const header = request.headers["idempotency-key"];
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) return undefined;
  if (value.length > 512 || !value.length
    || [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new Error("Idempotency-Key must be a bounded opaque value");
  }
  return value;
}

async function serve(file: string, portValue: string, capabilities: CapabilityValues): Promise<void> {
  const port = parsedPort(portValue, "serve");
  const approvalBroker = new HttpApprovalBroker();
  const harness = await Harnest.load(file, {
    ...sdkOptions(capabilities),
    services: {
      ...serviceOptions(capabilities),
      requestToolApproval: (request, context) => approvalBroker.request(request, context.signal),
    },
  });
  const activeRuns = new Map<string, ManagedRun>();
  const projectDirectory = dirname(harness.file);
  const runStore = new FileRunStore(projectDirectory);
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;
    if (request.method === "GET" && pathname === "/health") {
      const localConnections = await harness.localConnectionHealth();
      writeJson(response, localConnections.ok ? 200 : 503, {
        ok: localConnections.ok,
        file: harness.file,
        readyConnections: localConnections.readyConnections,
        localConnections,
      });
      return;
    }
    if (request.method === "GET" && pathname === "/contract") {
      writeJson(response, 200, harness.contract);
      return;
    }
    if (request.method === "GET" && pathname === "/v1/capabilities") {
      writeJson(response, 200, {
        protocolVersion: PROTOCOL_VERSION,
        events: { transport: "sse", reconnect: ["after", "Last-Event-ID"] },
        interactions: {
          kinds: ["select", "input", "form", "file", "oauth", "permission"],
          permissions: ["allow_once", "allow_for_run", "allow_always", "deny"],
        },
      });
      return;
    }
    if (request.method === "POST" && (pathname === "/runs" || pathname === "/v1/runs")) {
      let idempotencyKey: string | undefined;
      let ownedReservationRunId: string | undefined;
      let leasedRunId: string | undefined;
      let leaseTransferred = false;
      let runManaged = false;
      try {
        const rawBody = await requestObject(request);
        const wireRequest = pathname === "/v1/runs" ? CreateRunRequestSchema.parse(rawBody) : undefined;
        idempotencyKey = pathname === "/v1/runs" ? createIdempotencyKey(request) : undefined;
        const input = wireRequest ? wireRequest.input
          : Object.hasOwn(rawBody, "input") ? rawBody.input
          : typeof rawBody.message === "string" ? rawBody.message : (() => { throw new Error("Request body requires input or message"); })();
        const resumeRunId = wireRequest?.resumeRunId ?? rawBody.resumeRunId;
        if (!wireRequest && resumeRunId !== undefined
          && (typeof resumeRunId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(resumeRunId))) {
          throw new Error("resumeRunId is invalid");
        }
        const snapshot = typeof resumeRunId === "string" ? await harness.readRunSnapshot(resumeRunId) : undefined;
        if (resumeRunId && !snapshot) throw new Error("Run snapshot was not found");
        const durableRunExists = async (runId: string) => activeRuns.has(runId)
          || Boolean(await runStore.readSnapshot(runId))
          || await runStore.readEvents(runId).then((events) => events.length > 0, () => false);
        const reservation = idempotencyKey ? await reserveIdempotentRun(
          projectDirectory, idempotencyKey, typeof resumeRunId === "string" ? resumeRunId : undefined, durableRunExists,
        ) : undefined;
        if (reservation && !reservation.owner) {
          const settled = await waitForIdempotentRun(projectDirectory, idempotencyKey!, 5_000, durableRunExists);
          writeJson(response, 202, {
            runId: settled.runId,
            events: `/v1/runs/${encodeURIComponent(settled.runId)}/events`,
            snapshot: `/v1/runs/${encodeURIComponent(settled.runId)}/snapshot`,
            commands: `/v1/runs/${encodeURIComponent(settled.runId)}/commands`,
          });
          return;
        }
        ownedReservationRunId = reservation?.runId;
        if (typeof resumeRunId === "string" && activeRuns.get(resumeRunId)?.done === false) {
          if (idempotencyKey && ownedReservationRunId) {
            await abandonIdempotentRun(projectDirectory, idempotencyKey, ownedReservationRunId);
            ownedReservationRunId = undefined;
          }
          throw new Error(`Run '${resumeRunId}' is already active`);
        }
        const executionRunId = typeof resumeRunId === "string" ? resumeRunId : reservation?.runId ?? randomUUID();
        await acquireRunExecutionLease(projectDirectory, executionRunId);
        leasedRunId = executionRunId;
        if (idempotencyKey && reservation) await markIdempotentRunStarted(projectDirectory, idempotencyKey, reservation.runId);
        const options: RunOptions = wireRequest?.context
          ? { session: sessionFromContext(wireRequest.context) } : {};
        const handle = snapshot ? harness.resume(input, snapshot, options) : harness.start(input, options, executionRunId);
        const run = manageRun(handle, activeRuns, () => releaseRunExecutionLease(projectDirectory, handle.runId));
        leaseTransferred = true;
        runManaged = true;
        if (snapshot || idempotencyKey) await run.ready;
        writeJson(response, 202, pathname === "/v1/runs" ? {
          runId: run.handle.runId,
          events: `/v1/runs/${encodeURIComponent(run.handle.runId)}/events`,
          snapshot: `/v1/runs/${encodeURIComponent(run.handle.runId)}/snapshot`,
          commands: `/v1/runs/${encodeURIComponent(run.handle.runId)}/commands`,
        } : { ok: true, runId: run.handle.runId });
      } catch (error) {
        if (idempotencyKey && ownedReservationRunId && !runManaged) {
          await abandonIdempotentRun(projectDirectory, idempotencyKey, ownedReservationRunId).catch(() => undefined);
        }
        if (leasedRunId && !leaseTransferred) await releaseRunExecutionLease(projectDirectory, leasedRunId).catch(() => undefined);
        writeJson(response, 400, { ok: false, error: error instanceof Error ? error.message : "Run could not start" });
      }
      return;
    }
    const v1RunRoute = pathname.match(/^\/v1\/runs\/([^/]+)(?:\/(events|snapshot|commands))?$/u);
    const runRoute = pathname.match(/^\/runs\/([^/]+)(?:\/(events|snapshot|commands))?$/u);
    if (v1RunRoute || runRoute) {
      const matched = v1RunRoute ?? runRoute!;
      const runId = decodeURIComponent(matched[1] ?? "");
      const action = matched[2];
      const run = activeRuns.get(runId);
      if (request.method === "GET" && action === "events") {
        try {
          const after = eventCursor(request, url);
          if (!v1RunRoute) {
            if (!run) { writeJson(response, 404, { ok: false, error: "Run was not found" }); return; }
            streamManagedRun(request, response, run, after);
            return;
          }
          let history: StoredRunEvent[] = [];
          try { history = await runStore.readEvents(runId); }
          catch (error) {
            if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
          }
          if (run) streamManagedRunSse(request, response, run, after, history);
          else {
            const snapshot = await runStore.readSnapshot(runId);
            if (!snapshot && !history.length) { writeJson(response, 404, { ok: false, error: "Run was not found" }); return; }
            streamStoredRunSse(response, history, after);
          }
        } catch (error) {
          writeJson(response, 400, { ok: false, error: error instanceof Error ? error.message : "Event cursor is invalid" });
        }
        return;
      }
      if (request.method === "GET" && action === "snapshot") {
        const snapshot = run?.handle.snapshot() ?? (v1RunRoute ? await runStore.readSnapshot(runId) : undefined);
        if (!snapshot) { writeJson(response, 404, { ok: false, error: "Run was not found" }); return; }
        writeJson(response, 200, {
          ok: true,
          snapshot: publicRunSnapshot(snapshot),
          ...(v1RunRoute ? { active: Boolean(run && !run.done) } : {}),
        });
        return;
      }
      if (request.method === "POST" && action === "commands") {
        try {
          const body = await requestObject(request);
          if (v1RunRoute && (!run || run.done)) {
            const snapshot = await runStore.readSnapshot(runId);
            if (snapshot?.status === "paused") {
              writeJson(response, 409, { ok: false, error: {
                code: "RUN_RECOVERY_REQUIRED",
                message: "Resume this Run with POST /v1/runs and the original context before sending a command",
              } });
              return;
            }
            if (run) { writeJson(response, 409, { ok: false, error: "Run is not active" }); return; }
          }
          if (!run) { writeJson(response, 404, { ok: false, error: "Run was not found" }); return; }
          await run.handle.send(v1RunRoute ? coreRunCommand(RunCommandSchema.parse(body)) : body as RunCommand);
          writeJson(response, 200, { ok: true });
        } catch (error) {
          writeJson(response, 409, { ok: false, error: error instanceof Error ? error.message : "Command was rejected" });
        }
        return;
      }
      if (request.method === "DELETE" && !action) {
        if (v1RunRoute && (!run || run.done)) {
          const snapshot = await runStore.readSnapshot(runId);
          if (snapshot?.status === "paused") {
            writeJson(response, 409, { ok: false, error: {
              code: "RUN_RECOVERY_REQUIRED",
              message: "Resume this Run with POST /v1/runs and the original context before cancelling it",
            } });
            return;
          }
          if (run) { writeJson(response, 409, { ok: false, error: "Run is not active" }); return; }
        }
        if (!run) { writeJson(response, 404, { ok: false, error: "Run was not found" }); return; }
        await run.handle.cancel();
        writeJson(response, 200, { ok: true });
        return;
      }
      writeJson(response, 405, { ok: false, error: "Method not allowed" });
      return;
    }
    const artifactRoute = pathname.match(/^\/artifacts\/([^/]+)\/(artifact_[a-f0-9]{24})$/u);
    if (request.method === "GET" && artifactRoute) {
      try {
        const runId = decodeURIComponent(artifactRoute[1] ?? "");
        const artifactId = artifactRoute[2] ?? "";
        const { artifact, content } = await harness.readArtifact(runId, artifactId);
        response.writeHead(200, {
          "content-type": artifact.mimeType,
          "content-length": String(content.byteLength),
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(artifact.name)}`,
          "cache-control": "private, no-store",
          "content-security-policy": "sandbox; default-src 'none'",
          "x-content-type-options": "nosniff",
        });
        response.end(content);
      } catch (error) {
        writeJson(response, 404, { ok: false, error: error instanceof Error ? error.message : "Artifact was not found" });
      }
      return;
    }
    if (request.method === "GET" && pathname === "/approvals") {
      writeJson(response, 200, { approvals: approvalBroker.list() });
      return;
    }
    if (request.method === "POST" && pathname === "/approvals") {
      try {
        const candidate = await requestObject(request);
        if (!approvalBroker.decide(candidate)) throw new Error("Approval is invalid, stale, or no longer pending");
        writeJson(response, 200, { ok: true });
      } catch (error) {
        writeJson(response, 409, { ok: false, error: error instanceof Error ? error.message : "Approval failed" });
      }
      return;
    }
    if (request.method === "GET" && pathname === "/permissions") {
      writeJson(response, 200, { permissions: (await harness.listPermissions()).map(({ harnessId: _harnessId, ...permission }) => permission) });
      return;
    }
    if (request.method === "DELETE" && pathname === "/permissions") {
      const toolId = url.searchParams.get("tool");
      const connectionId = url.searchParams.get("connection") ?? undefined;
      if (!toolId || !TOOL_ID.test(toolId) || (connectionId && !/^[a-z][a-z0-9._-]{0,127}$/.test(connectionId))) {
        writeJson(response, 400, { ok: false, error: "An exact Tool id and optional Connection id are required" });
        return;
      }
      const revoked = await harness.revokePermission(toolId, connectionId);
      writeJson(response, revoked ? 200 : 404, { ok: revoked });
      return;
    }
    if (request.method !== "POST" || (pathname !== "/invoke" && pathname !== "/stream")) {
      const known = ["/health", "/contract", "/invoke", "/stream", "/runs", "/approvals", "/permissions", "/v1/capabilities", "/v1/runs"].includes(pathname)
        || pathname.startsWith("/v1/runs/")
        || pathname.startsWith("/artifacts/");
      writeJson(response, known ? 405 : 404, {
        ok: false,
        error: known ? "Method not allowed" : "Not found",
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
      const result = await harness.invoke(input, { signal: controller.signal });
      writeJson(response, 200, {
        ok: true,
        ...result,
        artifacts: result.artifacts.map((artifact) => ({
          ...artifact,
          downloadUrl: `/artifacts/${encodeURIComponent(result.runId)}/${artifact.id}`,
        })),
        trace: undefined,
      });
    } catch (error) {
      if (!controller.signal.aborted) console.error(error);
      if (!response.headersSent) {
        const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
          ? error.code : "HARNESS_INVOCATION_FAILED";
        writeJson(response, code === "TOOL_APPROVAL_DENIED" ? 403 : 500, {
          ok: false,
          error: { code, message: error instanceof Error ? error.message : "Harness invocation failed" },
        });
      }
    }
  });
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolveListen());
    });
    console.log(`Harnest API ready at http://127.0.0.1:${port}`);
    console.log("GET /v1/capabilities, /v1/runs/:id/events, /v1/runs/:id/snapshot · POST /v1/runs, /v1/runs/:id/commands");
    console.log("Compatibility: /contract, /runs, /invoke, /stream (NDJSON)");
    await new Promise<void>((resolveStop) => {
      process.once("SIGINT", resolveStop);
      process.once("SIGTERM", resolveStop);
    });
  } finally {
    approvalBroker.close();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await Promise.all([...activeRuns].map(([runId]) => releaseRunExecutionLease(projectDirectory, runId)));
    await harness.close();
  }
}

async function runs(file: string, limit: string): Promise<void> {
  const parsedLimit = Number(limit);
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 500) {
    throw new Error("runs --limit must be an integer from 1 to 500");
  }
  const store = new FileRunStore(dirname(await resolveHarnessFile(file)));
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
  const events = await new FileRunStore(dirname(await resolveHarnessFile(file))).read(runId);
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

const connectionProject = async (file: string): Promise<string> => dirname(await resolveHarnessFile(file));

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
  const manager = new ConnectionManager(await connectionProject(file));
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
  const profiles = await new ConnectionManager(await connectionProject(file)).list();
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

async function permissions(
  action: string,
  toolId: string | undefined,
  file: string,
  connectionId: string | undefined,
  json: boolean,
): Promise<void> {
  const absolute = await resolveHarnessFile(file);
  const services = new NodeRuntimeServices(dirname(absolute), { harnessId: absolute });
  try {
    if (action === "list") {
      const grants = (await services.listToolPermissions()).map(({ harnessId: _harnessId, ...grant }) => grant);
      if (json) console.log(JSON.stringify(grants, null, 2));
      else for (const grant of grants) console.log(`${grant.toolId}\t${grant.connectionId ?? "-"}\t${grant.createdAt}`);
      return;
    }
    if (action !== "revoke" || !toolId || !TOOL_ID.test(toolId)) {
      throw new Error("permissions requires list [file] or revoke <tool-id> [file]");
    }
    if (!await services.revokeToolPermission(toolId, connectionId)) {
      throw new Error(`No matching permission for Tool '${toolId}'${connectionId ? ` and Connection '${connectionId}'` : ""}`);
    }
    if (json) console.log(JSON.stringify({ ok: true, toolId, ...(connectionId ? { connectionId } : {}) }));
    else console.log(`Revoked ${toolId}${connectionId ? ` · ${connectionId}` : ""}`);
  } finally {
    await services.close();
  }
}

async function connectionAction(action: string, id: string, file: string): Promise<void> {
  const manager = new ConnectionManager(await connectionProject(file));
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
  const projectDirectory = await connectionProject(file);
  const store = new NodeSkillStore({ projectDirectory });
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
        projectDirectory,
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
  const resolvedFile = await resolveHarnessFile(file);
  const studioPackage = createRequire(import.meta.url).resolve("@harnestai/studio/package.json");
  const studioDirectory = dirname(studioPackage);
  let studioCwd = studioDirectory;
  let temporaryStudio: string | undefined;
  if (studioDirectory.split(sep).includes("node_modules")) {
    temporaryStudio = await mkdtemp(join(tmpdir(), "harnest-studio-"));
    studioCwd = join(temporaryStudio, "app");
    await cp(studioDirectory, studioCwd, {
      recursive: true,
      filter: (source) => !relative(studioDirectory, source).split(sep).includes("node_modules"),
    });
    await symlink(resolve(studioDirectory, "..", ".."), join(studioCwd, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  }
  const cleanupTemporaryStudio = () => {
    if (!temporaryStudio) return;
    try {
      rmSync(temporaryStudio, { recursive: true, force: true });
    } catch {
      // Process exit must not be blocked by best-effort temporary cleanup.
    }
  };
  process.once("exit", cleanupTemporaryStudio);
  const nextCli = createRequire(studioPackage).resolve("next/dist/bin/next");
  const preapprovedTools = approvedToolIds(capabilities);
  const bindHost = process.env.HARNEST_STUDIO_HOST?.trim() || "127.0.0.1";
  const allowedStudioHosts = process.env.HARNEST_STUDIO_ALLOWED_HOSTS?.trim();
  if (bindHost === "0.0.0.0" && !allowedStudioHosts) {
    throw new Error("Remote Studio binding requires HARNEST_STUDIO_ALLOWED_HOSTS with the exact browser-visible host or IP");
  }
  try {
    const child = spawn(
      process.execPath,
      [nextCli, "dev", "--webpack", "--hostname", bindHost, "--port", String(portNumber)],
      {
        cwd: studioCwd,
        env: {
          ...process.env,
          HARNEST_FILE: resolvedFile,
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
      },
    );
    const stopOnSigint = () => {
      child.kill("SIGINT");
    };
    const stopOnSigterm = () => {
      child.kill("SIGTERM");
    };
    process.once("SIGINT", stopOnSigint);
    process.once("SIGTERM", stopOnSigterm);
    try {
      await new Promise<void>((resolvePromise, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          if (signal === "SIGINT" || signal === "SIGTERM" || code === 0) resolvePromise();
          else reject(new Error(`Studio exited with code ${code ?? signal}`));
        });
      });
    } finally {
      process.removeListener("SIGINT", stopOnSigint);
      process.removeListener("SIGTERM", stopOnSigterm);
    }
  } finally {
    process.removeListener("exit", cleanupTemporaryStudio);
    if (temporaryStudio) await rm(temporaryStudio, { recursive: true, force: true });
  }
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

  if (command === "contract") {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: { json: { type: "boolean" } },
    });
    if (positionals.length !== 1) throw new Error("contract requires one file");
    await contract(positionals[0]!, values.json ?? false);
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
    if (action !== "serve") throw new Error("mcp requires serve [workspace]");
    const { values, positionals } = parseArgs({
      args: mcpArgs,
      allowPositionals: true,
      strict: true,
      options: {
        transport: { type: "string", default: "stdio" },
        host: { type: "string", default: "127.0.0.1" },
        port: { type: "string", short: "p", default: "8790" },
        "allowed-host": { type: "string", multiple: true },
        "allowed-origin": { type: "string", multiple: true },
      },
    });
    if (positionals.length > 1) throw new Error("mcp serve accepts at most one workspace");
    if (values.transport !== "stdio" && values.transport !== "http") throw new Error("mcp --transport must be stdio or http");
    const port = Number(values.port);
    await serveAuthoringMcp({
      workspaceRoot: positionals[0] ?? ".",
      transport: values.transport,
      host: values.host,
      port,
      ...(values["allowed-host"] ? { allowedHosts: values["allowed-host"] } : {}),
      ...(values["allowed-origin"] ? { allowedOrigins: values["allowed-origin"] } : {}),
    });
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

  if (command === "permissions") {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: { json: { type: "boolean" }, connection: { type: "string" } },
    });
    const action = positionals[0];
    if (!action) throw new Error("permissions requires list or revoke");
    const toolId = action === "revoke" ? positionals[1] : undefined;
    const file = action === "revoke" ? positionals[2] ?? "harnest.yaml" : positionals[1] ?? "harnest.yaml";
    await permissions(action, toolId, file, values.connection, values.json ?? false);
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
