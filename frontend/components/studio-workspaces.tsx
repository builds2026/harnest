"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Diagnostic, HarnessIntegrationContract, RunEvent } from "@harnestai/core";
import { apiErrorMessage, requestJson } from "@/lib/api-client";
import { connectionCanRun, type ConnectionSummary } from "@/lib/connections";
import { connectionLabel } from "@/i18n/manifest";
import type { Translator } from "@/i18n/core";
import { useI18n } from "./i18n-provider";
import { Button, ConfirmDialog, EmptyState, InlineNotice, Input, SelectControl, Skeleton } from "./ui/ui";
import { Markdown } from "./markdown";
import { groupTraceEvents } from "@/lib/trace-view";
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

export const storedRunStatus = (run: StoredRun) => run.status?.trim().toLocaleLowerCase() || "unknown";

export function filterStoredRuns(runs: readonly StoredRun[], query: string, status: string): StoredRun[] {
  const needle = query.trim().toLocaleLowerCase();
  return runs.filter((run) => {
    const runStatus = storedRunStatus(run);
    return (status === "all" || runStatus === status)
      && (!needle || run.runId.toLocaleLowerCase().includes(needle) || runStatus.includes(needle));
  });
}

export const serializeRunTrace = (runId: string, events: readonly RunEvent[]) => JSON.stringify({
  version: 1,
  runId,
  eventCount: events.length,
  events,
}, null, 2);

export function runSelectionUrl(href: string, runId?: string): string {
  const url = new URL(href);
  if (runId) url.searchParams.set("runId", runId);
  else url.searchParams.delete("runId");
  return `${url.pathname}${url.search}${url.hash}`;
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
    case "context-compaction": return t("runs.event.contextCompaction", { node: String(data.nodeId), before: String(data.beforeBytes ?? 0), after: String(data.afterBytes ?? 0) });
    case "prompt-cache": return t("runs.event.promptCache", { node: String(data.nodeId), status: String(data.status ?? "unknown") });
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
    case "artifact": case "artifact-created": case "artifact-updated": {
      const artifact = data.artifact as { name?: unknown; size?: unknown } | undefined;
      return t("runs.event.artifact", { name: String(artifact?.name ?? "artifact"), size: String(artifact?.size ?? 0) });
    }
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
  const requiredConnectionName = (id: string) => connections.find((connection) => connection.id === id)?.name ?? id;
  const snippets = [
    { id: "sdk", label: "TypeScript SDK", code: `const harness = await Harnest.load(${JSON.stringify(filename)});\nconst result = await harness.invoke(input);\nawait harness.close();` },
    { id: "cli", label: "CLI", code: `harnest validate ${filename}\nharnest run ${filename} --input '{"message":"hello"}'` },
    { id: "http", label: "HTTP", code: `harnest serve ${filename} --port 8787\ncurl -X POST http://127.0.0.1:8787/invoke \\\n  -H 'content-type: application/json' \\\n  -d '{"input":"hello"}'` },
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
      <div><span>{t("integrate.services")}</span><strong>{contract.requiredConnections.length}</strong><small>{contract.requiredConnections.map(requiredConnectionName).join(" · ") || t("integrate.noConnections")}</small></div>
      <div><span>{t("integrate.output")}</span><strong>{contract.output?.format ?? t("integrate.customOutput")}</strong><small>{contract.output?.schemaDeclared ? t("integrate.schemaDeclared") : t("integrate.entrypoint", { id: contract.entrypoint })}</small></div>
    </div>
    <div className="contract-layout">
      <section className="contract-capabilities"><header><div><span className="sheet-eyebrow">{t("integrate.runtimeTruth")}</span><h2>{t("integrate.capabilities")}</h2></div><button className="button" onClick={download}>{t("integrate.downloadJson")}</button></header>
        <div className="capability-grid">{contract.capabilities.length ? contract.capabilities.map((capability) => <span key={capability}>{capability.replaceAll("-", " ")}</span>) : <p>{t("integrate.noCapabilities")}</p>}</div>
        {contract.capabilities.includes("code-sandbox") && <div className="sandbox-contract"><strong>{t("integrate.fileContract")}</strong><div><span>{t("integrate.upload")}</span><i>→</i><span>{t("integrate.readOnly")}</span><i>→</i><span>{t("integrate.isolated")}</span><i>→</i><span>{t("integrate.artifacts")}</span></div><p>{t("integrate.fileHelp")}</p></div>}
        <div className="contract-list"><h3>{t("integrate.requiredConnections")}</h3>{!connectionsLoaded ? <Skeleton lines={3} label={t("integrate.connectionsLoading")} /> : contract.requiredConnections.length ? contract.requiredConnections.map((id) => {
          const connection = connections.find((candidate) => candidate.id === id);
          const running = connection ? connectionCanRun(connection) : false;
          return <div key={id}><span className={`contract-state ${running ? "is-ready" : "is-blocked"}`} aria-hidden="true" /><span><strong>{requiredConnectionName(id)}</strong><small>{connection ? `${connectionLabel(t, connection.kind)} · ${t(`connections.status.${connection.status}`)}` : t("integrate.connectionSetup", { id })}</small></span>{!running && <button className="button" onClick={onOpenConnections}>{t("common.connect")}</button>}</div>;
        }) : <EmptyState compact title={t("integrate.noRequiredConnectionsTitle")} description={t("integrate.noRequiredConnections")} />}</div>
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
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deletingRunId, setDeletingRunId] = useState("");
  const [deletedRunIds, setDeletedRunIds] = useState<readonly string[]>([]);
  const [feedback, setFeedback] = useState<{ tone: "success" | "danger"; title: string; message: string }>();
  const pendingUrlSelection = useRef("");
  const availableRuns = useMemo(() => runs.filter(({ runId }) => !deletedRunIds.includes(runId)), [deletedRunIds, runs]);
  const visibleRuns = useMemo(() => filterStoredRuns(availableRuns, query, status), [availableRuns, query, status]);
  const statuses = useMemo(() => [...new Set(availableRuns.map(storedRunStatus))].sort(), [availableRuns]);
  const selectedStoredRun = availableRuns.find(({ runId }) => runId === selectedRunId);
  const selectedWasDeleted = Boolean(selectedRunId && deletedRunIds.includes(selectedRunId));
  const selectedEvents = selectedWasDeleted ? [] : events;
  const terminal = selectedEvents.findLast((event) => event.type === "run-end" || event.type === "error");
  const terminalData = terminal ? eventData(terminal) : undefined;
  const result = terminal?.type === "run-end" ? terminalData?.output : terminalData?.message;
  const resultText = typeof result === "string" ? result : result === undefined ? "" : JSON.stringify(result, null, 2);
  const groupedEvents = useMemo(() => groupTraceEvents(selectedEvents), [selectedEvents]);
  const loadingEmpty = phase === "loading" && availableRuns.length === 0;
  const statusLabel = (value: string) => {
    switch (value) {
      case "running": return t("runs.status.running");
      case "succeeded": return t("runs.status.succeeded");
      case "failed": return t("runs.status.failed");
      case "cancelled": return t("runs.status.cancelled");
      default: return t("runs.status.unknown");
    }
  };
  const updateSelectionUrl = (runId?: string, replace = false) => {
    const nextUrl = runSelectionUrl(globalThis.location.href, runId);
    if (nextUrl === globalThis.location.href) return;
    globalThis.history[replace ? "replaceState" : "pushState"](globalThis.history.state, "", nextUrl);
  };
  const inspectRun = (run: StoredRun) => {
    setFeedback(undefined);
    pendingUrlSelection.current = run.runId;
    updateSelectionUrl(run.runId);
    onInspect(run);
  };
  const exportTrace = () => {
    if (!selectedRunId || selectedEvents.length === 0) return;
    const url = URL.createObjectURL(new Blob([serializeRunTrace(selectedRunId, selectedEvents)], { type: "application/json" }));
    const link = globalThis.document.createElement("a");
    link.href = url;
    link.download = `${selectedRunId.replace(/[^A-Za-z0-9._-]/gu, "_")}.trace.json`;
    link.click();
    URL.revokeObjectURL(url);
  };
  const removeRun = async () => {
    if (!selectedStoredRun || deletingRunId) return;
    const target = selectedStoredRun;
    setDeletingRunId(target.runId);
    setFeedback(undefined);
    try {
      await requestJson(`/api/runs/${encodeURIComponent(target.runId)}?persisted=1`, { method: "DELETE" });
      const remaining = availableRuns.filter(({ runId }) => runId !== target.runId);
      setDeletedRunIds((current) => [...current, target.runId]);
      const next = remaining[0];
      updateSelectionUrl(next?.runId, true);
      if (next) {
        pendingUrlSelection.current = next.runId;
        onInspect(next);
      }
      onRefresh();
      setFeedback({ tone: "success", title: t("runs.delete.successTitle"), message: t("runs.delete.success", { id: target.runId }) });
    } catch (error) {
      setFeedback({ tone: "danger", title: t("runs.delete.errorTitle"), message: apiErrorMessage(error, t("runs.delete.error"), t) });
    } finally {
      setDeletingRunId("");
    }
  };

  useEffect(() => {
    const inspectFromUrl = () => {
      const requestedRunId = new URL(globalThis.location.href).searchParams.get("runId");
      const requested = requestedRunId ? availableRuns.find(({ runId }) => runId === requestedRunId) : undefined;
      if (!requested || requested.runId === selectedRunId) {
        pendingUrlSelection.current = "";
        return;
      }
      if (pendingUrlSelection.current !== requested.runId) {
        pendingUrlSelection.current = requested.runId;
        onInspect(requested);
      }
    };
    inspectFromUrl();
    globalThis.addEventListener("popstate", inspectFromUrl);
    return () => globalThis.removeEventListener("popstate", inspectFromUrl);
  }, [availableRuns, onInspect, selectedRunId]);

  return <section className={styles.runsWorkspace} aria-labelledby="runs-title">
    <header className={styles.runsHero}><div><span className="sheet-eyebrow">{t("runs.eyebrow")}</span><h1 id="runs-title">{t("runs.title")}</h1><p>{t("runs.description")}</p></div><Button loading={phase === "loading"} onClick={onRefresh}>{t("common.refresh")}</Button></header>
    <div className={styles.runsLayout}>
      <aside className={`run-history ${styles.runsHistory}`} aria-label={t("runs.title")}>
        <div className={styles.runFilters}>
          <Input type="search" aria-label={t("runs.search.label")} placeholder={t("runs.search.placeholder")} value={query} onChange={(event) => setQuery(event.target.value)} />
          <SelectControl label={t("runs.filter.status")} value={status} options={[{ value: "all", label: t("runs.filter.all") }, ...statuses.map((value) => ({ value, label: statusLabel(value) }))]} onValueChange={setStatus} />
          <span className={styles.runCount} role="status">{t("runs.count", { visible: visibleRuns.length, total: availableRuns.length })}</span>
        </div>
        <div className={styles.runsList}>
          {loadingEmpty ? <Skeleton lines={5} label={t("runs.loading")} /> : availableRuns.length ? visibleRuns.length ? visibleRuns.map((stored) => <button key={stored.runId} type="button" className={`run-history-item ${stored.runId === selectedRunId ? "is-active" : ""}`} onClick={() => inspectRun(stored)}><span>{stored.runId.slice(0, 12)}</span><small>{stored.startedAt ? formatDate(stored.startedAt, { dateStyle: "medium", timeStyle: "short" }) : t("runs.stored")}</small><em>{[statusLabel(storedRunStatus(stored)), stored.durationMs === undefined ? "" : `${formatNumber(Math.round(stored.durationMs))} ms`].filter(Boolean).join(" · ")}</em></button>) : <EmptyState compact title={t("runs.search.emptyTitle")} description={t("runs.search.emptyDescription")} /> : phase === "error" ? <EmptyState compact title={t("runs.unavailable")} description={t("runs.empty.description")} action={<Button onClick={onRefresh}>{t("common.retry")}</Button>} /> : <EmptyState compact title={t("runs.empty.title")} description={t("runs.empty.description")} action={<Button variant="primary" onClick={onOpenPlayground}>{t("nav.openPlayground")}</Button>} />}
        </div>
      </aside>
      <div className={`trace-events ${styles.runsTrace}`}>
        <div className={styles.runTraceToolbar}>
          <div><strong>{selectedStoredRun?.runId ?? t("runs.select.title")}</strong>{selectedStoredRun && <small>{statusLabel(storedRunStatus(selectedStoredRun))}</small>}</div>
          <span><Button size="small" disabled={!selectedRunId || selectedEvents.length === 0} onClick={exportTrace}>{t("runs.exportTrace")}</Button><Button size="small" variant="danger" loading={deletingRunId === selectedRunId} disabled={!selectedStoredRun || Boolean(deletingRunId)} onClick={() => setConfirmDelete(true)}>{t("common.delete")}</Button></span>
        </div>
        {feedback && <div className={styles.runNotice}><InlineNotice tone={feedback.tone} title={feedback.title}>{feedback.message}</InlineNotice></div>}
        {terminal && <section className={`${styles.runOutcome} ${terminal.type === "error" ? styles.runOutcomeError : ""}`}>
          <span>{t(terminal.type === "run-end" ? "runs.result.title" : "runs.result.failed")}</span>
          {typeof result === "string" ? <Markdown>{resultText || t("runs.result.empty")}</Markdown> : <pre>{resultText || t("runs.result.empty")}</pre>}
        </section>}
        {loadingEmpty ? <Skeleton lines={8} label={t("runs.loading")} /> : groupedEvents.length ? <ul className="trace-list">{groupedEvents.map((group, index) => {
          const event = group.event;
          const artifactEvent = event.type === "artifact" || event.type === "artifact-created" || event.type === "artifact-updated" ? event : undefined;
          const artifactUrl = artifactEvent
            ? `/api/artifacts?runId=${encodeURIComponent(event.runId)}&artifactId=${encodeURIComponent(artifactEvent.artifact.id)}`
            : undefined;
          return <li key={`${event.type}:${event.timestamp}:${index}`}><details className="trace-detail"><summary><span className="trace-time">{formatTime(event.timestamp)}</span><span className="trace-message">{eventSummary(event, t)}</span><span className="trace-meta">{event.type}{group.events.length > 1 ? ` ×${group.events.length}` : ""}</span></summary>{artifactUrl && artifactEvent ? <div className={styles.artifactPreview}>{artifactEvent.artifact.preview === "image" && <img src={artifactUrl} alt={artifactEvent.artifact.name} />}{artifactEvent.artifact.preview === "video" && <video src={artifactUrl} controls preload="metadata" />}{artifactEvent.artifact.preview === "audio" && <audio src={artifactUrl} controls preload="metadata" />}<a className="button" href={`${artifactUrl}&download=1`}>{t("common.download")}</a></div> : null}<details className="trace-raw"><summary>{t("common.details")}</summary><pre>{JSON.stringify(group.events.length === 1 ? event : group.events, null, 2)}</pre></details>{eventNodeId(event) && <Button size="small" onClick={() => onShowComponent(eventNodeId(event)!)}>{t("runs.showComponent")}</Button>}</details></li>;
        })}</ul> : <EmptyState title={availableRuns.length ? t("runs.select.title") : t("runs.empty.title")} description={availableRuns.length ? t("runs.select.description") : t("runs.empty.description")} />}
      </div>
    </div>
    <ConfirmDialog open={confirmDelete} title={t("runs.delete.title")} description={t("runs.delete.description", { id: selectedStoredRun?.runId ?? "" })} confirmLabel={t("common.delete")} cancelLabel={t("common.cancel")} danger onOpenChange={setConfirmDelete} onConfirm={() => void removeRun()} />
  </section>;
}
