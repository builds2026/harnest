import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { guardedFetch } from "./node-connections.js";
import {
  SkillStoreError,
  skillInstallSourceKey,
  type GitSkillInstallSource,
  type PackageSkillInstallSource,
} from "./node-skills.js";

type RemoteSkillSource = GitSkillInstallSource | PackageSkillInstallSource;
type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type UnresolvedRemoteSkillSource =
  | { readonly kind: "git"; readonly repository: string; readonly commit?: string }
  | { readonly kind: "package"; readonly package: string; readonly version?: string; readonly integrity?: string };

export interface RemoteSkillMaterialization {
  readonly directory: string;
  cleanup(): Promise<void>;
}

interface ArchiveEntry {
  readonly path: string;
  readonly directory: boolean;
  readonly content: Buffer;
}

const GIT_COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const MAX_ARCHIVE_BYTES = 32 * 1_048_576;
const MAX_EXTRACTED_BYTES = 128 * 1_048_576;
const MAX_ARCHIVE_FILES = 4_096;

const error = (message: string, cause?: unknown): SkillStoreError => {
  const result = new SkillStoreError("SKILL_INSTALL_INVALID", message);
  if (cause !== undefined) result.cause = cause;
  return result;
};

async function json(response: Response, label: string): Promise<Record<string, unknown>> {
  if (!response.ok) throw error(`${label} returned HTTP ${response.status}`);
  try {
    const value = await response.json() as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch (cause) {
    throw error(`${label} returned invalid JSON`, cause);
  }
}

function gitHost(repository: string): { api: URL; archive(commit: string): URL } {
  let url: URL;
  try {
    url = new URL(repository);
  } catch {
    throw error("Git skill repository must be a GitHub or GitLab HTTPS URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw error("Git skill repository must be a credential-free HTTPS URL");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (url.hostname === "github.com" && parts.length === 2) {
    const owner = parts[0]!;
    const repositoryName = parts[1]!.replace(/\.git$/i, "");
    if (!owner || !repositoryName) throw error("GitHub repository URL is invalid");
    return {
      api: new URL(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repositoryName)}/commits/HEAD`),
      archive: (commit) => new URL(`https://codeload.github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repositoryName)}/tar.gz/${commit}`),
    };
  }
  if (url.hostname === "gitlab.com" && parts.length >= 2) {
    const path = parts.join("/").replace(/\.git$/i, "");
    return {
      api: new URL(`https://gitlab.com/api/v4/projects/${encodeURIComponent(path)}/repository/commits/HEAD`),
      archive: (commit) => new URL(`https://gitlab.com/api/v4/projects/${encodeURIComponent(path)}/repository/archive.tar.gz?sha=${commit}`),
    };
  }
  throw error("Remote Skill install currently supports github.com and gitlab.com; use a local folder for other Git hosts");
}

export async function resolveRemoteSkillSource(
  source: UnresolvedRemoteSkillSource,
  fetch: Fetch = guardedFetch(true, { timeoutMs: 30_000, maxResponseBytes: 2 * 1_048_576 }),
): Promise<RemoteSkillSource> {
  if (source.kind === "git") {
    const host = gitHost(source.repository);
    let commit = source.commit?.trim();
    if (!commit) {
      const metadata = await json(await fetch(host.api, {
        headers: { accept: "application/json", "user-agent": "Harnest Skill Installer" },
        redirect: "error",
      }), "Git repository metadata");
      commit = typeof metadata.sha === "string" ? metadata.sha
        : typeof metadata.id === "string" ? metadata.id : undefined;
    }
    if (!commit || !GIT_COMMIT.test(commit)) throw error("Git repository did not resolve to an exact commit object ID");
    const resolved: GitSkillInstallSource = { kind: "git", repository: new URL(source.repository).href, commit };
    skillInstallSourceKey(resolved);
    return resolved;
  }

  if (!PACKAGE_NAME.test(source.package)) throw error("npm Skill package name is invalid");
  const requestedVersion = source.version?.trim() || "latest";
  const endpoint = new URL(`https://registry.npmjs.org/${encodeURIComponent(source.package)}/${encodeURIComponent(requestedVersion)}`);
  const metadata = await json(await fetch(endpoint, {
    headers: { accept: "application/json", "user-agent": "Harnest Skill Installer" },
    redirect: "error",
  }), "npm registry metadata");
  const dist = metadata.dist;
  const version = metadata.version;
  if (!dist || typeof dist !== "object" || Array.isArray(dist) || typeof version !== "string") {
    throw error("npm registry metadata has no exact version archive");
  }
  const integrity = (dist as Record<string, unknown>).integrity;
  if (typeof integrity !== "string") throw error("npm registry metadata has no sha512 archive integrity");
  if (source.integrity && source.integrity !== integrity) throw error("Provided npm integrity does not match registry metadata");
  const resolved: PackageSkillInstallSource = { kind: "package", package: source.package, version, integrity };
  skillInstallSourceKey(resolved);
  return resolved;
}

function tarText(block: Buffer, start: number, length: number): string {
  const end = block.indexOf(0, start);
  return block.subarray(start, end >= start && end < start + length ? end : start + length).toString("utf8");
}

function tarNumber(block: Buffer, start: number, length: number): number {
  const raw = tarText(block, start, length).trim();
  if (!/^[0-7]*$/.test(raw)) throw error("Skill archive contains an unsupported TAR number");
  const value = raw ? Number.parseInt(raw, 8) : 0;
  if (!Number.isSafeInteger(value) || value < 0) throw error("Skill archive contains an invalid TAR size");
  return value;
}

function parsePax(content: Buffer): string | undefined {
  let offset = 0;
  let path: string | undefined;
  while (offset < content.length) {
    const space = content.indexOf(0x20, offset);
    if (space < 0) throw error("Skill archive contains invalid PAX metadata");
    const length = Number(content.subarray(offset, space).toString("ascii"));
    if (!Number.isSafeInteger(length) || length <= space - offset || offset + length > content.length) {
      throw error("Skill archive contains invalid PAX record length");
    }
    const record = content.subarray(space + 1, offset + length - 1).toString("utf8");
    const separator = record.indexOf("=");
    if (separator > 0 && record.slice(0, separator) === "path") path = record.slice(separator + 1);
    offset += length;
  }
  return path;
}

function archivePath(value: string): string {
  if (!value || value.includes("\\") || value.includes("\0") || value.startsWith("/")) {
    throw error("Skill archive contains an unsafe path");
  }
  const segments = value.replace(/^\.\//, "").replace(/\/$/, "").split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes(":"))) {
    throw error("Skill archive contains path traversal");
  }
  return segments.join("/");
}

function parseTar(content: Buffer): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  let offset = 0;
  let paxPath: string | undefined;
  let longPath: string | undefined;
  let total = 0;
  while (offset + 512 <= content.length) {
    const header = content.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const expected = tarNumber(header, 148, 8);
    let actual = 0;
    for (let index = 0; index < 512; index += 1) actual += index >= 148 && index < 156 ? 0x20 : header[index]!;
    if (expected !== actual) throw error("Skill archive TAR checksum is invalid");
    const size = tarNumber(header, 124, 12);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > content.length) throw error("Skill archive is truncated");
    const type = String.fromCharCode(header[156] || 0x30);
    const name = [tarText(header, 345, 155), tarText(header, 0, 100)].filter(Boolean).join("/");
    const data = content.subarray(dataStart, dataEnd);
    offset = dataStart + Math.ceil(size / 512) * 512;
    if (type === "x" || type === "g") {
      const value = parsePax(data);
      if (type === "x") paxPath = value;
      else if (value) throw error("Skill archive contains an unsupported global PAX path");
      continue;
    }
    if (type === "L") {
      longPath = data.toString("utf8").replace(/[\0\n]+$/, "");
      continue;
    }
    if (type !== "0" && type !== "\0" && type !== "5") {
      throw error("Skill archive may contain only regular files and directories");
    }
    const path = archivePath(paxPath ?? longPath ?? name);
    paxPath = undefined;
    longPath = undefined;
    total += size;
    if (entries.length >= MAX_ARCHIVE_FILES || total > MAX_EXTRACTED_BYTES) {
      throw error("Skill archive exceeds the safe extraction limit");
    }
    entries.push({ path, directory: type === "5", content: Buffer.from(data) });
  }
  if (paxPath || longPath) throw error("Skill archive ends with unused path metadata");
  return entries;
}

async function gunzipBounded(archive: Buffer): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  const stream = Readable.from([archive]).pipe(createGunzip());
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > MAX_EXTRACTED_BYTES) throw error("Skill archive expands beyond the safe size limit");
      chunks.push(buffer);
    }
  } catch (cause) {
    if (cause instanceof SkillStoreError) throw cause;
    throw error("Skill archive is not valid gzip data", cause);
  }
  return Buffer.concat(chunks, bytes);
}

async function extractArchive(archive: Buffer, destination: string): Promise<void> {
  const entries = parseTar(await gunzipBounded(archive));
  const paths = entries.map(({ path }) => path.split("/"));
  const prefix = paths.length && paths.some((segments) => segments.length > 1)
    && paths.every((segments) => segments[0] === paths[0]![0]) ? paths[0]![0] : undefined;
  const written = new Set<string>();
  for (const entry of entries) {
    const parts = entry.path.split("/");
    if (prefix) parts.shift();
    if (!parts.length) continue;
    const relative = parts.join("/");
    const key = process.platform === "win32" ? relative.toLocaleLowerCase() : relative;
    if (written.has(key) || relative === ".harnest-provenance.json") throw error("Skill archive contains duplicate or reserved paths");
    written.add(key);
    const target = join(destination, ...parts);
    if (entry.directory) await mkdir(target, { recursive: true, mode: 0o700 });
    else {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, entry.content, { mode: 0o600, flag: "wx" });
    }
  }
}

async function archiveBytes(response: Response): Promise<Buffer> {
  if (!response.ok) throw error(`Skill archive download returned HTTP ${response.status}`);
  const content = Buffer.from(await response.arrayBuffer());
  if (!content.length || content.byteLength > MAX_ARCHIVE_BYTES) throw error("Skill archive exceeds the download size limit");
  return content;
}

function archiveUrl(source: RemoteSkillSource, metadata?: Record<string, unknown>): URL {
  if (source.kind === "git") return gitHost(source.repository).archive(source.commit);
  const tarball = metadata?.tarball;
  if (typeof tarball !== "string") throw error("npm registry metadata has no package archive URL");
  const url = new URL(tarball);
  if (url.protocol !== "https:" || url.origin !== "https://registry.npmjs.org" || url.username || url.password || url.hash) {
    throw error("npm package archive must come from the public registry origin");
  }
  return url;
}

export async function materializeRemoteSkill(
  source: RemoteSkillSource,
  fetch: Fetch = guardedFetch(true, { timeoutMs: 60_000, maxResponseBytes: MAX_ARCHIVE_BYTES }),
): Promise<RemoteSkillMaterialization> {
  skillInstallSourceKey(source);
  const root = await mkdtemp(join(tmpdir(), "harnest-skill-"));
  try {
    let url: URL;
    if (source.kind === "package") {
      const endpoint = new URL(`https://registry.npmjs.org/${encodeURIComponent(source.package)}/${encodeURIComponent(source.version)}`);
      const metadata = await json(await fetch(endpoint, {
        headers: { accept: "application/json", "user-agent": "Harnest Skill Installer" },
        redirect: "error",
      }), "npm registry metadata");
      const dist = metadata.dist;
      if (!dist || typeof dist !== "object" || Array.isArray(dist)) throw error("npm registry metadata has no archive");
      url = archiveUrl(source, dist as Record<string, unknown>);
    } else url = archiveUrl(source);
    const archive = await archiveBytes(await fetch(url, {
      headers: { accept: "application/gzip", "user-agent": "Harnest Skill Installer" },
      redirect: "error",
    }));
    if (source.kind === "package") {
      const actual = Buffer.from(`sha512-${createHash("sha512").update(archive).digest("base64")}`);
      const expected = Buffer.from(source.integrity);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw error("npm package archive failed sha512 verification");
    }
    await extractArchive(archive, root);
    return { directory: root, cleanup: () => rm(root, { recursive: true, force: true }) };
  } catch (cause) {
    await rm(root, { recursive: true, force: true });
    throw cause;
  }
}

export function remoteSkillSourceLabel(source: RemoteSkillSource): string {
  return source.kind === "git"
    ? `${basename(new URL(source.repository).pathname).replace(/\.git$/i, "")} @ ${source.commit.slice(0, 12)}`
    : `${source.package} @ ${source.version}`;
}
