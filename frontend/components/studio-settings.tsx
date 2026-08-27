"use client";

import type { Diagnostic, HarnessIntegrationContract, HarnessSpec } from "@harnestai/core";
import { Dialog } from "@base-ui/react/dialog";
import type { MessageKey } from "@/i18n/messages/en-US";
import type { Locale } from "@/i18n/core";
import { connectionCanRun, connectionDetails, type ConnectionSummary } from "@/lib/connections";
import { apiErrorMessage, requestJson } from "@/lib/api-client";
import { connectionLabel } from "@/i18n/manifest";
import { useI18n } from "./i18n-provider";
import { Button } from "./ui/ui";
import { useCallback, useEffect, useState } from "react";
import type { StudioCapabilityPolicy } from "@/lib/host-policy";

export type SettingsPage = "general" | "connections" | "tools" | "runtime";

const objectValue = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};

function RuntimeSpecSettings({
  version,
  runtime,
  locked,
  onChange,
}: {
  version: HarnessSpec["version"];
  runtime: Readonly<Record<string, unknown>>;
  locked: boolean;
  onChange: (runtime: Record<string, unknown> | undefined) => void;
}) {
  const { t } = useI18n();
  const patch = (key: string, value: unknown) => {
    const next = { ...runtime };
    if (value === undefined || value === "") delete next[key]; else next[key] = value;
    onChange(Object.keys(next).length ? next : undefined);
  };
  const patchGroup = (group: "retry" | "budget" | "context", key: string, value: unknown) => {
    const nested = { ...objectValue(runtime[group]) };
    if (value === undefined || value === "") delete nested[key]; else nested[key] = value;
    if (group === "retry" && Object.keys(nested).length && typeof nested.maxAttempts !== "number") nested.maxAttempts = 3;
    patch(group, Object.keys(nested).length ? nested : undefined);
  };
  const number = (value: string) => value === "" ? undefined : Number(value);
  const lines = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").join("\n") : "";
  const retry = objectValue(runtime.retry);
  const budget = objectValue(runtime.budget);
  const context = objectValue(runtime.context);
  return <section className="settings-section">
    <div><h3>{t("settings.runtime.specTitle")}</h3><p>{t("settings.runtime.specDescription")}</p></div>
    <div className="field-grid">
      <div className="field"><label htmlFor="runtime-timeout">{t("settings.runtime.timeout")}</label><input id="runtime-timeout" type="number" min={1} max={600000} disabled={locked} defaultValue={typeof runtime.timeoutMs === "number" ? runtime.timeoutMs : ""} onBlur={(event) => patch("timeoutMs", number(event.target.value))} /></div>
      <div className="field"><label htmlFor="runtime-adapters">{t("settings.runtime.adapters")}</label><textarea id="runtime-adapters" rows={3} disabled={locked} defaultValue={lines(runtime.adapters)} onBlur={(event) => patch("adapters", event.target.value.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean))} /><span className="field-help">{t("settings.runtime.onePerLine")}</span></div>
      {version !== "0.1" && <>
        <div className="field"><label htmlFor="runtime-modules">{t("settings.runtime.modules")}</label><textarea id="runtime-modules" rows={3} disabled={locked} defaultValue={lines(runtime.modules)} onBlur={(event) => patch("modules", event.target.value.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean))} /><span className="field-help">{t("settings.runtime.modulesHelp")}</span></div>
        <div className="field-section">{t("settings.runtime.context")}</div>
        <div className="field"><label htmlFor="runtime-cache-mode">{t("settings.runtime.cacheMode")}</label><select id="runtime-cache-mode" disabled={locked} defaultValue={typeof context.cacheMode === "string" ? context.cacheMode : "automatic"} onChange={(event) => patchGroup("context", "cacheMode", event.target.value)}><option value="automatic">{t("settings.runtime.cacheAutomatic")}</option><option value="explicit">{t("settings.runtime.cacheExplicit")}</option></select><span className="field-help">{t("settings.runtime.cacheModeHelp")}</span></div>
        <div className="field"><label htmlFor="runtime-context-overflow">{t("settings.runtime.contextOverflow")}</label><select id="runtime-context-overflow" disabled={locked} defaultValue={typeof context.overflow === "string" ? context.overflow : "compact"} onChange={(event) => patchGroup("context", "overflow", event.target.value)}><option value="compact">{t("settings.runtime.overflowCompact")}</option><option value="error">{t("settings.runtime.overflowError")}</option></select><span className="field-help">{t("settings.runtime.contextOverflowHelp")}</span></div>
        <div className="field-section">{t("settings.runtime.retry")}</div>
        <div className="field"><label htmlFor="runtime-retry-attempts">{t("settings.runtime.maxAttempts")}</label><input id="runtime-retry-attempts" type="number" min={1} max={10} disabled={locked} defaultValue={typeof retry.maxAttempts === "number" ? retry.maxAttempts : ""} onBlur={(event) => patchGroup("retry", "maxAttempts", number(event.target.value))} /></div>
        <div className="field"><label htmlFor="runtime-retry-backoff">{t("settings.runtime.backoff")}</label><input id="runtime-retry-backoff" type="number" min={0} max={60000} disabled={locked} defaultValue={typeof retry.backoffMs === "number" ? retry.backoffMs : ""} onBlur={(event) => patchGroup("retry", "backoffMs", number(event.target.value))} /></div>
        <div className="field"><label htmlFor="runtime-retry-max-backoff">{t("settings.runtime.maxBackoff")}</label><input id="runtime-retry-max-backoff" type="number" min={0} max={60000} disabled={locked} defaultValue={typeof retry.maxBackoffMs === "number" ? retry.maxBackoffMs : ""} onBlur={(event) => patchGroup("retry", "maxBackoffMs", number(event.target.value))} /></div>
        <div className="field-section">{t("settings.runtime.budget")}</div>
        <div className="field"><label htmlFor="runtime-budget-tokens">{t("settings.runtime.maxTokens")}</label><input id="runtime-budget-tokens" type="number" min={1} disabled={locked} defaultValue={typeof budget.maxTokens === "number" ? budget.maxTokens : ""} onBlur={(event) => patchGroup("budget", "maxTokens", number(event.target.value))} /></div>
        <div className="field"><label htmlFor="runtime-budget-cost">{t("settings.runtime.maxCost")}</label><input id="runtime-budget-cost" type="number" min={0.000001} step="any" disabled={locked} defaultValue={typeof budget.maxCostUsd === "number" ? budget.maxCostUsd : ""} onBlur={(event) => patchGroup("budget", "maxCostUsd", number(event.target.value))} /></div>
      </>}
    </div>
  </section>;
}

interface ToolPermissionView {
  readonly toolId: string;
  readonly connectionId?: string;
  readonly capability?: string;
  readonly resource?: string;
  readonly createdAt: string;
}

const SETTINGS_PAGES: readonly { id: SettingsPage; label: MessageKey; description: MessageKey }[] = [
  { id: "general", label: "settings.general", description: "settings.general.description" },
  { id: "connections", label: "settings.connections", description: "settings.connections.description" },
  { id: "tools", label: "settings.tools", description: "settings.tools.description" },
  { id: "runtime", label: "settings.runtime", description: "settings.runtime.description" },
];

export function StudioSettings({
  open,
  page,
  theme,
  locale,
  file,
  contract,
  diagnostics,
  connections,
  toolCount,
  skillCount,
  specVersion,
  runtimeConfig,
  runtimeLocked,
  capabilityPolicy,
  hostDiagnostics,
  restartCommand,
  onOpenChange,
  onPageChange,
  onThemeChange,
  onLocaleChange,
  onManageConnections,
  onManageTools,
  onManageSkills,
  onRuntimeChange,
}: {
  open: boolean;
  page: SettingsPage;
  theme: "light" | "dark";
  locale: Locale;
  file: string;
  contract: HarnessIntegrationContract;
  diagnostics: readonly Diagnostic[];
  connections: readonly ConnectionSummary[];
  toolCount: number;
  skillCount: number;
  specVersion: HarnessSpec["version"];
  runtimeConfig: Readonly<Record<string, unknown>>;
  runtimeLocked: boolean;
  capabilityPolicy: StudioCapabilityPolicy;
  hostDiagnostics: readonly Diagnostic[];
  restartCommand: string;
  onOpenChange: (open: boolean) => void;
  onPageChange: (page: SettingsPage) => void;
  onThemeChange: (theme: "light" | "dark") => void;
  onLocaleChange: (locale: Locale) => void;
  onManageConnections: () => void;
  onManageTools: () => void;
  onManageSkills: () => void;
  onRuntimeChange: (runtime: Record<string, unknown> | undefined) => void;
}) {
  const { t, formatDate, formatNumber } = useI18n();
  const selected = SETTINGS_PAGES.find(({ id }) => id === page) ?? SETTINGS_PAGES[0];
  const readyConnections = connections.filter(connectionCanRun).length;
  const errors = diagnostics.filter(({ severity }) => severity === "error");
  const openManager = (action: () => void) => action();
  const [toolPermissions, setToolPermissions] = useState<readonly ToolPermissionView[]>([]);
  const [permissionError, setPermissionError] = useState("");
  const [permissionBusy, setPermissionBusy] = useState("");
  const [contextCacheCount, setContextCacheCount] = useState(0);
  const [contextCacheError, setContextCacheError] = useState("");
  const [contextCacheBusy, setContextCacheBusy] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const loadToolPermissions = useCallback(async () => {
    try {
      const payload = await requestJson<{ permissions: ToolPermissionView[] }>("/api/tool-permissions");
      setToolPermissions(payload.permissions);
      setPermissionError("");
    } catch (error) {
      setPermissionError(apiErrorMessage(error, t("settings.permissions.loadFailed"), t));
    }
  }, [t]);
  useEffect(() => {
    if (open && page === "tools") void loadToolPermissions();
  }, [loadToolPermissions, open, page]);
  const loadContextCache = useCallback(async () => {
    try {
      const payload = await requestJson<{ count: number }>("/api/context-cache");
      setContextCacheCount(payload.count);
      setContextCacheError("");
    } catch (error) {
      setContextCacheError(apiErrorMessage(error, t("settings.runtime.cacheLoadFailed"), t));
    }
  }, [t]);
  useEffect(() => {
    if (open && page === "runtime") void loadContextCache();
  }, [loadContextCache, open, page]);
  const clearContextCache = async () => {
    setContextCacheBusy(true);
    try {
      await requestJson("/api/context-cache", { method: "DELETE" });
      setContextCacheCount(0);
      setContextCacheError("");
    } catch (error) {
      setContextCacheError(apiErrorMessage(error, t("settings.runtime.cacheClearFailed"), t));
    } finally {
      setContextCacheBusy(false);
    }
  };
  const revokeToolPermission = async (permission: ToolPermissionView) => {
    const key = `${permission.toolId}\u0000${permission.connectionId ?? ""}\u0000${permission.capability ?? ""}\u0000${permission.resource ?? ""}`;
    setPermissionBusy(key);
    try {
      await requestJson("/api/tool-permissions", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toolId: permission.toolId, ...(permission.connectionId ? { connectionId: permission.connectionId } : {}), ...(permission.capability ? { capability: permission.capability } : {}), ...(permission.resource ? { resource: permission.resource } : {}) }),
      });
      await loadToolPermissions();
    } catch (error) {
      setPermissionError(apiErrorMessage(error, t("settings.permissions.revokeFailed"), t));
    } finally {
      setPermissionBusy("");
    }
  };
  const copyRestartCommand = async () => {
    try {
      await navigator.clipboard.writeText(restartCommand);
      setCopyState("copied");
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = restartCommand;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.append(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      textarea.remove();
      setCopyState(copied ? "copied" : "error");
    }
  };

  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Backdrop className="settings-backdrop" />
      <Dialog.Viewport className="settings-viewport">
        <Dialog.Popup className="settings-dialog">
          <aside className="settings-nav">
            <div className="settings-brand"><span className="settings-brand-mark">H</span><span><strong>{t("settings.title")}</strong><small>{t("settings.description")}</small></span></div>
            <nav aria-label={t("settings.title")}>
              {SETTINGS_PAGES.map((item) => <button type="button" key={item.id} className={page === item.id ? "is-active" : ""} aria-current={page === item.id ? "page" : undefined} onClick={() => onPageChange(item.id)}><span>{t(item.label)}</span><small>{t(item.description)}</small></button>)}
            </nav>
            <div className="settings-project"><span>{t("settings.currentProject")}</span><strong title={file}>{file.split(/[\\/]/).pop()}</strong></div>
          </aside>

          <section className="settings-content">
            <header className="settings-header">
              <div><Dialog.Title>{t(selected.label)}</Dialog.Title><Dialog.Description>{t(selected.description)}</Dialog.Description></div>
              <Dialog.Close className="settings-close" aria-label={t("common.close")}>×</Dialog.Close>
            </header>

            <div className="settings-page">
              {page === "general" && <>
                <section className="settings-section">
                  <div><h3>{t("settings.appearance")}</h3><p>{t("settings.appearance.description")}</p></div>
                  <div className="theme-choice" role="radiogroup" aria-label={t("settings.theme")}>
                    {(["light", "dark"] as const).map((value) => <button key={value} type="button" role="radio" aria-checked={theme === value} className={theme === value ? "is-active" : ""} onClick={() => onThemeChange(value)}><span className={`theme-preview is-${value}`}><i /><i /><i /></span><strong>{t(value === "light" ? "settings.theme.light" : "settings.theme.dark")}</strong></button>)}
                  </div>
                </section>
                <section className="settings-section is-inline">
                  <div><h3>{t("settings.language")}</h3><p>{t("settings.language.description")}</p></div>
                  <select aria-label={t("settings.language")} value={locale} onChange={(event) => onLocaleChange(event.target.value as Locale)}><option value="ko-KR">{t("settings.language.korean")}</option><option value="en-US">{t("settings.language.english")}</option></select>
                </section>
                <section className="settings-section">
                  <div><h3>{t("settings.readiness")}</h3><p>{t("settings.readiness.description")}</p></div>
                  <dl className="settings-facts">
                    <div><dt>{t("settings.metric.components")}</dt><dd>{formatNumber(contract.componentCount)}</dd></div>
                    <div><dt>{t("settings.metric.connections")}</dt><dd>{formatNumber(contract.connectionCount)}</dd></div>
                    <div><dt>{t("settings.metric.issues")}</dt><dd className={errors.length ? "is-fault" : "is-pass"}>{errors.length ? t("save.issues", { count: errors.length }) : t("common.ready")}</dd></div>
                    <div><dt>{t("settings.metric.spec")}</dt><dd>HarnessSpec {contract.specVersion}</dd></div>
                  </dl>
                </section>
              </>}

              {page === "connections" && <>
                <section className="settings-section is-inline"><div><h3>{t("settings.connections")}</h3><p>{t("settings.servicesSecurity")}</p></div><Button onClick={() => openManager(onManageConnections)}>{t("settings.manageServices")}</Button></section>
                <div className="settings-summary"><span><strong>{formatNumber(readyConnections)}</strong><small>{t("settings.metric.ready")}</small></span><span><strong>{formatNumber(connections.length - readyConnections)}</strong><small>{t("settings.metric.attention")}</small></span><span><strong>{formatNumber(contract.requiredConnections.length)}</strong><small>{t("settings.metric.used")}</small></span></div>
                <section className="settings-service-list" aria-label={t("settings.connections")}>
                  {connections.length ? connections.map((connection) => <article key={connection.id}><span className={`service-state is-${connectionCanRun(connection) ? "ready" : "blocked"}`} /><span><strong>{connection.name}</strong><small>{[connectionDetails(connection) ?? connectionLabel(t, connection.kind), t(`connections.form.scope.${connection.scope}`)].join(" · ")}</small></span><em>{t(`connections.status.${connection.status}`)}</em></article>) : <div className="settings-empty"><strong>{t("settings.noServices")}</strong><p>{t("settings.noServices.description")}</p><Button variant="primary" onClick={() => openManager(onManageConnections)}>{t("settings.addFirstService")}</Button></div>}
                </section>
              </>}

              {page === "tools" && <>
                <section className="settings-extension-grid">
                  <article><span className="settings-extension-icon">T</span><div><h3>{t("settings.customTools")}</h3><p>{t("settings.customTools.description")}</p><strong>{t("settings.available", { count: formatNumber(toolCount) })}</strong></div><Button onClick={() => openManager(onManageTools)}>{t("settings.manageTools")}</Button></article>
                  <article><span className="settings-extension-icon">S</span><div><h3>{t("settings.agentSkills")}</h3><p>{t("settings.agentSkills.description")}</p><strong>{t("settings.installed", { count: formatNumber(skillCount) })}</strong></div><Button onClick={() => openManager(onManageSkills)}>{t("settings.manageSkills")}</Button></article>
                </section>
                <section className="settings-section">
                  <div><h3>{t("settings.permissions.title")}</h3><p>{t("settings.permissions.description")}</p></div>
                  {permissionError && <p className="field-error" role="status">{permissionError}</p>}
                  <div className="settings-service-list">
                    {toolPermissions.length ? toolPermissions.map((permission) => {
                      const key = `${permission.toolId}\u0000${permission.connectionId ?? ""}\u0000${permission.capability ?? ""}\u0000${permission.resource ?? ""}`;
                      return <article key={key}><span className="service-state is-ready" /><span><strong>{permission.toolId}</strong><small>{[permission.capability, permission.resource, permission.connectionId ?? t("settings.permissions.noConnection"), formatDate(permission.createdAt, { dateStyle: "medium", timeStyle: "short" })].filter(Boolean).join(" · ")}</small></span><Button disabled={permissionBusy === key} onClick={() => void revokeToolPermission(permission)}>{t("settings.permissions.revoke")}</Button></article>;
                    }) : <div className="settings-empty"><strong>{t("settings.permissions.empty")}</strong><p>{t("settings.permissions.emptyDescription")}</p></div>}
                  </div>
                </section>
              </>}

              {page === "runtime" && <>
                <RuntimeSpecSettings key={JSON.stringify(runtimeConfig)} version={specVersion} runtime={runtimeConfig} locked={runtimeLocked} onChange={onRuntimeChange} />
                <section className="settings-section">
                  <div><h3>{t("settings.hostPolicy")}</h3><p>{t("settings.hostPolicy.description")}</p></div>
                  <dl className="settings-runtime-list">
                    <div><dt>{t("settings.hostPolicy.modules")}</dt><dd className={capabilityPolicy.allowModules ? "is-pass" : "is-fault"}>{t(capabilityPolicy.allowModules ? "common.allowed" : "common.denied")}</dd></div>
                    <div><dt>{t("settings.hostPolicy.files")}</dt><dd className={capabilityPolicy.allowFiles ? "is-pass" : "is-fault"}>{t(capabilityPolicy.allowFiles ? "common.allowed" : "common.denied")}</dd></div>
                    <div><dt>{t("settings.hostPolicy.roots")}</dt><dd>{capabilityPolicy.contextRoots.join(", ") || t("common.none")}</dd></div>
                    <div><dt>{t("settings.hostPolicy.process")}</dt><dd>{capabilityPolicy.processCommands.join(", ") || t("common.none")}</dd></div>
                    <div><dt>{t("settings.hostPolicy.network")}</dt><dd>{capabilityPolicy.networkHosts.join(", ") || t("common.none")}</dd></div>
                    <div><dt>{t("settings.hostPolicy.tools")}</dt><dd>{capabilityPolicy.approvedToolIds.join(", ") || t("common.none")}</dd></div>
                  </dl>
                  {hostDiagnostics.length ? <div className="settings-host-restart" role="alert"><strong>{t("settings.hostPolicy.denied", { count: hostDiagnostics.length })}</strong><p>{t("settings.hostPolicy.restartHelp")}</p><code tabIndex={0}>{restartCommand}</code><div><Button size="small" onClick={() => void copyRestartCommand()}>{t(copyState === "copied" ? "common.copied" : "common.copy")}</Button>{copyState === "error" && <span className="field-error" role="status">{t("settings.hostPolicy.copyFailed")}</span>}</div></div> : <p className="settings-host-ready" role="status">{t("settings.hostPolicy.ready")}</p>}
                </section>
                <section className="settings-section is-inline"><div><h3>{t("settings.runtime.cacheRegistry")}</h3><p>{t("settings.runtime.cacheRegistryDescription", { count: formatNumber(contextCacheCount) })}</p>{contextCacheError && <span className="field-error" role="status">{contextCacheError}</span>}</div><Button disabled={contextCacheBusy || contextCacheCount === 0} onClick={() => void clearContextCache()}>{contextCacheBusy ? t("settings.runtime.cacheClearing") : t("settings.runtime.cacheClear")}</Button></section>
                <section className="settings-section"><div><h3>{t("settings.declaredCapabilities")}</h3><p>{t("settings.declaredCapabilities.description")}</p></div><div className="settings-capabilities">{contract.capabilities.length ? contract.capabilities.map((capability) => <span key={capability}>{capability.replaceAll("-", " ")}</span>) : <span>{t("settings.textRuntime")}</span>}</div></section>
                <section className="settings-section"><div><h3>{t("settings.safetyBoundaries")}</h3><p>{t("settings.safetyBoundaries.description")}</p></div><dl className="settings-runtime-list"><div><dt>{t("settings.runtime.conversation")}</dt><dd>{t("settings.runtime.conversation.value")}</dd></div><div><dt>{t("settings.runtime.history")}</dt><dd>{t("settings.runtime.history.value")}</dd></div><div><dt>{t("settings.runtime.sandbox")}</dt><dd>{t("settings.runtime.sandbox.value")}</dd></div><div><dt>{t("settings.runtime.surfaces")}</dt><dd>{contract.integrationSurfaces.map(({ id }) => id.toUpperCase()).join(" · ")}</dd></div></dl></section>
              </>}
            </div>
          </section>
        </Dialog.Popup>
      </Dialog.Viewport>
    </Dialog.Portal>
  </Dialog.Root>;
}
