import "server-only";

import {
  CONNECTION_ID,
  ConnectionError,
  type ConnectionProfile,
  type ConnectionCreateInput,
  type ConnectionTool,
  type HarnessSpec,
} from "@harnestai/core";
import { ConnectionManager, detectContainerEngine, loadSpecFile } from "@harnestai/core/node";
import { ApiRequestError } from "./api-server";
import { EMPTY_SPEC } from "./default-spec";
import {
  CONNECTION_KINDS,
  type ConnectionAction,
  type ConnectionActionResult,
  type ConnectionKind,
  type ConnectionMutation,
  type ConnectionResource,
  type ConnectionSummary,
} from "./connections";
import { studioCapabilityPolicy } from "./runtime-config";
import { fileExists, harnessFile, runtimeResourcesFor } from "./server";

const FIELD_ID = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const SENSITIVE_KEY = /(?:authorization|cookies?|password|secrets?|tokens?|api[-_]?key|credentials?)$/i;

const jsonObject = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiRequestError("CONNECTION_INPUT_INVALID", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
};

function safeConfigValue(value: unknown, key = "config", depth = 0): unknown {
  if (depth > 8) throw new ApiRequestError("CONNECTION_CONFIG_INVALID", "Connection configuration is too deeply nested");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (value.length > 128) throw new ApiRequestError("CONNECTION_CONFIG_INVALID", "Connection configuration arrays are limited to 128 items");
    return value.map((item) => safeConfigValue(item, key, depth + 1));
  }
  if (!value || typeof value !== "object") {
    throw new ApiRequestError("CONNECTION_CONFIG_INVALID", `Connection field '${key}' is not JSON-safe`);
  }
  const result: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (!FIELD_ID.test(entryKey) || entryKey === "__proto__" || entryKey === "prototype" || entryKey === "constructor") {
      throw new ApiRequestError("CONNECTION_CONFIG_INVALID", `Connection field '${entryKey}' is invalid`);
    }
    if (SENSITIVE_KEY.test(entryKey)) {
      throw new ApiRequestError("CONNECTION_SECRET_IN_CONFIG", `Secret field '${entryKey}' must use the write-only credential fields`);
    }
    result[entryKey] = safeConfigValue(entryValue, entryKey, depth + 1);
  }
  return result;
}

export function parseConnectionMutation(value: unknown, requireId = false): ConnectionMutation {
  const input = jsonObject(value, "Connection");
  const allowed = new Set(["id", "name", "kind", "scope", "config", "secrets"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new ApiRequestError("CONNECTION_INPUT_INVALID", `Unknown connection field '${key}'`);
  }
  if ((requireId || input.id !== undefined) && (typeof input.id !== "string" || !CONNECTION_ID.test(input.id))) {
    throw new ApiRequestError("CONNECTION_ID_INVALID", "A valid connection id is required");
  }
  if (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 80) {
    throw new ApiRequestError("CONNECTION_NAME_INVALID", "Connection name must contain 1–80 characters");
  }
  if (typeof input.kind !== "string" || !CONNECTION_KINDS.includes(input.kind as ConnectionKind)) {
    throw new ApiRequestError("CONNECTION_KIND_INVALID", "Connection kind is not supported");
  }
  if (input.scope !== "project" && input.scope !== "user") {
    throw new ApiRequestError("CONNECTION_SCOPE_INVALID", "Connection scope must be project or user");
  }
  const config = input.config === undefined ? {} : safeConfigValue(input.config) as Record<string, unknown>;
  const secrets: Record<string, string> = {};
  if (input.secrets !== undefined) {
    for (const [key, secret] of Object.entries(jsonObject(input.secrets, "secrets"))) {
      if (!FIELD_ID.test(key) || typeof secret !== "string" || secret.length > 16_384) {
        throw new ApiRequestError("CONNECTION_SECRET_INVALID", `Credential field '${key}' is invalid`);
      }
      if (secret) secrets[key] = secret;
    }
  }
  if (new TextEncoder().encode(JSON.stringify({ config, secrets })).byteLength > 65_536) {
    throw new ApiRequestError("CONNECTION_INPUT_TOO_LARGE", "Connection data exceeds 64 KiB", 413);
  }
  return {
    ...(typeof input.id === "string" ? { id: input.id } : {}),
    name: input.name.trim(),
    kind: input.kind as ConnectionKind,
    scope: input.scope,
    config,
    secrets,
  };
}

const coreKind = (kind: ConnectionKind): ConnectionProfile["kind"] =>
  kind === "mcp-http" || kind === "mcp-stdio" ? "mcp" : kind;

const browserKind = (profile: ConnectionProfile): ConnectionKind => profile.kind === "mcp"
  ? profile.config.transport === "stdio" ? "mcp-stdio" : "mcp-http"
  : profile.kind;

async function coreConfig(input: ConnectionMutation, current?: ConnectionProfile): Promise<Readonly<Record<string, unknown>>> {
  const config = { ...(input.config ?? {}) };
  if (input.kind === "provider") {
    const adapter = typeof config.adapter === "string" && config.adapter.trim()
      ? config.adapter.trim()
      : typeof config.provider === "string" ? config.provider.trim() : "";
    const model = typeof config.model === "string" ? config.model.trim() : "";
    if (!adapter || !model) throw new ApiRequestError(
      "CONNECTION_PROVIDER_INVALID",
      "Provider connections require an adapter id and default model",
    );
    const publicConfig = { ...config };
    delete publicConfig.provider;
    return { ...publicConfig, adapter, model };
  }
  if ((input.kind === "http-api" || input.kind === "tool-service")
    && (input.secrets?.token || current?.credentialFields.includes("token"))) {
    return { ...config, headerCredentials: { Authorization: "token" } };
  }
  if (input.kind === "local-runtime" || input.kind === "mcp-stdio") {
    const engine = typeof config.engine === "string" && config.engine.trim()
      ? config.engine.trim() : await detectContainerEngine();
    const isolated = {
      ...config,
      sandbox: "container",
      engine,
      network: "none",
      memoryMb: typeof config.memoryMb === "number" ? config.memoryMb : 256,
      cpus: typeof config.cpus === "number" ? config.cpus : 1,
      pids: typeof config.pids === "number" ? config.pids : 64,
    };
    if (input.kind === "local-runtime") return isolated;
    return { ...isolated, transport: "stdio" };
  }
  if (input.kind !== "mcp-http") return config;
  const normalized: Record<string, unknown> = { ...config, transport: "http" };
  if (input.secrets?.token || current?.credentialFields.includes("token")) {
    normalized.headerCredentials = { Authorization: "token" };
  }
  return normalized;
}

const browserStatus = (profile: ConnectionProfile): ConnectionSummary["status"] => ({
  unknown: "unknown",
  connected: "connected",
  disconnected: "disconnected",
  needs_auth: "needs_auth",
  expired: "expired",
  insufficient_scope: "insufficient_scope",
  revocation_pending: "revocation_pending",
  error: "error",
})[profile.status.state] as ConnectionSummary["status"];

const browserConfig = (profile: ConnectionProfile): Readonly<Record<string, unknown>> => {
  const config = { ...profile.config };
  // These are server-managed bindings. The browser edits their public inputs
  // (Connection kind and write-only credentials), never the internal mapping.
  delete config.headerCredentials;
  if (profile.kind === "mcp") delete config.transport;
  return config;
};

const resourceRisk = (tool: ConnectionTool): ConnectionResource["risk"] => {
  if (tool.annotations?.destructiveHint === true) return "destructive";
  return "external";
};

const resource = (tool: ConnectionTool): ConnectionResource => {
  const risk = resourceRisk(tool);
  return {
    id: tool.name,
    label: tool.title ?? tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    ...(risk ? { risk } : {}),
  };
};

export class StudioConnectionService {
  readonly #manager: ConnectionManager;

  constructor(projectDirectory: string) {
    this.#manager = new ConnectionManager(projectDirectory, { allowLocalCredentialKey: true });
  }

  async #testProvider(profile: ConnectionProfile): Promise<string> {
    const file = harnessFile();
    let spec: HarnessSpec = EMPTY_SPEC;
    if (await fileExists(file)) {
      const loaded = await loadSpecFile(file);
      if (loaded.ok) spec = loaded.spec;
    }
    const resources = await runtimeResourcesFor(spec);
    const runId = `connection_test_${profile.id}`;
    const serviceContext = {
      signal: new AbortController().signal,
      runId,
      nodeId: "connection-test",
      iteration: 0,
      resolveSecret: () => undefined,
    };
    try {
      const resolved = await resources.services.resolveConnection(profile.id, serviceContext);
      const config = jsonObject(resolved.value, "Provider connection");
      const adapterId = typeof config.adapter === "string" ? config.adapter : "";
      const model = typeof config.model === "string" ? config.model : "";
      if (!adapterId || !model) throw new Error("Provider adapter and model are required");
      const adapter = resources.adapters.get(adapterId);
      const signal = AbortSignal.timeout(typeof config.timeoutMs === "number" ? config.timeoutMs : 30_000);
      let finished = false;
      for await (const event of adapter.run({
        model,
        messages: [{ role: "user", content: "Reply OK." }],
        maxTokens: 1,
        ...(typeof config.baseUrl === "string" ? { baseUrl: config.baseUrl } : {}),
        ...(typeof config.apiKey === "string" ? { apiKey: config.apiKey } : {}),
      }, {
        signal,
        resolveSecret: (reference) => resources.services.resolveSecret(reference),
        fetch: (url, init) => resources.services.fetchProvider(url, init),
      })) {
        if (event.type === "finish") finished = true;
      }
      if (!finished) throw new Error(`Adapter '${adapterId}' ended without a finish event`);
      return `${adapterId} · ${model} responded`;
    } finally {
      resources.services.releaseRun(runId);
      await resources.services.close();
    }
  }

  async #summary(profile: ConnectionProfile): Promise<ConnectionSummary> {
    const present = await this.#manager.credentialPresence(profile.id);
    return {
      id: profile.id,
      name: profile.name,
      kind: browserKind(profile),
      scope: profile.scope,
      status: browserStatus(profile),
      config: browserConfig(profile),
      credentialFields: profile.credentialFields,
      credentialPresence: Object.fromEntries(present.map((field) => [field, true])),
      ...(profile.status.checkedAt ? { lastCheckedAt: profile.status.checkedAt } : {}),
      ...(profile.status.message && ["error", "expired", "insufficient_scope", "revocation_pending"].includes(profile.status.state)
        ? { error: { code: "CONNECTION_STATUS", message: profile.status.message, recoverable: true } }
        : {}),
    };
  }

  async list(): Promise<ConnectionSummary[]> {
    return Promise.all((await this.#manager.list()).map((profile) => this.#summary(profile)));
  }

  async create(input: ConnectionMutation): Promise<ConnectionSummary> {
    const profile = await this.#manager.create({
      ...(input.id ? { id: input.id } : {}),
      scope: input.scope,
      kind: coreKind(input.kind),
      name: input.name,
      config: await coreConfig(input),
    } satisfies ConnectionCreateInput, input.secrets);
    return this.#summary(profile);
  }

  async update(input: ConnectionMutation & { id: string }): Promise<ConnectionSummary> {
    const current = await this.#manager.require(input.id);
    if (current.scope !== input.scope || current.kind !== coreKind(input.kind) || browserKind(current) !== input.kind) {
      throw new ApiRequestError("CONNECTION_IMMUTABLE_FIELD", "Connection kind and scope cannot change after creation");
    }
    const profile = await this.#manager.update(input.id, {
      name: input.name,
      config: await coreConfig(input, current),
    }, input.secrets && Object.keys(input.secrets).length ? input.secrets : undefined);
    return this.#summary(profile);
  }

  async delete(id: string): Promise<void> {
    if (!CONNECTION_ID.test(id)) throw new ApiRequestError("CONNECTION_ID_INVALID", "Connection id is invalid");
    if (!await this.#manager.delete(id)) throw new ApiRequestError("CONNECTION_NOT_FOUND", "Connection was not found", 404);
  }

  async action(
    id: string,
    action: ConnectionAction,
    options: { readonly redirectUrl?: string } = {},
  ): Promise<ConnectionActionResult> {
    if (!CONNECTION_ID.test(id)) throw new ApiRequestError("CONNECTION_ID_INVALID", "Connection id is invalid");
    const policy = studioCapabilityPolicy(process.env);
    const target = await this.#manager.require(id);
    const connectionHost = target.kind === "mcp" && target.config.transport === "http" && typeof target.config.url === "string"
      ? new URL(target.config.url).host.toLocaleLowerCase() : undefined;
    const networkHosts = [...new Set([...policy.networkHosts, ...(connectionHost ? [connectionHost] : [])])];
    const runtime = { allowProcessCommands: policy.processCommands, allowNetworkHosts: networkHosts };
    if (action === "test") {
      try {
        const profile = await this.#manager.test(id, {
          ...runtime,
          ...(target.kind === "provider" ? { probe: (candidate: ConnectionProfile) => this.#testProvider(candidate) } : {}),
        });
        return { connection: await this.#summary(profile), message: profile.status.message ?? "Connection test passed." };
      } catch (error) {
        if (!(error instanceof ConnectionError) || error.code !== "CONNECTION_TEST_FAILED") throw error;
        return {
          connection: await this.#summary(await this.#manager.require(id)),
          message: `Connection test failed: ${error.message}`,
        };
      }
    }
    if (action === "discover") {
      let resources: readonly ConnectionTool[];
      try {
        resources = await this.#manager.refreshTools(id, runtime);
      } catch (error) {
        if (!(error instanceof ConnectionError) || error.code !== "CONNECTION_TEST_FAILED") throw error;
        return {
          connection: await this.#summary(await this.#manager.require(id)),
          message: `Tool discovery failed: ${error.message}`,
          resources: [],
        };
      }
      return {
        connection: await this.#summary(await this.#manager.require(id)),
        message: `${resources.length} compatible tool(s) discovered.`,
        resources: resources.map(resource),
      };
    }
    if (action === "approve-process") {
      await this.#manager.approveProcess(id, { pullImage: true });
      const tested = await this.#manager.test(id, runtime);
      return {
        connection: await this.#summary(tested),
        message: target.kind === "mcp"
          ? `${tested.tools?.length ?? 0} MCP tool(s) discovered in the isolated container.`
          : tested.status.message ?? "Code sandbox is ready.",
      };
    }
    if (action === "disconnect" || action === "revoke") {
      const profile = await this.#manager.disconnect(id, {
        revoke: action === "revoke",
        allowNetworkHosts: networkHosts,
      });
      return {
        connection: await this.#summary(profile),
        message: profile.status.state === "revocation_pending"
          ? profile.status.message ?? "Remote revocation is pending; credentials were retained for retry."
          : action === "revoke" ? "Authorization and local credentials were revoked." : "Connection disconnected and local credentials cleared.",
      };
    }

    const profile = target;
    if (profile.kind === "mcp" && profile.config.transport === "http" && profile.config.oauth === true) {
      if (!options.redirectUrl) throw new ApiRequestError("OAUTH_REDIRECT_INVALID", "OAuth callback URL is unavailable");
      const started = await this.#manager.beginOAuth(id, {
        redirectUrl: options.redirectUrl,
        allowNetworkHosts: networkHosts,
        forceReauthorization: true,
      });
      const refreshed = await this.#manager.require(id);
      return {
        connection: await this.#summary(refreshed),
        message: started.status === "authorized" ? "OAuth authorization is active." : "Complete authorization in the opened window.",
        ...(started.authorizationUrl ? { authorizationUrl: started.authorizationUrl } : {}),
      };
    }
    return {
      connection: await this.#summary(profile),
      message: "Enter new write-only credentials, then save and test the connection.",
    };
  }

  async finishOAuth(id: string, callback: URLSearchParams): Promise<ConnectionSummary> {
    if (!CONNECTION_ID.test(id)) throw new ApiRequestError("CONNECTION_ID_INVALID", "Connection id is invalid");
    const policy = studioCapabilityPolicy(process.env);
    const current = await this.#manager.require(id, "mcp");
    const host = current.config.transport === "http" && typeof current.config.url === "string"
      ? new URL(current.config.url).host.toLocaleLowerCase() : undefined;
    const profile = await this.#manager.finishOAuth(id, callback, {
      allowNetworkHosts: [...new Set([...policy.networkHosts, ...(host ? [host] : [])])],
    });
    return this.#summary(profile);
  }
}
