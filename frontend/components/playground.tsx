"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import type { Diagnostic, RunEvent } from "@harnestai/core";
import { HarnestClient } from "@harnestai/sdk";
import { readNdjson } from "@/lib/ndjson";
import { apiErrorMessage, ClientApiError, requestJson } from "@/lib/api-client";
import { randomId } from "@/lib/random-id";
import type {
  PlaygroundCapabilities,
  PlaygroundFile,
  PlaygroundMessage,
  PlaygroundSession,
  PlaygroundSessionSummary,
} from "@/lib/playground";
import { useI18n } from "./i18n-provider";
import { InteractionRenderer, type InteractionResponseView, type InteractionView } from "./interaction-renderer";
import { ConfirmDialog } from "./ui/ui";

interface PlaygroundProject {
  readonly ready: boolean;
  readonly diagnostics: readonly Diagnostic[];
  readonly capabilities: PlaygroundCapabilities;
  readonly retentionDays: number;
  readonly sessions: readonly PlaygroundSessionSummary[];
}

interface SessionPayload extends Omit<PlaygroundProject, "sessions"> {
  readonly session: PlaygroundSession;
  readonly files: readonly PlaygroundFile[];
}

interface PlaygroundFilesEvent {
  readonly type: "playground-files";
  readonly timestamp: string;
  readonly sessionId: string;
  readonly live: boolean;
  readonly files: readonly PlaygroundFile[];
}

interface LiveRun {
  readonly events: readonly RunEvent[];
  readonly text: string;
  readonly output?: string;
  readonly error?: string;
  readonly runId?: string;
}

const responseMessage = async (response: Response) => {
  const payload = await response.json().catch(() => null) as
    | { error?: string | { message?: string }; diagnostics?: Diagnostic[] }
    | null;
  return typeof payload?.error === "string"
    ? payload.error
    : payload?.error?.message ?? payload?.diagnostics?.[0]?.message ?? `Request failed with ${response.status}`;
};

const outputText = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "null";
const bytes = (value: number) => value < 1_024 ? `${value} B`
  : value < 1_048_576 ? `${(value / 1_024).toFixed(1)} KiB`
    : `${(value / 1_048_576).toFixed(1)} MiB`;
const eventData = (event: RunEvent) => event as unknown as Record<string, unknown>;
const activeRunKey = (sessionId: string) => `harnest.playground.active-run.${sessionId}`;

function eventLabel(event: RunEvent, t: ReturnType<typeof useI18n>["t"]) {
  switch (event.type) {
    case "run-start": return t("playground.event.runStart");
    case "node-start": return t("playground.event.nodeStart", { node: event.nodeId });
    case "usage": return t("playground.event.usage", { node: event.nodeId });
    case "context-use": return t("playground.event.context", { node: event.nodeId, source: event.source });
    case "context-compaction": return t("playground.event.contextCompacted", { node: event.nodeId, before: event.beforeBytes, after: event.afterBytes });
    case "prompt-cache": return t("playground.event.promptCache", { node: event.nodeId, status: event.status });
    case "tool-call": return t("playground.event.toolRequested", { tool: event.tool });
    case "tool-approval": return t(event.approved ? "playground.event.toolApproved" : "playground.event.toolDenied", { tool: event.tool });
    case "tool-result": return t(event.ok ? "playground.event.toolCompleted" : "playground.event.toolFailed", { tool: event.tool, duration: Math.round(event.durationMs) });
    case "interaction-requested": return t("playground.event.interactionRequested", { title: event.request.title });
    case "interaction-resolved": return t("playground.event.interactionResolved");
    case "run-paused": return t(event.paused ? "playground.event.runPaused" : "playground.event.runResumed");
    case "skill-use": return t("playground.event.skill", { skill: event.skill });
    case "fallback": return t("playground.event.fallback", { from: event.from, to: event.to });
    case "retry": return t("playground.event.retry", { node: event.nodeId, attempt: event.attempt });
    case "iteration": return t("playground.event.iteration", { node: event.nodeId, iteration: event.iteration, phase: event.phase });
    case "evaluation": return t(event.passed ? "playground.event.checkPassed" : "playground.event.checkFailed", { evaluator: event.evaluator });
    case "artifact": case "artifact-created": case "artifact-updated": return t("playground.event.artifact", { name: event.artifact.name, size: event.artifact.size });
    case "node-end": return t("playground.event.nodeEnd", { node: event.nodeId, duration: Math.round(event.durationMs) });
    case "node-skip": return t("playground.event.nodeSkip", { node: event.nodeId });
    case "edge": return t("playground.event.edge", { from: event.from.component, to: event.to.component });
    case "run-end": return t("playground.event.runEnd", { duration: Math.round(event.durationMs) });
    case "error": return event.message;
    case "text-delta": return t("playground.event.streamed");
  }
}

function eventDetail(event: RunEvent): unknown {
  const data = eventData(event);
  if (event.type === "tool-call") return data.input;
  if (event.type === "tool-result") return event.ok ? data.output : data.error;
  if (event.type === "context-use") return data.metadata;
  if (event.type === "evaluation") return { score: data.score, message: data.message };
  if (event.type === "error") return { code: event.code, retryable: event.retryable };
  return undefined;
}

function TimelineRows({ events }: { events: readonly RunEvent[] }) {
  const { t, formatTime } = useI18n();
  const visible = events.filter((event) => event.type !== "text-delta" && !(event.type === "edge" && !event.active));
  if (!visible.length) return <div className="playground-timeline-empty">{t("playground.timeline.waiting")}</div>;
  return <ol className="playground-timeline-list">
    {visible.map((event, index) => {
      const detail = eventDetail(event);
      return <li className={`timeline-event is-${event.type}`} key={`${event.timestamp}:${event.type}:${index}`}>
        <span className="timeline-marker" aria-hidden="true" />
        <div><strong>{eventLabel(event, t)}</strong><small>{formatTime(event.timestamp)}</small>
          {detail !== undefined && <details><summary>{t("playground.timeline.inspect")}</summary><pre>{outputText(detail)}</pre></details>}
        </div>
      </li>;
    })}
  </ol>;
}

function RunTimeline({ runId, events, live = false }: { runId?: string; events?: readonly RunEvent[]; live?: boolean }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(live);
  const [loaded, setLoaded] = useState<readonly RunEvent[] | undefined>(events);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => { if (events) setLoaded(events); }, [events]);
  const open = async () => {
    if (!runId || loaded || loading || live) return;
    setLoading(true);
    try {
      const payload = await requestJson<{ run: { events?: RunEvent[] } }>(`/api/runs?runId=${encodeURIComponent(runId)}`);
      setLoaded(payload.run.events ?? []);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  };
  return <details className="playground-timeline" open={expanded} onToggle={(event) => { setExpanded(event.currentTarget.open); if (event.currentTarget.open) void open(); }}>
    <summary><span><strong>{live ? t("playground.timeline.live") : t("playground.timeline.saved")}</strong><small>{live ? t("playground.timeline.liveDescription") : t("playground.timeline.savedDescription")}</small></span><span>{loaded?.filter((event) => event.type !== "text-delta").length ?? "—"}</span></summary>
    <div className="playground-timeline-body">
      <p>{t("playground.timeline.disclosure")}</p>
      {loading ? <div className="playground-timeline-empty">{t("playground.timeline.loading")}</div>
        : failed ? <div className="playground-timeline-empty">{t("playground.timeline.unavailable")}</div>
          : <TimelineRows events={loaded ?? []} />}
    </div>
  </details>;
}

function FilePreview({ sessionId, file }: { sessionId: string; file?: PlaygroundFile }) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [failed, setFailed] = useState(false);
  const url = file && file.source !== "sandbox"
    ? `/api/playground/files?sessionId=${encodeURIComponent(sessionId)}&fileId=${encodeURIComponent(file.id)}` : undefined;
  useEffect(() => {
    setText("");
    setFailed(false);
    if (!url || file?.preview !== "text") return;
    const controller = new AbortController();
    fetch(url, { headers: { range: "bytes=0-262143" }, signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("preview failed");
        return response.text();
      })
      .then(setText)
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [file?.preview, url]);
  if (!file) return <div className="file-preview-empty"><span aria-hidden="true">◇</span><strong>{t("playground.file.select")}</strong><small>{t("playground.file.selectDescription")}</small></div>;
  if (file.source === "sandbox") return <div className="file-preview-empty"><span className="is-live" aria-hidden="true" /><strong>{t("playground.file.writing")}</strong><small>{file.sandboxPath}<br />{t("playground.file.writingDescription")}</small></div>;
  if (failed) return <div className="file-preview-empty"><strong>{t("playground.file.previewUnavailable")}</strong><small>{t("playground.file.previewUnavailableDescription")}</small></div>;
  if (file.preview === "image") return <img className="file-preview-media" src={url} alt={file.name} />;
  if (file.preview === "video") return <video className="file-preview-media" src={url} controls preload="metadata" />;
  if (file.preview === "audio") return <audio className="file-preview-audio" src={url} controls preload="metadata" />;
  if (file.preview === "pdf") return <iframe className="file-preview-frame" src={url} title={t("playground.files.previewNamed", { name: file.name })} sandbox="" />;
  if (file.preview === "text") return <pre className="file-preview-text">{text || t("playground.file.loadingPreview")}</pre>;
  return <div className="file-preview-empty"><span aria-hidden="true">▱</span><strong>{t("playground.file.noPreview")}</strong><small>{file.mimeType}</small></div>;
}

export function Playground({ onOpenBuilder }: { onOpenBuilder: () => void }) {
  const { t, formatDate, formatTime, formatNumber } = useI18n();
  const [project, setProject] = useState<PlaygroundProject>();
  const [session, setSession] = useState<PlaygroundSession>();
  const [files, setFiles] = useState<readonly PlaygroundFile[]>([]);
  const [liveFiles, setLiveFiles] = useState<readonly PlaygroundFile[]>([]);
  const [selectedFileIds, setSelectedFileIds] = useState<ReadonlySet<string>>(new Set());
  const [previewFileId, setPreviewFileId] = useState<string>();
  const [message, setMessage] = useState("");
  const [liveRun, setLiveRun] = useState<LiveRun>();
  const [runState, setRunState] = useState<"idle" | "running" | "paused" | "cancelling">("idle");
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState("");
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [rightTab, setRightTab] = useState<"files" | "sandbox" | "details">("files");
  const [disabledPlugins, setDisabledPlugins] = useState<ReadonlySet<string>>(new Set());
  const [modelValue, setModelValue] = useState("");
  const [pendingInteraction, setPendingInteraction] = useState<InteractionView>();
  const [queuedInteractions, setQueuedInteractions] = useState<readonly InteractionView[]>([]);
  const [interactionBusy, setInteractionBusy] = useState(false);
  const [interactionError, setInteractionError] = useState("");
  const [confirmation, setConfirmation] = useState<{
    title: string;
    description: string;
    confirmLabel: string;
    onConfirm: () => void;
  }>();
  const abortRef = useRef<AbortController | undefined>(undefined);
  const sessionLoad = useRef(0);

  useEffect(() => {
    if (pendingInteraction || !queuedInteractions.length) return;
    setPendingInteraction(queuedInteractions[0]);
    setQueuedInteractions((queued) => queued.slice(1));
  }, [pendingInteraction, queuedInteractions]);

  const acceptRunEvent = useCallback((event: RunEvent) => {
    window.dispatchEvent(new CustomEvent<RunEvent>("harnest-run-event", { detail: event }));
    if (session?.id && event.type === "run-start") localStorage.setItem(activeRunKey(session.id), event.runId);
    if (session?.id && (event.type === "run-end" || event.type === "error")) localStorage.removeItem(activeRunKey(session.id));
    setLiveRun((current) => ({
      events: [...(current?.events ?? []), event],
      text: event.type === "text-delta" ? `${current?.text ?? ""}${event.text}` : current?.text ?? "",
      ...(current?.output !== undefined ? { output: current.output } : {}),
      ...(current?.error ? { error: current.error } : {}),
      ...(event.type === "run-start" ? { runId: event.runId } : current?.runId ? { runId: current.runId } : {}),
      ...(event.type === "run-end" ? { output: outputText(event.output), runId: event.runId } : {}),
      ...(event.type === "error" ? { error: event.message, runId: event.runId } : {}),
    }));
    if (event.type === "interaction-requested") {
      setPendingInteraction((current) => {
        if (!current) return event.request;
        if (current.id !== event.request.id) setQueuedInteractions((queued) => queued.some(({ id }) => id === event.request.id)
          ? queued : [...queued, event.request]);
        return current.id === event.request.id ? event.request : current;
      });
    }
    if (event.type === "interaction-resolved") {
      setQueuedInteractions((queued) => queued.filter(({ id }) => id !== event.response.interactionId));
      setPendingInteraction((current) => current?.id === event.response.interactionId ? undefined : current);
    }
    if (event.type === "run-paused") setRunState(event.paused ? "paused" : "running");
  }, [session?.id]);

  const acceptStreamValue = useCallback((value: RunEvent | PlaygroundFilesEvent) => {
    if (value.type === "playground-files") {
      if (value.live) setLiveFiles(value.files);
      else {
        setLiveFiles([]);
        setFiles((current) => [...current.filter(({ id }) => !value.files.some((file) => file.id === id)), ...value.files]);
      }
      return;
    }
    acceptRunEvent(value);
  }, [acceptRunEvent]);

  const loadSession = useCallback(async (id: string) => {
    const request = ++sessionLoad.current;
    setLoading(true);
    try {
      const payload = await requestJson<SessionPayload>(`/api/playground?sessionId=${encodeURIComponent(id)}`);
      if (request !== sessionLoad.current) return;
      setProject((current) => current ? { ...current, ready: payload.ready, diagnostics: payload.diagnostics, capabilities: payload.capabilities, retentionDays: payload.retentionDays } : current);
      setSession(payload.session);
      setFiles(payload.files);
      setSelectedFileIds(new Set((payload.session.activeFileIds ?? []).filter((fileId) => payload.files.some(({ id: candidate }) => candidate === fileId))));
      setPreviewFileId((current) => current && payload.files.some(({ id: candidate }) => candidate === current) ? current : payload.files[0]?.id);
      setNotice("");
    } catch (error) {
      if (request === sessionLoad.current) setNotice(apiErrorMessage(error, t("playground.error.loadConversation"), t));
    } finally {
      if (request === sessionLoad.current) setLoading(false);
    }
  }, [t]);

  const refreshProject = useCallback(async () => {
    const payload = await requestJson<PlaygroundProject>("/api/playground");
    setProject(payload);
    return payload;
  }, []);

  const createSession = useCallback(async () => {
    const payload = await requestJson<{ session: PlaygroundSession }>("/api/playground", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "create" }),
    });
    setSession(payload.session);
    setFiles([]);
    setLiveFiles([]);
    setSelectedFileIds(new Set());
    setPreviewFileId(undefined);
    const index = await refreshProject();
    setProject(index);
    return payload.session;
  }, [refreshProject]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const index = await requestJson<PlaygroundProject>("/api/playground");
        if (!active) return;
        setProject(index);
        let id = index.sessions[0]?.id;
        if (!id) id = (await createSession()).id;
        if (active) await loadSession(id);
      } catch (error) {
        if (active) { setNotice(apiErrorMessage(error, t("playground.error.open"), t)); setLoading(false); }
      }
    })();
    return () => { active = false; abortRef.current?.abort(); };
  }, [createSession, loadSession]);

  useEffect(() => {
    const options = project?.capabilities.models ?? [];
    setModelValue((current) => options.some((option) => `${option.componentKey}\u0000${option.connectionId}` === current)
      ? current : options[0] ? `${options[0].componentKey}\u0000${options[0].connectionId}` : "");
    const keys = new Set(project?.capabilities.plugins.map(({ componentKey }) => componentKey) ?? []);
    setDisabledPlugins((current) => new Set([...current].filter((key) => keys.has(key))));
    if (!project?.capabilities.attachments.enabled) setRightTab("details");
  }, [project?.capabilities]);

  useEffect(() => {
    const compact = window.matchMedia("(max-width: 920px)");
    const collapse = () => {
      if (compact.matches) { setLeftOpen(false); setRightOpen(false); }
    };
    collapse();
    compact.addEventListener("change", collapse);
    return () => compact.removeEventListener("change", collapse);
  }, []);

  useEffect(() => {
    const sessionId = session?.id;
    if (!sessionId || abortRef.current) return;
    const runId = localStorage.getItem(activeRunKey(sessionId));
    if (!runId) return;
    const controller = new AbortController();
    abortRef.current = controller;
    void (async () => {
      try {
        const client = new HarnestClient(window.location.origin);
        const snapshot = await client.snapshot(runId, controller.signal) as unknown as {
          status?: string;
          pendingInteractions?: InteractionView[];
          sequence?: number;
        };
        if (["succeeded", "failed", "cancelled"].includes(snapshot.status ?? "")) {
          localStorage.removeItem(activeRunKey(sessionId));
          await loadSession(sessionId);
          return;
        }
        const history = await requestJson<{ run: { events?: RunEvent[] } }>(`/api/runs?runId=${encodeURIComponent(runId)}`);
        const prior = history.run.events ?? [];
        setLiveRun({
          runId,
          events: prior,
          text: prior.filter((event): event is Extract<RunEvent, { type: "text-delta" }> => event.type === "text-delta").map(({ text }) => text).join(""),
        });
        setPendingInteraction(snapshot.pendingInteractions?.[0]);
        setQueuedInteractions(snapshot.pendingInteractions?.slice(1) ?? []);
        setRunState(snapshot.status === "paused" ? "paused" : "running");
        let terminal = false;
        const after = Math.max(snapshot.sequence ?? 0, ...prior.map(({ sequence }) => sequence ?? 0));
        for await (const envelope of client.events(runId, { after, signal: controller.signal })) {
          const event = envelope.data as RunEvent;
          acceptRunEvent(event);
          terminal ||= event.type === "run-end" || event.type === "error";
        }
        if (terminal) {
          await loadSession(sessionId);
          await refreshProject();
          setLiveRun(undefined);
          setPendingInteraction(undefined);
          setQueuedInteractions([]);
          setRunState("idle");
        }
      } catch (error) {
        if (!controller.signal.aborted) setNotice(apiErrorMessage(error, t("playground.error.run"), t));
      } finally {
        if (abortRef.current === controller) abortRef.current = undefined;
      }
    })();
    return () => controller.abort();
  }, [acceptRunEvent, loadSession, refreshProject, session?.id, t]);

  const showLeft = () => {
    setLeftOpen(true);
    if (window.matchMedia("(max-width: 920px)").matches) setRightOpen(false);
  };

  const showRight = () => {
    setRightOpen(true);
    if (window.matchMedia("(max-width: 920px)").matches) setLeftOpen(false);
  };

  const openSession = async (id: string) => {
    if (runState !== "idle" || id === session?.id) return;
    setLiveRun(undefined);
    setLiveFiles([]);
    await loadSession(id);
  };

  const deleteSession = async (id: string) => {
    try {
      await requestJson<void>("/api/playground", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: id }),
      });
      const index = await refreshProject();
      const next = index.sessions.find(({ id: candidate }) => candidate !== id) ?? await createSession();
      await loadSession(next.id);
    } catch (error) {
      setNotice(apiErrorMessage(error, t("playground.error.deleteConversation"), t));
    }
  };

  const removeSession = (id: string) => {
    if (runState !== "idle") return;
    setConfirmation({
      title: t("playground.deleteConversation.title"),
      description: t("playground.deleteConversation.description"),
      confirmLabel: t("playground.deleteConversation.confirm"),
      onConfirm: () => void deleteSession(id),
    });
  };

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const selected = [...(event.target.files ?? [])].slice(0, project?.capabilities.attachments.maxFiles ?? 0);
    event.target.value = "";
    if (!session || !selected.length) return;
    setUploading(true);
    setNotice("");
    try {
      const added: PlaygroundFile[] = [];
      for (const file of selected) {
        const form = new FormData();
        form.set("sessionId", session.id);
        form.set("file", file);
        const payload = await requestJson<{ file: PlaygroundFile }>("/api/playground/files", { method: "POST", body: form });
        added.push(payload.file);
      }
      await loadSession(session.id);
      setSelectedFileIds((current) => new Set([...current, ...added.map(({ id }) => id)]));
      setPreviewFileId(added.at(-1)?.id);
    } catch (error) {
      setNotice(apiErrorMessage(error, t("playground.error.upload"), t));
    } finally {
      setUploading(false);
    }
  };

  const deleteFile = async (file: PlaygroundFile) => {
    if (!session) return;
    try {
      await requestJson<void>("/api/playground/files", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: session.id, fileId: file.id }),
      });
      await loadSession(session.id);
    } catch (error) {
      setNotice(apiErrorMessage(error, t("playground.error.removeFile"), t));
    }
  };

  const removeFile = (file: PlaygroundFile) => {
    if (!session || file.source === "sandbox") return;
    setConfirmation({
      title: t("playground.removeFile.title", { name: file.name }),
      description: t("playground.removeFile.description"),
      confirmLabel: t("playground.removeFile.confirm"),
      onConfirm: () => void deleteFile(file),
    });
  };

  const respondToInteraction = async (response: InteractionResponseView) => {
    if (!pendingInteraction || interactionBusy) return;
    setInteractionBusy(true);
    setInteractionError("");
    const commandId = `interaction_${randomId().replaceAll("-", "")}`;
    const sendResponse = () => requestJson(`/v1/runs/${encodeURIComponent(pendingInteraction.runId)}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId, type: "interaction.response", response }),
    });
    try {
      try {
        await sendResponse();
      } catch (error) {
        if (!(error instanceof ClientApiError) || error.details.code !== "RUN_NOT_ACTIVE" || !session || !project) throw error;
        const lastUserMessage = [...session.messages].reverse().find(({ role }) => role === "user")?.content;
        if (!lastUserMessage) throw error;
        const controller = new AbortController();
        abortRef.current = controller;
        const selectedModel = project.capabilities.models.find((option) => `${option.componentKey}\u0000${option.connectionId}` === modelValue);
        const resumed = await fetch("/api/playground/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionId: session.id,
            message: lastUserMessage,
            resumeRunId: pendingInteraction.runId,
            fileIds: [...selectedFileIds],
            disabledPluginKeys: [...disabledPlugins],
            ...(selectedModel ? { model: { componentKey: selectedModel.componentKey, connectionId: selectedModel.connectionId } } : {}),
          }),
          signal: controller.signal,
        });
        if (!resumed.ok) throw new Error(await responseMessage(resumed), { cause: error });
        void readNdjson<RunEvent | PlaygroundFilesEvent>(resumed, acceptStreamValue).then(async () => {
          await loadSession(session.id);
          await refreshProject();
          setLiveRun(undefined);
          setRunState("idle");
        }).catch((streamError: unknown) => {
          if (!controller.signal.aborted) setNotice(apiErrorMessage(streamError, t("playground.error.run"), t));
        });
        await sendResponse();
      }
      setPendingInteraction(queuedInteractions[0]);
      setQueuedInteractions((queued) => queued.slice(1));
      setRunState(queuedInteractions.length ? "paused" : "running");
    } catch (error) {
      setInteractionError(apiErrorMessage(error, t("playground.error.approval"), t));
    } finally {
      setInteractionBusy(false);
    }
  };

  const run = async () => {
    const input = message.trim();
    if (!input || !session || !project?.ready || runState !== "idle") return;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunState("running");
    setNotice("");
    setLiveFiles([]);
    setPendingInteraction(undefined);
    setQueuedInteractions([]);
    setInteractionError("");
    const optimistic: PlaygroundMessage = { id: `local-${Date.now()}`, role: "user", content: input, createdAt: new Date().toISOString(), fileIds: [...selectedFileIds] };
    setSession((current) => current ? { ...current, messages: [...current.messages, optimistic] } : current);
    setMessage("");
    setLiveRun({ events: [], text: "" });
    const selectedModel = project.capabilities.models.find((option) => `${option.componentKey}\u0000${option.connectionId}` === modelValue);
    try {
      const response = await fetch("/api/playground/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: session.id,
          message: input,
          fileIds: [...selectedFileIds],
          disabledPluginKeys: [...disabledPlugins],
          ...(selectedModel ? { model: { componentKey: selectedModel.componentKey, connectionId: selectedModel.connectionId } } : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      await readNdjson<RunEvent | PlaygroundFilesEvent>(response, acceptStreamValue);
      await loadSession(session.id);
      await refreshProject();
      setLiveRun(undefined);
    } catch (error) {
      if (controller.signal.aborted) {
        setLiveRun((current) => current ? { ...current, error: t("playground.runCancelled") } : current);
        await new Promise((resolve) => setTimeout(resolve, 100));
        await loadSession(session.id).catch(() => undefined);
        setLiveRun(undefined);
      } else {
        setNotice(apiErrorMessage(error, t("playground.error.run"), t));
        await loadSession(session.id);
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = undefined;
      setRunState("idle");
      setLiveFiles([]);
      setPendingInteraction(undefined);
      setQueuedInteractions([]);
    }
  };

  const cancel = async () => {
    if (!abortRef.current) return;
    setRunState("cancelling");
    if (liveRun?.runId) {
      await requestJson(`/v1/runs/${encodeURIComponent(liveRun.runId)}`, { method: "DELETE" }).catch(() => undefined);
    }
    abortRef.current.abort();
    setNotice(t("playground.runCancelled"));
  };

  const togglePlugin = (key: string) => {
    setDisabledPlugins((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      const codeRunnerAvailable = project?.capabilities.plugins.some((plugin) => plugin.id === "builtin.code-runner" && !next.has(plugin.componentKey));
      if (!codeRunnerAvailable && !project?.capabilities.attachments.directModelInput) setSelectedFileIds(new Set());
      return next;
    });
  };

  const toggleFile = (id: string) => setSelectedFileIds((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const codeRunnerEnabled = Boolean(project?.capabilities.plugins.some((plugin) => plugin.id === "builtin.code-runner" && !disabledPlugins.has(plugin.componentKey)));
  const canAttach = Boolean(project?.capabilities.attachments.enabled
    && (codeRunnerEnabled || project.capabilities.attachments.directModelInput));
  const uploadedFiles = files.filter(({ source }) => source === "upload");
  const sandboxFiles = [...files.filter(({ source }) => source === "artifact"), ...liveFiles];
  const previewFile = [...files, ...liveFiles].find(({ id }) => id === previewFileId);
  const currentFiles = rightTab === "files" ? uploadedFiles : sandboxFiles;
  const selectedModel = project?.capabilities.models.find((option) => `${option.componentKey}\u0000${option.connectionId}` === modelValue);
  const readyToSend = Boolean(session && project?.ready && message.trim() && runState === "idle" && !uploading);
  const setupIssueCount = project?.diagnostics.filter(({ severity }) => severity === "error").length ?? 0;

  if (loading && !project) return <section className="playground-loading"><span className="playground-spinner" /><strong>{t("playground.loading")}</strong><small>{t("playground.loading.description")}</small></section>;

  return <section className={`playground ${leftOpen ? "has-left" : ""} ${rightOpen ? "has-right" : ""}`} aria-label={t("playground.aria")}>
    {leftOpen ? <aside className="playground-history" aria-label={t("playground.history.aria")}>
      <header><div><span className="sheet-eyebrow">{t("playground.conversations")}</span><strong>{t("playground.history")}</strong></div><button className="panel-toggle" aria-label={t("playground.history.collapse")} aria-expanded="true" onClick={() => setLeftOpen(false)}>←</button></header>
      <button className="new-chat-button" disabled={runState !== "idle"} onClick={() => void createSession().then(({ id }) => loadSession(id))}><span>＋</span> {t("playground.newConversation")}</button>
      <nav className="conversation-list" aria-label={t("playground.history.saved")}>
        {project?.sessions.map((item) => <div className={`conversation-item ${item.id === session?.id ? "is-active" : ""}`} key={item.id}>
          <button disabled={runState !== "idle"} onClick={() => void openSession(item.id)}><strong>{item.title}</strong><span>{item.preview || t("playground.noMessages")}</span><small>{formatDate(item.updatedAt, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} · {formatNumber(item.messageCount)}</small></button>
          <button className="conversation-delete" aria-label={t("playground.conversation.delete", { name: item.title })} disabled={runState !== "idle"} onClick={() => void removeSession(item.id)}>×</button>
        </div>)}
      </nav>
      <footer><span>{t("playground.localHistory")}</span><small>{t("playground.retention", { days: project?.retentionDays ?? 30 })}</small></footer>
    </aside> : <button className="collapsed-panel-button is-left" aria-label={t("playground.history.expand")} aria-expanded="false" onClick={showLeft}>{t("playground.history")} →</button>}

    <section className="playground-chat" aria-label={t("playground.conversation.aria")}>
      <header className="playground-chat-header">
        <div><span className="sheet-eyebrow">{t("playground.immutableSurface")}</span><h1>{session?.title ?? "Harnest Playground"}</h1><p>{project?.ready ? t("playground.ready") : t("playground.setupRequired")} · {t("playground.immutable")}</p></div>
        <div className="playground-chat-actions">
          {!leftOpen && <button className="button" onClick={showLeft}>{t("playground.history")}</button>}
          {!rightOpen && <button className="button" onClick={showRight}>{t("playground.files")}</button>}
        </div>
      </header>
      {notice && <div className="playground-notice" role="status"><span>{notice}</span><button aria-label={t("playground.dismiss")} onClick={() => setNotice("")}>×</button></div>}
      <div className="playground-messages" aria-live="polite">
        {!session?.messages.length && !liveRun ? <div className="playground-empty-chat"><span className="empty-chat-mark">H</span><h2>{t("playground.empty.title")}</h2><p>{t("playground.empty.description")}</p><div><span>1</span> {t("playground.attach")} <span>2</span> {t("playground.capabilities")} <span>3</span> {t("nav.playground")}</div></div> : session?.messages.map((item) => <article className={`playground-message is-${item.role}`} key={item.id}>
          <div className="message-author"><span>{item.role === "user" ? t("playground.you") : "H"}</span><strong>{item.role === "user" ? t("playground.you") : t("playground.harness")}</strong><time>{formatTime(item.createdAt)}</time></div>
          <div className="message-body"><div className="message-content">{item.content}</div>
            {item.fileIds?.length ? <div className="message-files">{item.fileIds.map((id) => <span key={id}>{files.find((file) => file.id === id)?.name ?? t("playground.attachedFile")}</span>)}</div> : null}
            {item.role === "assistant" && <><RunTimeline runId={item.runId} />{(item.usage || item.costUsd !== undefined) && <div className="message-usage"><span>{t("playground.tokens", { count: item.usage?.totalTokens ?? "—" })}</span>{item.usage?.cachedInputTokens ? <span>{t("playground.cachedTokens", { count: item.usage.cachedInputTokens })}</span> : null}{item.usage?.cachedInputTokens && item.usage.inputTokens ? <span>{t("playground.cacheHitRatio", { ratio: Math.round(item.usage.cachedInputTokens / item.usage.inputTokens * 100) })}</span> : null}{item.usage?.cacheWriteInputTokens ? <span>{t("playground.cacheWriteTokens", { count: item.usage.cacheWriteInputTokens })}</span> : null}<span>${(item.costUsd ?? 0).toFixed(6)}</span><span>{item.finishReason ?? t("playground.unknown")}</span></div>}</>}
          </div>
        </article>)}
        {liveRun && <article className="playground-message is-assistant">
          <div className="message-author"><span>H</span><strong>{t("playground.harness")}</strong><time>{t("playground.now")}</time></div>
          <div className="message-body"><div className="working-label"><span className="is-live" />{runState === "cancelling" ? t("playground.cancelling") : runState === "paused" ? t("playground.waitingForInput") : liveRun.error ? t("common.needsAttention") : t("playground.working")}</div><div className="message-content">{liveRun.output ?? (liveRun.text || liveRun.error || "")}</div><RunTimeline runId={liveRun.runId} events={liveRun.events} live /></div>
        </article>}
      </div>

      <div className="playground-composer-wrap">
        {selectedFileIds.size > 0 && <div className="composer-files">{[...selectedFileIds].map((id) => { const file = files.find((candidate) => candidate.id === id); return file ? <button key={id} onClick={() => toggleFile(id)}>{file.name}<span>×</span></button> : null; })}</div>}
        <div className={`playground-composer ${!project?.ready ? "is-disabled" : ""}`}>
          <textarea aria-label={t("playground.message")} placeholder={project?.ready ? t("playground.message.placeholder") : t("playground.message.blocked")} value={message} disabled={!project?.ready || runState !== "idle"} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void run(); } }} />
          <div className="composer-toolbar">
            <div className="composer-tools">
              <label className={`composer-tool-button ${!canAttach ? "is-disabled" : ""}`} title={canAttach ? t("playground.uploadHelp") : project?.capabilities.attachments.enabled ? t("playground.runnerDisabled") : t("playground.attachRunner")}>＋<span>{t("playground.attach")}</span><input type="file" multiple accept={project?.capabilities.attachments.accepted} disabled={!canAttach || uploading || runState !== "idle"} onChange={(event) => void upload(event)} /></label>
              <details className="plugin-menu"><summary className="composer-tool-button"><span className="plugin-dot" />{t("playground.capabilities")} <small>{(project?.capabilities.plugins.length ?? 0) - disabledPlugins.size}/{project?.capabilities.plugins.length ?? 0}</small></summary><div className="plugin-menu-popover"><header><strong>{t("playground.runCapabilities")}</strong><small>{t("playground.connectedOnly")}</small></header>{project?.capabilities.plugins.length ? project.capabilities.plugins.map((plugin) => <label key={plugin.componentKey}><input type="checkbox" checked={!disabledPlugins.has(plugin.componentKey)} disabled={runState !== "idle"} onChange={() => togglePlugin(plugin.componentKey)} /><span><strong>{plugin.label}</strong><small>{plugin.kind.toLocaleUpperCase()} · {plugin.risk ?? t("playground.policyManaged")}</small></span></label>) : <p>{t("playground.noOptionalCapabilities")}</p>}</div></details>
              {project?.capabilities.models.length ? <label className="model-picker"><span className="sr-only">{t("playground.modelForRun")}</span><select value={modelValue} disabled={runState !== "idle"} onChange={(event) => setModelValue(event.target.value)}>{project.capabilities.models.map((option) => <option key={`${option.componentKey}:${option.connectionId}`} value={`${option.componentKey}\u0000${option.connectionId}`}>{option.label}</option>)}</select></label> : <span className="harness-default-model">{t("playground.harnessModel")}</span>}
            </div>
            {runState === "idle" ? <button className="send-button" disabled={!readyToSend} aria-label={t("playground.send")} onClick={() => void run()}>↑</button> : <button className="stop-button" aria-label={t("playground.cancelRun")} onClick={cancel}>■</button>}
          </div>
        </div>
        <div className="composer-footnote"><span>{selectedModel?.label ?? t("playground.savedHarnessModel")}</span><span>{t("playground.shortcut")}</span><span>{t("playground.contextLimit")}</span></div>
      </div>
    </section>

    {rightOpen ? <aside className="playground-files" aria-label={t("playground.filesAndSandbox")}>
      <header><div className="file-tabs" role="tablist" aria-label={t("playground.resources")}>
        {project?.capabilities.attachments.enabled && <button role="tab" aria-selected={rightTab === "files"} className={rightTab === "files" ? "is-active" : ""} onClick={() => setRightTab("files")}>{t("playground.uploads")} <span>{uploadedFiles.length}</span></button>}
        {project?.capabilities.attachments.enabled && <button role="tab" aria-selected={rightTab === "sandbox"} className={rightTab === "sandbox" ? "is-active" : ""} onClick={() => setRightTab("sandbox")}>{t("playground.sandbox")} <span>{sandboxFiles.length}</span></button>}
        <button role="tab" aria-selected={rightTab === "details"} className={rightTab === "details" ? "is-active" : ""} onClick={() => setRightTab("details")}>{t("playground.details")}</button>
      </div><button className="panel-toggle" aria-label={t("playground.files.collapse")} aria-expanded="true" onClick={() => setRightOpen(false)}>→</button></header>
      {rightTab === "details" ? <div className="playground-details">
        <div className={`readiness-card ${project?.ready ? "is-ready" : "is-blocked"}`}><span>{project?.ready ? t("common.ready") : t("playground.status.blocked")}</span><strong>{project?.ready ? t("playground.status.canRun") : t("playground.status.issues", { count: setupIssueCount })}</strong></div>
        <dl><div><dt>{t("playground.details.models")}</dt><dd>{project?.capabilities.models.length || t("playground.details.harnessDefault")}</dd></div><div><dt>{t("playground.details.optional")}</dt><dd>{project?.capabilities.plugins.length ?? 0}</dd></div><div><dt>{t("playground.details.workspace")}</dt><dd>{codeRunnerEnabled ? t("playground.details.codeRunner") : project?.capabilities.attachments.directModelInput ? t("playground.details.directMedia") : t("playground.details.unsupported")}</dd></div><div><dt>{t("playground.details.replay")}</dt><dd>{t("playground.details.replayValue")}</dd></div><div><dt>{t("playground.details.retention")}</dt><dd>{t("playground.details.daysInactive", { count: project?.retentionDays ?? 30 })}</dd></div></dl>
        <section><strong>{t("playground.details.isolation")}</strong><p>{t("playground.details.isolationHelp")}</p></section>
        <section><strong>{t("playground.details.cost")}</strong><p>{t("playground.details.costHelp")}</p></section>
        {project?.diagnostics.length ? <section><strong>{t("playground.details.diagnostics")}</strong><ul>{project.diagnostics.slice(0, 8).map((diagnostic, index) => <li key={`${diagnostic.code}:${index}`}>{diagnostic.message}</li>)}</ul></section> : null}
        <button className="button" onClick={() => void refreshProject().catch((error: unknown) => setNotice(apiErrorMessage(error, t("playground.error.refresh"), t)))}>{t("playground.details.refresh")}</button>
        <button className="button" onClick={onOpenBuilder}>{t("playground.details.openBuilder")}</button>
      </div> : <>
        <div className="file-explorer-heading"><div><strong>{t(rightTab === "files" ? "playground.files.conversation" : "playground.files.output")}</strong><small>{t(rightTab === "files" ? "playground.files.mountHelp" : liveFiles.length ? "playground.files.liveHelp" : "playground.files.outputHelp")}</small></div>{rightTab === "files" && <label className={`mini-upload ${!canAttach ? "is-disabled" : ""}`}>＋<input type="file" multiple accept={project?.capabilities.attachments.accepted} disabled={!canAttach || uploading} onChange={(event) => void upload(event)} /></label>}</div>
        <div className="file-list">{currentFiles.length ? currentFiles.map((file) => <div className={`file-row ${previewFileId === file.id ? "is-active" : ""}`} key={file.id}><button onClick={() => setPreviewFileId(file.id)}><span className={`file-kind is-${file.preview}`} aria-hidden="true">{file.source === "sandbox" ? "↻" : file.source === "artifact" ? "↳" : "▱"}</span><span><strong>{file.name}</strong><small>{bytes(file.size)} · {file.source === "sandbox" ? t("playground.files.writing") : file.mimeType}</small></span></button>{file.source !== "sandbox" && <label title={t("playground.files.useNext", { name: file.name })}><input type="checkbox" checked={selectedFileIds.has(file.id)} disabled={!canAttach || runState !== "idle"} onChange={() => toggleFile(file.id)} /><span className="sr-only">{t("playground.files.useNext", { name: file.name })}</span></label>} {file.source !== "sandbox" && <button className="file-remove" aria-label={t("playground.files.remove", { name: file.name })} onClick={() => void removeFile(file)}>×</button>}</div>) : <div className="file-list-empty"><span>{rightTab === "files" ? "＋" : "◇"}</span><strong>{t(rightTab === "files" ? "playground.files.emptyUploads" : "playground.files.emptyOutput")}</strong><small>{t(rightTab === "files" ? "playground.files.emptyUploadsHelp" : "playground.files.emptyOutputHelp")}</small></div>}</div>
        <div className="file-preview"><div className="file-preview-heading"><div><strong>{previewFile?.name ?? t("playground.files.preview")}</strong>{previewFile && <small>{previewFile.sandboxPath ?? previewFile.mimeType}</small>}</div>{previewFile && previewFile.source !== "sandbox" && <a className="button" href={`/api/playground/files?sessionId=${encodeURIComponent(session?.id ?? "")}&fileId=${encodeURIComponent(previewFile.id)}&download=1`}>{t("common.download")}</a>}</div><FilePreview sessionId={session?.id ?? ""} file={previewFile} /></div>
      </>}
    </aside> : <button className="collapsed-panel-button is-right" aria-label={t("playground.files.expand")} aria-expanded="false" onClick={showRight}>← {t("playground.files")}</button>}

    {pendingInteraction && <InteractionRenderer
      request={pendingInteraction}
      files={files.filter(({ source }) => source !== "sandbox")}
      busy={interactionBusy}
      error={interactionError}
      onRespond={respondToInteraction}
    />}
    {confirmation && <ConfirmDialog open title={confirmation.title} description={confirmation.description} confirmLabel={confirmation.confirmLabel} cancelLabel={t("common.cancel")} danger onConfirm={confirmation.onConfirm} onOpenChange={(open) => { if (!open) setConfirmation(undefined); }} />}
  </section>;
}
