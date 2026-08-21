import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { Client, StreamableHTTPClientTransport, type Tool } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { AdapterError, AdapterRegistry, type ModelAdapter } from "./adapter.js";
import type {
  ComponentDefinition,
  ComponentRegistry,
  RuntimeServices,
  ServiceExecutionContext,
  ServiceResult,
} from "./component.js";
import type { RunEvent } from "./runtime.js";
import {
  parseSpec,
  stringifySpec,
  type Diagnostic,
  type HarnessSpec,
  type ParseResult,
  type ValidationResult,
} from "./spec.js";
import type { ToolDefinition, ToolRegistry } from "./tool.js";

export async function loadSpecFile(filePath: string): Promise<ParseResult> {
  try {
    return parseSpec(await readFile(filePath, "utf8"));
  } catch (error) {
    return {
      ok: false,
      diagnostics: [{
        code: "FILE_READ",
        path: filePath,
        message: error instanceof Error ? error.message : `Could not read '${filePath}'`,
        severity: "error",
      }],
    };
  }
}

export async function saveSpecFile(filePath: string, spec: HarnessSpec): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, stringifySpec(spec), "utf8");
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true });
  }
}

const packageSpecifier = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

const isInside = (root: string, target: string): boolean => {
  const path = relative(root, target);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

async function moduleUrl(specifier: string, baseDir: string, code: string): Promise<string> {
  if (packageSpecifier.test(specifier)) return specifier;
  if (!specifier.startsWith("./") && !specifier.startsWith(".\\")) {
    throw new AdapterError(
      `Module '${specifier}' must be an npm package or a project-relative path`,
      { adapterId: specifier, code },
    );
  }
  const root = await realpath(resolve(baseDir));
  const target = await realpath(resolve(root, specifier));
  if (!isInside(root, target)) {
    throw new AdapterError(
      `Module '${specifier}' resolves outside the Harness project`,
      { adapterId: specifier, code },
    );
  }
  return pathToFileURL(target).href;
}

export interface ModuleLoadOptions {
  readonly allowModuleExecution: true;
}

export type AdapterModuleLoadOptions = ModuleLoadOptions;

interface AdapterModule {
  default?: unknown;
  adapter?: unknown;
  adapters?: unknown;
  register?: (registry: AdapterRegistry) => unknown;
}

const importModule = (specifier: string): Promise<Record<string, unknown>> =>
  import(/* webpackIgnore: true */ /* @vite-ignore */ specifier) as Promise<Record<string, unknown>>;

export async function loadAdapterModules(
  spec: HarnessSpec,
  registry: AdapterRegistry,
  baseDir: string,
  options?: AdapterModuleLoadOptions,
): Promise<ValidationResult> {
  const specifiers = spec.runtime?.adapters ?? [];
  if (specifiers.length > 0 && options?.allowModuleExecution !== true) {
    return {
      ok: false,
      diagnostics: [{
        code: "ADAPTER_MODULE_EXECUTION_DISABLED",
        path: "$.runtime.adapters",
        message: "Adapter modules are executable code; explicitly allow module execution",
        hint: "Review the project, then pass { allowModuleExecution: true }",
        severity: "error",
      }],
    };
  }
  const diagnostics: Diagnostic[] = [];
  for (const specifier of specifiers) {
    try {
      const loaded = await importModule(
        await moduleUrl(specifier, baseDir, "ADAPTER_MODULE_UNTRUSTED"),
      ) as AdapterModule;
      if (typeof loaded.register === "function") {
        await loaded.register(registry);
        continue;
      }
      const exported = loaded.default !== undefined
        ? [loaded.default]
        : loaded.adapter !== undefined
          ? [loaded.adapter]
          : Array.isArray(loaded.adapters)
            ? loaded.adapters
            : [];
      if (exported.length === 0) throw new AdapterError(
        `Adapter module '${specifier}' has no default adapter, adapter, adapters, or register export`,
        { adapterId: specifier, code: "ADAPTER_MODULE_INVALID" },
      );
      for (const adapter of exported) registry.register(adapter as ModelAdapter);
    } catch (error) {
      diagnostics.push({
        code: error instanceof AdapterError ? error.code : "ADAPTER_MODULE_LOAD",
        path: "$.runtime.adapters",
        message: error instanceof Error ? error.message : `Could not load adapter module '${specifier}'`,
        hint: `Check that '${specifier}' is installed and exports a ModelAdapter`,
        severity: "error",
      });
    }
  }
  return { ok: diagnostics.length === 0, diagnostics };
}

export interface RuntimeModuleRegistries {
  readonly adapters: AdapterRegistry;
  readonly components: ComponentRegistry;
  readonly tools: ToolRegistry;
}

interface RuntimeModule {
  adapters?: unknown;
  adapter?: unknown;
  components?: unknown;
  component?: unknown;
  tools?: unknown;
  tool?: unknown;
  register?: (registries: RuntimeModuleRegistries) => unknown;
}

const candidates = (plural: unknown, singular: unknown): unknown[] =>
  Array.isArray(plural) ? plural : singular === undefined ? [] : [singular];

export async function loadRuntimeModules(
  spec: HarnessSpec,
  registries: RuntimeModuleRegistries,
  baseDir: string,
  options?: ModuleLoadOptions,
): Promise<ValidationResult> {
  const specifiers = spec.version === "0.2" ? spec.runtime?.modules ?? [] : [];
  if (specifiers.length > 0 && options?.allowModuleExecution !== true) {
    return {
      ok: false,
      diagnostics: [{
        code: "RUNTIME_MODULE_EXECUTION_DISABLED",
        path: "$.runtime.modules",
        message: "Runtime modules are executable code; explicitly allow module execution",
        hint: "Review the project, then pass { allowModuleExecution: true }",
        severity: "error",
      }],
    };
  }
  const diagnostics: Diagnostic[] = [];
  for (const specifier of specifiers) {
    try {
      const loaded = await importModule(
        await moduleUrl(specifier, baseDir, "RUNTIME_MODULE_UNTRUSTED"),
      ) as RuntimeModule;
      if (typeof loaded.register === "function") {
        await loaded.register(registries);
        continue;
      }
      const adapters = candidates(loaded.adapters, loaded.adapter);
      const components = candidates(loaded.components, loaded.component);
      const tools = candidates(loaded.tools, loaded.tool);
      if (adapters.length + components.length + tools.length === 0) {
        throw new Error(`Runtime module '${specifier}' has no adapters, components, tools, or register export`);
      }
      for (const adapter of adapters) registries.adapters.register(adapter as ModelAdapter);
      for (const component of components) registries.components.register(component as ComponentDefinition);
      for (const tool of tools) registries.tools.register(tool as ToolDefinition);
    } catch (error) {
      diagnostics.push({
        code: error instanceof AdapterError ? error.code : "RUNTIME_MODULE_LOAD",
        path: "$.runtime.modules",
        message: error instanceof Error ? error.message : `Could not load runtime module '${specifier}'`,
        hint: `Check that '${specifier}' is installed and exports registered adapters, components, or tools`,
        severity: "error",
      });
    }
  }
  return { ok: diagnostics.length === 0, diagnostics };
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const asText = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) return { value, truncated: false };
  return { value: buffer.subarray(0, maxBytes).toString("utf8"), truncated: true };
}

async function projectRoot(path: string): Promise<string> {
  return realpath(resolve(path));
}

async function projectEntry(root: string, configuredPath: unknown): Promise<string> {
  if (typeof configuredPath !== "string" || configuredPath.length === 0 || isAbsolute(configuredPath)) {
    throw new Error("Context path must be a non-empty project-relative path");
  }
  const target = await realpath(resolve(root, configuredPath));
  if (!isInside(root, target)) throw new Error(`Context path '${configuredPath}' resolves outside the Harness project`);
  return target;
}

function isSensitiveProjectPath(root: string, target: string): boolean {
  const segments = relative(root, target).split(sep);
  return segments.some((segment) =>
    segment.startsWith(".")
    || /^(?:credentials?|secrets?|service[-_]?account|firebase[-_]?adminsdk|id_(?:dsa|ecdsa|ed25519|rsa))(?:[._-]|$)/i.test(segment)
    || /\.(?:jks|key|keystore|p12|pfx|pem)$/i.test(segment));
}

async function storageDirectory(root: string, child?: string): Promise<string> {
  const directory = resolve(root, ".harnest", ...(child ? [child] : []));
  if (!isInside(root, directory)) throw new Error("Invalid Harnest storage directory");
  await mkdir(directory, { recursive: true });
  const canonical = await realpath(directory);
  if (!isInside(root, canonical)) throw new Error("Harnest storage resolves outside the project");
  return canonical;
}

async function readBounded(file: string, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    return {
      text: buffer.subarray(0, Math.min(bytesRead, maxBytes)).toString("utf8"),
      truncated: bytesRead > maxBytes,
    };
  } finally {
    await handle.close();
  }
}

function globExpression(pattern: string): RegExp {
  const normalized = pattern.replaceAll("\\", "/");
  let expression = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index] ?? "";
    const next = normalized[index + 1];
    if (character === "*" && next === "*") {
      if (normalized[index + 2] === "/") {
        expression += "(?:.*/)?";
        index += 2;
      } else {
        expression += ".*";
        index += 1;
      }
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
    }
  }
  return new RegExp(`${expression}$`, "u");
}

interface ContextFile {
  readonly path: string;
  readonly relativePath: string;
}

async function contextFiles(
  root: string,
  directory: string,
  pattern: RegExp,
): Promise<{ files: ContextFile[]; truncated: boolean }> {
  const files: ContextFile[] = [];
  const visited = new Set<string>();
  let inspected = 0;
  let truncated = false;
  const walk = async (current: string): Promise<void> => {
    const canonical = await realpath(current);
    if (!isInside(root, canonical) || visited.has(canonical)) return;
    visited.add(canonical);
    const entries = await readdir(canonical, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (files.length >= 256 || inspected >= 2_048) {
        truncated = true;
        return;
      }
      inspected += 1;
      const target = await realpath(join(canonical, entry.name));
      if (!isInside(root, target) || isSensitiveProjectPath(root, target)) continue;
      const info = await stat(target);
      if (info.isDirectory()) {
        await walk(target);
      } else if (info.isFile()) {
        const relativePath = relative(directory, target).split(sep).join("/");
        if (pattern.test(relativePath)) files.push({ path: target, relativePath });
      }
    }
  };
  await walk(directory);
  return { files, truncated };
}

const queryTokens = (query: unknown): string[] => [
  ...new Set(truncateUtf8(asText(query), 8_192).value.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? []),
].slice(0, 32);

function relevance(path: string, text: string, tokens: readonly string[]): number {
  if (tokens.length === 0) return 0;
  const lowerPath = path.toLocaleLowerCase();
  const lowerText = text.toLocaleLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (lowerPath.includes(token)) score += 8;
    let offset = 0;
    for (let matches = 0; matches < 20; matches += 1) {
      offset = lowerText.indexOf(token, offset);
      if (offset < 0) break;
      score += 1;
      offset += token.length;
    }
  }
  return score;
}

export class FileMemoryStore {
  readonly #root: Promise<string>;
  #pending: Promise<unknown> = Promise.resolve();

  constructor(projectDirectory: string) {
    this.#root = projectRoot(projectDirectory);
  }

  async access(config: Readonly<Record<string, unknown>>, value: unknown): Promise<ServiceResult> {
    const task = this.#pending.then(() => this.#access(config, value), () => this.#access(config, value));
    this.#pending = task.catch(() => undefined);
    return task;
  }

  async #access(config: Readonly<Record<string, unknown>>, value: unknown): Promise<ServiceResult> {
    const key = config.key;
    const operation = config.operation;
    if (typeof key !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(key)) {
      throw new Error("Memory key is invalid");
    }
    if (operation !== "read" && operation !== "write" && operation !== "append") {
      throw new Error("Memory operation is invalid");
    }
    const root = await this.#root;
    const directory = await storageDirectory(root);
    const file = join(directory, "memory.json");
    let memory: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    try {
      const info = await stat(file);
      if (info.size > 1_048_576) throw new Error("Project memory exceeds the 1 MiB safety limit");
      const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
      const record = asRecord(parsed);
      if (!record) throw new Error("Project memory must contain a JSON object");
      memory = Object.assign(Object.create(null) as Record<string, unknown>, record);
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }

    let result: unknown;
    let changed = false;
    if (operation === "read") {
      if (Object.hasOwn(memory, key)) {
        result = memory[key];
      } else if (Object.hasOwn(config, "initial")) {
        result = config.initial;
        memory[key] = result;
        changed = true;
      }
    } else if (operation === "write") {
      result = value ?? null;
      memory[key] = result;
      changed = true;
    } else {
      const previous = memory[key];
      result = Array.isArray(previous)
        ? [...previous, value ?? null]
        : previous === undefined
          ? [value ?? null]
          : [previous, value ?? null];
      memory[key] = result;
      changed = true;
    }

    if (changed) {
      const serialized = JSON.stringify(memory, null, 2);
      if (byteLength(serialized) > 1_048_576) throw new Error("Project memory exceeds the 1 MiB safety limit");
      const temporary = join(directory, `memory.${process.pid}.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
        await rename(temporary, file);
      } finally {
        await rm(temporary, { force: true });
      }
    }
    return { value: result, metadata: { key, operation } };
  }
}

export interface NodeRuntimeServiceOptions {
  readonly allowFileSystem?: true;
  readonly allowedContextRoots?: readonly string[];
  readonly allowProcessCommands?: readonly string[];
  readonly allowNetworkHosts?: true | readonly string[];
  readonly maxContextBytes?: number;
}

interface McpConnection {
  readonly client: Client;
  readonly transport: StdioClientTransport | StreamableHTTPClientTransport;
  readonly tool: Tool;
}

function protocolMode(config: Readonly<Record<string, unknown>>, transport: "stdio" | "http") {
  const protocol = config.protocol ?? (transport === "http" ? "auto" : "legacy");
  if (protocol === "auto") return { mode: "auto" as const };
  if (protocol === "2026-07-28") return { mode: { pin: "2026-07-28" } as const };
  return { mode: "legacy" as const };
}

export class NodeRuntimeServices implements RuntimeServices {
  readonly #root: Promise<string>;
  readonly #memory: FileMemoryStore;
  readonly #options: NodeRuntimeServiceOptions;
  readonly #connections = new Map<string, Promise<McpConnection>>();

  constructor(projectDirectory: string, options: NodeRuntimeServiceOptions = {}) {
    this.#root = projectRoot(projectDirectory);
    this.#memory = new FileMemoryStore(projectDirectory);
    this.#options = options;
  }

  async loadContext(
    config: Readonly<Record<string, unknown>>,
    query: unknown,
    _context: ServiceExecutionContext,
  ): Promise<ServiceResult> {
    const root = await this.#root;
    const configured = typeof config.maxBytes === "number" ? Math.floor(config.maxBytes) : 262_144;
    const allowed = Math.min(Math.max(1, this.#options.maxContextBytes ?? 4_194_304), 10_000_000);
    const maxBytes = Math.min(Math.max(1, configured), allowed);
    if (config.source === "text") {
      const selected = truncateUtf8(typeof config.text === "string" ? config.text : "", maxBytes);
      return {
        value: selected.value,
        metadata: { source: "text", bytes: byteLength(selected.value), truncated: selected.truncated },
      };
    }
    if (this.#options.allowFileSystem !== true) {
      throw new Error("File and directory Context require explicit filesystem permission");
    }
    const path = await projectEntry(root, config.path);
    if (isSensitiveProjectPath(root, path)) {
      throw new Error("Context cannot read hidden Harnest metadata or common secret files");
    }
    if (this.#options.allowedContextRoots?.length) {
      const allowedRoots = await Promise.all(this.#options.allowedContextRoots.map((entry) => projectEntry(root, entry)));
      if (!allowedRoots.some((allowedRoot) => isInside(allowedRoot, path))) {
        throw new Error("Context path is outside the explicitly allowed Context roots");
      }
    }
    if (config.source === "file") {
      const info = await stat(path);
      if (!info.isFile()) throw new Error("Context file path is not a file");
      const selected = await readBounded(path, maxBytes);
      return {
        value: selected.text,
        metadata: {
          source: "file",
          paths: [relative(root, path).split(sep).join("/")],
          bytes: byteLength(selected.text),
          truncated: selected.truncated,
        },
      };
    }
    if (config.source !== "directory") throw new Error("Context source is invalid");
    if (!(await stat(path)).isDirectory()) throw new Error("Context directory path is not a directory");
    const configuredPattern = typeof config.pattern === "string" ? config.pattern : "**/*";
    if (configuredPattern.length > 512) throw new Error("Context file pattern is too long");
    const pattern = globExpression(configuredPattern);
    const listing = await contextFiles(root, path, pattern);
    const files = listing.files;
    const tokens = queryTokens(query);
    let scanRemaining = Math.min(4_194_304, allowed);
    const documents: Array<ContextFile & { text: string; score: number; truncated: boolean }> = [];
    for (const file of files) {
      if (scanRemaining <= 0) break;
      const readLimit = Math.min(65_536, scanRemaining);
      const loaded = await readBounded(file.path, readLimit);
      scanRemaining -= byteLength(loaded.text);
      documents.push({
        ...file,
        text: loaded.text,
        score: relevance(file.relativePath, loaded.text, tokens),
        truncated: loaded.truncated,
      });
    }
    documents.sort((left, right) =>
      right.score - left.score || left.relativePath.localeCompare(right.relativePath));
    const topK = Math.min(
      Math.max(1, typeof config.topK === "number" ? Math.floor(config.topK) : 5),
      20,
    );
    const selected = documents.slice(0, topK);
    const rendered = selected
      .map((document) => `--- ${document.relativePath} ---\n${document.text}`)
      .join("\n\n");
    const bounded = truncateUtf8(rendered, maxBytes);
    return {
      value: bounded.value,
      metadata: {
        source: "directory",
        paths: selected.map((document) => relative(root, document.path).split(sep).join("/")),
        bytes: byteLength(bounded.value),
        truncated: bounded.truncated
          || selected.some((document) => document.truncated)
          || documents.length < files.length
          || listing.truncated,
      },
    };
  }

  accessMemory(
    config: Readonly<Record<string, unknown>>,
    value: unknown,
    _context: ServiceExecutionContext,
  ): Promise<ServiceResult> {
    return this.#memory.access(config, value);
  }

  async callMcpTool(
    config: Readonly<Record<string, unknown>>,
    input: unknown,
    context: ServiceExecutionContext,
  ): Promise<ServiceResult> {
    const args = asRecord(input);
    if (!args) throw new Error("MCP Tool arguments must be an object");
    const pending = this.#connection(config, context);
    const connection = await pending;
    const timeout = typeof config.timeoutMs === "number" ? config.timeoutMs : 30_000;
    const invoke = () => connection.client.callTool(
      { name: connection.tool.name, arguments: args },
      {
        signal: context.signal,
        timeout,
        maxTotalTimeout: timeout,
        toolDefinition: connection.tool,
      },
    );
    let result: Awaited<ReturnType<typeof invoke>>;
    try {
      result = await invoke();
    } catch (error) {
      await this.#evictConnection(context.nodeId, pending, connection);
      throw error;
    }
    if (result.isError === true) {
      throw new Error(`MCP tool '${connection.tool.name}' returned an error result`);
    }
    return {
      value: result.structuredContent !== undefined ? result.structuredContent : result.content,
      metadata: {
        transport: config.transport,
        tool: connection.tool.name,
        protocol: connection.client.getNegotiatedProtocolVersion() ?? "unknown",
        isError: false,
      },
    };
  }

  async close(): Promise<void> {
    const settled = await Promise.allSettled(this.#connections.values());
    this.#connections.clear();
    await Promise.allSettled(settled.flatMap((result) => {
      if (result.status === "rejected") return [];
      return [this.#closeConnection(result.value)];
    }));
  }

  async #evictConnection(
    nodeId: string,
    pending: Promise<McpConnection>,
    connection: McpConnection,
  ): Promise<void> {
    if (this.#connections.get(nodeId) !== pending) return;
    this.#connections.delete(nodeId);
    await this.#closeConnection(connection);
  }

  async #closeConnection({ client, transport }: McpConnection): Promise<void> {
    await Promise.allSettled([
      ...(transport instanceof StreamableHTTPClientTransport && transport.sessionId
        ? [Promise.resolve().then(() => transport.terminateSession())]
        : []),
      Promise.resolve().then(() => client.close()),
    ]);
  }

  #connection(
    config: Readonly<Record<string, unknown>>,
    context: ServiceExecutionContext,
  ): Promise<McpConnection> {
    const existing = this.#connections.get(context.nodeId);
    if (existing) return existing;
    const pending = this.#connect(config, context);
    this.#connections.set(context.nodeId, pending);
    void pending.catch(() => {
      if (this.#connections.get(context.nodeId) === pending) this.#connections.delete(context.nodeId);
    });
    return pending;
  }

  async #connect(
    config: Readonly<Record<string, unknown>>,
    context: ServiceExecutionContext,
  ): Promise<McpConnection> {
    const root = await this.#root;
    const transportType = config.transport;
    const toolName = config.tool;
    if ((transportType !== "stdio" && transportType !== "http") || typeof toolName !== "string") {
      throw new Error("MCP transport or tool is invalid");
    }
    const timeout = typeof config.timeoutMs === "number" ? config.timeoutMs : 30_000;
    let transport: StdioClientTransport | StreamableHTTPClientTransport;
    if (transportType === "stdio") {
      if (typeof config.command !== "string" || config.command.length === 0) {
        throw new Error("MCP stdio requires config.command");
      }
      if (!this.#options.allowProcessCommands?.includes(config.command)) {
        throw new Error(`MCP stdio command '${config.command}' is not explicitly allowed`);
      }
      if (config.args !== undefined
        && (!Array.isArray(config.args) || !config.args.every((item) => typeof item === "string"))) {
        throw new Error("MCP stdio args must be strings");
      }
      transport = new StdioClientTransport({
        command: config.command,
        ...(Array.isArray(config.args) ? { args: config.args as string[] } : {}),
        cwd: root,
        env: getDefaultEnvironment(),
        stderr: "pipe",
      });
    } else {
      if (typeof config.url !== "string") throw new Error("MCP HTTP requires config.url");
      const url = new URL(config.url);
      this.#assertNetworkUrl(url);
      const headers = new Headers();
      if (config.headers !== undefined) {
        const configuredHeaders = asRecord(config.headers);
        if (!configuredHeaders) throw new Error("MCP HTTP headers must be an object");
        for (const [name, raw] of Object.entries(configuredHeaders)) {
          if (typeof raw !== "string") throw new Error(`MCP HTTP header '${name}' must be a string`);
          if (!/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) {
            throw new Error(`MCP HTTP header '${name}' must use an env:NAME secret reference`);
          }
          const value = context.resolveSecret(raw);
          if (value === undefined) throw new Error(`MCP HTTP secret reference '${raw}' is unavailable`);
          headers.set(name, value);
        }
      }
      const guardedFetch: typeof fetch = async (request, init) => {
        const requestUrl = new URL(request instanceof Request ? request.url : request.toString());
        this.#assertNetworkUrl(requestUrl);
        return fetch(request, { ...init, redirect: "error" });
      };
      transport = new StreamableHTTPClientTransport(url, {
        fetch: guardedFetch,
        requestInit: { headers, redirect: "error" },
        onInsufficientScope: "throw",
      });
    }
    const client = new Client(
      { name: "harnest", version: "0.2.0" },
      { versionNegotiation: protocolMode(config, transportType), listMaxPages: 16 },
    );
    try {
      await client.connect(transport, {
        signal: context.signal,
        timeout,
        maxTotalTimeout: timeout,
      });
      const listed = await client.listTools(undefined, {
        signal: context.signal,
        timeout,
        maxTotalTimeout: timeout,
      });
      const tool = listed.tools.find((candidate) => candidate.name === toolName);
      if (!tool) throw new Error(`MCP server does not expose configured tool '${toolName}'`);
      return { client, transport, tool };
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  #assertNetworkUrl(url: URL): void {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("MCP URL must use http or https");
    }
    if (url.username || url.password) throw new Error("MCP URL must not contain credentials");
    const allowed = this.#options.allowNetworkHosts;
    const normalized = url.host.toLocaleLowerCase();
    const hosts = Array.isArray(allowed) ? allowed.map((host) => host.toLocaleLowerCase()) : [];
    if (allowed !== true && !hosts.includes(normalized)) {
      throw new Error(`MCP HTTP host '${url.host}' is not explicitly allowed`);
    }
  }
}

export interface StoredRunEvent extends Readonly<Record<string, unknown>> {
  readonly type: string;
  readonly runId: string;
  readonly timestamp: string;
}

export interface RunSummary {
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly status: "running" | "succeeded" | "failed";
  readonly durationMs?: number;
  readonly eventCount: number;
}

const sensitiveKey = /^(?:authorization|cookies?|credentials?|password|secrets?|tokens?|access[-_]?token|refresh[-_]?token|api[-_]?key|headers?)$/i;

function valueShape(value: unknown): unknown {
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) return { type: "array", length: value.length };
  if (typeof value === "object") {
    return {
      type: "object",
      keys: Object.keys(value as object).slice(0, 32).map((key) => truncateUtf8(key, 64).value),
    };
  }
  if (typeof value === "string") return { type: "string", bytes: byteLength(value) };
  return { type: typeof value };
}

function safeTraceValue(
  value: unknown,
  key = "",
  depth = 0,
  budget: { remaining: number } = { remaining: 32_768 },
): unknown {
  if (budget.remaining <= 0) return "[TRUNCATED]";
  if (sensitiveKey.test(key)) {
    budget.remaining -= 10;
    return "[REDACTED]";
  }
  if (typeof value === "string") {
    const selected = truncateUtf8(value, Math.min(512, budget.remaining)).value;
    budget.remaining -= byteLength(selected);
    return selected;
  }
  if (value === null || typeof value !== "object") {
    budget.remaining -= 16;
    return value;
  }
  if (depth >= 3) {
    budget.remaining -= Math.min(512, budget.remaining);
    return valueShape(value);
  }
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const item of value.slice(0, 20)) {
      if (budget.remaining <= 0) break;
      result.push(safeTraceValue(item, "", depth + 1, budget));
    }
    return result;
  }
  const result: Record<string, unknown> = {};
  for (const [name, item] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
    if (budget.remaining <= 0) break;
    budget.remaining -= Math.min(byteLength(name), 128);
    result[name] = safeTraceValue(item, name, depth + 1, budget);
  }
  return result;
}

function storedEvent(event: RunEvent): StoredRunEvent {
  return safeTraceValue(event) as StoredRunEvent;
}

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export class FileRunStore {
  readonly #root: Promise<string>;
  readonly #pending = new Map<string, Promise<void>>();

  constructor(projectDirectory: string) {
    this.#root = projectRoot(projectDirectory);
  }

  append(event: RunEvent): Promise<void> {
    if (!RUN_ID.test(event.runId)) return Promise.reject(new Error("Run id is invalid"));
    const previous = this.#pending.get(event.runId) ?? Promise.resolve();
    const next = previous.then(() => this.#append(event), () => this.#append(event));
    this.#pending.set(event.runId, next);
    void next.finally(() => {
      if (this.#pending.get(event.runId) === next) this.#pending.delete(event.runId);
    }).catch(() => undefined);
    return next;
  }

  async read(runId: string): Promise<StoredRunEvent[]> {
    if (!RUN_ID.test(runId)) throw new Error("Run id is invalid");
    await this.#pending.get(runId);
    const directory = await storageDirectory(await this.#root, "runs");
    const text = await readFile(join(directory, `${runId}.ndjson`), "utf8");
    const events: StoredRunEvent[] = [];
    for (const [index, line] of text.split(/\r?\n/u).entries()) {
      if (!line) continue;
      try {
        const event = JSON.parse(line) as unknown;
        const record = asRecord(event);
        if (!record
          || typeof record.type !== "string"
          || typeof record.runId !== "string"
          || typeof record.timestamp !== "string") {
          throw new Error("event shape is invalid");
        }
        events.push(record as StoredRunEvent);
      } catch (error) {
        throw new Error(
          `Invalid run trace at line ${index + 1}: ${error instanceof Error ? error.message : "invalid JSON"}`,
          { cause: error },
        );
      }
    }
    return events;
  }

  async list(limit = 50): Promise<RunSummary[]> {
    const boundedLimit = Math.min(Math.max(1, Math.floor(limit)), 500);
    const directory = await storageDirectory(await this.#root, "runs");
    const files = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ndjson"))
      .map((entry) => entry.name.slice(0, -7))
      .filter((runId) => RUN_ID.test(runId));
    const ordered = await Promise.all(files.map(async (runId) => ({
      runId,
      modified: (await stat(join(directory, `${runId}.ndjson`))).mtimeMs,
    })));
    ordered.sort((left, right) => right.modified - left.modified);
    // ponytail: scanning the newest NDJSON files is enough until projects reach thousands of local runs.
    const summaries: RunSummary[] = [];
    for (const { runId } of ordered.slice(0, boundedLimit)) {
      const events = await this.read(runId);
      const first = events[0];
      const last = events.at(-1);
      const ended = [...events].reverse().find((event) => event.type === "run-end");
      const failed = [...events].reverse().find((event) => event.type === "error");
      const finished = ended ?? failed ?? last;
      summaries.push({
        runId,
        startedAt: first?.timestamp ?? new Date(0).toISOString(),
        ...(finished?.timestamp ? { finishedAt: finished.timestamp } : {}),
        status: ended ? "succeeded" : failed ? "failed" : "running",
        ...(typeof ended?.durationMs === "number" ? { durationMs: ended.durationMs } : {}),
        eventCount: events.length,
      });
    }
    return summaries;
  }

  async #append(event: RunEvent): Promise<void> {
    const directory = await storageDirectory(await this.#root, "runs");
    await appendFile(
      join(directory, `${event.runId}.ndjson`),
      `${JSON.stringify(storedEvent(event))}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  }
}
