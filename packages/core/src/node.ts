import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { Client, StreamableHTTPClientTransport, type Tool } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { build } from "esbuild";
import { AdapterError, AdapterRegistry, type ModelAdapter } from "./adapter.js";
import type { ConnectionProfile } from "./connection.js";
import type {
  ComponentDefinition,
  ComponentRegistry,
  RuntimeServices,
  ServiceExecutionContext,
  ServiceResult,
} from "./component.js";
import type { RunEvent } from "./runtime.js";
import { normalizeSpec } from "./graph.js";
import {
  ConnectionManager,
  canonicalExecutable,
  containerEngineEnvironment,
  containerRunArguments,
  executeWebSearchConnection,
  executeWebScrapeConnection,
  guardedFetch,
  mcpToolApprovalId,
  openMcpConnection,
  protocolMode,
  type ContainerMount,
  type McpConnectionHandle,
} from "./node-connections.js";
import { NodeSkillStore } from "./node-skills.js";
import { atomicWriteVerifiedFile, openVerifiedFile, readVerifiedFile } from "./safe-files.js";
import {
  BUILTIN_TOOL_MANIFESTS,
  NodeToolStore,
  ToolStoreError,
  type HttpCapabilityRequest,
  type ModuleExecutionRequest,
  type ProcessCapabilityRequest,
  type ProcessExecutionRequest,
  type WebSearchRequest,
  type WebScrapeRequest,
  runBoundedProcess,
} from "./node-tools.js";
import {
  parseSpec,
  stringifySpec,
  type Diagnostic,
  type HarnessSpec,
  type ParseResult,
  type ValidationResult,
} from "./spec.js";
import type {
  ToolApprovalDecision,
  ToolApprovalRequest,
  ToolBinding,
  ToolDefinition,
  ToolRegistry,
} from "./tool.js";

export {
  ConnectionManager,
  canonicalExecutable,
  detectContainerEngine,
  guardedFetch,
  mcpToolApprovalId,
  openMcpConnection,
  protocolMode,
  type ConnectionManagerOptions,
  type ConnectionTestOptions,
  type McpConnectionHandle,
} from "./node-connections.js";
export * from "./node-skills.js";
export * from "./node-skill-install.js";
export * from "./node-tools.js";

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
  let current = root;
  for (const segment of relative(root, directory).split(sep).filter(Boolean)) {
    const next = resolve(current, segment);
    let info;
    try {
      info = await lstat(next);
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
      try {
        await mkdir(next, { mode: 0o700 });
      } catch (mkdirError) {
        if (!(mkdirError && typeof mkdirError === "object" && "code" in mkdirError && mkdirError.code === "EEXIST")) {
          throw mkdirError;
        }
      }
      info = await lstat(next);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("Harnest storage contains an unsafe link or non-directory");
    }
    current = await realpath(next);
    if (!isInside(root, current)) throw new Error("Harnest storage resolves outside the project");
  }
  return current;
}

async function readBoundedHandle(
  handle: FileHandle,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let bytesRead = 0;
  while (bytesRead <= maxBytes) {
    const chunk = Buffer.alloc(Math.min(65_536, maxBytes + 1 - bytesRead));
    const result = await handle.read(chunk, 0, chunk.byteLength, bytesRead);
    if (result.bytesRead === 0) break;
    chunks.push(chunk.subarray(0, result.bytesRead));
    bytesRead += result.bytesRead;
  }
  const buffer = Buffer.concat(chunks, bytesRead);
  return {
    text: buffer.subarray(0, Math.min(bytesRead, maxBytes)).toString("utf8"),
    truncated: bytesRead > maxBytes,
  };
}

async function readBounded(file: string, root: string, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const opened = await openVerifiedFile(file, root, "read");
  try {
    const content = await readBoundedHandle(opened.handle, maxBytes);
    await opened.verify();
    return content;
  } finally {
    await opened.handle.close();
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
      const parsed = JSON.parse((await readVerifiedFile(file, directory, 1_048_576)).toString("utf8")) as unknown;
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
      await atomicWriteVerifiedFile(file, directory, serialized);
    }
    return { value: result, metadata: { key, operation } };
  }
}

export interface NodeRuntimeServiceOptions {
  readonly allowFileSystem?: true;
  readonly allowModuleExecution?: true;
  readonly allowedContextRoots?: readonly string[];
  readonly allowProcessCommands?: readonly string[];
  readonly allowNetworkHosts?: true | readonly string[];
  readonly maxContextBytes?: number;
  readonly connectionManager?: ConnectionManager;
  readonly toolStore?: NodeToolStore;
  readonly skillStore?: NodeSkillStore;
  readonly approvedToolIds?: readonly string[];
  /** Project-contained directories exposed only to approved process sandboxes. */
  readonly sandboxWorkspace?: {
    readonly inputDirectory?: string;
    readonly outputDirectory?: string;
  };
  readonly requestToolApproval?: (
    request: ToolApprovalRequest,
    context: ServiceExecutionContext,
  ) => ToolApprovalDecision | Promise<ToolApprovalDecision>;
}

interface McpConnection {
  readonly client: Client;
  readonly transport: StdioClientTransport | StreamableHTTPClientTransport;
  readonly tools: Map<string, Tool>;
  readonly transportType: "stdio" | "http";
  readonly close?: () => Promise<void>;
}

const runtimeConnectionAvailable = (profile: ConnectionProfile): boolean =>
  profile.status.state === "connected" || profile.status.state === "unknown";

function assertRuntimeConnection(profile: ConnectionProfile): void {
  if (!runtimeConnectionAvailable(profile)) {
    throw new Error(`Connection '${profile.id}' is ${profile.status.state.replaceAll("_", " ")} and cannot be used`);
  }
}

const forbiddenToolRequestHeader = /^(?::authority|host|authorization|proxy-.+|cookies?|connection|keep-alive|te|trailer|transfer-encoding|upgrade|content-length)$/i;

export class NodeRuntimeServices implements RuntimeServices {
  readonly connectionManager: ConnectionManager;
  readonly toolStore: NodeToolStore;
  readonly skillStore: NodeSkillStore;
  readonly #projectDirectory: string;
  readonly #root: Promise<string>;
  readonly #memory: FileMemoryStore;
  readonly #options: NodeRuntimeServiceOptions;
  readonly #connections = new Map<string, Promise<McpConnection>>();
  readonly #connectionSecrets = new Map<string, { readonly value: string; readonly runIds: Set<string> }>();

  constructor(projectDirectory: string, options: NodeRuntimeServiceOptions = {}) {
    this.#projectDirectory = resolve(projectDirectory);
    this.#root = projectRoot(projectDirectory);
    this.#memory = new FileMemoryStore(projectDirectory);
    this.#options = options;
    this.connectionManager = options.connectionManager ?? new ConnectionManager(projectDirectory);
    this.skillStore = options.skillStore ?? new NodeSkillStore({ projectDirectory });
    this.toolStore = options.toolStore ?? new NodeToolStore({
      projectDirectory,
      capabilities: {
        authorizeNetworkHost: ({ url }) => {
          this.#assertNetworkUrl(url);
          return true;
        },
        performHttp: (request) => this.#performHttp(request),
        authorizeProcess: (request) => this.#authorizeProcess(request),
        executeProcess: (request) => this.#executeProcess(request),
        authorizeFile: () => options.allowFileSystem === true,
        executeModule: (request) => this.#executeModule(request),
        webSearch: (request) => this.#webSearch(request),
        webScrape: (request) => this.#webScrape(request),
      },
    });
  }

  async toolDefinitions(): Promise<readonly ToolDefinition[]> {
    return [...this.toolStore.builtinDefinitions(), ...await this.toolStore.definitions()];
  }

  async connectionDiagnostics(spec: HarnessSpec, tools: ToolRegistry): Promise<Diagnostic[]> {
    const normalized = normalizeSpec(spec);
    const profiles = new Map((await this.connectionManager.list()).map((profile) => [profile.id, profile]));
    const diagnostics: Diagnostic[] = [];
    const bodies = [
      { components: normalized.components, path: "$" },
      ...Object.entries(normalized.subgraphs).map(([name, body]) => ({
        components: body.components,
        path: `$.subgraphs.${name}`,
      })),
    ];
    for (const body of bodies) body.components.forEach((component, index) => {
      let requiredKinds: readonly string[] | undefined;
      if (component.type === "model") requiredKinds = ["provider"];
      else if (component.type === "mcp-tool") requiredKinds = ["mcp"];
      else if (component.type === "tool" && typeof component.config.tool === "string") {
        requiredKinds = tools.has(component.config.tool)
          ? tools.get(component.config.tool).connectionKinds
          : ["mcp"];
      }
      if (!requiredKinds?.length) return;
      const fields = component.type === "model" ? ["connectionId", "fallbackConnectionId"] : ["connectionId"];
      for (const field of fields) {
        const connectionId = typeof component.config[field] === "string" && component.config[field].length
          ? component.config[field] as string : undefined;
        if (!connectionId) continue;
        const path = `${body.path}.components[${index}].config.${field}`;
        const profile = profiles.get(connectionId);
        if (!profile) {
          diagnostics.push({
            code: "CONNECTION_NOT_FOUND",
            path,
            message: `Connection '${connectionId}' does not exist`,
            componentId: component.id,
            severity: "error",
          });
          continue;
        }
        if (!runtimeConnectionAvailable(profile)) {
          diagnostics.push({
            code: profile.status.state === "disconnected" ? "CONNECTION_DISCONNECTED" : "CONNECTION_UNAVAILABLE",
            path,
            message: `Connection '${connectionId}' is ${profile.status.state.replaceAll("_", " ")} and cannot be used`,
            componentId: component.id,
            severity: "error",
          });
          continue;
        }
        const actualKind = profile.kind === "mcp" ? `mcp-${String(profile.config.transport)}` : profile.kind;
        if (!requiredKinds.includes(profile.kind) && !requiredKinds.includes(actualKind)) diagnostics.push({
          code: "CONNECTION_TYPE_MISMATCH",
          path,
          message: `Connection '${connectionId}' is '${actualKind}', but this component requires ${requiredKinds.join(" or ")}`,
          componentId: component.id,
          severity: "error",
        });
      }
    });
    return diagnostics;
  }

  async resolveConnection(
    connectionId: string,
    context: ServiceExecutionContext,
  ): Promise<ServiceResult> {
    const profile = await this.connectionManager.require(connectionId);
    assertRuntimeConnection(profile);
    const credentialReferences: Record<string, string> = {};
    for (const field of profile.credentialFields) {
      const reference = this.connectionManager.credentialReference(profile.id, field);
      const value = await this.connectionManager.resolveCredential(profile.id, field);
      if (value === undefined) throw new Error(`Connection '${profile.id}' credential '${field}' is unavailable`);
      credentialReferences[field] = reference;
      const unlocked = this.#connectionSecrets.get(reference);
      if (unlocked?.value === value) unlocked.runIds.add(context.runId);
      else this.#connectionSecrets.set(reference, { value, runIds: new Set([context.runId]) });
    }
    return {
      value: {
        ...credentialReferences,
        ...structuredClone(profile.config),
        connectionId: profile.id,
        connectionKind: profile.kind,
        connectionName: profile.name,
        credentialReferences,
      },
      metadata: {
        connectionId: profile.id,
        scope: profile.scope,
        kind: profile.kind,
        state: profile.status.state,
      },
    };
  }

  /** Synchronous bridge for HarnessRuntime's existing secret resolver contract. */
  resolveConnectionSecret(reference: string): string | undefined {
    return this.#connectionSecrets.get(reference)?.value;
  }

  resolveSecret(reference: string): string | undefined {
    return this.resolveConnectionSecret(reference);
  }

  fetchProvider(url: string | URL, init: RequestInit | undefined): Promise<Response> {
    return guardedFetch(true, { maxStreamBytes: 16 * 1_048_576 })(url, init);
  }

  releaseRun(runId: string): void {
    for (const [reference, unlocked] of this.#connectionSecrets) {
      unlocked.runIds.delete(runId);
      if (unlocked.runIds.size === 0) this.#connectionSecrets.delete(reference);
    }
  }

  async executeTool(
    binding: ToolBinding,
    input: unknown,
    context: ServiceExecutionContext,
  ): Promise<ServiceResult> {
    if (binding.source === "mcp") {
      if (!binding.connectionId) throw new Error(`MCP Tool '${binding.id}' has no Connection`);
      return this.callMcpTool({ connectionId: binding.connectionId, tool: binding.action ?? binding.id }, input, context);
    }
    let stored;
    try {
      stored = await this.toolStore.get(binding.id);
    } catch (error) {
      if (!(error instanceof ToolStoreError && error.code === "TOOL_MANIFEST_NOT_FOUND")) throw error;
    }
    if (stored) {
      await this.#assertToolConnection(stored.connectionKinds, binding.connectionId);
      const value = await this.toolStore.execute(stored, input, context, {
        ...(binding.connectionId ? { connectionId: binding.connectionId } : {}),
      });
      return {
        value: binding.connectionId
          ? await this.connectionManager.redactSensitiveOutput(binding.connectionId, value)
          : value,
        metadata: { tool: binding.id, source: stored.source },
      };
    }
    const builtin = BUILTIN_TOOL_MANIFESTS.find((candidate) => candidate.id === binding.id);
    if (builtin) {
      await this.#assertToolConnection(builtin.connectionKinds, binding.connectionId);
      const value = await this.toolStore.executeBuiltin(binding.id, input, context, {
        ...(binding.connectionId ? { connectionId: binding.connectionId } : {}),
      });
      return {
        value: binding.connectionId
          ? await this.connectionManager.redactSensitiveOutput(binding.connectionId, value)
          : value,
        metadata: { tool: binding.id, source: "builtin" },
      };
    }
    if (!binding.connectionId) throw new Error(`Tool '${binding.id}' is not installed`);
    const profile = await this.connectionManager.require(binding.connectionId);
    if (profile.kind !== "mcp") throw new Error(`Tool '${binding.id}' is not installed`);
    return this.callMcpTool({ connectionId: profile.id, tool: binding.action ?? binding.id }, input, context);
  }

  async loadSkill(skillId: string, _context: ServiceExecutionContext): Promise<ServiceResult> {
    const skill = await this.skillStore.activate(skillId);
    const grantedPermissions = [
      ...(this.#options.allowFileSystem ? ["filesystem:read", "filesystem:write"] : []),
      ...(this.#options.allowProcessCommands?.flatMap((command) => ["process", `process:${command}`]) ?? []),
      ...(this.#options.allowNetworkHosts === true ? ["network"]
        : this.#options.allowNetworkHosts?.flatMap((host) => ["network", `network:${host}`]) ?? []),
      ...(this.#options.allowModuleExecution ? ["module:execute"] : []),
    ];
    return {
      value: {
        instructions: skill.body,
        descriptor: skill.descriptor,
        requirements: skill.descriptor.requirements,
        grantedPermissions: [...new Set(grantedPermissions)],
        provenance: skill.provenance,
        provenanceVerified: skill.provenanceVerified,
        scriptsPresent: skill.scriptsPresent,
        trusted: skill.provenanceVerified && !skill.scriptsPresent,
      },
      metadata: {
        skill: skill.descriptor.name,
        scope: skill.scope,
        namespace: skill.namespace,
        documentHash: skill.documentHash,
      },
    };
  }

  async loadSkillResource(
    skillId: string,
    resourcePath: string,
    _context: ServiceExecutionContext,
  ): Promise<ServiceResult> {
    const resource = await this.skillStore.loadResource(skillId, resourcePath);
    return {
      value: resource.content,
      metadata: {
        skill: resource.skill,
        path: resource.path,
        bytes: resource.bytes,
        sha256: resource.sha256,
        script: resource.script,
        trusted: resource.trusted,
      },
    };
  }

  async #assertToolConnection(
    kinds: readonly string[] | undefined,
    connectionId: string | undefined,
  ): Promise<ConnectionProfile | undefined> {
    if ((!kinds || kinds.length === 0) && !connectionId) return undefined;
    if (!connectionId) throw new Error(`This Tool requires a ${kinds?.join(" or ") ?? "compatible"} Connection`);
    const profile = await this.connectionManager.require(connectionId);
    assertRuntimeConnection(profile);
    const kind = profile.kind === "mcp"
      ? profile.config.transport === "stdio" ? "mcp-stdio" : "mcp-http"
      : profile.kind;
    if (kinds?.length && !kinds.includes(profile.kind) && !kinds.includes(kind)) {
      throw new Error(`Connection '${connectionId}' is '${kind}', but this Tool requires ${kinds.join(" or ")}`);
    }
    return profile;
  }

  async #performHttp(capability: HttpCapabilityRequest): Promise<Response> {
    this.#assertNetworkUrl(capability.url);
    if (!capability.connectionId) return fetch(capability.request);
    const profile = await this.connectionManager.require(capability.connectionId);
    if (profile.kind !== "http-api" && profile.kind !== "tool-service") {
      throw new Error(`Connection '${profile.id}' cannot authenticate an HTTP Tool`);
    }
    if (typeof profile.config.url !== "string") throw new Error(`Connection '${profile.id}' has no HTTP URL`);
    const base = new URL(profile.config.url);
    if ((base.protocol !== "http:" && base.protocol !== "https:") || base.username || base.password
      || base.origin !== capability.url.origin) {
      throw new Error(`Connection '${profile.id}' is not bound to HTTP origin '${capability.url.origin}'`);
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(asRecord(profile.config.headers) ?? {})) {
      if (typeof value === "string") headers.set(name, value);
    }
    capability.request.headers.forEach((value, name) => {
      if (forbiddenToolRequestHeader.test(name)) {
        throw new Error(`HTTP Tool cannot control routing, credential, or hop-by-hop header '${name}'`);
      }
      headers.set(name, value);
    });
    for (const [name, field] of Object.entries(asRecord(profile.config.headerCredentials) ?? {})) {
      if (typeof field !== "string") continue;
      const value = await this.connectionManager.resolveCredential(profile.id, field);
      if (value === undefined) throw new Error(`Connection '${profile.id}' credential '${field}' is unavailable`);
      headers.set(name, value);
    }
    const body = capability.request.body ? Buffer.from(await capability.request.arrayBuffer()) : undefined;
    return guardedFetch(true)(capability.url, {
      method: capability.request.method,
      headers,
      ...(body ? { body } : {}),
      signal: capability.request.signal,
      redirect: "error",
    });
  }

  async #authorizeProcess(request: ProcessCapabilityRequest): Promise<boolean> {
    if (!request.connectionId) return false;
    const profile = await this.connectionManager.require(request.connectionId);
    if (profile.kind !== "local-runtime" || profile.config.sandbox !== "container") return false;
    await this.connectionManager.assertProcessApproved(profile);
    if (request.toolId === "builtin.code-runner") {
      return (profile.config.runtime === "node" || profile.config.runtime === "python")
        && profile.config.runtime === request.command;
    }
    return typeof profile.config.command === "string" && profile.config.command === request.command;
  }

  async #executeProcess(request: ProcessExecutionRequest): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (!request.connectionId) throw new Error("Process execution requires a Sandbox Connection");
    const profile = await this.connectionManager.require(request.connectionId, "local-runtime");
    if (profile.config.sandbox !== "container") throw new Error(
      `Local Runtime '${profile.name}' is not an isolated container sandbox`,
    );
    const runtime = profile.config.runtime as "node" | "python" | "shell" | "custom";
    const command = request.toolId === "builtin.code-runner"
      ? runtime === "node" ? ["node", "-"] : runtime === "python" ? ["python", "-"] : []
      : typeof profile.config.command === "string"
        ? [profile.config.command, ...(Array.isArray(profile.config.args) ? profile.config.args as string[] : []), ...request.args]
        : [];
    if (!command.length) throw new Error(`Sandbox '${profile.name}' cannot execute Tool '${request.toolId}'`);
    return this.#runContainer(profile, request, command);
  }

  async #runContainer(
    profile: ConnectionProfile,
    request: ProcessExecutionRequest,
    command: readonly string[],
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const imageId = await this.connectionManager.assertProcessApproved(profile);
    if (!imageId) throw new Error(`Local Runtime '${profile.name}' has no approved container image`);
    const engine = await canonicalExecutable(profile.config.engine, profile.id);
    const name = `harnest-${randomUUID()}`;
    const engineEnvironment = containerEngineEnvironment();
    const mounts = request.toolId === "builtin.code-runner" ? await this.#sandboxMounts() : [];
    try {
      return await runBoundedProcess({
        ...request,
        command: engine.path,
        args: containerRunArguments(profile, name, command, [], imageId, mounts),
        cwd: dirname(engine.path),
        environment: engineEnvironment,
      });
    } finally {
      await runBoundedProcess({
        toolId: `${request.toolId}:cleanup`, command: engine.path, args: ["rm", "--force", name],
        cwd: dirname(engine.path), stdin: "", timeoutMs: 5_000, maxInputBytes: 1,
        maxOutputBytes: 64 * 1_024, signal: new AbortController().signal, environment: engineEnvironment,
      }).catch(() => undefined);
    }
  }

  async #sandboxMounts(): Promise<ContainerMount[]> {
    const configured = this.#options.sandboxWorkspace;
    if (!configured) return [];
    const root = await this.#root;
    const mounts: ContainerMount[] = [];
    for (const [directory, target, readOnly] of [
      [configured.inputDirectory, "/mnt/data", true],
      [configured.outputDirectory, "/mnt/output", false],
    ] as const) {
      if (!directory) continue;
      const lexical = resolve(directory);
      if (!isInside(root, lexical)) throw new Error("Sandbox workspace must stay inside the project");
      const lexicalInfo = await lstat(lexical);
      if (!lexicalInfo.isDirectory() || lexicalInfo.isSymbolicLink()) {
        throw new Error("Sandbox workspace must be a regular directory");
      }
      const canonical = await realpath(lexical);
      if (canonical === root || !isInside(root, canonical) || !(await stat(canonical)).isDirectory()) {
        throw new Error("Sandbox workspace resolves outside the project");
      }
      mounts.push({ source: canonical, target, readOnly });
    }
    return mounts;
  }

  async #executeModule(request: ModuleExecutionRequest): Promise<unknown> {
    if (this.#options.allowModuleExecution !== true) {
      throw new Error(`TypeScript Tool '${request.toolId}' requires reviewed module execution permission`);
    }
    if (!request.connectionId) throw new Error(`TypeScript Tool '${request.toolId}' requires a Sandbox Connection`);
    const profile = await this.connectionManager.require(request.connectionId, "local-runtime");
    if (profile.config.sandbox !== "container" || profile.config.runtime !== "node") throw new Error(
      `TypeScript Tool '${request.toolId}' requires an approved Node container sandbox`,
    );
    const bundled = await build({
      absWorkingDir: this.#projectDirectory,
      entryPoints: [request.resolvedModule],
      bundle: true,
      format: "cjs",
      platform: "node",
      target: "node20",
      write: false,
      logLevel: "silent",
      legalComments: "none",
    });
    const source = bundled.outputFiles[0]?.text;
    if (!source) throw new Error(`TypeScript Tool '${request.toolId}' could not be bundled`);
    const marker = `__HARNEST_RESULT_${randomUUID()}__`;
    const input = Buffer.from(JSON.stringify(request.input), "utf8").toString("base64");
    const safeContext = Buffer.from(JSON.stringify({
      runId: request.context.runId,
      nodeId: request.context.nodeId,
      iteration: request.context.iteration,
    }), "utf8").toString("base64");
    const script = `${source}\n;(async () => {\n`
      + `const candidate = ${request.exportName === "default" ? "module.exports.default ?? module.exports" : `module.exports[${JSON.stringify(request.exportName)}]`};\n`
      + `if (typeof candidate !== "function") throw new Error(${JSON.stringify(`Export '${request.exportName}' is not a function`)});\n`
      + `const input = JSON.parse(Buffer.from(${JSON.stringify(input)}, "base64").toString("utf8"));\n`
      + `const values = JSON.parse(Buffer.from(${JSON.stringify(safeContext)}, "base64").toString("utf8"));\n`
      + `const context = Object.freeze({ ...values, signal: new AbortController().signal, resolveSecret: () => undefined });\n`
      + `const value = await candidate(input, context);\n`
      + `process.stdout.write("\\n${marker}" + Buffer.from(JSON.stringify({ ok: true, value: value === undefined ? null : value })).toString("base64") + "\\n");\n`
      + `})().catch((error) => { process.stdout.write("\\n${marker}" + Buffer.from(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })).toString("base64") + "\\n"); process.exitCode = 1; });\n`;
    const result = await this.#runContainer(profile, {
      toolId: request.toolId,
      command: "node",
      args: ["-"],
      cwd: this.#projectDirectory,
      stdin: script,
      timeoutMs: request.timeoutMs,
      maxInputBytes: request.maxInputBytes,
      maxOutputBytes: request.maxOutputBytes,
      signal: request.signal,
      connectionId: request.connectionId,
    }, ["node", "-"]);
    const offset = result.stdout.lastIndexOf(marker);
    const encoded = offset < 0 ? "" : result.stdout.slice(offset + marker.length).split(/\r?\n/u, 1)[0]?.trim() ?? "";
    let envelope: unknown;
    try {
      envelope = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as unknown;
    } catch {
      throw new Error(`TypeScript Tool '${request.toolId}' returned an invalid sandbox response`);
    }
    const record = asRecord(envelope);
    if (record?.ok !== true) throw new Error(
      typeof record?.error === "string" ? record.error : `TypeScript Tool '${request.toolId}' failed in its sandbox`,
    );
    return record.value;
  }

  async #webSearch(request: WebSearchRequest): Promise<unknown> {
    if (!request.connectionId) throw new Error("Web Search requires a Search Service Connection");
    const profile = await this.#assertToolConnection(["tool-service"], request.connectionId);
    if (!profile) throw new Error("Web Search Connection is unavailable");
    return executeWebSearchConnection(this.connectionManager, profile, request);
  }

  async #webScrape(request: WebScrapeRequest): Promise<unknown> {
    if (!request.connectionId) throw new Error("Web Scrape requires a Tool Service Connection");
    const profile = await this.#assertToolConnection(["tool-service"], request.connectionId);
    if (!profile) throw new Error("Web Scrape Connection is unavailable");
    return executeWebScrapeConnection(this.connectionManager, profile, request);
  }

  async requestToolApproval(
    request: ToolApprovalRequest,
    context: ServiceExecutionContext,
  ): Promise<ToolApprovalDecision> {
    if (await this.#matchesPreapprovedTool(request.tool)) {
      return { approved: true, source: "user", reason: `Tool '${request.tool.id}' was pre-approved` };
    }
    if (this.#options.requestToolApproval) return this.#options.requestToolApproval(request, context);
    return {
      approved: false,
      source: "policy",
      reason: `Tool '${request.tool.id}' requires explicit approval`,
    };
  }

  async #matchesPreapprovedTool(binding: ToolBinding): Promise<boolean> {
    if (!this.#options.approvedToolIds?.includes(binding.id)) return false;
    if (!binding.connectionId) return true;
    const profile = await this.connectionManager.require(binding.connectionId);
    if (profile.kind === "mcp") {
      const action = binding.action;
      return typeof action === "string"
        && profile.tools?.some((tool) => tool.name === action) === true
        && binding.id === mcpToolApprovalId(profile.id, action);
    }
    if (BUILTIN_TOOL_MANIFESTS.some((tool) => tool.id === binding.id)) return true;
    try {
      if (await this.toolStore.get(binding.id)) return true;
    } catch (error) {
      if (!(error instanceof ToolStoreError && error.code === "TOOL_MANIFEST_NOT_FOUND")) throw error;
    }
    return true;
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
      const selected = await readBounded(path, root, maxBytes);
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
      const loaded = await readBounded(file.path, root, readLimit);
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
    const connectionId = typeof config.connectionId === "string" ? config.connectionId : undefined;
    // Saved Connection lifecycle mutations must take effect on the next call; do not pool those sessions.
    const ephemeral = connectionId !== undefined;
    const pending = ephemeral ? this.#connect(config, context) : this.#connection(config, context);
    let connection: McpConnection;
    try {
      connection = await pending;
    } catch (error) {
      if (connectionId) throw await this.connectionManager.redactSensitiveError(connectionId, error);
      throw error;
    }
    try {
      const toolName = config.tool;
      if (typeof toolName !== "string" || !toolName) throw new Error("MCP tool name is invalid");
      let tool = connection.tools.get(toolName);
      if (!tool) {
        let listed: Awaited<ReturnType<typeof connection.client.listTools>>;
        try {
          listed = await connection.client.listTools(undefined, {
            signal: context.signal,
            timeout: typeof config.timeoutMs === "number" ? config.timeoutMs : 30_000,
            maxTotalTimeout: typeof config.timeoutMs === "number" ? config.timeoutMs : 30_000,
            cacheMode: "refresh",
          });
        } catch (error) {
          if (connectionId) throw await this.connectionManager.redactSensitiveError(connectionId, error);
          throw error;
        }
        connection.tools.clear();
        for (const candidate of listed.tools) connection.tools.set(candidate.name, candidate);
        tool = connection.tools.get(toolName);
      }
      if (!tool) throw new Error(`MCP server does not expose configured tool '${toolName}'`);
      const timeout = typeof config.timeoutMs === "number" ? config.timeoutMs : 30_000;
      const invoke = () => connection.client.callTool(
        { name: tool.name, arguments: args },
        {
          signal: context.signal,
          timeout,
          maxTotalTimeout: timeout,
          toolDefinition: tool,
        },
      );
      let result: Awaited<ReturnType<typeof invoke>>;
      try {
        result = await invoke();
      } catch (error) {
        if (!ephemeral) await this.#evictConnection(`node:${context.nodeId}`, pending, connection);
        if (connectionId) throw await this.connectionManager.redactSensitiveError(connectionId, error);
        throw error;
      }
      if (result.isError === true) {
        throw new Error(`MCP tool '${tool.name}' returned an error result`);
      }
      const rawValue = result.structuredContent !== undefined ? result.structuredContent : result.content;
      const value = connectionId
        ? await this.connectionManager.redactSensitiveOutput(connectionId, rawValue)
        : rawValue;
      return {
        value,
        metadata: {
          transport: connection.transportType,
          tool: tool.name,
          protocol: connection.client.getNegotiatedProtocolVersion() ?? "unknown",
          isError: false,
        },
      };
    } finally {
      if (ephemeral) await this.#closeConnection(connection);
    }
  }

  async close(): Promise<void> {
    const settled = await Promise.allSettled(this.#connections.values());
    this.#connections.clear();
    this.#connectionSecrets.clear();
    await Promise.allSettled(settled.flatMap((result) => {
      if (result.status === "rejected") return [];
      return [this.#closeConnection(result.value)];
    }));
  }

  async #evictConnection(
    connectionKey: string,
    pending: Promise<McpConnection>,
    connection: McpConnection,
  ): Promise<void> {
    if (this.#connections.get(connectionKey) !== pending) return;
    this.#connections.delete(connectionKey);
    await this.#closeConnection(connection);
  }

  async #closeConnection({ client, transport, close }: McpConnection): Promise<void> {
    if (close) {
      await close();
      return;
    }
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
    const key = typeof config.connectionId === "string"
      ? `connection:${config.connectionId}`
      : `node:${context.nodeId}`;
    const existing = this.#connections.get(key);
    if (existing) return existing;
    const pending = this.#connect(config, context);
    this.#connections.set(key, pending);
    void pending.catch(() => {
      if (this.#connections.get(key) === pending) this.#connections.delete(key);
    });
    return pending;
  }

  async #connect(
    config: Readonly<Record<string, unknown>>,
    context: ServiceExecutionContext,
  ): Promise<McpConnection> {
    const toolName = config.tool;
    if (typeof toolName !== "string" || !toolName) throw new Error("MCP tool is invalid");
    if (typeof config.connectionId === "string") {
      const profile = await this.connectionManager.require(config.connectionId, "mcp");
      const resolved = await this.resolveConnection(profile.id, context);
      const references = asRecord(asRecord(resolved.value)?.credentialReferences);
      if (references) {
        for (const reference of Object.values(references)) {
          if (typeof reference === "string") context.resolveSecret(reference);
        }
      }
      let tools = new Map<string, Tool>();
      const handle: McpConnectionHandle = await openMcpConnection(
        this.connectionManager,
        profile,
        {
          signal: context.signal,
          ...(typeof config.timeoutMs === "number" ? { timeoutMs: config.timeoutMs } : {}),
          ...(this.#options.allowProcessCommands ? { allowProcessCommands: this.#options.allowProcessCommands } : {}),
          ...(profile.config.transport === "http" && typeof profile.config.url === "string"
            ? { allowNetworkHosts: this.#options.allowNetworkHosts === true ? true : [
              ...(this.#options.allowNetworkHosts ?? []), new URL(profile.config.url).host,
            ] }
            : this.#options.allowNetworkHosts !== undefined ? { allowNetworkHosts: this.#options.allowNetworkHosts } : {}),
        },
        async (changed) => {
          await this.connectionManager.storeDiscoveredTools(profile.id, changed);
          tools.clear();
          for (const candidate of changed) tools.set(candidate.name, candidate as Tool);
        },
      );
      tools = new Map(handle.tools.map((tool) => [tool.name, tool]));
      if (!tools.has(toolName)) {
        await handle.close();
        throw new Error(`MCP server does not expose configured tool '${toolName}'`);
      }
      return {
        client: handle.client,
        transport: handle.transport,
        tools,
        transportType: profile.config.transport as "stdio" | "http",
        close: handle.close,
      };
    }
    const timeout = typeof config.timeoutMs === "number" && Number.isInteger(config.timeoutMs)
      && config.timeoutMs >= 1 && config.timeoutMs <= 600_000 ? config.timeoutMs : 30_000;
    const transportType = config.transport;
    let transport: StdioClientTransport | StreamableHTTPClientTransport;
    if (transportType === "stdio") {
      throw new Error("Raw MCP stdio is disabled; create an isolated MCP stdio Connection or use MCP HTTP");
    } else if (transportType === "http") {
      if (typeof config.url !== "string") throw new Error("Raw MCP HTTP URL is invalid");
      const url = new URL(config.url);
      this.#assertNetworkUrl(url);
      const headers = new Headers();
      const configuredHeaders = asRecord(config.headers) ?? {};
      if (Object.keys(configuredHeaders).length > 64) throw new Error("Raw MCP headers exceed the safe limit");
      for (const [name, reference] of Object.entries(configuredHeaders)) {
        if (/^(?::authority|host|proxy-.+|connection|keep-alive|te|trailer|transfer-encoding|upgrade|content-length)$/i.test(name)
          || typeof reference !== "string" || !/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(reference)) {
          throw new Error(`Raw MCP header '${name}' is invalid`);
        }
        const value = context.resolveSecret(reference);
        if (value === undefined) throw new Error(`Raw MCP credential '${reference}' is unavailable`);
        headers.set(name, value);
      }
      transport = new StreamableHTTPClientTransport(url, {
        fetch: guardedFetch(this.#options.allowNetworkHosts, { timeoutMs: timeout, maxStreamBytes: 2 * 1_048_576 }),
        requestInit: { headers, redirect: "error" },
        onInsufficientScope: "throw",
      });
    } else {
      throw new Error("Raw MCP transport must be stdio or http");
    }
    const client = new Client(
      { name: "harnest", version: "0.2.0" },
      { versionNegotiation: protocolMode(config, transportType), listMaxPages: 16 },
    );
    try {
      const requestOptions = { signal: context.signal, timeout, maxTotalTimeout: timeout };
      await client.connect(transport, requestOptions);
      const listed = await client.listTools(undefined, { ...requestOptions, cacheMode: "refresh" });
      if (!listed.tools.some((tool) => tool.name === toolName)) {
        throw new Error(`MCP server does not expose configured tool '${toolName}'`);
      }
      return {
        client,
        transport,
        tools: new Map(listed.tools.map((tool) => [tool.name, tool])),
        transportType,
      };
    } catch (cause) {
      await client.close().catch(() => undefined);
      throw cause;
    }
  }

  #assertNetworkUrl(url: URL): void {
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      throw new Error("HTTP URL must use HTTPS, or HTTP on a literal loopback address");
    }
    if (url.username || url.password || url.hash) throw new Error("HTTP URL must not contain credentials or a fragment");
    const allowed = this.#options.allowNetworkHosts;
    const normalized = url.host.toLocaleLowerCase();
    const hosts = Array.isArray(allowed) ? allowed.map((host) => host.toLocaleLowerCase()) : [];
    if (allowed !== true && !hosts.includes(normalized)) {
      throw new Error(`HTTP host '${url.host}' is not explicitly allowed`);
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
const MAX_RUN_FILE_BYTES = 8 * 1_048_576;
const MAX_RUN_LINE_BYTES = 65_536;
const MAX_RUN_EVENTS = 10_000;

async function runFile(directory: string, runId: string): Promise<{
  readonly path: string;
  readonly size: number;
  readonly modified: number;
}> {
  const path = resolve(directory, `${runId}.ndjson`);
  if (!isInside(directory, path)) throw new Error("Run trace resolves outside Harnest storage");
  const lexicalInfo = await lstat(path);
  if (!lexicalInfo.isFile() || lexicalInfo.isSymbolicLink() || lexicalInfo.nlink !== 1) {
    throw new Error("Run trace must be a regular, unlinked file");
  }
  const canonical = await realpath(path);
  if (!isInside(directory, canonical)) throw new Error("Run trace resolves outside Harnest storage");
  const info = await stat(canonical);
  if (!info.isFile()) throw new Error("Run trace must be a regular file");
  return { path: canonical, size: info.size, modified: info.mtimeMs };
}

function parseRunEvents(runId: string, text: string): StoredRunEvent[] {
  const events: StoredRunEvent[] = [];
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (!line) continue;
    try {
      if (byteLength(line) > MAX_RUN_LINE_BYTES) throw new Error("event exceeds the 64 KiB line limit");
      if (events.length >= MAX_RUN_EVENTS) throw new Error("trace exceeds the 10,000 event limit");
      const event = JSON.parse(line) as unknown;
      const record = asRecord(event);
      if (!record
        || typeof record.type !== "string"
        || record.runId !== runId
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

async function openRunFileForAppend(directory: string, runId: string): Promise<FileHandle> {
  const path = resolve(directory, `${runId}.ndjson`);
  if (!isInside(directory, path)) throw new Error("Run trace resolves outside Harnest storage");
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      throw new Error("Run trace must be a regular, unlinked file");
    }
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }

  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(
    path,
    fsConstants.O_RDWR | fsConstants.O_APPEND | fsConstants.O_CREAT | noFollow,
    0o600,
  );
  try {
    const opened = await handle.stat({ bigint: true });
    const lexical = await lstat(path, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || opened.ino === 0n
      || !lexical.isFile() || lexical.isSymbolicLink() || lexical.nlink !== 1n) {
      throw new Error("Run trace must be a verifiable regular, unlinked file");
    }
    const canonical = await realpath(path);
    if (!isInside(directory, canonical)) throw new Error("Run trace resolves outside Harnest storage");
    const resolved = await stat(canonical, { bigint: true });
    if (!resolved.isFile() || resolved.ino !== opened.ino) {
      throw new Error("Run trace changed while it was being opened");
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

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
    const file = await runFile(directory, runId);
    if (file.size > MAX_RUN_FILE_BYTES) throw new Error("Run trace exceeds the 8 MiB safety limit");
    const selected = await readBounded(file.path, directory, MAX_RUN_FILE_BYTES);
    if (selected.truncated) throw new Error("Run trace exceeds the 8 MiB safety limit");
    return parseRunEvents(runId, selected.text);
  }

  async list(limit = 50): Promise<RunSummary[]> {
    const boundedLimit = Math.min(Math.max(1, Math.floor(limit)), 500);
    const directory = await storageDirectory(await this.#root, "runs");
    const files = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ndjson"))
      .map((entry) => entry.name.slice(0, -7))
      .filter((runId) => RUN_ID.test(runId));
    const ordered: { runId: string; modified: number }[] = [];
    for (const runId of files) {
      try {
        const file = await runFile(directory, runId);
        if (file.size <= MAX_RUN_FILE_BYTES) ordered.push({ runId, modified: file.modified });
      } catch {
        // A concurrently removed, linked, or invalid trace is not listable.
      }
    }
    ordered.sort((left, right) => right.modified - left.modified);
    // ponytail: scanning the newest NDJSON files is enough until projects reach thousands of local runs.
    const summaries: RunSummary[] = [];
    for (const { runId } of ordered) {
      if (summaries.length >= boundedLimit) break;
      let events: StoredRunEvent[];
      try {
        events = await this.read(runId);
      } catch {
        continue;
      }
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
    const serialized = JSON.stringify(storedEvent(event));
    if (byteLength(serialized) > MAX_RUN_LINE_BYTES) {
      throw new Error("Run trace event exceeds the 64 KiB line limit");
    }
    const line = Buffer.from(`${serialized}\n`, "utf8");
    const directory = await storageDirectory(await this.#root, "runs");
    const handle = await openRunFileForAppend(directory, event.runId);
    try {
      const opened = await handle.stat({ bigint: true });
      if (opened.size + BigInt(line.byteLength) > BigInt(MAX_RUN_FILE_BYTES)) {
        throw new Error("Run trace exceeds the 8 MiB safety limit");
      }
      const selected = await readBoundedHandle(handle, MAX_RUN_FILE_BYTES);
      if (selected.truncated) throw new Error("Run trace exceeds the 8 MiB safety limit");
      if (selected.text.length > 0 && !selected.text.endsWith("\n")) {
        throw new Error("Run trace is incomplete and cannot be appended");
      }
      const events = parseRunEvents(event.runId, selected.text);
      if (events.length >= MAX_RUN_EVENTS) throw new Error("Run trace exceeds the 10,000 event limit");
      const beforeWrite = await handle.stat({ bigint: true });
      if (beforeWrite.size !== opened.size) throw new Error("Run trace changed while it was being appended");
      const { bytesWritten } = await handle.write(line, 0, line.byteLength, null);
      if (bytesWritten !== line.byteLength) throw new Error("Run trace append was incomplete");
      const afterWrite = await handle.stat({ bigint: true });
      if (afterWrite.size !== beforeWrite.size + BigInt(line.byteLength)
        || afterWrite.size > BigInt(MAX_RUN_FILE_BYTES)) {
        throw new Error("Run trace changed while it was being appended");
      }
    } finally {
      await handle.close();
    }
  }
}
