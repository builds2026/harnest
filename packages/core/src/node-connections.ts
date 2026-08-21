import { spawn } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import {
  auth,
  Client,
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
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
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
import { snapshotSafeJsonSchema } from "./tool.js";

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

interface WrappedKeyFile {
  readonly version: typeof FILE_VERSION;
  readonly protection: "dpapi-current-user";
  readonly wrappedKey: string;
}

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
    const info = await stat(path);
    if (!info.isFile() || info.size > maxBytes) throw new Error(`File '${path}' is not a bounded regular file`);
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
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

class DpapiCredentialVault {
  readonly #vaultPath: string;
  readonly #keyPath: string;
  readonly #lockPath: string;
  #key: Buffer | undefined;

  constructor(directory: string) {
    this.#vaultPath = join(directory, "credentials.vault");
    this.#keyPath = join(directory, "credentials.key.dpapi");
    this.#lockPath = join(directory, "credentials.lock");
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
      if (!isRecord(candidate) || candidate.version !== FILE_VERSION
        || candidate.protection !== "dpapi-current-user" || typeof candidate.wrappedKey !== "string") {
        throw new ConnectionError("CREDENTIAL_STORE_FAILED", "The wrapped credential key file is invalid");
      }
      const key = await dpapi("unprotect", Buffer.from(candidate.wrappedKey, "base64"));
      if (key.length !== 32) throw new ConnectionError("CREDENTIAL_STORE_FAILED", "Windows DPAPI returned an invalid credential key");
      this.#key = key;
      return key;
    }
    const key = randomBytes(32);
    const wrapped = await dpapi("protect", key);
    await atomicJson(this.#keyPath, {
      version: FILE_VERSION,
      protection: "dpapi-current-user",
      wrappedKey: wrapped.toString("base64"),
    } satisfies WrappedKeyFile);
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
        "testUrl", "testMethod",
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
      if (input.config.staticParameters !== undefined && !isRecord(input.config.staticParameters)) {
        throw new ConnectionError("CONNECTION_INVALID", "Search staticParameters must be an object", input.id);
      }
      for (const field of ["queryParameter", "limitParameter", "titleField", "urlField", "snippetField", "contentField"] as const) {
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
    }
    validateTimeout(input.config.timeoutMs, input.id);
    return;
  }
  if (input.kind === "local-runtime") {
    assertConfigKeys(input.config, ["command", "args", "cwd", "timeoutMs"], input.id);
    validatePublicConfig(input.config);
    if (typeof input.config.command !== "string" || !input.config.command.trim() || !isAbsolute(input.config.command)) {
      throw new ConnectionError("CONNECTION_INVALID", "Local Runtime Connections require an absolute command path", input.id);
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
    ["transport", "protocol", "command", "args", "cwd", "environmentCredentials", "timeoutMs"],
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
    if (typeof input.config.command !== "string" || !input.config.command.trim() || input.config.command.length > 32_768
      || !isAbsolute(input.config.command)) {
      throw new ConnectionError("CONNECTION_INVALID", "MCP stdio connections require an absolute command path", input.id);
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

export async function mcpProcessFingerprint(profile: ConnectionProfile): Promise<string> {
  if (profile.kind !== "mcp" || profile.config.transport !== "stdio") throw new ConnectionError(
    "CONNECTION_TYPE_MISMATCH", `Connection '${profile.id}' is not MCP stdio`, profile.id,
  );
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

/** Stable approval identity; binds a visible Tool id to its saved Connection and exact MCP action. */
export function mcpToolApprovalId(connectionId: string, action: string): string {
  return `mcp.${createHash("sha256").update(connectionId).update("\0").update(action).digest("hex")}`;
}

export class ConnectionManager implements ConnectionCatalog {
  readonly #root: Promise<string>;
  readonly #projectFile: string;
  readonly #userFile: string;
  readonly #vault: DpapiCredentialVault;
  readonly #now: () => Date;
  #projectBinding: Promise<string> | undefined;

  constructor(projectDirectory: string, options: ConnectionManagerOptions = {}) {
    const absolute = resolve(projectDirectory);
    this.#root = realpath(absolute);
    this.#projectFile = join(absolute, ".harnest", "connections.json");
    const userDirectory = resolve(/* turbopackIgnore: true */ options.userDataDirectory ?? defaultUserDataDirectory());
    this.#userFile = join(userDirectory, "connections.json");
    this.#vault = new DpapiCredentialVault(userDirectory);
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
    const changedLaunch = current.kind === "mcp" && current.config.transport === "stdio" && configChanged;
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
        await this.#revokeOAuth(current, options.allowNetworkHosts);
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

  async approveProcess(id: string): Promise<string> {
    const profile = await this.require(id, "mcp");
    const fingerprint = await mcpProcessFingerprint(profile);
    await this.#vault.update(await this.#binding(profile.scope, id), (entry) => {
      this.#assertVaultBinding(profile, entry);
      return { ...entry, processApproval: fingerprint, profileBinding: connectionProfileBinding(profile) };
    });
    return fingerprint;
  }

  async assertProcessApproved(profile: ConnectionProfile): Promise<void> {
    const fingerprint = await mcpProcessFingerprint(profile);
    const entry = await this.#vault.read(await this.#binding(profile.scope, profile.id));
    this.#assertVaultBinding(profile, entry);
    const approved = entry?.processApproval;
    if (!approved || approved !== fingerprint) throw new ConnectionError(
      "PROCESS_APPROVAL_REQUIRED",
      `MCP stdio launch profile '${profile.name}' must be reviewed and approved`,
      profile.id,
    );
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
    try {
      result = await auth(provider, {
        serverUrl: profile.config.url,
        ...(options.scope ? { scope: options.scope } : {}),
        fetchFn: guardedFetch(options.allowNetworkHosts, {
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
    assertAllowedUrl(authorizationUrl, options.allowNetworkHosts);
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
    const transport = new StreamableHTTPClientTransport(new URL(profile.config.url), {
      authProvider: provider,
      fetch: guardedFetch(options.allowNetworkHosts, {
        timeoutMs: options.timeoutMs ?? OAUTH_FETCH_TIMEOUT_MS,
        maxResponseBytes: MAX_DISCOVERY_BYTES,
      }),
      onInsufficientScope: "throw",
    });
    try {
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
  return async (request, init) => {
    const url = new URL(request instanceof Request ? request.url : request.toString());
    assertAllowedUrl(url, allowed);
    const signals = [request instanceof Request ? request.signal : undefined, init?.signal]
      .filter((signal): signal is AbortSignal => signal !== undefined);
    if (options.timeoutMs !== undefined) signals.push(AbortSignal.timeout(options.timeoutMs));
    const response = await fetch(request, {
      ...init,
      ...(signals.length ? { signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals) } : {}),
      redirect: "error",
    });
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
  return {
    provider: typeof profile.config.connector === "string" ? profile.config.connector : "custom-search",
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

/** Executes the stable Web Search contract through a saved, origin-bound Connection. */
export async function executeWebSearchConnection(
  manager: ConnectionManager,
  profileOrId: ConnectionProfile | string,
  options: {
    readonly query: string;
    readonly limit: number;
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
  const headers = new Headers({ accept: "application/json" });
  for (const [name, value] of Object.entries(isRecord(profile.config.headers) ? profile.config.headers : {})) {
    if (typeof value === "string") headers.set(name, value);
  }
  const token = await manager.resolveCredential(profile.id, "token");
  if (profile.config.authScheme === "bearer" && !token) throw new Error("Search credential is required");
  if (token) headers.set("authorization", profile.config.authScheme === "bearer"
    ? `Bearer ${token.replace(/^Bearer\s+/i, "")}` : token);

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

export function protocolMode(config: Readonly<Record<string, unknown>>, transport: "stdio" | "http") {
  const protocol = config.protocol ?? (transport === "http" ? "auto" : "legacy");
  if (protocol === "auto") return { mode: "auto" as const };
  if (protocol === "2026-07-28") return { mode: { pin: "2026-07-28" } as const };
  return { mode: "legacy" as const };
}

async function projectWorkingDirectory(manager: ConnectionManager, profile: ConnectionProfile): Promise<string> {
  const project = dirname(dirname(manager.paths().projectMetadata));
  const root = await realpath(project);
  const configured = typeof profile.config.cwd === "string" ? profile.config.cwd : ".";
  if (isAbsolute(configured)) throw new ConnectionError("CONNECTION_INVALID", "MCP stdio cwd must be project-relative", profile.id);
  const target = await realpath(resolve(root, configured));
  if (!isInside(root, target)) throw new ConnectionError("CONNECTION_INVALID", "MCP stdio cwd resolves outside the project", profile.id);
  return target;
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
  if (transportType === "stdio") {
    await manager.assertProcessApproved(profile);
    const executable = await canonicalExecutable(profile.config.command, profile.id);
    const allowed = options.allowProcessCommands?.some((command) => process.platform === "win32"
      ? command.toLocaleLowerCase() === executable.path.toLocaleLowerCase() : command === executable.path);
    if (!allowed) throw new ConnectionError(
      "PROCESS_APPROVAL_REQUIRED", `MCP stdio command '${executable.path}' is not allowed by this runtime`, profile.id,
    );
    const environment = { ...getDefaultEnvironment() };
    if (isRecord(profile.config.environmentCredentials)) {
      for (const [name, field] of Object.entries(profile.config.environmentCredentials)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof field !== "string") throw new ConnectionError(
          "CONNECTION_INVALID", "MCP stdio environment credential binding is invalid", profile.id,
        );
        const value = await manager.resolveCredential(profile.id, field);
        if (value === undefined) throw new ConnectionError("CONNECTION_INVALID", `Credential field '${field}' is unavailable`, profile.id);
        environment[name] = value;
      }
    }
    transport = new StdioClientTransport({
      command: executable.path,
      ...(Array.isArray(profile.config.args) ? { args: profile.config.args as string[] } : {}),
      cwd: await projectWorkingDirectory(manager, profile),
      env: environment,
      stderr: "ignore",
    });
  } else {
    if (typeof profile.config.url !== "string") throw new ConnectionError("CONNECTION_INVALID", "MCP HTTP URL is missing", profile.id);
    const url = new URL(profile.config.url);
    assertAllowedUrl(url, options.allowNetworkHosts);
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
    const oauth = profile.config.oauth === true || isRecord(profile.config.oauth);
    transport = new StreamableHTTPClientTransport(url, {
      fetch: guardedFetch(options.allowNetworkHosts, { timeoutMs: timeout, maxStreamBytes: MAX_DISCOVERY_BYTES }),
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
    };
    return { client, transport, profile, tools: listed.tools, close };
  } catch (cause) {
    await client.close().catch(() => undefined);
    throw cause;
  }
}
