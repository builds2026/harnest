import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseSpec, type HarnessSpec } from "@harnestai/core";

const VERSION_ID = /^v_[0-9TZ_-]{15,32}_[a-f0-9]{12}$/;
const MAX_INDEX_BYTES = 1_048_576;
const MAX_YAML_BYTES = 2_097_152;
const MAX_VERSIONS = 100;

export interface HarnessVersionEntry {
  readonly id: string;
  readonly createdAt: string;
  readonly summary: string;
  readonly sha256: string;
  readonly bytes: number;
}

interface HarnessVersionIndex {
  readonly version: 1;
  readonly entries: readonly HarnessVersionEntry[];
}

export interface HarnessVersionDiff {
  readonly components: {
    readonly added: readonly string[];
    readonly removed: readonly string[];
    readonly changed: readonly string[];
  };
  readonly connections: {
    readonly added: readonly string[];
    readonly removed: readonly string[];
    readonly changed: readonly string[];
  };
  readonly runtimeChanged: boolean;
  readonly testsChanged: boolean;
}

const locks = new Map<string, Promise<unknown>>();

function withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  locks.set(key, next);
  void next.finally(() => { if (locks.get(key) === next) locks.delete(key); }).catch(() => undefined);
  return next;
}

const inside = (root: string, target: string) => {
  const path = relative(root, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};

const digest = (yaml: string) => createHash("sha256").update(yaml).digest("hex");
const stableValue = (value: unknown): unknown => Array.isArray(value)
  ? value.map(stableValue)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]))
    : value;
const stable = (value: unknown) => JSON.stringify(stableValue(value));

function graphEntries(spec: HarnessSpec) {
  const graphs = [{ name: "root", body: spec }, ...(spec.version !== "0.1"
    ? Object.entries(spec.subgraphs ?? {}).map(([name, body]) => ({ name, body })) : [])];
  return {
    components: new Map(graphs.flatMap(({ name, body }) => body.components.map((component) => [
      `${name}/${component.id}`,
      stable({ type: component.type, config: component.config, policy: "policy" in component ? component.policy : undefined }),
    ] as const))),
    connections: new Map(graphs.flatMap(({ name, body }) => body.connections.map((connection, index) => [
      `${name}/${connection.id ?? `${connection.from.component}.${connection.from.port}->${connection.to.component}.${connection.to.port}:${index}`}`,
      stable(connection),
    ] as const))),
  };
}

function mapDiff(left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>) {
  return {
    added: [...right.keys()].filter((key) => !left.has(key)).sort(),
    removed: [...left.keys()].filter((key) => !right.has(key)).sort(),
    changed: [...right.keys()].filter((key) => left.has(key) && left.get(key) !== right.get(key)).sort(),
  };
}

export function compareHarnessVersions(leftYaml: string, rightYaml: string): HarnessVersionDiff {
  const left = parseSpec(leftYaml);
  const right = parseSpec(rightYaml);
  if (!left.ok || !right.ok) throw new Error("Only valid Harness versions can be compared");
  const leftEntries = graphEntries(left.spec);
  const rightEntries = graphEntries(right.spec);
  return {
    components: mapDiff(leftEntries.components, rightEntries.components),
    connections: mapDiff(leftEntries.connections, rightEntries.connections),
    runtimeChanged: stable(left.spec.version !== "0.1" ? left.spec.runtime : undefined)
      !== stable(right.spec.version !== "0.1" ? right.spec.runtime : undefined),
    testsChanged: stable(left.spec.tests) !== stable(right.spec.tests),
  };
}

export function sameHarnessRuntime(leftYaml: string, rightYaml: string): boolean {
  const left = parseSpec(leftYaml);
  const right = parseSpec(rightYaml);
  if (!left.ok || !right.ok) return false;
  return stable({ ...left.spec, studio: undefined }) === stable({ ...right.spec, studio: undefined });
}

export function summarizeHarnessDiff(diff: HarnessVersionDiff): string {
  const componentChanges = diff.components.added.length + diff.components.removed.length + diff.components.changed.length;
  const connectionChanges = diff.connections.added.length + diff.connections.removed.length + diff.connections.changed.length;
  const details = [
    componentChanges ? `${componentChanges} component change${componentChanges === 1 ? "" : "s"}` : "",
    connectionChanges ? `${connectionChanges} connection change${connectionChanges === 1 ? "" : "s"}` : "",
    diff.runtimeChanged ? "runtime changed" : "",
    diff.testsChanged ? "tests changed" : "",
  ].filter(Boolean);
  return details.join(", ") || "Layout or metadata updated";
}

export class FileHarnessVersionStore {
  readonly #harnessFile: string;
  readonly #root: Promise<string>;

  constructor(harnessFile: string) {
    this.#harnessFile = resolve(harnessFile);
    this.#root = this.#initialize();
  }

  async #initialize() {
    const project = await realpath(dirname(this.#harnessFile));
    const hiddenPath = join(project, ".harnest");
    await mkdir(hiddenPath, { recursive: true });
    const hidden = await realpath(hiddenPath);
    if (!inside(project, hidden)) throw new Error("Harness history resolves outside the project");
    const versionsPath = join(hidden, "versions");
    await mkdir(versionsPath, { recursive: true });
    const versions = await realpath(versionsPath);
    if (!inside(hidden, versions)) throw new Error("Harness history resolves outside storage");
    return versions;
  }

  async #readIndex(root: string): Promise<HarnessVersionIndex> {
    const file = join(root, "index.json");
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_INDEX_BYTES) throw new Error("Harness history index is invalid");
      const parsed = JSON.parse(await readFile(file, "utf8")) as HarnessVersionIndex;
      if (!parsed || typeof parsed !== "object" || parsed.version !== 1 || !Array.isArray(parsed.entries)
        || parsed.entries.some((entry) => !VERSION_ID.test(entry.id) || typeof entry.createdAt !== "string"
          || typeof entry.summary !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)
          || !Number.isInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > MAX_YAML_BYTES)) {
        throw new Error("Harness history index is invalid");
      }
      return parsed;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return { version: 1, entries: [] };
      throw error;
    }
  }

  async #atomicWrite(path: string, content: string) {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async list(): Promise<HarnessVersionEntry[]> {
    const root = await this.#root;
    return (await this.#readIndex(root)).entries.map((entry) => ({ ...entry }));
  }

  async get(id: string): Promise<{ entry: HarnessVersionEntry; yaml: string }> {
    if (!VERSION_ID.test(id)) throw new Error("Harness version id is invalid");
    const root = await this.#root;
    const index = await this.#readIndex(root);
    const entry = index.entries.find((candidate) => candidate.id === id);
    if (!entry) throw new Error("Harness version was not found");
    const file = join(root, `${id}.yaml`);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== entry.bytes || info.size > MAX_YAML_BYTES) {
      throw new Error("Harness version snapshot is invalid");
    }
    const yaml = await readFile(file, "utf8");
    if (digest(yaml) !== entry.sha256) throw new Error("Harness version snapshot failed integrity verification");
    return { entry: { ...entry }, yaml };
  }

  async record(yaml: string, summary: string, force = false): Promise<HarnessVersionEntry> {
    const bytes = Buffer.byteLength(yaml);
    if (bytes < 1 || bytes > MAX_YAML_BYTES) throw new Error("Harness version must contain 1 byte–2 MiB");
    const parsed = parseSpec(yaml);
    if (!parsed.ok) throw new Error("Invalid Harness YAML cannot be stored as a restorable version");
    const root = await this.#root;
    return withLock(root, async () => {
      const index = await this.#readIndex(root);
      const sha256 = digest(yaml);
      if (!force && index.entries[0]?.sha256 === sha256) return { ...index.entries[0] };
      const createdAt = new Date().toISOString();
      const id = `v_${createdAt.replace(/[^0-9TZ]/g, "_")}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      const entry: HarnessVersionEntry = { id, createdAt, summary: summary.slice(0, 240), sha256, bytes };
      await this.#atomicWrite(join(root, `${id}.yaml`), yaml);
      const entries = [entry, ...index.entries].slice(0, MAX_VERSIONS);
      await this.#atomicWrite(join(root, "index.json"), JSON.stringify({ version: 1, entries }, null, 2));
      const retained = new Set(entries.map(({ id: retainedId }) => `${retainedId}.yaml`));
      for (const file of await readdir(root)) {
        if (VERSION_ID.test(file.replace(/\.yaml$/, "")) && file.endsWith(".yaml") && !retained.has(file)) {
          await rm(join(root, file), { force: true });
        }
      }
      return { ...entry };
    });
  }
}
