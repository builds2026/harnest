import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
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
import {
  Client,
  StreamableHTTPClientTransport,
  type ElicitRequestParams,
  type ElicitResult,
  type Tool,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { build } from "esbuild";
import {
  AdapterError,
  AdapterRegistry,
  type ModelAdapter,
  type PromptCacheEntry,
  type PromptCacheStore,
} from "./adapter.js";
import type { ConnectionProfile } from "./connection.js";
import type {
  ComponentDefinition,
  ComponentRegistry,
  ArtifactReference,
  RunAttachment,
  RuntimeServices,
  ServiceExecutionContext,
  ServiceResult,
} from "./component.js";
import type { RunEvent } from "./runtime.js";
import type { InteractionRequest, RunSnapshot } from "./orchestration.js";
import { normalizeSpec } from "./graph.js";
import { acquireRunExecutionLease, releaseRunExecutionLease } from "./node-run-idempotency.js";
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
  type McpElicitationHandler,
} from "./node-connections.js";
import { NodeSkillStore } from "./node-skills.js";
import { atomicWriteVerifiedFile, isSensitiveWorkspacePath, openVerifiedFile, readVerifiedFile } from "./safe-files.js";
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
  stringifySpec,
  type Diagnostic,
  type HarnessSpec,
  type ParseResult,
  type ValidationResult,
} from "./spec.js";
import {
  normalizePermissionDecision,
  type LegacyPermissionDecision,
  type PermissionDecision,
  type ToolApprovalDecision,
  type ToolApprovalRequest,
  type ToolBinding,
  type ToolDefinition,
  type ToolRegistry,
} from "./tool.js";
import { loadHarnestProjectSpec } from "./node-project.js";
import type { PermissionProvider, PersistentPermissionGrant, PersistentPermissionScope } from "./provider.js";

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
  type McpElicitationHandler,
} from "./node-connections.js";
export * from "./node-skills.js";
export * from "./node-skill-install.js";
export * from "./node-tools.js";
export * from "./node-project.js";
export { isSensitiveWorkspacePath } from "./safe-files.js";

export async function loadSpecFile(filePath: string): Promise<ParseResult> {
  const loaded = await loadHarnestProjectSpec(filePath);
  return loaded.ok
    ? { ok: true, spec: loaded.spec, diagnostics: [] }
    : loaded;
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

const MCP_CREDENTIAL_FIELD = /(?:password|passphrase|secret|token|api[-_]?key|access[-_]?token|credential|private[-_]?key)/iu;
const MCP_FORM_KEYS = new Set([
  "type", "title", "description", "enum", "minimum", "maximum", "minLength", "maxLength", "default",
]);

const mcpFormSchema = (value: unknown): Readonly<Record<string, unknown>> => {
  const schema = asRecord(value);
  const properties = asRecord(schema?.properties);
  if (!schema || schema.type !== "object" || !properties) throw new Error("MCP form elicitation requires an object schema");
  if (Object.keys(schema).some((key) => !["type", "title", "description", "properties", "required", "additionalProperties"].includes(key))
    || schema.additionalProperties === true) {
    throw new Error("MCP form elicitation contains an unsupported schema keyword");
  }
  if (Object.keys(properties).length > 50) throw new Error("MCP form elicitation has too many fields");
  const safeProperties: Record<string, unknown> = {};
  for (const [name, candidate] of Object.entries(properties)) {
    if (MCP_CREDENTIAL_FIELD.test(name)) throw new Error(`MCP credential field '${name}' must use URL elicitation`);
    const field = asRecord(candidate);
    if (!field || !["string", "number", "integer", "boolean"].includes(String(field.type))) {
      throw new Error(`MCP form field '${name}' must be primitive`);
    }
    if (typeof field.format === "string" && MCP_CREDENTIAL_FIELD.test(field.format)) {
      throw new Error(`MCP credential format '${field.format}' must use URL elicitation`);
    }
    if (Object.keys(field).some((key) => !MCP_FORM_KEYS.has(key))) {
      throw new Error(`MCP form field '${name}' contains an unsupported schema keyword`);
    }
    safeProperties[name] = { ...field };
  }
  const required = schema.required;
  if (required !== undefined && (!Array.isArray(required)
    || required.some((name) => typeof name !== "string" || !Object.hasOwn(properties, name)))) {
    throw new Error("MCP form required fields are invalid");
  }
  return {
    type: "object",
    ...(typeof schema.title === "string" ? { title: schema.title } : {}),
    ...(typeof schema.description === "string" ? { description: schema.description } : {}),
    properties: safeProperties,
    ...(required === undefined ? {} : { required: [...required] }),
    additionalProperties: false,
  };
};

const mcpElicitationUrl = (value: unknown): URL => {
  if (typeof value !== "string") throw new Error("MCP URL elicitation URL is invalid");
  const url = new URL(value);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("MCP URL elicitation must use HTTPS, or HTTP on a literal loopback address");
  }
  if (url.username || url.password || url.hash) throw new Error("MCP URL elicitation must not contain credentials or a fragment");
  for (const name of url.searchParams.keys()) {
    if (MCP_CREDENTIAL_FIELD.test(name)) throw new Error("MCP URL elicitation must not carry tokens or credentials");
  }
  return url;
};

/** Maps both legacy push-style and modern input_required MCP elicitation through RunControl. */
export async function resolveMcpElicitation(
  params: ElicitRequestParams,
  context: ServiceExecutionContext,
  requesterId = "mcp",
): Promise<ElicitResult> {
  if (!context.requestInteraction) throw new Error("MCP elicitation requires an interactive run");
  const candidate = params as ElicitRequestParams & Readonly<Record<string, unknown>>;
  const mode = candidate.mode ?? "form";
  const schema = mode === "form" ? mcpFormSchema(candidate.requestedSchema) : undefined;
  const url = mode === "url" ? mcpElicitationUrl(candidate.url) : undefined;
  if (mode !== "form" && mode !== "url") throw new Error("MCP elicitation mode is invalid");
  const response = await context.requestInteraction({
    nodeId: context.nodeId,
    kind: mode === "form" ? "form" : "oauth",
    requester: { kind: "mcp", id: requesterId },
    title: mode === "form" ? "MCP input required" : "MCP connection required",
    message: typeof candidate.message === "string" ? candidate.message : "The MCP server requires input.",
    blocking: "run",
    ...(schema ? { schema } : {}),
    ...(url ? { data: {
      url: url.toString(),
      ...(typeof candidate.elicitationId === "string" ? { elicitationId: candidate.elicitationId } : {}),
    } } : {}),
  });
  if (response.action !== "submit") return { action: response.action === "decline" ? "decline" : "cancel" };
  const content = asRecord(response.value);
  if (!content) throw new Error(`MCP ${mode} elicitation submit response must be an object`);
  if (Object.keys(content).some((name) => MCP_CREDENTIAL_FIELD.test(name))) {
    throw new Error("MCP elicitation response must not contain credentials or tokens");
  }
  if (mode === "url") {
    if (Object.keys(content).some((name) => name !== "connectionRef")
      || typeof content.connectionRef !== "string" || !content.connectionRef
      || content.connectionRef.length > 512) {
      throw new Error("MCP URL elicitation response must contain only an external connectionRef");
    }
    return { action: "accept", content: { connectionRef: content.connectionRef } };
  }
  const allowed = new Set(Object.keys(asRecord(schema?.properties) ?? {}));
  if (Object.keys(content).some((name) => !allowed.has(name))) throw new Error("MCP form response contains an unknown field");
  for (const value of Object.values(content)) {
    if (!["string", "number", "boolean"].includes(typeof value)) throw new Error("MCP form response values must be primitive");
  }
  return { action: "accept", content: content as ElicitResult["content"] };
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
  const specifiers = spec.version === "0.1" ? [] : spec.runtime?.modules ?? [];
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
  return isSensitiveWorkspacePath(root, target);
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
  /** Stable Harness identity used to scope persisted Tool grants. Defaults to the project directory. */
  readonly harnessId?: string;
  /** Project-contained directories exposed only to approved process sandboxes. */
  readonly sandboxWorkspace?: {
    readonly inputDirectory?: string;
    readonly outputDirectory?: string;
    /** Expose a secret-filtered project snapshot at /workspace. Defaults to write when file access is enabled. */
    readonly projectAccess?: "read" | "write";
  };
  readonly requestToolApproval?: (
    request: ToolApprovalRequest,
    context: ServiceExecutionContext,
  ) => (Omit<ToolApprovalDecision, "mode"> & { readonly mode?: PermissionDecision | LegacyPermissionDecision })
    | Promise<Omit<ToolApprovalDecision, "mode"> & { readonly mode?: PermissionDecision | LegacyPermissionDecision }>;
}

export interface PersistedToolPermission {
  readonly harnessId: string;
  readonly toolId: string;
  readonly connectionId?: string;
  readonly capability?: "tool-execution" | "workspace-read" | "workspace-write" | "process" | "network" | "module-execution";
  readonly resource?: string;
  readonly createdAt: string;
}

export interface NodeArtifactContent {
  readonly artifact: ArtifactReference;
  readonly content: Buffer;
}

interface ToolPermissionFile {
  readonly version: 1 | 2;
  readonly grants: readonly PersistedToolPermission[];
}

interface ToolPermissionScope {
  readonly capability: NonNullable<PersistedToolPermission["capability"]>;
  readonly resource: string;
}

const safePermissionResource = (value: unknown, fallback = "*"): string => {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const trimmed = value.trim().slice(0, 512);
  if (trimmed.includes("\0") || trimmed.includes("\\") || trimmed.split("/").some((part) => part === "..")) return "[invalid]";
  return trimmed;
};

const toolPermissionScope = (request: ToolApprovalRequest): ToolPermissionScope => {
  const input = request.input && typeof request.input === "object" && !Array.isArray(request.input)
    ? request.input as Record<string, unknown> : {};
  if (request.tool.id === "builtin.file") return {
    capability: input.operation === "read" ? "workspace-read" : "workspace-write",
    resource: safePermissionResource(input.path),
  };
  if (request.tool.id === "builtin.shell") return {
    capability: "process",
    resource: safePermissionResource(input.command),
  };
  if (request.tool.id === "builtin.code-runner") return {
    capability: "process",
    resource: safePermissionResource(input.runtime, "container"),
  };
  if (request.tool.id === "builtin.http" || request.tool.id === "builtin.web-scrape") {
    let resource = "[invalid]";
    try { resource = new URL(String(input.url)).origin; } catch { /* execution validation reports the invalid URL */ }
    return { capability: "network", resource };
  }
  if (request.tool.id === "builtin.web-search") return {
    capability: "network",
    resource: request.tool.connectionId ?? "search-service",
  };
  if (request.tool.source === "module") return { capability: "module-execution", resource: request.tool.id };
  return { capability: "tool-execution", resource: request.tool.action ?? request.tool.id };
};

interface SandboxProjectFile {
  readonly sha256: string;
  readonly mode: number;
}

interface SandboxProjectWorkspace {
  readonly directory: string;
  readonly access: "read" | "write";
  readonly baseline: Map<string, SandboxProjectFile>;
}

interface SandboxArtifactDirectory {
  readonly directory: string;
  readonly managed: boolean;
}

const SANDBOX_PROJECT_MAX_FILES = 10_000;
const SANDBOX_PROJECT_MAX_BYTES = 256 * 1_048_576;
const SANDBOX_PROJECT_MAX_FILE_BYTES = 16 * 1_048_576;
const SANDBOX_PROJECT_IGNORED_DIRECTORIES = new Set([
  ".git", ".next", ".turbo", "build", "coverage", "dist", "node_modules",
]);

const fileSha256 = (content: Uint8Array): string => createHash("sha256").update(content).digest("hex");
const ARTIFACT_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const ARTIFACT_ID = /^artifact_[a-f0-9]{24}$/u;
const ARTIFACT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const ARTIFACT_RETAINED_RUNS = 100;

const artifactPreview = (mimeType: string, name: string): ArtifactReference["preview"] => {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType === "application/pdf" || name.toLocaleLowerCase().endsWith(".pdf")) return "pdf";
  if (mimeType.startsWith("text/") || /\.(?:csv|html?|json|md|svg|tsx?|ya?ml)$/iu.test(name)) return "text";
  return "none";
};

const artifactMimeType = (name: string): string => {
  const extension = name.toLocaleLowerCase().split(".").at(-1) ?? "";
  return ({
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
    svg: "image/svg+xml", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
    mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", pdf: "application/pdf",
    json: "application/json", csv: "text/csv", tsv: "text/tab-separated-values", md: "text/markdown",
    txt: "text/plain", html: "text/html", yaml: "application/yaml", yml: "application/yaml",
    zip: "application/zip",
  } as Record<string, string>)[extension] ?? "application/octet-stream";
};

const fileStoreLocks = new Map<string, Promise<unknown>>();

function withFileStoreLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = fileStoreLocks.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  fileStoreLocks.set(key, next);
  void next.finally(() => {
    if (fileStoreLocks.get(key) === next) fileStoreLocks.delete(key);
  }).catch(() => undefined);
  return next;
}

interface PromptCacheFile {
  readonly version: 1;
  readonly entries: readonly PromptCacheEntry[];
}

const validPromptCacheEntry = (value: unknown): value is PromptCacheEntry => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as PromptCacheEntry;
  return /^[a-f0-9]{64}$/u.test(entry.key)
    && /^[a-z][a-z0-9._-]*$/u.test(entry.adapterId)
    && typeof entry.model === "string" && entry.model.length > 0 && entry.model.length <= 512
    && typeof entry.resource === "string" && entry.resource.length > 0 && entry.resource.length <= 1_024
    && Number.isFinite(Date.parse(entry.createdAt)) && Number.isFinite(Date.parse(entry.expiresAt))
    && (entry.cachedInputTokens === undefined
      || (Number.isSafeInteger(entry.cachedInputTokens) && entry.cachedInputTokens >= 0));
};

export class FilePromptCacheStore implements PromptCacheStore {
  readonly #projectDirectory: string;

  constructor(projectDirectory: string) {
    this.#projectDirectory = resolve(projectDirectory);
  }

  async #location(): Promise<{ root: string; file: string }> {
    const project = await realpath(this.#projectDirectory);
    const hiddenPath = join(project, ".harnest");
    await mkdir(hiddenPath, { recursive: true, mode: 0o700 });
    const hidden = await realpath(hiddenPath);
    const runtimePath = join(hidden, "runtime");
    await mkdir(runtimePath, { recursive: true, mode: 0o700 });
    const root = await realpath(runtimePath);
    if (!isInside(project, root)) throw new Error("Prompt cache storage resolves outside the project");
    return { root, file: join(root, "context-cache.json") };
  }

  async #read(root: string, file: string): Promise<PromptCacheEntry[]> {
    try {
      const parsed = JSON.parse((await readVerifiedFile(file, root, 1_048_576)).toString("utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid shape");
      const candidate = parsed as { version?: unknown; entries?: unknown };
      if (candidate.version !== 1 || !Array.isArray(candidate.entries)
        || candidate.entries.some((entry) => !validPromptCacheEntry(entry))) throw new Error("invalid shape");
      return candidate.entries;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
      throw new Error("Prompt cache storage is invalid", { cause: error });
    }
  }

  async #write(root: string, file: string, entries: readonly PromptCacheEntry[]): Promise<void> {
    const retained = entries
      .filter((entry) => Date.parse(entry.expiresAt) > Date.now())
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .slice(0, 256);
    const payload: PromptCacheFile = { version: 1, entries: retained };
    await atomicWriteVerifiedFile(file, root, `${JSON.stringify(payload, null, 2)}\n`);
  }

  async get(key: string): Promise<PromptCacheEntry | undefined> {
    if (!/^[a-f0-9]{64}$/u.test(key)) return undefined;
    const { root, file } = await this.#location();
    return withFileStoreLock(file, async () => {
      const entries = await this.#read(root, file);
      const active = entries.filter((entry) => Date.parse(entry.expiresAt) > Date.now());
      if (active.length !== entries.length) await this.#write(root, file, active);
      const entry = active.find((candidate) => candidate.key === key);
      return entry ? { ...entry } : undefined;
    });
  }

  async set(entry: PromptCacheEntry): Promise<void> {
    if (!validPromptCacheEntry(entry)) throw new Error("Prompt cache entry is invalid");
    const { root, file } = await this.#location();
    await withFileStoreLock(file, async () => {
      const entries = (await this.#read(root, file)).filter((candidate) => candidate.key !== entry.key);
      await this.#write(root, file, [...entries, { ...entry }]);
    });
  }

  async delete(key: string): Promise<void> {
    const { root, file } = await this.#location();
    await withFileStoreLock(file, async () => {
      const entries = await this.#read(root, file);
      await this.#write(root, file, entries.filter((entry) => entry.key !== key));
    });
  }

  async list(): Promise<readonly PromptCacheEntry[]> {
    const { root, file } = await this.#location();
    return withFileStoreLock(file, async () => {
      const entries = await this.#read(root, file);
      const active = entries.filter((entry) => Date.parse(entry.expiresAt) > Date.now());
      if (active.length !== entries.length) await this.#write(root, file, active);
      return active.map((entry) => ({ ...entry }));
    });
  }

  async clear(): Promise<number> {
    const { root, file } = await this.#location();
    return withFileStoreLock(file, async () => {
      const count = (await this.#read(root, file)).length;
      await this.#write(root, file, []);
      return count;
    });
  }
}

class ToolPermissionStore {
  readonly #projectDirectory: string;

  constructor(projectDirectory: string) {
    this.#projectDirectory = resolve(projectDirectory);
  }

  async #location(): Promise<{ root: string; file: string }> {
    const project = await realpath(this.#projectDirectory);
    const hiddenPath = join(project, ".harnest");
    await mkdir(hiddenPath, { recursive: true });
    const hidden = await realpath(hiddenPath);
    if (!isInside(project, hidden)) throw new Error("Tool permission storage resolves outside the project");
    return { root: hidden, file: join(hidden, "tool-permissions.json") };
  }

  async #read(root: string, file: string): Promise<ToolPermissionFile> {
    try {
      const parsed = JSON.parse((await readVerifiedFile(file, root, 1_048_576)).toString("utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid shape");
      const candidate = parsed as { version?: unknown; grants?: unknown };
      if ((candidate.version !== 1 && candidate.version !== 2) || !Array.isArray(candidate.grants)) throw new Error("invalid shape");
      const grants = candidate.grants.filter((grant): grant is PersistedToolPermission => Boolean(
        grant && typeof grant === "object" && !Array.isArray(grant)
        && typeof (grant as PersistedToolPermission).harnessId === "string"
        && typeof (grant as PersistedToolPermission).toolId === "string"
        && ((grant as PersistedToolPermission).connectionId === undefined
          || typeof (grant as PersistedToolPermission).connectionId === "string")
        && ((grant as PersistedToolPermission).capability === undefined
          || ["tool-execution", "workspace-read", "workspace-write", "process", "network", "module-execution"].includes((grant as PersistedToolPermission).capability!))
        && ((grant as PersistedToolPermission).resource === undefined
          || typeof (grant as PersistedToolPermission).resource === "string")
        && typeof (grant as PersistedToolPermission).createdAt === "string",
      ));
      return { version: candidate.version, grants };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return { version: 2, grants: [] };
      }
      throw new Error("Tool permission storage is invalid", { cause: error });
    }
  }

  async list(harnessId: string): Promise<PersistedToolPermission[]> {
    const { root, file } = await this.#location();
    const stored = await this.#read(root, file);
    return stored.grants.filter((grant) => grant.harnessId === harnessId).map((grant) => ({ ...grant }));
  }

  async allows(harnessId: string, request: ToolApprovalRequest): Promise<boolean> {
    const scope = toolPermissionScope(request);
    return (await this.list(harnessId)).some((grant) => grant.toolId === request.tool.id
      && grant.connectionId === request.tool.connectionId
      && (grant.capability === undefined || (grant.capability === scope.capability && grant.resource === scope.resource)));
  }

  async grant(harnessId: string, request: ToolApprovalRequest): Promise<void> {
    const { root, file } = await this.#location();
    await withFileStoreLock(file, async () => {
      const stored = await this.#read(root, file);
      const scope = toolPermissionScope(request);
      if (stored.grants.some((grant) => grant.harnessId === harnessId && grant.toolId === request.tool.id
        && grant.connectionId === request.tool.connectionId && grant.capability === scope.capability
        && grant.resource === scope.resource)) return;
      const next: PersistedToolPermission = {
        harnessId,
        toolId: request.tool.id,
        ...(request.tool.connectionId ? { connectionId: request.tool.connectionId } : {}),
        ...scope,
        createdAt: new Date().toISOString(),
      };
      await atomicWriteVerifiedFile(file, root, JSON.stringify({ version: 2, grants: [...stored.grants, next] }, null, 2));
    });
  }

  async grantScope(scope: PersistentPermissionScope): Promise<void> {
    const { root, file } = await this.#location();
    await withFileStoreLock(file, async () => {
      const stored = await this.#read(root, file);
      if (stored.grants.some((grant) => grant.harnessId === scope.harnessId && grant.toolId === scope.toolId
        && grant.connectionId === scope.connectionId && grant.capability === scope.capability
        && grant.resource === scope.resource)) return;
      await atomicWriteVerifiedFile(file, root, JSON.stringify({ version: 2, grants: [...stored.grants, {
        harnessId: scope.harnessId,
        toolId: scope.toolId,
        ...(scope.connectionId ? { connectionId: scope.connectionId } : {}),
        capability: scope.capability,
        ...(scope.resource ? { resource: scope.resource } : {}),
        createdAt: new Date().toISOString(),
      } satisfies PersistedToolPermission] }, null, 2));
    });
  }

  async revoke(harnessId: string, toolId: string, connectionId?: string, capability?: PersistedToolPermission["capability"], resource?: string): Promise<boolean> {
    const { root, file } = await this.#location();
    return withFileStoreLock(file, async () => {
      const stored = await this.#read(root, file);
      const grants = stored.grants.filter((grant) => !(grant.harnessId === harnessId && grant.toolId === toolId
        && grant.connectionId === connectionId && (capability === undefined
          || (grant.capability === capability && grant.resource === resource))));
      if (grants.length === stored.grants.length) return false;
      await atomicWriteVerifiedFile(file, root, JSON.stringify({ version: 2, grants }, null, 2));
      return true;
    });
  }
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
  readonly promptCache: FilePromptCacheStore;
  readonly harnessId: string;
  readonly providers: NonNullable<RuntimeServices["providers"]>;
  readonly #projectDirectory: string;
  readonly #root: Promise<string>;
  readonly #memory: FileMemoryStore;
  readonly #options: NodeRuntimeServiceOptions;
  readonly #harnessId: string;
  readonly #toolPermissions: ToolPermissionStore;
  readonly #connections = new Map<string, Promise<McpConnection>>();
  readonly #connectionSecrets = new Map<string, { readonly value: string; readonly runIds: Set<string> }>();
  readonly #sandboxProjects = new Map<string, Promise<SandboxProjectWorkspace>>();
  readonly #sandboxSyncLocks = new Map<string, Promise<void>>();
  readonly #artifactDirectories = new Map<string, Promise<SandboxArtifactDirectory>>();

  constructor(projectDirectory: string, options: NodeRuntimeServiceOptions = {}) {
    this.#projectDirectory = resolve(projectDirectory);
    this.#root = projectRoot(projectDirectory);
    this.#memory = new FileMemoryStore(projectDirectory);
    this.#options = options;
    this.#harnessId = resolve(options.harnessId ?? projectDirectory);
    this.harnessId = this.#harnessId;
    this.#toolPermissions = new ToolPermissionStore(projectDirectory);
    const permissionId = (scope: PersistentPermissionScope) => `permission_${createHash("sha256")
      .update(JSON.stringify(scope)).digest("hex").slice(0, 24)}`;
    const permissionFrom = (grant: PersistedToolPermission): PersistentPermissionGrant | undefined => {
      if (grant.capability !== "network" && grant.capability !== "process" && grant.capability !== "workspace-write") return undefined;
      const scope: PersistentPermissionScope = {
        harnessId: grant.harnessId, toolId: grant.toolId,
        ...(grant.connectionId ? { connectionId: grant.connectionId } : {}),
        capability: grant.capability,
        ...(grant.resource ? { resource: grant.resource } : {}),
      };
      return { id: permissionId(scope), scope, effect: "allow_always", createdAt: grant.createdAt };
    };
    const permissions: PermissionProvider = {
      list: async ({ harnessId }) => (await this.#toolPermissions.list(harnessId)).flatMap((grant) => permissionFrom(grant) ?? []),
      find: async (scope) => (await this.#toolPermissions.list(scope.harnessId)).map(permissionFrom)
        .find((grant) => grant?.id === permissionId(scope)),
      grant: async ({ scope }) => {
        await this.#toolPermissions.grantScope(scope);
        return { id: permissionId(scope), scope, effect: "allow_always", createdAt: new Date().toISOString() };
      },
      revoke: async ({ id }) => {
        const grant = (await this.#toolPermissions.list(this.#harnessId)).map(permissionFrom).find((candidate) => candidate?.id === id);
        return grant ? this.#toolPermissions.revoke(
          grant.scope.harnessId, grant.scope.toolId, grant.scope.connectionId, grant.scope.capability, grant.scope.resource,
        ) : false;
      },
    };
    this.providers = { permissions };
    this.promptCache = new FilePromptCacheStore(projectDirectory);
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

  async releaseRun(runId: string): Promise<void> {
    for (const [reference, unlocked] of this.#connectionSecrets) {
      unlocked.runIds.delete(runId);
      if (unlocked.runIds.size === 0) this.#connectionSecrets.delete(reference);
    }
    const staged = this.#sandboxProjects.get(runId);
    this.#sandboxProjects.delete(runId);
    const lock = this.#sandboxSyncLocks.get(runId);
    this.#sandboxSyncLocks.delete(runId);
    await lock?.catch(() => undefined);
    if (staged) {
      const workspace = await staged.catch(() => undefined);
      if (workspace) await rm(workspace.directory, { recursive: true, force: true });
    }
    const artifacts = this.#artifactDirectories.get(runId);
    this.#artifactDirectories.delete(runId);
    const artifactDirectory = await artifacts?.catch(() => undefined);
    if (artifactDirectory?.managed && (await readdir(artifactDirectory.directory)).length === 0) {
      await rm(artifactDirectory.directory, { recursive: true, force: true });
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
    const mounts = await this.#sandboxMounts(request.runId, request.toolId === "builtin.code-runner");
    try {
      const result = await runBoundedProcess({
        ...request,
        command: engine.path,
        args: containerRunArguments(profile, name, command, [], imageId, mounts),
        cwd: dirname(engine.path),
        environment: engineEnvironment,
      });
      if (request.runId) await this.#syncSandboxProject(request.runId);
      return result;
    } finally {
      await runBoundedProcess({
        toolId: `${request.toolId}:cleanup`, command: engine.path, args: ["rm", "--force", name],
        cwd: dirname(engine.path), stdin: "", timeoutMs: 5_000, maxInputBytes: 1,
        maxOutputBytes: 64 * 1_024, signal: new AbortController().signal, environment: engineEnvironment,
      }).catch(() => undefined);
    }
  }

  async #sandboxMounts(runId: string | undefined, includePlaygroundFiles: boolean): Promise<ContainerMount[]> {
    const configured = this.#options.sandboxWorkspace;
    const root = await this.#root;
    const mounts: ContainerMount[] = [];
    if (configured) {
      for (const [directory, target, readOnly, enabled] of [
        [configured.inputDirectory, "/mnt/data", true, includePlaygroundFiles],
        [configured.outputDirectory, "/mnt/output", false, true],
      ] as const) {
        if (!enabled) continue;
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
        if (target === "/mnt/output" && runId) {
          this.#artifactDirectories.set(runId, Promise.resolve({ directory: canonical, managed: false }));
        }
      }
    }
    if (runId && !mounts.some(({ target }) => target === "/mnt/output")) {
      const artifacts = await this.#artifactDirectory(runId);
      mounts.push({ source: artifacts.directory, target: "/mnt/output", readOnly: false });
    }
    const access = configured?.projectAccess ?? (this.#options.allowFileSystem === true ? "write" : undefined);
    if (access && runId) {
      const workspace = await this.#sandboxProject(runId, access);
      mounts.push({ source: workspace.directory, target: "/workspace", readOnly: access === "read" });
      const dependencies = join(root, "node_modules");
      try {
        const lexical = await lstat(dependencies);
        const canonical = await realpath(dependencies);
        if (lexical.isDirectory() && !lexical.isSymbolicLink() && isInside(root, canonical)
          && (await stat(canonical)).isDirectory()) {
          mounts.push({ source: canonical, target: "/workspace/node_modules", readOnly: true });
        }
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
    return mounts;
  }

  #sandboxProject(runId: string, access: "read" | "write"): Promise<SandboxProjectWorkspace> {
    const existing = this.#sandboxProjects.get(runId);
    if (existing) return existing;
    const created = this.#createSandboxProject(access);
    this.#sandboxProjects.set(runId, created);
    void created.catch(() => {
      if (this.#sandboxProjects.get(runId) === created) this.#sandboxProjects.delete(runId);
    });
    return created;
  }

  async #createSandboxProject(access: "read" | "write"): Promise<SandboxProjectWorkspace> {
    const root = await this.#root;
    const workspaces = await storageDirectory(root, "runtime/workspaces");
    const directory = join(workspaces, randomUUID());
    await mkdir(directory, { mode: 0o700 });
    const baseline = new Map<string, SandboxProjectFile>();
    let files = 0;
    let bytes = 0;
    const visit = async (source: string, destination: string): Promise<void> => {
      const entries = await readdir(source, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const sourcePath = join(source, entry.name);
        const relativePath = relative(root, sourcePath).split(sep).join("/");
        if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) continue;
        if (entry.isDirectory() && SANDBOX_PROJECT_IGNORED_DIRECTORIES.has(entry.name)) continue;
        if (relativePath !== ".harnest" && isSensitiveWorkspacePath(root, sourcePath)) continue;
        const lexical = await lstat(sourcePath);
        if (lexical.isSymbolicLink()) continue;
        const canonical = await realpath(sourcePath);
        if (!isInside(root, canonical)) continue;
        const destinationPath = join(destination, entry.name);
        if (entry.isDirectory()) {
          await mkdir(destinationPath, { mode: access === "write" ? 0o777 : 0o755 });
          await chmod(destinationPath, access === "write" ? 0o777 : 0o755);
          await visit(canonical, destinationPath);
          continue;
        }
        const info = await stat(canonical);
        if (!info.isFile() || info.size > SANDBOX_PROJECT_MAX_FILE_BYTES) continue;
        files += 1;
        bytes += info.size;
        if (files > SANDBOX_PROJECT_MAX_FILES || bytes > SANDBOX_PROJECT_MAX_BYTES) {
          throw new Error(
            `Approved workspace exceeds the sandbox snapshot limit (${SANDBOX_PROJECT_MAX_FILES} files / 256 MiB)`,
          );
        }
        const content = await readVerifiedFile(canonical, root, SANDBOX_PROJECT_MAX_FILE_BYTES);
        await writeFile(destinationPath, content, { flag: "wx", mode: access === "write" ? 0o666 : 0o444 });
        await chmod(destinationPath, access === "write" ? 0o666 : 0o444);
        baseline.set(relativePath, { sha256: fileSha256(content), mode: info.mode & 0o777 });
      }
    };
    try {
      await chmod(directory, access === "write" ? 0o777 : 0o755);
      await visit(root, directory);
      return { directory, access, baseline };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async #syncSandboxProject(runId: string): Promise<void> {
    const pending = this.#sandboxProjects.get(runId);
    if (!pending) return;
    const workspace = await pending;
    if (workspace.access !== "write") return;
    const previous = this.#sandboxSyncLocks.get(runId) ?? Promise.resolve();
    const next = previous.then(() => this.#applySandboxChanges(workspace));
    this.#sandboxSyncLocks.set(runId, next);
    try {
      await next;
    } finally {
      if (this.#sandboxSyncLocks.get(runId) === next) this.#sandboxSyncLocks.delete(runId);
    }
  }

  async #applySandboxChanges(workspace: SandboxProjectWorkspace): Promise<void> {
    const root = await this.#root;
    let files = 0;
    let bytes = 0;
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) continue;
        const lexical = await lstat(path);
        if (lexical.isSymbolicLink()) continue;
        const canonical = await realpath(path);
        if (!isInside(workspace.directory, canonical)) continue;
        if (entry.isDirectory()) {
          await visit(canonical);
          continue;
        }
        const relativePath = relative(workspace.directory, canonical).split(sep).join("/");
        const target = resolve(root, relativePath);
        if (!isInside(root, target) || isSensitiveWorkspacePath(root, target)) continue;
        const info = await stat(canonical);
        if (!info.isFile() || info.size > SANDBOX_PROJECT_MAX_FILE_BYTES) {
          throw new Error(`Sandbox change '${relativePath}' exceeds the 16 MiB file limit`);
        }
        files += 1;
        bytes += info.size;
        if (files > SANDBOX_PROJECT_MAX_FILES || bytes > SANDBOX_PROJECT_MAX_BYTES) {
          throw new Error("Sandbox changes exceed the approved workspace limit");
        }
        const content = await readVerifiedFile(canonical, workspace.directory, SANDBOX_PROJECT_MAX_FILE_BYTES);
        const sha256 = fileSha256(content);
        const baseline = workspace.baseline.get(relativePath);
        if (baseline?.sha256 === sha256) continue;
        let current: Buffer | undefined;
        try {
          const lexicalTarget = await lstat(target);
          if (!lexicalTarget.isFile() || lexicalTarget.isSymbolicLink()) {
            throw new Error(`Workspace target '${relativePath}' is not a regular file`);
          }
          current = await readVerifiedFile(await realpath(target), root, SANDBOX_PROJECT_MAX_FILE_BYTES);
        } catch (error) {
          if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
        }
        if ((baseline && (!current || fileSha256(current) !== baseline.sha256)) || (!baseline && current)) {
          throw new Error(`Workspace target '${relativePath}' changed outside the sandbox; reload and retry`);
        }
        await this.#ensureSandboxTargetParent(root, relativePath);
        await atomicWriteVerifiedFile(target, root, content);
        const mode = baseline?.mode ?? ((info.mode & 0o111) ? 0o700 : 0o600);
        await chmod(target, mode);
        workspace.baseline.set(relativePath, { sha256, mode });
      }
    };
    await visit(workspace.directory);
  }

  async #ensureSandboxTargetParent(root: string, relativePath: string): Promise<void> {
    const segments = dirname(relativePath).split("/").filter((segment) => segment && segment !== ".");
    let current = root;
    for (const segment of segments) {
      const next = join(current, segment);
      if (!isInside(root, next) || isSensitiveWorkspacePath(root, next)) {
        throw new Error(`Workspace directory '${relativePath}' is protected`);
      }
      try {
        const info = await lstat(next);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(
          `Workspace directory '${relativePath}' changed while applying sandbox output`,
        );
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
        await mkdir(next, { mode: 0o700 });
      }
      current = await realpath(next);
      if (!isInside(root, current)) throw new Error(`Workspace directory '${relativePath}' resolves outside the project`);
    }
  }

  #artifactDirectory(runId: string): Promise<SandboxArtifactDirectory> {
    if (!ARTIFACT_RUN_ID.test(runId)) return Promise.reject(new Error("Artifact run id is invalid"));
    const existing = this.#artifactDirectories.get(runId);
    if (existing) return existing;
    const created = this.#createManagedArtifactDirectory(runId);
    this.#artifactDirectories.set(runId, created);
    void created.catch(() => {
      if (this.#artifactDirectories.get(runId) === created) this.#artifactDirectories.delete(runId);
    });
    return created;
  }

  async #createManagedArtifactDirectory(runId: string): Promise<SandboxArtifactDirectory> {
    if (!ARTIFACT_RUN_ID.test(runId)) throw new Error("Artifact run id is invalid");
    const root = await this.#root;
    const artifacts = await storageDirectory(root, "artifacts");
    await this.#pruneManagedArtifacts(artifacts, runId);
    const directory = join(artifacts, runId);
    await mkdir(directory, { mode: 0o777 }).catch((error: unknown) => {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
    });
    const lexical = await lstat(directory);
    const canonical = await realpath(directory);
    if (!lexical.isDirectory() || lexical.isSymbolicLink() || !isInside(artifacts, canonical)) {
      throw new Error("Artifact directory is unsafe");
    }
    await chmod(canonical, 0o777);
    return { directory: canonical, managed: true };
  }

  async #pruneManagedArtifacts(artifacts: string, currentRunId: string): Promise<void> {
    const candidates: Array<{ path: string; mtimeMs: number; runId: string }> = [];
    for (const entry of await readdir(artifacts, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !ARTIFACT_RUN_ID.test(entry.name) || entry.name === currentRunId) continue;
      const lexical = join(artifacts, entry.name);
      try {
        const link = await lstat(lexical);
        const canonical = await realpath(lexical);
        if (!link.isDirectory() || link.isSymbolicLink() || !isInside(artifacts, canonical)) continue;
        candidates.push({ path: canonical, mtimeMs: (await stat(canonical)).mtimeMs, runId: entry.name });
      } catch {
        // A concurrent cleanup already handled this entry.
      }
    }
    candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
    const now = Date.now();
    await Promise.all(candidates.flatMap((candidate, index) => {
      if (this.#artifactDirectories.has(candidate.runId)
        || (index < ARTIFACT_RETAINED_RUNS && now - candidate.mtimeMs <= ARTIFACT_RETENTION_MS)) return [];
      return [rm(candidate.path, { recursive: true, force: true })];
    }));
  }

  async #storedArtifactDirectory(runId: string): Promise<SandboxArtifactDirectory | undefined> {
    if (!ARTIFACT_RUN_ID.test(runId)) throw new Error("Artifact run id is invalid");
    const active = this.#artifactDirectories.get(runId);
    if (active) return active;
    const root = await this.#root;
    const artifacts = await storageDirectory(root, "artifacts");
    const directory = join(artifacts, runId);
    try {
      const lexical = await lstat(directory);
      const canonical = await realpath(directory);
      if (!lexical.isDirectory() || lexical.isSymbolicLink() || !isInside(artifacts, canonical)) {
        throw new Error("Artifact directory is unsafe");
      }
      return { directory: canonical, managed: true };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async #artifactEntries(runId: string): Promise<Array<NodeArtifactContent>> {
    const stored = await this.#storedArtifactDirectory(runId);
    if (!stored) return [];
    const output: NodeArtifactContent[] = [];
    let total = 0;
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > 5) return;
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (output.length >= 100) return;
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) continue;
        const lexical = await lstat(path);
        if (lexical.isSymbolicLink()) continue;
        const canonical = await realpath(path);
        if (!isInside(stored.directory, canonical)) continue;
        if (entry.isDirectory()) {
          await visit(canonical, depth + 1);
          continue;
        }
        const info = await stat(canonical);
        if (!info.isFile() || info.size <= 0 || info.size > 64 * 1_048_576 || total + info.size > 256 * 1_048_576) continue;
        total += info.size;
        const content = await readVerifiedFile(canonical, stored.directory, 64 * 1_048_576);
        const sha256 = fileSha256(content);
        const name = relative(stored.directory, canonical).split(sep).join("/");
        const id = `artifact_${createHash("sha256").update(`${runId}\0${name}\0${sha256}`).digest("hex").slice(0, 24)}`;
        const mimeType = artifactMimeType(name);
        output.push({
          artifact: {
            id,
            name,
            mimeType,
            size: content.byteLength,
            sha256,
            ref: `harnest-artifact:${runId}/${id}`,
            preview: artifactPreview(mimeType, name),
            status: "ready",
          },
          content,
        });
      }
    };
    await visit(stored.directory, 0);
    return output;
  }

  async listArtifacts(runId: string): Promise<readonly ArtifactReference[]> {
    const active = await this.#storedArtifactDirectory(runId);
    if (active && !active.managed) {
      const external = await this.#artifactEntries(runId);
      if (external.length) {
        const managed = await this.#createManagedArtifactDirectory(runId);
        for (const { artifact, content } of external) {
          const target = resolve(managed.directory, ...artifact.name.split("/"));
          if (!isInside(managed.directory, target)) throw new Error("Artifact path is invalid");
          await mkdir(dirname(target), { recursive: true, mode: 0o700 });
          await atomicWriteVerifiedFile(target, managed.directory, content);
        }
        this.#artifactDirectories.set(runId, Promise.resolve(managed));
      }
    }
    return (await this.#artifactEntries(runId)).map(({ artifact }) => artifact);
  }

  async readAttachment(attachment: RunAttachment, _context: ServiceExecutionContext): Promise<Uint8Array> {
    const inputDirectory = this.#options.sandboxWorkspace?.inputDirectory;
    if (!inputDirectory || typeof attachment.sandboxPath !== "string"
      || !attachment.sandboxPath.startsWith("/mnt/data/")) {
      throw new Error(`Attachment '${attachment.name}' is not available in this runtime`);
    }
    const relativePath = attachment.sandboxPath.slice("/mnt/data/".length);
    if (!relativePath || relativePath.includes("\\") || relativePath.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error("Attachment path is invalid");
    }
    const root = await realpath(resolve(inputDirectory));
    const target = resolve(root, ...relativePath.split("/"));
    if (!isInside(root, target)) throw new Error("Attachment resolves outside the selected run files");
    const lexical = await lstat(target);
    if (!lexical.isFile() || lexical.isSymbolicLink()) throw new Error("Attachment is not a regular file");
    const canonical = await realpath(target);
    if (!isInside(root, canonical)) throw new Error("Attachment resolves outside the selected run files");
    const info = await stat(canonical);
    if (info.size !== attachment.size || info.size > 20 * 1_048_576) {
      throw new Error(`Attachment '${attachment.name}' changed or exceeds the direct model-input limit`);
    }
    return readVerifiedFile(canonical, root, 20 * 1_048_576);
  }

  async readArtifact(runId: string, artifactId: string): Promise<NodeArtifactContent> {
    if (!ARTIFACT_ID.test(artifactId)) throw new Error("Artifact id is invalid");
    const found = (await this.#artifactEntries(runId)).find(({ artifact }) => artifact.id === artifactId);
    if (!found) throw new Error("Artifact was not found");
    return found;
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
      runId: request.context.runId,
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
      return { approved: true, source: "user", mode: "allow_always", reason: `Tool '${request.tool.id}' was pre-approved` };
    }
    if (await this.#toolPermissions.allows(this.#harnessId, request)) {
      return { approved: true, source: "policy", mode: "allow_always", reason: `Tool '${request.tool.id}' is always allowed for this Harness` };
    }
    if (this.#options.requestToolApproval) {
      const decision = await this.#options.requestToolApproval(request, context);
      const normalized: ToolApprovalDecision = {
        ...decision,
        mode: normalizePermissionDecision(decision.mode, decision.approved),
      };
      if (normalized.approved && normalized.mode === "allow_always") {
        await this.#toolPermissions.grant(this.#harnessId, request);
      }
      return normalized;
    }
    return {
      approved: false,
      source: "policy",
      mode: "deny",
      reason: `Tool '${request.tool.id}' requires explicit approval`,
    };
  }

  canResolveInteraction(request: InteractionRequest): boolean {
    if (this.#options.requestToolApproval) return true;
    const data = request.data && typeof request.data === "object" ? request.data as Record<string, unknown> : undefined;
    const permission = data?.permission && typeof data.permission === "object"
      ? data.permission as Record<string, unknown> : undefined;
    return typeof permission?.toolId === "string" && this.#options.approvedToolIds?.includes(permission.toolId) === true;
  }

  listToolPermissions(): Promise<PersistedToolPermission[]> {
    return this.#toolPermissions.list(this.#harnessId);
  }

  revokeToolPermission(toolId: string, connectionId?: string, capability?: PersistedToolPermission["capability"], resource?: string): Promise<boolean> {
    return this.#toolPermissions.revoke(this.#harnessId, toolId, connectionId, capability, resource);
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
    // Saved lifecycle mutations and run-bound interaction handlers must never share a pooled client.
    const ephemeral = connectionId !== undefined || context.requestInteraction !== undefined;
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
    const staged = await Promise.allSettled(this.#sandboxProjects.values());
    this.#connections.clear();
    this.#connectionSecrets.clear();
    this.#sandboxProjects.clear();
    this.#sandboxSyncLocks.clear();
    this.#artifactDirectories.clear();
    await Promise.allSettled(settled.flatMap((result) => {
      if (result.status === "rejected") return [];
      return [this.#closeConnection(result.value)];
    }));
    await Promise.allSettled(staged.flatMap((result) => result.status === "fulfilled"
      ? [rm(result.value.directory, { recursive: true, force: true })]
      : []));
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
    const elicitationHandler: McpElicitationHandler | undefined = context.requestInteraction
      ? (params) => resolveMcpElicitation(params, context, toolName)
      : undefined;
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
          ...(elicitationHandler ? { elicitationHandler } : {}),
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
      {
        versionNegotiation: protocolMode(config, transportType),
        listMaxPages: 16,
        ...(elicitationHandler ? {
          capabilities: { elicitation: { form: {}, url: {} } },
          inputRequired: { autoFulfill: true },
        } : {}),
      },
    );
    if (elicitationHandler) client.setRequestHandler(
      "elicitation/create",
      ({ params }) => elicitationHandler(params),
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
  readonly sequence?: number;
}

export interface RunSummary {
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly status: "running" | "succeeded" | "failed" | "cancelled";
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
  maxDepth = 3,
  maxStringBytes = 512,
): unknown {
  if (budget.remaining <= 0) return "[TRUNCATED]";
  if (sensitiveKey.test(key)) {
    budget.remaining -= 10;
    return "[REDACTED]";
  }
  if (typeof value === "string") {
    const selected = truncateUtf8(value, Math.min(maxStringBytes, budget.remaining)).value;
    budget.remaining -= byteLength(selected);
    return selected;
  }
  if (value === null || typeof value !== "object") {
    budget.remaining -= 16;
    return value;
  }
  if (depth >= maxDepth) {
    budget.remaining -= Math.min(512, budget.remaining);
    return valueShape(value);
  }
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const item of value.slice(0, 20)) {
      if (budget.remaining <= 0) break;
      result.push(safeTraceValue(item, "", depth + 1, budget, maxDepth, maxStringBytes));
    }
    return result;
  }
  const result: Record<string, unknown> = {};
  for (const [name, item] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
    if (budget.remaining <= 0) break;
    budget.remaining -= Math.min(byteLength(name), 128);
    result[name] = safeTraceValue(item, name, depth + 1, budget, maxDepth, maxStringBytes);
  }
  return result;
}

function storedEvent(event: RunEvent): StoredRunEvent {
  const userResult = event.type === "run-end";
  return safeTraceValue(event, "", 0, { remaining: 32_768 }, event.type === "run-snapshot" || userResult ? 7 : 3, userResult ? 24_576 : 512) as StoredRunEvent;
}

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_RUN_FILE_BYTES = 8 * 1_048_576;
const MAX_RUN_LINE_BYTES = 65_536;
const MAX_RUN_EVENTS = 10_000;
const MAX_RUN_SHARDS = 16;
const MAX_RUN_BUNDLE_BYTES = MAX_RUN_SHARDS * MAX_RUN_FILE_BYTES;
const MAX_RUN_SNAPSHOT_BYTES = 4 * 1_048_576;
const MAX_RUN_COMMIT_BYTES = MAX_RUN_SNAPSHOT_BYTES + MAX_RUN_LINE_BYTES + 65_536;
const RUN_SHARD = /^\d{6}\.ndjson$/;

interface StoredRunCommit {
  readonly version: 1 | 2;
  readonly owner?: { readonly id: string; readonly pid: number };
  readonly event: StoredRunEvent;
  readonly snapshot: RunSnapshot;
}

const runStoreHost = globalThis as typeof globalThis & {
  __harnestRunStoreOwner?: string;
  __harnestActiveCommits?: Set<string>;
};
const RUN_STORE_OWNER = runStoreHost.__harnestRunStoreOwner ??= randomUUID();
const ACTIVE_RUN_COMMITS = runStoreHost.__harnestActiveCommits ??= new Set<string>();
const RUN_STORE_OPERATIONS = (runStoreHost as typeof runStoreHost & {
  __harnestRunStoreOperations?: Map<string, Promise<void>>;
}).__harnestRunStoreOperations ??= new Map<string, Promise<void>>();

export * from "./node-run-idempotency.js";

interface StoredRunMeta {
  readonly version: 1;
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly status: RunSummary["status"];
  readonly durationMs?: number;
  readonly eventCount: number;
}

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

async function openRunFileForAppend(directory: string, filename: string): Promise<FileHandle> {
  const path = resolve(directory, filename);
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
  readonly #operationRoot: string;

  constructor(projectDirectory: string) {
    this.#root = projectRoot(projectDirectory);
    this.#operationRoot = resolve(projectDirectory);
  }

  append(event: RunEvent): Promise<void> {
    if (!RUN_ID.test(event.runId)) return Promise.reject(new Error("Run id is invalid"));
    const write = () => this.#withRunLease(event.runId, async () => {
      await this.#recoverCommit(event.runId);
      await this.#append(event);
    });
    return this.#enqueue(event.runId, write);
  }

  commit(event: RunEvent, snapshot: RunSnapshot): Promise<void> {
    if (event.runId !== snapshot.runId || !RUN_ID.test(event.runId)) return Promise.reject(new Error("Run commit is invalid"));
    const write = () => this.#withRunLease(event.runId, async () => {
      await this.#recoverCommit(event.runId);
      const root = await this.#root;
      const bundle = await storageDirectory(root, `runs/${event.runId}`);
      const commit: StoredRunCommit = {
        version: 2, owner: { id: RUN_STORE_OWNER, pid: process.pid },
        event: storedEvent(event), snapshot: this.#snapshotValue(snapshot),
      };
      const existing = await this.#readBundle(bundle, event.runId).catch((error: unknown) => {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
        throw error;
      });
      if (typeof commit.event.sequence === "number") {
        const duplicate = existing.find(({ sequence }) => sequence === commit.event.sequence);
        if (duplicate && JSON.stringify(duplicate) !== JSON.stringify(commit.event)) {
          throw new Error(`Run event sequence ${commit.event.sequence} conflicts with stored history`);
        }
        if (!duplicate && typeof existing.at(-1)?.sequence === "number"
          && existing.at(-1)!.sequence! >= commit.event.sequence) {
          throw new Error(`Run event sequence ${commit.event.sequence} is already committed`);
        }
      }
      const serialized = `${JSON.stringify(commit)}\n`;
      if (byteLength(serialized) > MAX_RUN_COMMIT_BYTES) throw new Error("Run commit exceeds the recovery journal limit");
      const journal = resolve(bundle, "commit.json");
      ACTIVE_RUN_COMMITS.add(journal);
      try {
        await atomicWriteVerifiedFile(journal, bundle, serialized);
        await this.#applyCommit(bundle, commit);
        await rm(journal, { force: true });
      } finally { ACTIVE_RUN_COMMITS.delete(journal); }
    });
    return this.#enqueue(event.runId, write);
  }

  async read(runId: string): Promise<StoredRunEvent[]> {
    if (!RUN_ID.test(runId)) throw new Error("Run id is invalid");
    await this.#waitForPending(runId);
    return this.#stableRead(async () => {
      const directory = await storageDirectory(await this.#root, "runs");
      const bundle = await this.#bundle(directory, runId);
      if (bundle) { await this.#recoverCommit(runId, bundle); return this.#readBundle(bundle, runId); }
      const file = await runFile(directory, runId);
      if (file.size > MAX_RUN_FILE_BYTES) throw new Error("Run trace exceeds the 8 MiB safety limit");
      const selected = await readBounded(file.path, directory, MAX_RUN_FILE_BYTES);
      if (selected.truncated) throw new Error("Run trace exceeds the 8 MiB safety limit");
      return parseRunEvents(runId, selected.text);
    });
  }

  async readEvents(runId: string, afterSequence = 0): Promise<StoredRunEvent[]> {
    return (await this.read(runId)).filter((event) => typeof event.sequence !== "number" || event.sequence > afterSequence);
  }

  async readSnapshot(runId: string): Promise<RunSnapshot | undefined> {
    if (!RUN_ID.test(runId)) throw new Error("Run id is invalid");
    await this.#waitForPending(runId);
    return this.#stableRead(async () => {
      const directory = await storageDirectory(await this.#root, "runs");
      const bundle = await this.#bundle(directory, runId);
      if (!bundle) return undefined;
      await this.#recoverCommit(runId, bundle);
      try {
        const parsed = JSON.parse((await readVerifiedFile(resolve(bundle, "snapshot.json"), bundle, MAX_RUN_SNAPSHOT_BYTES)).toString("utf8")) as unknown;
        const record = asRecord(parsed);
        return record?.runId === runId ? record as unknown as RunSnapshot : undefined;
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
      }
    });
  }

  saveSnapshot(snapshot: RunSnapshot): Promise<void> {
    if (!RUN_ID.test(snapshot.runId)) return Promise.reject(new Error("Run id is invalid"));
    return this.#enqueue(snapshot.runId, () => this.#withRunLease(snapshot.runId, () => this.#saveSnapshot(snapshot)));
  }

  async list(limit = 50): Promise<RunSummary[]> {
    const boundedLimit = Math.min(Math.max(1, Math.floor(limit)), 500);
    const directory = await storageDirectory(await this.#root, "runs");
    const files = new Set((await readdir(directory, { withFileTypes: true })).flatMap((entry) => {
      const runId = entry.isFile() && entry.name.endsWith(".ndjson") ? entry.name.slice(0, -7)
        : entry.isDirectory() ? entry.name : "";
      return RUN_ID.test(runId) && (entry.isDirectory() || entry.isFile()) ? [runId] : [];
    }));
    const ordered: { runId: string; modified: number }[] = [];
    for (const runId of files) {
      try {
        const bundle = await this.#bundle(directory, runId);
        if (bundle) ordered.push({ runId, modified: (await stat(bundle)).mtimeMs });
        else {
          const file = await runFile(directory, runId);
          if (file.size <= MAX_RUN_FILE_BYTES) ordered.push({ runId, modified: file.modified });
        }
      } catch {
        // A concurrently removed, linked, or invalid trace is not listable.
      }
    }
    ordered.sort((left, right) => right.modified - left.modified);
    // ponytail: scanning the newest NDJSON files is enough until projects reach thousands of local runs.
    const summaries: RunSummary[] = [];
    for (const { runId } of ordered) {
      if (summaries.length >= boundedLimit) break;
      const bundle = await this.#bundle(directory, runId);
      if (bundle) {
        const meta = await this.#readMeta(bundle, runId);
        if (meta) { summaries.push(meta); continue; }
      }
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

  delete(runId: string): Promise<boolean> {
    if (!RUN_ID.test(runId)) return Promise.reject(new Error("Run id is invalid"));
    let deleted = false;
    const remove = async () => {
      const root = await this.#root;
      await acquireRunExecutionLease(root, runId);
      try {
        const directory = await storageDirectory(root, "runs");
        const bundle = await this.#bundle(directory, runId);
        if (bundle) {
          await rm(bundle, { recursive: true, force: true });
          deleted = true;
        }
        try {
          const legacy = await runFile(directory, runId);
          await rm(legacy.path, { force: true });
          deleted = true;
        } catch (error) {
          if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
        }
      } finally {
        await releaseRunExecutionLease(root, runId);
      }
    };
    return this.#enqueue(runId, remove).then(() => deleted);
  }

  async #append(event: RunEvent): Promise<void> {
    const safeEvent = storedEvent(event);
    const serialized = JSON.stringify(safeEvent);
    if (byteLength(serialized) > MAX_RUN_LINE_BYTES) {
      throw new Error("Run trace event exceeds the 64 KiB line limit");
    }
    const line = Buffer.from(`${serialized}\n`, "utf8");
    const root = await this.#root;
    const runs = await storageDirectory(root, "runs");
    try {
      const legacy = await runFile(runs, event.runId);
      if (legacy.size + line.byteLength > MAX_RUN_FILE_BYTES) throw new Error("Run trace exceeds the 8 MiB safety limit");
      const selected = await readBounded(legacy.path, runs, MAX_RUN_FILE_BYTES);
      if (selected.truncated) throw new Error("Run trace exceeds the 8 MiB safety limit");
      const events = parseRunEvents(event.runId, selected.text);
      if (events.length >= MAX_RUN_EVENTS) throw new Error("Run trace exceeds the 10,000 event limit");
      throw new Error("Legacy run traces are read-only");
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
    const bundle = await storageDirectory(root, `runs/${event.runId}`);
    const directory = await storageDirectory(root, `runs/${event.runId}/events`);
    const shards = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && RUN_SHARD.test(entry.name)).map(({ name }) => name).sort();
    let shardNumber = shards.length ? Number(shards.at(-1)!.slice(0, 6)) : 1;
    let filename = `${String(shardNumber).padStart(6, "0")}.ndjson`;
    let handle = await openRunFileForAppend(directory, filename);
    try {
      let opened = await handle.stat({ bigint: true });
      let selected = await readBoundedHandle(handle, MAX_RUN_FILE_BYTES);
      if (selected.truncated || (selected.text.length > 0 && !selected.text.endsWith("\n"))) {
        throw new Error("Run trace shard is incomplete");
      }
      let events = parseRunEvents(event.runId, selected.text);
      const previous = events.at(-1) ?? (shards.length > 1 ? (await this.#readBundle(bundle, event.runId)).at(-1) : undefined);
      if (typeof safeEvent.sequence === "number" && typeof previous?.sequence === "number"
        && previous.sequence >= safeEvent.sequence) {
        if (previous.sequence === safeEvent.sequence && JSON.stringify(previous) === serialized) return;
        throw new Error(`Run event sequence ${safeEvent.sequence} is already committed`);
      }
      if (opened.size + BigInt(line.byteLength) > BigInt(MAX_RUN_FILE_BYTES) || events.length >= MAX_RUN_EVENTS) {
        await handle.close();
        shardNumber += 1;
        if (shardNumber > MAX_RUN_SHARDS) throw new Error(`Run trace exceeds the ${MAX_RUN_SHARDS}-shard safety limit`);
        filename = `${String(shardNumber).padStart(6, "0")}.ndjson`;
        handle = await openRunFileForAppend(directory, filename);
        opened = await handle.stat({ bigint: true });
        selected = await readBoundedHandle(handle, MAX_RUN_FILE_BYTES);
        events = parseRunEvents(event.runId, selected.text);
      }
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
    if (event.type === "run-start" || event.type === "run-end" || event.type === "error") {
      const existing = await this.#readMeta(bundle, event.runId);
      const status = event.type === "run-end" ? "succeeded" : event.type === "error"
        ? event.code === "RUN_CANCELLED" ? "cancelled" : "failed" : "running";
      const meta: StoredRunMeta = {
        version: 1,
        runId: event.runId,
        startedAt: existing?.startedAt ?? event.timestamp,
        ...(event.type === "run-start" ? {} : { finishedAt: event.timestamp }),
        status,
        ...(event.type === "run-end" ? { durationMs: event.durationMs } : {}),
        eventCount: event.sequence ?? (await this.#readBundle(bundle, event.runId)).length,
      };
      await atomicWriteVerifiedFile(resolve(bundle, "meta.json"), bundle, `${JSON.stringify(meta)}\n`);
    }
  }

  async #bundle(runs: string, runId: string): Promise<string | undefined> {
    const candidate = resolve(runs, runId);
    if (!isInside(runs, candidate)) throw new Error("Run bundle resolves outside Harnest storage");
    try {
      const lexical = await lstat(candidate);
      if (!lexical.isDirectory() || lexical.isSymbolicLink()) throw new Error("Run bundle is unsafe");
      const canonical = await realpath(candidate);
      if (!isInside(runs, canonical)) throw new Error("Run bundle resolves outside Harnest storage");
      return canonical;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async #withRunLease<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const root = await this.#root;
    await acquireRunExecutionLease(root, runId, true);
    try { return await operation(); } finally { await releaseRunExecutionLease(root, runId); }
  }

  #operationKey(runId: string): string {
    return `${this.#operationRoot}\0${runId}`;
  }

  async #enqueue(runId: string, operation: () => Promise<void>): Promise<void> {
    const key = this.#operationKey(runId);
    const previous = RUN_STORE_OPERATIONS.get(key) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    RUN_STORE_OPERATIONS.set(key, next);
    try { await next; } finally {
      if (RUN_STORE_OPERATIONS.get(key) === next) RUN_STORE_OPERATIONS.delete(key);
    }
  }

  async #waitForPending(runId: string): Promise<void> {
    await RUN_STORE_OPERATIONS.get(this.#operationKey(runId));
  }

  async #stableRead<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try { return await operation(); } catch (error) {
        if (attempt >= 4 || !(error instanceof Error)
          || !/(?:changed during I\/O|incomplete|ENOENT)/iu.test(error.message)) throw error;
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 10));
      }
    }
  }

  async #readBundle(bundle: string, runId: string): Promise<StoredRunEvent[]> {
    const eventsDirectory = await realpath(resolve(bundle, "events"));
    if (!isInside(bundle, eventsDirectory)) throw new Error("Run event storage is unsafe");
    const shards = (await readdir(eventsDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && RUN_SHARD.test(entry.name)).map(({ name }) => name).sort();
    if (shards.length > MAX_RUN_SHARDS) throw new Error("Run trace has too many shards");
    const events: StoredRunEvent[] = [];
    let bytes = 0;
    for (const shard of shards) {
      const path = resolve(eventsDirectory, shard);
      const info = await stat(path);
      bytes += info.size;
      if (info.size > MAX_RUN_FILE_BYTES || bytes > MAX_RUN_BUNDLE_BYTES) throw new Error("Run trace exceeds its safety limit");
      const text = (await readVerifiedFile(path, eventsDirectory, MAX_RUN_FILE_BYTES)).toString("utf8");
      events.push(...parseRunEvents(runId, text));
    }
    return events;
  }

  async #readMeta(bundle: string, runId: string): Promise<StoredRunMeta | undefined> {
    try {
      const value = JSON.parse((await readVerifiedFile(resolve(bundle, "meta.json"), bundle, 65_536)).toString("utf8")) as unknown;
      const record = asRecord(value);
      if (!record || record.version !== 1 || record.runId !== runId || typeof record.startedAt !== "string"
        || !["running", "succeeded", "failed", "cancelled"].includes(String(record.status))
        || typeof record.eventCount !== "number") return undefined;
      return record as unknown as StoredRunMeta;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  #snapshotValue(snapshot: RunSnapshot): RunSnapshot {
    let serialized: string;
    try {
      serialized = JSON.stringify(snapshot, function (_key, value: unknown) {
        if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Run snapshot contains a non-finite number");
        if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
          throw new Error(`Run snapshot contains a non-JSON ${typeof value}`);
        }
        if (value === undefined && Array.isArray(this)) throw new Error("Run snapshot contains an undefined array item");
        return value;
      });
    } catch (cause) {
      throw new Error("Run snapshot is not JSON serializable", { cause });
    }
    if (byteLength(serialized) + 1 > MAX_RUN_SNAPSHOT_BYTES) throw new Error("Run snapshot exceeds the 4 MiB safety limit");
    return JSON.parse(serialized) as RunSnapshot;
  }

  async #applyCommit(bundle: string, commit: StoredRunCommit): Promise<void> {
    let events: StoredRunEvent[] = [];
    try { events = await this.#readBundle(bundle, commit.event.runId); } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
    const duplicate = typeof commit.event.sequence === "number"
      ? events.find(({ sequence }) => sequence === commit.event.sequence)
      : events.find((event) => JSON.stringify(event) === JSON.stringify(commit.event));
    if (duplicate && JSON.stringify(duplicate) !== JSON.stringify(commit.event)) {
      throw new Error(`Run event sequence ${commit.event.sequence ?? "without a sequence"} conflicts with stored history`);
    }
    if (!duplicate) await this.#append(commit.event as unknown as RunEvent);
    let current: RunSnapshot | undefined;
    try {
      const value = JSON.parse((await readVerifiedFile(resolve(bundle, "snapshot.json"), bundle, MAX_RUN_SNAPSHOT_BYTES)).toString("utf8")) as unknown;
      const record = asRecord(value);
      if (record?.runId === commit.snapshot.runId) current = record as unknown as RunSnapshot;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
    if ((current?.sequence ?? -1) < (commit.snapshot.sequence ?? 0)) await this.#saveSnapshot(commit.snapshot);
  }

  async #recoverCommit(runId: string, knownBundle?: string): Promise<void> {
    const root = await this.#root;
    const runs = await storageDirectory(root, "runs");
    const bundle = knownBundle ?? await this.#bundle(runs, runId);
    if (!bundle) return;
    const journal = resolve(bundle, "commit.json");
    if (ACTIVE_RUN_COMMITS.has(journal)) return;
    let commit: StoredRunCommit;
    try {
      const parsed = JSON.parse((await readVerifiedFile(journal, bundle, MAX_RUN_COMMIT_BYTES)).toString("utf8")) as unknown;
      const record = asRecord(parsed);
      const event = asRecord(record?.event);
      const snapshot = asRecord(record?.snapshot);
      if ((record?.version !== 1 && record?.version !== 2) || event?.runId !== runId || snapshot?.runId !== runId) {
        throw new Error("Run recovery journal is invalid");
      }
      const owner = asRecord(record.owner);
      if (record.version === 2 && typeof owner?.pid === "number" && owner.pid !== process.pid) {
        try { process.kill(owner.pid, 0); return; } catch (probe) {
          if (probe && typeof probe === "object" && "code" in probe && probe.code === "EPERM") return;
        }
      }
      commit = record as unknown as StoredRunCommit;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    await this.#applyCommit(bundle, commit);
    await rm(journal, { force: true });
  }

  async #saveSnapshot(snapshot: RunSnapshot): Promise<void> {
    const root = await this.#root;
    const bundle = await storageDirectory(root, `runs/${snapshot.runId}`);
    const safe = this.#snapshotValue(snapshot);
    try {
      const value = JSON.parse((await readVerifiedFile(resolve(bundle, "snapshot.json"), bundle, MAX_RUN_SNAPSHOT_BYTES)).toString("utf8")) as unknown;
      const current = asRecord(value);
      if (typeof current?.sequence === "number" && typeof safe.sequence === "number" && current.sequence > safe.sequence) {
        throw new Error(`Run snapshot sequence ${safe.sequence} would regress stored sequence ${current.sequence}`);
      }
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
    const serialized = `${JSON.stringify(safe)}\n`;
    if (byteLength(serialized) > MAX_RUN_SNAPSHOT_BYTES) throw new Error("Run snapshot exceeds the 4 MiB safety limit");
    await atomicWriteVerifiedFile(resolve(bundle, "snapshot.json"), bundle, serialized);
    const existing = await this.#readMeta(bundle, snapshot.runId);
    if (existing) await atomicWriteVerifiedFile(resolve(bundle, "meta.json"), bundle, `${JSON.stringify({
      ...existing,
      status: snapshot.status,
      ...(snapshot.status === "running" ? {} : { finishedAt: snapshot.updatedAt }),
    })}\n`);
  }
}
