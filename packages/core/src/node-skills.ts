import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  SKILL_NAME_PATTERN,
  parseSkillDocument,
  splitSkillDocument,
  type SkillDescriptor,
} from "./skill.js";

export type SkillScope = "project" | "user";
export type SkillNamespace = "agents" | "harnest";

export type SkillStoreErrorCode =
  | "SKILL_NOT_FOUND"
  | "SKILL_CATALOG_INVALID"
  | "SKILL_READ_LIMIT"
  | "SKILL_RESOURCE_INVALID"
  | "SKILL_RESOURCE_OUTSIDE_ROOT"
  | "SKILL_SCRIPT_APPROVAL_REQUIRED"
  | "SKILL_INSTALL_INVALID"
  | "SKILL_INSTALL_EXISTS"
  | "SKILL_INSTALL_APPROVAL_REQUIRED"
  | "SKILL_INSTALL_PROVIDER_REQUIRED";

export class SkillStoreError extends Error {
  readonly code: SkillStoreErrorCode;
  readonly skill?: string;
  readonly resource?: string;

  constructor(
    code: SkillStoreErrorCode,
    message: string,
    details: { readonly skill?: string; readonly resource?: string } = {},
  ) {
    super(message);
    this.name = "SkillStoreError";
    this.code = code;
    if (details.skill !== undefined) this.skill = details.skill;
    if (details.resource !== undefined) this.resource = details.resource;
  }
}

interface SkillProvenanceBase {
  readonly installedAt?: string;
  readonly contentHash?: string;
}

export interface LocalSkillProvenance extends SkillProvenanceBase {
  readonly kind: "local";
  readonly source: string;
}

export interface GitSkillProvenance extends SkillProvenanceBase {
  readonly kind: "git";
  readonly repository: string;
  readonly commit: string;
}

export interface PackageSkillProvenance extends SkillProvenanceBase {
  readonly kind: "package";
  readonly package: string;
  readonly version: string;
  readonly integrity: string;
}

export type SkillProvenance = LocalSkillProvenance | GitSkillProvenance | PackageSkillProvenance;

type UnhashedSkillProvenance =
  | Omit<LocalSkillProvenance, "contentHash" | "installedAt">
  | Omit<GitSkillProvenance, "contentHash" | "installedAt">
  | Omit<PackageSkillProvenance, "contentHash" | "installedAt">;

export interface SkillCatalogEntry {
  readonly name: string;
  readonly description: string;
  readonly descriptor: SkillDescriptor;
  readonly scope: SkillScope;
  readonly namespace: SkillNamespace;
  readonly directory: string;
  readonly scriptsPresent: boolean;
  readonly scriptTrust: "not-required" | "approval-required";
  readonly provenance: SkillProvenance;
  readonly provenanceVerified: boolean;
}

export interface SkillCatalog {
  readonly skills: readonly SkillCatalogEntry[];
  readonly warnings: readonly string[];
}

export interface ActivatedSkill {
  readonly descriptor: SkillDescriptor;
  readonly body: string;
  readonly scope: SkillScope;
  readonly namespace: SkillNamespace;
  readonly provenance: SkillProvenance;
  readonly provenanceVerified: boolean;
  readonly documentHash: string;
  readonly scriptsPresent: boolean;
  readonly scriptTrust: "not-required" | "approval-required";
}

export interface SkillResource {
  readonly skill: string;
  readonly path: string;
  readonly content: string | Uint8Array;
  readonly bytes: number;
  readonly sha256: string;
  readonly script: boolean;
  readonly trusted: boolean;
}

export interface ScriptTrustRequest {
  readonly skill: SkillCatalogEntry;
  readonly resource: string;
  readonly sha256: string;
}

export interface GitSkillInstallSource {
  readonly kind: "git";
  readonly repository: string;
  /** Exact immutable Git object ID. Branches and tags are intentionally not accepted. */
  readonly commit: string;
}

export interface PackageSkillInstallSource {
  readonly kind: "package";
  readonly package: string;
  /** Exact version, never a range or dist-tag. */
  readonly version: string;
  /** Registry integrity supplied for the exact package archive. */
  readonly integrity: string;
}

export interface LocalSkillInstallSource {
  readonly kind: "local";
  readonly directory: string;
}

export type SkillInstallSource =
  | LocalSkillInstallSource
  | GitSkillInstallSource
  | PackageSkillInstallSource;

export interface SkillInstallApproval {
  /** Must exactly equal `skillInstallSourceKey(source)`. */
  readonly sourceKey: string;
}

export interface InstallSkillOptions {
  readonly scope: SkillScope;
  readonly namespace?: SkillNamespace;
  readonly approval?: SkillInstallApproval;
}

export interface LoadSkillResourceOptions {
  readonly encoding?: "utf8" | "bytes";
}

export interface NodeSkillStoreOptions {
  readonly projectDirectory: string;
  readonly userDirectory?: string;
  readonly maxFrontmatterBytes?: number;
  readonly maxSkillBytes?: number;
  readonly maxResourceBytes?: number;
  readonly maxInstallBytes?: number;
  readonly maxInstallFiles?: number;
  readonly maxProvenanceFiles?: number;
  readonly maxProvenanceTotalBytes?: number;
  readonly maxProvenanceFileBytes?: number;
  readonly maxProvenanceDepth?: number;
  /** No callback means scripts remain inaccessible. */
  readonly authorizeScript?: (request: ScriptTrustRequest) => boolean | Promise<boolean>;
  /** Network/package tooling stays outside core; the callback must materialize the pinned source locally. */
  readonly materializeRemote?: (
    source: GitSkillInstallSource | PackageSkillInstallSource,
  ) => string | Promise<string>;
}

const PROVENANCE_FILE = ".harnest-provenance.json";
const RESOURCE_ROOTS = new Set(["assets", "references", "scripts"]);
const SHA256 = /^sha256-[a-f0-9]{64}$/;
const GIT_COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const EXACT_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PACKAGE_INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/;

const isInside = (root: string, target: string): boolean => {
  const path = relative(root, target);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

const isMissing = (error: unknown): boolean =>
  error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";

const boundedInteger = (value: number | undefined, fallback: number, maximum: number): number =>
  Math.min(Math.max(1, Math.floor(value ?? fallback)), maximum);

const sha256 = (content: Uint8Array): string =>
  `sha256-${createHash("sha256").update(content).digest("hex")}`;

function validateGitSource(source: GitSkillInstallSource): void {
  let repository: URL;
  try {
    repository = new URL(source.repository);
  } catch {
    throw new SkillStoreError("SKILL_INSTALL_INVALID", "Git skill repository must be an HTTPS URL");
  }
  if (repository.protocol !== "https:" || repository.username || repository.password || repository.hash) {
    throw new SkillStoreError("SKILL_INSTALL_INVALID", "Git skill repository must be an HTTPS URL without credentials or fragments");
  }
  if (!GIT_COMMIT.test(source.commit)) {
    throw new SkillStoreError("SKILL_INSTALL_INVALID", "Git skill installs require an exact 40- or 64-character object ID");
  }
}

function validatePackageSource(source: PackageSkillInstallSource): void {
  if (!PACKAGE_NAME.test(source.package) || !EXACT_VERSION.test(source.version)
    || !PACKAGE_INTEGRITY.test(source.integrity)) {
    throw new SkillStoreError(
      "SKILL_INSTALL_INVALID",
      "Package skill installs require a valid package name, exact version, and sha512 integrity",
    );
  }
}

export function skillInstallSourceKey(source: GitSkillInstallSource | PackageSkillInstallSource): string {
  if (source.kind === "git") {
    validateGitSource(source);
    return `git:${new URL(source.repository).href}#${source.commit.toLocaleLowerCase()}`;
  }
  validatePackageSource(source);
  return `package:${source.package}@${source.version}:${source.integrity}`;
}

async function readFrontmatterOnly(file: string, maximum: number): Promise<string> {
  const handle = await open(file, "r");
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (total < maximum) {
      const buffer = Buffer.alloc(Math.min(4_096, maximum - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      total += bytesRead;
      const candidate = Buffer.concat(chunks).toString("utf8");
      try {
        const sliced = splitSkillDocument(candidate);
        return `---\n${sliced.yaml}---\n`;
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error)
          || error.code !== "SKILL_FRONTMATTER_MISSING") throw error;
      }
    }
  } finally {
    await handle.close();
  }
  throw new SkillStoreError(
    "SKILL_READ_LIMIT",
    `Skill frontmatter has no closing delimiter within ${maximum} bytes`,
  );
}

async function readBounded(file: string, maximum: number): Promise<Buffer> {
  const info = await stat(file);
  if (!info.isFile()) throw new SkillStoreError("SKILL_RESOURCE_INVALID", "Skill resource is not a regular file");
  if (info.size > maximum) {
    throw new SkillStoreError("SKILL_READ_LIMIT", `Skill file exceeds the ${maximum}-byte limit`);
  }
  const content = await readFile(file);
  if (content.byteLength > maximum) {
    throw new SkillStoreError("SKILL_READ_LIMIT", `Skill file exceeds the ${maximum}-byte limit`);
  }
  return content;
}

interface RootCandidate {
  readonly base: string;
  readonly scope: SkillScope;
  readonly namespace: SkillNamespace;
}

interface PersistedProvenance {
  readonly kind: SkillProvenance["kind"];
  readonly source?: string;
  readonly repository?: string;
  readonly commit?: string;
  readonly package?: string;
  readonly version?: string;
  readonly integrity?: string;
  readonly installedAt?: string;
  readonly contentHash?: string;
}

function parsedProvenance(value: unknown, fallback: LocalSkillProvenance): SkillProvenance {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fallback;
  const record = value as PersistedProvenance;
  const common = {
    ...(typeof record.installedAt === "string" ? { installedAt: record.installedAt } : {}),
    ...(typeof record.contentHash === "string" && SHA256.test(record.contentHash)
      ? { contentHash: record.contentHash }
      : {}),
  };
  if (record.kind === "local" && typeof record.source === "string") {
    return { kind: "local", source: record.source, ...common };
  }
  if (record.kind === "git" && typeof record.repository === "string" && typeof record.commit === "string") {
    try {
      validateGitSource({ kind: "git", repository: record.repository, commit: record.commit });
      return { kind: "git", repository: record.repository, commit: record.commit, ...common };
    } catch {
      return fallback;
    }
  }
  if (record.kind === "package" && typeof record.package === "string"
    && typeof record.version === "string" && typeof record.integrity === "string") {
    try {
      validatePackageSource({
        kind: "package",
        package: record.package,
        version: record.version,
        integrity: record.integrity,
      });
      return {
        kind: "package",
        package: record.package,
        version: record.version,
        integrity: record.integrity,
        ...common,
      };
    } catch {
      return fallback;
    }
  }
  return fallback;
}

interface SkillHashLimits {
  readonly maxFiles: number;
  readonly maxTotalBytes: number;
  readonly maxPerFile: number;
  readonly maxDepth: number;
}

interface SkillHashState {
  files: number;
  totalBytes: number;
}

async function skillTreeHash(root: string, limits: SkillHashLimits): Promise<string> {
  const hash = createHash("sha256");
  const state: SkillHashState = { files: 0, totalBytes: 0 };
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > limits.maxDepth) throw new SkillStoreError(
      "SKILL_READ_LIMIT", `Skill provenance traversal exceeds depth ${limits.maxDepth}`,
    );
    const entries: Dirent[] = [];
    const opened = await opendir(directory);
    for await (const entry of opened) {
      if (entry.name === PROVENANCE_FILE) continue;
      state.files += 1;
      if (state.files > limits.maxFiles) throw new SkillStoreError(
        "SKILL_READ_LIMIT", `Skill provenance traversal exceeds ${limits.maxFiles} entries`,
      );
      entries.push(entry);
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new SkillStoreError("SKILL_CATALOG_INVALID", "Skill trees cannot contain symbolic links");
      const path = join(directory, entry.name);
      const canonical = await realpath(path);
      if (!isInside(root, canonical)) throw new SkillStoreError("SKILL_CATALOG_INVALID", "Skill entry resolves outside its root");
      if (entry.isDirectory()) {
        await visit(canonical, depth + 1);
      } else if (entry.isFile()) {
        const handle = await open(canonical, "r");
        let size = 0;
        try {
          const info = await handle.stat();
          if (!info.isFile()) throw new SkillStoreError("SKILL_CATALOG_INVALID", "Skill trees may contain only regular files");
          if (info.size > limits.maxPerFile) throw new SkillStoreError(
            "SKILL_READ_LIMIT", `Skill provenance file exceeds ${limits.maxPerFile} bytes`,
          );
          if (state.totalBytes + info.size > limits.maxTotalBytes) throw new SkillStoreError(
            "SKILL_READ_LIMIT", `Skill provenance traversal exceeds ${limits.maxTotalBytes} bytes`,
          );
          const relativePath = relative(root, canonical).split(sep).join("/");
          hash.update(relativePath).update("\0").update(String(info.size)).update("\0");
          const stream = handle.createReadStream({ autoClose: false });
          for await (const chunk of stream) {
            const content = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += content.byteLength;
            if (size > limits.maxPerFile || state.totalBytes + size > limits.maxTotalBytes) {
              throw new SkillStoreError("SKILL_READ_LIMIT", "Skill provenance data changed beyond its byte limit while hashing");
            }
            hash.update(content);
          }
          if (size !== info.size) throw new SkillStoreError(
            "SKILL_CATALOG_INVALID", "Skill provenance data changed while it was being hashed",
          );
          state.totalBytes += size;
        } finally {
          await handle.close();
        }
      } else {
        throw new SkillStoreError("SKILL_CATALOG_INVALID", "Skill trees may contain only regular files and directories");
      }
    }
  };
  await visit(root, 0);
  return `sha256-${hash.digest("hex")}`;
}

interface ProvenanceResult {
  readonly provenance: SkillProvenance;
  readonly verified: boolean;
  readonly warning?: string;
}

async function provenanceFor(directory: string): Promise<ProvenanceResult> {
  const fallback: LocalSkillProvenance = { kind: "local", source: directory };
  const file = join(directory, PROVENANCE_FILE);
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if (isMissing(error)) return { provenance: fallback, verified: false };
    return {
      provenance: fallback,
      verified: false,
      warning: `provenance metadata cannot be inspected: ${error instanceof Error ? error.message : "unknown error"}`,
    };
  }
  if (!info.isFile() || info.isSymbolicLink()) return {
    provenance: fallback,
    verified: false,
    warning: "provenance metadata is not a regular, non-symbolic-link file",
  };
  let provenance: SkillProvenance;
  try {
    const content = await readBounded(file, 16_384);
    provenance = parsedProvenance(JSON.parse(content.toString("utf8")) as unknown, fallback);
  } catch (error) {
    return {
      provenance: fallback,
      verified: false,
      warning: `provenance metadata cannot be read: ${error instanceof Error ? error.message : "unknown error"}`,
    };
  }
  return { provenance, verified: false };
}

async function verifiedProvenanceFor(
  directory: string,
  limits: SkillHashLimits,
): Promise<ProvenanceResult> {
  const result = await provenanceFor(directory);
  if (result.warning !== undefined) {
    throw new SkillStoreError("SKILL_CATALOG_INVALID", `Skill provenance cannot be verified: ${result.warning}`);
  }
  if (result.provenance.contentHash === undefined) return result;
  if (result.provenance.contentHash !== await skillTreeHash(directory, limits)) {
    throw new SkillStoreError("SKILL_CATALOG_INVALID", "Skill provenance content hash does not match the skill tree");
  }
  return { provenance: result.provenance, verified: true };
}

async function scriptsPresent(directory: string): Promise<boolean> {
  try {
    const info = await lstat(join(directory, "scripts"));
    return info.isDirectory() && !info.isSymbolicLink();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

interface CopyLimits {
  readonly maxBytes: number;
  readonly maxFiles: number;
}

interface CopyState {
  bytes: number;
  files: number;
  readonly hash: ReturnType<typeof createHash>;
}

async function copySkillTree(
  sourceRoot: string,
  source: string,
  destination: string,
  limits: CopyLimits,
  state: CopyState,
): Promise<void> {
  const entries = await readdir(source, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.name === PROVENANCE_FILE) continue;
    if (entry.isSymbolicLink()) {
      throw new SkillStoreError("SKILL_INSTALL_INVALID", `Skill install rejects symbolic link '${entry.name}'`);
    }
    const sourcePath = join(source, entry.name);
    const sourceCanonical = await realpath(sourcePath);
    if (!isInside(sourceRoot, sourceCanonical)) {
      throw new SkillStoreError("SKILL_INSTALL_INVALID", `Skill entry '${entry.name}' resolves outside its source`);
    }
    const destinationPath = join(destination, entry.name);
    if (entry.isDirectory()) {
      await mkdir(destinationPath, { mode: 0o700 });
      await copySkillTree(sourceRoot, sourceCanonical, destinationPath, limits, state);
      continue;
    }
    if (!entry.isFile()) {
      throw new SkillStoreError("SKILL_INSTALL_INVALID", `Skill entry '${entry.name}' is not a regular file`);
    }
    state.files += 1;
    const info = await stat(sourceCanonical);
    const content = await readFile(sourceCanonical);
    state.bytes += content.byteLength;
    if (state.files > limits.maxFiles || state.bytes > limits.maxBytes || content.byteLength > limits.maxBytes) {
      throw new SkillStoreError("SKILL_READ_LIMIT", "Skill install exceeds its file or byte limit");
    }
    const path = relative(sourceRoot, sourceCanonical).split(sep).join("/");
    state.hash.update(path).update("\0").update(String(content.byteLength)).update("\0").update(content);
    await writeFile(destinationPath, content, { mode: info.mode & 0o777 });
  }
}

async function containedDirectory(base: string, target: string): Promise<string> {
  if (!isInside(base, target)) throw new SkillStoreError("SKILL_INSTALL_INVALID", "Skill install path is outside its scope");
  const segments = relative(base, target).split(sep).filter(Boolean);
  let current = base;
  for (const segment of segments) {
    const next = join(current, segment);
    try {
      const info = await lstat(next);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new SkillStoreError("SKILL_INSTALL_INVALID", `Skill install directory '${segment}' is unsafe`);
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
      await mkdir(next, { mode: 0o700 });
    }
    current = await realpath(next);
    if (!isInside(base, current)) throw new SkillStoreError("SKILL_INSTALL_INVALID", "Skill install directory escapes its scope");
  }
  return current;
}

function normalizedResourcePath(path: string): string {
  if (path.length === 0 || path.length > 512 || isAbsolute(path) || path.includes("\\") || path.includes("\0")) {
    throw new SkillStoreError("SKILL_RESOURCE_INVALID", "Skill resource path must be a bounded POSIX-style relative path");
  }
  const segments = path.split("/");
  if (!RESOURCE_ROOTS.has(segments[0] ?? "")
    || segments.some((segment) => segment.length === 0 || segment === "." || segment === ".." || segment.startsWith("."))) {
    throw new SkillStoreError(
      "SKILL_RESOURCE_INVALID",
      "Skill resources must be requested from assets/, references/, or scripts/ without traversal",
    );
  }
  return segments.join("/");
}

export class NodeSkillStore {
  readonly #options: NodeSkillStoreOptions;
  readonly #projectRoot: Promise<string>;
  readonly #userRoot: Promise<string>;

  constructor(options: NodeSkillStoreOptions) {
    this.#options = options;
    this.#projectRoot = realpath(resolve(options.projectDirectory));
    this.#userRoot = realpath(resolve(options.userDirectory ?? homedir()));
  }

  async catalog(): Promise<SkillCatalog> {
    const candidates = await this.#rootCandidates();
    const winners = new Map<string, SkillCatalogEntry>();
    const warnings: string[] = [];
    for (const candidate of candidates) {
      const root = resolve(candidate.base, `.${candidate.namespace}`, "skills");
      let canonicalRoot: string;
      try {
        canonicalRoot = await realpath(root);
      } catch (error) {
        if (isMissing(error)) continue;
        warnings.push(`Cannot inspect skill root '${root}': ${error instanceof Error ? error.message : "unknown error"}`);
        continue;
      }
      if (!isInside(candidate.base, canonicalRoot)) {
        warnings.push(`Skill root '${root}' resolves outside its ${candidate.scope} directory`);
        continue;
      }
      let entries;
      try {
        entries = await readdir(canonicalRoot, { withFileTypes: true });
      } catch (error) {
        warnings.push(`Cannot list skill root '${root}': ${error instanceof Error ? error.message : "unknown error"}`);
        continue;
      }
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        try {
          const skillDirectory = await realpath(join(canonicalRoot, entry.name));
          if (!isInside(canonicalRoot, skillDirectory)) {
            throw new SkillStoreError("SKILL_CATALOG_INVALID", "Skill directory resolves outside its catalog root");
          }
          const documentPath = join(skillDirectory, "SKILL.md");
          const documentInfo = await lstat(documentPath);
          if (!documentInfo.isFile() || documentInfo.isSymbolicLink()) {
            throw new SkillStoreError("SKILL_CATALOG_INVALID", "SKILL.md must be a regular, non-symbolic-link file");
          }
          const frontmatter = await readFrontmatterOnly(
            documentPath,
            boundedInteger(this.#options.maxFrontmatterBytes, 65_536, 262_144),
          );
          const parsed = parseSkillDocument(frontmatter, { directoryName: entry.name });
          const hasScripts = await scriptsPresent(skillDirectory);
          const provenance = await provenanceFor(skillDirectory);
          if (provenance.warning !== undefined) {
            warnings.push(`Skill '${parsed.descriptor.name}' provenance is unverified: ${provenance.warning}`);
          }
          const catalogEntry: SkillCatalogEntry = {
            name: parsed.descriptor.name,
            description: parsed.descriptor.description,
            descriptor: parsed.descriptor,
            scope: candidate.scope,
            namespace: candidate.namespace,
            directory: skillDirectory,
            scriptsPresent: hasScripts,
            scriptTrust: hasScripts ? "approval-required" : "not-required",
            provenance: provenance.provenance,
            provenanceVerified: provenance.verified,
          };
          const shadowed = winners.get(catalogEntry.name);
          if (shadowed) {
            warnings.push(
              `Skill '${catalogEntry.name}' from ${shadowed.scope}/.${shadowed.namespace} is shadowed by ${catalogEntry.scope}/.${catalogEntry.namespace}`,
            );
          }
          winners.set(catalogEntry.name, catalogEntry);
        } catch (error) {
          warnings.push(
            `Ignoring skill '${entry.name}' in '${root}': ${error instanceof Error ? error.message : "invalid skill"}`,
          );
        }
      }
    }
    return {
      skills: [...winners.values()].sort((left, right) => left.name.localeCompare(right.name)),
      warnings,
    };
  }

  async activate(name: string): Promise<ActivatedSkill> {
    const entry = await this.#verifiedEntry(await this.#find(name));
    const content = await readBounded(
      join(entry.directory, "SKILL.md"),
      boundedInteger(this.#options.maxSkillBytes, 524_288, 4_194_304),
    );
    const parsed = parseSkillDocument(content.toString("utf8"), { directoryName: entry.name });
    return {
      descriptor: parsed.descriptor,
      body: parsed.body,
      scope: entry.scope,
      namespace: entry.namespace,
      provenance: entry.provenance,
      provenanceVerified: entry.provenanceVerified,
      documentHash: sha256(content),
      scriptsPresent: entry.scriptsPresent,
      scriptTrust: entry.scriptTrust,
    };
  }

  async loadResource(
    name: string,
    requestedPath: string,
    options: LoadSkillResourceOptions = {},
  ): Promise<SkillResource> {
    const entry = await this.#verifiedEntry(await this.#find(name));
    const resourcePath = normalizedResourcePath(requestedPath);
    const root = await realpath(entry.directory);
    let target: string;
    try {
      target = await realpath(resolve(root, resourcePath));
    } catch (error) {
      if (isMissing(error)) {
        throw new SkillStoreError(
          "SKILL_RESOURCE_INVALID",
          `Skill resource '${resourcePath}' does not exist`,
          { skill: name, resource: resourcePath },
        );
      }
      throw error;
    }
    if (!isInside(root, target)) {
      throw new SkillStoreError(
        "SKILL_RESOURCE_OUTSIDE_ROOT",
        `Skill resource '${resourcePath}' resolves outside the skill`,
        { skill: name, resource: resourcePath },
      );
    }
    const linkInfo = await lstat(resolve(root, resourcePath));
    if (linkInfo.isSymbolicLink() || !linkInfo.isFile()) {
      throw new SkillStoreError(
        "SKILL_RESOURCE_INVALID",
        `Skill resource '${resourcePath}' must be a regular, non-symbolic-link file`,
        { skill: name, resource: resourcePath },
      );
    }
    const content = await readBounded(
      target,
      boundedInteger(this.#options.maxResourceBytes, 1_048_576, 8_388_608),
    );
    const digest = sha256(content);
    const script = resourcePath.startsWith("scripts/");
    let trusted = !script && entry.provenanceVerified;
    if (script) {
      trusted = this.#options.authorizeScript === undefined
        ? false
        : await this.#options.authorizeScript({ skill: entry, resource: resourcePath, sha256: digest });
      if (!trusted) {
        throw new SkillStoreError(
          "SKILL_SCRIPT_APPROVAL_REQUIRED",
          `Skill script '${resourcePath}' requires approval for ${digest}`,
          { skill: name, resource: resourcePath },
        );
      }
    }
    return {
      skill: name,
      path: resourcePath,
      content: options.encoding === "bytes" ? content : content.toString("utf8"),
      bytes: content.byteLength,
      sha256: digest,
      script,
      trusted,
    };
  }

  async install(source: SkillInstallSource, options: InstallSkillOptions): Promise<SkillCatalogEntry> {
    const namespace = options.namespace ?? "harnest";
    if ((options.scope !== "project" && options.scope !== "user")
      || (namespace !== "agents" && namespace !== "harnest")) {
      throw new SkillStoreError("SKILL_INSTALL_INVALID", "Skill scope or namespace is invalid");
    }
    let materialized: string;
    let provenance: UnhashedSkillProvenance;
    if (source.kind === "local") {
      materialized = source.directory;
      provenance = { kind: "local", source: resolve(source.directory) };
    } else {
      const key = skillInstallSourceKey(source);
      if (options.approval?.sourceKey !== key) {
        throw new SkillStoreError(
          "SKILL_INSTALL_APPROVAL_REQUIRED",
          `Remote skill install requires approval bound to '${key}'`,
        );
      }
      if (this.#options.materializeRemote === undefined) {
        throw new SkillStoreError(
          "SKILL_INSTALL_PROVIDER_REQUIRED",
          "Remote skill installation requires an explicitly configured pinned-source materializer",
        );
      }
      materialized = await this.#options.materializeRemote(source);
      provenance = source.kind === "git"
        ? { kind: "git", repository: source.repository, commit: source.commit }
        : {
            kind: "package",
            package: source.package,
            version: source.version,
            integrity: source.integrity,
          };
    }
    const sourceRoot = await realpath(resolve(materialized));
    if (!(await stat(sourceRoot)).isDirectory()) {
      throw new SkillStoreError("SKILL_INSTALL_INVALID", "Skill install source must be a directory");
    }
    const directoryName = basename(sourceRoot);
    const documentInfo = await lstat(join(sourceRoot, "SKILL.md"));
    if (!documentInfo.isFile() || documentInfo.isSymbolicLink()) {
      throw new SkillStoreError("SKILL_INSTALL_INVALID", "Skill install source requires a regular SKILL.md file");
    }
    const document = await readBounded(
      join(sourceRoot, "SKILL.md"),
      boundedInteger(this.#options.maxSkillBytes, 524_288, 4_194_304),
    );
    const parsed = parseSkillDocument(document.toString("utf8"), { directoryName });
    if (!SKILL_NAME_PATTERN.test(parsed.descriptor.name)) {
      throw new SkillStoreError("SKILL_INSTALL_INVALID", "Skill install name is invalid");
    }

    const base = options.scope === "project" ? await this.#projectRoot : await this.#userRoot;
    const installRoot = resolve(base, `.${namespace}`, "skills");
    const canonicalInstallRoot = await containedDirectory(base, installRoot);
    const destination = resolve(canonicalInstallRoot, parsed.descriptor.name);
    if (!isInside(canonicalInstallRoot, destination)) {
      throw new SkillStoreError("SKILL_INSTALL_INVALID", "Skill install destination is invalid");
    }
    try {
      await lstat(destination);
      throw new SkillStoreError(
        "SKILL_INSTALL_EXISTS",
        `Skill '${parsed.descriptor.name}' already exists in ${options.scope}/.${namespace}`,
        { skill: parsed.descriptor.name },
      );
    } catch (error) {
      if (!isMissing(error)) throw error;
    }

    const temporary = resolve(canonicalInstallRoot, `.${parsed.descriptor.name}.${randomUUID()}.tmp`);
    const state: CopyState = { bytes: 0, files: 0, hash: createHash("sha256") };
    try {
      await mkdir(temporary, { mode: 0o700 });
      await copySkillTree(
        sourceRoot,
        sourceRoot,
        temporary,
        {
          maxBytes: boundedInteger(this.#options.maxInstallBytes, 16_777_216, 134_217_728),
          maxFiles: boundedInteger(this.#options.maxInstallFiles, 256, 4_096),
        },
        state,
      );
      const installedAt = new Date().toISOString();
      const contentHash = `sha256-${state.hash.digest("hex")}`;
      const persisted: SkillProvenance = { ...provenance, installedAt, contentHash };
      await writeFile(join(temporary, PROVENANCE_FILE), `${JSON.stringify(persisted, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, destination);
      const hasScripts = await scriptsPresent(destination);
      return {
        name: parsed.descriptor.name,
        description: parsed.descriptor.description,
        descriptor: parsed.descriptor,
        scope: options.scope,
        namespace,
        directory: destination,
        scriptsPresent: hasScripts,
        scriptTrust: hasScripts ? "approval-required" : "not-required",
        provenance: persisted,
        provenanceVerified: true,
      };
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async #find(name: string): Promise<SkillCatalogEntry> {
    if (!SKILL_NAME_PATTERN.test(name)) {
      throw new SkillStoreError("SKILL_NOT_FOUND", `Skill '${name}' is not valid`, { skill: name });
    }
    const catalog = await this.catalog();
    const entry = catalog.skills.find((candidate) => candidate.name === name);
    if (!entry) throw new SkillStoreError("SKILL_NOT_FOUND", `Skill '${name}' is not installed`, { skill: name });
    return entry;
  }

  async #verifiedEntry(entry: SkillCatalogEntry): Promise<SkillCatalogEntry> {
    const result = await verifiedProvenanceFor(entry.directory, {
      maxFiles: boundedInteger(this.#options.maxProvenanceFiles, 4_096, 65_536),
      maxTotalBytes: boundedInteger(this.#options.maxProvenanceTotalBytes, 67_108_864, 536_870_912),
      maxPerFile: boundedInteger(this.#options.maxProvenanceFileBytes, 8_388_608, 67_108_864),
      maxDepth: boundedInteger(this.#options.maxProvenanceDepth, 32, 128),
    });
    return { ...entry, provenance: result.provenance, provenanceVerified: result.verified };
  }

  async #rootCandidates(): Promise<readonly RootCandidate[]> {
    const [project, user] = await Promise.all([this.#projectRoot, this.#userRoot]);
    // Later entries override earlier entries. Project wins user; .harnest wins .agents within a scope.
    return [
      { base: user, scope: "user", namespace: "agents" },
      { base: user, scope: "user", namespace: "harnest" },
      { base: project, scope: "project", namespace: "agents" },
      { base: project, scope: "project", namespace: "harnest" },
    ];
  }
}
