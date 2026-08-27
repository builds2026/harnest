"use client";

import { Dialog } from "@base-ui/react/dialog";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  DEFAULT_PROVIDER_MODELS,
  DEFAULT_SANDBOX_IMAGES,
  FIRECRAWL_CONNECTION_CONFIG,
  SEARXNG_CONNECTION_CONFIG,
} from "@harnestai/core/browser";
import {
  connectionCanRun,
  connectionDetails,
  connectionOperationForAction,
  type ConnectionAction,
  type ConnectionActionResult,
  type ConnectionKind,
  type ConnectionMutation,
  type ConnectionOperationPhase,
  type ConnectionSummary,
} from "@/lib/connections";
import type { ConnectionTypeCatalogItem } from "@/lib/studio-catalog";
import { ClientApiError, apiErrorMessage, requestJson } from "@/lib/api-client";
import type { ApiErrorDetails } from "@/lib/api";
import type { Translator } from "@/i18n/core";
import type { MessageKey } from "@/i18n/messages/en-US";
import { useI18n } from "./i18n-provider";
import { ArgumentList } from "./argument-list";
import { Button, EmptyState, InlineNotice } from "./ui/ui";

type ManagerMode = "list" | "kind" | "form";

const emptyConfig = (kind: ConnectionKind): Record<string, unknown> => kind === "provider"
  ? { adapter: "gemini", model: DEFAULT_PROVIDER_MODELS.gemini }
  : kind === "tool-service"
    ? { ...FIRECRAWL_CONNECTION_CONFIG }
    : kind === "mcp-http"
      ? { url: "", oauth: true, authentication: "oauth" }
      : kind === "http-api"
        ? { url: "" }
        : kind === "local-runtime"
          ? { sandbox: "container", runtime: "node", image: DEFAULT_SANDBOX_IMAGES.node, network: "none" }
          : { sandbox: "container", image: "", command: "", args: [], network: "none" };

const OPERATION_KEYS: Readonly<Record<Exclude<ConnectionOperationPhase, "idle">, MessageKey>> = {
  saving: "connections.operation.saving",
  authorizing: "connections.operation.authorizing",
  testing: "connections.operation.testing",
  discovering: "connections.operation.discovering",
  approving: "connections.operation.approving",
  retrying: "connections.operation.retrying",
};

const KIND_LABEL_KEYS: Readonly<Record<ConnectionKind, MessageKey>> = {
  provider: "connections.kind.provider",
  "mcp-http": "connections.kind.mcp-http",
  "mcp-stdio": "connections.kind.mcp-stdio",
  "http-api": "connections.kind.http-api",
  "tool-service": "connections.kind.tool-service",
  "local-runtime": "connections.kind.local-runtime",
};

const KIND_DESCRIPTION_KEYS: Readonly<Record<ConnectionKind, MessageKey>> = {
  provider: "connections.kind.provider.description",
  "mcp-http": "connections.kind.mcp-http.description",
  "mcp-stdio": "connections.kind.mcp-stdio.description",
  "http-api": "connections.kind.http-api.description",
  "tool-service": "connections.kind.tool-service.description",
  "local-runtime": "connections.kind.local-runtime.description",
};

type PresentedApiError = ApiErrorDetails & { readonly technicalMessage?: string };

const errorDetails = (error: unknown, fallback: string, t: Translator): PresentedApiError => error instanceof ClientApiError
  ? { ...error.details, technicalMessage: error.details.message, message: apiErrorMessage(error, fallback, t) }
  : { code: "REQUEST_FAILED", message: apiErrorMessage(error, fallback, t), category: "server", recoverable: true, action: "retry" };

function ConnectionForm({
  connection,
  requestedId,
  kind,
  definition,
  operation,
  onCancel,
  onCancelOperation,
  onSaved,
}: {
  connection?: ConnectionSummary;
  requestedId?: string;
  kind: ConnectionKind;
  definition: ConnectionTypeCatalogItem;
  operation?: ConnectionOperationPhase;
  onCancel: () => void;
  onCancelOperation: () => void;
  onSaved: (input: ConnectionMutation) => Promise<void>;
}) {
  const { t } = useI18n();
  const busy = Boolean(operation && operation !== "idle");
  const [name, setName] = useState(connection?.name ?? t(KIND_LABEL_KEYS[kind]));
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
  const updateOptionalNumber = (key: string, value: string) => setConfig((current) => {
    const next = { ...current };
    if (value === "") delete next[key]; else next[key] = Number(value);
    return next;
  });
  const builtinAdapter = ["gemini", "openai", "anthropic", "ollama"].includes(String(config.adapter ?? ""));
  const mcpAuthentication = ["oauth", "token", "none"].includes(String(config.authentication))
    ? String(config.authentication)
    : config.oauth === true ? "oauth" : connection?.credentialPresence.token ? "token" : "none";
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
      <div className="sheet-section-heading"><span>{connection ? t("connections.form.edit") : t("connections.form.settings")}</span><small>{t(KIND_LABEL_KEYS[kind])}</small></div>
      <div className="field-grid">
        {requestedId && !connection && <div className="source-review"><span>{t("connections.form.requiredId")}</span><code>{requestedId}</code><p>{t("connections.form.requiredIdHelp")}</p></div>}
        <div className="field"><label htmlFor="connection-name">{t("connections.form.name")}</label><input ref={firstField} id="connection-name" required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></div>
        <div className="field"><label htmlFor="connection-scope">{t("connections.form.scope")}</label><select id="connection-scope" disabled={Boolean(connection)} value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}><option value="project">{t("connections.form.scope.project")}</option><option value="user">{t("connections.form.scope.user")}</option></select><span className="field-help">{t("connections.form.scopeHelp")}</span></div>
        {kind === "provider" && <>
          <div className="field"><label htmlFor="connection-adapter">{t("connections.form.modelService")}</label><select id="connection-adapter" required value={builtinAdapter ? String(config.adapter) : "registered"} onChange={(event) => {
            const adapter = event.target.value === "registered" ? "" : event.target.value;
            setConfig({
              adapter,
              model: DEFAULT_PROVIDER_MODELS[adapter as keyof typeof DEFAULT_PROVIDER_MODELS] ?? "",
              ...(adapter === "ollama" ? { baseUrl: "http://127.0.0.1:11434" } : {}),
            });
          }}><option value="gemini">Google AI Studio</option><option value="openai">OpenAI / OpenAI-compatible</option><option value="anthropic">Anthropic</option><option value="ollama">Ollama</option><option value="registered">{t("connections.form.registeredAdapter")}</option></select></div>
          {!builtinAdapter && <div className="field"><label htmlFor="connection-custom-adapter">{t("connections.form.adapterId")}</label><input id="connection-custom-adapter" required placeholder="my-provider" value={String(config.adapter ?? "")} onChange={(event) => update("adapter", event.target.value)} /><span className="field-help">{t("connections.form.adapterHelp")}</span></div>}
          <div className="field"><label htmlFor="connection-model">{t("connections.form.defaultModel")}</label><input id="connection-model" required placeholder="gpt-5-mini" value={String(config.model ?? "")} onChange={(event) => update("model", event.target.value)} /><span className="field-help">{t("connections.form.modelHelp")}</span></div>
          <div className="field"><label htmlFor="connection-provider-url">{t("connections.form.customEndpoint")} <span className="field-optional">{t("connections.form.optional")}</span></label><input id="connection-provider-url" type="url" placeholder="https://api.example.com/v1" value={String(config.baseUrl ?? "")} onChange={(event) => setConfig((current) => {
            const next = { ...current };
            if (event.target.value) next.baseUrl = event.target.value;
            else delete next.baseUrl;
            return next;
          })} /><span className="field-help">{t("connections.form.endpointHelp")}</span></div>
          <details className="advanced-panel"><summary>{t("connections.form.cacheAdvanced")}</summary><div className="field-grid">
            <div className="field"><label htmlFor="connection-context-window">{t("connections.form.contextWindow")}</label><input id="connection-context-window" type="number" min={1} value={typeof config.contextWindowTokens === "number" ? config.contextWindowTokens : ""} onChange={(event) => updateOptionalNumber("contextWindowTokens", event.target.value)} /></div>
            <div className="field"><label htmlFor="connection-cache-dialect">{t("connections.form.cacheDialect")}</label><select id="connection-cache-dialect" value={String(config.cacheDialect ?? "auto")} onChange={(event) => update("cacheDialect", event.target.value)}><option value="auto">{t("connections.form.cacheAuto")}</option><option value="native">{t("connections.form.cacheNative")}</option><option value="none">{t("connections.form.cacheNone")}</option></select></div>
            <div className="field"><label htmlFor="connection-input-price">{t("field.inputCostPerMillion")}</label><input id="connection-input-price" type="number" min={0} step="any" value={typeof config.inputCostPerMillion === "number" ? config.inputCostPerMillion : ""} onChange={(event) => updateOptionalNumber("inputCostPerMillion", event.target.value)} /></div>
            <div className="field"><label htmlFor="connection-output-price">{t("field.outputCostPerMillion")}</label><input id="connection-output-price" type="number" min={0} step="any" value={typeof config.outputCostPerMillion === "number" ? config.outputCostPerMillion : ""} onChange={(event) => updateOptionalNumber("outputCostPerMillion", event.target.value)} /></div>
            <div className="field"><label htmlFor="connection-cached-price">{t("connections.form.cachedInputPrice")}</label><input id="connection-cached-price" type="number" min={0} step="any" value={typeof config.cachedInputCostPerMillion === "number" ? config.cachedInputCostPerMillion : ""} onChange={(event) => updateOptionalNumber("cachedInputCostPerMillion", event.target.value)} /></div>
            <div className="field"><label htmlFor="connection-cache-write-price">{t("connections.form.cacheWritePrice")}</label><input id="connection-cache-write-price" type="number" min={0} step="any" value={typeof config.cacheWriteCostPerMillion === "number" ? config.cacheWriteCostPerMillion : ""} onChange={(event) => updateOptionalNumber("cacheWriteCostPerMillion", event.target.value)} /></div>
            <div className="field"><label htmlFor="connection-cache-storage-price">{t("connections.form.cacheStoragePrice")}</label><input id="connection-cache-storage-price" type="number" min={0} step="any" value={typeof config.cacheStorageCostPerMillionHour === "number" ? config.cacheStorageCostPerMillionHour : ""} onChange={(event) => updateOptionalNumber("cacheStorageCostPerMillionHour", event.target.value)} /></div>
          </div></details>
        </>}
        {kind === "tool-service" && <>
          <div className="field"><label htmlFor="connection-connector">{t("connections.form.searchService")}</label><select id="connection-connector" value={String(config.connector ?? "firecrawl")} onChange={(event) => {
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
          }}><option value="firecrawl">Firecrawl</option><option value="searxng">SearXNG</option><option value="custom-search">Custom Search API</option></select><span className="field-help">{t("connections.form.searchHelp")}</span></div>
          <div className="field"><label htmlFor="connection-url">{t("connections.form.searchEndpoint")}</label><input id="connection-url" type="url" required placeholder={config.connector === "searxng" ? "https://search.example.com/search" : "https://api.example.com/search"} value={String(config.url ?? "")} onChange={(event) => update("url", event.target.value)} /></div>
          {config.connector === "custom-search" && <>
            <div className="field"><label htmlFor="connection-search-method">{t("connections.form.requestMethod")}</label><select id="connection-search-method" value={String(config.method ?? "POST")} onChange={(event) => update("method", event.target.value)}><option>POST</option><option>GET</option></select></div>
            <div className="field"><label htmlFor="connection-query-param">{t("connections.form.queryField")}</label><input id="connection-query-param" required value={String(config.queryParameter ?? "query")} onChange={(event) => update("queryParameter", event.target.value)} /></div>
            <div className="field"><label htmlFor="connection-limit-param">{t("connections.form.limitField")}</label><input id="connection-limit-param" required value={String(config.limitParameter ?? "limit")} onChange={(event) => update("limitParameter", event.target.value)} /><span className="field-help">{t("connections.form.responseHelp")}</span></div>
          </>}
          {config.connector !== "firecrawl" && <div className="field"><label htmlFor="connection-search-auth">{t("connections.form.authentication")}</label><select id="connection-search-auth" value={String(config.authScheme ?? "none")} onChange={(event) => update("authScheme", event.target.value)}><option value="none">{t("connections.form.none")}</option><option value="bearer">{t("connections.form.bearer")}</option></select></div>}
        </>}
        {(kind === "mcp-http" || kind === "http-api") && (
          <div className="field"><label htmlFor="connection-url">{t("connections.form.serverUrl")}</label><input id="connection-url" type="url" required placeholder="https://…" value={String(config.url ?? "")} onChange={(event) => update("url", event.target.value)} /></div>
        )}
        {kind === "mcp-http" && <div className="field"><label htmlFor="connection-mcp-auth">{t("connections.form.signInMethod")}</label><select id="connection-mcp-auth" value={mcpAuthentication} onChange={(event) => setConfig((current) => ({ ...current, authentication: event.target.value, oauth: event.target.value === "oauth" }))}><option value="oauth">{t("connections.form.browserSignIn")}</option><option value="token">{t("connections.form.bearer")}</option><option value="none">{t("connections.form.none")}</option></select><span className="field-help">{t(mcpAuthentication === "none" ? "connections.form.noneHelp" : "connections.form.oauthHelp")}</span></div>}
        {kind === "local-runtime" && <>
          <div className="field"><label htmlFor="connection-runtime">{t("connections.form.codeRuntime")}</label><select id="connection-runtime" value={String(config.runtime ?? "node")} onChange={(event) => setConfig((current) => ({ ...current, runtime: event.target.value, image: DEFAULT_SANDBOX_IMAGES[event.target.value as keyof typeof DEFAULT_SANDBOX_IMAGES] }))}><option value="node">Node.js</option><option value="python">Python</option></select></div>
          <div className="field"><label htmlFor="connection-image">{t("connections.form.sandboxImage")}</label><input id="connection-image" required value={String(config.image ?? "")} onChange={(event) => update("image", event.target.value)} /><span className="field-help">{t("connections.form.sandboxHelp")}</span></div>
        </>}
        {kind === "mcp-stdio" && <>
          <div className="field"><label htmlFor="connection-image">{t("connections.form.mcpImage")}</label><input id="connection-image" required placeholder="ghcr.io/owner/mcp-server:version" value={String(config.image ?? "")} onChange={(event) => update("image", event.target.value)} /><span className="field-help">{t("connections.form.mcpImageHelp")}</span></div>
          <div className="field"><label htmlFor="connection-command">{t("connections.form.command")}</label><input id="connection-command" required placeholder="node" value={String(config.command ?? "")} onChange={(event) => update("command", event.target.value)} /></div>
          <ArgumentList id="connection-args" label={t("connections.form.arguments")} args={Array.isArray(config.args) ? config.args.filter((value): value is string => typeof value === "string") : []} addLabel={t("common.addArgument")} removeLabel={t("common.removeArgument")} disabled={busy} onChange={(args) => update("args", args)} />
        </>}
        {definition.secretFields.filter((field) => !(field.id === "token"
          && ((kind === "mcp-http" && mcpAuthentication !== "token")
            || (kind === "tool-service" && config.connector !== "firecrawl" && config.authScheme !== "bearer")))).map((field) => (
          <div className="field" key={field.id}>
            <label htmlFor={`connection-secret-${field.id}`}>{kind === "tool-service" && config.connector === "firecrawl" ? "Firecrawl API key" : field.label}</label>
            <input
              id={`connection-secret-${field.id}`}
              type="password"
              required={kind === "mcp-http" && mcpAuthentication === "token" && !connection?.credentialPresence[field.id]}
              autoComplete="new-password"
              placeholder={connection?.credentialPresence[field.id] ? t("connections.form.credentialSaved") : t("connections.form.credentialEnter")}
              value={secrets[field.id] ?? ""}
              onChange={(event) => setSecrets((current) => ({ ...current, [field.id]: event.target.value }))}
            />
            <span className="field-help">{t("connections.form.writeOnly")}</span>
          </div>
        ))}
        <details className="advanced-panel">
          <summary>{t("common.advanced")}</summary>
          <div className="field"><label htmlFor="connection-timeout">{t("connections.form.timeout")}</label><input id="connection-timeout" type="number" min={100} max={600000} value={String(config.timeoutMs ?? "30000")} onChange={(event) => update("timeoutMs", Number(event.target.value))} /></div>
          {kind === "tool-service" && config.connector === "custom-search" && <>
            <div className="field"><label htmlFor="connection-response-path">{t("connections.form.resultsPointer")}</label><input id="connection-response-path" required placeholder="/results" value={String(config.responseItemsPath ?? "/results")} onChange={(event) => update("responseItemsPath", event.target.value)} /></div>
            <div className="field"><label htmlFor="connection-title-field">{t("connections.form.titleField")}</label><input id="connection-title-field" required value={String(config.titleField ?? "title")} onChange={(event) => update("titleField", event.target.value)} /></div>
            <div className="field"><label htmlFor="connection-url-field">{t("connections.form.urlField")}</label><input id="connection-url-field" required value={String(config.urlField ?? "url")} onChange={(event) => update("urlField", event.target.value)} /></div>
            <div className="field"><label htmlFor="connection-snippet-field">{t("connections.form.snippetField")}</label><input id="connection-snippet-field" value={String(config.snippetField ?? "snippet")} onChange={(event) => update("snippetField", event.target.value)} /></div>
            <div className="field"><label htmlFor="connection-scrape-url">{t("connections.form.scrapeEndpoint")} <span className="field-optional">{t("connections.form.optional")}</span></label><input id="connection-scrape-url" type="url" value={String(config.scrapeUrl ?? "")} onChange={(event) => setConfig((current) => { const next = { ...current }; if (event.target.value) next.scrapeUrl = event.target.value; else delete next.scrapeUrl; return next; })} /><span className="field-help">{t("connections.form.scrapeHelp")}</span></div>
            {Boolean(config.scrapeUrl) && <div className="field"><label htmlFor="connection-scrape-content">{t("connections.form.scrapeTextPointer")}</label><input id="connection-scrape-content" value={String(config.scrapeContentPath ?? "/data/markdown")} onChange={(event) => update("scrapeContentPath", event.target.value)} /></div>}
          </>}
        </details>
      </div>
      {operation && operation !== "idle" && <InlineNotice title={t(OPERATION_KEYS[operation])} action={<Button size="small" onClick={onCancelOperation}>{t("common.cancel")}</Button>}>{t("connections.permission.help")}</InlineNotice>}
      <div className="sheet-actions"><Button type="button" disabled={busy} onClick={onCancel}>{t("common.back")}</Button><Button variant="primary" loading={busy}>{connection ? t("connections.form.saveAndTest") : t("common.connect")}</Button></div>
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
  const { t, formatRelative } = useI18n();
  const [mode, setMode] = useState<ManagerMode>("list");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<ConnectionKind>(requestedKind ?? "provider");
  const [editing, setEditing] = useState<ConnectionSummary>();
  const [message, setMessage] = useState("");
  const [deleteId, setDeleteId] = useState("");
  const [operations, setOperations] = useState<Readonly<Record<string, ConnectionOperationPhase>>>({});
  const [operationErrors, setOperationErrors] = useState<Readonly<Record<string, PresentedApiError>>>({});
  const search = useRef<HTMLInputElement>(null);
  const controllers = useRef(new Map<string, AbortController>());
  const oauthPopups = useRef(new Map<string, Window>());
  const busy = Object.values(operations).some((phase) => phase !== "idle");
  const formKey = editing?.id ?? requestedId ?? "__new__";

  const setOperation = useCallback((id: string, phase?: ConnectionOperationPhase) => {
    setOperations((current) => {
      const next = { ...current };
      if (!phase || phase === "idle") delete next[id];
      else next[id] = phase;
      return next;
    });
  }, []);

  const setOperationError = useCallback((id: string, error?: PresentedApiError) => {
    setOperationErrors((current) => {
      const next = { ...current };
      if (error) next[id] = error;
      else delete next[id];
      return next;
    });
  }, []);

  const beginOperation = useCallback((id: string, phase: ConnectionOperationPhase) => {
    controllers.current.get(id)?.abort();
    const controller = new AbortController();
    controllers.current.set(id, controller);
    setOperationError(id);
    setOperation(id, phase);
    return controller;
  }, [setOperation, setOperationError]);

  const finishOperation = useCallback((id: string, keepAuthorizing = false) => {
    controllers.current.delete(id);
    if (!keepAuthorizing) setOperation(id);
  }, [setOperation]);

  const cancelOperation = useCallback((id: string) => {
    controllers.current.get(id)?.abort();
    controllers.current.delete(id);
    oauthPopups.current.get(id)?.close();
    oauthPopups.current.delete(id);
    setOperation(id);
    setMessage(t("connections.cancelled", { name: id === "__new__" ? t("inspector.connection") : id }));
  }, [setOperation, t]);

  const replace = useCallback((connection: ConnectionSummary) => onChanged([
    ...connections.filter((item) => item.id !== connection.id),
    connection,
  ].sort((left, right) => left.name.localeCompare(right.name))), [connections, onChanged]);

  useEffect(() => {
    if (!open) return;
    const requested = requestedId ? connections.find((connection) => connection.id === requestedId) : undefined;
    const compatible = requestedKind && connections.some((connection) => connection.kind === requestedKind);
    setKind(requested?.kind ?? requestedKind ?? "provider");
    setMode(requestedKind && !requested && !compatible ? "form" : "list");
    setEditing(requested);
    setQuery("");
    setMessage("");
    setOperations({});
    setOperationErrors({});
    queueMicrotask(() => search.current?.focus());
  }, [connections, open, requestedId, requestedKind]);

  useEffect(() => () => {
    for (const controller of controllers.current.values()) controller.abort();
    for (const popup of oauthPopups.current.values()) popup.close();
    controllers.current.clear();
    oauthPopups.current.clear();
  }, []);

  useEffect(() => {
    if (!open) return;
    const receiveOAuth = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || !event.data || typeof event.data !== "object"
        || (event.data as { type?: unknown }).type !== "harnest-oauth-complete") return;
      const id = (event.data as { id?: unknown }).id;
      if (typeof id !== "string" || (event.data as { ok?: unknown }).ok !== true) {
        setMessage(t("connections.oauthNotCompleted"));
        if (typeof id === "string") {
          setOperationError(id, { code: "OAUTH_NOT_COMPLETED", message: t("connections.oauthNotCompleted"), category: "auth", recoverable: true, action: "reauth" });
          finishOperation(id);
          oauthPopups.current.get(id)?.close();
          oauthPopups.current.delete(id);
        }
        return;
      }
      const controller = beginOperation(id, "discovering");
      void requestJson<ConnectionActionResult>("/api/connections/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, action: "discover" }),
        signal: controller.signal,
      }, { timeoutMs: 120_000 }).then((result) => {
        replace(result.connection);
        setMessage(result.message);
        onComplete?.(result.connection);
      }).catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const details = errorDetails(error, t("connections.discoveryFailed"), t);
        setOperationError(id, details);
        setMessage(details.message);
      }).finally(() => {
        finishOperation(id);
        oauthPopups.current.get(id)?.close();
        oauthPopups.current.delete(id);
      });
    };
    window.addEventListener("message", receiveOAuth);
    return () => window.removeEventListener("message", receiveOAuth);
  }, [beginOperation, finishOperation, onComplete, open, replace, setOperationError, t]);

  const visible = useMemo(() => {
    const value = query.trim().toLocaleLowerCase();
    return connections.filter((connection) => (!requestedKind || connection.kind === requestedKind) && (!value
      || `${connection.name} ${connection.kind} ${connectionDetails(connection) ?? ""} ${connection.scope} ${connection.status}`.toLocaleLowerCase().includes(value)));
  }, [connections, query, requestedKind]);

  if (!open) return null;
  const definition = definitions.find((item) => item.id === kind) ?? definitions[0];
  if (!definition) return null;

  const save = async (input: ConnectionMutation) => {
    const key = formKey;
    const oauthPopup = input.kind === "mcp-http" && input.config?.oauth === true
      ? window.open("about:blank", "harnest-oauth", "popup,width=560,height=760")
      : null;
    if (oauthPopup) oauthPopups.current.set(key, oauthPopup);
    const controller = beginOperation(key, "saving");
    setMessage("");
    let saved: ConnectionSummary | undefined;
    let waitingForOAuth = false;
    try {
      const payload = await requestJson<{ connection: ConnectionSummary }>("/api/connections", {
        method: editing ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
        signal: controller.signal,
      }, { timeoutMs: 60_000 });
      saved = payload.connection;
      replace(saved);
      let connected = saved;
      const actionValue: ConnectionAction = connected.kind === "mcp-http" && connected.config.oauth === true
        ? "reauth"
        : connected.kind === "mcp-http" ? "discover"
          : connected.kind === "mcp-stdio" || connected.kind === "local-runtime" ? "approve-process" : "test";
      setOperation(key, connectionOperationForAction(actionValue));
      const result = await requestJson<ConnectionActionResult>("/api/connections/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: connected.id, action: actionValue }),
        signal: controller.signal,
      }, { timeoutMs: 120_000 });
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
        if (oauthPopup) {
          oauthPopup.location.href = result.authorizationUrl;
          oauthPopups.current.delete(key);
          oauthPopups.current.set(connected.id, oauthPopup);
        }
        else {
          const popup = window.open(result.authorizationUrl, "harnest-oauth", "popup,width=560,height=760");
          if (popup) oauthPopups.current.set(connected.id, popup);
        }
        waitingForOAuth = true;
        setOperation(connected.id, "authorizing");
      } else oauthPopup?.close();
      setMode("list");
      setEditing(undefined);
      if (!(connected.kind === "mcp-http" && connected.config.oauth === true)) onComplete?.(connected);
    } catch (error) {
      oauthPopup?.close();
      if (saved) setEditing(saved);
      if (controller.signal.aborted) return;
      const details = errorDetails(error, t("connections.saveFailed"), t);
      setOperationError(saved?.id ?? key, details);
      setMessage(details.message);
    } finally {
      finishOperation(key);
      if (!waitingForOAuth) oauthPopups.current.delete(key);
    }
  };

  const action = async (connection: ConnectionSummary, value: ConnectionAction) => {
    const oauthPopup = value === "reauth" && connection.kind === "mcp-http" && connection.config.oauth === true
      ? window.open("about:blank", "harnest-oauth", "popup,width=560,height=760")
      : null;
    if (oauthPopup) oauthPopups.current.set(connection.id, oauthPopup);
    const controller = beginOperation(connection.id, operationErrors[connection.id] ? "retrying" : connectionOperationForAction(value));
    setMessage("");
    let waitingForOAuth = false;
    try {
      if (operationErrors[connection.id]) setOperation(connection.id, connectionOperationForAction(value));
      const result = await requestJson<ConnectionActionResult>("/api/connections/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: connection.id, action: value }),
        signal: controller.signal,
      }, { timeoutMs: 120_000 });
      replace(result.connection);
      setMessage(result.message);
      if (value === "reauth" && !result.authorizationUrl) {
        setEditing(result.connection);
        setKind(result.connection.kind);
        setMode("form");
      }
      if (result.authorizationUrl) {
        if (oauthPopup) oauthPopup.location.href = result.authorizationUrl;
        else {
          const popup = window.open(result.authorizationUrl, "harnest-oauth", "popup,width=560,height=760");
          if (popup) oauthPopups.current.set(connection.id, popup);
        }
        waitingForOAuth = true;
        setOperation(connection.id, "authorizing");
      } else oauthPopup?.close();
      if (["test", "discover", "approve-process"].includes(value) && connectionCanRun(result.connection)) {
        onComplete?.(result.connection);
      }
    } catch (error) {
      oauthPopup?.close();
      if (controller.signal.aborted) return;
      const details = errorDetails(error, t("connections.actionFailed"), t);
      setOperationError(connection.id, details);
      setMessage(details.message);
    } finally {
      finishOperation(connection.id, waitingForOAuth);
      if (!waitingForOAuth) oauthPopups.current.delete(connection.id);
    }
  };

  const remove = async (connection: ConnectionSummary) => {
    const controller = beginOperation(connection.id, "testing");
    try {
      await requestJson<void>("/api/connections", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: connection.id }),
        signal: controller.signal,
      });
      onChanged(connections.filter((item) => item.id !== connection.id));
      setDeleteId("");
      setMessage(t("connections.deleted", { name: connection.name }));
    } catch (error) {
      if (controller.signal.aborted) return;
      const details = errorDetails(error, t("connections.deleteFailed"), t);
      setOperationError(connection.id, details);
      setMessage(details.message);
    } finally {
      finishOperation(connection.id);
    }
  };

  const primary = (connection: ConnectionSummary): { label: MessageKey; action?: ConnectionAction } => {
    if (onComplete && connectionCanRun(connection)) return { label: "common.continue" };
    if (["needs_auth", "expired", "insufficient_scope", "disconnected"].includes(connection.status)) {
      return { label: "connections.action.reauth", action: "reauth" };
    }
    if ((connection.kind === "mcp-stdio" || connection.kind === "local-runtime") && connection.status === "error") {
      return { label: "connections.action.approve", action: "approve-process" };
    }
    if (connection.kind === "mcp-http" || connection.kind === "mcp-stdio") return { label: "connections.action.discover", action: "discover" };
    return { label: "connections.action.test", action: "test" };
  };

  return <Dialog.Root open={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="sheet-backdrop" />
      <Dialog.Viewport className="connection-sheet-viewport">
        <Dialog.Popup className="connection-sheet">
          <header className="sheet-header"><div><span className="sheet-eyebrow">{t("connections.eyebrow")}</span><Dialog.Title>{t("connections.title")}</Dialog.Title></div><Dialog.Close className="sheet-close" aria-label={t("common.close")} disabled={busy}>×</Dialog.Close></header>
          {message && <div className="sheet-message" role="status">{message}</div>}
          {mode === "kind" && <div className="connection-kind-grid">
            {definitions.map((item) => <button key={item.id} className="connection-kind" onClick={() => { setKind(item.id); setMode("form"); }}><strong>{t(KIND_LABEL_KEYS[item.id])}</strong><span>{t(KIND_DESCRIPTION_KEYS[item.id])}</span></button>)}
            <Button onClick={() => setMode("list")}>{t("common.back")}</Button>
          </div>}
          {mode === "form" && <ConnectionForm connection={editing} requestedId={requestedId} kind={kind} definition={definition} operation={operations[formKey]} onCancel={() => { setEditing(undefined); setMode("list"); }} onCancelOperation={() => cancelOperation(formKey)} onSaved={save} />}
          {mode === "list" && <>
            <div className="connection-toolbar"><label className="sr-only" htmlFor="connection-search">{t("connections.search")}</label><input ref={search} id="connection-search" type="search" placeholder={t("connections.search")} value={query} onChange={(event) => setQuery(event.target.value)} /><Button variant="primary" onClick={() => setMode("kind")}>{t("connections.add")}</Button></div>
            <div className="connection-list">
              {visible.length ? visible.map((connection) => {
                const main = primary(connection);
                const operation = operations[connection.id];
                const operationError = operationErrors[connection.id];
                const cardBusy = Boolean(operation && operation !== "idle");
                const status = t(`connections.status.${connection.status}`);
                const details = connectionDetails(connection);
                return <article key={connection.id} className={`connection-card ${cardBusy ? "is-busy" : ""}`} aria-busy={cardBusy || undefined}>
                  <div className="connection-card-heading"><span className={`connection-status is-${connection.status}`} aria-label={status} /><div><strong>{connection.name}</strong><small>{[t(KIND_LABEL_KEYS[connection.kind]), details, t(`connections.form.scope.${connection.scope}`), connection.lastCheckedAt ? t("connections.lastChecked", { time: formatRelative(connection.lastCheckedAt) }) : t("connections.neverChecked")].filter(Boolean).join(" · ")}</small></div><span className="connection-status-copy">{status}</span></div>
                  {operation && operation !== "idle" && <InlineNotice title={t(OPERATION_KEYS[operation])} action={<Button size="small" onClick={() => cancelOperation(connection.id)}>{t("common.cancel")}</Button>}>{t("connections.operation.description")}</InlineNotice>}
                  {operationError ? <InlineNotice tone="danger" title={t("common.needsAttention")} action={operationError.recoverable && main.action ? <Button size="small" onClick={() => void action(connection, main.action!)}>{t("connections.action.retry")}</Button> : undefined}><span>{operationError.message}</span><details><summary>{t("common.details")}</summary><code>{operationError.code} · {operationError.category}{operationError.technicalMessage ? `\n${operationError.technicalMessage}` : ""}</code></details></InlineNotice> : connection.error && <InlineNotice tone="danger" title={status}><span>{t("connections.error.description")}</span><details><summary>{t("common.details")}</summary><code>{connection.error.code}{connection.error.message ? ` · ${connection.error.message}` : ""}</code></details></InlineNotice>}
                  <div className="connection-card-actions">
                    <Button variant="primary" loading={cardBusy} onClick={() => main.action ? void action(connection, main.action) : onComplete?.(connection)}>{cardBusy && operation && operation !== "idle" ? t(OPERATION_KEYS[operation]) : t(main.label)}</Button>
                    <Button disabled={cardBusy} onClick={() => { setEditing(connection); setKind(connection.kind); setMode("form"); }}>{t("common.edit")}</Button>
                  </div>
                  <details className="advanced-panel"><summary>{t("common.advanced")}</summary><div className="connection-card-actions">
                    {main.action !== "test" && <Button size="small" disabled={cardBusy} onClick={() => void action(connection, "test")}>{t("connections.action.test")}</Button>}
                    {(connection.kind === "mcp-http" || connection.kind === "mcp-stdio") && main.action !== "discover" && <Button size="small" disabled={cardBusy} onClick={() => void action(connection, "discover")}>{t("connections.action.discover")}</Button>}
                    {(connection.kind === "mcp-stdio" || connection.kind === "local-runtime") && <Button size="small" disabled={cardBusy} onClick={() => void action(connection, "approve-process")}>{t("connections.action.approve")}</Button>}
                    {main.action !== "reauth" && <Button size="small" disabled={cardBusy} onClick={() => void action(connection, "reauth")}>{t("common.reconnect")}</Button>}
                    <Button size="small" disabled={cardBusy || connection.status === "disconnected"} onClick={() => void action(connection, "disconnect")}>{t("common.disconnect")}</Button>
                    {connection.kind === "mcp-http" && connection.config.oauth === true && <Button size="small" disabled={cardBusy} onClick={() => void action(connection, "revoke")}>{t("connections.action.revoke")}</Button>}
                    {deleteId === connection.id ? <><Button size="small" variant="danger" loading={cardBusy} onClick={() => void remove(connection)}>{t("connections.deleteConfirm")}</Button><Button size="small" onClick={() => setDeleteId("")}>{t("common.cancel")}</Button></> : <Button size="small" disabled={cardBusy} onClick={() => setDeleteId(connection.id)}>{t("common.delete")}</Button>}
                  </div></details>
                </article>;
              }) : <EmptyState title={connections.length ? t("connections.noMatch") : t("connections.empty.title")} description={t("connections.empty.description")} action={!connections.length ? <Button variant="primary" onClick={() => setMode("kind")}>{t("connections.add")}</Button> : undefined} />}
            </div>
          </>}
        </Dialog.Popup>
      </Dialog.Viewport>
    </Dialog.Portal>
  </Dialog.Root>;
}
