export type ConnectionScope = "project" | "user";

export type ConnectionKind =
  | "provider"
  | "mcp-http"
  | "mcp-stdio"
  | "http-api"
  | "tool-service"
  | "local-runtime";

export type ConnectionStatus =
  | "unknown"
  | "connected"
  | "needs_auth"
  | "expired"
  | "insufficient_scope"
  | "revocation_pending"
  | "disconnected"
  | "error";

export interface ConnectionErrorSummary {
  readonly code: string;
  readonly message: string;
  readonly recoverable: boolean;
}

/** Safe browser DTO. Secret values are intentionally not representable here. */
export interface ConnectionSummary {
  readonly id: string;
  readonly name: string;
  readonly kind: ConnectionKind;
  readonly scope: ConnectionScope;
  readonly status: ConnectionStatus;
  readonly config: Readonly<Record<string, unknown>>;
  readonly credentialFields: readonly string[];
  readonly credentialPresence: Readonly<Record<string, boolean>>;
  readonly lastCheckedAt?: string;
  readonly error?: ConnectionErrorSummary;
}

export type ConnectionAction =
  | "test"
  | "discover"
  | "approve-process"
  | "disconnect"
  | "reauth"
  | "revoke";

export interface ConnectionMutation {
  readonly id?: string;
  readonly name: string;
  readonly kind: ConnectionKind;
  readonly scope: ConnectionScope;
  readonly config?: Readonly<Record<string, unknown>>;
  /** Write-only: APIs never echo these values. */
  readonly secrets?: Readonly<Record<string, string>>;
}

export interface ConnectionActionResult {
  readonly connection: ConnectionSummary;
  readonly message: string;
  readonly resources?: readonly ConnectionResource[];
  readonly authorizationUrl?: string;
}

export interface ConnectionResource {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly inputSchema?: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly risk?: "read" | "write" | "external" | "destructive";
}

export const CONNECTION_KINDS: readonly ConnectionKind[] = [
  "provider",
  "mcp-http",
  "mcp-stdio",
  "http-api",
  "tool-service",
  "local-runtime",
];

export const connectionKindLabel = (kind: ConnectionKind) => ({
  provider: "Model provider",
  "mcp-http": "MCP · Streamable HTTP",
  "mcp-stdio": "MCP · stdio",
  "http-api": "HTTP API",
  "tool-service": "Tool service",
  "local-runtime": "Local runtime",
})[kind];

export const connectionCanRun = (connection: Pick<ConnectionSummary, "status">) =>
  connection.status === "connected" || connection.status === "unknown";
