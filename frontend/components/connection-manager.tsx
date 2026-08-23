"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  DEFAULT_PROVIDER_MODELS,
  DEFAULT_SANDBOX_IMAGES,
  FIRECRAWL_CONNECTION_CONFIG,
  SEARXNG_CONNECTION_CONFIG,
} from "@harnest/core";
import {
  connectionCanRun,
  connectionKindLabel,
  type ConnectionAction,
  type ConnectionActionResult,
  type ConnectionKind,
  type ConnectionMutation,
  type ConnectionSummary,
} from "@/lib/connections";
import type { ConnectionTypeCatalogItem } from "@/lib/studio-catalog";

type ManagerMode = "list" | "kind" | "form";

const emptyConfig = (kind: ConnectionKind): Record<string, unknown> => kind === "provider"
  ? { adapter: "gemini", model: DEFAULT_PROVIDER_MODELS.gemini }
  : kind === "tool-service"
    ? { ...FIRECRAWL_CONNECTION_CONFIG }
    : kind === "mcp-http"
      ? { url: "", oauth: true }
      : kind === "http-api"
        ? { url: "" }
        : kind === "local-runtime"
          ? { sandbox: "container", runtime: "node", image: DEFAULT_SANDBOX_IMAGES.node, network: "none" }
          : { sandbox: "container", image: "", command: "", args: [], network: "none" };

const statusLabel = (status: ConnectionSummary["status"]) => ({
  unknown: "Not tested",
  connected: "Connected",
  needs_auth: "Needs authentication",
  expired: "Credentials expired",
  insufficient_scope: "Needs more scope",
  revocation_pending: "Revocation pending",
  disconnected: "Disconnected",
  error: "Error",
})[status];

const requestError = async (response: Response) => {
  const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  return payload?.error?.message ?? `Request failed with ${response.status}`;
};

function ConnectionForm({
  connection,
  requestedId,
  kind,
  definition,
  busy,
  onCancel,
  onSaved,
}: {
  connection?: ConnectionSummary;
  requestedId?: string;
  kind: ConnectionKind;
  definition: ConnectionTypeCatalogItem;
  busy: boolean;
  onCancel: () => void;
  onSaved: (input: ConnectionMutation) => Promise<void>;
}) {
  const [name, setName] = useState(connection?.name ?? definition.label);
  const [scope, setScope] = useState<"project" | "user">(connection?.scope ?? "project");
  const [config, setConfig] = useState<Record<string, unknown>>(() => {
    const saved = { ...emptyConfig(kind), ...(connection?.config ?? {}) };
    if (kind === "provider" && !saved.adapter && typeof saved.provider === "string") saved.adapter = saved.provider;
    return saved;
  });
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const firstField = useRef<HTMLInputElement>(null);

  useEffect(() => firstField.current?.focus(), []);

  const update = (key: string, value: unknown) => setConfig((current) => ({ ...current, [key]: value }));
  const builtinAdapter = ["gemini", "openai", "anthropic", "ollama"].includes(String(config.adapter ?? ""));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void onSaved({
      ...((connection?.id ?? requestedId) ? { id: connection?.id ?? requestedId } : {}),
      name,
      kind,
      scope,
      config,
      secrets,
    });
  };

  return (
    <form className="connection-form" onSubmit={submit}>
      <div className="sheet-section-heading"><span>{connection ? "Edit connection" : "Connection settings"}</span><small>{definition.label}</small></div>
      <div className="field-grid">
        {requestedId && !connection && <div className="source-review"><span>Required Connection id</span><code>{requestedId}</code><p>This immutable id comes from the Skill requirement and will be wired automatically.</p></div>}
        <div className="field"><label htmlFor="connection-name">Name</label><input ref={firstField} id="connection-name" required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></div>
        <div className="field"><label htmlFor="connection-scope">Scope</label><select id="connection-scope" disabled={Boolean(connection)} value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}><option value="project">This project</option><option value="user">All local projects</option></select><span className="field-help">Project connections stay beside this harness. User connections can be reused locally.</span></div>
        {kind === "provider" && <>
          <div className="field"><label htmlFor="connection-adapter">Model service</label><select id="connection-adapter" required value={builtinAdapter ? String(config.adapter) : "registered"} onChange={(event) => {
            const adapter = event.target.value === "registered" ? "" : event.target.value;
            setConfig({
              adapter,
              model: DEFAULT_PROVIDER_MODELS[adapter as keyof typeof DEFAULT_PROVIDER_MODELS] ?? "",
              ...(adapter === "ollama" ? { baseUrl: "http://127.0.0.1:11434" } : {}),
            });
          }}><option value="gemini">Google AI Studio</option><option value="openai">OpenAI / OpenAI-compatible</option><option value="anthropic">Anthropic</option><option value="ollama">Ollama</option><option value="registered">Registered custom adapter</option></select></div>
          {!builtinAdapter && <div className="field"><label htmlFor="connection-custom-adapter">Adapter id</label><input id="connection-custom-adapter" required placeholder="my-provider" value={String(config.adapter ?? "")} onChange={(event) => update("adapter", event.target.value)} /><span className="field-help">Any adapter registered by this harness runtime can use the same Connection flow.</span></div>}
          <div className="field"><label htmlFor="connection-model">Default model</label><input id="connection-model" required placeholder="gpt-5-mini" value={String(config.model ?? "")} onChange={(event) => update("model", event.target.value)} /><span className="field-help">The Model component can override this, but one model id is required here.</span></div>
          <div className="field"><label htmlFor="connection-provider-url">Custom endpoint <span className="field-optional">optional</span></label><input id="connection-provider-url" type="url" placeholder="https://api.example.com/v1" value={String(config.baseUrl ?? "")} onChange={(event) => setConfig((current) => {
            const next = { ...current };
            if (event.target.value) next.baseUrl = event.target.value;
            else delete next.baseUrl;
            return next;
          })} /><span className="field-help">Use any endpoint compatible with the selected adapter. Credentials remain write-only.</span></div>
        </>}
        {kind === "tool-service" && <>
          <div className="field"><label htmlFor="connection-connector">Search service</label><select id="connection-connector" value={String(config.connector ?? "firecrawl")} onChange={(event) => {
            const connector = event.target.value;
            setConfig(connector === "firecrawl"
              ? { ...FIRECRAWL_CONNECTION_CONFIG }
              : connector === "searxng"
                ? { ...SEARXNG_CONNECTION_CONFIG }
                : {
                  connector, url: "", authScheme: "none", method: "POST", requestEncoding: "json",
                  queryParameter: "query", limitParameter: "limit", responseItemsPath: "/results",
                  titleField: "title", urlField: "url", snippetField: "snippet", contentField: "content",
                });
          }}><option value="firecrawl">Firecrawl</option><option value="searxng">SearXNG</option><option value="custom-search">Custom Search API</option></select><span className="field-help">All choices expose the same Web Search tool contract to the harness.</span></div>
          <div className="field"><label htmlFor="connection-url">Search endpoint URL</label><input id="connection-url" type="url" required placeholder={config.connector === "searxng" ? "https://search.example.com/search" : "https://api.example.com/search"} value={String(config.url ?? "")} onChange={(event) => update("url", event.target.value)} /></div>
          {config.connector === "custom-search" && <>
            <div className="field"><label htmlFor="connection-search-method">Request method</label><select id="connection-search-method" value={String(config.method ?? "POST")} onChange={(event) => update("method", event.target.value)}><option>POST</option><option>GET</option></select></div>
            <div className="field"><label htmlFor="connection-query-param">Query field</label><input id="connection-query-param" required value={String(config.queryParameter ?? "query")} onChange={(event) => update("queryParameter", event.target.value)} /></div>
            <div className="field"><label htmlFor="connection-limit-param">Limit field</label><input id="connection-limit-param" required value={String(config.limitParameter ?? "limit")} onChange={(event) => update("limitParameter", event.target.value)} /><span className="field-help">The response must be JSON with <code>results[]</code>; each result needs <code>title</code> and <code>url</code>.</span></div>
          </>}
          {config.connector !== "firecrawl" && <div className="field"><label htmlFor="connection-search-auth">Authentication</label><select id="connection-search-auth" value={String(config.authScheme ?? "none")} onChange={(event) => update("authScheme", event.target.value)}><option value="none">None</option><option value="bearer">Bearer token</option></select></div>}
        </>}
        {(kind === "mcp-http" || kind === "http-api") && (
          <div className="field"><label htmlFor="connection-url">Server URL</label><input id="connection-url" type="url" required placeholder="https://…" value={String(config.url ?? "")} onChange={(event) => update("url", event.target.value)} /></div>
        )}
        {kind === "mcp-http" && <div className="field"><label htmlFor="connection-mcp-auth">Authentication</label><select id="connection-mcp-auth" value={config.oauth === true ? "oauth" : "token"} onChange={(event) => update("oauth", event.target.value === "oauth")}><option value="oauth">OAuth in browser · auto-discover</option><option value="token">Bearer token</option></select></div>}
        {kind === "local-runtime" && <>
          <div className="field"><label htmlFor="connection-runtime">Code runtime</label><select id="connection-runtime" value={String(config.runtime ?? "node")} onChange={(event) => setConfig((current) => ({ ...current, runtime: event.target.value, image: DEFAULT_SANDBOX_IMAGES[event.target.value as keyof typeof DEFAULT_SANDBOX_IMAGES] }))}><option value="node">Node.js</option><option value="python">Python</option></select></div>
          <div className="field"><label htmlFor="connection-image">Sandbox image</label><input id="connection-image" required value={String(config.image ?? "")} onChange={(event) => update("image", event.target.value)} /><span className="field-help">Docker or Podman is detected automatically. Connect downloads this image once and runs code with no network or project mount.</span></div>
        </>}
        {kind === "mcp-stdio" && <>
          <div className="field"><label htmlFor="connection-image">MCP container image</label><input id="connection-image" required placeholder="ghcr.io/owner/mcp-server:version" value={String(config.image ?? "")} onChange={(event) => update("image", event.target.value)} /><span className="field-help">Use an image that already contains the MCP server. Docker or Podman is detected automatically.</span></div>
          <div className="field"><label htmlFor="connection-command">Command in image</label><input id="connection-command" required placeholder="node" value={String(config.command ?? "")} onChange={(event) => update("command", event.target.value)} /></div>
          <div className="field"><label htmlFor="connection-args">Arguments</label><input id="connection-args" placeholder="server.js --stdio" value={Array.isArray(config.args) ? config.args.join(" ") : ""} onChange={(event) => update("args", event.target.value.split(/\s+/).filter(Boolean))} /></div>
        </>}
        {definition.secretFields.filter((field) => !(field.id === "token"
          && ((kind === "mcp-http" && config.oauth === true)
            || (kind === "tool-service" && config.connector !== "firecrawl" && config.authScheme !== "bearer")))).map((field) => (
          <div className="field" key={field.id}>
            <label htmlFor={`connection-secret-${field.id}`}>{kind === "tool-service" && config.connector === "firecrawl" ? "Firecrawl API key" : field.label}</label>
            <input
              id={`connection-secret-${field.id}`}
              type="password"
              autoComplete="new-password"
              placeholder={connection?.credentialPresence[field.id] ? "Saved — leave blank to keep" : "Enter credential"}
              value={secrets[field.id] ?? ""}
              onChange={(event) => setSecrets((current) => ({ ...current, [field.id]: event.target.value }))}
            />
            <span className="field-help">Write-only. Harnest never returns this value to the browser.</span>
          </div>
        ))}
        <details className="advanced-panel">
          <summary>Advanced</summary>
          <div className="field"><label htmlFor="connection-timeout">Timeout (ms)</label><input id="connection-timeout" type="number" min={100} max={600000} value={String(config.timeoutMs ?? "30000")} onChange={(event) => update("timeoutMs", Number(event.target.value))} /></div>
          {kind === "tool-service" && config.connector === "custom-search" && <>
            <div className="field"><label htmlFor="connection-response-path">Results JSON Pointer</label><input id="connection-response-path" required placeholder="/results" value={String(config.responseItemsPath ?? "/results")} onChange={(event) => update("responseItemsPath", event.target.value)} /></div>
            <div className="field"><label htmlFor="connection-title-field">Title field</label><input id="connection-title-field" required value={String(config.titleField ?? "title")} onChange={(event) => update("titleField", event.target.value)} /></div>
            <div className="field"><label htmlFor="connection-url-field">URL field</label><input id="connection-url-field" required value={String(config.urlField ?? "url")} onChange={(event) => update("urlField", event.target.value)} /></div>
            <div className="field"><label htmlFor="connection-snippet-field">Snippet field</label><input id="connection-snippet-field" value={String(config.snippetField ?? "snippet")} onChange={(event) => update("snippetField", event.target.value)} /></div>
            <div className="field"><label htmlFor="connection-scrape-url">Page extraction endpoint <span className="field-optional">optional</span></label><input id="connection-scrape-url" type="url" value={String(config.scrapeUrl ?? "")} onChange={(event) => setConfig((current) => { const next = { ...current }; if (event.target.value) next.scrapeUrl = event.target.value; else delete next.scrapeUrl; return next; })} /><span className="field-help">If set, this Connection also exposes Web Scrape. POST JSON must accept a <code>url</code> field.</span></div>
            {Boolean(config.scrapeUrl) && <div className="field"><label htmlFor="connection-scrape-content">Extracted text JSON Pointer</label><input id="connection-scrape-content" value={String(config.scrapeContentPath ?? "/data/markdown")} onChange={(event) => update("scrapeContentPath", event.target.value)} /></div>}
          </>}
        </details>
      </div>
      <div className="sheet-actions"><button type="button" className="button" disabled={busy} onClick={onCancel}>Back</button><button className="button button-primary" disabled={busy}>{busy ? "Connecting…" : connection ? "Save & test" : "Connect"}</button></div>
    </form>
  );
}

export function ConnectionManager({
  open,
  connections,
  definitions,
  requestedKind,
  requestedId,
  onClose,
  onChanged,
  onComplete,
}: {
  open: boolean;
  connections: readonly ConnectionSummary[];
  definitions: readonly ConnectionTypeCatalogItem[];
  requestedKind?: ConnectionKind;
  requestedId?: string;
  onClose: () => void;
  onChanged: (connections: ConnectionSummary[]) => void;
  onComplete?: (connection: ConnectionSummary) => void;
}) {
  const [mode, setMode] = useState<ManagerMode>("list");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<ConnectionKind>(requestedKind ?? "provider");
  const [editing, setEditing] = useState<ConnectionSummary>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [deleteId, setDeleteId] = useState("");
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const requested = requestedId ? connections.find((connection) => connection.id === requestedId) : undefined;
    setKind(requested?.kind ?? requestedKind ?? "provider");
    setMode(requestedKind && !requested ? "form" : "list");
    setEditing(requested);
    setMessage("");
    queueMicrotask(() => search.current?.focus());
  }, [connections, open, requestedId, requestedKind]);

  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [busy, onClose, open]);

  useEffect(() => {
    if (!open) return;
    const receiveOAuth = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || !event.data || typeof event.data !== "object"
        || (event.data as { type?: unknown }).type !== "harnest-oauth-complete") return;
      const id = (event.data as { id?: unknown }).id;
      if (typeof id !== "string" || (event.data as { ok?: unknown }).ok !== true) {
        setMessage("OAuth authorization was not completed.");
        return;
      }
      setBusy(true);
      void fetch("/api/connections/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, action: "discover" }),
      }).then(async (response) => {
        if (!response.ok) throw new Error(await requestError(response));
        return response.json() as Promise<ConnectionActionResult>;
      }).then((result) => fetch("/api/connections").then(async (response) => {
        if (!response.ok) throw new Error(await requestError(response));
        const payload = await response.json() as { connections: ConnectionSummary[] };
        onChanged(payload.connections);
        setMessage(result.message);
        onComplete?.(result.connection);
      })).catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : "MCP Tool discovery failed after OAuth.");
      }).finally(() => setBusy(false));
    };
    window.addEventListener("message", receiveOAuth);
    return () => window.removeEventListener("message", receiveOAuth);
  }, [onChanged, onComplete, open]);

  const visible = useMemo(() => {
    const value = query.trim().toLocaleLowerCase();
    return connections.filter((connection) => (!requestedId || connection.id === requestedId) && (!value
      || `${connection.name} ${connection.kind} ${connection.scope} ${connection.status}`.toLocaleLowerCase().includes(value)));
  }, [connections, query, requestedId]);

  if (!open) return null;
  const definition = definitions.find((item) => item.id === kind) ?? definitions[0];
  if (!definition) return null;

  const replace = (connection: ConnectionSummary) => onChanged([
    ...connections.filter((item) => item.id !== connection.id),
    connection,
  ].sort((left, right) => left.name.localeCompare(right.name)));

  const save = async (input: ConnectionMutation) => {
    const oauthPopup = input.kind === "mcp-http" && input.config?.oauth === true
      ? window.open("about:blank", "harnest-oauth", "popup,width=560,height=760")
      : null;
    setBusy(true);
    setMessage("");
    let saved: ConnectionSummary | undefined;
    try {
      const response = await fetch("/api/connections", {
        method: editing ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!response.ok) throw new Error(await requestError(response));
      const payload = await response.json() as { connection: ConnectionSummary };
      saved = payload.connection;
      replace(saved);
      let connected = saved;
      const actionValue: ConnectionAction = connected.kind === "mcp-http" && connected.config.oauth === true
        ? "reauth"
        : connected.kind === "mcp-http" ? "discover"
          : connected.kind === "mcp-stdio" || connected.kind === "local-runtime" ? "approve-process" : "test";
      const tested = await fetch("/api/connections/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: connected.id, action: actionValue }),
      });
      if (!tested.ok) throw new Error(await requestError(tested));
      const result = await tested.json() as ConnectionActionResult;
      connected = result.connection;
      setMessage(result.message);
      replace(connected);
      if (!connectionCanRun(connected) && !result.authorizationUrl) {
        oauthPopup?.close();
        setEditing(connected);
        setKind(connected.kind);
        setMode("form");
        return;
      }
      if (result.authorizationUrl) {
        if (oauthPopup) oauthPopup.location.href = result.authorizationUrl;
        else window.open(result.authorizationUrl, "harnest-oauth", "popup,width=560,height=760");
      } else oauthPopup?.close();
      setMode("list");
      setEditing(undefined);
      if (!(connected.kind === "mcp-http" && connected.config.oauth === true)) onComplete?.(connected);
    } catch (error) {
      oauthPopup?.close();
      if (saved) setEditing(saved);
      setMessage(error instanceof Error ? error.message : "Connection could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const action = async (connection: ConnectionSummary, value: ConnectionAction) => {
    const oauthPopup = value === "reauth" && connection.kind === "mcp-http" && connection.config.oauth === true
      ? window.open("about:blank", "harnest-oauth", "popup,width=560,height=760")
      : null;
    setBusy(true);
    setMessage(`${value === "test" ? "Testing" : "Updating"} ${connection.name}…`);
    try {
      const response = await fetch("/api/connections/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: connection.id, action: value }),
      });
      if (!response.ok) throw new Error(await requestError(response));
      const result = await response.json() as ConnectionActionResult;
      replace(result.connection);
      setMessage(result.message);
      if (value === "reauth" && !result.authorizationUrl) {
        setEditing(result.connection);
        setKind(result.connection.kind);
        setMode("form");
      }
      if (result.authorizationUrl) {
        if (oauthPopup) oauthPopup.location.href = result.authorizationUrl;
        else window.open(result.authorizationUrl, "harnest-oauth", "popup,width=560,height=760");
      } else oauthPopup?.close();
      if (["test", "discover", "approve-process"].includes(value) && connectionCanRun(result.connection)) {
        onComplete?.(result.connection);
      }
    } catch (error) {
      oauthPopup?.close();
      setMessage(error instanceof Error ? error.message : "Connection action failed.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (connection: ConnectionSummary) => {
    setBusy(true);
    try {
      const response = await fetch("/api/connections", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: connection.id }),
      });
      if (!response.ok) throw new Error(await requestError(response));
      onChanged(connections.filter((item) => item.id !== connection.id));
      setDeleteId("");
      setMessage(`${connection.name} deleted.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Connection could not be deleted.");
    } finally {
      setBusy(false);
    }
  };

  const primary = (connection: ConnectionSummary): { label: string; action?: ConnectionAction } => {
    if (onComplete && connectionCanRun(connection)) return { label: "Use connection" };
    if (["needs_auth", "expired", "insufficient_scope", "disconnected"].includes(connection.status)) {
      return { label: "Reconnect", action: "reauth" };
    }
    if ((connection.kind === "mcp-stdio" || connection.kind === "local-runtime") && connection.status === "error") {
      return { label: "Repair sandbox", action: "approve-process" };
    }
    if (connection.kind === "mcp-http" || connection.kind === "mcp-stdio") return { label: "Refresh tools", action: "discover" };
    return { label: "Test connection", action: "test" };
  };

  return (
    <div className="sheet-backdrop">
      <section className="connection-sheet" role="dialog" aria-modal="true" aria-labelledby="connection-sheet-title">
        <header className="sheet-header"><div><span className="sheet-eyebrow">Connect once · reuse anywhere</span><h2 id="connection-sheet-title">Connections</h2></div><button className="sheet-close" aria-label="Close connections" disabled={busy} onClick={onClose}>×</button></header>
        {message && <div className="sheet-message" role="status">{message}</div>}
        {mode === "kind" && <div className="connection-kind-grid">
          {definitions.map((item) => <button key={item.id} className="connection-kind" onClick={() => { setKind(item.id); setMode("form"); }}><strong>{item.label}</strong><span>{item.description}</span></button>)}
          <button className="button" onClick={() => setMode("list")}>Back</button>
        </div>}
        {mode === "form" && <ConnectionForm connection={editing} requestedId={requestedId} kind={kind} definition={definition} busy={busy} onCancel={() => { setEditing(undefined); setMode("list"); }} onSaved={save} />}
        {mode === "list" && <>
          <div className="connection-toolbar"><label className="sr-only" htmlFor="connection-search">Search connections</label><input ref={search} id="connection-search" type="search" placeholder="Search connections" value={query} onChange={(event) => setQuery(event.target.value)} /><button className="button button-primary" onClick={() => setMode("kind")}>New connection</button></div>
          <div className="connection-list">
            {visible.length ? visible.map((connection) => {
              const main = primary(connection);
              return <article key={connection.id} className="connection-card">
              <div className="connection-card-heading"><span className={`connection-status is-${connection.status}`} aria-label={statusLabel(connection.status)} /><div><strong>{connection.name}</strong><small>{connectionKindLabel(connection.kind)} · {connection.scope}</small></div><span className="connection-status-copy">{statusLabel(connection.status)}</span></div>
              {connection.error && <p className="connection-error">{connection.error.message}</p>}
              <div className="connection-card-actions">
                <button className="button button-primary" disabled={busy} onClick={() => main.action ? void action(connection, main.action) : onComplete?.(connection)}>{main.label}</button>
                <button className="button" disabled={busy} onClick={() => { setEditing(connection); setKind(connection.kind); setMode("form"); }}>Edit</button>
              </div>
              <details className="advanced-panel"><summary>More</summary><div className="connection-card-actions">
                {main.action !== "test" && <button className="button" disabled={busy} onClick={() => void action(connection, "test")}>Test</button>}
                {(connection.kind === "mcp-http" || connection.kind === "mcp-stdio") && main.action !== "discover" && <button className="button" disabled={busy} onClick={() => void action(connection, "discover")}>Refresh tools</button>}
                {(connection.kind === "mcp-stdio" || connection.kind === "local-runtime") && <button className="button" disabled={busy} onClick={() => void action(connection, "approve-process")}>Review sandbox</button>}
                {main.action !== "reauth" && <button className="button" disabled={busy} onClick={() => void action(connection, "reauth")}>Reconnect</button>}
                <button className="button" disabled={busy || connection.status === "disconnected"} onClick={() => void action(connection, "disconnect")}>Disconnect</button>
                {connection.kind === "mcp-http" && connection.config.oauth === true && <button className="button" disabled={busy} onClick={() => void action(connection, "revoke")}>Revoke OAuth</button>}
                {deleteId === connection.id
                  ? <><button className="button button-danger" disabled={busy} onClick={() => void remove(connection)}>Confirm delete</button><button className="button" onClick={() => setDeleteId("")}>Cancel</button></>
                  : <button className="button" disabled={busy} onClick={() => setDeleteId(connection.id)}>Delete</button>}
              </div></details>
            </article>;
            }) : <div className="connection-empty"><strong>{connections.length ? "No connections match" : "No connections yet"}</strong><span>Pick a service, sign in or add its key, and Harnest will test and wire it for you.</span></div>}
          </div>
        </>}
      </section>
    </div>
  );
}
