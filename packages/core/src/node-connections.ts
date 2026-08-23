import { spawn } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { lookup } from "node:dns/promises";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import {
  auth,
  Client,
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  InsufficientScopeError,
  selectClientAuthMethod,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type AuthorizationServerMetadata,
  type FetchLike,
  type OAuthClientInformationContext,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
  type Tool,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  CONNECTION_ID,
  CREDENTIAL_FIELD,
  ConnectionError,
  type ConnectionCatalog,
  type ConnectionCreateInput,
  type ConnectionProfile,
  type ConnectionSearch,
  type ConnectionStatus,
  type ConnectionTool,
  type ConnectionUpdateInput,
  type OAuthStartResult,
} from "./connection.js";
import { runBoundedProcess } from "./node-tools.js";
import { snapshotSafeJsonSchema } from "./tool.js";
import { atomicWriteVerifiedFile, readVerifiedFile } from "./safe-files.js";

const FILE_VERSION = 1 as const;
const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_SECRET_BYTES = 1024 * 1024;
const MAX_DISCOVERY_BYTES = 2 * 1024 * 1024;
const LOCK_TIMEOUT_MS = 10_000;
const OAUTH_SESSION_MS = 10 * 60_000;
const OAUTH_FETCH_TIMEOUT_MS = 30_000;
const VAULT_AAD = Buffer.from("harnest-credential-vault:v1", "utf8");
const SECRET_REFERENCE = /^connection:([^:]+):([^:]+)$/;
const SENSITIVE_PUBLIC_KEY = /^(?:api[-_]?key|authorization|cookies?|credentials?|password|passphrase|secrets?|tokens?|access[-_]?token|refresh[-_]?token|client[-_]?secret|private[-_]?key)$/i;
const SENSITIVE_HEADER = /^(?:authorization|proxy-authorization|cookies?|x-api-key|api-key)$/i;
const SENSITIVE_NORMALIZED_KEYS = new Set([
  "apikey", "authorization", "cookie", "cookies", "credential", "credentials", "password",
  "passphrase", "secret", "secrets", "token", "tokens", "accesstoken", "refreshtoken",
  "clientsecret", "privatekey", "authtoken",
]);
const SECRET_LIKE_VALUE = /(?:\bbearer\s+\S+|\bsk-[A-Za-z0-9_-]{12,}|\b(?:api[-_ ]?key|token|secret|password)\s*[=:]\s*\S+)/i;

interface ConnectionFile {
  readonly version: typeof FILE_VERSION;
  readonly connections: ConnectionProfile[];
}

interface OAuthSession {
  readonly state: string;
  readonly serverUrl: string;
  readonly redirectUrl: string;
  readonly expiresAt: string;
  readonly requestedScope?: string;
  readonly codeVerifier?: string;
  readonly discovery?: OAuthDiscoveryState;
}

interface OAuthCredentialSet {
  readonly tokens?: StoredOAuthTokens;
  readonly clientInformation?: StoredOAuthClientInformation;
  readonly discovery?: OAuthDiscoveryState;
}

interface VaultEntry {
  readonly fields?: Record<string, string>;
  readonly oauth?: Record<string, OAuthCredentialSet>;
  readonly oauthSession?: OAuthSession;
  readonly processApproval?: string;
  readonly profileBinding?: string;
  readonly pendingCreate?: string;
}

interface VaultData {
  readonly version: typeof FILE_VERSION;
  readonly entries: Record<string, VaultEntry>;
}

interface EncryptedVault {
  readonly version: typeof FILE_VERSION;
  readonly algorithm: "aes-256-gcm";
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
}

type WrappedKeyFile = {
  readonly version: typeof FILE_VERSION;
  readonly protection: "dpapi-current-user";
  readonly wrappedKey: string;
} | {
  readonly version: typeof FILE_VERSION;
  readonly protection: "macos-keychain" | "linux-secret-service";
  readonly keyId: string;
};

export interface ConnectionManagerOptions {
  readonly userDataDirectory?: string;
  readonly now?: () => Date;
}

export interface ConnectionTestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly allowProcessCommands?: readonly string[];
  readonly allowNetworkHosts?: true | readonly string[];
  readonly probe?: (profile: ConnectionProfile) => string | void | Promise<string | void>;
}

export interface McpConnectionHandle {
  readonly client: Client;
  readonly transport: StdioClientTransport | StreamableHTTPClientTransport;
  readonly profile: ConnectionProfile;
  readonly tools: readonly Tool[];
  close(): Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function omitKeys<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Omit<T, K> {
  const result: Partial<T> = { ...value };
  for (const key of keys) delete result[key];
  return result as Omit<T, K>;
}

const isInside = (root: string, target: string): boolean => {
  const path = relative(root, target);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

const timestamp = (now: () => Date): string => now().toISOString();

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
}

function connectionProfileBinding(profile: Pick<ConnectionProfile, "kind" | "config">): string {
  return createHash("sha256").update(JSON.stringify(canonicalJson({ kind: profile.kind, config: profile.config }))).digest("hex");
}

function protectedVaultEntry(entry: VaultEntry | undefined): boolean {
  return Boolean(entry && (Object.keys(entry.fields ?? {}).length || Object.keys(entry.oauth ?? {}).length
    || entry.oauthSession || entry.processApproval || entry.pendingCreate));
}

function defaultUserDataDirectory(): string {
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA ?? process.env.APPDATA;
    if (base) return join(base, "Harnest");
  }
  if (process.platform === "darwin" && process.env.HOME) {
    return join(process.env.HOME, "Library", "Application Support", "Harnest");
  }
  const base = process.env.XDG_DATA_HOME ?? (process.env.HOME ? join(process.env.HOME, ".local", "share") : undefined);
  if (base) return join(base, "harnest");
  throw new ConnectionError("CREDENTIAL_BACKEND_UNAVAILABLE", "A per-user Harnest data directory is unavailable");
}

async function readJson(path: string, maxBytes: number): Promise<unknown | undefined> {
  try {
    const directory = await realpath(dirname(path));
    return JSON.parse((await readVerifiedFile(path, directory, maxBytes)).toString("utf8")) as unknown;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const directory = await realpath(dirname(path));
  await atomicWriteVerifiedFile(path, directory, `${JSON.stringify(value)}\n`);
}

async function pause(ms: number): Promise<void> {
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function withFileLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  const started = Date.now();
  while (true) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(`${process.pid}\n`, "utf8");
        return await operation();
      } finally {
        await handle.close();
        await rm(path, { force: true });
      }
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
      if (Date.now() - started > LOCK_TIMEOUT_MS) {
        throw new ConnectionError("CREDENTIAL_STORE_FAILED", "Timed out waiting for the local credential store lock");
      }
      try {
        const info = await stat(path);
        if (Date.now() - info.mtimeMs > LOCK_TIMEOUT_MS * 2) await rm(path, { force: true });
      } catch {
        // A concurrent owner may have released the lock.
      }
      await pause(25);
    }
  }
}

async function dpapi(action: "protect" | "unprotect", data: Buffer): Promise<Buffer> {
  if (process.platform !== "win32") throw new ConnectionError(
    "CREDENTIAL_BACKEND_UNAVAILABLE",
    "Secure local credentials require Windows DPAPI; no safe backend is configured on this platform",
  );
  const method = action === "protect" ? "Protect" : "Unprotect";
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; `
    + `$raw=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); `
    + `$entropy=[Text.Encoding]::UTF8.GetBytes('Harnest Credential Vault v1'); `
    + `$out=[Security.Cryptography.ProtectedData]::${method}($raw,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser); `
    + `[Console]::Out.Write([Convert]::ToBase64String($out))`;
  const configuredRoot = process.env.SystemRoot;
  if (!configuredRoot || !isAbsolute(configuredRoot)) throw new ConnectionError(
    "CREDENTIAL_BACKEND_UNAVAILABLE", "The trusted Windows system directory is unavailable",
  );
  const systemRoot = await realpath(configuredRoot);
  if (relative(parse(systemRoot).root, systemRoot).toLocaleLowerCase() !== "windows") throw new ConnectionError(
    "CREDENTIAL_BACKEND_UNAVAILABLE", "The Windows system directory is not trusted",
  );
  const system32 = join(systemRoot, "System32");
  const powershell = join(system32, "WindowsPowerShell", "v1.0", "powershell.exe");
  const executable = await realpath(powershell);
  const executableInfo = await lstat(powershell);
  if (executableInfo.isSymbolicLink() || !executableInfo.isFile() || executable.toLocaleLowerCase() !== powershell.toLocaleLowerCase()) {
    throw new ConnectionError("CREDENTIAL_BACKEND_UNAVAILABLE", "The trusted Windows DPAPI helper is unavailable");
  }
  return new Promise<Buffer>((resolvePromise, reject) => {
    const child = spawn(executable, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script,
    ], {
      cwd: system32,
      env: {
        SystemRoot: systemRoot,
        WINDIR: systemRoot,
        ComSpec: join(system32, "cmd.exe"),
        ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
        ...(process.env.TMP ? { TMP: process.env.TMP } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    const timeout = setTimeout(() => child.kill(), 10_000);
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes <= 65_536) stdout.push(chunk);
      else child.kill();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.reduce((size, item) => size + item.length, 0) < 8_192) stderr.push(chunk);
    });
    child.once("error", (cause) => {
      clearTimeout(timeout);
      reject(new ConnectionError("CREDENTIAL_BACKEND_UNAVAILABLE", "Windows DPAPI could not be started", undefined, cause));
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0 || outputBytes > 65_536) {
        reject(new ConnectionError(
          "CREDENTIAL_STORE_FAILED",
          `Windows DPAPI failed${stderr.length ? `: ${Buffer.concat(stderr).toString("utf8").trim().slice(0, 300)}` : ""}`,
        ));
        return;
      }
      try {
        resolvePromise(Buffer.from(Buffer.concat(stdout).toString("utf8").trim(), "base64"));
      } catch (cause) {
        reject(new ConnectionError("CREDENTIAL_STORE_FAILED", "Windows DPAPI returned invalid data", undefined, cause));
      }
    });
    child.stdin.end(data.toString("base64"));
  });
}

interface CredentialBackendCommand {
  readonly protection: "macos-keychain" | "linux-secret-service";
  readonly candidates: readonly string[];
  readonly args: readonly string[];
}

/** @internal Pure command builder kept exported for platform-independent security tests. */
export function credentialBackendCommand(
  platform: NodeJS.Platform,
  action: "store" | "lookup",
  keyId: string,
): CredentialBackendCommand {
  if (!/^[a-f0-9]{32}$/u.test(keyId)) throw new ConnectionError("CREDENTIAL_STORE_FAILED", "Credential key id is invalid");
  if (platform === "darwin") return {
    protection: "macos-keychain",
    candidates: ["/usr/bin/security"],
    args: action === "store"
      ? ["add-generic-password", "-a", keyId, "-s", "dev.harnest.credential-vault", "-U", "-w"]
      : ["find-generic-password", "-a", keyId, "-s", "dev.harnest.credential-vault", "-w"],
  };
  if (platform === "linux") return {
    protection: "linux-secret-service",
    candidates: ["/usr/bin/secret-tool", "/bin/secret-tool"],
    args: action === "store"
      ? ["store", "--label=Harnest credential vault key", "application", "harnest", "vault", keyId]
      : ["lookup", "application", "harnest", "vault", keyId],
  };
  throw new ConnectionError(
    "CREDENTIAL_BACKEND_UNAVAILABLE",
    "Secure credentials require Windows DPAPI, macOS Keychain, or Linux Secret Service",
  );
}

async function runCredentialBackend(
  action: "store" | "lookup",
  keyId: string,
  secret?: Buffer,
): Promise<Buffer> {
  const descriptor = credentialBackendCommand(process.platform, action, keyId);
  let executable: string | undefined;
  for (const candidate of descriptor.candidates) {
    try {
      const canonical = await realpath(candidate);
      if ((await stat(canonical)).isFile()) {
        executable = canonical;
        break;
      }
    } catch {
      // Try the next fixed system path.
    }
  }
  if (!executable) throw new ConnectionError(
    "CREDENTIAL_BACKEND_UNAVAILABLE",
    descriptor.protection === "linux-secret-service"
      ? "Linux credentials require secret-tool and an unlocked Secret Service collection"
      : "The macOS Keychain security tool is unavailable",
  );
  return new Promise<Buffer>((resolvePromise, reject) => {
    let settled = false;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    const finish = (error?: ConnectionError, value?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolvePromise(value ?? Buffer.alloc(0));
    };
    const child = spawn(executable, [...descriptor.args], {
      cwd: dirname(executable),
      env: Object.fromEntries([
        "DBUS_SESSION_BUS_ADDRESS", "DISPLAY", "HOME", "LANG", "LC_ALL", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR",
      ].flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]!]])),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const timeout = setTimeout(() => {
      child.kill();
      finish(new ConnectionError("CREDENTIAL_BACKEND_UNAVAILABLE", "The OS credential store did not respond"));
    }, 30_000);
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > 65_536) child.kill();
      else stdout.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.reduce((size, item) => size + item.byteLength, 0) < 8_192) stderr.push(Buffer.from(chunk));
    });
    child.once("error", (cause) => finish(new ConnectionError(
      "CREDENTIAL_BACKEND_UNAVAILABLE", "The OS credential store could not be started", undefined, cause,
    )));
    child.once("exit", (code) => {
      if (code !== 0 || outputBytes > 65_536) {
        finish(new ConnectionError(
          "CREDENTIAL_STORE_FAILED",
          `The OS credential store rejected the request${stderr.length ? `: ${Buffer.concat(stderr).toString("utf8").trim().slice(0, 300)}` : ""}`,
        ));
      } else finish(undefined, Buffer.from(Buffer.concat(stdout).toString("utf8").trim(), "base64"));
    });
    child.stdin.end(action === "store" && secret ? `${secret.toString("base64")}\n` : undefined);
  });
}

class CredentialVault {
  readonly #vaultPath: string;
  readonly #keyPath: string;
  readonly #lockPath: string;
  readonly #keyId: string;
  #key: Buffer | undefined;

  constructor(directory: string) {
    this.#vaultPath = join(directory, "credentials.vault");
    this.#keyPath = join(directory, process.platform === "win32" ? "credentials.key.dpapi" : "credentials.key.os");
    this.#lockPath = join(directory, "credentials.lock");
    this.#keyId = createHash("sha256").update(resolve(directory)).digest("hex").slice(0, 32);
  }

  async read(binding: string): Promise<VaultEntry | undefined> {
    return withFileLock(this.#lockPath, async () => structuredClone((await this.#read()).entries[binding]));
  }

  async update(binding: string, update: (entry: VaultEntry) => VaultEntry | undefined): Promise<void> {
    await withFileLock(this.#lockPath, async () => {
      const data = await this.#read();
      const entries = { ...data.entries };
      const next = update(structuredClone(entries[binding] ?? {}));
      if (next === undefined || Object.keys(next).length === 0) delete entries[binding];
      else entries[binding] = next;
      await this.#write({ version: FILE_VERSION, entries });
    });
  }

  paths(): readonly string[] {
    return [this.#vaultPath, this.#keyPath];
  }

  async #dataKey(): Promise<Buffer> {
    if (this.#key) return this.#key;
    const candidate = await readJson(this.#keyPath, 16_384);
    if (candidate !== undefined) {
      if (!isRecord(candidate) || candidate.version !== FILE_VERSION) {
        throw new ConnectionError("CREDENTIAL_STORE_FAILED", "The wrapped credential key file is invalid");
      }
      let key: Buffer;
      if (candidate.protection === "dpapi-current-user" && typeof candidate.wrappedKey === "string") {
        if (process.platform !== "win32") throw new ConnectionError(
          "CREDENTIAL_BACKEND_UNAVAILABLE", "This credential vault is protected by Windows DPAPI",
        );
        key = await dpapi("unprotect", Buffer.from(candidate.wrappedKey, "base64"));
      } else if ((candidate.protection === "macos-keychain" || candidate.protection === "linux-secret-service")
        && candidate.keyId === this.#keyId) {
        const backend = credentialBackendCommand(process.platform, "lookup", this.#keyId);
        if (backend.protection !== candidate.protection) throw new ConnectionError(
          "CREDENTIAL_BACKEND_UNAVAILABLE", `This credential vault is protected by ${candidate.protection}`,
        );
        key = await runCredentialBackend("lookup", this.#keyId);
      } else throw new ConnectionError("CREDENTIAL_STORE_FAILED", "The wrapped credential key file is invalid");
      if (key.length !== 32) throw new ConnectionError("CREDENTIAL_STORE_FAILED", "The OS credential store returned an invalid credential key");
      this.#key = key;
      return key;
    }
    const key = randomBytes(32);
    if (process.platform === "win32") {
      const wrapped = await dpapi("protect", key);
      await atomicJson(this.#keyPath, {
        version: FILE_VERSION,
        protection: "dpapi-current-user",
        wrappedKey: wrapped.toString("base64"),
      } satisfies WrappedKeyFile);
    } else {
      const backend = credentialBackendCommand(process.platform, "store", this.#keyId);
      await runCredentialBackend("store", this.#keyId, key);
      await atomicJson(this.#keyPath, {
        version: FILE_VERSION,
        protection: backend.protection,
        keyId: this.#keyId,
      } satisfies WrappedKeyFile);
    }
    this.#key = key;
    return key;
  }

  async #read(): Promise<VaultData> {
    const candidate = await readJson(this.#vaultPath, MAX_SECRET_BYTES * 4);
    if (candidate === undefined) return { version: FILE_VERSION, entries: {} };
    if (!isRecord(candidate) || candidate.version !== FILE_VERSION || candidate.algorithm !== "aes-256-gcm"
      || typeof candidate.iv !== "string" || typeof candidate.tag !== "string" || typeof candidate.ciphertext !== "string") {
      throw new ConnectionError("CREDENTIAL_STORE_FAILED", "The encrypted credential vault is invalid");
    }
    try {
      const decipher = createDecipheriv("aes-256-gcm", await this.#dataKey(), Buffer.from(candidate.iv, "base64"));
      decipher.setAAD(VAULT_AAD);
      decipher.setAuthTag(Buffer.from(candidate.tag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(candidate.ciphertext, "base64")),
        decipher.final(),
      ]);
      try {
        const parsed = JSON.parse(plaintext.toString("utf8")) as unknown;
        if (!isRecord(parsed) || parsed.version !== FILE_VERSION || !isRecord(parsed.entries)) throw new Error("shape");
        return parsed as unknown as VaultData;
      } finally {
        plaintext.fill(0);
      }
    } catch (cause) {
      throw new ConnectionError("CREDENTIAL_STORE_FAILED", "The credential vault could not be authenticated or decrypted", undefined, cause);
    }
  }

  async #write(data: VaultData): Promise<void> {
    const plaintext = Buffer.from(JSON.stringify(data), "utf8");
    if (plaintext.length > MAX_SECRET_BYTES * 4) {
      plaintext.fill(0);
      throw new ConnectionError("CREDENTIAL_STORE_FAILED", "The credential vault exceeds its size limit");
    }
    try {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", await this.#dataKey(), iv);
      cipher.setAAD(VAULT_AAD);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      await atomicJson(this.#vaultPath, {
        version: FILE_VERSION,
        algorithm: "aes-256-gcm",
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      } satisfies EncryptedVault);
    } finally {
      plaintext.fill(0);
    }
  }
}

function validateCredentialFields(credentials: Readonly<Record<string, string>>): Record<string, string> {
  const result: Record<string, string> = {};
  let total = 0;
  for (const [field, value] of Object.entries(credentials)) {
    if (!CREDENTIAL_FIELD.test(field) || typeof value !== "string") throw new ConnectionError(
      "CONNECTION_INVALID", `Credential field '${field}' is invalid`,
    );
    total += Buffer.byteLength(value, "utf8");
    if (total > MAX_SECRET_BYTES) throw new ConnectionError("CONNECTION_INVALID", "Connection credentials exceed the size limit");
    result[field] = value;
  }
  return result;
}

function validateBindingRecord(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new ConnectionError("CONNECTION_INVALID", `${label} must be an object`);
  for (const [name, field] of Object.entries(value)) {
    if (!name || typeof field !== "string" || !CREDENTIAL_FIELD.test(field)) throw new ConnectionError(
      "CONNECTION_INVALID", `${label} must map names to credential field ids`,
    );
  }
}

function validatePublicConfig(config: Readonly<Record<string, unknown>>): void {
  const seen = new WeakSet<object>();
  let nodes = 0;
  const visit = (value: unknown, path: string, depth = 0): void => {
    if (value === null || typeof value === "boolean") return;
    if (typeof value === "string") {
      if (SECRET_LIKE_VALUE.test(value)) throw new ConnectionError(
        "CONNECTION_INVALID", `Secret-like value '${path}' must be written to the credential store`,
      );
      return;
    }
    if (typeof value === "number") {
      if (Number.isFinite(value)) return;
      throw new ConnectionError("CONNECTION_INVALID", `Non-finite number '${path}' is not valid Connection metadata`);
    }
    if (typeof value !== "object") throw new ConnectionError(
      "CONNECTION_INVALID", `Connection metadata '${path}' must contain only JSON values`,
    );
    if (depth > 32 || (nodes += 1) > 100_000) throw new ConnectionError(
      "CONNECTION_INVALID", "Connection metadata is too deeply nested or complex",
    );
    if (seen.has(value)) throw new ConnectionError("CONNECTION_INVALID", `Connection metadata '${path}' is cyclic`);
    seen.add(value);
    if (Array.isArray(value)) {
      if (value.length > 4_096) throw new ConnectionError("CONNECTION_INVALID", `Connection metadata array '${path}' is too large`);
      value.forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
      return;
    }
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) throw new ConnectionError(
      "CONNECTION_INVALID", `Connection metadata '${path}' must be a plain JSON object`,
    );
    for (const [key, item] of Object.entries(value)) {
      if (key.length > 256 || key === "__proto__" || key === "prototype" || key === "constructor") throw new ConnectionError(
        "CONNECTION_INVALID", `Connection metadata key '${path}.${key}' is invalid`,
      );
      if (key === "headerCredentials" || key === "environmentCredentials") {
        validateBindingRecord(item, `${path}.${key}`);
        continue;
      }
      const normalizedKey = key.replaceAll(/[-_.]/g, "").toLocaleLowerCase();
      if (SENSITIVE_PUBLIC_KEY.test(key) || SENSITIVE_NORMALIZED_KEYS.has(normalizedKey)) throw new ConnectionError(
        "CONNECTION_INVALID",
        `Sensitive field '${path}.${key}' must be written to the credential store, not connection metadata`,
      );
      if (key === "headers" && isRecord(item)) {
        for (const [header, headerValue] of Object.entries(item)) {
          const normalizedHeader = header.replaceAll(/[^a-z0-9]/gi, "").toLocaleLowerCase();
          if (SENSITIVE_HEADER.test(header) || normalizedHeader.includes("auth")
            || normalizedHeader.includes("token") || normalizedHeader.includes("cookie")
            || normalizedHeader.includes("apikey") || typeof headerValue !== "string"
            || SECRET_LIKE_VALUE.test(headerValue)) throw new ConnectionError(
            "CONNECTION_INVALID", `Sensitive or non-string header '${header}' must use headerCredentials`,
          );
        }
      }
      visit(item, `${path}.${key}`, depth + 1);
    }
  };
  visit(config, "config");
  const serialized = JSON.stringify(config);
  if (Buffer.byteLength(serialized, "utf8") > 1_048_576) throw new ConnectionError(
    "CONNECTION_INVALID", "A Connection config cannot exceed 1 MiB",
  );
}

function secureEndpoint(value: unknown, label: string, id?: string): URL {
  if (typeof value !== "string" || value.length === 0 || value.length > 8_192) {
    throw new ConnectionError("CONNECTION_INVALID", `${label} requires a bounded URL`, id);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new ConnectionError("CONNECTION_INVALID", `${label} URL is invalid`, id, cause);
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    || url.username || url.password || url.hash) {
    throw new ConnectionError(
      "CONNECTION_INVALID",
      `${label} URL must use HTTPS, or HTTP on a literal loopback address, without credentials or a fragment`,
      id,
    );
  }
  return url;
}

function assertConfigKeys(
  config: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  id?: string,
): void {
  const unknown = Object.keys(config).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new ConnectionError(
    "CONNECTION_INVALID",
    `Connection config field '${unknown[0]}' is not public metadata; use the credential store for secrets`,
    id,
  );
}

function validateTimeout(value: unknown, id?: string): void {
  if (value !== undefined && (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 600_000)) {
    throw new ConnectionError("CONNECTION_INVALID", "Connection timeout must be between 1 and 600000 ms", id);
  }
}

function validateContainerConfig(config: Readonly<Record<string, unknown>>, id?: string): void {
  if (typeof config.engine !== "string" || !isAbsolute(config.engine)) throw new ConnectionError(
    "CONNECTION_INVALID", "Container sandboxes require an absolute Docker or Podman executable path", id,
  );
  if (typeof config.image !== "string" || !/^[A-Za-z0-9][A-Za-z0-9./:@_-]{0,511}$/u.test(config.image)) {
    throw new ConnectionError("CONNECTION_INVALID", "Container sandbox image is invalid", id);
  }
  if (config.network !== undefined && config.network !== "none") throw new ConnectionError(
    "CONNECTION_INVALID", "Container sandbox network must remain disabled", id,
  );
  for (const [key, minimum, maximum] of [["memoryMb", 64, 4096], ["cpus", 0.1, 8], ["pids", 8, 512]] as const) {
    const value = config[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum)) {
      throw new ConnectionError("CONNECTION_INVALID", `Container sandbox ${key} must be between ${minimum} and ${maximum}`, id);
    }
  }
}

function validateProfileInput(input: ConnectionCreateInput | (ConnectionUpdateInput & { id: string; scope: ConnectionProfile["scope"]; kind: ConnectionProfile["kind"] })): void {
  if (!CONNECTION_ID.test(input.id ?? "generated") || !input.name?.trim() || input.name.trim().length > 120 || !isRecord(input.config)) {
    throw new ConnectionError("CONNECTION_INVALID", "Connection id, name, or config is invalid", input.id);
  }
  if (input.kind === "provider") {
    assertConfigKeys(input.config, [
      "adapter", "model", "baseUrl", "temperature", "maxTokens",
      "inputCostPerMillion", "outputCostPerMillion", "timeoutMs",
    ], input.id);
    validatePublicConfig(input.config);
    if (typeof input.config.adapter !== "string" || !input.config.adapter
      || typeof input.config.model !== "string" || !input.config.model) {
      throw new ConnectionError("CONNECTION_INVALID", "Provider Connections require adapter and model ids", input.id);
    }
    if (input.config.baseUrl !== undefined) secureEndpoint(input.config.baseUrl, "Provider", input.id);
    validateTimeout(input.config.timeoutMs, input.id);
    return;
  }
  if (input.kind === "http-api" || input.kind === "tool-service") {
    assertConfigKeys(input.config, input.kind === "tool-service"
      ? [
        "url", "headers", "headerCredentials", "timeoutMs", "connector", "authScheme",
        "method", "requestEncoding", "queryParameter", "limitParameter", "staticParameters",
        "responseItemsPath", "titleField", "urlField", "snippetField", "contentField",
        "cursorParameter", "nextCursorPath", "testUrl", "testMethod",
        "scrapeUrl", "scrapeMethod", "scrapeUrlParameter", "scrapeStaticParameters",
        "scrapeContentPath", "scrapeTitlePath", "scrapeSourceUrlPath",
      ]
      : ["url", "headers", "headerCredentials", "timeoutMs"], input.id);
    validatePublicConfig(input.config);
    secureEndpoint(input.config.url, input.kind === "http-api" ? "HTTP API" : "Tool Service", input.id);
    validateBindingRecord(input.config.headerCredentials, "config.headerCredentials");
    if (input.kind === "tool-service") {
      if (input.config.connector !== undefined
        && (typeof input.config.connector !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(input.config.connector))) {
        throw new ConnectionError("CONNECTION_INVALID", "Tool Service connector id is invalid", input.id);
      }
      if (input.config.authScheme !== undefined && !["none", "bearer"].includes(String(input.config.authScheme))) {
        throw new ConnectionError("CONNECTION_INVALID", "Tool Service authScheme is invalid", input.id);
      }
      if (input.config.method !== undefined && !["GET", "POST"].includes(String(input.config.method))) {
        throw new ConnectionError("CONNECTION_INVALID", "Custom Search method must be GET or POST", input.id);
      }
      if (input.config.requestEncoding !== undefined && !["query", "json"].includes(String(input.config.requestEncoding))) {
        throw new ConnectionError("CONNECTION_INVALID", "Search request encoding must be query or json", input.id);
      }
      if (input.config.testMethod !== undefined && !["GET", "POST"].includes(String(input.config.testMethod))) {
        throw new ConnectionError("CONNECTION_INVALID", "Search test method must be GET or POST", input.id);
      }
      if (input.config.testUrl !== undefined) secureEndpoint(input.config.testUrl, "Search test", input.id);
      if (input.config.scrapeUrl !== undefined) secureEndpoint(input.config.scrapeUrl, "Scrape connector", input.id);
      if (input.config.scrapeMethod !== undefined && input.config.scrapeMethod !== "POST") throw new ConnectionError(
        "CONNECTION_INVALID", "Scrape request method must be POST", input.id,
      );
      if (input.config.staticParameters !== undefined && !isRecord(input.config.staticParameters)) {
        throw new ConnectionError("CONNECTION_INVALID", "Search staticParameters must be an object", input.id);
      }
      if (input.config.scrapeStaticParameters !== undefined && !isRecord(input.config.scrapeStaticParameters)) {
        throw new ConnectionError("CONNECTION_INVALID", "Scrape staticParameters must be an object", input.id);
      }
      for (const field of [
        "queryParameter", "limitParameter", "cursorParameter", "titleField", "urlField", "snippetField", "contentField",
        "scrapeUrlParameter",
      ] as const) {
        const value = input.config[field];
        if (value !== undefined && (typeof value !== "string" || value.length > 256
          || (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value) && !/^\/(?:[^/~]|~[01])+(?:\/(?:[^/~]|~[01])+)*$/.test(value)))) {
          throw new ConnectionError("CONNECTION_INVALID", `Search ${field} is invalid`, input.id);
        }
      }
      if (input.config.responseItemsPath !== undefined && (typeof input.config.responseItemsPath !== "string"
        || input.config.responseItemsPath.length > 512
        || (input.config.responseItemsPath !== "" && !/^\/(?:[^/~]|~[01])+(?:\/(?:[^/~]|~[01])+)*$/.test(input.config.responseItemsPath)))) {
        throw new ConnectionError("CONNECTION_INVALID", "Search responseItemsPath must be a JSON Pointer", input.id);
      }
      for (const field of ["nextCursorPath", "scrapeContentPath", "scrapeTitlePath", "scrapeSourceUrlPath"] as const) {
        const value = input.config[field];
        if (value !== undefined && (typeof value !== "string" || value.length > 512
          || !/^\/(?:[^/~]|~[01])+(?:\/(?:[^/~]|~[01])+)*$/u.test(value))) throw new ConnectionError(
          "CONNECTION_INVALID", `Tool Service ${field} must be a JSON Pointer`, input.id,
        );
      }
    }
    validateTimeout(input.config.timeoutMs, input.id);
    return;
  }
  if (input.kind === "local-runtime") {
    assertConfigKeys(input.config, [
      "sandbox", "engine", "image", "runtime", "command", "args", "cwd", "timeoutMs",
      "memoryMb", "cpus", "pids", "network",
    ], input.id);
    validatePublicConfig(input.config);
    if (input.config.sandbox === "container") {
      validateContainerConfig(input.config, input.id);
      if (!["node", "python", "shell", "custom"].includes(String(input.config.runtime))) throw new ConnectionError(
        "CONNECTION_INVALID", "Sandbox runtime must be node, python, shell, or custom", input.id,
      );
      if (input.config.command !== undefined && (typeof input.config.command !== "string"
        || input.config.command.length === 0 || input.config.command.length > 8_192 || input.config.command.includes("\0"))) {
        throw new ConnectionError("CONNECTION_INVALID", "Sandbox command is invalid", input.id);
      }
    } else if (typeof input.config.command !== "string" || !input.config.command.trim() || !isAbsolute(input.config.command)) {
      throw new ConnectionError("CONNECTION_INVALID", "Trusted Local Runtime Connections require an absolute command path", input.id);
    }
    if (input.config.args !== undefined && (!Array.isArray(input.config.args)
      || input.config.args.length > 256
      || !input.config.args.every((value) => typeof value === "string" && value.length <= 32_768))) {
      throw new ConnectionError("CONNECTION_INVALID", "Local Runtime args must be bounded strings", input.id);
    }
    validateTimeout(input.config.timeoutMs, input.id);
    return;
  }
  if (input.kind !== "mcp") throw new ConnectionError("CONNECTION_INVALID", "Connection kind is invalid", input.id);
  const transport = input.config.transport;
  if (transport === "stdio") assertConfigKeys(
    input.config,
    [
      "transport", "protocol", "sandbox", "engine", "image", "command", "args", "cwd",
      "environmentCredentials", "timeoutMs", "memoryMb", "cpus", "pids", "network",
    ],
    input.id,
  );
  else if (transport === "http") assertConfigKeys(
    input.config,
    ["transport", "protocol", "url", "headers", "headerCredentials", "oauth", "timeoutMs"],
    input.id,
  );
  else throw new ConnectionError("CONNECTION_INVALID", "MCP connection transport must be stdio or http", input.id);
  validatePublicConfig(input.config);
  if (input.config.protocol !== undefined && !["legacy", "auto", "2026-07-28"].includes(String(input.config.protocol))) {
    throw new ConnectionError("CONNECTION_INVALID", "MCP protocol mode is invalid", input.id);
  }
  validateTimeout(input.config.timeoutMs, input.id);
  if (transport === "stdio") {
    if (input.config.sandbox === "container") {
      validateContainerConfig(input.config, input.id);
      if (input.config.cwd !== undefined) throw new ConnectionError(
        "CONNECTION_INVALID", "Containerized MCP uses its isolated /workspace directory and cannot bind a host cwd", input.id,
      );
    }
    if (typeof input.config.command !== "string" || !input.config.command.trim() || input.config.command.length > 32_768
      || input.config.command.includes("\0") || (input.config.sandbox !== "container" && !isAbsolute(input.config.command))) {
      throw new ConnectionError(
        "CONNECTION_INVALID",
        input.config.sandbox === "container"
          ? "Containerized MCP requires a bounded command available in its image"
          : "Legacy MCP stdio metadata requires an absolute command path",
        input.id,
      );
    }
    if (input.config.args !== undefined && (!Array.isArray(input.config.args)
      || input.config.args.length > 256
      || !input.config.args.every((value) => typeof value === "string" && value.length <= 32_768))) {
      throw new ConnectionError("CONNECTION_INVALID", "MCP stdio args must be strings", input.id);
    }
    if (input.config.cwd !== undefined && (typeof input.config.cwd !== "string"
      || !input.config.cwd || input.config.cwd.length > 2_048 || isAbsolute(input.config.cwd))) {
      throw new ConnectionError("CONNECTION_INVALID", "MCP stdio cwd must be project-relative", input.id);
    }
    validateBindingRecord(input.config.environmentCredentials, "config.environmentCredentials");
    for (const name of Object.keys(isRecord(input.config.environmentCredentials) ? input.config.environmentCredentials : {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new ConnectionError(
        "CONNECTION_INVALID", `MCP environment variable '${name}' is invalid`, input.id,
      );
    }
  } else if (transport === "http") {
    secureEndpoint(input.config.url, "MCP HTTP", input.id);
    if (input.config.oauth !== undefined && typeof input.config.oauth !== "boolean") throw new ConnectionError(
      "CONNECTION_INVALID", "MCP OAuth config must be a boolean", input.id,
    );
    validateBindingRecord(input.config.headerCredentials, "config.headerCredentials");
    for (const name of Object.keys(isRecord(input.config.headerCredentials) ? input.config.headerCredentials : {})) {
      try {
        new Headers().set(name, "value");
      } catch (cause) {
        throw new ConnectionError("CONNECTION_INVALID", `MCP HTTP header '${name}' is invalid`, input.id, cause);
      }
      if ((input.config.oauth === true || isRecord(input.config.oauth)) && name.toLocaleLowerCase() === "authorization") {
        throw new ConnectionError("CONNECTION_INVALID", "OAuth Connections cannot also bind an Authorization header", input.id);
      }
    }
  }
}

function connectionToolFrom(value: unknown, connectionId?: string): ConnectionTool {
  if (!isRecord(value) || typeof value.name !== "string" || !value.name
    || (value.title !== undefined && typeof value.title !== "string")
    || (value.description !== undefined && typeof value.description !== "string")
    || (value.annotations !== undefined && !isRecord(value.annotations))) {
    throw new ConnectionError("CONNECTION_INVALID", "Stored Connection tool metadata is invalid", connectionId);
  }
  const inputSchema = snapshotSafeJsonSchema(value.inputSchema);
  const outputSchema = value.outputSchema === undefined ? undefined : snapshotSafeJsonSchema(value.outputSchema);
  if (!inputSchema || (value.outputSchema !== undefined && !outputSchema)) throw new ConnectionError(
    "CONNECTION_INVALID",
    "Connection tool contains an invalid or unsafe JSON Schema",
    connectionId,
  );
  return {
    name: value.name,
    ...(value.title === undefined ? {} : { title: value.title }),
    ...(value.description === undefined ? {} : { description: value.description }),
    inputSchema,
    ...(outputSchema === undefined ? {} : { outputSchema }),
    ...(value.annotations === undefined ? {} : { annotations: structuredClone(value.annotations) }),
  };
}

function profileFrom(value: unknown): ConnectionProfile {
  if (!isRecord(value) || typeof value.id !== "string" || !CONNECTION_ID.test(value.id)
    || (value.scope !== "project" && value.scope !== "user")
    || !["provider", "mcp", "http-api", "tool-service", "local-runtime"].includes(String(value.kind))
    || typeof value.name !== "string" || !isRecord(value.config)
    || !Array.isArray(value.credentialFields) || !value.credentialFields.every((item) => typeof item === "string" && CREDENTIAL_FIELD.test(item))
    || !isRecord(value.status) || ![
      "unknown", "connected", "disconnected", "needs_auth", "expired",
      "insufficient_scope", "revocation_pending", "error",
    ].includes(String(value.status.state))
    || typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") {
    throw new ConnectionError("CONNECTION_INVALID", "Stored connection metadata is invalid");
  }
  if ((value.status.checkedAt !== undefined && typeof value.status.checkedAt !== "string")
    || (value.status.message !== undefined && typeof value.status.message !== "string")) {
    throw new ConnectionError("CONNECTION_INVALID", "Stored connection status is invalid", value.id);
  }
  const storedId = value.id;
  const kind = value.kind as ConnectionProfile["kind"];
  validateProfileInput({
    id: value.id,
    scope: value.scope,
    kind,
    name: value.name,
    config: value.config,
  });
  let tools: ConnectionTool[] | undefined;
  if (value.tools !== undefined) {
    if (!Array.isArray(value.tools)) throw new ConnectionError("CONNECTION_INVALID", "Stored Connection tools are invalid", storedId);
    tools = value.tools.map((candidate) => connectionToolFrom(candidate, storedId));
  }
  return {
    id: value.id,
    scope: value.scope,
    kind,
    name: value.name,
    config: structuredClone(value.config),
    credentialFields: [...new Set(value.credentialFields)].sort(),
    status: {
      state: value.status.state as ConnectionStatus["state"],
      ...(value.status.checkedAt === undefined ? {} : { checkedAt: value.status.checkedAt }),
      ...(value.status.message === undefined ? {} : { message: value.status.message }),
    },
    ...(tools === undefined ? {} : { tools }),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function toolsFrom(tools: readonly Tool[]): ConnectionTool[] {
  if (tools.length > 2_048) throw new ConnectionError("CONNECTION_TEST_FAILED", "MCP Tool discovery exceeds 2048 entries");
  return tools.map((tool) => connectionToolFrom(tool));
}

export async function canonicalExecutable(command: unknown, connectionId?: string): Promise<{
  readonly path: string;
  readonly identity: Readonly<Record<string, number>>;
}> {
  if (typeof command !== "string" || !isAbsolute(command)) throw new ConnectionError(
    "CONNECTION_INVALID", "Process command must be an absolute executable path", connectionId,
  );
  const lexical = resolve(command);
  const info = await lstat(lexical);
  const canonical = await realpath(lexical);
  const samePath = process.platform === "win32"
    ? canonical.toLocaleLowerCase() === lexical.toLocaleLowerCase() : canonical === lexical;
  if (!info.isFile() || info.isSymbolicLink() || !samePath) throw new ConnectionError(
    "CONNECTION_INVALID", "Process command must be a canonical, non-link regular file", connectionId,
  );
  return {
    path: canonical,
    identity: { size: info.size, mtimeMs: info.mtimeMs, dev: info.dev, ino: info.ino },
  };
}

export async function mcpProcessFingerprint(
  profile: ConnectionProfile,
  container?: Awaited<ReturnType<typeof containerImageIdentity>>,
): Promise<string> {
  if (profile.kind !== "mcp" || profile.config.transport !== "stdio") throw new ConnectionError(
    "CONNECTION_TYPE_MISMATCH", `Connection '${profile.id}' is not MCP stdio`, profile.id,
  );
  if (profile.config.sandbox === "container") {
    container ??= await containerImageIdentity(profile);
    return createHash("sha256").update(JSON.stringify({
      engine: container.engine,
      imageId: container.imageId,
      config: canonicalJson(profile.config),
    })).digest("hex");
  }
  const executable = await canonicalExecutable(profile.config.command, profile.id);
  const canonical = JSON.stringify({
    command: executable,
    args: profile.config.args ?? [],
    cwd: profile.config.cwd ?? ".",
    environmentCredentials: Object.entries(isRecord(profile.config.environmentCredentials)
      ? profile.config.environmentCredentials : {}).sort(([left], [right]) => left.localeCompare(right)),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function containerEngineEnvironment(): Record<string, string> {
  return Object.fromEntries([
    "HOME", "USERPROFILE", "SystemRoot", "TEMP", "TMP", "XDG_RUNTIME_DIR", "DOCKER_HOST", "CONTAINER_HOST",
  ].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
}

export async function detectContainerEngine(): Promise<string> {
  const windowsRoots = [process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(
    (value): value is string => typeof value === "string" && isAbsolute(value),
  );
  const candidates = process.platform === "win32"
    ? windowsRoots.flatMap((root) => [
      join(root, "Docker", "Docker", "resources", "bin", "docker.exe"),
      join(root, "RedHat", "Podman", "podman.exe"),
    ])
    : process.platform === "darwin"
      ? [
        "/Applications/Docker.app/Contents/Resources/bin/docker",
        "/opt/homebrew/bin/docker", "/usr/local/bin/docker", "/opt/homebrew/bin/podman", "/usr/local/bin/podman",
      ]
      : ["/usr/bin/docker", "/usr/local/bin/docker", "/usr/bin/podman", "/usr/local/bin/podman"];
  for (const candidate of [...new Set(candidates)]) {
    try {
      return (await canonicalExecutable(candidate)).path;
    } catch {
      // Continue through fixed, trusted installation locations.
    }
  }
  throw new ConnectionError(
    "CONNECTION_TEST_FAILED",
    "No Docker or Podman engine was found. Install one, start it, then Connect again.",
  );
}

export interface ContainerMount {
  readonly source: string;
  readonly target: "/mnt/data" | "/mnt/output";
  readonly readOnly: boolean;
}

export function containerRunArguments(
  profile: ConnectionProfile,
  name: string,
  command: readonly string[],
  environmentNames: readonly string[] = [],
  imageIdentity?: string,
  mounts: readonly ContainerMount[] = [],
): string[] {
  if (profile.config.sandbox !== "container" || typeof profile.config.image !== "string") throw new ConnectionError(
    "CONNECTION_TYPE_MISMATCH", `Connection '${profile.id}' is not a container sandbox`, profile.id,
  );
  const memoryMb = typeof profile.config.memoryMb === "number" ? profile.config.memoryMb : 256;
  const cpus = typeof profile.config.cpus === "number" ? profile.config.cpus : 1;
  const pids = typeof profile.config.pids === "number" ? profile.config.pids : 64;
  for (const mount of mounts) {
    if (!isAbsolute(mount.source) || mount.source.includes("\0") || mount.source.includes(",")
      || (mount.target !== "/mnt/data" && mount.target !== "/mnt/output")) throw new ConnectionError(
      "CONNECTION_INVALID", "Sandbox mount is invalid", profile.id,
    );
  }
  return [
    "run", "--rm", "--interactive", "--name", name, "--pull", "never", "--network", "none", "--read-only",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", String(pids),
    "--memory", `${memoryMb}m`, "--cpus", String(cpus), "--stop-timeout", "1",
    "--tmpfs", "/workspace:rw,nosuid,nodev,size=64m", "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m",
    "--workdir", "/workspace", "--user", "65534:65534",
    ...mounts.flatMap((mount) => [
      "--mount",
      `type=bind,source=${mount.source},target=${mount.target}${mount.readOnly ? ",readonly" : ""}`,
    ]),
    ...environmentNames.flatMap((name) => ["--env", name]),
    imageIdentity ?? profile.config.image,
    ...command,
  ];
}

async function containerImageIdentity(profile: ConnectionProfile, signal = new AbortController().signal): Promise<{
  readonly engine: Awaited<ReturnType<typeof canonicalExecutable>>;
  readonly imageId: string;
}> {
  if (profile.config.sandbox !== "container"
    || (profile.kind !== "local-runtime" && !(profile.kind === "mcp" && profile.config.transport === "stdio"))) throw new ConnectionError(
    "CONNECTION_TYPE_MISMATCH", `Connection '${profile.id}' is not a container sandbox`, profile.id,
  );
  const engine = await canonicalExecutable(profile.config.engine, profile.id);
  const result = await runBoundedProcess({
    toolId: `connection:${profile.id}`,
    command: engine.path,
    args: ["image", "inspect", "--format", "{{.Id}}", profile.config.image as string],
    cwd: dirname(engine.path),
    stdin: "",
    timeoutMs: typeof profile.config.timeoutMs === "number" ? profile.config.timeoutMs : 30_000,
    maxInputBytes: 1,
    maxOutputBytes: 64 * 1_024,
    signal,
    environment: containerEngineEnvironment(),
  });
  const imageId = result.stdout.trim();
  if (!/^(?:sha256:)?[a-f0-9]{64}$/u.test(imageId)) throw new ConnectionError(
    "CONNECTION_TEST_FAILED", "Container engine returned an invalid image identity", profile.id,
  );
  return { engine, imageId };
}

async function processFingerprint(
  profile: ConnectionProfile,
  container?: Awaited<ReturnType<typeof containerImageIdentity>>,
): Promise<string> {
  if (profile.kind === "mcp") return mcpProcessFingerprint(profile, container);
  if (profile.kind !== "local-runtime") throw new ConnectionError(
    "CONNECTION_TYPE_MISMATCH", `Connection '${profile.id}' is not a process runtime`, profile.id,
  );
  container ??= profile.config.sandbox === "container" ? await containerImageIdentity(profile) : undefined;
  const executable = container?.engine ?? await canonicalExecutable(profile.config.command, profile.id);
  return createHash("sha256").update(JSON.stringify({
    executable,
    ...(container ? { imageId: container.imageId } : {}),
    config: canonicalJson(profile.config),
  })).digest("hex");
}

/** Stable approval identity; binds a visible Tool id to its saved Connection and exact MCP action. */
export function mcpToolApprovalId(connectionId: string, action: string): string {
  return `mcp.${createHash("sha256").update(connectionId).update("\0").update(action).digest("hex")}`;
}

export class ConnectionManager implements ConnectionCatalog {
  readonly #root: Promise<string>;
  readonly #projectFile: string;
  readonly #userFile: string;
  readonly #vault: CredentialVault;
  readonly #now: () => Date;
  #projectBinding: Promise<string> | undefined;

  constructor(projectDirectory: string, options: ConnectionManagerOptions = {}) {
    const absolute = resolve(projectDirectory);
    this.#root = realpath(absolute);
    this.#projectFile = join(absolute, ".harnest", "connections.json");
    const userDirectory = resolve(/* turbopackIgnore: true */ options.userDataDirectory ?? defaultUserDataDirectory());
    this.#userFile = join(userDirectory, "connections.json");
    this.#vault = new CredentialVault(userDirectory);
    this.#now = options.now ?? (() => new Date());
  }

  async list(search: ConnectionSearch = {}): Promise<readonly ConnectionProfile[]> {
    const profiles = [...await this.#readFile(this.#projectFile), ...await this.#readFile(this.#userFile)];
    const text = search.text?.trim().toLocaleLowerCase();
    return profiles.filter((profile) =>
      (search.scope === undefined || profile.scope === search.scope)
      && (search.kind === undefined || profile.kind === search.kind)
      && (!text || `${profile.name} ${profile.id} ${profile.kind}`.toLocaleLowerCase().includes(text)))
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  }

  async get(id: string): Promise<ConnectionProfile | undefined> {
    if (!CONNECTION_ID.test(id)) return undefined;
    return (await this.list()).find((profile) => profile.id === id);
  }

  async require(id: string, kind?: ConnectionProfile["kind"]): Promise<ConnectionProfile> {
    const profile = await this.get(id);
    if (!profile) throw new ConnectionError("CONNECTION_NOT_FOUND", `Connection '${id}' does not exist`, id);
    if (kind !== undefined && profile.kind !== kind) throw new ConnectionError(
      "CONNECTION_TYPE_MISMATCH", `Connection '${id}' is '${profile.kind}', not '${kind}'`, id,
    );
    return profile;
  }

  async create(input: ConnectionCreateInput, credentials: Readonly<Record<string, string>> = {}): Promise<ConnectionProfile> {
    const id = input.id ?? `connection_${randomUUID().replaceAll("-", "")}`;
    const candidate = { ...input, id };
    validateProfileInput(candidate);
    if (await this.get(id)) throw new ConnectionError("CONNECTION_DUPLICATE", `Connection '${id}' already exists`, id);
    const credentialValues = validateCredentialFields(credentials);
    const time = timestamp(this.#now);
    const profile: ConnectionProfile = {
      id,
      scope: input.scope,
      kind: input.kind,
      name: input.name.trim(),
      config: structuredClone(input.config),
      credentialFields: Object.keys(credentialValues).sort(),
      status: { state: "unknown" },
      createdAt: time,
      updatedAt: time,
    };
    const binding = await this.#binding(profile.scope, profile.id);
    const transaction = Object.keys(credentialValues).length ? randomUUID() : undefined;
    await this.#vault.update(binding, () => transaction ? {
      fields: credentialValues,
      profileBinding: connectionProfileBinding(profile),
      pendingCreate: transaction,
    } : undefined);
    let metadataWritten = false;
    try {
      await this.#mutateFile(this.#fileFor(input.scope), (profiles) => {
        if (profiles.some((item) => item.id === id)) throw new ConnectionError(
          "CONNECTION_DUPLICATE", `Connection '${id}' already exists`, id,
        );
        return [...profiles, profile];
      });
      metadataWritten = true;
      if (transaction) await this.#vault.update(binding, (entry) => {
        if (entry.pendingCreate !== transaction) throw new ConnectionError(
          "CREDENTIAL_STORE_FAILED", "Connection credential creation transaction was replaced", id,
        );
        return omitKeys(entry, ["pendingCreate"]);
      });
      return structuredClone(profile);
    } catch (cause) {
      const rollback = await Promise.allSettled([
        ...(transaction ? [this.#vault.update(
          binding,
          (entry) => entry.pendingCreate === transaction ? undefined : entry,
        )] : []),
        ...(metadataWritten ? [this.#mutateFile(
          this.#fileFor(input.scope),
          (profiles) => profiles.filter((item) => item.id !== id),
        )] : []),
      ]);
      if (rollback.some((result) => result.status === "rejected")) throw new ConnectionError(
        "CREDENTIAL_STORE_FAILED", "Connection creation failed and could not be rolled back safely", id, cause,
      );
      throw cause;
    }
  }

  async update(id: string, input: ConnectionUpdateInput, credentials?: Readonly<Record<string, string>>): Promise<ConnectionProfile> {
    const current = await this.require(id);
    const candidate = {
      id,
      scope: current.scope,
      kind: current.kind,
      name: input.name ?? current.name,
      config: input.config ?? current.config,
    };
    validateProfileInput(candidate);
    const credentialValues = credentials === undefined ? undefined : validateCredentialFields(credentials);
    const vaultBinding = await this.#binding(current.scope, id);
    const stored = await this.#vault.read(vaultBinding);
    this.#assertVaultBinding(current, stored);
    const configChanged = JSON.stringify(current.config) !== JSON.stringify(candidate.config);
    const changedLaunch = configChanged && (current.kind === "local-runtime"
      || (current.kind === "mcp" && current.config.transport === "stdio"));
    const changedStdioCredential = current.kind === "mcp" && current.config.transport === "stdio"
      && credentials !== undefined;
    const changedHttpResource = current.kind === "mcp" && current.config.transport === "http"
      && (candidate.config.transport !== "http"
        || current.config.url !== candidate.config.url
        || JSON.stringify(current.config.oauth) !== JSON.stringify(candidate.config.oauth));
    await this.#vault.update(vaultBinding, (entry) => {
      this.#assertVaultBinding(current, entry);
      let next: VaultEntry = credentialValues === undefined
        ? entry
        : { ...entry, fields: { ...entry.fields, ...credentialValues } };
      if (changedLaunch || changedStdioCredential) next = omitKeys(next, ["processApproval"]);
      if (changedHttpResource) next = omitKeys(next, ["oauth", "oauthSession"]);
      if (!protectedVaultEntry(next)) {
        const unbound = omitKeys(next, ["profileBinding"]);
        return Object.keys(unbound).length ? unbound : undefined;
      }
      return { ...next, profileBinding: connectionProfileBinding(candidate) };
    });
    try {
      const fields = credentials === undefined
        ? [...current.credentialFields]
        : Object.keys((await this.#vault.read(vaultBinding))?.fields ?? {}).sort();
      const base = omitKeys(current, ["tools"]);
      const updated: ConnectionProfile = {
        ...(configChanged ? base : current),
        name: candidate.name.trim(),
        config: structuredClone(candidate.config),
        credentialFields: fields,
        status: { state: "unknown" },
        updatedAt: timestamp(this.#now),
      };
      await this.#replace(updated);
      return structuredClone(updated);
    } catch (cause) {
      try {
        await this.#vault.update(vaultBinding, () => stored);
      } catch (rollbackCause) {
        throw new ConnectionError(
          "CREDENTIAL_STORE_FAILED",
          "Connection update failed and the original credential state could not be restored safely",
          id,
          new AggregateError([cause, rollbackCause], "Connection update rollback failed"),
        );
      }
      throw cause;
    }
  }

  async delete(id: string): Promise<boolean> {
    const current = await this.get(id);
    if (!current) return false;
    await this.#vault.update(await this.#binding(current.scope, id), () => undefined);
    await this.#mutateFile(this.#fileFor(current.scope), (profiles) => profiles.filter((profile) => profile.id !== id));
    return true;
  }

  async disconnect(id: string, options: { revoke?: boolean; allowNetworkHosts?: true | readonly string[] } = {}): Promise<ConnectionProfile> {
    const current = await this.require(id);
    const binding = await this.#binding(current.scope, id);
    this.#assertVaultBinding(current, await this.#vault.read(binding));
    if (options.revoke && current.kind === "mcp" && current.config.transport === "http") {
      try {
        await this.#revokeOAuth(
          current,
          await this.oauthNetworkHostsFor(current.id, options.allowNetworkHosts),
        );
      } catch (cause) {
        const message = safeMessage(cause, await this.#secretValues(current));
        return this.#setStatus(current, {
          state: "revocation_pending",
          checkedAt: timestamp(this.#now),
          message: `Remote OAuth revocation is pending: ${message}`,
        });
      }
    }
    await this.#vault.update(binding, (entry) => entry.processApproval
      ? { processApproval: entry.processApproval, profileBinding: connectionProfileBinding(current) }
      : undefined);
    return this.#setStatus(
      { ...current, credentialFields: [] },
      { state: "disconnected", checkedAt: timestamp(this.#now) },
      [],
    );
  }

  async credentialPresence(id: string): Promise<readonly string[]> {
    const profile = await this.require(id);
    const entry = await this.#vault.read(await this.#binding(profile.scope, id));
    this.#assertVaultBinding(profile, entry);
    return Object.keys(entry?.fields ?? {}).sort();
  }

  async resolveCredential(id: string, field: string): Promise<string | undefined> {
    if (!CREDENTIAL_FIELD.test(field)) return undefined;
    const profile = await this.require(id);
    const entry = await this.#vault.read(await this.#binding(profile.scope, id));
    this.#assertVaultBinding(profile, entry);
    return entry?.fields?.[field];
  }

  credentialReference(id: string, field: string): string {
    if (!CONNECTION_ID.test(id) || !CREDENTIAL_FIELD.test(field)) throw new ConnectionError(
      "CONNECTION_INVALID", "Connection credential reference is invalid", id,
    );
    return `connection:${encodeURIComponent(id)}:${encodeURIComponent(field)}`;
  }

  async resolveCredentialReference(reference: string): Promise<string | undefined> {
    const match = SECRET_REFERENCE.exec(reference);
    if (!match) return undefined;
    return this.resolveCredential(decodeURIComponent(match[1]!), decodeURIComponent(match[2]!));
  }

  async approveProcess(id: string, options: { readonly pullImage?: boolean; readonly signal?: AbortSignal } = {}): Promise<string> {
    const profile = await this.require(id);
    if (options.pullImage && profile.config.sandbox === "container") {
      try {
        await containerImageIdentity(profile, options.signal);
      } catch {
        const engine = await canonicalExecutable(profile.config.engine, profile.id);
        const pulled = await runBoundedProcess({
          toolId: `connection:${profile.id}:pull`,
          command: engine.path,
          args: ["pull", profile.config.image as string],
          cwd: dirname(engine.path),
          stdin: "",
          timeoutMs: 300_000,
          maxInputBytes: 1,
          maxOutputBytes: 4 * 1_048_576,
          signal: options.signal ?? new AbortController().signal,
          environment: containerEngineEnvironment(),
        });
        if (pulled.exitCode !== 0) throw new ConnectionError(
          "CONNECTION_TEST_FAILED", `Container image could not be downloaded: ${pulled.stderr.trim() || "engine failed"}`, profile.id,
        );
      }
    }
    const fingerprint = await processFingerprint(profile);
    await this.#vault.update(await this.#binding(profile.scope, id), (entry) => {
      this.#assertVaultBinding(profile, entry);
      return { ...entry, processApproval: fingerprint, profileBinding: connectionProfileBinding(profile) };
    });
    return fingerprint;
  }

  async assertProcessApproved(profile: ConnectionProfile): Promise<string | undefined> {
    const container = profile.config.sandbox === "container" ? await containerImageIdentity(profile) : undefined;
    const fingerprint = await processFingerprint(profile, container);
    const entry = await this.#vault.read(await this.#binding(profile.scope, profile.id));
    this.#assertVaultBinding(profile, entry);
    const approved = entry?.processApproval;
    if (!approved || approved !== fingerprint) throw new ConnectionError(
      "PROCESS_APPROVAL_REQUIRED",
      `Process launch profile '${profile.name}' must be reviewed and approved`,
      profile.id,
    );
    return container?.imageId;
  }

  async test(id: string, options: ConnectionTestOptions = {}): Promise<ConnectionProfile> {
    const profile = await this.require(id);
    if (profile.kind === "tool-service") {
      try {
        await executeWebSearchConnection(this, profile, {
          query: "Harnest connection test",
          limit: 1,
          testOnly: true,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        return await this.#setStatus(profile, {
          state: "connected", checkedAt: timestamp(this.#now), message: "Search connector is ready",
        });
      } catch (cause) {
        const failed = await this.#setFailureStatus(profile, cause);
        throw new ConnectionError("CONNECTION_TEST_FAILED", failed.status.message ?? "Connection test failed", id, cause);
      }
    }
    if (profile.kind === "http-api") {
      try {
        const url = secureEndpoint(profile.config.url, "HTTP API", profile.id);
        const headers = new Headers({ accept: "application/json, text/plain;q=0.9, */*;q=0.1" });
        for (const [name, value] of Object.entries(isRecord(profile.config.headers) ? profile.config.headers : {})) {
          if (typeof value === "string") headers.set(name, value);
        }
        for (const [name, field] of Object.entries(isRecord(profile.config.headerCredentials)
          ? profile.config.headerCredentials : {})) {
          if (typeof field !== "string") continue;
          const value = await this.resolveCredential(profile.id, field);
          if (value === undefined) throw new Error(`Credential field '${field}' is required`);
          headers.set(name, value);
        }
        const request = guardedFetch(true, {
          timeoutMs: typeof profile.config.timeoutMs === "number" ? profile.config.timeoutMs : 30_000,
          maxResponseBytes: 64 * 1_024,
        });
        let response = await request(url, { method: "HEAD", headers, redirect: "error", ...(options.signal ? { signal: options.signal } : {}) });
        if (response.status === 405 || response.status === 501) {
          response = await request(url, { method: "GET", headers, redirect: "error", ...(options.signal ? { signal: options.signal } : {}) });
        }
        if (response.status === 401 || response.status === 403) throw new Error(`HTTP API returned ${response.status} Unauthorized`);
        if (response.status >= 500) throw new Error(`HTTP API returned ${response.status}`);
        return await this.#setStatus(profile, {
          state: "connected", checkedAt: timestamp(this.#now), message: `HTTP API is reachable (HTTP ${response.status})`,
        });
      } catch (cause) {
        const failed = await this.#setFailureStatus(profile, cause);
        throw new ConnectionError("CONNECTION_TEST_FAILED", failed.status.message ?? "HTTP API test failed", id, cause);
      }
    }
    if (profile.kind === "local-runtime" && profile.config.sandbox === "container") {
      try {
        const { imageId } = await containerImageIdentity(profile, options.signal);
        return await this.#setStatus(profile, {
          state: "connected",
          checkedAt: timestamp(this.#now),
          message: `Isolated container image ${imageId.slice(0, 19)}… is ready`,
        });
      } catch (cause) {
        const failed = await this.#setFailureStatus(profile, cause);
        throw new ConnectionError("CONNECTION_TEST_FAILED", failed.status.message ?? "Sandbox test failed", id, cause);
      }
    }
    if (profile.kind !== "mcp") {
      if (!options.probe) return this.#setStatus(profile, {
        state: "unknown",
        checkedAt: timestamp(this.#now),
        message: `Saved ${profile.kind} configuration is valid but no protocol test is available`,
      });
      try {
        const message = await options.probe(profile);
        return await this.#setStatus(profile, {
          state: "connected", checkedAt: timestamp(this.#now), message: message || `${profile.kind} connection is ready`,
        });
      } catch (cause) {
        const failed = await this.#setFailureStatus(profile, cause);
        throw new ConnectionError("CONNECTION_TEST_FAILED", failed.status.message ?? "Connection test failed", id, cause);
      }
    }
    let handle: McpConnectionHandle | undefined;
    try {
      handle = await openMcpConnection(this, profile, options);
      const discovered = await this.#sanitizeTools(profile, toolsFrom(handle.tools));
      return await this.#setStatus(profile, {
        state: "connected", checkedAt: timestamp(this.#now), message: `${handle.tools.length} tool(s) discovered`,
      }, discovered);
    } catch (cause) {
      const failed = await this.#setFailureStatus(profile, cause);
      const message = failed.status.message ?? "Connection test failed";
      throw new ConnectionError("CONNECTION_TEST_FAILED", message, id, cause);
    } finally {
      await handle?.close();
    }
  }

  async refreshTools(id: string, options: ConnectionTestOptions = {}): Promise<readonly ConnectionTool[]> {
    const tested = await this.test(id, options);
    return tested.tools ?? [];
  }

  async storeDiscoveredTools(id: string, tools: readonly ConnectionTool[]): Promise<ConnectionProfile> {
    const profile = await this.require(id, "mcp");
    const discovered = await this.#sanitizeTools(profile, tools);
    return this.#setStatus(profile, {
      state: "connected",
      checkedAt: timestamp(this.#now),
      message: `${discovered.length} tool(s) discovered`,
    }, discovered);
  }

  /** Redacts this Connection's credentials from untrusted protocol output without exposing their values. */
  async redactSensitiveOutput(id: string, value: unknown): Promise<unknown> {
    const profile = await this.require(id);
    return redactKnownSecrets(value, await this.#secretValues(profile), MAX_DISCOVERY_BYTES);
  }

  /** Returns a credential-redacted error without retaining the untrusted cause object. */
  async redactSensitiveError(id: string, cause: unknown): Promise<ConnectionError> {
    const profile = await this.require(id);
    return new ConnectionError(
      cause instanceof ConnectionError ? cause.code : "CONNECTION_TEST_FAILED",
      safeMessage(cause, await this.#secretValues(profile)),
      id,
    );
  }

  paths(): { readonly projectMetadata: string; readonly userMetadata: string; readonly credentialFiles: readonly string[] } {
    return { projectMetadata: this.#projectFile, userMetadata: this.#userFile, credentialFiles: this.#vault.paths() };
  }

  async beginOAuth(id: string, options: {
    readonly redirectUrl: string;
    readonly scope?: string;
    readonly allowNetworkHosts?: true | readonly string[];
    readonly timeoutMs?: number;
    readonly forceReauthorization?: boolean;
  }): Promise<OAuthStartResult> {
    validateTimeout(options.timeoutMs, id);
    const profile = await this.require(id, "mcp");
    if (profile.config.transport !== "http" || typeof profile.config.url !== "string") throw new ConnectionError(
      "OAUTH_INVALID", "OAuth is only available for MCP Streamable HTTP connections", id,
    );
    const redirect = new URL(options.redirectUrl);
    const reservedCallbackParameter = ["code", "state", "error", "error_description", "error_uri", "iss"]
      .find((name) => redirect.searchParams.has(name));
    if (redirect.protocol !== "http:" || (redirect.hostname !== "127.0.0.1" && redirect.hostname !== "[::1]")
      || redirect.username || redirect.password || redirect.hash || reservedCallbackParameter) {
      throw new ConnectionError("OAUTH_INVALID", "OAuth callback must be an HTTP loopback URL", id);
    }
    let authorizationUrl: URL | undefined;
    const provider = await this.#oauthProvider(profile, redirect.toString(), options.scope, (url) => { authorizationUrl = url; });
    let result: Awaited<ReturnType<typeof auth>>;
    let allowedOAuthHosts: true | readonly string[];
    try {
      allowedOAuthHosts = await oauthNetworkHosts(
        profile.config.url,
        options.allowNetworkHosts,
        options.timeoutMs ?? OAUTH_FETCH_TIMEOUT_MS,
      );
      result = await auth(provider, {
        serverUrl: profile.config.url,
        ...(options.scope ? { scope: options.scope } : {}),
        ...((options.forceReauthorization === true || profile.status.state === "insufficient_scope")
          ? { forceReauthorization: true } : {}),
        fetchFn: guardedFetch(allowedOAuthHosts, {
          timeoutMs: options.timeoutMs ?? OAUTH_FETCH_TIMEOUT_MS,
          maxResponseBytes: MAX_DISCOVERY_BYTES,
        }),
      });
    } catch (cause) {
      const failed = await this.#setFailureStatus(profile, cause);
      throw new ConnectionError("OAUTH_INVALID", failed.status.message ?? "OAuth authorization failed", id, cause);
    }
    if (result === "AUTHORIZED") {
      await this.#setStatus(profile, {
        state: "unknown",
        checkedAt: timestamp(this.#now),
        message: "OAuth credentials are available; run a Connection test to verify the MCP resource",
      });
      return { status: "authorized" };
    }
    const entry = await this.#vault.read(await this.#binding(profile.scope, profile.id));
    this.#assertVaultBinding(profile, entry);
    const session = entry?.oauthSession;
    if (!authorizationUrl || !session) throw new ConnectionError("OAUTH_INVALID", "OAuth did not produce an authorization redirect", id);
    assertAllowedUrl(authorizationUrl, allowedOAuthHosts);
    await this.#setStatus(profile, {
      state: "needs_auth",
      checkedAt: timestamp(this.#now),
      message: "Browser authorization is required",
    });
    return {
      status: "redirect",
      authorizationUrl: authorizationUrl.toString(),
      state: session.state,
      redirectUrl: session.redirectUrl,
      expiresAt: session.expiresAt,
    };
  }

  async finishOAuth(id: string, callback: URLSearchParams, options: {
    readonly allowNetworkHosts?: true | readonly string[];
    readonly timeoutMs?: number;
  } = {}): Promise<ConnectionProfile> {
    validateTimeout(options.timeoutMs, id);
    const profile = await this.require(id, "mcp");
    if (profile.config.transport !== "http" || typeof profile.config.url !== "string") throw new ConnectionError(
      "OAUTH_INVALID", "OAuth is only available for MCP Streamable HTTP connections", id,
    );
    const entry = await this.#vault.read(await this.#binding(profile.scope, profile.id));
    this.#assertVaultBinding(profile, entry);
    const session = entry?.oauthSession;
    if (!session) throw new ConnectionError("OAUTH_STATE_INVALID", "No OAuth authorization is pending", id);
    if (session.serverUrl !== new URL(profile.config.url).toString()) {
      await this.#clearOAuthSession(profile);
      throw new ConnectionError("OAUTH_STATE_INVALID", "The OAuth session is bound to a different MCP resource", id);
    }
    if (Date.parse(session.expiresAt) <= this.#now().getTime()) {
      await this.#clearOAuthSession(profile);
      throw new ConnectionError("OAUTH_SESSION_EXPIRED", "The OAuth callback session has expired", id);
    }
    const receivedState = callback.get("state") ?? "";
    const expected = Buffer.from(session.state, "utf8");
    const received = Buffer.from(receivedState, "utf8");
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      throw new ConnectionError("OAUTH_STATE_INVALID", "The OAuth callback state does not match", id);
    }
    const provider = await this.#oauthProvider(profile, session.redirectUrl, session.requestedScope, () => undefined);
    await this.#consumeOAuthState(profile, receivedState);
    try {
      const allowedOAuthHosts = await oauthNetworkHosts(
        profile.config.url,
        options.allowNetworkHosts,
        options.timeoutMs ?? OAUTH_FETCH_TIMEOUT_MS,
        session.discovery,
      );
      const transport = new StreamableHTTPClientTransport(new URL(profile.config.url), {
        authProvider: provider,
        fetch: guardedFetch(allowedOAuthHosts, {
          timeoutMs: options.timeoutMs ?? OAUTH_FETCH_TIMEOUT_MS,
          maxResponseBytes: MAX_DISCOVERY_BYTES,
        }),
        onInsufficientScope: "throw",
      });
      await transport.finishAuth(callback);
      await this.#clearOAuthSession(profile);
      return this.#setStatus(profile, {
        state: "unknown",
        checkedAt: timestamp(this.#now),
        message: "OAuth authorization completed; run a Connection test to verify the MCP resource",
      });
    } catch (cause) {
      await this.#clearOAuthSession(profile);
      await this.#setFailureStatus(profile, cause);
      throw new ConnectionError("OAUTH_INVALID", "OAuth authorization could not be completed", id, cause);
    }
  }

  async oauthProviderFor(id: string, redirectUrl?: string): Promise<OAuthClientProvider> {
    const profile = await this.require(id, "mcp");
    const entry = await this.#vault.read(await this.#binding(profile.scope, profile.id));
    this.#assertVaultBinding(profile, entry);
    const session = entry?.oauthSession;
    return this.#oauthProvider(profile, redirectUrl ?? session?.redirectUrl, session?.requestedScope, () => undefined);
  }

  async oauthNetworkHostsFor(
    id: string,
    allowed?: true | readonly string[],
    timeoutMs = OAUTH_FETCH_TIMEOUT_MS,
  ): Promise<true | readonly string[]> {
    const profile = await this.require(id, "mcp");
    if (profile.config.transport !== "http" || typeof profile.config.url !== "string") return allowed ?? [];
    const entry = await this.#vault.read(await this.#binding(profile.scope, profile.id));
    this.#assertVaultBinding(profile, entry);
    const current = entry?.oauth?.latest ?? Object.values(entry?.oauth ?? {}).at(-1);
    return oauthNetworkHosts(
      profile.config.url,
      allowed,
      timeoutMs,
      entry?.oauthSession?.discovery ?? current?.discovery,
    );
  }

  async #oauthProvider(
    profile: ConnectionProfile,
    redirectUrl: string | undefined,
    requestedScope: string | undefined,
    redirect: (url: URL) => void,
  ): Promise<OAuthClientProvider> {
    const binding = await this.#binding(profile.scope, profile.id);
    const vault = this.#vault;
    const readBound = async (): Promise<VaultEntry | undefined> => {
      const entry = await vault.read(binding);
      this.#assertVaultBinding(profile, entry);
      return entry;
    };
    const updateBound = async (update: (entry: VaultEntry) => VaultEntry | undefined): Promise<void> => {
      await vault.update(binding, (entry) => {
        this.#assertVaultBinding(profile, entry);
        return update(entry);
      });
    };
    await readBound();
    await updateBound((entry) => ({ ...entry, profileBinding: connectionProfileBinding(profile) }));
    const now = this.#now;
    const metadata: OAuthClientMetadata = {
      client_name: "Harnest",
      redirect_uris: redirectUrl ? [redirectUrl] : [],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(requestedScope ? { scope: requestedScope } : {}),
    };
    const serverUrl = new URL(String(profile.config.url)).toString();
    const issuerKey = (ctx?: OAuthClientInformationContext) => ctx?.issuer ?? "latest";
    const credentialSet = (
      oauth: Record<string, OAuthCredentialSet> | undefined,
      ctx?: OAuthClientInformationContext,
    ): OAuthCredentialSet | undefined => ctx?.issuer ? oauth?.[ctx.issuer] : oauth?.latest;
    return {
      get redirectUrl() { return redirectUrl; },
      get clientMetadata() { return metadata; },
      async state() {
        const state = randomBytes(32).toString("base64url");
        const expiresAt = new Date(now().getTime() + OAUTH_SESSION_MS).toISOString();
        await updateBound((entry) => ({
          ...entry,
          oauthSession: {
            state,
            serverUrl,
            redirectUrl: redirectUrl ?? "",
            expiresAt,
            ...(requestedScope ? { requestedScope } : {}),
            ...(entry.oauthSession?.codeVerifier ? { codeVerifier: entry.oauthSession.codeVerifier } : {}),
            ...(entry.oauthSession?.discovery ? { discovery: entry.oauthSession.discovery } : {}),
          },
        }));
        return state;
      },
      async clientInformation(ctx) {
        const oauth = (await readBound())?.oauth;
        return credentialSet(oauth, ctx)?.clientInformation;
      },
      async saveClientInformation(clientInformation, ctx) {
        await updateBound((entry) => {
          const oauth = { ...entry.oauth };
          const issuer = ctx?.issuer ?? clientInformation.issuer;
          const key = issuer ?? issuerKey(ctx);
          const value = {
            ...oauth[key],
            clientInformation: issuer ? { ...clientInformation, issuer } : clientInformation,
          };
          oauth[key] = value;
          oauth.latest = value;
          return { ...entry, oauth };
        });
      },
      async tokens(ctx) {
        const oauth = (await readBound())?.oauth;
        return credentialSet(oauth, ctx)?.tokens;
      },
      async saveTokens(tokens, ctx) {
        await updateBound((entry) => {
          const oauth = { ...entry.oauth };
          const issuer = ctx?.issuer ?? tokens.issuer;
          const key = issuer ?? issuerKey(ctx);
          const value = { ...oauth[key], tokens: issuer ? { ...tokens, issuer } : tokens };
          oauth[key] = value;
          oauth.latest = value;
          return { ...entry, oauth };
        });
      },
      redirectToAuthorization(url) { redirect(url); },
      async saveCodeVerifier(codeVerifier) {
        await updateBound((entry) => ({
          ...entry,
          oauthSession: {
            state: entry.oauthSession?.state ?? "",
            serverUrl,
            redirectUrl: redirectUrl ?? entry.oauthSession?.redirectUrl ?? "",
            expiresAt: entry.oauthSession?.expiresAt ?? new Date(now().getTime() + OAUTH_SESSION_MS).toISOString(),
            ...(requestedScope ? { requestedScope } : {}),
            codeVerifier,
            ...(entry.oauthSession?.discovery ? { discovery: entry.oauthSession.discovery } : {}),
          },
        }));
      },
      async codeVerifier() {
        const verifier = (await readBound())?.oauthSession?.codeVerifier;
        if (!verifier) throw new ConnectionError("OAUTH_INVALID", "OAuth PKCE verifier is unavailable", profile.id);
        return verifier;
      },
      async invalidateCredentials(scope) {
        await updateBound((entry) => {
          if (scope === "all") {
            const rest = omitKeys(entry, ["oauth", "oauthSession"]);
            return Object.keys(rest).length ? rest : undefined;
          }
          if (scope === "tokens" || scope === "client") {
            const oauth = Object.fromEntries(Object.entries(entry.oauth ?? {}).map(([key, value]) => {
              if (scope === "tokens") {
                return [key, omitKeys(value, ["tokens"])] as const;
              }
              return [key, omitKeys(value, ["clientInformation"])] as const;
            }));
            return { ...entry, oauth };
          }
          if (scope === "verifier") {
            if (!entry.oauthSession) return entry;
            const session = omitKeys(entry.oauthSession, ["codeVerifier"]);
            return { ...entry, oauthSession: session };
          }
          const oauth = Object.fromEntries(Object.entries(entry.oauth ?? {}).map(([key, value]) => {
            return [key, omitKeys(value, ["discovery"])] as const;
          }));
          if (!entry.oauthSession) return { ...entry, oauth };
          const session = omitKeys(entry.oauthSession, ["discovery"]);
          return { ...entry, oauth, oauthSession: session };
        });
      },
      async saveDiscoveryState(discovery) {
        await updateBound((entry) => ({
          ...entry,
          oauth: (() => {
            const oauth = { ...entry.oauth };
            const issuer = discovery.authorizationServerMetadata?.issuer ?? discovery.authorizationServerUrl;
            const value = { ...oauth[issuer], discovery };
            oauth[issuer] = value;
            oauth.latest = value;
            return oauth;
          })(),
          oauthSession: {
            state: entry.oauthSession?.state ?? "",
            serverUrl,
            redirectUrl: redirectUrl ?? entry.oauthSession?.redirectUrl ?? "",
            expiresAt: entry.oauthSession?.expiresAt ?? new Date(now().getTime() + OAUTH_SESSION_MS).toISOString(),
            ...(requestedScope ? { requestedScope } : {}),
            ...(entry.oauthSession?.codeVerifier ? { codeVerifier: entry.oauthSession.codeVerifier } : {}),
            discovery,
          },
        }));
      },
      async discoveryState() {
        const entry = await readBound();
        return entry?.oauthSession?.discovery ?? entry?.oauth?.latest?.discovery;
      },
    };
  }

  async #revokeOAuth(profile: ConnectionProfile, allowed: true | readonly string[] | undefined): Promise<void> {
    const entry = await this.#vault.read(await this.#binding(profile.scope, profile.id));
    this.#assertVaultBinding(profile, entry);
    const session = entry?.oauthSession;
    const oauth = entry?.oauth;
    const current = oauth?.latest ?? Object.values(oauth ?? {}).at(-1);
    const discovery = session?.discovery ?? current?.discovery;
    const metadata = discovery?.authorizationServerMetadata as AuthorizationServerMetadata | undefined;
    const endpoint = metadata && "revocation_endpoint" in metadata && typeof metadata.revocation_endpoint === "string"
      ? metadata.revocation_endpoint : undefined;
    const tokens = [current?.tokens?.refresh_token, current?.tokens?.access_token]
      .filter((token): token is string => typeof token === "string" && token.length > 0)
      .filter((token, index, values) => values.indexOf(token) === index);
    if (!endpoint || tokens.length === 0) return;
    const url = new URL(endpoint);
    assertAllowedUrl(url, allowed);
    const client = current?.clientInformation;
    for (const token of tokens) {
      const params = new URLSearchParams({
        token,
        token_type_hint: token === current?.tokens?.refresh_token ? "refresh_token" : "access_token",
      });
      const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
      if (client) {
        const supported = Array.isArray(metadata?.token_endpoint_auth_methods_supported)
          ? metadata.token_endpoint_auth_methods_supported : ["none"];
        const method = selectClientAuthMethod(client, supported);
        if (method === "client_secret_basic" && "client_secret" in client && typeof client.client_secret === "string") {
          headers.set("authorization", `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`).toString("base64")}`);
        } else {
          params.set("client_id", client.client_id);
          if (method === "client_secret_post" && "client_secret" in client && typeof client.client_secret === "string") {
            params.set("client_secret", client.client_secret);
          }
        }
      }
      const response = await guardedFetch(allowed, {
        timeoutMs: OAUTH_FETCH_TIMEOUT_MS,
        maxResponseBytes: MAX_DISCOVERY_BYTES,
      })(url, { method: "POST", headers, body: params });
      if (!response.ok) throw new ConnectionError(
        "OAUTH_INVALID",
        `OAuth ${params.get("token_type_hint")} revocation failed with HTTP ${response.status}`,
        profile.id,
      );
    }
  }

  async #consumeOAuthState(profile: ConnectionProfile, receivedState: string): Promise<void> {
    await this.#vault.update(await this.#binding(profile.scope, profile.id), (entry) => {
      this.#assertVaultBinding(profile, entry);
      const session = entry.oauthSession;
      if (!session || session.serverUrl !== new URL(String(profile.config.url)).toString()) throw new ConnectionError(
        "OAUTH_STATE_INVALID", "The OAuth callback session is unavailable or bound to a different MCP resource", profile.id,
      );
      if (Date.parse(session.expiresAt) <= this.#now().getTime()) throw new ConnectionError(
        "OAUTH_SESSION_EXPIRED", "The OAuth callback session has expired", profile.id,
      );
      const expected = Buffer.from(session.state, "utf8");
      const received = Buffer.from(receivedState, "utf8");
      if (expected.length !== received.length || !timingSafeEqual(expected, received)) throw new ConnectionError(
        "OAUTH_STATE_INVALID", "The OAuth callback state was already consumed or does not match", profile.id,
      );
      return { ...entry, oauthSession: { ...session, state: "consumed" } };
    });
  }

  async #clearOAuthSession(profile: ConnectionProfile): Promise<void> {
    await this.#vault.update(
      await this.#binding(profile.scope, profile.id),
      (entry) => {
        this.#assertVaultBinding(profile, entry);
        return omitKeys(entry, ["oauthSession"]);
      },
    );
  }

  async #secretValues(profile: ConnectionProfile): Promise<string[]> {
    const entry = await this.#vault.read(await this.#binding(profile.scope, profile.id));
    this.#assertVaultBinding(profile, entry);
    const values = [...Object.values(entry?.fields ?? {})];
    for (const credential of Object.values(entry?.oauth ?? {})) {
      if (credential.tokens?.access_token) values.push(credential.tokens.access_token);
      if (credential.tokens?.refresh_token) values.push(credential.tokens.refresh_token);
      const client = credential.clientInformation;
      if (client && "client_secret" in client && typeof client.client_secret === "string") values.push(client.client_secret);
    }
    return [...new Set(values.filter(Boolean))];
  }

  async #setFailureStatus(profile: ConnectionProfile, cause: unknown): Promise<ConnectionProfile> {
    const entry = await this.#vault.read(await this.#binding(profile.scope, profile.id));
    this.#assertVaultBinding(profile, entry);
    const hasStoredTokens = Object.values(entry?.oauth ?? {}).some((credential) => credential.tokens !== undefined);
    const message = safeMessage(cause, await this.#secretValues(profile));
    return this.#setStatus(profile, {
      state: connectionFailureState(cause, message, hasStoredTokens),
      checkedAt: timestamp(this.#now),
      message,
    });
  }

  async #sanitizeTools(profile: ConnectionProfile, tools: readonly ConnectionTool[]): Promise<ConnectionTool[]> {
    if (tools.length > 2_048) throw new ConnectionError(
      "CONNECTION_TEST_FAILED", "MCP Tool discovery exceeds 2048 entries", profile.id,
    );
    const sanitized = redactKnownSecrets(tools, await this.#secretValues(profile), MAX_DISCOVERY_BYTES);
    if (!Array.isArray(sanitized)) throw new ConnectionError(
      "CONNECTION_INVALID", "Connection Tool discovery returned invalid metadata", profile.id,
    );
    return sanitized.map((tool) => connectionToolFrom(tool, profile.id));
  }

  async #setStatus(profile: ConnectionProfile, status: ConnectionStatus, tools = profile.tools): Promise<ConnectionProfile> {
    const updated: ConnectionProfile = {
      ...profile,
      status,
      ...(tools === undefined ? {} : { tools }),
      updatedAt: timestamp(this.#now),
    };
    await this.#replace(updated);
    return structuredClone(updated);
  }

  async #replace(profile: ConnectionProfile): Promise<void> {
    await this.#mutateFile(this.#fileFor(profile.scope), (profiles) => profiles.map((item) => item.id === profile.id ? profile : item));
  }

  #fileFor(scope: ConnectionProfile["scope"]): string {
    return scope === "project" ? this.#projectFile : this.#userFile;
  }

  #assertVaultBinding(profile: Pick<ConnectionProfile, "id" | "kind" | "config">, entry: VaultEntry | undefined): void {
    if (entry?.pendingCreate || (protectedVaultEntry(entry) && entry?.profileBinding !== connectionProfileBinding(profile))) throw new ConnectionError(
      "CREDENTIAL_STORE_FAILED",
      "Connection security metadata changed; delete and recreate the Connection to re-authorize credentials",
      profile.id,
    );
  }

  async #binding(scope: ConnectionProfile["scope"], id: string): Promise<string> {
    if (scope === "user") return `user:${id}`;
    this.#projectBinding ??= this.#root.then((root) => createHash("sha256").update(root.toLocaleLowerCase()).digest("hex"));
    return `project:${await this.#projectBinding}:${id}`;
  }

  async #readFile(path: string): Promise<ConnectionProfile[]> {
    const safePath = await this.#metadataPath(path, false);
    const candidate = await readJson(safePath, MAX_METADATA_BYTES);
    if (candidate === undefined) return [];
    if (!isRecord(candidate) || candidate.version !== FILE_VERSION || !Array.isArray(candidate.connections)) {
      throw new ConnectionError("CONNECTION_INVALID", `Connection metadata '${safePath}' is invalid`);
    }
    return candidate.connections.map(profileFrom);
  }

  async #mutateFile(path: string, mutate: (profiles: ConnectionProfile[]) => ConnectionProfile[]): Promise<void> {
    const safePath = await this.#metadataPath(path, true);
    await withFileLock(`${safePath}.lock`, async () => {
      const connections = mutate(await this.#readFile(safePath));
      await atomicJson(safePath, { version: FILE_VERSION, connections } satisfies ConnectionFile);
    });
  }

  async #metadataPath(path: string, create: boolean): Promise<string> {
    if (path !== this.#projectFile) return path;
    const root = await this.#root;
    const directory = join(root, ".harnest");
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new ConnectionError(
        "CONNECTION_INVALID", "Project .harnest directory is an unsafe link or non-directory",
      );
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
      if (!create) return join(directory, "connections.json");
      await mkdir(directory, { mode: 0o700 });
    }
    const canonical = await realpath(directory);
    if (!isInside(root, canonical)) throw new ConnectionError(
      "CONNECTION_INVALID", "Project Connection metadata resolves outside the project",
    );
    return join(canonical, "connections.json");
  }
}

function safeMessage(error: unknown, secrets: readonly string[]): string {
  let message = error instanceof Error ? error.message : "Connection test failed";
  for (const secret of [...secrets].filter(Boolean).sort((left, right) => right.length - left.length)) {
    message = message.replaceAll(secret, "[REDACTED]");
  }
  message = message.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@");
  return message.slice(0, 500);
}

function redactKnownSecrets(value: unknown, secrets: readonly string[], maxBytes: number): unknown {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (cause) {
    throw new ConnectionError("CONNECTION_INVALID", "Protocol data is not JSON-serializable", undefined, cause);
  }
  if (serialized === undefined) return value;
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) throw new ConnectionError(
    "CONNECTION_INVALID", "Protocol data exceeds the safe persistence limit",
  );
  for (const secret of [...secrets].filter(Boolean).sort((left, right) => right.length - left.length)) {
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped) serialized = serialized.replaceAll(escaped, "[REDACTED]");
  }
  return JSON.parse(serialized) as unknown;
}

function connectionFailureState(
  error: unknown,
  message: string,
  hasStoredTokens: boolean,
): ConnectionStatus["state"] {
  const causes: unknown[] = [];
  let current = error;
  for (let depth = 0; current !== undefined && depth < 8; depth += 1) {
    causes.push(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  if (causes.some((cause) => cause instanceof InsufficientScopeError)
    || /insufficient[_ -]?scope|required scope|scope[^.]{0,80}(?:required|missing)/i.test(message)) {
    return "insufficient_scope";
  }
  if (causes.some((cause) => cause instanceof UnauthorizedError)
    || /\b401\b|unauthori[sz]ed|api key is required|credential is required/i.test(message)) {
    return hasStoredTokens ? "expired" : "needs_auth";
  }
  if (hasStoredTokens && /expired|invalid[^.]{0,40}token|token[^.]{0,40}(?:expired|invalid)/i.test(message)) {
    return "expired";
  }
  return "error";
}

const MAX_FETCH_REQUEST_BYTES = 16 * 1_048_576;
const NON_PUBLIC_IPV4 = new BlockList();
const NON_PUBLIC_IPV6 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) NON_PUBLIC_IPV4.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["64:ff9b:1::", 48], ["100::", 64],
  ["2001:db8::", 32], ["2001:10::", 28], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) NON_PUBLIC_IPV6.addSubnet(network, prefix, "ipv6");

interface PinnedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export function pinnedLookup(address: PinnedAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [address]);
      return;
    }
    callback(null, address.address, address.family);
  };
}

const bareHostname = (hostname: string): string => hostname.startsWith("[") && hostname.endsWith("]")
  ? hostname.slice(1, -1) : hostname;

const blockedAddress = ({ address, family }: PinnedAddress): boolean =>
  family === 4 ? NON_PUBLIC_IPV4.check(address, "ipv4") : NON_PUBLIC_IPV6.check(address, "ipv6");

async function pinnedAddress(url: URL): Promise<PinnedAddress> {
  const hostname = bareHostname(url.hostname);
  const literalFamily = isIP(hostname);
  const literalLoopback = hostname === "127.0.0.1" || hostname === "::1";
  if (literalLoopback) return { address: hostname, family: literalFamily as 4 | 6 };
  let addresses: PinnedAddress[];
  try {
    addresses = literalFamily
      ? [{ address: hostname, family: literalFamily as 4 | 6 }]
      : (await lookup(hostname, { all: true, verbatim: true })) as PinnedAddress[];
  } catch (cause) {
    throw new ConnectionError("CONNECTION_INVALID", `Network host '${url.host}' could not be resolved safely`, undefined, cause);
  }
  if (!addresses.length || addresses.some(blockedAddress)) throw new ConnectionError(
    "CONNECTION_INVALID",
    `Network host '${url.host}' resolves to a private or reserved address`,
  );
  return addresses[0]!;
}

async function pinnedFetch(
  url: URL,
  request: Request,
  address: PinnedAddress,
  signal: AbortSignal,
): Promise<Response> {
  const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
  if (body && body.byteLength > MAX_FETCH_REQUEST_BYTES) throw new ConnectionError(
    "CONNECTION_INVALID", "Protocol request exceeds the safe size limit",
  );
  const headers = Object.fromEntries(request.headers.entries());
  delete headers.host;
  delete headers.connection;
  delete headers["transfer-encoding"];
  if (!headers["accept-encoding"]) headers["accept-encoding"] = "identity";
  if (body && !headers["content-length"]) headers["content-length"] = String(body.byteLength);
  return new Promise<Response>((resolveResponse, reject) => {
    const transport = url.protocol === "https:" ? requestHttps : requestHttp;
    const outgoing = transport(url, {
      method: request.method,
      headers,
      signal,
      maxHeaderSize: 32 * 1_024,
      lookup: pinnedLookup(address),
    }, (incoming) => {
      const responseHeaders = new Headers();
      for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
        responseHeaders.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
      }
      const status = incoming.statusCode ?? 500;
      const noBody = request.method === "HEAD" || status === 204 || status === 205 || status === 304;
      resolveResponse(new Response(noBody ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>, {
        status,
        headers: responseHeaders,
        ...(incoming.statusMessage === undefined ? {} : { statusText: incoming.statusMessage }),
      }));
    });
    outgoing.once("error", reject);
    outgoing.end(body);
  });
}

function assertAllowedUrl(url: URL, allowed: true | readonly string[] | undefined): void {
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.hash) {
    throw new ConnectionError("CONNECTION_INVALID", "Connection URL must use http(s) and contain no credentials or fragment");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !loopback) throw new ConnectionError(
    "CONNECTION_INVALID", "Non-loopback connection URLs must use HTTPS",
  );
  const hosts = Array.isArray(allowed) ? allowed.map((host) => host.toLocaleLowerCase()) : [];
  if (allowed !== true && !hosts.includes(url.host.toLocaleLowerCase())) throw new ConnectionError(
    "CONNECTION_INVALID", `Network host '${url.host}' is not explicitly allowed`,
  );
}

const OAUTH_METADATA_ENDPOINTS = [
  "authorization_endpoint",
  "token_endpoint",
  "registration_endpoint",
  "revocation_endpoint",
  "userinfo_endpoint",
  "jwks_uri",
] as const;

function addDiscoveredOAuthHost(hosts: Set<string>, value: unknown): URL | undefined {
  if (typeof value !== "string") return undefined;
  const url = secureEndpoint(value, "Discovered OAuth endpoint");
  hosts.add(url.host.toLocaleLowerCase());
  if (hosts.size > 32) throw new ConnectionError("OAUTH_INVALID", "OAuth discovery declared too many network hosts");
  return url;
}

async function oauthNetworkHosts(
  serverUrlValue: string,
  allowed: true | readonly string[] | undefined,
  timeoutMs: number,
  discovery?: OAuthDiscoveryState,
): Promise<true | readonly string[]> {
  if (allowed === true) return true;
  const serverUrl = secureEndpoint(serverUrlValue, "MCP resource");
  const hosts = new Set((allowed ?? []).map((host) => host.toLocaleLowerCase()));
  hosts.add(serverUrl.host.toLocaleLowerCase());

  let resourceMetadata = discovery?.resourceMetadata;
  if (!resourceMetadata && !discovery?.authorizationServerUrl) {
    resourceMetadata = await discoverOAuthProtectedResourceMetadata(
      serverUrl,
      undefined,
      guardedFetch([...hosts], { timeoutMs, maxResponseBytes: MAX_DISCOVERY_BYTES }),
    );
  }
  const authorizationServers = resourceMetadata?.authorization_servers ?? [];
  const authorizationServer = addDiscoveredOAuthHost(
    hosts,
    discovery?.authorizationServerUrl ?? authorizationServers[0] ?? serverUrl.origin,
  );
  for (const value of authorizationServers.slice(1, 16)) addDiscoveredOAuthHost(hosts, value);

  let metadata = discovery?.authorizationServerMetadata;
  if (!metadata && authorizationServer) {
    metadata = await discoverAuthorizationServerMetadata(authorizationServer, {
      fetchFn: guardedFetch([...hosts], { timeoutMs, maxResponseBytes: MAX_DISCOVERY_BYTES }),
    });
  }
  const metadataRecord: Record<string, unknown> | undefined = metadata
    ? Object.fromEntries(Object.entries(metadata))
    : undefined;
  for (const field of OAUTH_METADATA_ENDPOINTS) addDiscoveredOAuthHost(hosts, metadataRecord?.[field]);
  return [...hosts];
}

async function boundedResponse(response: Response, maxBytes: number): Promise<Response> {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ConnectionError("CONNECTION_INVALID", "OAuth response exceeds the safe size limit");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return new Response(Buffer.concat(chunks, total), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function guardedFetch(
  allowed: true | readonly string[] | undefined,
  options: {
    readonly timeoutMs?: number;
    readonly maxResponseBytes?: number;
    readonly maxStreamBytes?: number;
  } = {},
): FetchLike {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    assertAllowedUrl(url, allowed);
    const signals = [request.signal];
    if (options.timeoutMs !== undefined) signals.push(AbortSignal.timeout(options.timeoutMs));
    const signal = signals.length === 1 ? signals[0]! : AbortSignal.any(signals);
    const response = await pinnedFetch(url, request, await pinnedAddress(url), signal);
    const maximum = options.maxResponseBytes ?? options.maxStreamBytes;
    const declared = response.headers.get("content-length");
    if (maximum !== undefined && declared && /^\d+$/.test(declared) && Number(declared) > maximum) {
      await response.body?.cancel();
      throw new ConnectionError("CONNECTION_INVALID", "Protocol response exceeds the safe size limit");
    }
    if (options.maxResponseBytes !== undefined) return boundedResponse(response, options.maxResponseBytes);
    if (options.maxStreamBytes === undefined || !response.body) return response;
    let bytes = 0;
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > options.maxStreamBytes!) {
          controller.error(new ConnectionError("CONNECTION_INVALID", "MCP response exceeds the safe size limit"));
        } else controller.enqueue(chunk);
      },
    }));
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

const searchRecord = (value: unknown): Record<string, unknown> | undefined => isRecord(value) ? value : undefined;

function pointerValue(value: unknown, path: unknown, fallback: string): unknown {
  const pointer = typeof path === "string" ? path : fallback;
  if (!pointer.startsWith("/")) return searchRecord(value)?.[pointer];
  let current = value;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    current = searchRecord(current)?.[key];
  }
  return current;
}

function searchResults(value: unknown, profile: ConnectionProfile, limit: number): unknown {
  const rows = pointerValue(value, profile.config.responseItemsPath, "/results");
  if (!Array.isArray(rows)) throw new Error("Search connector response must contain a results array");
  const nextCursor = pointerValue(value, profile.config.nextCursorPath, "nextCursor");
  return {
    provider: typeof profile.config.connector === "string" ? profile.config.connector : "custom-search",
    ...(typeof nextCursor === "string" || typeof nextCursor === "number" ? { nextCursor: String(nextCursor) } : {}),
    results: rows.slice(0, limit).flatMap((entry) => {
      if (!searchRecord(entry)) return [];
      const urlValue = pointerValue(entry, profile.config.urlField, "url");
      const titleValue = pointerValue(entry, profile.config.titleField, "title");
      const url = typeof urlValue === "string" ? urlValue : undefined;
      const title = typeof titleValue === "string" ? titleValue : url;
      if (!url || !title) return [];
      const snippet = pointerValue(entry, profile.config.snippetField, "snippet");
      const content = pointerValue(entry, profile.config.contentField, "content");
      return [{
        title,
        url,
        ...(typeof snippet === "string" ? { snippet } : {}),
        ...(typeof content === "string" ? { content } : {}),
      }];
    }),
  };
}

async function toolServiceHeaders(manager: ConnectionManager, profile: ConnectionProfile): Promise<Headers> {
  const headers = new Headers({ accept: "application/json" });
  for (const [name, value] of Object.entries(isRecord(profile.config.headers) ? profile.config.headers : {})) {
    if (typeof value === "string") headers.set(name, value);
  }
  const token = await manager.resolveCredential(profile.id, "token");
  if (profile.config.authScheme === "bearer" && !token) throw new Error("Search credential is required");
  if (token) headers.set("authorization", profile.config.authScheme === "bearer"
    ? `Bearer ${token.replace(/^Bearer\s+/i, "")}` : token);
  return headers;
}

/** Executes the stable Web Search contract through a saved, origin-bound Connection. */
export async function executeWebSearchConnection(
  manager: ConnectionManager,
  profileOrId: ConnectionProfile | string,
  options: {
    readonly query: string;
    readonly limit: number;
    readonly cursor?: string;
    readonly signal?: AbortSignal;
    readonly testOnly?: boolean;
  },
): Promise<unknown> {
  const profile = typeof profileOrId === "string" ? await manager.require(profileOrId) : profileOrId;
  if (profile.kind !== "tool-service") throw new ConnectionError(
    "CONNECTION_TYPE_MISMATCH", "Web Search requires a Tool Service Connection", profile.id,
  );
  const endpoint = secureEndpoint(profile.config.url, "Search connector", profile.id);
  const limit = Math.min(100, Math.max(1, Math.floor(options.limit)));
  const headers = await toolServiceHeaders(manager, profile);

  let url = endpoint;
  let init: RequestInit = {
    method: "GET", headers, redirect: "error", ...(options.signal ? { signal: options.signal } : {}),
  };
  const staticParameters = isRecord(profile.config.staticParameters) ? structuredClone(profile.config.staticParameters) : {};
  if (options.testOnly && typeof profile.config.testUrl === "string") {
    url = secureEndpoint(profile.config.testUrl, "Search test", profile.id);
    init = { ...init, method: profile.config.testMethod === "POST" ? "POST" : "GET" };
  } else {
    const method = profile.config.method === "GET" ? "GET" : "POST";
    const encoding = profile.config.requestEncoding === "query" || method === "GET" ? "query" : "json";
    const queryParameter = typeof profile.config.queryParameter === "string" ? profile.config.queryParameter : "query";
    const limitParameter = typeof profile.config.limitParameter === "string" ? profile.config.limitParameter : "limit";
    const parameters = { ...staticParameters, [queryParameter]: options.query, [limitParameter]: limit };
    if (options.cursor && typeof profile.config.cursorParameter === "string") {
      parameters[profile.config.cursorParameter] = options.cursor;
    }
    if (encoding === "query") {
      url = new URL(endpoint);
      for (const [name, value] of Object.entries(parameters)) {
        if (["string", "number", "boolean"].includes(typeof value)) url.searchParams.set(name, String(value));
      }
      init = { ...init, method };
    } else {
      headers.set("content-type", "application/json");
      init = { ...init, method, body: JSON.stringify(parameters) };
    }
  }

  const timeout = typeof profile.config.timeoutMs === "number" ? profile.config.timeoutMs : 30_000;
  const response = await guardedFetch(true, { timeoutMs: timeout, maxResponseBytes: MAX_DISCOVERY_BYTES })(url, init);
  const body = await response.text();
  let value: unknown;
  try {
    value = body ? JSON.parse(body) as unknown : null;
  } catch {
    throw new Error(`Search connector returned invalid JSON (HTTP ${response.status})`);
  }
  if (!response.ok) {
    const message = searchRecord(value)?.error ?? searchRecord(value)?.message;
    throw new Error(`Search connector returned HTTP ${response.status}${typeof message === "string" ? `: ${message}` : ""}`);
  }
  if (options.testOnly && typeof profile.config.testUrl === "string") return value;
  return searchResults(value, profile, limit);
}

/** Extracts one public page through the same saved Tool Service Connection. */
export async function executeWebScrapeConnection(
  manager: ConnectionManager,
  profileOrId: ConnectionProfile | string,
  options: { readonly url: string; readonly signal?: AbortSignal },
): Promise<unknown> {
  const profile = typeof profileOrId === "string" ? await manager.require(profileOrId) : profileOrId;
  if (profile.kind !== "tool-service" || typeof profile.config.scrapeUrl !== "string") throw new ConnectionError(
    "CONNECTION_TYPE_MISMATCH", "Web Scrape requires a Tool Service Connection with a scrape endpoint", profile.id,
  );
  let target: URL;
  try {
    target = new URL(options.url);
  } catch (cause) {
    throw new ConnectionError("CONNECTION_INVALID", "Scrape target URL is invalid", profile.id, cause);
  }
  const literalFamily = isIP(bareHostname(target.hostname));
  if ((target.protocol !== "http:" && target.protocol !== "https:") || target.username || target.password || target.hash
    || (literalFamily !== 0 && blockedAddress({ address: bareHostname(target.hostname), family: literalFamily as 4 | 6 }))) {
    throw new ConnectionError("CONNECTION_INVALID", "Scrape target must be a public HTTP(S) URL without credentials or a fragment", profile.id);
  }
  await pinnedAddress(target);
  const endpoint = secureEndpoint(profile.config.scrapeUrl, "Scrape connector", profile.id);
  const headers = await toolServiceHeaders(manager, profile);
  headers.set("content-type", "application/json");
  const urlParameter = typeof profile.config.scrapeUrlParameter === "string" ? profile.config.scrapeUrlParameter : "url";
  const parameters = {
    ...(isRecord(profile.config.scrapeStaticParameters) ? structuredClone(profile.config.scrapeStaticParameters) : {}),
    [urlParameter]: target.toString(),
  };
  const timeout = typeof profile.config.timeoutMs === "number" ? profile.config.timeoutMs : 60_000;
  const response = await guardedFetch(true, { timeoutMs: timeout, maxResponseBytes: MAX_DISCOVERY_BYTES })(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(parameters),
    redirect: "error",
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const body = await response.text();
  let value: unknown;
  try {
    value = body ? JSON.parse(body) as unknown : null;
  } catch {
    throw new Error(`Scrape connector returned invalid JSON (HTTP ${response.status})`);
  }
  if (!response.ok) {
    const message = searchRecord(value)?.error ?? searchRecord(value)?.message;
    throw new Error(`Scrape connector returned HTTP ${response.status}${typeof message === "string" ? `: ${message}` : ""}`);
  }
  const content = pointerValue(value, profile.config.scrapeContentPath, "/data/markdown");
  if (typeof content !== "string") throw new Error("Scrape connector response does not contain text content");
  const title = pointerValue(value, profile.config.scrapeTitlePath, "/data/metadata/title");
  const sourceUrl = pointerValue(value, profile.config.scrapeSourceUrlPath, "/data/metadata/sourceURL");
  return {
    provider: typeof profile.config.connector === "string" ? profile.config.connector : "custom-search",
    url: typeof sourceUrl === "string" ? sourceUrl : target.toString(),
    ...(typeof title === "string" ? { title } : {}),
    content,
  };
}

export function protocolMode(config: Readonly<Record<string, unknown>>, transport: "stdio" | "http") {
  const protocol = config.protocol ?? (transport === "http" ? "auto" : "legacy");
  if (protocol === "auto") return { mode: "auto" as const };
  if (protocol === "2026-07-28") return { mode: { pin: "2026-07-28" } as const };
  return { mode: "legacy" as const };
}

export async function openMcpConnection(
  manager: ConnectionManager,
  profileOrId: ConnectionProfile | string,
  options: ConnectionTestOptions = {},
  onToolsChanged?: (tools: readonly ConnectionTool[]) => void | Promise<void>,
): Promise<McpConnectionHandle> {
  const profile = typeof profileOrId === "string" ? await manager.require(profileOrId, "mcp") : profileOrId;
  if (profile.kind !== "mcp") throw new ConnectionError("CONNECTION_TYPE_MISMATCH", `Connection '${profile.id}' is not MCP`, profile.id);
  if (["disconnected", "revocation_pending"].includes(profile.status.state)) throw new ConnectionError(
    "CONNECTION_TEST_FAILED",
    `Connection '${profile.id}' is ${profile.status.state.replaceAll("_", " ")} and cannot be used`,
    profile.id,
  );
  const transportType = profile.config.transport;
  if (transportType !== "stdio" && transportType !== "http") throw new ConnectionError(
    "CONNECTION_INVALID", "MCP connection transport is invalid", profile.id,
  );
  const timeout = options.timeoutMs ?? (typeof profile.config.timeoutMs === "number" ? profile.config.timeoutMs : 30_000);
  let transport: StdioClientTransport | StreamableHTTPClientTransport;
  let cleanupContainer: (() => Promise<void>) | undefined;
  if (transportType === "stdio") {
    if (profile.config.sandbox !== "container") throw new ConnectionError(
      "PROCESS_APPROVAL_REQUIRED",
      `MCP stdio Connection '${profile.name}' must use an isolated Docker or Podman image`,
      profile.id,
    );
    const imageId = await manager.assertProcessApproved(profile);
    if (!imageId) throw new ConnectionError(
      "PROCESS_APPROVAL_REQUIRED", `MCP stdio Connection '${profile.name}' has no approved container image`, profile.id,
    );
    const engine = await canonicalExecutable(profile.config.engine, profile.id);
    const environment = containerEngineEnvironment();
    const environmentNames: string[] = [];
    if (isRecord(profile.config.environmentCredentials)) {
      for (const [name, field] of Object.entries(profile.config.environmentCredentials)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof field !== "string") throw new ConnectionError(
          "CONNECTION_INVALID", "MCP stdio environment credential binding is invalid", profile.id,
        );
        const value = await manager.resolveCredential(profile.id, field);
        if (value === undefined) throw new ConnectionError("CONNECTION_INVALID", `Credential field '${field}' is unavailable`, profile.id);
        environment[name] = value;
        environmentNames.push(name);
      }
    }
    const name = `harnest-mcp-${randomUUID()}`;
    const command = [profile.config.command as string, ...(Array.isArray(profile.config.args) ? profile.config.args as string[] : [])];
    transport = new StdioClientTransport({
      command: engine.path,
      args: containerRunArguments(profile, name, command, environmentNames, imageId),
      cwd: dirname(engine.path),
      env: environment,
      stderr: "ignore",
    });
    cleanupContainer = async () => {
      await runBoundedProcess({
        toolId: `connection:${profile.id}:cleanup`,
        command: engine.path,
        args: ["rm", "--force", name],
        cwd: dirname(engine.path),
        stdin: "",
        timeoutMs: 5_000,
        maxInputBytes: 1,
        maxOutputBytes: 64 * 1_024,
        signal: new AbortController().signal,
        environment: containerEngineEnvironment(),
      }).catch(() => undefined);
    };
  } else {
    if (typeof profile.config.url !== "string") throw new ConnectionError("CONNECTION_INVALID", "MCP HTTP URL is missing", profile.id);
    const url = new URL(profile.config.url);
    const oauth = profile.config.oauth === true || isRecord(profile.config.oauth);
    const allowedNetworkHosts = oauth
      ? await manager.oauthNetworkHostsFor(profile.id, options.allowNetworkHosts, timeout)
      : options.allowNetworkHosts;
    assertAllowedUrl(url, allowedNetworkHosts);
    const headers = new Headers();
    if (isRecord(profile.config.headers)) {
      for (const [name, value] of Object.entries(profile.config.headers)) if (typeof value === "string") headers.set(name, value);
    }
    if (isRecord(profile.config.headerCredentials)) {
      for (const [name, field] of Object.entries(profile.config.headerCredentials)) {
        if (typeof field !== "string") throw new ConnectionError("CONNECTION_INVALID", "MCP HTTP header credential binding is invalid", profile.id);
        const value = await manager.resolveCredential(profile.id, field);
        if (value === undefined) throw new ConnectionError("CONNECTION_INVALID", `Credential field '${field}' is unavailable`, profile.id);
        headers.set(name, value);
      }
    }
    transport = new StreamableHTTPClientTransport(url, {
      fetch: guardedFetch(allowedNetworkHosts, { timeoutMs: timeout, maxStreamBytes: MAX_DISCOVERY_BYTES }),
      requestInit: { headers, redirect: "error" },
      ...(oauth ? { authProvider: await manager.oauthProviderFor(profile.id) } : {}),
      onInsufficientScope: "throw",
    });
  }
  const client = new Client(
    { name: "harnest", version: "0.2.0" },
    {
      versionNegotiation: protocolMode(profile.config, transportType),
      listMaxPages: 16,
      ...(onToolsChanged ? {
        listChanged: {
          tools: {
            autoRefresh: true,
            onChanged: (error, tools) => {
              if (!error && tools) void Promise.resolve(onToolsChanged(toolsFrom(tools))).catch(() => undefined);
            },
          },
        },
      } : {}),
    },
  );
  try {
    const requestOptions = {
      ...(options.signal ? { signal: options.signal } : {}),
      timeout,
      maxTotalTimeout: timeout,
    };
    await client.connect(transport, requestOptions);
    const listed = await client.listTools(undefined, { ...requestOptions, cacheMode: "refresh" });
    const close = async () => {
      await Promise.allSettled([
        ...(transport instanceof StreamableHTTPClientTransport && transport.sessionId
          ? [Promise.resolve().then(() => transport.terminateSession())]
          : []),
        Promise.resolve().then(() => client.close()),
      ]);
      await cleanupContainer?.();
    };
    return { client, transport, profile, tools: listed.tools, close };
  } catch (cause) {
    await client.close().catch(() => undefined);
    await cleanupContainer?.();
    throw cause;
  }
}
