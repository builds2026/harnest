import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { filePreview, type PlaygroundConversationCheckpoint, type PlaygroundFile, type PlaygroundMessage, type PlaygroundSession, type PlaygroundSessionSummary } from "./playground";

const SESSION_ID = /^[a-f0-9-]{36}$/;
const FILE_ID = /^(?:file|artifact)_[a-z0-9_-]{8,80}$/;
const MAX_FILE_BYTES = 64 * 1_048_576;
const MAX_SESSION_BYTES = 256 * 1_048_576;
const MAX_SESSION_FILES = 100;
const MAX_MESSAGES = 200;
const MAX_METADATA_BYTES = 4 * 1_048_576;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

const compactConversation = (
  previous: PlaygroundConversationCheckpoint | undefined,
  messages: readonly PlaygroundMessage[],
): PlaygroundConversationCheckpoint | undefined => {
  if (!messages.length) return previous;
  const firstUser = messages.find(({ role, content }) => role === "user" && content.trim());
  const assistants = messages.filter(({ role, content }) => role === "assistant" && content.trim());
  const lastAssistant = assistants.at(-1);
  const decisions = [...(previous?.decisions ?? []), ...assistants.map(({ content }) => boundedText(content.replace(/\s+/gu, " ").trim(), 1_024))].slice(-16);
  const evidence = [...new Set([
    ...(previous?.evidence ?? []),
    ...messages.flatMap(({ runId, fileIds }) => [...(runId ? [`run:${runId}`] : []), ...(fileIds ?? []).map((id) => `file:${id}`)]),
  ])].slice(-64);
  return {
    ...(previous?.originalRequest ? { originalRequest: previous.originalRequest }
      : firstUser ? { originalRequest: boundedText(firstUser.content, 16_384) } : {}),
    decisions,
    evidence,
    ...(lastAssistant ? { currentResult: boundedText(lastAssistant.content, 16_384) } : previous?.currentResult ? { currentResult: previous.currentResult } : {}),
    ...(lastAssistant?.runId ? { validation: { lastRunId: lastAssistant.runId, finishReason: lastAssistant.finishReason ?? "unknown" } }
      : previous?.validation ? { validation: previous.validation } : {}),
    remainingWork: previous?.remainingWork ?? [],
    compactedMessages: (previous?.compactedMessages ?? 0) + messages.length,
  };
};

interface StoredFile extends PlaygroundFile {
  readonly storedPath: string;
  readonly sha256: string;
}

interface StoredSession extends PlaygroundSession {
  readonly version: 2;
  readonly files: readonly StoredFile[];
  readonly activeFileIds: readonly string[];
  readonly checkpoint?: PlaygroundConversationCheckpoint;
}

const publicFile = ({ storedPath: _storedPath, ...file }: StoredFile): PlaygroundFile => file;
const publicSession = ({ files: _files, version: _version, checkpoint: _checkpoint, ...session }: StoredSession): PlaygroundSession => session;

const locks = new Map<string, Promise<unknown>>();

function withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  locks.set(key, next);
  void next.finally(() => { if (locks.get(key) === next) locks.delete(key); }).catch(() => undefined);
  return next;
}

const isInside = (root: string, path: string) => {
  const value = relative(root, path);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
};

const assertSessionId = (id: string) => {
  if (!SESSION_ID.test(id)) throw new Error("Playground session id is invalid");
};

const safeName = (value: string) => {
  const leaf = value.replaceAll("\\", "/").split("/").at(-1) ?? "file";
  const normalized = [...leaf].filter((character) => character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127)
    .join("").trim().slice(0, 180);
  return normalized || "file";
};

const safeMime = (value: string) => /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i.test(value)
  ? value.toLocaleLowerCase() : "application/octet-stream";

const extension = (name: string) => {
  const value = extname(name).toLocaleLowerCase();
  return /^\.[a-z0-9]{1,12}$/.test(value) ? value : "";
};

const boundedText = (value: string, maxBytes: number) => {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  return bytes.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/u, "") + "\n[truncated]";
};

const inferredMime = (name: string) => ({
  ".csv": "text/csv", ".tsv": "text/tab-separated-values", ".txt": "text/plain", ".md": "text/markdown",
  ".json": "application/json", ".yaml": "application/yaml", ".yml": "application/yaml", ".pdf": "application/pdf",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".wav": "audio/wav",
})[extname(name).toLocaleLowerCase()] ?? "application/octet-stream";

async function verifiedDirectory(path: string, parent: string) {
  const lexical = await lstat(path);
  if (!lexical.isDirectory() || lexical.isSymbolicLink()) throw new Error("Playground storage must be a regular directory");
  const canonical = await realpath(path);
  if (!isInside(parent, canonical)) throw new Error("Playground storage resolves outside the project");
  return canonical;
}

async function createDirectory(path: string, parent: string) {
  await mkdir(path, { recursive: false }).catch((error: unknown) => {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
  });
  return verifiedDirectory(path, parent);
}

export class FilePlaygroundStore {
  readonly #root: Promise<string>;

  constructor(projectDirectory: string) {
    this.#root = this.#initialize(projectDirectory);
  }

  async #initialize(projectDirectory: string) {
    const project = await realpath(projectDirectory);
    const hidden = await createDirectory(join(project, ".harnest"), project);
    const playground = await createDirectory(join(hidden, "playground"), hidden);
    await createDirectory(join(playground, "sessions"), playground);
    return playground;
  }

  async #sessionDirectory(id: string, create = false) {
    assertSessionId(id);
    const root = await this.#root;
    const sessions = await verifiedDirectory(join(root, "sessions"), root);
    const path = join(sessions, id);
    return create ? createDirectory(path, sessions) : verifiedDirectory(path, sessions);
  }

  async #read(id: string): Promise<StoredSession> {
    const directory = await this.#sessionDirectory(id);
    const file = join(directory, "session.json");
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_METADATA_BYTES) {
      throw new Error("Playground session metadata is invalid");
    }
    const parsed = JSON.parse(await readFile(file, "utf8")) as Omit<StoredSession, "version" | "activeFileIds"> & {
      version: number;
      activeFileIds?: unknown;
    };
    if ((parsed.version !== 1 && parsed.version !== 2) || parsed.id !== id || !Array.isArray(parsed.messages) || !Array.isArray(parsed.files)) {
      throw new Error("Playground session metadata is invalid");
    }
    const expiresAt = Date.parse(parsed.expiresAt);
    if (!Number.isFinite(expiresAt)) throw new Error("Playground session metadata is invalid");
    if (expiresAt <= Date.now()) {
      await rm(directory, { recursive: true, force: true });
      throw new Error("Playground session expired");
    }
    const knownFiles = new Set(parsed.files.map(({ id: fileId }) => fileId));
    const previousSelection: readonly string[] = parsed.version === 2 && Array.isArray(parsed.activeFileIds)
      ? parsed.activeFileIds.filter((fileId): fileId is string => typeof fileId === "string")
      : [...parsed.messages].reverse().find((message) => message.role === "user" && message.fileIds !== undefined)?.fileIds ?? [];
    return {
      ...parsed,
      version: 2,
      activeFileIds: [...new Set(previousSelection)].filter((fileId) => FILE_ID.test(fileId) && knownFiles.has(fileId)).slice(0, 32),
    };
  }

  async #write(session: StoredSession) {
    const directory = await this.#sessionDirectory(session.id);
    const serialized = JSON.stringify(session, null, 2);
    if (Buffer.byteLength(serialized) > MAX_METADATA_BYTES) throw new Error("Playground session metadata exceeds 4 MiB");
    const temporary = join(directory, `.session-${randomUUID()}.tmp`);
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    const handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o600);
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, join(directory, "session.json"));
  }

  async create(): Promise<PlaygroundSession> {
    const now = new Date();
    const id = randomUUID();
    const directory = await this.#sessionDirectory(id, true);
    await Promise.all([
      createDirectory(join(directory, "uploads"), directory),
      createDirectory(join(directory, "workspaces"), directory),
      createDirectory(join(directory, "artifacts"), directory),
    ]);
    const session: StoredSession = {
      version: 2,
      id,
      title: "New conversation",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + RETENTION_MS).toISOString(),
      messages: [],
      files: [],
      activeFileIds: [],
    };
    await this.#write(session);
    return publicSession(session);
  }

  async get(id: string): Promise<PlaygroundSession> {
    return publicSession(await this.#read(id));
  }

  async checkpoint(id: string): Promise<PlaygroundConversationCheckpoint | undefined> {
    return structuredClone((await this.#read(id)).checkpoint);
  }

  async list(): Promise<PlaygroundSessionSummary[]> {
    const root = await this.#root;
    const sessions = await verifiedDirectory(join(root, "sessions"), root);
    const result: PlaygroundSessionSummary[] = [];
    for (const entry of await readdir(sessions, { withFileTypes: true })) {
      if (!entry.isDirectory() || !SESSION_ID.test(entry.name)) continue;
      try {
        const session = await this.#read(entry.name);
        result.push({
          id: session.id,
          title: session.title,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          expiresAt: session.expiresAt,
          messageCount: session.messages.length,
          ...(session.messages.at(-1)?.content ? { preview: session.messages.at(-1)?.content.slice(0, 100) } : {}),
        });
      } catch {
        // Invalid entries are not exposed through the UI.
      }
    }
    return result.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 100);
  }

  async delete(id: string): Promise<void> {
    const directory = await this.#sessionDirectory(id);
    const root = await this.#root;
    if (!isInside(join(root, "sessions"), directory)) throw new Error("Playground session resolves outside storage");
    await rm(directory, { recursive: true, force: false });
  }

  async append(id: string, messages: readonly PlaygroundMessage[]): Promise<PlaygroundSession> {
    return withLock(id, async () => {
      const current = await this.#read(id);
      const now = new Date();
      const additions = messages.map((message) => ({
        ...message,
        content: boundedText(message.content, 512 * 1_024),
        fileIds: message.fileIds?.filter((fileId) => FILE_ID.test(fileId)).slice(0, 32),
      }));
      const combined = [...current.messages, ...additions];
      const removed = combined.slice(0, Math.max(0, combined.length - MAX_MESSAGES));
      const all = combined.slice(-MAX_MESSAGES);
      const selected = [...additions].reverse().find((message) => message.role === "user" && message.fileIds !== undefined)?.fileIds;
      const firstUser = all.find((message) => message.role === "user" && message.content.trim());
      const next: StoredSession = {
        ...current,
        title: current.title === "New conversation" && firstUser
          ? boundedText(firstUser.content.replace(/\s+/gu, " ").trim(), 80).slice(0, 64) : current.title,
        updatedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + RETENTION_MS).toISOString(),
        messages: all,
        checkpoint: compactConversation(current.checkpoint, removed),
        activeFileIds: selected === undefined
          ? current.activeFileIds
          : [...new Set(selected)].filter((fileId) => current.files.some(({ id: candidate }) => candidate === fileId)),
      };
      await this.#write(next);
      return publicSession(next);
    });
  }

  async files(id: string): Promise<PlaygroundFile[]> {
    return (await this.#read(id)).files.map(publicFile);
  }

  async upload(id: string, input: { readonly name: string; readonly mimeType: string; readonly content: Uint8Array }): Promise<PlaygroundFile> {
    if (input.content.byteLength === 0 || input.content.byteLength > MAX_FILE_BYTES) {
      throw new Error("Files must contain 1 byte–64 MiB");
    }
    return withLock(id, async () => {
      const session = await this.#read(id);
      if (session.files.length >= MAX_SESSION_FILES) throw new Error("A Playground session is limited to 100 files");
      if (session.files.reduce((total, file) => total + file.size, 0) + input.content.byteLength > MAX_SESSION_BYTES) {
        throw new Error("A Playground session is limited to 256 MiB");
      }
      const sha256 = createHash("sha256").update(input.content).digest("hex");
      const duplicate = session.files.find((file) => file.source === "upload" && file.sha256 === sha256);
      if (duplicate) {
        if (!session.activeFileIds.includes(duplicate.id)) {
          await this.#write({
            ...session,
            updatedAt: new Date().toISOString(),
            activeFileIds: [...session.activeFileIds, duplicate.id].slice(0, 32),
          });
        }
        return publicFile(duplicate);
      }
      const fileId = `file_${sha256.slice(0, 32)}`;
      const name = safeName(input.name);
      const mimeType = safeMime(input.mimeType);
      const storedName = `${fileId}${extension(name)}`;
      const directory = await this.#sessionDirectory(id);
      const uploads = await verifiedDirectory(join(directory, "uploads"), directory);
      const path = join(uploads, storedName);
      const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
      const handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o600);
      try {
        await handle.writeFile(input.content);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const now = new Date().toISOString();
      const file: StoredFile = {
        id: fileId,
        name,
        mimeType,
        size: input.content.byteLength,
        source: "upload",
        createdAt: now,
        sandboxPath: `/mnt/data/${storedName}`,
        preview: filePreview(mimeType, name),
        storedPath: `uploads/${storedName}`,
        sha256,
      };
      await this.#write({
        ...session,
        updatedAt: now,
        expiresAt: new Date(Date.now() + RETENTION_MS).toISOString(),
        files: [...session.files, file],
        activeFileIds: [...new Set([...session.activeFileIds, file.id])].slice(0, 32),
      });
      return publicFile(file);
    });
  }

  async #storedFile(sessionId: string, fileId: string) {
    if (!FILE_ID.test(fileId)) throw new Error("Playground file id is invalid");
    const session = await this.#read(sessionId);
    const file = session.files.find((candidate) => candidate.id === fileId);
    if (!file) throw new Error("Playground file was not found");
    const directory = await this.#sessionDirectory(sessionId);
    const path = resolve(directory, file.storedPath);
    if (!isInside(directory, path)) throw new Error("Playground file resolves outside its session");
    const lexical = await lstat(path);
    if (!lexical.isFile() || lexical.isSymbolicLink()) throw new Error("Playground file is not a regular file");
    const canonical = await realpath(path);
    if (!isInside(directory, canonical) || !(await stat(canonical)).isFile()) {
      throw new Error("Playground file resolves outside its session");
    }
    return { file, path: canonical };
  }

  async content(sessionId: string, fileId: string) {
    const stored = await this.#storedFile(sessionId, fileId);
    return { file: publicFile(stored.file), content: await readFile(stored.path) };
  }

  async removeFile(sessionId: string, fileId: string): Promise<void> {
    await withLock(sessionId, async () => {
      const session = await this.#read(sessionId);
      const stored = await this.#storedFile(sessionId, fileId);
      await this.#write({
        ...session,
        updatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + RETENTION_MS).toISOString(),
        files: session.files.filter(({ id }) => id !== fileId),
        activeFileIds: session.activeFileIds.filter((id) => id !== fileId),
      });
      // Metadata is authoritative; a failed unlink leaves only an unreachable file cleaned with the session.
      await rm(stored.path, { force: false }).catch(() => undefined);
    });
  }

  async setActiveFiles(sessionId: string, fileIds: readonly string[]): Promise<PlaygroundSession> {
    return withLock(sessionId, async () => {
      const session = await this.#read(sessionId);
      const selected = [...new Set(fileIds)].slice(0, 32);
      if (selected.some((fileId) => !session.files.some(({ id }) => id === fileId))) {
        throw new Error("One or more Playground files were not found in this session");
      }
      const next = {
        ...session,
        updatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + RETENTION_MS).toISOString(),
        activeFileIds: selected,
      };
      await this.#write(next);
      return publicSession(next);
    });
  }

  async prepareWorkspace(sessionId: string, fileIds?: readonly string[]) {
    const session = await this.#read(sessionId);
    const selectedFileIds = fileIds ?? session.activeFileIds;
    const directory = await this.#sessionDirectory(sessionId);
    const workspaces = await verifiedDirectory(join(directory, "workspaces"), directory);
    const artifacts = await verifiedDirectory(join(directory, "artifacts"), directory);
    const workspaceId = randomUUID();
    const workspace = await createDirectory(join(workspaces, workspaceId), workspaces);
    const inputDirectory = await createDirectory(join(workspace, "input"), workspace);
    const outputDirectory = await createDirectory(join(artifacts, workspaceId), artifacts);
    await chmod(inputDirectory, 0o755).catch(() => undefined);
    await chmod(outputDirectory, 0o777).catch(() => undefined);
    const selected: PlaygroundFile[] = [];
    for (const fileId of [...new Set(selectedFileIds)].slice(0, 32)) {
      const stored = await this.#storedFile(sessionId, fileId);
      const targetName = `${stored.file.id}${extension(stored.file.name)}`;
      const target = join(inputDirectory, targetName);
      await copyFile(stored.path, target, fsConstants.COPYFILE_EXCL);
      await chmod(target, 0o444).catch(() => undefined);
      selected.push({
        ...publicFile(stored.file),
        sandboxPath: `/mnt/data/${targetName}`,
      });
    }
    return { workspaceId, inputDirectory, outputDirectory, files: selected };
  }

  async finalizeWorkspace(sessionId: string, workspaceId: string, runId?: string): Promise<PlaygroundFile[]> {
    if (!SESSION_ID.test(workspaceId)) throw new Error("Playground workspace id is invalid");
    return withLock(sessionId, async () => {
      const session = await this.#read(sessionId);
      const directory = await this.#sessionDirectory(sessionId);
      const artifactsRoot = await verifiedDirectory(join(directory, "artifacts"), directory);
      const outputDirectory = await verifiedDirectory(join(artifactsRoot, workspaceId), artifactsRoot);
      const found: StoredFile[] = [];
      const available = Math.max(0, MAX_SESSION_FILES - session.files.length);
      let total = session.files.reduce((sum, file) => sum + file.size, 0);
      const visit = async (current: string, depth: number): Promise<void> => {
        if (depth > 5) {
          await rm(current, { recursive: true, force: true });
          return;
        }
        for (const entry of await readdir(current, { withFileTypes: true })) {
          const path = join(current, entry.name);
          if (entry.isSymbolicLink()) { await rm(path, { force: true }); continue; }
          if (entry.isDirectory()) { await visit(path, depth + 1); continue; }
          if (!entry.isFile()) { await rm(path, { force: true }); continue; }
          const lexical = await lstat(path);
          if (!lexical.isFile() || lexical.isSymbolicLink()) { await rm(path, { force: true }); continue; }
          const canonical = await realpath(path);
          if (!isInside(outputDirectory, canonical)) { await rm(path, { force: true }); continue; }
          const info = await stat(canonical);
          if (found.length >= available || info.size <= 0 || info.size > MAX_FILE_BYTES || total + info.size > MAX_SESSION_BYTES) {
            await rm(path, { force: true });
            continue;
          }
          const name = safeName(relative(outputDirectory, path).split(sep).join("/"));
          const id = `artifact_${workspaceId.replaceAll("-", "").slice(0, 16)}_${found.length + 1}`;
          const mimeType = inferredMime(name);
          const content = await readFile(canonical);
          total += info.size;
          found.push({
            id,
            name,
            mimeType,
            size: info.size,
            source: "artifact",
            createdAt: new Date().toISOString(),
            ...(runId ? { runId } : {}),
            preview: filePreview(mimeType, name),
            storedPath: relative(directory, path).split(sep).join("/"),
            sha256: createHash("sha256").update(content).digest("hex"),
          });
          await chmod(path, 0o600).catch(() => undefined);
        }
      };
      await visit(outputDirectory, 0);
      await chmod(outputDirectory, 0o700).catch(() => undefined);
      const now = new Date().toISOString();
      await this.#write({
        ...session,
        updatedAt: now,
        expiresAt: new Date(Date.now() + RETENTION_MS).toISOString(),
        files: [...session.files, ...found],
      });
      return found.map(publicFile);
    });
  }

  async workspaceFiles(sessionId: string, workspaceId: string): Promise<PlaygroundFile[]> {
    if (!SESSION_ID.test(workspaceId)) return [];
    const directory = await this.#sessionDirectory(sessionId);
    const artifactsRoot = await verifiedDirectory(join(directory, "artifacts"), directory);
    const outputDirectory = await verifiedDirectory(join(artifactsRoot, workspaceId), artifactsRoot);
    const files: PlaygroundFile[] = [];
    let total = 0;
    const visit = async (current: string, depth: number): Promise<void> => {
      if (depth > 5 || files.length >= 100) return;
      for (const entry of await readdir(current, { withFileTypes: true })) {
        if (files.length >= 100) break;
        const path = join(current, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) { await visit(path, depth + 1); continue; }
        if (!entry.isFile()) continue;
        const info = await stat(path);
        if (info.size <= 0 || info.size > MAX_FILE_BYTES || total + info.size > MAX_SESSION_BYTES) continue;
        total += info.size;
        const relativePath = relative(outputDirectory, path).split(sep).join("/");
        const name = safeName(relativePath);
        const mimeType = inferredMime(name);
        files.push({
          id: `sandbox_${workspaceId.replaceAll("-", "").slice(0, 16)}_${files.length + 1}`,
          name,
          mimeType,
          size: info.size,
          source: "sandbox",
          createdAt: info.mtime.toISOString(),
          sandboxPath: `/mnt/output/${relativePath}`,
          preview: filePreview(mimeType, name),
        });
      }
    };
    await visit(outputDirectory, 0);
    return files;
  }

  async cleanupWorkspace(sessionId: string, workspaceId: string): Promise<void> {
    if (!SESSION_ID.test(workspaceId)) return;
    const directory = await this.#sessionDirectory(sessionId);
    const workspaces = await verifiedDirectory(join(directory, "workspaces"), directory);
    const target = join(workspaces, workspaceId);
    if (isInside(workspaces, target)) await rm(target, { recursive: true, force: true });
  }
}

export const playgroundStore = (projectFile: string) => new FilePlaygroundStore(dirname(projectFile));
