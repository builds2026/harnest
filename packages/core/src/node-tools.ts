import { spawn } from "node:child_process";
import { constants as fsConstants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  stat,
  type FileHandle,
} from "node:fs/promises";
import { isAbsolute, dirname, relative, resolve, sep } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parseDocument } from "yaml";
import { inspectSafeRegex } from "./safe-regex.js";
import { atomicWriteVerifiedFile, readVerifiedFile } from "./safe-files.js";
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolManifest,
  ToolRisk,
} from "./tool.js";

export type ToolStoreErrorCode =
  | "TOOL_MANIFEST_INVALID"
  | "TOOL_MANIFEST_SECRET"
  | "TOOL_MANIFEST_NOT_FOUND"
  | "TOOL_CAPABILITY_REQUIRED"
  | "TOOL_CAPABILITY_DENIED"
  | "TOOL_INPUT_INVALID"
  | "TOOL_OUTPUT_INVALID"
  | "TOOL_OUTPUT_LIMIT"
  | "TOOL_EXECUTION_TIMEOUT"
  | "TOOL_EXECUTION_FAILED"
  | "OPENAPI_DOCUMENT_INVALID"
  | "OPENAPI_VERSION_UNSUPPORTED"
  | "OPENAPI_EXTERNAL_REF_DENIED"
  | "OPENAPI_OPERATION_UNSUPPORTED";

export class ToolStoreError extends Error {
  readonly code: ToolStoreErrorCode;
  readonly toolId?: string;

  constructor(code: ToolStoreErrorCode, message: string, toolId?: string) {
    super(message);
    this.name = "ToolStoreError";
    this.code = code;
    if (toolId !== undefined) this.toolId = toolId;
  }
}

export type JsonSchema = Readonly<Record<string, unknown>>;
export type HttpMethod = "DELETE" | "GET" | "HEAD" | "PATCH" | "POST" | "PUT";

export interface HttpBodyMapping {
  readonly source: "input" | "property";
  readonly property?: string;
  readonly mediaType?: "application/json" | "text/plain";
}

export interface HttpRequestMapping {
  readonly method: HttpMethod;
  /** Absolute HTTP(S) URL. `{parameter}` placeholders are populated through `path`. */
  readonly url: string;
  readonly path?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: HttpBodyMapping;
  readonly response?: "auto" | "json" | "text";
  readonly timeoutMs?: number;
}

interface StoredToolBase {
  readonly manifestVersion: "1";
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema?: JsonSchema;
  readonly category?: string;
  readonly risk?: ToolRisk;
  readonly connectionKinds?: readonly string[];
}

export interface HttpEndpointToolManifest extends StoredToolBase {
  readonly kind: "http";
  readonly source: "custom";
  readonly request: HttpRequestMapping;
}

export interface LocalCommandToolManifest extends StoredToolBase {
  readonly kind: "local-command";
  readonly source: "custom";
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly stdin?: "none" | "json" | "text";
  readonly output?: "record" | "json" | "text";
  readonly timeoutMs?: number;
}

export interface TypeScriptModuleToolManifest extends StoredToolBase {
  readonly kind: "typescript-module";
  readonly source: "module";
  readonly module: string;
  readonly exportName?: string;
  readonly timeoutMs?: number;
}

export interface OpenApiOperationToolManifest extends StoredToolBase {
  readonly kind: "openapi-operation";
  readonly source: "custom";
  readonly document: string;
  readonly operationId: string;
  readonly request: HttpRequestMapping;
}

export type StoredToolManifest =
  | HttpEndpointToolManifest
  | LocalCommandToolManifest
  | TypeScriptModuleToolManifest
  | OpenApiOperationToolManifest;

export interface ToolStoreCatalog {
  readonly tools: readonly StoredToolManifest[];
  readonly warnings: readonly string[];
}

export interface NetworkCapabilityRequest {
  readonly toolId: string;
  readonly url: URL;
  readonly method: HttpMethod;
  readonly connectionId?: string;
}

export interface HttpCapabilityRequest extends NetworkCapabilityRequest {
  readonly request: Request;
}

export interface ProcessCapabilityRequest {
  readonly toolId: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly isolation: "os-sandbox";
  readonly connectionId?: string;
}

export interface ProcessExecutionRequest extends BoundedProcessOptions {
  readonly connectionId?: string;
}

export interface FileCapabilityRequest {
  readonly toolId: string;
  readonly operation: "read" | "write";
  readonly path: string;
}

export interface ModuleExecutionRequest {
  readonly toolId: string;
  readonly module: string;
  readonly resolvedModule: string;
  readonly exportName: string;
  readonly input: unknown;
  readonly signal: AbortSignal;
  readonly context: ToolExecutionContext;
  readonly timeoutMs: number;
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly connectionId?: string;
}

export interface WebSearchRequest {
  readonly query: string;
  readonly limit: number;
  readonly cursor?: string;
  readonly signal: AbortSignal;
  readonly context: ToolExecutionContext;
  readonly connectionId?: string;
}

export interface WebScrapeRequest {
  readonly url: string;
  readonly signal: AbortSignal;
  readonly context: ToolExecutionContext;
  readonly connectionId?: string;
}

export interface ToolHostCapabilities {
  /** Required before every HTTP request, including built-in HTTP. */
  readonly authorizeNetworkHost?: (
    request: NetworkCapabilityRequest,
  ) => boolean | Promise<boolean>;
  /** Optional transport injection for Connection-managed authentication. */
  readonly fetch?: typeof fetch;
  /** Preferred per-execution transport when credentials depend on `connectionId`. */
  readonly performHttp?: (request: HttpCapabilityRequest) => Promise<Response>;
  /** Required before every spawned process. `shell` is never enabled by this module. */
  readonly authorizeProcess?: (
    request: ProcessCapabilityRequest,
  ) => boolean | Promise<boolean>;
  /** Host process boundary. Production Node hosts execute this in the configured OS sandbox. */
  readonly executeProcess?: (
    request: ProcessExecutionRequest,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** Required before built-in file reads or writes. */
  readonly authorizeFile?: (
    request: FileCapabilityRequest,
  ) => boolean | Promise<boolean>;
  /** Required module host. Core never imports project/package code directly. */
  readonly executeModule?: (
    request: ModuleExecutionRequest,
  ) => unknown | Promise<unknown>;
  /** Required provider/connection host for the built-in Web Search manifest. */
  readonly webSearch?: (request: WebSearchRequest) => unknown | Promise<unknown>;
  readonly webScrape?: (request: WebScrapeRequest) => unknown | Promise<unknown>;
}

export interface NodeToolStoreOptions {
  readonly projectDirectory: string;
  readonly capabilities?: ToolHostCapabilities;
  readonly maxManifestBytes?: number;
  readonly maxOpenApiBytes?: number;
  readonly maxInputBytes?: number;
  readonly maxOutputBytes?: number;
  readonly maxTimeoutMs?: number;
  /** Explicit child environment. It defaults to empty rather than inheriting credentials. */
  readonly processEnvironment?: Readonly<Record<string, string>>;
  readonly codeRunners?: Readonly<Record<"node" | "python", string | undefined>>;
}

export interface OpenApiImportOptions {
  readonly operationIds?: readonly string[];
}

export interface OpenApiImportResult {
  readonly tools: readonly OpenApiOperationToolManifest[];
  readonly warnings: readonly string[];
}

export interface GenerateSchemaOptions {
  readonly title?: string;
  readonly allObjectPropertiesRequired?: boolean;
}

export interface ToolExecuteOptions {
  readonly connectionId?: string;
}

const TOOL_ID = /^[a-z][a-z0-9._-]{0,127}$/;
const CONNECTION_KIND = /^[a-z][a-z0-9._-]{0,63}$/;
const EXPORT_NAME = /^(?:default|[A-Za-z_$][A-Za-z0-9_$]*)$/;
const PACKAGE_SPECIFIER = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const INPUT_PATH = /^(?:[A-Za-z_][A-Za-z0-9_.-]*|\/(?:[^/~]|~[01])+(?:\/(?:[^/~]|~[01])+)*?)$/;
const SECRET_FIELD = /^(?:authorization|cookies?|credentials?|password|secrets?|tokens?|access[-_]?token|refresh[-_]?token|api[-_]?key|client[-_]?secret)$/i;
const SECRET_VALUE = /(?:\bbearer\s+[A-Za-z0-9._~+/=-]+|\b(?:password|secret|token|api[-_]?key)\s*[=:]\s*\S+|\bsk-[A-Za-z0-9_-]{12,}|\benv:[A-Za-z_][A-Za-z0-9_]*)/i;
const FORBIDDEN_HTTP_HEADER = /^(?::authority|host|authorization|proxy-.+|cookies?|connection|keep-alive|te|trailer|transfer-encoding|upgrade|content-length)$/i;
const METHODS = new Set<HttpMethod>(["DELETE", "GET", "HEAD", "PATCH", "POST", "PUT"]);
const RISKS = new Set<ToolRisk>(["read", "write", "external", "destructive"]);
const BASE_KEYS = [
  "manifestVersion",
  "id",
  "label",
  "description",
  "inputSchema",
  "outputSchema",
  "category",
  "risk",
  "connectionKinds",
  "kind",
  "source",
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isMissing = (error: unknown): boolean =>
  error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";

const isInside = (root: string, target: string): boolean => {
  const path = relative(root, target);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

async function createContainedDirectory(root: string, target: string): Promise<string> {
  if (!isInside(root, target)) throw new ToolStoreError("TOOL_MANIFEST_INVALID", "Tool store path escapes the project");
  let current = root;
  for (const segment of relative(root, target).split(sep).filter(Boolean)) {
    const next = resolve(current, segment);
    try {
      const info = await lstat(next);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new ToolStoreError("TOOL_MANIFEST_INVALID", `Tool store directory '${segment}' is unsafe`);
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
      await mkdir(next, { mode: 0o700 });
    }
    current = await realpath(next);
    if (!isInside(root, current)) throw new ToolStoreError("TOOL_MANIFEST_INVALID", "Tool store directory escapes the project");
  }
  return current;
}

const boundedInteger = (value: number | undefined, fallback: number, maximum: number): number =>
  Math.min(Math.max(1, Math.floor(value ?? fallback)), maximum);

const serializedBytes = (value: unknown): number => {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    throw new ToolStoreError("TOOL_OUTPUT_INVALID", "Tool value is not JSON serializable");
  }
};

function assertAllowedKeys(record: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allow = new Set(allowed);
  const unknown = Object.keys(record).find((key) => !allow.has(key));
  if (unknown !== undefined) {
    throw new ToolStoreError("TOOL_MANIFEST_INVALID", `${path} contains unsupported field '${unknown}'`);
  }
}

function boundedString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new ToolStoreError("TOOL_MANIFEST_INVALID", `Tool '${field}' must be a non-empty string no longer than ${maximum} characters`);
  }
  return value;
}

function optionalString(value: unknown, field: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  return boundedString(value, field, maximum);
}

function timeoutValue(value: unknown, field = "timeoutMs"): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 300_000) {
    throw new ToolStoreError("TOOL_MANIFEST_INVALID", `Tool '${field}' must be an integer from 1 to 300000`);
  }
  return value;
}

function assertNoSecretValue(value: unknown, path = "$", seen = new WeakSet<object>()): void {
  if (typeof value === "string") {
    if (SECRET_VALUE.test(value)) {
      throw new ToolStoreError("TOOL_MANIFEST_SECRET", `Tool manifest contains a secret-like value at ${path}`);
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) throw new ToolStoreError("TOOL_MANIFEST_INVALID", "Tool manifest must not contain cycles");
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecretValue(entry, `${path}[${index}]`, seen));
  } else {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_FIELD.test(key)) {
        throw new ToolStoreError("TOOL_MANIFEST_SECRET", `Tool manifest cannot store credential field '${key}' at ${path}`);
      }
      assertNoSecretValue(entry, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function assertSchemaSecrets(schema: JsonSchema, path: string): void {
  const visit = (value: unknown, location: string, seen: WeakSet<object>): void => {
    if (value === null || typeof value !== "object") {
      if (typeof value === "string" && SECRET_VALUE.test(value)) {
        throw new ToolStoreError("TOOL_MANIFEST_SECRET", `JSON Schema contains a secret-like literal at ${location}`);
      }
      return;
    }
    if (seen.has(value)) throw new ToolStoreError("TOOL_MANIFEST_INVALID", "JSON Schema must not contain cycles");
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${location}[${index}]`, seen));
    } else {
      const record = value as Record<string, unknown>;
      if (typeof record.pattern === "string" && inspectSafeRegex(record.pattern)) throw new ToolStoreError(
        "TOOL_MANIFEST_INVALID", `JSON Schema contains an unsafe regular expression at ${location}.pattern`,
      );
      if (isRecord(record.patternProperties)
        && Object.keys(record.patternProperties).some((pattern) => inspectSafeRegex(pattern))) throw new ToolStoreError(
        "TOOL_MANIFEST_INVALID", `JSON Schema contains an unsafe patternProperties expression at ${location}`,
      );
      if (isRecord(record.properties)) {
        const credential = Object.keys(record.properties).find((name) => SECRET_FIELD.test(name));
        if (credential !== undefined) {
          throw new ToolStoreError(
            "TOOL_MANIFEST_SECRET",
            `Tool schemas must use a Connection instead of credential input '${credential}' at ${location}`,
          );
        }
      }
      for (const [key, entry] of Object.entries(record)) visit(entry, `${location}.${key}`, seen);
    }
    seen.delete(value);
  };
  visit(schema, path, new WeakSet<object>());
}

function validateSchema(value: unknown, field: string): JsonSchema {
  if (!isRecord(value)) {
    throw new ToolStoreError("TOOL_MANIFEST_INVALID", `Tool '${field}' must be a JSON Schema object`);
  }
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  if (!ajv.validateSchema(value)) {
    throw new ToolStoreError(
      "TOOL_MANIFEST_INVALID",
      `Tool '${field}' is invalid: ${ajv.errorsText(ajv.errors)}`,
    );
  }
  assertSchemaSecrets(value, `$.${field}`);
  return value;
}

function mapping(value: unknown, field: string, headerNames = false): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.keys(value).length > 64) {
    throw new ToolStoreError("TOOL_MANIFEST_INVALID", `Tool request '${field}' must be a bounded mapping`);
  }
  const selected = Object.create(null) as Record<string, string>;
  for (const [name, source] of Object.entries(value)) {
    if (name.length === 0 || name.length > 128 || typeof source !== "string" || !INPUT_PATH.test(source)) {
      throw new ToolStoreError("TOOL_MANIFEST_INVALID", `Tool request '${field}.${name}' is invalid`);
    }
    const normalizedHeader = name.replaceAll(/[^a-z0-9]/gi, "").toLocaleLowerCase();
    if (headerNames && (SECRET_FIELD.test(name) || FORBIDDEN_HTTP_HEADER.test(name)
      || normalizedHeader.includes("auth") || normalizedHeader.includes("token")
      || normalizedHeader.includes("cookie") || normalizedHeader.includes("apikey")
      || normalizedHeader.includes("secret"))) {
      throw new ToolStoreError(
        "TOOL_MANIFEST_SECRET",
        `HTTP credential, routing, or hop-by-hop header '${name}' cannot be model-controlled`,
      );
    }
    selected[name] = source;
  }
  return selected;
}

function assertHttpUrl(template: string, pathMapping: Readonly<Record<string, string>> | undefined): void {
  const placeholders = [...template.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1] ?? "");
  if (placeholders.some((name) => name.length === 0 || pathMapping?.[name] === undefined)
    || Object.keys(pathMapping ?? {}).some((name) => !placeholders.includes(name))) {
    throw new ToolStoreError("TOOL_MANIFEST_INVALID", "HTTP URL placeholders and path mappings must match exactly");
  }
  const candidate = template.replace(/\{[^{}]+\}/g, "placeholder");
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new ToolStoreError("TOOL_MANIFEST_INVALID", "HTTP tool URL must be absolute");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.hash) {
    throw new ToolStoreError(
      "TOOL_MANIFEST_INVALID",
      "HTTP tool URL must use HTTP(S) without embedded credentials or fragments",
    );
  }
  for (const [name, value] of url.searchParams) {
    if (SECRET_FIELD.test(name) || SECRET_VALUE.test(value)) {
      throw new ToolStoreError(
        "TOOL_MANIFEST_SECRET",
        "HTTP credentials must be supplied by a Connection-aware fetch capability",
      );
    }
  }
}

function parseHttpRequest(value: unknown): HttpRequestMapping {
  if (!isRecord(value)) throw new ToolStoreError("TOOL_MANIFEST_INVALID", "HTTP tool requires a request object");
  assertAllowedKeys(value, ["method", "url", "path", "query", "headers", "body", "response", "timeoutMs"], "request");
  const method = typeof value.method === "string" ? value.method.toLocaleUpperCase() as HttpMethod : undefined;
  if (method === undefined || !METHODS.has(method)) {
    throw new ToolStoreError("TOOL_MANIFEST_INVALID", "HTTP request method is invalid");
  }
  const url = boundedString(value.url, "request.url", 4_096);
  const path = mapping(value.path, "path");
  const query = mapping(value.query, "query");
  const headers = mapping(value.headers, "headers", true);
  let body: HttpBodyMapping | undefined;
  if (value.body !== undefined) {
    if (!isRecord(value.body)) throw new ToolStoreError("TOOL_MANIFEST_INVALID", "HTTP request body mapping is invalid");
    assertAllowedKeys(value.body, ["source", "property", "mediaType"], "request.body");
    if (value.body.source !== "input" && value.body.source !== "property") {
      throw new ToolStoreError("TOOL_MANIFEST_INVALID", "HTTP request body source is invalid");
    }
    const property = optionalString(value.body.property, "request.body.property", 512);
    if (value.body.source === "property" && (property === undefined || !INPUT_PATH.test(property))) {
      throw new ToolStoreError("TOOL_MANIFEST_INVALID", "HTTP property body requires a valid input path");
    }
    if (value.body.source === "input" && property !== undefined) {
      throw new ToolStoreError("TOOL_MANIFEST_INVALID", "HTTP input body must not declare a property path");
    }
    if (value.body.mediaType !== undefined
      && value.body.mediaType !== "application/json" && value.body.mediaType !== "text/plain") {
      throw new ToolStoreError("TOOL_MANIFEST_INVALID", "HTTP request body media type is unsupported");
    }
    body = {
      source: value.body.source,
      ...(property === undefined ? {} : { property }),
      ...(value.body.mediaType === undefined ? {} : { mediaType: value.body.mediaType }),
    };
  }
  if (value.response !== undefined && value.response !== "auto" && value.response !== "json" && value.response !== "text") {
    throw new ToolStoreError("TOOL_MANIFEST_INVALID", "HTTP response mode is invalid");
  }
  const timeoutMs = timeoutValue(value.timeoutMs, "request.timeoutMs");
  assertHttpUrl(url, path);
  return {
    method,
    url,
    ...(path === undefined ? {} : { path }),
    ...(query === undefined ? {} : { query }),
    ...(headers === undefined ? {} : { headers }),
    ...(body === undefined ? {} : { body }),
    ...(value.response === undefined ? {} : { response: value.response }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

function baseManifest(record: Record<string, unknown>): StoredToolBase {
  if (record.manifestVersion !== "1") {
    throw new ToolStoreError("TOOL_MANIFEST_INVALID", "Tool manifestVersion must be '1'");
  }
  const id = boundedString(record.id, "id", 128);
  if (!TOOL_ID.test(id)) throw new ToolStoreError("TOOL_MANIFEST_INVALID", `Tool id '${id}' is invalid`, id);
  const label = boundedString(record.label, "label", 128);
  const description = boundedString(record.description, "description", 2_048);
  const inputSchema = validateSchema(record.inputSchema, "inputSchema");
  const outputSchema = record.outputSchema === undefined ? undefined : validateSchema(record.outputSchema, "outputSchema");
  const category = optionalString(record.category, "category", 128);
  const risk = record.risk;
  if (risk !== undefined && (typeof risk !== "string" || !RISKS.has(risk as ToolRisk))) {
    throw new ToolStoreError("TOOL_MANIFEST_INVALID", "Tool risk is invalid", id);
  }
  let connectionKinds: readonly string[] | undefined;
  if (record.connectionKinds !== undefined) {
    if (!Array.isArray(record.connectionKinds) || record.connectionKinds.length > 16
      || !record.connectionKinds.every((entry) => typeof entry === "string" && CONNECTION_KIND.test(entry))) {
      throw new ToolStoreError("TOOL_MANIFEST_INVALID", "Tool connectionKinds are invalid", id);
    }
    connectionKinds = [...new Set(record.connectionKinds as string[])];
  }
  return {
    manifestVersion: "1",
    id,
    label,
    description,
    inputSchema,
    ...(outputSchema === undefined ? {} : { outputSchema }),
    ...(category === undefined ? {} : { category }),
    ...(risk === undefined ? {} : { risk: risk as ToolRisk }),
    ...(connectionKinds === undefined ? {} : { connectionKinds }),
  };
}

export function validateStoredToolManifest(value: unknown): StoredToolManifest {
  if (!isRecord(value)) throw new ToolStoreError("TOOL_MANIFEST_INVALID", "Tool manifest must be a JSON object");
  assertNoSecretValue(value);
  const base = baseManifest(value);
  if (value.kind === "http") {
    assertAllowedKeys(value, [...BASE_KEYS, "request"], "manifest");
    if (value.source !== "custom") throw new ToolStoreError("TOOL_MANIFEST_INVALID", "HTTP tool source must be 'custom'", base.id);
    const request = parseHttpRequest(value.request);
    return {
      ...base,
      risk: request.method === "DELETE" || base.risk === "destructive" ? "destructive" : "external",
      kind: "http",
      source: "custom",
      request,
    };
  }
  if (value.kind === "openapi-operation") {
    assertAllowedKeys(value, [...BASE_KEYS, "document", "operationId", "request"], "manifest");
    if (value.source !== "custom") {
      throw new ToolStoreError("TOOL_MANIFEST_INVALID", "OpenAPI tool source must be 'custom'", base.id);
    }
    const document = boundedString(value.document, "document", 1_024);
    if (isAbsolute(document) || document.includes("\0")) {
      throw new ToolStoreError("TOOL_MANIFEST_INVALID", "OpenAPI document path must be project-relative", base.id);
    }
    const request = parseHttpRequest(value.request);
    return {
      ...base,
      risk: request.method === "DELETE" || base.risk === "destructive" ? "destructive" : "external",
      kind: "openapi-operation",
      source: "custom",
      document,
      operationId: boundedString(value.operationId, "operationId", 256),
      request,
    };
  }
  if (value.kind === "local-command") {
    assertAllowedKeys(value, [...BASE_KEYS, "command", "args", "cwd", "stdin", "output", "timeoutMs"], "manifest");
    if (value.source !== "custom") {
      throw new ToolStoreError("TOOL_MANIFEST_INVALID", "Local command source must be 'custom'", base.id);
    }
    const command = boundedString(value.command, "command", 1_024);
    let args: readonly string[] | undefined;
    if (value.args !== undefined) {
      if (!Array.isArray(value.args) || value.args.length > 64
        || !value.args.every((entry) => typeof entry === "string" && entry.length <= 4_096)) {
        throw new ToolStoreError("TOOL_MANIFEST_INVALID", "Local command args must be bounded strings", base.id);
      }
      args = value.args as string[];
    }
    const cwd = optionalString(value.cwd, "cwd", 1_024);
    if (cwd !== undefined && (isAbsolute(cwd) || cwd.includes("\0"))) {
      throw new ToolStoreError("TOOL_MANIFEST_INVALID", "Local command cwd must be project-relative", base.id);
    }
    if (value.stdin !== undefined && value.stdin !== "none" && value.stdin !== "json" && value.stdin !== "text") {
      throw new ToolStoreError("TOOL_MANIFEST_INVALID", "Local command stdin mode is invalid", base.id);
    }
    if (value.output !== undefined && value.output !== "record" && value.output !== "json" && value.output !== "text") {
      throw new ToolStoreError("TOOL_MANIFEST_INVALID", "Local command output mode is invalid", base.id);
    }
    const timeoutMs = timeoutValue(value.timeoutMs);
    return {
      ...base,
      risk: "destructive",
      kind: "local-command",
      source: "custom",
      command,
      ...(args === undefined ? {} : { args }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(value.stdin === undefined ? {} : { stdin: value.stdin }),
      ...(value.output === undefined ? {} : { output: value.output }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    };
  }
  if (value.kind === "typescript-module") {
    assertAllowedKeys(value, [...BASE_KEYS, "module", "exportName", "timeoutMs"], "manifest");
    if (value.source !== "module") {
      throw new ToolStoreError("TOOL_MANIFEST_INVALID", "TypeScript module source must be 'module'", base.id);
    }
    const module = boundedString(value.module, "module", 1_024);
    if (isAbsolute(module) || (!module.startsWith("./") && !module.startsWith(".\\") && !PACKAGE_SPECIFIER.test(module))) {
      throw new ToolStoreError(
        "TOOL_MANIFEST_INVALID",
        "TypeScript module must be a package or project-relative specifier",
        base.id,
      );
    }
    const exportName = optionalString(value.exportName, "exportName", 128);
    if (exportName !== undefined && !EXPORT_NAME.test(exportName)) {
      throw new ToolStoreError("TOOL_MANIFEST_INVALID", "TypeScript module exportName is invalid", base.id);
    }
    const timeoutMs = timeoutValue(value.timeoutMs);
    return {
      ...base,
      risk: "destructive",
      kind: "typescript-module",
      source: "module",
      module,
      ...(exportName === undefined ? {} : { exportName }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    };
  }
  throw new ToolStoreError("TOOL_MANIFEST_INVALID", "Tool kind is unsupported");
}

function generatedSchema(
  value: unknown,
  required: boolean,
  state: { nodes: number; readonly seen: WeakSet<object> },
): Record<string, unknown> {
  state.nodes += 1;
  if (state.nodes > 2_048) throw new ToolStoreError("TOOL_MANIFEST_INVALID", "Schema example is too complex");
  if (value === null) return { type: "null" };
  if (typeof value === "string") return { type: "string", example: value };
  if (typeof value === "boolean") return { type: "boolean", example: value };
  if (typeof value === "number" && Number.isFinite(value)) {
    return { type: Number.isInteger(value) ? "integer" : "number", example: value };
  }
  if (Array.isArray(value)) {
    if (state.seen.has(value)) throw new ToolStoreError("TOOL_MANIFEST_INVALID", "Schema example contains a cycle");
    state.seen.add(value);
    const itemSchemas = value.map((entry) => generatedSchema(entry, required, state));
    state.seen.delete(value);
    const unique = new Map(itemSchemas.map((schema) => [JSON.stringify(schema), schema]));
    return {
      type: "array",
      items: unique.size === 0
        ? {}
        : unique.size === 1
          ? [...unique.values()][0]
          : { anyOf: [...unique.values()] },
    };
  }
  if (isRecord(value)) {
    if (state.seen.has(value)) throw new ToolStoreError("TOOL_MANIFEST_INVALID", "Schema example contains a cycle");
    state.seen.add(value);
    const properties = Object.create(null) as Record<string, unknown>;
    for (const [key, entry] of Object.entries(value)) {
      if (SECRET_FIELD.test(key)) {
        throw new ToolStoreError(
          "TOOL_MANIFEST_SECRET",
          `Generated tool schema cannot contain credential field '${key}'`,
        );
      }
      properties[key] = generatedSchema(entry, required, state);
    }
    state.seen.delete(value);
    const keys = Object.keys(properties);
    return {
      type: "object",
      properties,
      ...(required && keys.length > 0 ? { required: keys } : {}),
      additionalProperties: false,
    };
  }
  throw new ToolStoreError("TOOL_MANIFEST_INVALID", `Cannot generate JSON Schema for ${typeof value}`);
}

/** Returns a plain mutable schema so Studio can edit it before saving the manifest. */
export function generateEditableSchema(
  example: unknown,
  options: GenerateSchemaOptions = {},
): Record<string, unknown> {
  const schema = generatedSchema(
    example,
    options.allObjectPropertiesRequired !== false,
    { nodes: 0, seen: new WeakSet<object>() },
  );
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...(options.title === undefined ? {} : { title: options.title }),
    ...schema,
  };
}

function manifestView(manifest: StoredToolManifest): ToolManifest {
  return {
    id: manifest.id,
    label: manifest.label,
    description: manifest.description,
    inputSchema: manifest.inputSchema,
    ...(manifest.outputSchema === undefined ? {} : { outputSchema: manifest.outputSchema }),
    ...(manifest.category === undefined ? {} : { category: manifest.category }),
    ...(manifest.risk === undefined ? {} : { risk: manifest.risk }),
    source: manifest.source,
    ...(manifest.connectionKinds === undefined ? {} : { connectionKinds: manifest.connectionKinds }),
  };
}

const BUILTIN_INPUTS = {
  webSearch: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1 },
      limit: { type: "integer", minimum: 1, maximum: 20, default: 5 },
      cursor: { type: "string", minLength: 1, maxLength: 4_096 },
    },
    required: ["query"],
    additionalProperties: false,
  },
  webScrape: {
    type: "object",
    properties: { url: { type: "string", minLength: 1, maxLength: 8_192 } },
    required: ["url"],
    additionalProperties: false,
  },
  http: {
    type: "object",
    properties: {
      url: { type: "string", minLength: 1 },
      method: { type: "string", enum: [...METHODS], default: "GET" },
      query: { type: "object", additionalProperties: { type: ["string", "number", "boolean"] } },
      body: {},
    },
    required: ["url"],
    additionalProperties: false,
  },
  file: {
    type: "object",
    properties: {
      operation: { type: "string", enum: ["read", "write"] },
      path: { type: "string", minLength: 1 },
      content: { type: "string" },
    },
    required: ["operation", "path"],
    additionalProperties: false,
  },
  shell: {
    type: "object",
    properties: {
      command: { type: "string", minLength: 1 },
      args: { type: "array", items: { type: "string" }, maxItems: 64, default: [] },
      stdin: { type: "string" },
    },
    required: ["command"],
    additionalProperties: false,
  },
  code: {
    type: "object",
    properties: {
      runtime: { type: "string", enum: ["node", "python"], default: "node" },
      code: { type: "string", minLength: 1 },
    },
    required: ["runtime", "code"],
    additionalProperties: false,
  },
} as const;

export const BUILTIN_TOOL_MANIFESTS = Object.freeze([
  {
    id: "builtin.web-search",
    label: "Web Search",
    description: "Search through a host-approved provider connection.",
    inputSchema: BUILTIN_INPUTS.webSearch,
    category: "Web",
    risk: "external",
    source: "builtin",
    connectionKinds: ["tool-service"],
  },
  {
    id: "builtin.web-scrape",
    label: "Web Scrape",
    description: "Extract one public page through a host-approved Tool Service Connection.",
    inputSchema: BUILTIN_INPUTS.webScrape,
    category: "Web",
    risk: "external",
    source: "builtin",
    connectionKinds: ["tool-service"],
  },
  {
    id: "builtin.http",
    label: "HTTP Request",
    description: "Send an HTTP request after explicit host approval; credentials come from the host connection.",
    inputSchema: BUILTIN_INPUTS.http,
    category: "Web",
    risk: "external",
    source: "builtin",
    connectionKinds: ["http-api"],
  },
  {
    id: "builtin.file",
    label: "File",
    description: "Read or write a project-contained file after explicit file capability approval.",
    inputSchema: BUILTIN_INPUTS.file,
    category: "Local",
    risk: "write",
    source: "builtin",
    connectionKinds: ["local-runtime"],
  },
  {
    id: "builtin.shell",
    label: "Shell",
    description: "Run a host-approved executable without a shell inside an approved no-network container.",
    inputSchema: BUILTIN_INPUTS.shell,
    category: "Local",
    risk: "destructive",
    source: "builtin",
    connectionKinds: ["local-runtime"],
  },
  {
    id: "builtin.code-runner",
    label: "Code Runner",
    description: "Run Node.js or Python code inside an approved no-network container.",
    inputSchema: BUILTIN_INPUTS.code,
    category: "Local",
    risk: "destructive",
    source: "builtin",
    connectionKinds: ["local-runtime"],
  },
] satisfies readonly ToolManifest[]);

function inputAt(input: unknown, path: string): unknown {
  if (!path.startsWith("/")) return isRecord(input) ? input[path] : undefined;
  let current = input;
  for (const raw of path.slice(1).split("/")) {
    const token = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current) && /^\d+$/.test(token)) current = current[Number(token)];
    else if (isRecord(current)) current = current[token];
    else return undefined;
  }
  return current;
}

function requestScalar(value: unknown, field: string): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  throw new ToolStoreError("TOOL_INPUT_INVALID", `HTTP mapping '${field}' requires a string, number, or boolean`);
}

function interpolateArgument(template: string, input: unknown): string {
  return template.replace(/\{\{([^{}]+)\}\}/g, (_match, path: string) =>
    requestScalar(inputAt(input, path), path));
}

const PROCESS_TERMINATE_GRACE_MS = 100;
const PROCESS_CLOSE_DEADLINE_MS = 1_000;

function mergeSignals(parent: AbortSignal, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason);
  if (parent.aborted) abort();
  else parent.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new ToolStoreError("TOOL_EXECUTION_TIMEOUT", `Tool execution exceeded ${timeoutMs} ms`));
  }, timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent.removeEventListener("abort", abort);
    },
  };
}

export interface BoundedProcessOptions {
  readonly toolId: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdin: string;
  readonly timeoutMs: number;
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly signal: AbortSignal;
  readonly environment?: Readonly<Record<string, string>>;
}

export async function runBoundedProcess(options: BoundedProcessOptions): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  if (Buffer.byteLength(options.stdin, "utf8") > options.maxInputBytes) throw new ToolStoreError(
    "TOOL_INPUT_INVALID", `Process stdin exceeds ${options.maxInputBytes} bytes`, options.toolId,
  );
  const deadline = mergeSignals(options.signal, options.timeoutMs);
  try {
    if (deadline.signal.aborted) throw deadline.signal.reason;
    return await new Promise((resolvePromise, rejectPromise) => {
      let settled = false;
      let total = 0;
      let terminalError: unknown;
      let terminating = false;
      let forceKillTimer: NodeJS.Timeout | undefined;
      let closeDeadlineTimer: NodeJS.Timeout | undefined;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const finish = (error?: unknown, result?: { stdout: string; stderr: string; exitCode: number }) => {
        if (settled) return;
        settled = true;
        if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
        if (closeDeadlineTimer !== undefined) clearTimeout(closeDeadlineTimer);
        deadline.signal.removeEventListener("abort", aborted);
        if (error !== undefined) rejectPromise(error);
        else if (result !== undefined) resolvePromise(result);
      };
      const child = spawn(options.command, [...options.args], {
        cwd: options.cwd,
        env: { ...(options.environment ?? {}) },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const terminate = (error: unknown) => {
        if (terminalError === undefined) terminalError = error;
        if (terminating || settled) return;
        terminating = true;
        try { child.kill("SIGTERM"); } catch { /* close deadline still settles the caller */ }
        forceKillTimer = setTimeout(() => {
          if (settled) return;
          try { child.kill("SIGKILL"); } catch { /* close deadline still settles the caller */ }
        }, PROCESS_TERMINATE_GRACE_MS);
        closeDeadlineTimer = setTimeout(() => {
          if (settled) return;
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          finish(terminalError);
        }, PROCESS_TERMINATE_GRACE_MS + PROCESS_CLOSE_DEADLINE_MS);
      };
      const aborted = () => terminate(deadline.signal.reason);
      deadline.signal.addEventListener("abort", aborted, { once: true });
      const collect = (target: Buffer[], chunk: Buffer) => {
        if (terminalError !== undefined) return;
        total += chunk.byteLength;
        if (total > options.maxOutputBytes) terminate(new ToolStoreError(
          "TOOL_OUTPUT_LIMIT", `Process output exceeds ${options.maxOutputBytes} bytes`, options.toolId,
        ));
        else target.push(Buffer.from(chunk));
      };
      child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
      child.on("error", (error) => finish(terminalError ?? new ToolStoreError(
        "TOOL_EXECUTION_FAILED", `Process failed: ${error.message}`, options.toolId,
      )));
      child.on("close", (code) => {
        if (terminalError !== undefined) return finish(terminalError);
        if (code !== 0) return finish(new ToolStoreError(
          "TOOL_EXECUTION_FAILED", `Process exited with code ${code ?? "unknown"}`, options.toolId,
        ));
        finish(undefined, {
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          exitCode: 0,
        });
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(options.stdin);
      if (deadline.signal.aborted) aborted();
    });
  } finally {
    deadline.cleanup();
  }
}

async function signalRace<T>(value: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const aborted = () => rejectPromise(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    void value.then(
      (result) => {
        signal.removeEventListener("abort", aborted);
        resolvePromise(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", aborted);
        rejectPromise(error);
      },
    );
  });
}

async function responseBytes(response: Response, maximum: number): Promise<Buffer> {
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new ToolStoreError("TOOL_OUTPUT_LIMIT", `HTTP response exceeds the ${maximum}-byte limit`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

interface OpenApiState {
  nodes: number;
  readonly stack: Set<string>;
}

function jsonPointer(root: unknown, reference: string): unknown {
  let current = root;
  for (const raw of reference.slice(2).split("/")) {
    const token = decodeURIComponent(raw).replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isRecord(current) && !Array.isArray(current)) {
      throw new ToolStoreError("OPENAPI_DOCUMENT_INVALID", `OpenAPI reference '${reference}' does not resolve`);
    }
    current = (current as Record<string, unknown>)[token];
    if (current === undefined) {
      throw new ToolStoreError("OPENAPI_DOCUMENT_INVALID", `OpenAPI reference '${reference}' does not resolve`);
    }
  }
  return current;
}

function resolvedOpenApiNode(root: unknown, value: unknown, state: OpenApiState): unknown {
  state.nodes += 1;
  if (state.nodes > 16_384) throw new ToolStoreError("OPENAPI_DOCUMENT_INVALID", "OpenAPI reference graph is too large");
  if (Array.isArray(value)) return value.map((entry) => resolvedOpenApiNode(root, entry, state));
  if (!isRecord(value)) return value;
  if (typeof value.$ref === "string") {
    if (!value.$ref.startsWith("#/")) {
      throw new ToolStoreError("OPENAPI_EXTERNAL_REF_DENIED", `External OpenAPI reference '${value.$ref}' is denied`);
    }
    if (state.stack.has(value.$ref)) {
      throw new ToolStoreError("OPENAPI_DOCUMENT_INVALID", `Recursive OpenAPI reference '${value.$ref}' is unsupported`);
    }
    state.stack.add(value.$ref);
    const target = resolvedOpenApiNode(root, jsonPointer(root, value.$ref), state);
    state.stack.delete(value.$ref);
    const siblings = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "$ref"));
    if (Object.keys(siblings).length === 0) return target;
    if (!isRecord(target)) throw new ToolStoreError("OPENAPI_DOCUMENT_INVALID", `OpenAPI reference '${value.$ref}' is not an object`);
    return {
      ...target,
      ...resolvedOpenApiNode(root, siblings, state) as Record<string, unknown>,
    };
  }
  const selected = Object.create(null) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(value)) selected[key] = resolvedOpenApiNode(root, entry, state);
  return selected;
}

function assertNoExternalRefs(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) assertNoExternalRefs(entry, seen);
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === "$ref" && typeof entry === "string" && !entry.startsWith("#/")) {
      throw new ToolStoreError("OPENAPI_EXTERNAL_REF_DENIED", `External OpenAPI reference '${entry}' is denied by default`);
    }
    assertNoExternalRefs(entry, seen);
  }
}

function openApiRecord(root: unknown, value: unknown): Record<string, unknown> {
  const resolved = resolvedOpenApiNode(root, value, { nodes: 0, stack: new Set<string>() });
  if (!isRecord(resolved)) throw new ToolStoreError("OPENAPI_DOCUMENT_INVALID", "OpenAPI object is invalid");
  return resolved;
}

function serverUrl(document: Record<string, unknown>, path: Record<string, unknown>, operation: Record<string, unknown>): string {
  const sources = [operation.servers, path.servers, document.servers];
  const servers = sources.find((candidate) => Array.isArray(candidate)) as unknown[] | undefined;
  const selected = servers?.[0];
  if (!isRecord(selected) || typeof selected.url !== "string") {
    throw new ToolStoreError("OPENAPI_OPERATION_UNSUPPORTED", "OpenAPI operation requires an absolute server URL");
  }
  let url = selected.url;
  const variables = isRecord(selected.variables) ? selected.variables : {};
  url = url.replace(/\{([^{}]+)\}/g, (_match, name: string) => {
    const variable = variables[name];
    if (!isRecord(variable) || typeof variable.default !== "string") {
      throw new ToolStoreError("OPENAPI_OPERATION_UNSUPPORTED", `OpenAPI server variable '${name}' has no default`);
    }
    return variable.default;
  });
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ToolStoreError("OPENAPI_OPERATION_UNSUPPORTED", "OpenAPI server URL must be absolute");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new ToolStoreError("OPENAPI_OPERATION_UNSUPPORTED", "OpenAPI server URL is unsafe");
  }
  return parsed.href.replace(/\/$/, "");
}

const pointerToken = (value: string): string => value.replaceAll("~", "~0").replaceAll("/", "~1");

interface ParameterGroups {
  readonly schemas: Record<"path" | "query" | "headers", Record<string, unknown>>;
  readonly required: Record<"path" | "query" | "headers", string[]>;
  readonly mappings: Record<"path" | "query" | "headers", Record<string, string>>;
}

function openApiParameters(
  root: Record<string, unknown>,
  path: Record<string, unknown>,
  operation: Record<string, unknown>,
): ParameterGroups {
  const combined = [
    ...(Array.isArray(path.parameters) ? path.parameters : []),
    ...(Array.isArray(operation.parameters) ? operation.parameters : []),
  ];
  const selected = new Map<string, Record<string, unknown>>();
  for (const entry of combined) {
    const parameter = openApiRecord(root, entry);
    if (typeof parameter.name !== "string" || typeof parameter.in !== "string") continue;
    selected.set(`${parameter.in}:${parameter.name}`, parameter);
  }
  const groups: ParameterGroups = {
    schemas: { path: Object.create(null), query: Object.create(null), headers: Object.create(null) },
    required: { path: [], query: [], headers: [] },
    mappings: { path: Object.create(null), query: Object.create(null), headers: Object.create(null) },
  };
  for (const parameter of selected.values()) {
    const location = parameter.in === "header" ? "headers" : parameter.in;
    if (location === "cookie") {
      throw new ToolStoreError("OPENAPI_OPERATION_UNSUPPORTED", "OpenAPI cookie parameters require a Connection and are not imported as inputs");
    }
    if (location !== "path" && location !== "query" && location !== "headers") continue;
    const name = parameter.name as string;
    if (location === "headers" && SECRET_FIELD.test(name)) {
      throw new ToolStoreError("OPENAPI_OPERATION_UNSUPPORTED", `Credential header '${name}' must be supplied by a Connection`);
    }
    const schema = parameter.schema === undefined ? { type: "string" } : resolvedOpenApiNode(
      root,
      parameter.schema,
      { nodes: 0, stack: new Set<string>() },
    );
    if (!isRecord(schema)) throw new ToolStoreError("OPENAPI_DOCUMENT_INVALID", `Parameter '${name}' schema is invalid`);
    groups.schemas[location][name] = schema;
    groups.mappings[location][name] = `/${location}/${pointerToken(name)}`;
    if (parameter.required === true || location === "path") groups.required[location].push(name);
  }
  return groups;
}

function requestBodySchema(
  root: Record<string, unknown>,
  operation: Record<string, unknown>,
): { schema: Record<string, unknown>; required: boolean; mediaType: "application/json" | "text/plain" } | undefined {
  if (operation.requestBody === undefined) return undefined;
  const requestBody = openApiRecord(root, operation.requestBody);
  const content = isRecord(requestBody.content) ? requestBody.content : undefined;
  if (!content) throw new ToolStoreError("OPENAPI_OPERATION_UNSUPPORTED", "OpenAPI requestBody has no content map");
  const jsonType = Object.keys(content).find((key) => key === "application/json" || key.endsWith("+json"));
  const mediaType = jsonType ?? (Object.hasOwn(content, "text/plain") ? "text/plain" : undefined);
  if (mediaType === undefined) {
    throw new ToolStoreError("OPENAPI_OPERATION_UNSUPPORTED", "Only JSON and text OpenAPI request bodies are supported");
  }
  const media = content[mediaType];
  if (!isRecord(media) || !isRecord(media.schema)) {
    throw new ToolStoreError("OPENAPI_OPERATION_UNSUPPORTED", "OpenAPI request body requires a schema");
  }
  const schema = resolvedOpenApiNode(root, media.schema, { nodes: 0, stack: new Set<string>() });
  if (!isRecord(schema)) throw new ToolStoreError("OPENAPI_DOCUMENT_INVALID", "OpenAPI request body schema is invalid");
  return {
    schema,
    required: requestBody.required === true,
    mediaType: mediaType === "text/plain" ? "text/plain" : "application/json",
  };
}

function responseSchema(root: Record<string, unknown>, operation: Record<string, unknown>): JsonSchema | undefined {
  if (!isRecord(operation.responses)) return undefined;
  const key = Object.keys(operation.responses)
    .filter((candidate) => /^(?:2\d\d|default)$/.test(candidate))
    .sort((left, right) => left === "default" ? 1 : right === "default" ? -1 : left.localeCompare(right))[0];
  if (key === undefined) return undefined;
  const response = openApiRecord(root, operation.responses[key]);
  if (!isRecord(response.content)) return undefined;
  const mediaType = Object.keys(response.content).find((candidate) => candidate === "application/json" || candidate.endsWith("+json"));
  if (mediaType === undefined) return undefined;
  const media = response.content[mediaType];
  if (!isRecord(media) || !isRecord(media.schema)) return undefined;
  const schema = resolvedOpenApiNode(root, media.schema, { nodes: 0, stack: new Set<string>() });
  return isRecord(schema) ? schema : undefined;
}

function toolIdForOperation(operationId: string, occupied: Set<string>): string {
  const slug = operationId.toLocaleLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z]+/, "").slice(0, 100);
  const base = `openapi.${slug || "operation"}`;
  let candidate = base;
  let suffix = 2;
  while (occupied.has(candidate)) {
    candidate = `${base.slice(0, 120)}-${suffix}`;
    suffix += 1;
  }
  occupied.add(candidate);
  return candidate;
}

export class NodeToolStore {
  readonly #options: NodeToolStoreOptions;
  readonly #root: Promise<string>;

  constructor(options: NodeToolStoreOptions) {
    this.#options = options;
    this.#root = realpath(resolve(options.projectDirectory));
  }

  async save(manifest: StoredToolManifest): Promise<StoredToolManifest> {
    const validated = validateStoredToolManifest(manifest);
    const serialized = `${JSON.stringify(validated, null, 2)}\n`;
    const maximum = boundedInteger(this.#options.maxManifestBytes, 1_048_576, 4_194_304);
    if (Buffer.byteLength(serialized, "utf8") > maximum) {
      throw new ToolStoreError("TOOL_MANIFEST_INVALID", `Tool manifest exceeds ${maximum} bytes`, validated.id);
    }
    const directory = await this.#storeDirectory(true);
    const file = resolve(directory, `${validated.id}.json`);
    if (!isInside(directory, file)) throw new ToolStoreError("TOOL_MANIFEST_INVALID", "Tool manifest path is invalid", validated.id);
    await atomicWriteVerifiedFile(file, directory, serialized);
    return validated;
  }

  async get(id: string): Promise<StoredToolManifest> {
    if (!TOOL_ID.test(id)) throw new ToolStoreError("TOOL_MANIFEST_NOT_FOUND", `Tool '${id}' is invalid`, id);
    const directory = await this.#storeDirectory(false);
    if (directory === undefined) throw new ToolStoreError("TOOL_MANIFEST_NOT_FOUND", `Tool '${id}' is not installed`, id);
    const file = resolve(directory, `${id}.json`);
    let info;
    try {
      info = await lstat(file);
    } catch (error) {
      if (isMissing(error)) throw new ToolStoreError("TOOL_MANIFEST_NOT_FOUND", `Tool '${id}' is not installed`, id);
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new ToolStoreError("TOOL_MANIFEST_INVALID", `Tool '${id}' manifest must be a regular file`, id);
    }
    const maximum = boundedInteger(this.#options.maxManifestBytes, 1_048_576, 4_194_304);
    if (info.size > maximum) throw new ToolStoreError("TOOL_MANIFEST_INVALID", `Tool '${id}' manifest exceeds ${maximum} bytes`, id);
    try {
      const candidate = JSON.parse((await readVerifiedFile(file, directory, maximum)).toString("utf8")) as unknown;
      if (isRecord(candidate) && candidate.deleted === true) throw new ToolStoreError(
        "TOOL_MANIFEST_NOT_FOUND", `Tool '${id}' is not installed`, id,
      );
      return validateStoredToolManifest(candidate);
    } catch (error) {
      if (error instanceof ToolStoreError) throw error;
      throw new ToolStoreError(
        "TOOL_MANIFEST_INVALID",
        `Tool '${id}' manifest is invalid JSON: ${error instanceof Error ? error.message : "unknown error"}`,
        id,
      );
    }
  }

  async catalog(): Promise<ToolStoreCatalog> {
    const directory = await this.#storeDirectory(false);
    if (directory === undefined) return { tools: [], warnings: [] };
    const warnings: string[] = [];
    const tools: StoredToolManifest[] = [];
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries.slice(0, 512)) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) continue;
      const id = entry.name.slice(0, -5);
      try {
        const tool = await this.get(id);
        if (tool.id !== id) throw new ToolStoreError("TOOL_MANIFEST_INVALID", "Manifest id must match its filename", id);
        tools.push(tool);
      } catch (error) {
        if (!(error instanceof ToolStoreError && error.code === "TOOL_MANIFEST_NOT_FOUND")) {
          warnings.push(`Ignoring tool manifest '${entry.name}': ${error instanceof Error ? error.message : "invalid manifest"}`);
        }
      }
    }
    return { tools, warnings };
  }

  async delete(id: string): Promise<void> {
    if (!TOOL_ID.test(id)) throw new ToolStoreError("TOOL_MANIFEST_NOT_FOUND", `Tool '${id}' is invalid`, id);
    const directory = await this.#storeDirectory(false);
    if (directory === undefined) return;
    const file = resolve(directory, `${id}.json`);
    if (!isInside(directory, file)) throw new ToolStoreError("TOOL_MANIFEST_INVALID", "Tool manifest path is invalid", id);
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new ToolStoreError("TOOL_MANIFEST_INVALID", `Tool '${id}' manifest is not a regular file`, id);
      }
      await atomicWriteVerifiedFile(file, directory, '{"deleted":true}\n');
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  definition(manifest: StoredToolManifest): ToolDefinition {
    const selected = validateStoredToolManifest(manifest);
    return {
      ...manifestView(selected),
      execute: (input, context) => this.execute(selected, input, context),
    };
  }

  async definitions(): Promise<readonly ToolDefinition[]> {
    const catalog = await this.catalog();
    return catalog.tools.map((manifest) => this.definition(manifest));
  }

  builtinDefinitions(): readonly ToolDefinition[] {
    return BUILTIN_TOOL_MANIFESTS.map((manifest) => ({
      ...manifest,
      execute: (input, context) => this.executeBuiltin(manifest.id, input, context),
    }));
  }

  async executeBuiltin(
    id: string,
    input: unknown,
    context: ToolExecutionContext,
    options: ToolExecuteOptions = {},
  ): Promise<unknown> {
    return this.#executeBuiltin(id, input, context, options);
  }

  async execute(
    manifest: StoredToolManifest,
    input: unknown,
    context: ToolExecutionContext,
    options: ToolExecuteOptions = {},
  ): Promise<unknown> {
    const selected = validateStoredToolManifest(manifest);
    this.#validateInput(selected, input);
    let output: unknown;
    if (selected.kind === "http" || selected.kind === "openapi-operation") {
      output = await this.#executeHttp(selected.id, selected.request, input, context, options);
    } else if (selected.kind === "local-command") {
      output = await this.#executeLocalCommand(selected, input, context, options);
    } else {
      output = await this.#executeModule(selected, input, context, options);
    }
    this.#validateOutput(selected, output);
    return output;
  }

  async importOpenApi(documentPath: string, options: OpenApiImportOptions = {}): Promise<OpenApiImportResult> {
    const root = await this.#root;
    if (documentPath.length === 0 || documentPath.length > 1_024 || isAbsolute(documentPath) || documentPath.includes("\0")) {
      throw new ToolStoreError("OPENAPI_DOCUMENT_INVALID", "OpenAPI document path must be project-relative");
    }
    const lexical = resolve(root, documentPath);
    let canonical: string;
    try {
      canonical = await realpath(lexical);
    } catch (error) {
      throw new ToolStoreError(
        "OPENAPI_DOCUMENT_INVALID",
        `Cannot read OpenAPI document: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
    if (!isInside(root, canonical) || (await lstat(lexical)).isSymbolicLink()) {
      throw new ToolStoreError("OPENAPI_DOCUMENT_INVALID", "OpenAPI document must be a contained regular file");
    }
    const info = await stat(canonical);
    const maximum = boundedInteger(this.#options.maxOpenApiBytes, 2_097_152, 16_777_216);
    if (!info.isFile() || info.size > maximum) {
      throw new ToolStoreError("OPENAPI_DOCUMENT_INVALID", `OpenAPI document exceeds ${maximum} bytes or is not a file`);
    }
    const source = await readFile(canonical, "utf8");
    const parsed = parseDocument(source, { schema: "core", uniqueKeys: true });
    if (parsed.errors.length > 0) {
      throw new ToolStoreError(
        "OPENAPI_DOCUMENT_INVALID",
        `OpenAPI document is invalid: ${parsed.errors[0]?.message ?? "YAML error"}`,
      );
    }
    let value: unknown;
    try {
      value = parsed.toJS({ maxAliasCount: 0 }) as unknown;
    } catch (error) {
      throw new ToolStoreError(
        "OPENAPI_DOCUMENT_INVALID",
        `OpenAPI document is unsafe: ${error instanceof Error ? error.message : "invalid YAML"}`,
      );
    }
    if (!isRecord(value) || typeof value.openapi !== "string") {
      throw new ToolStoreError("OPENAPI_DOCUMENT_INVALID", "OpenAPI document requires an openapi version");
    }
    if (!/^3\.(?:0|1)\.\d+(?:[-+].*)?$/.test(value.openapi)) {
      throw new ToolStoreError(
        "OPENAPI_VERSION_UNSUPPORTED",
        `OpenAPI '${value.openapi}' is unsupported; import supports 3.0.x and 3.1.x`,
      );
    }
    assertNoExternalRefs(value);
    if (!isRecord(value.paths)) throw new ToolStoreError("OPENAPI_DOCUMENT_INVALID", "OpenAPI document requires paths");
    const selectedIds = options.operationIds === undefined ? undefined : new Set(options.operationIds);
    const seenOperationIds = new Set<string>();
    const occupiedToolIds = new Set<string>();
    const tools: OpenApiOperationToolManifest[] = [];
    const warnings: string[] = [];
    const relativeDocument = relative(root, canonical).split(sep).join("/");
    const methods = ["get", "post", "put", "patch", "delete", "head"] as const;
    for (const [route, rawPath] of Object.entries(value.paths)) {
      if (!isRecord(rawPath)) continue;
      const path = openApiRecord(value, rawPath);
      for (const method of methods) {
        if (!isRecord(path[method])) continue;
        const operation = openApiRecord(value, path[method]);
        const operationId = typeof operation.operationId === "string" && operation.operationId.length > 0
          ? operation.operationId
          : `${method}-${route}`;
        seenOperationIds.add(operationId);
        if (selectedIds !== undefined && !selectedIds.has(operationId)) continue;
        try {
          const groups = openApiParameters(value, path, operation);
          const body = requestBodySchema(value, operation);
          const properties = Object.create(null) as Record<string, unknown>;
          const required: string[] = [];
          for (const group of ["path", "query", "headers"] as const) {
            const names = Object.keys(groups.schemas[group]);
            if (names.length === 0) continue;
            properties[group] = {
              type: "object",
              properties: groups.schemas[group],
              ...(groups.required[group].length === 0 ? {} : { required: groups.required[group] }),
              additionalProperties: false,
            };
            if (groups.required[group].length > 0) required.push(group);
          }
          if (body !== undefined) {
            properties.body = body.schema;
            if (body.required) required.push("body");
          }
          const security = operation.security ?? value.security;
          const connectionKinds = Array.isArray(security) && security.length > 0 ? ["http-api"] : undefined;
          const request: HttpRequestMapping = {
            method: method.toLocaleUpperCase() as HttpMethod,
            url: `${serverUrl(value, path, operation)}${route.startsWith("/") ? route : `/${route}`}`,
            ...(Object.keys(groups.mappings.path).length === 0 ? {} : { path: groups.mappings.path }),
            ...(Object.keys(groups.mappings.query).length === 0 ? {} : { query: groups.mappings.query }),
            ...(Object.keys(groups.mappings.headers).length === 0 ? {} : { headers: groups.mappings.headers }),
            ...(body === undefined
              ? {}
              : { body: { source: "property", property: "/body", mediaType: body.mediaType } as const }),
            response: "auto",
          };
          const manifest = validateStoredToolManifest({
            manifestVersion: "1",
            id: toolIdForOperation(operationId, occupiedToolIds),
            label: typeof operation.summary === "string" ? operation.summary : operationId,
            description: typeof operation.description === "string"
              ? operation.description
              : `Imported ${method.toLocaleUpperCase()} ${route}`,
            category: "OpenAPI",
            risk: method === "delete" ? "destructive" : method === "get" || method === "head" ? "external" : "write",
            source: "custom",
            ...(connectionKinds === undefined ? {} : { connectionKinds }),
            kind: "openapi-operation",
            document: relativeDocument,
            operationId,
            inputSchema: {
              $schema: "https://json-schema.org/draft/2020-12/schema",
              type: "object",
              properties,
              ...(required.length === 0 ? {} : { required }),
              additionalProperties: false,
            },
            ...(responseSchema(value, operation) === undefined
              ? {}
              : { outputSchema: responseSchema(value, operation) }),
            request,
          });
          if (manifest.kind !== "openapi-operation") throw new Error("OpenAPI manifest normalization failed");
          tools.push(manifest);
        } catch (error) {
          warnings.push(
            `Skipping OpenAPI operation '${operationId}': ${error instanceof Error ? error.message : "unsupported operation"}`,
          );
        }
      }
    }
    for (const requested of selectedIds ?? []) {
      if (!seenOperationIds.has(requested)) warnings.push(`OpenAPI operation '${requested}' was not found`);
    }
    return { tools, warnings };
  }

  async #storeDirectory(create: true): Promise<string>;
  async #storeDirectory(create: false): Promise<string | undefined>;
  async #storeDirectory(create: boolean): Promise<string | undefined> {
    const root = await this.#root;
    const directory = resolve(root, ".harnest", "tools");
    if (create) return createContainedDirectory(root, directory);
    let canonical: string;
    try {
      canonical = await realpath(directory);
    } catch (error) {
      if (!create && isMissing(error)) return undefined;
      throw error;
    }
    if (!isInside(root, canonical)) {
      throw new ToolStoreError("TOOL_MANIFEST_INVALID", "Tool store resolves outside the project");
    }
    return canonical;
  }

  #timeout(configured?: number): number {
    return Math.min(configured ?? 30_000, boundedInteger(this.#options.maxTimeoutMs, 30_000, 300_000));
  }

  #maxInput(): number {
    return boundedInteger(this.#options.maxInputBytes, 1_048_576, 16_777_216);
  }

  #maxOutput(): number {
    return boundedInteger(this.#options.maxOutputBytes, 1_048_576, 16_777_216);
  }

  #validateInput(manifest: ToolManifest, input: unknown): void {
    if (serializedBytes(input) > this.#maxInput()) {
      throw new ToolStoreError("TOOL_INPUT_INVALID", `Tool input exceeds ${this.#maxInput()} bytes`, manifest.id);
    }
    const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
    const validate = ajv.compile(manifest.inputSchema);
    if (!validate(input)) {
      throw new ToolStoreError("TOOL_INPUT_INVALID", `Tool input is invalid: ${ajv.errorsText(validate.errors)}`, manifest.id);
    }
  }

  #validateOutput(manifest: ToolManifest, output: unknown): void {
    if (serializedBytes(output) > this.#maxOutput()) {
      throw new ToolStoreError("TOOL_OUTPUT_LIMIT", `Tool output exceeds ${this.#maxOutput()} bytes`, manifest.id);
    }
    if (manifest.outputSchema === undefined) return;
    const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
    const validate = ajv.compile(manifest.outputSchema);
    if (!validate(output)) {
      throw new ToolStoreError("TOOL_OUTPUT_INVALID", `Tool output is invalid: ${ajv.errorsText(validate.errors)}`, manifest.id);
    }
  }

  async #executeHttp(
    toolId: string,
    request: HttpRequestMapping,
    input: unknown,
    context: ToolExecutionContext,
    options: ToolExecuteOptions = {},
  ): Promise<unknown> {
    const capabilities = this.#options.capabilities;
    if (capabilities?.authorizeNetworkHost === undefined) {
      throw new ToolStoreError("TOOL_CAPABILITY_REQUIRED", "HTTP tools require a network host capability callback", toolId);
    }
    let urlText = request.url;
    for (const [name, source] of Object.entries(request.path ?? {})) {
      urlText = urlText.replaceAll(`{${name}}`, encodeURIComponent(requestScalar(inputAt(input, source), source)));
    }
    const url = new URL(urlText);
    for (const [name, source] of Object.entries(request.query ?? {})) {
      const value = inputAt(input, source);
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) value.forEach((entry) => url.searchParams.append(name, requestScalar(entry, source)));
      else url.searchParams.append(name, requestScalar(value, source));
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.hash) {
      throw new ToolStoreError(
        "TOOL_INPUT_INVALID",
        "HTTP URL must use HTTP(S) without embedded credentials or fragments",
        toolId,
      );
    }
    for (const [name, value] of url.searchParams) {
      if (SECRET_FIELD.test(name) || SECRET_VALUE.test(value)) {
        throw new ToolStoreError(
          "TOOL_INPUT_INVALID",
          "HTTP credentials must come from a Connection-aware fetch capability",
          toolId,
        );
      }
    }
    const capabilityRequest: NetworkCapabilityRequest = {
      toolId,
      url,
      method: request.method,
      ...(options.connectionId === undefined ? {} : { connectionId: options.connectionId }),
    };
    const allowed = await capabilities.authorizeNetworkHost(capabilityRequest);
    if (!allowed) throw new ToolStoreError("TOOL_CAPABILITY_DENIED", `HTTP host '${url.host}' was not approved`, toolId);
    const headers = new Headers();
    for (const [name, source] of Object.entries(request.headers ?? {})) {
      if (FORBIDDEN_HTTP_HEADER.test(name)) {
        throw new ToolStoreError("TOOL_MANIFEST_SECRET", `HTTP header '${name}' cannot be model-controlled`, toolId);
      }
      const value = inputAt(input, source);
      if (value !== undefined && value !== null) headers.set(name, requestScalar(value, source));
    }
    let body: string | undefined;
    if (request.body !== undefined) {
      const value = request.body.source === "input" ? input : inputAt(input, request.body.property ?? "");
      const mediaType = request.body.mediaType ?? "application/json";
      if (mediaType === "text/plain") {
        if (typeof value !== "string") throw new ToolStoreError("TOOL_INPUT_INVALID", "HTTP text body must be a string", toolId);
        body = value;
      } else {
        body = JSON.stringify(value);
      }
      headers.set("content-type", mediaType);
    }
    const deadline = mergeSignals(context.signal, this.#timeout(request.timeoutMs));
    try {
      const requestInit: RequestInit = {
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: deadline.signal,
        redirect: "error",
      };
      const response = capabilities.performHttp === undefined
        ? await (capabilities.fetch ?? fetch)(url, requestInit)
        : await capabilities.performHttp({
            ...capabilityRequest,
            request: new Request(url, requestInit),
          });
      if (!response.ok) {
        throw new ToolStoreError("TOOL_EXECUTION_FAILED", `HTTP tool returned status ${response.status}`, toolId);
      }
      const content = await responseBytes(response, this.#maxOutput());
      const mode = request.response ?? "auto";
      const json = mode === "json" || (mode === "auto" && /(?:application\/json|\+json)(?:;|$)/i.test(response.headers.get("content-type") ?? ""));
      if (!json) return content.toString("utf8");
      if (content.byteLength === 0) return null;
      try {
        return JSON.parse(content.toString("utf8")) as unknown;
      } catch {
        throw new ToolStoreError("TOOL_OUTPUT_INVALID", "HTTP tool returned invalid JSON", toolId);
      }
    } catch (error) {
      if (deadline.signal.aborted) throw deadline.signal.reason;
      if (error instanceof ToolStoreError) throw error;
      throw new ToolStoreError(
        "TOOL_EXECUTION_FAILED",
        `HTTP tool failed: ${error instanceof Error ? error.message : "unknown error"}`,
        toolId,
      );
    } finally {
      deadline.cleanup();
    }
  }

  async #executeLocalCommand(
    manifest: LocalCommandToolManifest,
    input: unknown,
    context: ToolExecutionContext,
    options: ToolExecuteOptions,
  ): Promise<unknown> {
    const root = await this.#root;
    const cwd = manifest.cwd === undefined ? root : await this.#containedExistingPath(manifest.cwd, true);
    const args = (manifest.args ?? []).map((argument) => interpolateArgument(argument, input));
    const stdin = manifest.stdin === "none"
      ? ""
      : manifest.stdin === "text"
        ? typeof input === "string" ? input : String(input)
        : JSON.stringify(input);
    const result = await this.#runProcess(
      manifest.id,
      manifest.command,
      args,
      cwd,
      stdin,
      this.#timeout(manifest.timeoutMs),
      context.signal,
      options,
    );
    if (manifest.output === "text") return result.stdout;
    if (manifest.output === "json") {
      try {
        return JSON.parse(result.stdout) as unknown;
      } catch {
        throw new ToolStoreError("TOOL_OUTPUT_INVALID", "Local command returned invalid JSON", manifest.id);
      }
    }
    return result;
  }

  async #executeModule(
    manifest: TypeScriptModuleToolManifest,
    input: unknown,
    context: ToolExecutionContext,
    options: ToolExecuteOptions,
  ): Promise<unknown> {
    const executeModule = this.#options.capabilities?.executeModule;
    if (executeModule === undefined) {
      throw new ToolStoreError("TOOL_CAPABILITY_REQUIRED", "TypeScript tools require a module execution capability callback", manifest.id);
    }
    const resolvedModule = PACKAGE_SPECIFIER.test(manifest.module)
      ? manifest.module
      : await this.#containedExistingPath(manifest.module, false);
    const deadline = mergeSignals(context.signal, this.#timeout(manifest.timeoutMs));
    try {
      return await signalRace(Promise.resolve(executeModule({
        toolId: manifest.id,
        module: manifest.module,
        resolvedModule,
        exportName: manifest.exportName ?? "default",
        input,
        signal: deadline.signal,
        context,
        timeoutMs: this.#timeout(manifest.timeoutMs),
        maxInputBytes: this.#maxInput(),
        maxOutputBytes: this.#maxOutput(),
        ...(options.connectionId === undefined ? {} : { connectionId: options.connectionId }),
      })), deadline.signal);
    } catch (error) {
      if (deadline.signal.aborted) throw deadline.signal.reason;
      if (error instanceof ToolStoreError) throw error;
      throw new ToolStoreError(
        "TOOL_EXECUTION_FAILED",
        `TypeScript module tool failed: ${error instanceof Error ? error.message : "unknown error"}`,
        manifest.id,
      );
    } finally {
      deadline.cleanup();
    }
  }

  async #executeBuiltin(
    id: string,
    input: unknown,
    context: ToolExecutionContext,
    options: ToolExecuteOptions,
  ): Promise<unknown> {
    const manifest = BUILTIN_TOOL_MANIFESTS.find((candidate) => candidate.id === id);
    if (!manifest) throw new ToolStoreError("TOOL_MANIFEST_NOT_FOUND", `Built-in tool '${id}' is not registered`, id);
    this.#validateInput(manifest, input);
    if (!isRecord(input)) throw new ToolStoreError("TOOL_INPUT_INVALID", "Built-in tool input must be an object", id);
    let output: unknown;
    if (id === "builtin.web-search") {
      const webSearch = this.#options.capabilities?.webSearch;
      if (webSearch === undefined) {
        throw new ToolStoreError("TOOL_CAPABILITY_REQUIRED", "Web Search requires a provider capability callback", id);
      }
      const deadline = mergeSignals(context.signal, this.#timeout());
      try {
        output = await signalRace(Promise.resolve(webSearch({
          query: input.query as string,
          limit: typeof input.limit === "number" ? input.limit : 5,
          ...(typeof input.cursor === "string" ? { cursor: input.cursor } : {}),
          signal: deadline.signal,
          context,
          ...(options.connectionId === undefined ? {} : { connectionId: options.connectionId }),
        })), deadline.signal);
      } finally {
        deadline.cleanup();
      }
    } else if (id === "builtin.web-scrape") {
      const webScrape = this.#options.capabilities?.webScrape;
      if (webScrape === undefined) throw new ToolStoreError(
        "TOOL_CAPABILITY_REQUIRED", "Web Scrape requires a Tool Service capability callback", id,
      );
      const deadline = mergeSignals(context.signal, this.#timeout());
      try {
        output = await signalRace(Promise.resolve(webScrape({
          url: input.url as string,
          signal: deadline.signal,
          context,
          ...(options.connectionId === undefined ? {} : { connectionId: options.connectionId }),
        })), deadline.signal);
      } finally {
        deadline.cleanup();
      }
    } else if (id === "builtin.http") {
      const method = typeof input.method === "string" ? input.method.toLocaleUpperCase() as HttpMethod : "GET";
      const query = isRecord(input.query)
        ? Object.fromEntries(Object.keys(input.query).map((name) => [name, `/query/${pointerToken(name)}`]))
        : undefined;
      output = await this.#executeHttp(id, {
        method,
        url: input.url as string,
        ...(query === undefined ? {} : { query }),
        ...(input.body === undefined ? {} : { body: { source: "property", property: "/body" } as const }),
        response: "auto",
      }, input, context, options);
    } else if (id === "builtin.file") {
      output = await this.#executeFile(input, context);
    } else if (id === "builtin.shell") {
      const root = await this.#root;
      output = await this.#runProcess(
        id,
        input.command as string,
        Array.isArray(input.args) ? input.args as string[] : [],
        root,
        typeof input.stdin === "string" ? input.stdin : "",
        this.#timeout(),
        context.signal,
        options,
      );
    } else {
      const runtime = input.runtime as "node" | "python";
      const command = options.connectionId === undefined
        ? runtime === "node" ? this.#options.codeRunners?.node ?? process.execPath : this.#options.codeRunners?.python
        : runtime;
      if (command === undefined) {
        throw new ToolStoreError("TOOL_CAPABILITY_REQUIRED", `Code runner '${runtime}' is not configured`, id);
      }
      const root = await this.#root;
      output = await this.#runProcess(id, command, ["-"], root, input.code as string, this.#timeout(), context.signal, options);
    }
    this.#validateOutput(manifest, output);
    return output;
  }

  async #executeFile(input: Record<string, unknown>, context: ToolExecutionContext): Promise<unknown> {
    const operation = input.operation as "read" | "write";
    const path = input.path as string;
    const authorizeFile = this.#options.capabilities?.authorizeFile;
    if (authorizeFile === undefined) {
      throw new ToolStoreError("TOOL_CAPABILITY_REQUIRED", "File tool requires a file capability callback", "builtin.file");
    }
    if (typeof input.content !== "string") {
      if (operation === "write") throw new ToolStoreError(
        "TOOL_INPUT_INVALID", "File write requires string content", "builtin.file",
      );
    }
    if (operation === "write" && Buffer.byteLength(input.content as string, "utf8") > this.#maxInput()) {
      throw new ToolStoreError("TOOL_INPUT_INVALID", `File content exceeds ${this.#maxInput()} bytes`, "builtin.file");
    }
    const opened = await this.#openContainedFile(path, operation);
    try {
      if (!await authorizeFile({ toolId: "builtin.file", operation, path: opened.path })) {
        throw new ToolStoreError("TOOL_CAPABILITY_DENIED", `File '${path}' was not approved`, "builtin.file");
      }
      if (context.signal.aborted) throw context.signal.reason;
      await this.#assertOpenFileIdentity(opened.handle, opened.path);
      const info = await opened.handle.stat();
      if (operation === "read") {
        if (info.size > this.#maxOutput()) throw new ToolStoreError(
          "TOOL_OUTPUT_LIMIT", `File exceeds ${this.#maxOutput()} bytes`, "builtin.file",
        );
        return opened.handle.readFile({ encoding: "utf8" });
      }
      await opened.handle.truncate(0);
      await opened.handle.writeFile(input.content as string, { encoding: "utf8" });
      await opened.handle.sync();
      return {
        path: relative(await this.#root, opened.path).split(sep).join("/"),
        bytes: Buffer.byteLength(input.content as string, "utf8"),
      };
    } finally {
      await opened.handle.close();
    }
  }

  async #openContainedFile(configured: string, operation: "read" | "write"): Promise<{
    readonly handle: FileHandle;
    readonly path: string;
  }> {
    if (configured.length === 0 || configured.length > 1_024 || isAbsolute(configured) || configured.includes("\0")) {
      throw new ToolStoreError("TOOL_CAPABILITY_DENIED", "Project path must be a bounded relative path");
    }
    const root = await this.#root;
    const lexical = resolve(root, configured);
    if (!isInside(root, lexical)) throw new ToolStoreError(
      "TOOL_CAPABILITY_DENIED", `Project path '${configured}' is outside the project`,
    );
    const parent = await realpath(dirname(lexical));
    if (!isInside(root, parent)) throw new ToolStoreError(
      "TOOL_CAPABILITY_DENIED", `Project path '${configured}' has an unsafe parent`,
    );
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    const flags = operation === "read"
      ? fsConstants.O_RDONLY | noFollow
      : fsConstants.O_RDWR | fsConstants.O_CREAT | noFollow;
    let handle: FileHandle;
    try {
      handle = await open(lexical, flags, 0o600);
    } catch (error) {
      if (isMissing(error)) throw new ToolStoreError(
        "TOOL_CAPABILITY_DENIED", `Project path '${configured}' does not exist`,
      );
      throw error;
    }
    try {
      const canonical = await realpath(lexical);
      if (!isInside(root, canonical) || (await lstat(lexical)).isSymbolicLink()) throw new ToolStoreError(
        "TOOL_CAPABILITY_DENIED", `Project path '${configured}' resolves outside the project`,
      );
      await this.#assertOpenFileIdentity(handle, canonical);
      return { handle, path: canonical };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async #assertOpenFileIdentity(handle: FileHandle, path: string): Promise<void> {
    const [opened, current] = await Promise.all([handle.stat(), stat(path)]);
    if (!opened.isFile() || !current.isFile() || !this.#sameFile(opened, current)) throw new ToolStoreError(
      "TOOL_CAPABILITY_DENIED", "Project file changed while it was being authorized", "builtin.file",
    );
  }

  #sameFile(left: Stats, right: Stats): boolean {
    return left.ino !== 0 && left.ino === right.ino && (process.platform === "win32" || left.dev === right.dev);
  }

  async #runProcess(
    toolId: string,
    command: string,
    args: readonly string[],
    cwd: string,
    stdin: string,
    timeoutMs: number,
    parentSignal: AbortSignal,
    options: ToolExecuteOptions,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (Buffer.byteLength(stdin, "utf8") > this.#maxInput()) {
      throw new ToolStoreError("TOOL_INPUT_INVALID", `Process stdin exceeds ${this.#maxInput()} bytes`, toolId);
    }
    const authorizeProcess = this.#options.capabilities?.authorizeProcess;
    if (authorizeProcess === undefined) {
      throw new ToolStoreError("TOOL_CAPABILITY_REQUIRED", "Process tools require a process capability callback", toolId);
    }
    const approved = await authorizeProcess({
      toolId,
      command,
      args,
      cwd,
      isolation: "os-sandbox",
      ...(options.connectionId === undefined ? {} : { connectionId: options.connectionId }),
    });
    if (!approved) throw new ToolStoreError("TOOL_CAPABILITY_DENIED", `Process '${command}' was not approved`, toolId);
    const request: ProcessExecutionRequest = {
      toolId,
      command,
      args,
      cwd,
      stdin,
      timeoutMs,
      maxInputBytes: this.#maxInput(),
      maxOutputBytes: this.#maxOutput(),
      signal: parentSignal,
      ...(this.#options.processEnvironment ? { environment: this.#options.processEnvironment } : {}),
      ...(options.connectionId === undefined ? {} : { connectionId: options.connectionId }),
    };
    return this.#options.capabilities?.executeProcess
      ? this.#options.capabilities.executeProcess(request)
      : runBoundedProcess(request);
  }

  async #containedExistingPath(configured: string, directoryOnly: boolean): Promise<string> {
    if (configured.length === 0 || configured.length > 1_024 || isAbsolute(configured) || configured.includes("\0")) {
      throw new ToolStoreError("TOOL_CAPABILITY_DENIED", "Project path must be a bounded relative path");
    }
    const root = await this.#root;
    const lexical = resolve(root, configured);
    if (!isInside(root, lexical)) {
      throw new ToolStoreError("TOOL_CAPABILITY_DENIED", `Project path '${configured}' is outside the project`);
    }
    let target: string;
    try {
      target = await realpath(lexical);
    } catch (error) {
      if (isMissing(error)) {
        throw new ToolStoreError("TOOL_CAPABILITY_DENIED", `Project path '${configured}' does not exist`);
      }
      throw error;
    }
    if (!isInside(root, target) || (await lstat(lexical)).isSymbolicLink()) {
      throw new ToolStoreError("TOOL_CAPABILITY_DENIED", `Project path '${configured}' resolves outside the project`);
    }
    const info = await stat(target);
    if (directoryOnly && !info.isDirectory()) throw new ToolStoreError("TOOL_CAPABILITY_DENIED", `Project path '${configured}' is not a directory`);
    if (!directoryOnly && !info.isFile()) throw new ToolStoreError("TOOL_CAPABILITY_DENIED", `Project path '${configured}' is not a file`);
    return target;
  }

}
