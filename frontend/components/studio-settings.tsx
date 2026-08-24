"use client";

import type { Diagnostic, HarnessIntegrationContract } from "@harnest/core";
import { Dialog } from "@base-ui/react/dialog";
import type { MessageKey } from "@/i18n/messages/en-US";
import type { Locale } from "@/i18n/core";
import { connectionCanRun, type ConnectionSummary } from "@/lib/connections";
import { connectionLabel } from "@/i18n/manifest";
import { useI18n } from "./i18n-provider";
import { Button } from "./ui/ui";
import type { ReactNode } from "react";

export type SettingsPage = "general" | "connections" | "tools" | "runtime";

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
  onOpenChange,
  onPageChange,
  onThemeChange,
  onLocaleChange,
  onManageConnections,
  onManageTools,
  onManageSkills,
  children,
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
  onOpenChange: (open: boolean) => void;
  onPageChange: (page: SettingsPage) => void;
  onThemeChange: (theme: "light" | "dark") => void;
  onLocaleChange: (locale: Locale) => void;
  onManageConnections: () => void;
  onManageTools: () => void;
  onManageSkills: () => void;
  children?: ReactNode;
}) {
  const { t, formatNumber } = useI18n();
  const selected = SETTINGS_PAGES.find(({ id }) => id === page) ?? SETTINGS_PAGES[0];
  const readyConnections = connections.filter(connectionCanRun).length;
  const errors = diagnostics.filter(({ severity }) => severity === "error");
  const openManager = (action: () => void) => action();

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
                  {connections.length ? connections.map((connection) => <article key={connection.id}><span className={`service-state is-${connectionCanRun(connection) ? "ready" : "blocked"}`} /><span><strong>{connection.name}</strong><small>{connectionLabel(t, connection.kind)} · {t(`connections.form.scope.${connection.scope}`)}</small></span><em>{t(`connections.status.${connection.status}`)}</em></article>) : <div className="settings-empty"><strong>{t("settings.noServices")}</strong><p>{t("settings.noServices.description")}</p><Button variant="primary" onClick={() => openManager(onManageConnections)}>{t("settings.addFirstService")}</Button></div>}
                </section>
              </>}

              {page === "tools" && <section className="settings-extension-grid">
                <article><span className="settings-extension-icon">T</span><div><h3>{t("settings.customTools")}</h3><p>{t("settings.customTools.description")}</p><strong>{t("settings.available", { count: formatNumber(toolCount) })}</strong></div><Button onClick={() => openManager(onManageTools)}>{t("settings.manageTools")}</Button></article>
                <article><span className="settings-extension-icon">S</span><div><h3>{t("settings.agentSkills")}</h3><p>{t("settings.agentSkills.description")}</p><strong>{t("settings.installed", { count: formatNumber(skillCount) })}</strong></div><Button onClick={() => openManager(onManageSkills)}>{t("settings.manageSkills")}</Button></article>
              </section>}

              {page === "runtime" && <>
                <section className="settings-section"><div><h3>{t("settings.declaredCapabilities")}</h3><p>{t("settings.declaredCapabilities.description")}</p></div><div className="settings-capabilities">{contract.capabilities.length ? contract.capabilities.map((capability) => <span key={capability}>{capability.replaceAll("-", " ")}</span>) : <span>{t("settings.textRuntime")}</span>}</div></section>
                <section className="settings-section"><div><h3>{t("settings.safetyBoundaries")}</h3><p>{t("settings.safetyBoundaries.description")}</p></div><dl className="settings-runtime-list"><div><dt>{t("settings.runtime.conversation")}</dt><dd>{t("settings.runtime.conversation.value")}</dd></div><div><dt>{t("settings.runtime.history")}</dt><dd>{t("settings.runtime.history.value")}</dd></div><div><dt>{t("settings.runtime.sandbox")}</dt><dd>{t("settings.runtime.sandbox.value")}</dd></div><div><dt>{t("settings.runtime.surfaces")}</dt><dd>{contract.integrationSurfaces.map(({ id }) => id.toUpperCase()).join(" · ")}</dd></div></dl></section>
              </>}
            </div>
          </section>
        </Dialog.Popup>
      </Dialog.Viewport>
    </Dialog.Portal>
    {children}
  </Dialog.Root>;
}
