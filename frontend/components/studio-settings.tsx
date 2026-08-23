"use client";

import type { Diagnostic, HarnessIntegrationContract } from "@harnest/core";
import { Dialog } from "@base-ui/react/dialog";
import { useState, type ReactNode } from "react";
import { connectionCanRun, connectionKindLabel, type ConnectionSummary } from "@/lib/connections";

type SettingsPage = "general" | "services" | "extensions" | "runtime";

const SETTINGS_PAGES: readonly { id: SettingsPage; label: string; description: string }[] = [
  { id: "general", label: "Workspace", description: "Appearance and project state" },
  { id: "services", label: "Services", description: "Models, search, MCP, and runtimes" },
  { id: "extensions", label: "Tools & skills", description: "Reusable agent capabilities" },
  { id: "runtime", label: "Runtime", description: "Limits and integration contract" },
];

function SettingsAction({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return <button type="button" className="button" onClick={onClick}>{children}</button>;
}

export function StudioSettings({
  open,
  theme,
  file,
  contract,
  diagnostics,
  connections,
  toolCount,
  skillCount,
  onOpenChange,
  onThemeChange,
  onManageConnections,
  onManageTools,
  onManageSkills,
}: {
  open: boolean;
  theme: "light" | "dark";
  file: string;
  contract: HarnessIntegrationContract;
  diagnostics: readonly Diagnostic[];
  connections: readonly ConnectionSummary[];
  toolCount: number;
  skillCount: number;
  onOpenChange: (open: boolean) => void;
  onThemeChange: (theme: "light" | "dark") => void;
  onManageConnections: () => void;
  onManageTools: () => void;
  onManageSkills: () => void;
}) {
  const [page, setPage] = useState<SettingsPage>("general");
  const readyConnections = connections.filter(connectionCanRun).length;
  const errors = diagnostics.filter(({ severity }) => severity === "error");
  const openManager = (action: () => void) => {
    onOpenChange(false);
    window.setTimeout(action, 0);
  };

  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Backdrop className="settings-backdrop" />
      <Dialog.Viewport className="settings-viewport">
        <Dialog.Popup className="settings-dialog">
          <aside className="settings-nav">
            <div className="settings-brand"><span className="settings-brand-mark">H</span><span><strong>Studio settings</strong><small>Project control plane</small></span></div>
            <nav aria-label="Settings sections">
              {SETTINGS_PAGES.map((item) => <button
                type="button"
                key={item.id}
                className={page === item.id ? "is-active" : ""}
                aria-current={page === item.id ? "page" : undefined}
                onClick={() => setPage(item.id)}
              ><span>{item.label}</span><small>{item.description}</small></button>)}
            </nav>
            <div className="settings-project"><span>Current project</span><strong title={file}>{file.split(/[\\/]/).pop()}</strong></div>
          </aside>

          <section className="settings-content">
            <header className="settings-header">
              <div><Dialog.Title>{SETTINGS_PAGES.find(({ id }) => id === page)?.label}</Dialog.Title><Dialog.Description>{SETTINGS_PAGES.find(({ id }) => id === page)?.description}</Dialog.Description></div>
              <Dialog.Close className="settings-close" aria-label="Close settings">×</Dialog.Close>
            </header>

            <div className="settings-page">
              {page === "general" && <>
                <section className="settings-section">
                  <div><h3>Appearance</h3><p>Use one theme across Builder, Playground, inspectors, and dialogs.</p></div>
                  <div className="theme-choice" role="radiogroup" aria-label="Color theme">
                    {(["light", "dark"] as const).map((value) => <button key={value} type="button" role="radio" aria-checked={theme === value} className={theme === value ? "is-active" : ""} onClick={() => onThemeChange(value)}><span className={`theme-preview is-${value}`}><i /><i /><i /></span><strong>{value === "light" ? "Light" : "Dark"}</strong></button>)}
                  </div>
                </section>
                <section className="settings-section">
                  <div><h3>Project readiness</h3><p>Harnest saves valid canvas changes automatically and validates runtime requirements after each meaningful edit.</p></div>
                  <dl className="settings-facts">
                    <div><dt>Components</dt><dd>{contract.componentCount}</dd></div>
                    <div><dt>Connections</dt><dd>{contract.connectionCount}</dd></div>
                    <div><dt>Issues</dt><dd className={errors.length ? "is-fault" : "is-pass"}>{errors.length ? `${errors.length} issue${errors.length === 1 ? "" : "s"}` : "Ready"}</dd></div>
                    <div><dt>Spec</dt><dd>HarnessSpec {contract.specVersion}</dd></div>
                  </dl>
                </section>
              </>}

              {page === "services" && <>
                <section className="settings-section is-inline">
                  <div><h3>Reusable services</h3><p>Credentials stay in the local encrypted store. HarnessSpecs keep only Connection IDs.</p></div>
                  <SettingsAction onClick={() => openManager(onManageConnections)}>Manage services</SettingsAction>
                </section>
                <div className="settings-summary"><span><strong>{readyConnections}</strong><small>Ready</small></span><span><strong>{connections.length - readyConnections}</strong><small>Need attention</small></span><span><strong>{contract.requiredConnections.length}</strong><small>Used by this harness</small></span></div>
                <section className="settings-service-list" aria-label="Saved services">
                  {connections.length ? connections.map((connection) => <article key={connection.id}><span className={`service-state is-${connectionCanRun(connection) ? "ready" : "blocked"}`} /><span><strong>{connection.name}</strong><small>{connectionKindLabel(connection.kind)} · {connection.scope}</small></span><em>{connection.status.replaceAll("_", " ")}</em></article>) : <div className="settings-empty"><strong>No services connected</strong><p>Add a model Provider, search engine, MCP server, HTTP API, or isolated local runtime.</p><SettingsAction onClick={() => openManager(onManageConnections)}>Add the first service</SettingsAction></div>}
                </section>
              </>}

              {page === "extensions" && <>
                <section className="settings-extension-grid">
                  <article><span className="settings-extension-icon">T</span><div><h3>Custom tools</h3><p>Wrap approved HTTP endpoints as typed Tools that agents can call.</p><strong>{toolCount} available</strong></div><SettingsAction onClick={() => openManager(onManageTools)}>Manage tools</SettingsAction></article>
                  <article><span className="settings-extension-icon">S</span><div><h3>Agent skills</h3><p>Install portable instructions and explicitly review scripts before trust.</p><strong>{skillCount} installed</strong></div><SettingsAction onClick={() => openManager(onManageSkills)}>Manage skills</SettingsAction></article>
                </section>
              </>}

              {page === "runtime" && <>
                <section className="settings-section">
                  <div><h3>Declared capabilities</h3><p>These capabilities are derived from the current HarnessSpec and remain identical across SDK, CLI, HTTP, and MCP.</p></div>
                  <div className="settings-capabilities">{contract.capabilities.length ? contract.capabilities.map((capability) => <span key={capability}>{capability.replaceAll("-", " ")}</span>) : <span>text runtime</span>}</div>
                </section>
                <section className="settings-section">
                  <div><h3>Safety boundaries</h3><p>Runtime limits are enforced by Core, not by this interface.</p></div>
                  <dl className="settings-runtime-list">
                    <div><dt>Conversation replay</dt><dd>Latest 20 messages · 64 KiB</dd></div>
                    <div><dt>Local history</dt><dd>30 inactive days</dd></div>
                    <div><dt>Code and MCP stdio</dt><dd>Approved container Connection</dd></div>
                    <div><dt>Integration surfaces</dt><dd>{contract.integrationSurfaces.map(({ id }) => id.toUpperCase()).join(" · ")}</dd></div>
                  </dl>
                </section>
              </>}
            </div>
          </section>
        </Dialog.Popup>
      </Dialog.Viewport>
    </Dialog.Portal>
  </Dialog.Root>;
}
