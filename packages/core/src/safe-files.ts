import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, rename, rm, stat, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

const inside = (root: string, target: string): boolean => {
  const path = relative(root, target);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

const PORTABLE_HARNEST_PATHS = new Set([
  "project.json", "studio.json", "prompts", "skills", "context", "schemas", "tests", "tools", "config",
]);
const SAFE_DOT_FILES = new Set([".editorconfig", ".env.example", ".gitignore"]);

export function isSensitiveWorkspacePath(root: string, target: string): boolean {
  const segments = relative(root, target).split(sep).filter(Boolean);
  if (!segments.length || !inside(root, target)) return true;
  if (segments[0] === ".harnest") {
    if (!PORTABLE_HARNEST_PATHS.has(segments[1] ?? "")) return true;
    if (segments.slice(2).some((segment) => segment.startsWith(".") && segment !== ".harnest-provenance.json")) return true;
  } else if (segments.some((segment) => segment.startsWith(".") && !SAFE_DOT_FILES.has(segment))) {
    return true;
  }
  return segments.some((segment) =>
    /^(?:credentials?|secrets?|service[-_]?account|firebase[-_]?adminsdk|id_(?:dsa|ecdsa|ed25519|rsa))(?:[._-]|$)/i.test(segment)
    || /\.(?:jks|key|keystore|p12|pfx|pem)$/i.test(segment));
}

const sameFile = (left: Stats, right: Stats): boolean =>
  left.ino !== 0 && left.ino === right.ino && (process.platform === "win32" || left.dev === right.dev);

export interface VerifiedFile {
  readonly handle: FileHandle;
  readonly path: string;
  verify(): Promise<void>;
}

export async function openVerifiedFile(
  path: string,
  root: string,
  access: "read" | "write",
): Promise<VerifiedFile> {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const flags = access === "read"
    ? constants.O_RDONLY | noFollow
    : constants.O_RDWR | constants.O_CREAT | noFollow;
  const handle = await open(path, flags, 0o600);
  let canonical = "";
  const verify = async (): Promise<void> => {
    canonical = await realpath(path);
    const [link, opened, current] = await Promise.all([
      lstat(path),
      handle.stat(),
      stat(/* turbopackIgnore: true */ canonical),
    ]);
    if (!inside(root, canonical) || link.isSymbolicLink() || !opened.isFile() || !current.isFile()
      || !sameFile(opened, current)) throw new Error(`File '${path}' changed during I/O`);
  };
  try {
    await verify();
    return { handle, get path() { return canonical; }, verify };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function readVerifiedFile(path: string, root: string, maxBytes: number): Promise<Buffer> {
  const opened = await openVerifiedFile(path, root, "read");
  try {
    const info = await opened.handle.stat();
    if (info.size > maxBytes) throw new Error(`File '${path}' exceeds ${maxBytes} bytes`);
    const content = await opened.handle.readFile();
    await opened.verify();
    return content;
  } finally {
    await opened.handle.close();
  }
}

export async function writeVerifiedFile(path: string, root: string, content: string | Uint8Array): Promise<void> {
  const opened = await openVerifiedFile(path, root, "write");
  try {
    await opened.verify();
    await opened.handle.truncate(0);
    await opened.handle.writeFile(content, typeof content === "string" ? "utf8" : undefined);
    await opened.handle.sync();
    await opened.verify();
  } finally {
    await opened.handle.close();
  }
}

export async function atomicWriteVerifiedFile(
  path: string,
  root: string,
  content: string | Uint8Array,
): Promise<void> {
  const canonicalRoot = await realpath(root);
  const directory = await realpath(dirname(path));
  if (!inside(canonicalRoot, directory)) throw new Error(`File '${path}' is outside its storage root`);
  const target = join(directory, basename(path));
  if (!inside(canonicalRoot, target)) throw new Error(`File '${path}' is outside its storage root`);
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeVerifiedFile(temporary, canonicalRoot, content);
    await rename(temporary, target);
    const verified = await openVerifiedFile(target, canonicalRoot, "read");
    await verified.handle.close();
  } finally {
    await rm(temporary, { force: true });
  }
}
