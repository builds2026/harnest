"use client";

import { useState } from "react";
import type { Diagnostic, HarnessIntegrationContract, RunEvent } from "@harnest/core";
import { connectionCanRun, type ConnectionSummary } from "@/lib/connections";
import { connectionLabel } from "@/i18n/manifest";
import type { Translator } from "@/i18n/core";
import { useI18n } from "./i18n-provider";
import { Button, EmptyState } from "./ui/ui";
import styles from "./studio-surfaces.module.css";

export interface StoredRun {
  runId: string;
  startedAt?: string;
  status?: string;
  durationMs?: number;
  usage?: unknown;
  costUsd?: number;
  events?: RunEvent[];
}

const eventData = (event: RunEvent) => event as unknown as Record<string, unknown>;

export const eventNodeId = (event: RunEvent) => {
  const value = eventData(event).nodeId;
  return typeof value === "string" ? value : undefined;
};

export const eventSummary = (event: RunEvent, t: Translator) => {
  const data = eventData(event);
  switch (data.type) {
    case "run-start": return t("runs.event.runStart", { id: String(data.runId) });
    case "node-start": return t(typeof data.iteration === "number" ? "runs.event.nodeIteration" : "runs.event.nodeStart", { node: String(data.nodeId), iteration: Number(data.iteration ?? 0) });
    case "text-delta": return String(data.text ?? "");
    case "usage": return t("runs.event.usage", { node: String(data.nodeId) });
    case "node-end": return t("runs.event.nodeEnd", { node: String(data.nodeId), duration: Math.round(Number(data.durationMs ?? 0)) });
    case "edge": {
      const from = data.from as { component?: unknown; port?: unknown } | undefined;
      const to = data.to as { component?: unknown; port?: unknown } | undefined;
      return `${String(from?.component ?? "edge")}.${String(from?.port ?? "output")} → ${String(to?.component ?? "next")}.${String(to?.port ?? "input")}`;
    }
    case "node-skip": return t("runs.event.nodeSkip", { node: String(data.nodeId) });
    case "retry": return t("runs.event.retry", { node: String(data.nodeId), attempt: String(data.attempt ?? "") });
    case "iteration": return t("runs.event.iteration", { node: String(data.nodeId ?? "Loop"), iteration: String(data.iteration ?? "") });
    case "context-use": return t("runs.event.context", { node: String(data.nodeId), source: String(data.source ?? data.contextId ?? "context") });
    case "tool-call": return [t("runs.event.toolCall", { node: String(data.nodeId), tool: String(data.tool ?? data.toolName ?? "tool") }), typeof data.turn === "number" ? t("runs.event.turn", { turn: data.turn }) : "", data.risk ? String(data.risk) : ""].filter(Boolean).join(" · ");
    case "tool-approval": return t(data.approved === false ? "runs.event.toolDenied" : "runs.event.toolApproved", { tool: String(data.tool ?? "Tool"), source: String(data.source ?? "policy") });
    case "tool-result": return [t(data.ok === false ? "runs.event.toolFailed" : "runs.event.toolReturned", { tool: String(data.tool ?? data.toolName ?? "Tool") }), typeof data.turn === "number" ? t("runs.event.turn", { turn: data.turn }) : ""].filter(Boolean).join(" · ");
    case "tool-turn": return t("runs.event.toolTurn", { node: String(data.nodeId ?? "Agent"), turn: String(data.turn ?? "") });
    case "approval-request": return t("runs.event.approvalRequired", { tool: String(data.tool ?? data.toolName ?? "tool"), turn: String(data.turn ?? "") });
    case "approval": return t(data.approved === false ? "runs.event.denied" : "runs.event.approved", { tool: String(data.tool ?? data.toolName ?? "Tool") });
    case "skill-activate": return t("runs.event.skillActivated", { node: String(data.nodeId ?? "Agent"), skill: String(data.skill ?? data.skillId ?? "skill") });
    case "skill-resource": return t("runs.event.skillResource", { skill: String(data.skill ?? data.skillId ?? "Skill"), resource: String(data.resource ?? "resource") });
    case "skill-use": return [t("runs.event.skillActivated", { node: String(data.nodeId ?? "Agent"), skill: String(data.skill ?? "skill") }), Array.isArray(data.resources) ? t("runs.event.resources", { count: data.resources.length }) : "", data.trusted === false ? t("runs.event.scriptsUntrusted") : ""].filter(Boolean).join(" · ");
    case "fallback": return t("runs.event.fallback", { from: String(data.from ?? "Primary provider"), to: String(data.to ?? "fallback provider"), turn: String(data.turn ?? "") });
    case "evaluation": return t(data.passed === false ? "runs.event.evaluationFailed" : "runs.event.evaluationPassed", { node: String(data.nodeId ?? "Evaluator") });
    case "run-end": return t("runs.event.runEnd", { duration: Math.round(Number(data.durationMs ?? 0)) });
    case "error": return String(data.message ?? t("runs.event.runFailed"));
    default: return String(data.type ?? t("runs.event.unknown"));
  }
};

export function IntegrationWorkspace({
  contract,
  diagnostics,
  connections,
  connectionsLoaded,
  verified,
  file,
  onOpenBuilder,
  onOpenConnections,
}: {
  contract: HarnessIntegrationContract;
  diagnostics: readonly Diagnostic[];
  connections: readonly ConnectionSummary[];
  connectionsLoaded: boolean;
  verified: boolean;
  file: string;
  onOpenBuilder: () => void;
  onOpenConnections: () => void;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState<string>();
  const filename = file.split(/[\\/]/).pop() ?? "harnest.yaml";
  const missingConnections = connectionsLoaded
    ? contract.requiredConnections.filter((id) => !connections.some((connection) => connection.id === id && connectionCanRun(connection)))
    : [];
  const errors = diagnostics.filter(({ severity }) => severity === "error");
  const ready = verified && missingConnections.length === 0 && errors.length === 0;
  const blockerCount = errors.length + missingConnections.length + Number(!verified);
  const snippets = [
    { id: "sdk", label: "TypeScript SDK", code: `const harness = await Harnest.load(${JSON.stringify(filename)});\nconst result = await harness.invoke(input);\nawait harness.close();` },
    { id: "cli", label: "CLI", code: `harnest validate ${filename}\nharnest run ${filename} --input '{"message":"hello"}'` },
    { id: "http", label: "HTTP", code: `harnest serve ${filename} --port 8787\ncurl -X POST http://127.0.0.1:8787/invoke \\\n  -H 'content-type: application/json' \\\n  -d '{"input":"hello"}'` },
    { id: "mcp", label: "MCP", code: `harnest mcp serve ${filename}` },
  ] as const;
  const copy = async (id: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(id);
    } catch {
      setCopied(`error:${id}`);
    }
    window.setTimeout(() => setCopied((current) => current === id || current === `error:${id}` ? undefined : current), 1_500);
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(contract, null, 2)], { type: "application/json" }));
    const link = globalThis.document.createElement("a");
    link.href = url;
    link.download = `${filename.replace(/\.ya?ml$/i, "")}.contract.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return <section className="integrate-workspace" aria-labelledby="integrate-title">
    <header className="integrate-hero">
      <div><span className="sheet-eyebrow">{t("integrate.eyebrow")}</span><h1 id="integrate-title">{t("integrate.title")}</h1><p>{t("integrate.description")}</p></div>
      <div className={`contract-readiness ${ready ? "is-ready" : "is-blocked"}`}><span>{ready ? t("integrate.ready") : connectionsLoaded ? t("integrate.blocked") : t("integrate.checking")}</span><strong>{ready ? t("integrate.verified", { count: contract.componentCount }) : t("integrate.blockers", { count: blockerCount })}</strong><small>HarnessSpec {contract.specVersion} · contract v{contract.contractVersion}</small></div>
    </header>
    <div className="contract-metrics" aria-label={t("integrate.summary")}>
      <div><span>{t("integrate.graph")}</span><strong>{contract.graphCount}</strong><small>{t("integrate.graphDetail", { components: contract.componentCount, connections: contract.connectionCount })}</small></div>
      <div><span>{t("integrate.tests")}</span><strong>{contract.tests.count}</strong><small>{contract.tests.assertionTypes.join(" · ") || t("integrate.noAssertions")}</small></div>
      <div><span>{t("integrate.services")}</span><strong>{contract.requiredConnections.length}</strong><small>{contract.requiredConnections.join(" · ") || t("integrate.noConnections")}</small></div>
      <div><span>{t("integrate.output")}</span><strong>{contract.output?.format ?? t("integrate.customOutput")}</strong><small>{contract.output?.schemaDeclared ? t("integrate.schemaDeclared") : t("integrate.entrypoint", { id: contract.entrypoint })}</small></div>
    </div>
    <div className="contract-layout">
      <section className="contract-capabilities"><header><div><span className="sheet-eyebrow">{t("integrate.runtimeTruth")}</span><h2>{t("integrate.capabilities")}</h2></div><button className="button" onClick={download}>{t("integrate.downloadJson")}</button></header>
        <div className="capability-grid">{contract.capabilities.length ? contract.capabilities.map((capability) => <span key={capability}>{capability.replaceAll("-", " ")}</span>) : <p>{t("integrate.noCapabilities")}</p>}</div>
        {contract.capabilities.includes("code-sandbox") && <div className="sandbox-contract"><strong>{t("integrate.fileContract")}</strong><div><span>{t("integrate.upload")}</span><i>→</i><span>{t("integrate.readOnly")}</span><i>→</i><span>{t("integrate.isolated")}</span><i>→</i><span>{t("integrate.artifacts")}</span></div><p>{t("integrate.fileHelp")}</p></div>}
        <div className="contract-list"><h3>{t("integrate.requiredConnections")}</h3>{contract.requiredConnections.length ? contract.requiredConnections.map((id) => {
          const connection = connections.find((candidate) => candidate.id === id);
          const running = connection ? connectionCanRun(connection) : false;
          return <div key={id}><span className={`contract-state ${running ? "is-ready" : "is-blocked"}`} aria-hidden="true" /><span><strong>{id}</strong><small>{connection ? `${connectionLabel(t, connection.kind)} · ${t(`connections.status.${connection.status}`)}` : t("integrate.connectionMissing")}</small></span>{!running && <button className="button" onClick={onOpenConnections}>{t("common.connect")}</button>}</div>;
        }) : <p>{t("integrate.noRequiredConnections")}</p>}</div>
        {!ready && <div className="contract-blockers" role="status"><strong>{t("integrate.integrationBlockers")}</strong><ul>{!verified && <li>{connectionsLoaded ? t("integrate.saveValidate") : t("integrate.connectionsLoading")}</li>}{missingConnections.map((id) => <li key={id}>{t("integrate.connectTest", { id })}</li>)}{errors.slice(0, 6).map((diagnostic, index) => <li key={`${diagnostic.code}:${index}`}>{diagnostic.message}</li>)}</ul><button className="button" onClick={onOpenBuilder}>{t("integrate.resolveBuilder")}</button></div>}
      </section>
      <section className="integration-snippets"><header><span className="sheet-eyebrow">{t("integrate.recipesEyebrow")}</span><h2>{t("integrate.recipes")}</h2></header>{snippets.map((snippet) => <article key={snippet.id}><div><strong>{snippet.label}</strong><button type="button" onClick={() => void copy(snippet.id, snippet.code)}>{copied === snippet.id ? t("common.copied") : copied === `error:${snippet.id}` ? t("common.copyFailed") : t("common.copy")}</button></div><pre><code>{snippet.code}</code></pre></article>)}</section>
    </div>
  </section>;
}

export function RunsWorkspace({ runs, phase, selectedRunId, events, onRefresh, onInspect, onShowComponent, onOpenPlayground }: {
  runs: readonly StoredRun[];
  phase: "idle" | "loading" | "error";
  selectedRunId: string;
  events: readonly RunEvent[];
  onRefresh: () => void;
  onInspect: (run: StoredRun) => void;
  onShowComponent: (nodeId: string) => void;
  onOpenPlayground: () => void;
}) {
  const { t, formatDate, formatTime, formatNumber } = useI18n();
  return <section className={styles.runsWorkspace} aria-labelledby="runs-title">
    <header className={styles.runsHero}><div><span className="sheet-eyebrow">{t("runs.eyebrow")}</span><h1 id="runs-title">{t("runs.title")}</h1><p>{t("runs.description")}</p></div><Button loading={phase === "loading"} onClick={onRefresh}>{t("common.refresh")}</Button></header>
    <div className={styles.runsLayout}>
      <aside className={`run-history ${styles.runsHistory}`} aria-label={t("runs.title")}>
        {runs.length ? runs.map((stored) => <button key={stored.runId} className={`run-history-item ${stored.runId === selectedRunId ? "is-active" : ""}`} onClick={() => onInspect(stored)}><span>{stored.runId.slice(0, 12)}</span><small>{stored.startedAt ? formatDate(stored.startedAt, { dateStyle: "medium", timeStyle: "short" }) : stored.status ?? t("runs.stored")}</small><em>{stored.durationMs === undefined ? "" : `${formatNumber(Math.round(stored.durationMs))} ms`}</em></button>) : phase === "error" ? <EmptyState compact title={t("runs.unavailable")} description={t("runs.empty.description")} action={<Button onClick={onRefresh}>{t("common.retry")}</Button>} /> : <EmptyState compact title={t("runs.empty.title")} description={t("runs.empty.description")} action={<Button variant="primary" onClick={onOpenPlayground}>{t("nav.openPlayground")}</Button>} />}
      </aside>
      <div className={`trace-events ${styles.runsTrace}`}>
        {events.length ? <ul className="trace-list">{events.map((event, index) => <li key={`${event.type}:${event.timestamp}:${index}`}><details className="trace-detail"><summary><span className="trace-time">{formatTime(event.timestamp)}</span><span className="trace-message">{eventSummary(event, t)}</span><span className="trace-meta">{event.type}</span></summary><pre>{JSON.stringify(event, null, 2)}</pre>{eventNodeId(event) && <Button size="small" onClick={() => onShowComponent(eventNodeId(event)!)}>{t("runs.showComponent")}</Button>}</details></li>)}</ul> : <EmptyState title={t("runs.empty.title")} description={t("runs.empty.description")} />}
      </div>
    </div>
  </section>;
}
