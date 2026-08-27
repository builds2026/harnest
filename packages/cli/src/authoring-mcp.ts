import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { hostHeaderValidation, originValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import {
  BUILTIN_COMPONENT_MANIFESTS,
  HarnessSpecSchema,
  describeHarness,
  parseSpec,
  validateSpec,
  type Diagnostic,
  type HarnessSpec,
} from "@harnestai/core";
import {
  BUILTIN_TOOL_MANIFESTS,
  loadHarnestProjectSpec,
  projectEnvironmentReferences,
  resolveHarnessFile,
} from "@harnestai/core/node";
import { createAuthoringToolRegistry, createShippedAdapterRegistry } from "./registries.js";

const MAX_YAML_BYTES = 1_048_576;
const MAX_HTTP_BODY_BYTES = 2 * 1_048_576;
const SERVER_VERSION = (createRequire(import.meta.url)("../package.json") as { version: string }).version;
const URI_ROOT = "harnest://docs/";
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const ENV_REFERENCE = /^env:[A-Za-z_][A-Za-z0-9_]*$/;
const PROVIDER_KEY = /\b(?:sk-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{30,}|(?:AKIA|ASIA)[A-Z0-9]{16}|gh[opusr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|(?:sk|rk)_live_[A-Za-z0-9]{16,}|(?:hf|gsk|npm)_[A-Za-z0-9]{20,}|pypi-[A-Za-z0-9_-]{40,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{32,})\b/g;
const BEARER_CREDENTIAL = /\bbearer\s+([A-Za-z0-9._~+/=-]{16,})\b/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const PRIVATE_KEY_BLOCK = /-----BEGIN ((?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY)-----[\s\S]{16,}?-----END \1-----/g;
const CREDENTIALED_URL = /\bhttps?:\/\/[^\s/:?#]+:[^\s/@?#]+@[^\s/]+/gi;
const CREDENTIAL_ASSIGNMENT = /\b(?:password|passphrase|client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|secret|token)\s*[:=]\s*["']?([A-Za-z0-9._~+/=@%!-]{16,})/giu;
const authoringAdapters = createShippedAdapterRegistry();

interface DocumentResource {
  readonly name: string;
  readonly uri: string;
  readonly title: string;
  readonly description: string;
  readonly mimeType: "text/markdown" | "application/schema+json";
  readonly read: () => Promise<string>;
}

const document = (
  name: string,
  title: string,
  description: string,
  file: string,
): DocumentResource => ({
  name,
  uri: `${URI_ROOT}${name}`,
  title,
  description,
  mimeType: "text/markdown",
  read: () => readFile(fileURLToPath(new URL(`../mcp-docs/${file}`, import.meta.url)), "utf8"),
});

const portsTable = (ports: Readonly<Record<string, { type: string; required?: boolean; variadic?: boolean; maxConnections?: number }>>): string => {
  const rows = Object.entries(ports);
  if (!rows.length) return "_None_";
  return [
    "| Port | Type | Required | Cardinality |",
    "|---|---|---:|---|",
    ...rows.map(([name, port]) => `| \`${name}\` | \`${port.type}\` | ${port.required ? "yes" : "no"} | ${port.variadic ? "many" : port.maxConnections ?? 1} |`),
  ].join("\n");
};

const componentCatalog = (): string => [
  "# Built-in component catalog",
  "",
  "This catalog is generated from the exact runtime manifests. Unknown config keys are rejected unless the shown JSON Schema allows them.",
  ...BUILTIN_COMPONENT_MANIFESTS.flatMap((component) => [
    "",
    `## \`${component.type}\` — ${component.label}`,
    "",
    `Category: **${component.category}**${component.description ? ` · ${component.description}` : ""}`,
    "",
    "### Inputs",
    "",
    portsTable(component.ports.inputs),
    "",
    "### Outputs",
    "",
    portsTable(component.ports.outputs),
    "",
    "### Config JSON Schema",
    "",
    "```json",
    JSON.stringify(component.configSchema, null, 2),
    "```",
    "",
    "### Default config",
    "",
    "```json",
    JSON.stringify(component.defaultConfig, null, 2),
    "```",
  ]),
].join("\n");

const toolCatalog = (): string => [
  "# Built-in Tool catalog",
  "",
  "Tools run only through host capabilities and compatible Connections. Risk and Connection requirements below are authoritative.",
  ...BUILTIN_TOOL_MANIFESTS.flatMap((tool) => [
    "",
    `## \`${tool.id}\` — ${tool.label}`,
    "",
    tool.description,
    "",
    `- Category: ${tool.category ?? "General"}`,
    `- Risk: \`${tool.risk ?? "external"}\``,
    `- Compatible Connection kinds: ${tool.connectionKinds?.map((kind) => `\`${kind}\``).join(", ") || "none"}`,
    "- Input schema:",
    "",
    "```json",
    JSON.stringify(tool.inputSchema, null, 2),
    "```",
  ]),
].join("\n");

const harnessSchema = (): string => JSON.stringify({
  ...z.toJSONSchema(HarnessSpecSchema, { target: "draft-2020-12", unrepresentable: "any" }),
  $id: "harnest://schema/harness-spec.json",
}, null, 2);

export const AUTHORING_RESOURCES: readonly DocumentResource[] = [
  document("index", "Harnest authoring index", "Start here: workflow and documentation map.", "README.md"),
  document("quickstart", "Harnest authoring quickstart", "Shortest safe path from a requirement to a validated project.", "quickstart.md"),
  document("harness-spec", "HarnessSpec v0.3", "Top-level schema, compatibility, and authoring rules.", "harnessspec-v0.3.md"),
  document("graphs-runtime", "Graphs and runtime", "Ports, edges, branching, state, subgraphs, Loop, Team, budgets, retry, and trace.", "graph-runtime.md"),
  document("tools-connections-skills", "Tools, MCP, Connections, and Skills", "Tool/Connection/Skill architecture, MCP client modes, and capability safety.", "tools-mcp-skills-connections.md"),
  document("context-memory-pkm", "Context, Memory, PKM, and providers", "Host provider ownership, context assembly, caching, provenance, and citations.", "context-memory-pkm-providers.md"),
  document("interactions-permissions", "Human interaction and permissions", "Six interaction kinds, pause/resume, and four permission lifetimes.", "interactions-permissions.md"),
  document("tests-evaluation", "Tests and evaluation", "Assertions, evaluator components, experiments, and validation gates.", "tests-evaluation.md"),
  document("project-security", "Project layout, secrets, and security", "Portable assets, bindings, secret handoff, sandboxing, and safe authoring rules.", "project-assets-secrets-security.md"),
  document("integration", "Integration guide", "Studio, CLI, SDK, HTTP runtime, Claude Code, Codex, and ChatGPT MCP setup.", "integration.md"),
  document("recipes", "Harness recipes", "Validated design patterns for common agent harnesses.", "recipes.md"),
  document("diagnostics", "Validation diagnostics", "How to interpret and repair structured HarnessSpec diagnostics.", "diagnostics.md"),
  {
    name: "components",
    uri: `${URI_ROOT}components`,
    title: "Built-in component catalog",
    description: "Exact ports, config schemas, and defaults generated from the runtime.",
    mimeType: "text/markdown",
    read: async () => componentCatalog(),
  },
  {
    name: "builtin-tools",
    uri: `${URI_ROOT}builtin-tools`,
    title: "Built-in Tool catalog",
    description: "Exact Tool schemas, risk classes, and Connection requirements generated from the runtime.",
    mimeType: "text/markdown",
    read: async () => toolCatalog(),
  },
  {
    name: "harness-spec-schema",
    uri: "harnest://schema/harness-spec.json",
    title: "HarnessSpec JSON Schema",
    description: "Machine-readable schema for all supported HarnessSpec versions, including current v0.3.",
    mimeType: "application/schema+json",
    read: async () => harnessSchema(),
  },
] as const;

export interface HarnessValidationResult {
  readonly ok: boolean;
  readonly valid: boolean;
  readonly source: { readonly kind: "project" | "yaml"; readonly file?: string };
  readonly specVersion?: HarnessSpec["version"];
  readonly diagnostics: readonly Diagnostic[];
  readonly summary?: ReturnType<typeof describeHarness>;
  readonly setupRequired: {
    readonly environmentVariables: readonly string[];
    readonly connections: readonly string[];
    readonly adapters: readonly string[];
    readonly modules: readonly string[];
  };
  readonly checks: readonly string[];
}

const inside = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};

const safeDiagnostics = (diagnostics: readonly Diagnostic[], workspaceRoot: string): Diagnostic[] => diagnostics.map((item) => {
  const resolvedPath = isAbsolute(item.path)
    ? inside(workspaceRoot, item.path)
      ? `./${relative(workspaceRoot, item.path).split(sep).join("/")}`
      : "<outside-workspace>"
    : item.path;
  const rawMessage = item.code.startsWith("YAML_") ? item.message.split("\n", 1)[0]! : item.message;
  const message = (isAbsolute(item.path) ? rawMessage.replaceAll(item.path, resolvedPath) : rawMessage)
    .replaceAll(`${workspaceRoot}${sep}`, `<workspace>${sep}`);
  return {
    ...item,
    path: redactSecretLiterals(resolvedPath),
    message: redactSecretLiterals(message),
    ...(item.componentId === undefined ? {} : { componentId: redactSecretLiterals(item.componentId) }),
    ...(item.hint === undefined ? {} : { hint: redactSecretLiterals(item.hint) }),
  };
});

const placeholderCredential = (value: string): boolean => {
  const normalized = value.toUpperCase();
  return normalized.includes("PLACEHOLDER")
    || normalized.includes("CHANGEME")
    || normalized.includes("REDACTED")
    || normalized.includes("EXAMPLE")
    || /^(?:SK-)?X{12,}$/.test(normalized)
    || /(?:^|[-_])(?:YOUR|REPLACE|INSERT|DUMMY|FAKE|XXX)(?:[-_]|$)/.test(normalized);
};

const secretLiteralRanges = (value: string): Array<[number, number]> => {
  if (ENV_REFERENCE.test(value)) return [];
  const ranges: Array<[number, number]> = [];
  const add = (pattern: RegExp, accept: (match: RegExpExecArray) => boolean = () => true): void => {
    for (const match of value.matchAll(pattern)) if (accept(match)) ranges.push([
      match.index,
      match.index + match[0].length,
    ]);
  };
  add(PRIVATE_KEY_BLOCK);
  add(JWT);
  add(CREDENTIALED_URL);
  add(PROVIDER_KEY, (match) => !placeholderCredential(match[0]));
  add(BEARER_CREDENTIAL, (match) => !placeholderCredential(match[1]!));
  add(CREDENTIAL_ASSIGNMENT, (match) => {
    const credential = match[1]!;
    return !placeholderCredential(credential)
      && [/[A-Za-z]/, /\d/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(credential)).length >= 2;
  });
  ranges.sort(([left], [right]) => left - right);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
    else merged.push(range);
  }
  return merged;
};

const containsSecretLiteral = (value: string): boolean => secretLiteralRanges(value).length > 0;

const redactSecretLiterals = (value: string): string => {
  const ranges = secretLiteralRanges(value);
  if (!ranges.length) return value;
  let redacted = "";
  let cursor = 0;
  for (const [start, end] of ranges) {
    redacted += `${value.slice(cursor, start)}<redacted-credential>`;
    cursor = end;
  }
  return redacted + value.slice(cursor);
};

const secretLiteralDiagnostics = (spec: HarnessSpec): Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  const visit = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      if (containsSecretLiteral(value)) diagnostics.push({
        code: "SECRET_LITERAL",
        path,
        message: "HarnessSpec string values must not contain literal credentials; use env:NAME references or saved Connections.",
        severity: "error",
      });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, item] of Object.entries(value)) {
      const childPath = /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
      visit(item, childPath);
    }
  };
  visit(spec, "$");
  return diagnostics;
};

const failure = (
  kind: "project" | "yaml",
  diagnostics: readonly Diagnostic[],
  workspaceRoot: string,
): HarnessValidationResult => ({
  ok: false,
  valid: false,
  source: { kind },
  diagnostics: safeDiagnostics(diagnostics, workspaceRoot),
  setupRequired: { environmentVariables: [], connections: [], adapters: [], modules: [] },
  checks: kind === "yaml" ? ["YAML syntax", "HarnessSpec schema"] : ["Workspace boundary", "Project manifest and assets"],
});

const requiredEnvironmentVariables = (spec: HarnessSpec): string[] => {
  const references = new Set(projectEnvironmentReferences(spec));
  const components = [
    ...spec.components,
    ...(spec.version === "0.1" ? [] : Object.values(spec.subgraphs ?? {}).flatMap(({ components }) => components)),
  ];
  for (const component of components) {
    const config = component.config as Readonly<Record<string, unknown>>;
    if (component.type !== "model"
      || (typeof config.connectionId === "string" && config.connectionId.length > 0)
      || config.apiKey !== undefined
      || typeof config.adapter !== "string"
      || !authoringAdapters.has(config.adapter)) continue;
    for (const reference of authoringAdapters.get(config.adapter).requiredCredentials ?? []) {
      if (ENV_REFERENCE.test(reference)) references.add(reference.slice(4));
    }
  }
  return [...references].sort();
};

const customModuleToolPaths = (spec: HarnessSpec): Set<string> => new Set([
  { path: "$", components: spec.components },
  ...(spec.version === "0.1" ? [] : Object.entries(spec.subgraphs ?? {}).map(([name, body]) => ({
    path: `$.subgraphs.${name}`,
    components: body.components,
  }))),
].flatMap(({ path, components }) => components.flatMap((component, index) => component.type === "tool"
  && component.config.source === "module"
  && typeof component.config.tool === "string"
  && !component.config.tool.startsWith("builtin.")
  ? [`${path}.components[${index}].config.tool`]
  : [])));

const analyze = (
  spec: HarnessSpec,
  source: HarnessValidationResult["source"],
  initialDiagnostics: readonly Diagnostic[],
  workspaceRoot: string,
): HarnessValidationResult => {
  const validation = validateSpec(spec, { registry: authoringAdapters, tools: createAuthoringToolRegistry() });
  const summary = describeHarness(spec);
  const runtime = spec.runtime;
  const adapterModules = [...(runtime?.adapters ?? [])].sort();
  const modules = spec.version === "0.1" ? [] : [...(spec.runtime?.modules ?? [])].sort();
  const deferredToolPaths = modules.length ? customModuleToolPaths(spec) : new Set<string>();
  const validationDiagnostics = validation.diagnostics.map((item): Diagnostic => {
    if (item.code === "ADAPTER_NOT_REGISTERED" && adapterModules.length) return {
      ...item,
      code: "AUTHORING_ADAPTER_REGISTRATION_DEFERRED",
      message: "Custom Adapter registration validation was deferred because runtime.adapters modules were not loaded or executed.",
      hint: "Verify the declared Adapter module in the reviewed target host",
      severity: "warning",
    };
    if (item.code === "TOOL_NOT_REGISTERED" && deferredToolPaths.has(item.path)) return {
      ...item,
      code: "AUTHORING_TOOL_REGISTRATION_DEFERRED",
      message: "Custom Tool registration validation was deferred because runtime.modules were not loaded or executed.",
      hint: "Verify the declared Tool module in the reviewed target host",
      severity: "warning",
    };
    return item;
  });
  const diagnostics = [...initialDiagnostics, ...validationDiagnostics, ...secretLiteralDiagnostics(spec)];
  if (adapterModules.length) diagnostics.push({
    code: "AUTHORING_ADAPTER_MODULE_VALIDATION_DEFERRED",
    path: "$.runtime.adapters",
    message: "Adapter modules were declared but were not loaded or executed by the authoring validator; verify them in the target host.",
    severity: "warning",
  });
  if (modules.length) diagnostics.push({
    code: "AUTHORING_MODULE_VALIDATION_DEFERRED",
    path: "$.runtime.modules",
    message: "Runtime modules were declared but were not executed by the authoring validator; verify them in the target host.",
    severity: "warning",
  });
  const hasSecretLiteral = diagnostics.some((item) => item.code === "SECRET_LITERAL");
  return {
    ok: !diagnostics.some((item) => item.severity === "error"),
    valid: !diagnostics.some((item) => item.severity === "error"),
    source,
    specVersion: spec.version,
    diagnostics: safeDiagnostics(diagnostics, workspaceRoot),
    ...(hasSecretLiteral ? {} : { summary }),
    setupRequired: hasSecretLiteral
      ? { environmentVariables: [], connections: [], adapters: [], modules: [] }
      : {
          environmentVariables: requiredEnvironmentVariables(spec),
          connections: summary.requiredConnections,
          adapters: adapterModules,
          modules,
        },
    checks: [
      "YAML 1.2 syntax and duplicate keys",
      "HarnessSpec strict schema",
      "Project manifest and bound assets",
      "Shipped adapters and exact built-in Tool manifests (without execution)",
      "Built-in component configs and typed ports",
      "Graph reachability, cycles, state, subgraphs, Loop, Team, tests, and JSON Schemas",
      "High-confidence credential literals in materialized HarnessSpec string values rejected; .env/vault values and Adapter/runtime modules never loaded",
    ],
  };
};

export async function validateHarnessInput(options: {
  readonly workspaceRoot: string;
  readonly path?: string;
  readonly yaml?: string;
}): Promise<HarnessValidationResult> {
  const workspaceRoot = await realpath(resolve(options.workspaceRoot));
  if (options.yaml !== undefined && options.path !== undefined) return failure("yaml", [{
    code: "AUTHORING_INPUT_CONFLICT",
    path: "$",
    message: "Provide either yaml or path, not both.",
    severity: "error",
  }], workspaceRoot);

  if (options.yaml !== undefined) {
    if (Buffer.byteLength(options.yaml, "utf8") > MAX_YAML_BYTES) return failure("yaml", [{
      code: "AUTHORING_INPUT_TOO_LARGE",
      path: "$",
      message: `Harness YAML exceeds ${MAX_YAML_BYTES} bytes.`,
      severity: "error",
    }], workspaceRoot);
    const parsed = parseSpec(options.yaml);
    return parsed.ok
      ? analyze(parsed.spec, { kind: "yaml" }, parsed.diagnostics, workspaceRoot)
      : failure("yaml", parsed.diagnostics, workspaceRoot);
  }

  const requested = resolve(workspaceRoot, options.path ?? ".");
  if (!inside(workspaceRoot, requested)) return failure("project", [{
    code: "AUTHORING_PATH_OUTSIDE_WORKSPACE",
    path: "$",
    message: "Harness path must remain inside the configured MCP workspace root.",
    severity: "error",
  }], workspaceRoot);
  let canonicalRequested: string;
  try {
    canonicalRequested = await realpath(requested);
  } catch (error) {
    return failure("project", [{
      code: "FILE_READ",
      path: options.path ?? ".",
      message: error instanceof Error ? error.message : "Harness path could not be read.",
      severity: "error",
    }], workspaceRoot);
  }
  if (!inside(workspaceRoot, canonicalRequested)) return failure("project", [{
    code: "AUTHORING_PATH_OUTSIDE_WORKSPACE",
    path: "$",
    message: "Harness path resolves outside the configured MCP workspace root.",
    severity: "error",
  }], workspaceRoot);

  let harnessFile: string;
  try {
    harnessFile = await resolveHarnessFile(canonicalRequested);
    const info = await lstat(harnessFile);
    if (info.isSymbolicLink() || !(await stat(harnessFile)).isFile()) throw new Error("Harness must be a regular, non-symbolic-link YAML file.");
    const canonicalFile = await realpath(harnessFile);
    if (!inside(workspaceRoot, canonicalFile)) throw new Error("Harness file resolves outside the configured MCP workspace root.");
  } catch (error) {
    return failure("project", [{
      code: "FILE_READ",
      path: options.path ?? ".",
      message: error instanceof Error ? error.message : "Harness file could not be read safely.",
      severity: "error",
    }], workspaceRoot);
  }

  const loaded = await loadHarnestProjectSpec(harnessFile);
  if (!loaded.ok) return failure("project", loaded.diagnostics, workspaceRoot);
  const file = `./${relative(workspaceRoot, loaded.file).split(sep).join("/")}`;
  return analyze(loaded.spec, { kind: "project", file }, loaded.diagnostics, workspaceRoot);
}

export function buildAuthoringMcpServer(options: { readonly workspaceRoot: string }): McpServer {
  const server = new McpServer(
    { name: "harnest-authoring", version: SERVER_VERSION },
    {
      instructions: "Design Harnest HarnessSpec v0.3 projects. Read harnest://docs/index first, use the generated component and Tool catalogs for exact schemas, edit files with the host's filesystem tools, then call validate_harness_project. Never put secrets in HarnessSpec. Validation inspects materialized HarnessSpec strings to reject obvious literals, but never accesses .env, vault, or saved Connection credentials.",
      capabilities: { tools: {}, resources: {}, prompts: {} },
    },
  );

  for (const resource of AUTHORING_RESOURCES) server.registerResource(
    resource.name,
    resource.uri,
    {
      title: resource.title,
      description: resource.description,
      mimeType: resource.mimeType,
      annotations: { audience: ["assistant"], priority: resource.name === "index" ? 1 : 0.8 },
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: resource.mimeType, text: await resource.read() }] }),
  );

  server.registerPrompt("design_harness", {
    title: "Design and validate a Harnest harness",
    description: "A safe workflow for turning a product requirement into a validated HarnessSpec project.",
    argsSchema: z.object({
      requirement: z.string().min(1).max(20_000).describe("What the AI service or agent harness must do"),
      projectPath: z.string().max(4_096).optional().describe("Project path relative to the configured workspace root"),
    }),
  }, ({ requirement, projectPath }) => ({ messages: [{
    role: "user",
    content: {
      type: "text",
      text: [
        "Design a Harnest HarnessSpec v0.3 project for this requirement:",
        requirement,
        "",
        "Read harnest://docs/index, harnest://docs/components, and the relevant topic resources before editing.",
        "Use the host filesystem tools to create or update the project. Do not write API keys, tokens, or passwords.",
        `When complete, call validate_harness_project with path ${JSON.stringify(projectPath ?? ".")} and repair every error.`,
        "Report required Connections and environment variable names separately for the user to configure later.",
      ].join("\n"),
    },
  }] }));

  server.registerTool("validate_harness_project", {
    title: "Validate HarnessSpec project",
    description: "Statically validate a project folder/file or pasted YAML without running modules, tools, or models. It inspects materialized HarnessSpec strings to reject obvious credential literals, but never accesses .env, vault, or saved Connection credential values.",
    inputSchema: z.object({
      path: z.string().max(4_096).optional().describe("Project directory or Harness YAML path inside the configured workspace root; defaults to '.'"),
      yaml: z.string().max(MAX_YAML_BYTES).optional().describe("Harness YAML to validate when the MCP server cannot access the caller's filesystem"),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ path, yaml }) => {
    const result = await validateHarnessInput({ workspaceRoot: options.workspaceRoot, ...(path === undefined ? {} : { path }), ...(yaml === undefined ? {} : { yaml }) });
    return {
      isError: !result.valid,
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  });

  return server;
}

export async function serveAuthoringMcp(options: {
  readonly workspaceRoot: string;
  readonly transport: "stdio" | "http";
  readonly host?: string;
  readonly port?: number;
  readonly allowedHosts?: readonly string[];
  readonly allowedOrigins?: readonly string[];
}): Promise<void> {
  const workspaceRoot = await realpath(resolve(options.workspaceRoot));
  const factory = () => buildAuthoringMcpServer({ workspaceRoot });
  if (options.transport === "stdio") {
    const handle = serveStdio(factory, { onerror: (error) => console.error(error) });
    console.error(`Harnest authoring MCP ready on stdio (workspace: ${workspaceRoot})`);
    try {
      await new Promise<void>((done) => {
        process.stdin.once("end", done);
        process.once("SIGINT", done);
        process.once("SIGTERM", done);
      });
    } finally {
      await handle.close();
    }
    return;
  }

  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8790;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("MCP HTTP port must be an integer from 1 to 65535");
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  const allowedHosts = [...new Set(options.allowedHosts ?? (loopback ? LOOPBACK_HOSTS : []))];
  const allowedOrigins = [...new Set(options.allowedOrigins ?? (loopback ? LOOPBACK_HOSTS : []))];
  if (!allowedHosts.length) throw new Error("Remote MCP HTTP binding requires at least one --allowed-host hostname or IP");
  const validateHost = hostHeaderValidation(allowedHosts);
  const validateOrigin = originValidation(allowedOrigins);
  const handler = createMcpHandler(factory, { onerror: (error) => console.error(error) });
  const nodeHandler = toNodeHandler(handler, { onerror: (error) => console.error(error) });
  const rejectBody = (
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
    status: number,
    code: number,
    message: string,
  ): void => {
    request.resume();
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", connection: "close" });
    response.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
  };
  const http = createServer(async (request, response) => {
    const target = request.url;
    if (request.method === "GET" && target === "/health") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ ok: true, service: "harnest-authoring-mcp" }));
      return;
    }
    if (target !== "/mcp") {
      request.resume();
      response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "Not found" }));
      return;
    }
    if (!validateHost(request, response) || !validateOrigin(request, response)) return;
    if (request.method !== "GET" && request.method !== "POST" && request.method !== "DELETE") {
      rejectBody(request, response, 405, -32600, "Method not allowed");
      return;
    }
    try {
      let parsedBody: unknown;
      if (request.method === "POST" || request.method === "DELETE") {
        const encoding = request.headers["content-encoding"]?.trim().toLowerCase();
        if (encoding && encoding !== "identity") {
          rejectBody(request, response, 415, -32600, "Unsupported Content-Encoding");
          return;
        }
        const length = request.headers["content-length"];
        if (length && /^\d+$/.test(length) && BigInt(length) > BigInt(MAX_HTTP_BODY_BYTES)) {
          rejectBody(request, response, 413, -32600, "Request body too large");
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of request) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
          bytes += buffer.byteLength;
          if (bytes > MAX_HTTP_BODY_BYTES) {
            rejectBody(request, response, 413, -32600, "Request body too large");
            return;
          }
          chunks.push(buffer);
        }
        if (bytes || request.method === "POST") {
          try {
            parsedBody = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
          } catch {
            rejectBody(request, response, 400, -32700, "Parse error");
            return;
          }
        }
      }
      await nodeHandler(
        request as Parameters<typeof nodeHandler>[0],
        response as Parameters<typeof nodeHandler>[1],
        parsedBody,
      );
    } catch (error) {
      console.error(error);
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      if (!response.writableEnded) response.end(JSON.stringify({ error: "MCP request failed" }));
    }
  });
  try {
    await new Promise<void>((ready, reject) => {
      http.once("error", reject);
      http.listen(port, host, ready);
    });
    console.error(`Harnest authoring MCP ready at http://${host}:${port}/mcp (workspace: ${workspaceRoot})`);
    await new Promise<void>((done) => {
      process.once("SIGINT", done);
      process.once("SIGTERM", done);
    });
  } finally {
    await handler.close();
    await new Promise<void>((done) => http.close(() => done()));
  }
}
