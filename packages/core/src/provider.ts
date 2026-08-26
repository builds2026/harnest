import type { PromptCacheStore } from "./adapter.js";
import type {
  ArtifactReference,
  RunAttachment,
  RunConversationMessage,
  RuntimeServices,
  ServiceExecutionContext,
  ServiceResult,
} from "./component.js";
import type { RunEvent, RunStore } from "./runtime.js";
import type { PermissionDecision } from "./tool.js";

export type ProviderRevision = string | number;
export type MemoryNamespace = "user" | "conversation" | "pkm";
export type CacheNamespace = "context" | "provider-prompt";

export interface ContextProvenance {
  readonly source: string;
  readonly sourceId?: string;
  readonly title?: string;
  readonly uri?: string;
  readonly revision?: ProviderRevision;
}

export interface ContextSource {
  readonly label: `S${number}`;
  readonly content: string;
  readonly provenance: ContextProvenance;
}

export interface Citation {
  readonly label: `S${number}`;
  readonly provenance: ContextProvenance;
}

export interface ConversationReadRequest {
  /** Legacy host identity. Omit when an opaque contextRef is available. */
  readonly conversationId?: string;
  readonly revision?: ProviderRevision;
  readonly cursor?: string;
  readonly contextRef?: string;
  readonly limit?: number;
}

export interface ConversationReadResult {
  readonly messages: readonly RunConversationMessage[];
  readonly revision: ProviderRevision;
  readonly cursor?: string;
  readonly sources?: readonly Omit<ContextSource, "label">[];
}

export interface ConversationProvider {
  read(request: ConversationReadRequest, context: ServiceExecutionContext): Promise<ConversationReadResult>;
}

export interface MemoryRecord {
  readonly id: string;
  readonly namespace: MemoryNamespace;
  readonly value: unknown;
  readonly provenance: ContextProvenance;
  readonly revision: ProviderRevision;
}

export interface MemorySearchResult {
  readonly records: readonly MemoryRecord[];
  readonly revision: ProviderRevision;
}

export interface MemoryProvider {
  search(request: {
    readonly namespace: MemoryNamespace;
    readonly query: unknown;
    readonly revision?: ProviderRevision;
    readonly contextRef?: string;
    readonly limit?: number;
  }, context: ServiceExecutionContext): Promise<MemorySearchResult>;
  upsert(request: {
    readonly namespace: MemoryNamespace;
    readonly id?: string;
    readonly value: unknown;
    readonly provenance: ContextProvenance;
    readonly revision?: ProviderRevision;
    readonly contextRef?: string;
  }, context: ServiceExecutionContext): Promise<MemoryRecord>;
  delete(request: {
    readonly namespace: MemoryNamespace;
    readonly id: string;
    readonly revision?: ProviderRevision;
    readonly contextRef?: string;
  }, context: ServiceExecutionContext): Promise<{ readonly revision: ProviderRevision }>;
}

export interface CacheEntry {
  readonly namespace: CacheNamespace;
  readonly key: string;
  readonly value: unknown;
  readonly etag: string;
  readonly revision?: ProviderRevision;
  readonly expiresAt: string;
}

export interface CacheProvider {
  get(request: Pick<CacheEntry, "namespace" | "key" | "revision">, context: ServiceExecutionContext): Promise<CacheEntry | undefined>;
  put(request: Omit<CacheEntry, "etag" | "expiresAt"> & {
    readonly ttlMs: number;
    readonly etag?: string;
  }, context: ServiceExecutionContext): Promise<CacheEntry>;
  delete(request: Pick<CacheEntry, "namespace" | "key"> & { readonly etag?: string }, context: ServiceExecutionContext): Promise<boolean>;
}

export interface FileReference {
  readonly ref: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size?: number;
  readonly sha256?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface FileProvider {
  read(request: { readonly ref: string; readonly contextRef?: string }, context: ServiceExecutionContext): Promise<{
    readonly file: FileReference;
    readonly stream: AsyncIterable<Uint8Array>;
  }>;
  create(request: Omit<FileReference, "ref" | "size" | "sha256"> & { readonly contextRef?: string }, context: ServiceExecutionContext): Promise<{ readonly ref: string }>;
  commit(request: {
    readonly ref: string;
    readonly stream: AsyncIterable<Uint8Array>;
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly contextRef?: string;
  }, context: ServiceExecutionContext): Promise<FileReference>;
}

export interface ResolvedConnection {
  readonly id: string;
  readonly kind: string;
  /** Secret-free connection configuration only. */
  readonly configuration?: Readonly<Record<string, unknown>>;
  /** Credential injection stays inside this bounded outbound operation. */
  fetch?(url: string | URL, init?: RequestInit): Promise<Response>;
  execute?(operation: string, input: unknown): Promise<unknown>;
}

export interface ConnectionProvider {
  resolve(request: {
    readonly connectionId: string;
    readonly purpose: "metadata" | "provider" | "tool";
    readonly contextRef?: string;
  }, context: ServiceExecutionContext): Promise<ResolvedConnection>;
}

export interface PersistentPermissionScope {
  readonly harnessId: string;
  readonly toolId: string;
  readonly connectionId?: string;
  readonly capability: "network" | "process" | "workspace-write";
  readonly resource?: string;
}

export interface PersistentPermissionGrant {
  readonly id: string;
  readonly scope: PersistentPermissionScope;
  readonly effect: Extract<PermissionDecision, "allow_always">;
  readonly createdAt: string;
  readonly expiresAt?: string;
}

export interface PermissionProvider {
  list(request: { readonly harnessId: string }, context: ServiceExecutionContext): Promise<readonly PersistentPermissionGrant[]>;
  find(scope: PersistentPermissionScope, context: ServiceExecutionContext): Promise<PersistentPermissionGrant | undefined>;
  grant(request: { readonly scope: PersistentPermissionScope; readonly effect: "allow_always" }, context: ServiceExecutionContext): Promise<PersistentPermissionGrant>;
  revoke(request: { readonly id: string }, context: ServiceExecutionContext): Promise<boolean>;
}

export interface HostProviders {
  readonly conversation?: ConversationProvider;
  readonly memory?: MemoryProvider;
  readonly cache?: CacheProvider;
  readonly files?: FileProvider;
  readonly connections?: ConnectionProvider;
  readonly permissions?: PermissionProvider;
  readonly runs: RunStore;
}

export type FilesProvider = FileProvider;
export type ConnectionsProvider = ConnectionProvider;
export type PermissionsProvider = PermissionProvider;
export type RunsProvider = RunStore;
export type HostProviderSet = HostProviders;

export interface HttpHostProviderOptions {
  readonly baseUrl: string | URL;
  readonly token: string;
  readonly runs: RunStore;
  readonly fetch?: typeof globalThis.fetch;
}

/** Native-fetch Host Provider client. Bearer credentials remain closed over and never enter Provider values. */
export function createHttpHostProviders(options: HttpHostProviderOptions): HostProviders {
  const endpoint = new URL(options.baseUrl);
  const loopback = endpoint.hostname === "127.0.0.1" || endpoint.hostname === "[::1]";
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) {
    throw new Error("Host Provider URL must use HTTPS, or HTTP on a literal loopback address");
  }
  if (endpoint.username || endpoint.password || endpoint.hash) throw new Error("Host Provider URL must not contain credentials or a fragment");
  if (!options.token) throw new Error("Host Provider token is required");
  const fetchFn = options.fetch ?? globalThis.fetch;
  const call = async <T>(operation: string, request: unknown, service: ServiceExecutionContext): Promise<T> => {
    if (!service.contextRef) throw new Error(`Host Provider '${operation}' requires an opaque contextRef`);
    const transportRequest = request && typeof request === "object" && !Array.isArray(request)
      ? Object.fromEntries(Object.entries(request).filter(([key]) => !/^context[-_]?ref$/iu.test(key)))
      : request;
    const response = await fetchFn(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
      body: JSON.stringify({ operation, request: transportRequest, contextRef: service.contextRef }),
      signal: service.signal,
      redirect: "error",
    });
    const parsed = await response.json().catch(() => undefined) as unknown;
    if (!response.ok) throw new Error(`Host Provider '${operation}' failed with HTTP ${response.status}`);
    const envelope = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
    if (!envelope || !("result" in envelope)) throw new Error(`Host Provider '${operation}' returned an invalid response`);
    return envelope.result as T;
  };
  const encode = (bytes: Uint8Array): string => {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  };
  const decode = (value: string): Uint8Array => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  const providers: HostProviders = {
    runs: options.runs,
    conversation: { read: (request, service) => call("conversation.read", request, service) },
    memory: {
      search: (request, service) => call("memory.search", request, service),
      upsert: (request, service) => call("memory.upsert", request, service),
      delete: (request, service) => call("memory.delete", request, service),
    },
    cache: {
      get: (request, service) => call<CacheEntry | null>("cache.get", request, service).then((value) => value ?? undefined),
      put: (request, service) => call("cache.put", request, service),
      delete: (request, service) => call("cache.delete", request, service),
    },
    files: {
      async read(request, service) {
        const result = await call<{ readonly file: FileReference; readonly url?: string; readonly dataBase64?: string }>("file.read", request, service);
        let bytes: Uint8Array;
        if (result.dataBase64) bytes = decode(result.dataBase64);
        else {
          if (typeof result.url !== "string") throw new Error("Host Provider file.read returned no content URL");
          const url = new URL(result.url, endpoint);
          if (url.origin !== endpoint.origin || url.username || url.password || url.hash) throw new Error("Host Provider file URL is outside the configured origin");
          const response = await fetchFn(url, {
            headers: { authorization: `Bearer ${options.token}` }, signal: service.signal, redirect: "error",
          });
          if (!response.ok) throw new Error(`Host Provider file read failed with HTTP ${response.status}`);
          const buffer = await response.arrayBuffer();
          if (buffer.byteLength > 32 * 1_048_576) throw new Error("Host Provider file exceeds the 32 MiB runtime limit");
          bytes = new Uint8Array(buffer);
        }
        return { file: result.file, stream: (async function* () { yield bytes; })() };
      },
      create: (request, service) => call("file.create", request, service),
      async commit(request, service) {
        const bytes = await collect(request.stream);
        return call("file.commit", { ...request, stream: undefined, dataBase64: encode(bytes) }, service);
      },
    },
    connections: {
      async resolve(request, service) {
        const resolved = await call<Pick<ResolvedConnection, "id" | "kind" | "configuration">>("connections.resolve", request, service);
        return {
          ...resolved,
          fetch: async (url, init) => {
            const headers = Object.fromEntries(new Headers(init?.headers).entries());
            const body = typeof init?.body === "string" ? init.body : undefined;
            const result = await call<{ status: number; headers?: Record<string, string>; bodyBase64?: string }>("connections.fetch", {
              connectionId: request.connectionId,
              url: String(url),
              init: { method: init?.method, headers, body },
            }, service);
            const responseBody = result.bodyBase64 ? decode(result.bodyBase64).slice().buffer as ArrayBuffer : undefined;
            return new Response(responseBody, {
              status: result.status,
              ...(result.headers ? { headers: result.headers } : {}),
            });
          },
          execute: (action, input) => call("connections.execute", { connectionId: request.connectionId, action, input }, service),
        };
      },
    },
    permissions: {
      list: (request, service) => call("permissions.list", request, service),
      find: (request, service) => call<PersistentPermissionGrant | null>("permissions.find", request, service).then((value) => value ?? undefined),
      grant: (request, service) => call("permissions.grant", request, service),
      revoke: (id, service) => call("permissions.revoke", { id }, service),
    },
  };
  return providers;
}

export function normalizeContextSources(
  sources: readonly Omit<ContextSource, "label">[],
): readonly ContextSource[] {
  return sources.slice(0, 100).map((source, index) => ({
    label: `S${index + 1}`,
    content: source.content,
    provenance: { ...source.provenance },
  }));
}

export function validateContextCitations(text: string, sources: readonly Pick<ContextSource, "label">[]): {
  readonly valid: readonly string[];
  readonly invented: readonly string[];
} {
  const available = new Set<string>(sources.map(({ label }) => label));
  const labels = [...new Set([...text.matchAll(/\[(S\d+)\]/g)].map((match) => match[1]!))];
  return { valid: labels.filter((label) => available.has(label)), invented: labels.filter((label) => !available.has(label)) };
}

const collect = async (stream: AsyncIterable<Uint8Array>, maximum = 32 * 1_048_576): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > maximum) throw new Error("Provider file exceeds the 32 MiB runtime limit");
    chunks.push(chunk);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
};

const secretFreeConfiguration = (value: Readonly<Record<string, unknown>> | undefined): Readonly<Record<string, unknown>> => {
  const visit = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(visit);
    if (!candidate || typeof candidate !== "object") return candidate;
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(candidate)) {
      if (/(?:api[-_]?key|authorization|secret|token|password|credential|cookie|private[-_]?key)$/iu.test(key)) {
        throw new Error("Connection Provider returned credential material");
      }
      result[key] = visit(child);
    }
    return result;
  };
  return visit(value ?? {}) as Readonly<Record<string, unknown>>;
};

/** Adapts product-owned providers to the existing RuntimeServices surface. */
export function runtimeServicesFromProviders(providers: HostProviders, legacy: RuntimeServices = {}): RuntimeServices {
  const resolvedConnections = new Map<string, ResolvedConnection>();
  const connectionScope = (context: Pick<ServiceExecutionContext, "runId" | "nodeId">) => `${context.runId}\0${context.nodeId}`;
  // PromptCacheStore lacks a run context; only an explicitly supplied local/provider-native store is safe.
  const promptCache: PromptCacheStore | undefined = legacy.promptCache;
  return {
    ...legacy,
    releaseRun: async (runId: string) => {
      for (const key of resolvedConnections.keys()) if (key.startsWith(`${runId}\0`)) resolvedConnections.delete(key);
      await legacy.releaseRun?.(runId);
    },
    ...(promptCache ? { promptCache } : {}),
    providers,
    ...(providers.files ? {
      readAttachment: async (attachment: RunAttachment, context: ServiceExecutionContext) =>
        collect((await providers.files!.read({ ref: attachment.ref ?? attachment.id }, context)).stream),
    } : {}),
    ...(providers.connections ? {
      resolveConnection: async (connectionId: string, context: ServiceExecutionContext): Promise<ServiceResult> => {
        const resolved = await providers.connections!.resolve({ connectionId, purpose: "metadata" }, context);
        resolvedConnections.set(connectionScope(context), resolved);
        return {
          value: {
            ...secretFreeConfiguration(resolved.configuration),
            connectionId: resolved.id,
            connectionKind: resolved.kind,
          },
        };
      },
    } : {}),
    ...(providers.connections ? {
      fetchProvider: async (url: string | URL, init: RequestInit | undefined, context: ServiceExecutionContext) => {
        const target = new URL(url);
        const connection = resolvedConnections.get(connectionScope(context));
        const baseUrl = connection?.configuration?.baseUrl;
        let sameOrigin = false;
        try { sameOrigin = typeof baseUrl === "string" && new URL(baseUrl).origin === target.origin; } catch { /* deny */ }
        if (!connection?.fetch || !sameOrigin) throw new Error("No credential-injecting Connection is resolved for this URL and run node");
        return connection.fetch(url, init);
      },
    } : {}),
    ...(providers.connections ? {
      executeTool: async (binding, input, context) => {
        if (!binding.connectionId) throw new Error(`Tool '${binding.id}' requires a Connection id`);
        const connection = await providers.connections!.resolve({ connectionId: binding.connectionId, purpose: "tool" }, context);
        if ((!connection?.id || !connection.kind) && legacy.executeTool) {
          return legacy.executeTool(binding, input, context);
        }
        if (!connection.execute) throw new Error(`Connection '${binding.connectionId}' cannot execute Tools`);
        return { value: await connection.execute(binding.action ?? binding.id, input) };
      },
    } : {}),
  };
}

export type ProviderRunEvent = RunEvent;
export type ProviderArtifactReference = ArtifactReference;
