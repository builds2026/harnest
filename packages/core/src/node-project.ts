import { createHash } from "node:crypto";
import { readFileSync, statSync, type Stats } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  ComponentIdSchema,
  parseSpec,
  stringifySpec,
  type Diagnostic,
  type HarnessSpec,
} from "./spec.js";
import { atomicWriteVerifiedFile, isSensitiveWorkspacePath, readVerifiedFile } from "./safe-files.js";

const PROJECT_FILE = "project.json";
const PROJECT_ROOT = ".harnest";
const MAX_MANIFEST_BYTES = 1_048_576;
const MAX_TEXT_ASSET_BYTES = 1_048_576;
const MAX_JSON_ASSET_BYTES = 4_194_304;
const MAX_PORTABLE_FILES = 1_000;
const MAX_PORTABLE_BYTES = 64 * 1_048_576;
const PORTABLE_ROOTS = new Set(["prompts", "skills", "context", "schemas", "tests", "tools", "config"]);

const isInside = (root: string, target: string): boolean => {
  const path = relative(root, target);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

const portablePath = z.string().min(1).max(512).refine((value) => {
  if (value.includes("\\") || value.startsWith("/") || isAbsolute(value)) return false;
  const segments = value.split("/");
  return segments.every((segment) => Boolean(segment) && segment !== "." && segment !== "..");
}, "Path must be a portable .harnest-relative path");

const harnessPath = z.string().min(1).max(512).refine((value) => {
  if (value.includes("\\") || value.startsWith("/") || isAbsolute(value)) return false;
  const segments = value.split("/");
  return segments.length === 1 && segments.every((segment) => Boolean(segment) && segment !== "." && segment !== "..")
    && /\.ya?ml$/i.test(value);
}, "Harness must be a YAML file in the project root");

const under = (root: string, extensions?: readonly string[]) => portablePath.refine((value) => {
  if (!value.startsWith(`${root}/`) || value.endsWith("/")) return false;
  return !extensions || extensions.some((extension) => value.toLowerCase().endsWith(extension));
}, extensions
  ? `Path must be a ${extensions.join(" or ")} file under ${root}/`
  : `Path must be under ${root}/`);

const portableIncludePath = portablePath.refine((value) => {
  if (value === "studio.json") return true;
  return PORTABLE_ROOTS.has(value.split("/")[0] ?? "");
}, "Portable includes are limited to prompts, skills, context, schemas, tests, tools, config, and studio.json");

const promptPath = under("prompts");
const contextPath = under("context");
const schemaPath = under("schemas", [".json"]);
const testPath = under("tests", [".json"]);

const componentBinding = {
  component: ComponentIdSchema,
  graph: ComponentIdSchema.optional(),
};

const ProjectBindingSchema = z.discriminatedUnion("kind", [
  z.object({ ...componentBinding, kind: z.literal("prompt"), path: promptPath }).strict(),
  z.object({ ...componentBinding,
    kind: z.literal("context"),
    path: contextPath,
    mode: z.enum(["file", "directory"]).optional(),
  }).strict(),
  z.object({ ...componentBinding, kind: z.literal("schema"), path: schemaPath }).strict(),
]);

export const HarnestProjectManifestSchema = z.object({
  version: z.literal(1),
  harness: harnessPath,
  bindings: z.array(ProjectBindingSchema).max(512).optional(),
  tests: z.array(testPath).max(64).optional(),
  studio: z.literal("studio.json").optional(),
  portable: z.object({
    include: z.array(portableIncludePath).max(128).optional(),
  }).strict().optional(),
}).strict();

export type HarnestProjectManifest = z.infer<typeof HarnestProjectManifestSchema>;
export type HarnestProjectBinding = z.infer<typeof ProjectBindingSchema>;

export interface HarnestProjectDescriptor {
  readonly file: string;
  readonly projectDirectory: string;
  readonly hiddenDirectory: string;
  readonly manifestPath: string;
  readonly manifest: HarnestProjectManifest;
}

export interface PortableProjectFile {
  readonly path: string;
  readonly archivePath: string;
  readonly size: number;
  readonly sha256: string;
}

export interface PortableProjectTextFile extends PortableProjectFile {
  readonly content: string;
}

export class HarnestProjectError extends Error {
  readonly code: string;
  readonly path: string;

  constructor(code: string, path: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "HarnestProjectError";
    this.code = code;
    this.path = path;
  }
}

const missing = (error: unknown): boolean => Boolean(
  error && typeof error === "object" && "code" in error && error.code === "ENOENT",
);

const diagnostic = (error: unknown): Diagnostic => error instanceof HarnestProjectError
  ? { code: error.code, path: error.path, message: error.message, severity: "error" }
  : {
      code: "PROJECT_LOAD",
      path: `$.${PROJECT_ROOT}`,
      message: error instanceof Error ? error.message : "Harnest project could not be loaded",
      severity: "error",
    };

export async function resolveHarnessFile(inputPath: string): Promise<string> {
  const requested = resolve(inputPath);
  try {
    const info = await stat(requested);
    if (!info.isDirectory()) return requested;
  } catch {
    return requested;
  }
  const manifestPath = join(requested, PROJECT_ROOT, PROJECT_FILE);
  try {
    const parsed = HarnestProjectManifestSchema.safeParse(JSON.parse(await readFile(manifestPath, "utf8")) as unknown);
    if (!parsed.success) throw new HarnestProjectError(
      "PROJECT_MANIFEST_INVALID",
      `$.${PROJECT_ROOT}.${PROJECT_FILE}`,
      parsed.error.issues.map((issue) => issue.message).join("; "),
    );
    return resolve(requested, parsed.data.harness);
  } catch (error) {
    if (missing(error)) return join(requested, "harnest.yaml");
    throw error;
  }
}

export function resolveHarnessFileSync(inputPath: string): string {
  const requested = resolve(inputPath);
  try {
    if (!statSync(requested).isDirectory()) return requested;
  } catch {
    return requested;
  }
  const manifestPath = join(requested, PROJECT_ROOT, PROJECT_FILE);
  try {
    const parsed = HarnestProjectManifestSchema.safeParse(JSON.parse(readFileSync(manifestPath, "utf8")) as unknown);
    if (!parsed.success) throw new HarnestProjectError(
      "PROJECT_MANIFEST_INVALID",
      `$.${PROJECT_ROOT}.${PROJECT_FILE}`,
      parsed.error.issues.map((issue) => issue.message).join("; "),
    );
    return resolve(requested, parsed.data.harness);
  } catch (error) {
    if (missing(error)) return join(requested, "harnest.yaml");
    throw error;
  }
}

async function projectLocation(filePath: string): Promise<{
  file: string;
  projectDirectory: string;
  hiddenDirectory: string;
  manifestPath: string;
}> {
  const file = await resolveHarnessFile(filePath);
  const projectDirectory = await realpath(dirname(file));
  const hiddenPath = join(projectDirectory, PROJECT_ROOT);
  const hiddenDirectory = await realpath(hiddenPath);
  if (!isInside(projectDirectory, hiddenDirectory) || hiddenDirectory === projectDirectory) {
    throw new HarnestProjectError("PROJECT_PATH_INVALID", `$.${PROJECT_ROOT}`, "Project metadata resolves outside the project");
  }
  return { file, projectDirectory, hiddenDirectory, manifestPath: join(hiddenDirectory, PROJECT_FILE) };
}

export async function loadHarnestProjectManifest(filePath: string): Promise<HarnestProjectDescriptor | undefined> {
  let location: Awaited<ReturnType<typeof projectLocation>>;
  try {
    location = await projectLocation(filePath);
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  let raw: Buffer;
  try {
    raw = await readVerifiedFile(location.manifestPath, location.projectDirectory, MAX_MANIFEST_BYTES);
  } catch (error) {
    if (missing(error)) return undefined;
    throw new HarnestProjectError(
      "PROJECT_MANIFEST_READ",
      `$.${PROJECT_ROOT}.${PROJECT_FILE}`,
      "Project manifest could not be read safely",
      error,
    );
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw.toString("utf8")) as unknown;
  } catch (error) {
    throw new HarnestProjectError(
      "PROJECT_MANIFEST_JSON",
      `$.${PROJECT_ROOT}.${PROJECT_FILE}`,
      "Project manifest is not valid JSON",
      error,
    );
  }
  const parsed = HarnestProjectManifestSchema.safeParse(candidate);
  if (!parsed.success) throw new HarnestProjectError(
    "PROJECT_MANIFEST_INVALID",
    `$.${PROJECT_ROOT}.${PROJECT_FILE}`,
    parsed.error.issues.map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`).join("; "),
  );
  const requestedHarness = relative(location.projectDirectory, location.file).split(sep).join("/");
  if (parsed.data.harness !== requestedHarness) throw new HarnestProjectError(
    "PROJECT_HARNESS_MISMATCH",
    `$.${PROJECT_ROOT}.${PROJECT_FILE}.harness`,
    `Project manifest targets '${parsed.data.harness}', not '${requestedHarness}'`,
  );
  return { ...location, manifest: parsed.data };
}

async function verifiedProjectEntry(
  project: HarnestProjectDescriptor,
  configuredPath: string,
): Promise<{ path: string; relativePath: string; info: Stats }> {
  const lexical = resolve(project.hiddenDirectory, configuredPath);
  if (!isInside(project.hiddenDirectory, lexical)) throw new HarnestProjectError(
    "PROJECT_ASSET_PATH",
    `$.${PROJECT_ROOT}.${configuredPath}`,
    `Project asset '${configuredPath}' is outside .harnest`,
  );
  let link;
  try {
    link = await lstat(lexical);
  } catch (error) {
    throw new HarnestProjectError(
      "PROJECT_ASSET_MISSING",
      `$.${PROJECT_ROOT}.${configuredPath}`,
      `Project asset '${configuredPath}' does not exist`,
      error,
    );
  }
  if (link.isSymbolicLink()) throw new HarnestProjectError(
    "PROJECT_ASSET_LINK",
    `$.${PROJECT_ROOT}.${configuredPath}`,
    `Project asset '${configuredPath}' cannot be a symbolic link`,
  );
  const path = await realpath(lexical);
  if (!isInside(project.hiddenDirectory, path)) throw new HarnestProjectError(
    "PROJECT_ASSET_PATH",
    `$.${PROJECT_ROOT}.${configuredPath}`,
    `Project asset '${configuredPath}' resolves outside .harnest`,
  );
  return { path, relativePath: configuredPath, info: await stat(path) as Stats };
}

async function readAsset(
  project: HarnestProjectDescriptor,
  configuredPath: string,
  maxBytes: number,
): Promise<string> {
  const entry = await verifiedProjectEntry(project, configuredPath);
  if (isSensitiveWorkspacePath(project.projectDirectory, entry.path)) throw new HarnestProjectError(
    "PROJECT_ASSET_SENSITIVE", `$.${PROJECT_ROOT}.${configuredPath}`, `Sensitive asset '${configuredPath}' cannot be portable`,
  );
  if (!entry.info.isFile()) throw new HarnestProjectError(
    "PROJECT_ASSET_TYPE",
    `$.${PROJECT_ROOT}.${configuredPath}`,
    `Project asset '${configuredPath}' must be a regular file`,
  );
  try {
    return (await readVerifiedFile(entry.path, project.hiddenDirectory, maxBytes)).toString("utf8");
  } catch (error) {
    throw new HarnestProjectError(
      "PROJECT_ASSET_READ",
      `$.${PROJECT_ROOT}.${configuredPath}`,
      `Project asset '${configuredPath}' could not be read safely`,
      error,
    );
  }
}

function targetComponent(spec: HarnessSpec, binding: HarnestProjectBinding) {
  const graph = binding.graph && spec.version !== "0.1" ? spec.subgraphs?.[binding.graph] : spec;
  if (!graph) throw new HarnestProjectError(
    "PROJECT_BINDING_GRAPH",
    `$.${PROJECT_ROOT}.${PROJECT_FILE}.bindings`,
    `Project binding references missing subgraph '${binding.graph}'`,
  );
  const component = graph.components.find((candidate) => candidate.id === binding.component);
  if (!component) throw new HarnestProjectError(
    "PROJECT_BINDING_COMPONENT",
    `$.${PROJECT_ROOT}.${PROJECT_FILE}.bindings`,
    `Project binding references missing component '${binding.component}'`,
  );
  return component;
}

function parseJsonAsset(text: string, path: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new HarnestProjectError(
      "PROJECT_ASSET_JSON",
      `$.${PROJECT_ROOT}.${path}`,
      `Project asset '${path}' is not valid JSON`,
      error,
    );
  }
}

export async function materializeHarnestProject(
  filePath: string,
  sourceSpec: HarnessSpec,
): Promise<{ readonly spec: HarnessSpec; readonly project?: HarnestProjectDescriptor }> {
  const project = await loadHarnestProjectManifest(filePath);
  if (!project) return { spec: sourceSpec };
  const candidate = structuredClone(sourceSpec);
  for (const binding of project.manifest.bindings ?? []) {
    const component = targetComponent(candidate, binding);
    if (binding.kind === "prompt") {
      if (component.type !== "prompt") throw new HarnestProjectError(
        "PROJECT_BINDING_TYPE",
        `$.${PROJECT_ROOT}.${PROJECT_FILE}.bindings`,
        `Prompt asset '${binding.path}' targets '${component.type}', not a Prompt component`,
      );
      const template = await readAsset(project, binding.path, MAX_TEXT_ASSET_BYTES);
      if (!template.trim()) throw new HarnestProjectError(
        "PROJECT_PROMPT_EMPTY",
        `$.${PROJECT_ROOT}.${binding.path}`,
        `Prompt asset '${binding.path}' cannot be empty`,
      );
      component.config = { ...component.config, template };
      continue;
    }
    if (binding.kind === "schema") {
      if (component.type !== "output") throw new HarnestProjectError(
        "PROJECT_BINDING_TYPE",
        `$.${PROJECT_ROOT}.${PROJECT_FILE}.bindings`,
        `Schema asset '${binding.path}' targets '${component.type}', not an Output component`,
      );
      const schema = parseJsonAsset(await readAsset(project, binding.path, MAX_JSON_ASSET_BYTES), binding.path);
      if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new HarnestProjectError(
        "PROJECT_SCHEMA_INVALID",
        `$.${PROJECT_ROOT}.${binding.path}`,
        `Schema asset '${binding.path}' must contain a JSON object`,
      );
      component.config = { ...component.config, format: "json", schema };
      continue;
    }
    if (component.type !== "context") throw new HarnestProjectError(
      "PROJECT_BINDING_TYPE",
      `$.${PROJECT_ROOT}.${PROJECT_FILE}.bindings`,
      `Context asset '${binding.path}' targets '${component.type}', not a Context component`,
    );
    const entry = await verifiedProjectEntry(project, binding.path);
    const mode = binding.mode ?? (entry.info.isDirectory() ? "directory" : "file");
    if ((mode === "directory") !== entry.info.isDirectory() || (mode === "file") !== entry.info.isFile()) {
      throw new HarnestProjectError(
        "PROJECT_ASSET_TYPE",
        `$.${PROJECT_ROOT}.${binding.path}`,
        `Context asset '${binding.path}' is not a ${mode}`,
      );
    }
    component.config = {
      ...component.config,
      source: mode,
      path: `${PROJECT_ROOT}/${binding.path}`,
    };
    delete component.config.text;
  }

  if (project.manifest.tests?.length) {
    const tests: unknown[] = [];
    for (const path of project.manifest.tests) {
      const value = parseJsonAsset(await readAsset(project, path, MAX_JSON_ASSET_BYTES), path);
      if (!Array.isArray(value)) throw new HarnestProjectError(
        "PROJECT_TESTS_INVALID",
        `$.${PROJECT_ROOT}.${path}`,
        `Test asset '${path}' must contain a JSON array`,
      );
      tests.push(...value);
    }
    candidate.tests = tests as HarnessSpec["tests"];
  }
  if (project.manifest.studio) {
    const studio = parseJsonAsset(
      await readAsset(project, project.manifest.studio, MAX_JSON_ASSET_BYTES),
      project.manifest.studio,
    );
    candidate.studio = studio as HarnessSpec["studio"];
  }
  const parsed = parseSpec(stringifySpec(candidate));
  if (!parsed.ok) throw new HarnestProjectError(
    "PROJECT_MATERIALIZED_INVALID",
    `$.${PROJECT_ROOT}.${PROJECT_FILE}`,
    `Project assets produce an invalid Harness: ${parsed.diagnostics.map((item) => `${item.path}: ${item.message}`).join("; ")}`,
  );
  return { spec: parsed.spec, project };
}

export async function loadHarnestProjectSpec(filePath: string): Promise<
  | { readonly ok: true; readonly file: string; readonly sourceSpec: HarnessSpec; readonly spec: HarnessSpec; readonly project?: HarnestProjectDescriptor; readonly diagnostics: [] }
  | { readonly ok: false; readonly diagnostics: Diagnostic[] }
> {
  try {
    const file = await resolveHarnessFile(filePath);
    let text: string;
    try {
      text = await readFile(/* turbopackIgnore: true */ file, "utf8");
    } catch (error) {
      return { ok: false, diagnostics: [{
        code: "FILE_READ",
        path: file,
        message: error instanceof Error ? error.message : `Could not read '${file}'`,
        severity: "error",
      }] };
    }
    const source = parseSpec(text);
    if (!source.ok) return source;
    const materialized = await materializeHarnestProject(file, source.spec);
    return {
      ok: true,
      file,
      sourceSpec: source.spec,
      spec: materialized.spec,
      ...(materialized.project ? { project: materialized.project } : {}),
      diagnostics: [],
    };
  } catch (error) {
    return { ok: false, diagnostics: [diagnostic(error)] };
  }
}

export async function initializeHarnestProject(
  filePath: string,
  manifest: HarnestProjectManifest,
  assets: Readonly<Record<string, string>> = {},
): Promise<HarnestProjectDescriptor> {
  const file = resolve(filePath);
  const projectDirectory = await realpath(dirname(file));
  const hiddenPath = join(projectDirectory, PROJECT_ROOT);
  await mkdir(hiddenPath, { mode: 0o700 }).catch((error: unknown) => {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
  });
  const hiddenInfo = await lstat(hiddenPath);
  if (!hiddenInfo.isDirectory() || hiddenInfo.isSymbolicLink()) {
    throw new HarnestProjectError("PROJECT_PATH_INVALID", `$.${PROJECT_ROOT}`, "Project metadata must be a regular directory");
  }
  const hiddenDirectory = await realpath(hiddenPath);
  if (!isInside(projectDirectory, hiddenDirectory) || hiddenDirectory === projectDirectory) {
    throw new HarnestProjectError("PROJECT_PATH_INVALID", `$.${PROJECT_ROOT}`, "Project metadata resolves outside the project");
  }
  const parsed = HarnestProjectManifestSchema.parse(manifest);
  const requestedHarness = relative(projectDirectory, file).split(sep).join("/");
  if (parsed.harness !== requestedHarness) throw new HarnestProjectError(
    "PROJECT_HARNESS_MISMATCH",
    `$.${PROJECT_ROOT}.${PROJECT_FILE}.harness`,
    `Project manifest must target '${requestedHarness}'`,
  );
  const directories = new Set(PORTABLE_ROOTS);
  for (const path of [...Object.keys(assets), ...(parsed.bindings ?? []).map(({ path }) => path), ...(parsed.tests ?? []), ...(parsed.studio ? [parsed.studio] : [])]) {
    const segments = path.split("/");
    let current = hiddenDirectory;
    for (const segment of segments.slice(0, -1)) {
      current = join(current, segment);
      await mkdir(current, { mode: 0o700 }).catch((error: unknown) => {
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
      });
    }
    directories.delete(segments[0] ?? "");
  }
  for (const directory of directories) await mkdir(join(hiddenDirectory, directory), { mode: 0o700 }).catch((error: unknown) => {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
  });
  for (const [path, content] of Object.entries(assets)) {
    if (!portableIncludePath.safeParse(path).success) throw new HarnestProjectError(
      "PROJECT_ASSET_PATH",
      `$.${PROJECT_ROOT}.${path}`,
      `Project asset '${path}' has an invalid path`,
    );
    await atomicWriteVerifiedFile(join(hiddenDirectory, ...path.split("/")), hiddenDirectory, content);
  }
  const manifestPath = join(hiddenDirectory, PROJECT_FILE);
  await atomicWriteVerifiedFile(manifestPath, hiddenDirectory, JSON.stringify(parsed, null, 2) + "\n");
  return { file, projectDirectory, hiddenDirectory, manifestPath, manifest: parsed };
}

export function projectEnvironmentReferences(spec: HarnessSpec): string[] {
  const references = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      for (const match of value.matchAll(/\benv:([A-Za-z_][A-Za-z0-9_]*)\b/g)) references.add(match[1]!);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value && typeof value === "object") Object.values(value as Record<string, unknown>).forEach(visit);
  };
  visit(spec);
  return [...references].sort();
}

export async function writeProjectEnvExample(filePath: string, spec: HarnessSpec): Promise<boolean> {
  const file = await resolveHarnessFile(filePath);
  const projectDirectory = await realpath(dirname(file));
  const target = join(projectDirectory, ".env.example");
  try {
    await lstat(target);
    return false;
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const references = projectEnvironmentReferences(spec);
  const content = [
    "# Copy this file to .env and provide values locally. Never commit .env.",
    ...references.map((name) => `${name}=`),
    "",
  ].join("\n");
  await writeFile(target, content, { flag: "wx", mode: 0o600 });
  return true;
}

async function portableEntries(
  project: HarnestProjectDescriptor,
  configuredPath: string,
  result: PortableProjectFile[],
  budget: { bytes: number },
): Promise<void> {
  const entry = await verifiedProjectEntry(project, configuredPath);
  if (isSensitiveWorkspacePath(project.projectDirectory, entry.path)) throw new HarnestProjectError(
    "PROJECT_ASSET_SENSITIVE", `$.${PROJECT_ROOT}.${configuredPath}`, `Sensitive asset '${configuredPath}' cannot be portable`,
  );
  if (entry.info.isDirectory()) {
    const children = await readdir(entry.path, { withFileTypes: true });
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      if (child.isSymbolicLink()) throw new HarnestProjectError(
        "PROJECT_ASSET_LINK",
        `$.${PROJECT_ROOT}.${configuredPath}/${child.name}`,
        "Portable project assets cannot contain symbolic links",
      );
      await portableEntries(project, `${configuredPath}/${child.name}`, result, budget);
    }
    return;
  }
  if (!entry.info.isFile()) throw new HarnestProjectError(
    "PROJECT_ASSET_TYPE",
    `$.${PROJECT_ROOT}.${configuredPath}`,
    "Portable project assets must be regular files or directories",
  );
  if (result.length >= MAX_PORTABLE_FILES || budget.bytes + entry.info.size > MAX_PORTABLE_BYTES) {
    throw new HarnestProjectError(
      "PROJECT_PORTABLE_LIMIT",
      `$.${PROJECT_ROOT}`,
      `Portable project exceeds ${MAX_PORTABLE_FILES} files or ${MAX_PORTABLE_BYTES} bytes`,
    );
  }
  const content = await readVerifiedFile(entry.path, project.hiddenDirectory, Math.min(MAX_PORTABLE_BYTES, entry.info.size + 1));
  budget.bytes += content.byteLength;
  result.push({
    path: entry.path,
    archivePath: `${PROJECT_ROOT}/${configuredPath}`,
    size: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex"),
  });
}

export async function listPortableProjectFiles(filePath: string): Promise<PortableProjectFile[]> {
  const project = await loadHarnestProjectManifest(filePath);
  if (!project) return [];
  const configured = new Set([
    PROJECT_FILE,
    ...(project.manifest.bindings ?? []).map(({ path }) => path),
    ...(project.manifest.tests ?? []),
    ...(project.manifest.studio ? [project.manifest.studio] : []),
    ...PORTABLE_ROOTS,
    ...(project.manifest.portable?.include ?? []),
  ]);
  const result: PortableProjectFile[] = [];
  const budget = { bytes: 0 };
  for (const path of [...configured].sort()) {
    try {
      await portableEntries(project, path, result, budget);
    } catch (error) {
      if (missing(error) && PORTABLE_ROOTS.has(path)) continue;
      if (error instanceof HarnestProjectError && error.code === "PROJECT_ASSET_MISSING"
        && PORTABLE_ROOTS.has(path)) continue;
      throw error;
    }
  }
  return result.filter((file, index, all) => all.findIndex(({ archivePath }) => archivePath === file.archivePath) === index)
    .sort((left, right) => left.archivePath.localeCompare(right.archivePath));
}

const configuredProjectPath = (archivePath: string): string => {
  if (!archivePath.startsWith(`${PROJECT_ROOT}/`)) throw new HarnestProjectError(
    "PROJECT_ASSET_PATH", `$.${PROJECT_ROOT}`, "Project asset path must start with .harnest/",
  );
  const configured = archivePath.slice(PROJECT_ROOT.length + 1);
  if (!portableIncludePath.safeParse(configured).success || configured === PROJECT_FILE || configured === "studio.json") {
    throw new HarnestProjectError("PROJECT_ASSET_PATH", `$.${PROJECT_ROOT}.${configured}`, "Project asset path is not editable");
  }
  return configured;
};

export async function createPortableProjectTextFile(
  filePath: string,
  archivePath: string,
  content: string,
): Promise<PortableProjectTextFile> {
  const project = await loadHarnestProjectManifest(filePath);
  if (!project) throw new HarnestProjectError("PROJECT_MANIFEST_MISSING", `$.${PROJECT_ROOT}`, "Initialize the project before creating source files");
  const configured = configuredProjectPath(archivePath);
  if (Buffer.byteLength(content, "utf8") > MAX_JSON_ASSET_BYTES || content.includes("\0")) {
    throw new HarnestProjectError("PROJECT_ASSET_WRITE", `$.${PROJECT_ROOT}.${configured}`, "Project text assets must be UTF-8 text no larger than 4 MiB");
  }
  const target = resolve(project.hiddenDirectory, ...configured.split("/"));
  if (!isInside(project.hiddenDirectory, target)) throw new HarnestProjectError("PROJECT_ASSET_PATH", `$.${PROJECT_ROOT}.${configured}`, "Project asset resolves outside .harnest");
  let current = project.hiddenDirectory;
  for (const segment of dirname(configured).split("/").filter((part) => part && part !== ".")) {
    const next = join(current, segment);
    try {
      const info = await lstat(next);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new HarnestProjectError("PROJECT_ASSET_PATH", `$.${PROJECT_ROOT}.${configured}`, "Project asset parent is unsafe");
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
      await mkdir(next, { mode: 0o700 });
    }
    current = await realpath(next);
    if (!isInside(project.hiddenDirectory, current)) throw new HarnestProjectError("PROJECT_ASSET_PATH", `$.${PROJECT_ROOT}.${configured}`, "Project asset parent resolves outside .harnest");
  }
  try {
    await lstat(target);
    throw new HarnestProjectError("PROJECT_ASSET_EXISTS", `$.${PROJECT_ROOT}.${configured}`, `Project asset '${archivePath}' already exists`);
  } catch (error) {
    if (error instanceof HarnestProjectError) throw error;
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  await atomicWriteVerifiedFile(target, project.hiddenDirectory, content);
  return readPortableProjectTextFile(filePath, archivePath);
}

export async function deletePortableProjectFile(
  filePath: string,
  archivePath: string,
  expectedSha256: string,
): Promise<void> {
  const project = await loadHarnestProjectManifest(filePath);
  if (!project) throw new HarnestProjectError("PROJECT_MANIFEST_MISSING", `$.${PROJECT_ROOT}`, "Project manifest is missing");
  const configured = configuredProjectPath(archivePath);
  const referenced = [
    ...(project.manifest.bindings ?? []).map(({ path }) => path),
    ...(project.manifest.tests ?? []),
    ...(project.manifest.portable?.include ?? []),
  ].some((path) => path === configured || configured.startsWith(`${path}/`) || path.startsWith(`${configured}/`));
  if (referenced) throw new HarnestProjectError(
    "PROJECT_ASSET_REFERENCED", `$.${PROJECT_ROOT}.${configured}`, "Unbind this project asset before deleting it",
  );
  const current = await readPortableProjectTextFile(filePath, archivePath);
  if (current.sha256 !== expectedSha256) throw new HarnestProjectError(
    "PROJECT_ASSET_CONFLICT", `$.${PROJECT_ROOT}.${configured}`, `Project asset '${archivePath}' changed since it was opened`,
  );
  await unlink(current.path);
}

export async function bindHarnestProjectAsset(
  filePath: string,
  selector: { readonly kind: HarnestProjectBinding["kind"]; readonly component: string; readonly graph?: string },
  archivePath?: string,
): Promise<HarnestProjectManifest> {
  const project = await loadHarnestProjectManifest(filePath);
  if (!project) throw new HarnestProjectError("PROJECT_MANIFEST_MISSING", `$.${PROJECT_ROOT}`, "Project manifest is missing");
  const retained = (project.manifest.bindings ?? []).filter((binding) => !(binding.kind === selector.kind
    && binding.component === selector.component && binding.graph === selector.graph));
  let binding: HarnestProjectBinding | undefined;
  if (archivePath) {
    const configured = configuredProjectPath(archivePath);
    const parsed = ProjectBindingSchema.safeParse({ ...selector, path: configured });
    if (!parsed.success) throw new HarnestProjectError("PROJECT_BINDING_INVALID", `$.${PROJECT_ROOT}.${PROJECT_FILE}.bindings`, parsed.error.issues.map(({ message }) => message).join("; "));
    binding = parsed.data;
    await verifiedProjectEntry(project, configured);
    const loaded = await loadHarnestProjectSpec(filePath);
    if (!loaded.ok) throw new HarnestProjectError("PROJECT_LOAD", `$.${PROJECT_ROOT}`, loaded.diagnostics.map(({ message }) => message).join("; "));
    const component = targetComponent(loaded.sourceSpec, binding);
    const expected = binding.kind === "prompt" ? "prompt" : binding.kind === "context" ? "context" : "output";
    if (component.type !== expected) throw new HarnestProjectError("PROJECT_BINDING_TYPE", `$.${PROJECT_ROOT}.${PROJECT_FILE}.bindings`, `${binding.kind} assets require a ${expected} component`);
  }
  const next: HarnestProjectManifest = { ...project.manifest, bindings: [...retained, ...(binding ? [binding] : [])] };
  if (!next.bindings?.length) delete next.bindings;
  const previous = await readFile(project.manifestPath, "utf8");
  try {
    await atomicWriteVerifiedFile(project.manifestPath, project.hiddenDirectory, `${JSON.stringify(next, null, 2)}\n`);
    const loaded = await loadHarnestProjectSpec(filePath);
    if (!loaded.ok) throw new HarnestProjectError("PROJECT_BINDING_INVALID", `$.${PROJECT_ROOT}.${PROJECT_FILE}.bindings`, loaded.diagnostics.map(({ message }) => message).join("; "));
    return next;
  } catch (error) {
    await atomicWriteVerifiedFile(project.manifestPath, project.hiddenDirectory, previous).catch(() => undefined);
    throw error;
  }
}

export async function readPortableProjectTextFile(
  filePath: string,
  archivePath: string,
): Promise<PortableProjectTextFile> {
  const selected = (await listPortableProjectFiles(filePath)).find((entry) => entry.archivePath === archivePath);
  if (!selected) throw new HarnestProjectError(
    "PROJECT_ASSET_NOT_PORTABLE",
    `$.${PROJECT_ROOT}`,
    `Project asset '${archivePath}' is not part of the portable project`,
  );
  if (selected.size > MAX_JSON_ASSET_BYTES) throw new HarnestProjectError(
    "PROJECT_ASSET_READ",
    `$.${PROJECT_ROOT}.${archivePath}`,
    `Project asset '${archivePath}' exceeds the editable text limit`,
  );
  const content = await readFile(selected.path);
  if (content.includes(0)) throw new HarnestProjectError(
    "PROJECT_ASSET_BINARY",
    `$.${PROJECT_ROOT}.${archivePath}`,
    `Project asset '${archivePath}' is binary and cannot be edited as text`,
  );
  return { ...selected, content: content.toString("utf8") };
}

export async function writePortableProjectTextFile(
  filePath: string,
  archivePath: string,
  content: string,
  expectedSha256?: string,
): Promise<PortableProjectTextFile> {
  if (Buffer.byteLength(content, "utf8") > MAX_JSON_ASSET_BYTES || content.includes("\0")) {
    throw new HarnestProjectError(
      "PROJECT_ASSET_WRITE",
      `$.${PROJECT_ROOT}.${archivePath}`,
      "Project text assets must be UTF-8 text no larger than 4 MiB",
    );
  }
  const current = await readPortableProjectTextFile(filePath, archivePath);
  if (expectedSha256 !== undefined && expectedSha256 !== current.sha256) throw new HarnestProjectError(
    "PROJECT_ASSET_CONFLICT",
    `$.${PROJECT_ROOT}.${archivePath}`,
    `Project asset '${archivePath}' changed since it was opened`,
  );
  await atomicWriteVerifiedFile(current.path, await realpath(dirname(current.path)), content);
  const loaded = await loadHarnestProjectSpec(filePath);
  if (!loaded.ok) {
    await atomicWriteVerifiedFile(current.path, await realpath(dirname(current.path)), current.content);
    throw new HarnestProjectError(
      "PROJECT_ASSET_INVALID",
      `$.${PROJECT_ROOT}.${archivePath}`,
      loaded.diagnostics.map((item) => item.message).join("; "),
    );
  }
  return readPortableProjectTextFile(filePath, archivePath);
}

export async function saveHarnestProjectSpec(filePath: string, spec: HarnessSpec): Promise<void> {
  const file = await resolveHarnessFile(filePath);
  const project = await loadHarnestProjectManifest(file);
  if (!project) {
    await atomicWriteVerifiedFile(file, await realpath(dirname(file)), stringifySpec(spec));
    return;
  }
  const source = structuredClone(spec);
  const writes = new Map<string, string>();
  const retainedBindings: HarnestProjectBinding[] = [];
  for (const binding of project.manifest.bindings ?? []) {
    let component;
    try {
      component = targetComponent(source, binding);
    } catch (error) {
      if (error instanceof HarnestProjectError
        && (error.code === "PROJECT_BINDING_COMPONENT" || error.code === "PROJECT_BINDING_GRAPH")) continue;
      throw error;
    }
    retainedBindings.push(binding);
    if (binding.kind === "prompt") {
      if (component.type !== "prompt" || typeof component.config.template !== "string") throw new HarnestProjectError(
        "PROJECT_BINDING_TYPE", `$.${PROJECT_ROOT}.${binding.path}`, "Prompt binding no longer targets a Prompt component",
      );
      writes.set(binding.path, component.config.template);
      component.config = { ...component.config, template: `Project prompt: ${PROJECT_ROOT}/${binding.path}\n\n{{input}}` };
    } else if (binding.kind === "schema") {
      if (component.type !== "output" || !component.config.schema || typeof component.config.schema !== "object") {
        throw new HarnestProjectError(
          "PROJECT_BINDING_TYPE", `$.${PROJECT_ROOT}.${binding.path}`, "Schema binding requires an Output JSON Schema",
        );
      }
      writes.set(binding.path, `${JSON.stringify(component.config.schema, null, 2)}\n`);
      component.config = { ...component.config, format: "json" };
      delete component.config.schema;
    }
  }
  if (retainedBindings.length !== (project.manifest.bindings?.length ?? 0)) {
    const manifest: HarnestProjectManifest = { ...project.manifest, bindings: retainedBindings };
    if (!retainedBindings.length) delete manifest.bindings;
    writes.set(PROJECT_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  if (project.manifest.tests?.length) {
    writes.set(project.manifest.tests[0]!, `${JSON.stringify(spec.tests ?? [], null, 2)}\n`);
    for (const path of project.manifest.tests.slice(1)) writes.set(path, "[]\n");
    delete source.tests;
  }
  if (project.manifest.studio) {
    writes.set(project.manifest.studio, `${JSON.stringify(spec.studio ?? { positions: {} }, null, 2)}\n`);
    delete source.studio;
  }

  const previous = new Map<string, string>();
  const sourceYaml = stringifySpec(source);
  try {
    previous.set(file, await readFile(/* turbopackIgnore: true */ file, "utf8"));
    for (const [path, content] of writes) {
      const entry = await verifiedProjectEntry(project, path);
      if (!entry.info.isFile()) throw new HarnestProjectError(
        "PROJECT_ASSET_TYPE", `$.${PROJECT_ROOT}.${path}`, `Project asset '${path}' must be a regular file`,
      );
      previous.set(entry.path, await readFile(entry.path, "utf8"));
      await atomicWriteVerifiedFile(entry.path, project.hiddenDirectory, content);
    }
    await atomicWriteVerifiedFile(file, project.projectDirectory, sourceYaml);
    const reloaded = await loadHarnestProjectSpec(file);
    if (!reloaded.ok || stringifySpec(reloaded.spec) !== stringifySpec(spec)) throw new HarnestProjectError(
      "PROJECT_SAVE_INVALID",
      `$.${PROJECT_ROOT}.${PROJECT_FILE}`,
      reloaded.ok ? "Saved project did not reproduce the requested Harness" : reloaded.diagnostics.map((item) => item.message).join("; "),
    );
  } catch (error) {
    for (const [path, content] of previous) {
      await atomicWriteVerifiedFile(path, path === file ? project.projectDirectory : project.hiddenDirectory, content).catch(() => undefined);
    }
    throw error;
  }
}
