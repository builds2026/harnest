export type ConnectionScope = "project" | "user";

export type ConnectionKind =
  | "provider"
  | "mcp"
  | "http-api"
  | "tool-service"
  | "local-runtime";

export type ConnectionState =
  | "unknown"
  | "connected"
  | "disconnected"
  | "needs_auth"
  | "expired"
  | "insufficient_scope"
  | "revocation_pending"
  | "error";

export interface ConnectionStatus {
  readonly state: ConnectionState;
  readonly checkedAt?: string;
  readonly message?: string;
}

export interface ConnectionTool {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly annotations?: Readonly<Record<string, unknown>>;
}

/** Public, serializable connection metadata. Credential values never inhabit this type. */
export interface ConnectionProfile {
  readonly id: string;
  readonly scope: ConnectionScope;
  readonly kind: ConnectionKind;
  readonly name: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly credentialFields: readonly string[];
  readonly status: ConnectionStatus;
  readonly tools?: readonly ConnectionTool[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ConnectionCreateInput {
  readonly id?: string;
  readonly scope: ConnectionScope;
  readonly kind: ConnectionKind;
  readonly name: string;
  readonly config: Readonly<Record<string, unknown>>;
}

export interface ConnectionUpdateInput {
  readonly name?: string;
  readonly config?: Readonly<Record<string, unknown>>;
}

export interface ConnectionSearch {
  readonly text?: string;
  readonly scope?: ConnectionScope;
  readonly kind?: ConnectionKind;
}

export interface OAuthStartResult {
  readonly status: "authorized" | "redirect";
  readonly authorizationUrl?: string;
  readonly state?: string;
  readonly redirectUrl?: string;
  readonly expiresAt?: string;
}

export interface ConnectionCatalog {
  get(id: string): ConnectionProfile | undefined | Promise<ConnectionProfile | undefined>;
  list(search?: ConnectionSearch): readonly ConnectionProfile[] | Promise<readonly ConnectionProfile[]>;
}

export class ConnectionError extends Error {
  readonly code:
    | "CONNECTION_INVALID"
    | "CONNECTION_DUPLICATE"
    | "CONNECTION_NOT_FOUND"
    | "CONNECTION_TYPE_MISMATCH"
    | "CONNECTION_TEST_FAILED"
    | "CREDENTIAL_BACKEND_UNAVAILABLE"
    | "CREDENTIAL_STORE_FAILED"
    | "PROCESS_APPROVAL_REQUIRED"
    | "OAUTH_INVALID"
    | "OAUTH_STATE_INVALID"
    | "OAUTH_SESSION_EXPIRED";
  readonly connectionId: string | undefined;

  constructor(code: ConnectionError["code"], message: string, connectionId?: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ConnectionError";
    this.code = code;
    this.connectionId = connectionId;
  }
}

export const CONNECTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const CREDENTIAL_FIELD = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;

export const DEFAULT_PROVIDER_MODELS = Object.freeze({
  gemini: "gemini-3.5-flash-lite",
  openai: "",
  anthropic: "",
  ollama: "llama3.2",
});

export const DEFAULT_SANDBOX_IMAGES = Object.freeze({
  node: "node:22-alpine",
  python: "python:3.13-alpine",
});

export const FIRECRAWL_CONNECTION_CONFIG = Object.freeze({
  connector: "firecrawl",
  url: "https://api.firecrawl.dev/v2/search",
  authScheme: "bearer",
  method: "POST",
  requestEncoding: "json",
  queryParameter: "query",
  limitParameter: "limit",
  staticParameters: { sources: ["web"] },
  responseItemsPath: "/data/web",
  titleField: "title",
  urlField: "url",
  snippetField: "description",
  contentField: "markdown",
  testUrl: "https://api.firecrawl.dev/v2/team/credit-usage",
  testMethod: "GET",
  scrapeUrl: "https://api.firecrawl.dev/v2/scrape",
  scrapeUrlParameter: "url",
  scrapeStaticParameters: { formats: ["markdown"], onlyMainContent: true },
  scrapeContentPath: "/data/markdown",
  scrapeTitlePath: "/data/metadata/title",
  scrapeSourceUrlPath: "/data/metadata/sourceURL",
});

export const SEARXNG_CONNECTION_CONFIG = Object.freeze({
  connector: "searxng",
  url: "",
  authScheme: "none",
  method: "GET",
  requestEncoding: "query",
  queryParameter: "q",
  limitParameter: "limit",
  staticParameters: { format: "json" },
  responseItemsPath: "/results",
  titleField: "title",
  urlField: "url",
  snippetField: "content",
});
