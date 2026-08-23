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

export function missingConnectionSetup(
  components: readonly { type: string; config: Readonly<Record<string, unknown>> }[],
  connections: readonly ConnectionSummary[],
  tools: readonly { id: string; connectionKinds?: readonly ConnectionKind[] }[],
): { id: string; kind: ConnectionKind } | undefined {
  for (const component of components) {
    const tool = component.type === "tool" ? tools.find((item) => item.id === component.config.tool) : undefined;
    const kind: ConnectionKind | undefined = component.type === "model" ? "provider"
      : component.type === "mcp-tool" || component.config.source === "mcp" ? "mcp-http"
        : ["builtin.code-runner", "builtin.file", "builtin.shell"].includes(String(component.config.tool)) ? "local-runtime"
          : ["builtin.web-search", "builtin.web-scrape"].includes(String(component.config.tool)) ? "tool-service"
            : component.config.tool === "builtin.http" ? "http-api"
              : tool?.connectionKinds?.[0];
    const ids = component.type === "model"
      ? [component.config.connectionId, component.config.fallbackConnectionId]
      : [component.config.connectionId];
    for (const value of ids) {
      if (typeof value !== "string" || !value) continue;
      const saved = connections.find((connection) => connection.id === value);
      const mcp = component.type === "mcp-tool" || component.config.source === "mcp";
      const requiredKind = mcp && (saved?.kind === "mcp-http" || saved?.kind === "mcp-stdio")
        ? saved.kind : kind ?? saved?.kind;
      if (requiredKind && (!saved || !connectionCanRun(saved) || saved.kind !== requiredKind)) {
        return { id: value, kind: requiredKind };
      }
    }
  }
  return undefined;
}
