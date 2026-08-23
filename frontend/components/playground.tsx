"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import type { Diagnostic, RunEvent } from "@harnest/core";
import { readNdjson } from "@/lib/ndjson";
import type {
  PlaygroundCapabilities,
  PlaygroundFile,
  PlaygroundMessage,
  PlaygroundSession,
  PlaygroundSessionSummary,
} from "@/lib/playground";

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

interface PendingApproval {
  readonly runId: string;
  readonly nodeId: string;
  readonly callId: string;
  readonly turn: number;
  readonly tool: string;
  readonly risk: string;
  readonly input: unknown;
  readonly inputDigest: string;
  readonly inputBytes: number;
  readonly previewLimited: boolean;
}

interface LiveRun {
  readonly events: readonly RunEvent[];
  readonly text: string;
  readonly output?: string;
  readonly error?: string;
  readonly runId?: string;
}

const RISK_LABELS: Readonly<Record<string, string>> = {
  read: "Reads data",
  write: "Changes data",
  external: "Contacts an external service",
  destructive: "Can delete or overwrite data",
};

const responseMessage = async (response: Response) => {
  const payload = await response.json().catch(() => null) as
    | { error?: string | { message?: string }; diagnostics?: Diagnostic[] }
    | null;
  return typeof payload?.error === "string"
    ? payload.error
    : payload?.error?.message ?? payload?.diagnostics?.[0]?.message ?? `Request failed with ${response.status}`;
};

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) throw new Error(await responseMessage(response));
  return response.json() as Promise<T>;
}

const outputText = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "null";
const bytes = (value: number) => value < 1_024 ? `${value} B`
  : value < 1_048_576 ? `${(value / 1_024).toFixed(1)} KiB`
    : `${(value / 1_048_576).toFixed(1)} MiB`;
const shortTime = (value: string) => new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));

const eventData = (event: RunEvent) => event as unknown as Record<string, unknown>;

function eventLabel(event: RunEvent) {
  switch (event.type) {
    case "run-start": return "Request accepted";
    case "node-start": return `${event.nodeId} started`;
    case "usage": return `${event.nodeId} reported usage`;
    case "context-use": return `${event.nodeId} loaded ${event.source}`;
    case "tool-call": return `${event.tool} requested`;
    case "tool-approval": return `${event.tool} ${event.approved ? "approved" : "denied"}`;
    case "tool-result": return `${event.tool} ${event.ok ? "completed" : "failed"} · ${Math.round(event.durationMs)}ms`;
    case "skill-use": return `${event.skill} skill loaded`;
    case "fallback": return `Model fallback · ${event.from} → ${event.to}`;
    case "retry": return `${event.nodeId} retry ${event.attempt}`;
    case "iteration": return `${event.nodeId} iteration ${event.iteration} ${event.phase}`;
    case "evaluation": return `${event.evaluator} check ${event.passed ? "passed" : "failed"}`;
    case "node-end": return `${event.nodeId} completed · ${Math.round(event.durationMs)}ms`;
    case "node-skip": return `${event.nodeId} skipped`;
    case "edge": return `${event.from.component} → ${event.to.component}`;
    case "run-end": return `Run completed · ${Math.round(event.durationMs)}ms`;
    case "error": return event.message;
    case "text-delta": return "Response streamed";
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
  const visible = events.filter((event) => event.type !== "text-delta" && !(event.type === "edge" && !event.active));
  if (!visible.length) return <div className="playground-timeline-empty">Waiting for the first observable event…</div>;
  return <ol className="playground-timeline-list">
    {visible.map((event, index) => {
      const detail = eventDetail(event);
      return <li className={`timeline-event is-${event.type}`} key={`${event.timestamp}:${event.type}:${index}`}>
        <span className="timeline-marker" aria-hidden="true" />
        <div><strong>{eventLabel(event)}</strong><small>{new Date(event.timestamp).toLocaleTimeString()}</small>
          {detail !== undefined && <details><summary>Inspect event</summary><pre>{outputText(detail)}</pre></details>}
        </div>
      </li>;
    })}
  </ol>;
}

function RunTimeline({ runId, events, live = false }: { runId?: string; events?: readonly RunEvent[]; live?: boolean }) {
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
    <summary><span><strong>{live ? "Working timeline" : "Execution timeline"}</strong><small>{live ? "Updates as components and tools run" : "Observable model, tool, skill, and routing activity"}</small></span><span>{loaded?.filter((event) => event.type !== "text-delta").length ?? "—"}</span></summary>
    <div className="playground-timeline-body">
      <p>Harnest shows runtime activity and tool evidence, not a model&apos;s private hidden reasoning.</p>
      {loading ? <div className="playground-timeline-empty">Loading run trace…</div>
        : failed ? <div className="playground-timeline-empty">This run trace is unavailable.</div>
          : <TimelineRows events={loaded ?? []} />}
    </div>
  </details>;
}

function FilePreview({ sessionId, file }: { sessionId: string; file?: PlaygroundFile }) {
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
  if (!file) return <div className="file-preview-empty"><span aria-hidden="true">◇</span><strong>Select a file</strong><small>Safe previews appear here.</small></div>;
  if (file.source === "sandbox") return <div className="file-preview-empty"><span className="is-live" aria-hidden="true" /><strong>Being written by the sandbox</strong><small>{file.sandboxPath}<br />Preview becomes available when the run completes.</small></div>;
  if (failed) return <div className="file-preview-empty"><strong>Preview unavailable</strong><small>Download the file to inspect it locally.</small></div>;
  if (file.preview === "image") return <img className="file-preview-media" src={url} alt={file.name} />;
  if (file.preview === "video") return <video className="file-preview-media" src={url} controls preload="metadata" />;
  if (file.preview === "audio") return <audio className="file-preview-audio" src={url} controls preload="metadata" />;
  if (file.preview === "pdf") return <iframe className="file-preview-frame" src={url} title={`Preview ${file.name}`} sandbox="" />;
  if (file.preview === "text") return <pre className="file-preview-text">{text || "Loading preview…"}</pre>;
  return <div className="file-preview-empty"><span aria-hidden="true">▱</span><strong>No inline preview</strong><small>{file.mimeType}</small></div>;
}

export function Playground({ onOpenBuilder }: { onOpenBuilder: () => void }) {
  const [project, setProject] = useState<PlaygroundProject>();
  const [session, setSession] = useState<PlaygroundSession>();
  const [files, setFiles] = useState<readonly PlaygroundFile[]>([]);
  const [liveFiles, setLiveFiles] = useState<readonly PlaygroundFile[]>([]);
  const [selectedFileIds, setSelectedFileIds] = useState<ReadonlySet<string>>(new Set());
  const [previewFileId, setPreviewFileId] = useState<string>();
  const [message, setMessage] = useState("");
  const [liveRun, setLiveRun] = useState<LiveRun>();
  const [runState, setRunState] = useState<"idle" | "running" | "cancelling">("idle");
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState("");
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [rightTab, setRightTab] = useState<"files" | "sandbox" | "details">("files");
  const [disabledPlugins, setDisabledPlugins] = useState<ReadonlySet<string>>(new Set());
  const [modelValue, setModelValue] = useState("");
  const [pendingApproval, setPendingApproval] = useState<PendingApproval>();
  const [approvalBusy, setApprovalBusy] = useState(false);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const sessionLoad = useRef(0);

  const loadSession = useCallback(async (id: string) => {
    const request = ++sessionLoad.current;
    setLoading(true);
    try {
      const payload = await requestJson<SessionPayload>(`/api/playground?sessionId=${encodeURIComponent(id)}`);
      if (request !== sessionLoad.current) return;
      setProject((current) => current ? { ...current, ready: payload.ready, diagnostics: payload.diagnostics, capabilities: payload.capabilities, retentionDays: payload.retentionDays } : current);
      setSession(payload.session);
      setFiles(payload.files);
      setSelectedFileIds((current) => new Set([...current].filter((fileId) => payload.files.some(({ id: candidate }) => candidate === fileId))));
      setPreviewFileId((current) => current && payload.files.some(({ id: candidate }) => candidate === current) ? current : payload.files[0]?.id);
      setNotice("");
    } catch (error) {
      if (request === sessionLoad.current) setNotice(error instanceof Error ? error.message : "Conversation could not be loaded");
    } finally {
      if (request === sessionLoad.current) setLoading(false);
    }
  }, []);

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
        if (active) { setNotice(error instanceof Error ? error.message : "Playground could not open"); setLoading(false); }
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

  const removeSession = async (id: string) => {
    if (runState !== "idle" || !window.confirm("Delete this Playground conversation and all of its files?")) return;
    const response = await fetch("/api/playground", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: id }),
    });
    if (!response.ok) { setNotice(await responseMessage(response)); return; }
    const index = await refreshProject();
    const next = index.sessions.find(({ id: candidate }) => candidate !== id) ?? await createSession();
    await loadSession(next.id);
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
      setNotice(error instanceof Error ? error.message : "File upload failed");
    } finally {
      setUploading(false);
    }
  };

  const removeFile = async (file: PlaygroundFile) => {
    if (!session || file.source === "sandbox" || !window.confirm(`Remove ${file.name} from this conversation?`)) return;
    const response = await fetch("/api/playground/files", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: session.id, fileId: file.id }),
    });
    if (!response.ok) { setNotice(await responseMessage(response)); return; }
    await loadSession(session.id);
  };

  const inspectApproval = async (event: Extract<RunEvent, { type: "tool-call" }>) => {
    if (event.risk === "read" || !event.callId || !event.turn) return;
    setApprovalBusy(true);
    try {
      const payload = await requestJson<{ approval: PendingApproval }>("/api/approvals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "inspect", runId: event.runId, nodeId: event.nodeId, callId: event.callId, turn: event.turn }),
      });
      setPendingApproval(payload.approval);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Tool approval could not be inspected");
    } finally {
      setApprovalBusy(false);
    }
  };

  const decideApproval = async (approved: boolean) => {
    if (!pendingApproval || approvalBusy) return;
    setApprovalBusy(true);
    try {
      await requestJson("/api/approvals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runId: pendingApproval.runId,
          nodeId: pendingApproval.nodeId,
          callId: pendingApproval.callId,
          turn: pendingApproval.turn,
          inputDigest: pendingApproval.inputDigest,
          approved,
        }),
      });
      setPendingApproval(undefined);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Approval decision failed");
    } finally {
      setApprovalBusy(false);
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
    setPendingApproval(undefined);
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
      await readNdjson<RunEvent | PlaygroundFilesEvent>(response, (value) => {
        if (value.type === "playground-files") {
          if (value.live) setLiveFiles(value.files);
          else { setLiveFiles([]); setFiles((current) => [...current.filter(({ id }) => !value.files.some((file) => file.id === id)), ...value.files]); }
          return;
        }
        const event = value;
        setLiveRun((current) => ({
          events: [...(current?.events ?? []), event],
          text: event.type === "text-delta" ? `${current?.text ?? ""}${event.text}` : current?.text ?? "",
          ...(current?.output !== undefined ? { output: current.output } : {}),
          ...(current?.error ? { error: current.error } : {}),
          ...(event.type === "run-start" ? { runId: event.runId } : current?.runId ? { runId: current.runId } : {}),
          ...(event.type === "run-end" ? { output: outputText(event.output), runId: event.runId } : {}),
          ...(event.type === "error" ? { error: event.message, runId: event.runId } : {}),
        }));
        if (event.type === "tool-call") void inspectApproval(event);
        if (event.type === "tool-approval") setPendingApproval(undefined);
      });
      await loadSession(session.id);
      await refreshProject();
      setLiveRun(undefined);
      setSelectedFileIds(new Set());
    } catch (error) {
      if (controller.signal.aborted) {
        setLiveRun((current) => current ? { ...current, error: "Run cancelled" } : current);
        await new Promise((resolve) => setTimeout(resolve, 100));
        await loadSession(session.id).catch(() => undefined);
        setLiveRun(undefined);
      } else {
        setNotice(error instanceof Error ? error.message : "Playground run failed");
        await loadSession(session.id);
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = undefined;
      setRunState("idle");
      setLiveFiles([]);
      setPendingApproval(undefined);
    }
  };

  const cancel = () => {
    if (!abortRef.current) return;
    setRunState("cancelling");
    abortRef.current.abort();
    setNotice("Run cancelled");
  };

  const togglePlugin = (key: string) => {
    setDisabledPlugins((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      const codeRunnerAvailable = project?.capabilities.plugins.some((plugin) => plugin.id === "builtin.code-runner" && !next.has(plugin.componentKey));
      if (!codeRunnerAvailable) setSelectedFileIds(new Set());
      return next;
    });
  };

  const toggleFile = (id: string) => setSelectedFileIds((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const codeRunnerEnabled = Boolean(project?.capabilities.plugins.some((plugin) => plugin.id === "builtin.code-runner" && !disabledPlugins.has(plugin.componentKey)));
  const canAttach = Boolean(project?.capabilities.attachments.enabled && codeRunnerEnabled);
  const uploadedFiles = files.filter(({ source }) => source === "upload");
  const sandboxFiles = [...files.filter(({ source }) => source === "artifact"), ...liveFiles];
  const previewFile = [...files, ...liveFiles].find(({ id }) => id === previewFileId);
  const currentFiles = rightTab === "files" ? uploadedFiles : sandboxFiles;
  const selectedModel = project?.capabilities.models.find((option) => `${option.componentKey}\u0000${option.connectionId}` === modelValue);
  const readyToSend = Boolean(session && project?.ready && message.trim() && runState === "idle" && !uploading);

  if (loading && !project) return <section className="playground-loading"><span className="playground-spinner" /><strong>Opening Harnest Playground</strong><small>Reading only the capabilities declared by this harness.</small></section>;

  return <section className={`playground ${leftOpen ? "has-left" : ""} ${rightOpen ? "has-right" : ""}`} aria-label="Harnest Playground">
    {leftOpen ? <aside className="playground-history" aria-label="AI chat history">
      <header><div><span className="sheet-eyebrow">Conversations</span><strong>Playground history</strong></div><button className="panel-toggle" aria-label="Collapse history" aria-expanded="true" onClick={() => setLeftOpen(false)}>←</button></header>
      <button className="new-chat-button" disabled={runState !== "idle"} onClick={() => void createSession().then(({ id }) => loadSession(id))}><span>＋</span> New conversation</button>
      <nav className="conversation-list" aria-label="Saved conversations">
        {project?.sessions.map((item) => <div className={`conversation-item ${item.id === session?.id ? "is-active" : ""}`} key={item.id}>
          <button disabled={runState !== "idle"} onClick={() => void openSession(item.id)}><strong>{item.title}</strong><span>{item.preview || "No messages yet"}</span><small>{shortTime(item.updatedAt)} · {item.messageCount}</small></button>
          <button className="conversation-delete" aria-label={`Delete ${item.title}`} disabled={runState !== "idle"} onClick={() => void removeSession(item.id)}>×</button>
        </div>)}
      </nav>
      <footer><span>Local project history</span><small>Expires after {project?.retentionDays ?? 30} days of inactivity</small></footer>
    </aside> : <button className="collapsed-panel-button is-left" aria-label="Expand chat history" aria-expanded="false" onClick={showLeft}>History →</button>}

    <section className="playground-chat" aria-label="AI conversation">
      <header className="playground-chat-header">
        <div><span className="sheet-eyebrow">Immutable test surface</span><h1>{session?.title ?? "Harnest Playground"}</h1><p>{project?.ready ? "Harness ready" : "Setup required before this harness can run"} · source YAML is never changed here</p></div>
        <div className="playground-chat-actions">
          {!leftOpen && <button className="button" onClick={showLeft}>History</button>}
          {!rightOpen && <button className="button" onClick={showRight}>Files</button>}
        </div>
      </header>
      {notice && <div className="playground-notice" role="status"><span>{notice}</span><button aria-label="Dismiss message" onClick={() => setNotice("")}>×</button></div>}
      <div className="playground-messages" aria-live="polite">
        {!session?.messages.length && !liveRun ? <div className="playground-empty-chat"><span className="empty-chat-mark">H</span><h2>Test the harness as a real service.</h2><p>Send a request, attach supported files, or choose which declared tools and skills may participate. Every observable action appears in the execution timeline.</p><div><span>1</span> Attach data <span>2</span> Choose capabilities <span>3</span> Run</div></div> : session?.messages.map((item) => <article className={`playground-message is-${item.role}`} key={item.id}>
          <div className="message-author"><span>{item.role === "user" ? "You" : "H"}</span><strong>{item.role === "user" ? "You" : "Harness"}</strong><time>{new Date(item.createdAt).toLocaleTimeString()}</time></div>
          <div className="message-body"><div className="message-content">{item.content}</div>
            {item.fileIds?.length ? <div className="message-files">{item.fileIds.map((id) => <span key={id}>{files.find((file) => file.id === id)?.name ?? "Attached file"}</span>)}</div> : null}
            {item.role === "assistant" && <><RunTimeline runId={item.runId} />{(item.usage || item.costUsd !== undefined) && <div className="message-usage"><span>{item.usage?.totalTokens ?? "—"} tokens</span><span>${(item.costUsd ?? 0).toFixed(6)}</span><span>{item.finishReason ?? "unknown"}</span></div>}</>}
          </div>
        </article>)}
        {liveRun && <article className="playground-message is-assistant is-live">
          <div className="message-author"><span>H</span><strong>Harness</strong><time>now</time></div>
          <div className="message-body"><div className="working-label"><span className="is-live" />{runState === "cancelling" ? "Cancelling safely…" : liveRun.error ? "Needs attention" : "Harness is working"}</div><div className="message-content">{liveRun.output ?? (liveRun.text || liveRun.error || "")}</div><RunTimeline runId={liveRun.runId} events={liveRun.events} live /></div>
        </article>}
      </div>

      <div className="playground-composer-wrap">
        {selectedFileIds.size > 0 && <div className="composer-files">{[...selectedFileIds].map((id) => { const file = files.find((candidate) => candidate.id === id); return file ? <button key={id} onClick={() => toggleFile(id)}>{file.name}<span>×</span></button> : null; })}</div>}
        <div className={`playground-composer ${!project?.ready ? "is-disabled" : ""}`}>
          <textarea aria-label="Message the harness" placeholder={project?.ready ? "Ask this harness to analyze, search, build, or transform…" : "Resolve the harness setup issues before running"} value={message} disabled={!project?.ready || runState !== "idle"} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); void run(); } }} />
          <div className="composer-toolbar">
            <div className="composer-tools">
              <label className={`composer-tool-button ${!canAttach ? "is-disabled" : ""}`} title={canAttach ? "Upload photos, video, documents, or data" : project?.capabilities.attachments.reason ?? "Code Runner is disabled"}>＋<span>Attach</span><input type="file" multiple accept={project?.capabilities.attachments.accepted} disabled={!canAttach || uploading || runState !== "idle"} onChange={(event) => void upload(event)} /></label>
              <details className="plugin-menu"><summary className="composer-tool-button"><span className="plugin-dot" />Capabilities <small>{(project?.capabilities.plugins.length ?? 0) - disabledPlugins.size}/{project?.capabilities.plugins.length ?? 0}</small></summary><div className="plugin-menu-popover"><header><strong>Run capabilities</strong><small>Only components connected in this harness</small></header>{project?.capabilities.plugins.length ? project.capabilities.plugins.map((plugin) => <label key={plugin.componentKey}><input type="checkbox" checked={!disabledPlugins.has(plugin.componentKey)} disabled={runState !== "idle"} onChange={() => togglePlugin(plugin.componentKey)} /><span><strong>{plugin.label}</strong><small>{plugin.kind.toLocaleUpperCase()} · {plugin.risk ?? "policy managed"}</small></span></label>) : <p>No optional tools, MCP servers, or skills are connected.</p>}</div></details>
              {project?.capabilities.models.length ? <label className="model-picker"><span className="sr-only">Model for this run</span><select value={modelValue} disabled={runState !== "idle"} onChange={(event) => setModelValue(event.target.value)}>{project.capabilities.models.map((option) => <option key={`${option.componentKey}:${option.connectionId}`} value={`${option.componentKey}\u0000${option.connectionId}`}>{option.label}</option>)}</select></label> : <span className="harness-default-model">Harness model</span>}
            </div>
            {runState === "idle" ? <button className="send-button" disabled={!readyToSend} aria-label="Send request" onClick={() => void run()}>↑</button> : <button className="stop-button" aria-label="Cancel run" onClick={cancel}>■</button>}
          </div>
        </div>
        <div className="composer-footnote"><span>{selectedModel?.label ?? "Saved harness model"}</span><span>Ctrl/⌘ + Enter to send</span><span>Latest 20 messages · 64 KiB context ceiling</span></div>
      </div>
    </section>

    {rightOpen ? <aside className="playground-files" aria-label="Files and sandbox">
      <header><div className="file-tabs" role="tablist" aria-label="Playground resources">
        {project?.capabilities.attachments.enabled && <button role="tab" aria-selected={rightTab === "files"} className={rightTab === "files" ? "is-active" : ""} onClick={() => setRightTab("files")}>Uploads <span>{uploadedFiles.length}</span></button>}
        {project?.capabilities.attachments.enabled && <button role="tab" aria-selected={rightTab === "sandbox"} className={rightTab === "sandbox" ? "is-active" : ""} onClick={() => setRightTab("sandbox")}>Sandbox <span>{sandboxFiles.length}</span></button>}
        <button role="tab" aria-selected={rightTab === "details"} className={rightTab === "details" ? "is-active" : ""} onClick={() => setRightTab("details")}>Details</button>
      </div><button className="panel-toggle" aria-label="Collapse files" aria-expanded="true" onClick={() => setRightOpen(false)}>→</button></header>
      {rightTab === "details" ? <div className="playground-details">
        <div className={`readiness-card ${project?.ready ? "is-ready" : "is-blocked"}`}><span>{project?.ready ? "Ready" : "Blocked"}</span><strong>{project?.ready ? "Harness can run" : `${project?.diagnostics.filter(({ severity }) => severity === "error").length ?? 0} setup issues`}</strong></div>
        <dl><div><dt>Model choices</dt><dd>{project?.capabilities.models.length || "Harness default"}</dd></div><div><dt>Optional capabilities</dt><dd>{project?.capabilities.plugins.length ?? 0}</dd></div><div><dt>File workspace</dt><dd>{project?.capabilities.attachments.enabled ? "Code Runner" : "Not supported"}</dd></div><div><dt>Conversation replay</dt><dd>20 messages / 64 KiB</dd></div><div><dt>Local retention</dt><dd>{project?.retentionDays ?? 30} days inactive</dd></div></dl>
        <section><strong>Run isolation</strong><p>Playground choices create an in-memory copy. They never write model, plugin, prompt, or file settings back to harnest.yaml.</p></section>
        <section><strong>Cost boundary</strong><p>Conversation replay is bounded; provider-side prompt caching is separate and depends on the selected adapter and provider.</p></section>
        {project?.diagnostics.length ? <section><strong>Current diagnostics</strong><ul>{project.diagnostics.slice(0, 8).map((diagnostic, index) => <li key={`${diagnostic.code}:${index}`}>{diagnostic.message}</li>)}</ul></section> : null}
        <button className="button" onClick={() => void refreshProject().catch((error: unknown) => setNotice(error instanceof Error ? error.message : "Refresh failed"))}>Refresh harness support</button>
        <button className="button" onClick={onOpenBuilder}>Open Builder</button>
      </div> : <>
        <div className="file-explorer-heading"><div><strong>{rightTab === "files" ? "Conversation files" : "Sandbox output"}</strong><small>{rightTab === "files" ? "Select files to mount read-only for the next run" : liveFiles.length ? "Live · output updates while code runs" : "Files created under /mnt/output"}</small></div>{rightTab === "files" && <label className={`mini-upload ${!canAttach ? "is-disabled" : ""}`}>＋<input type="file" multiple accept={project?.capabilities.attachments.accepted} disabled={!canAttach || uploading} onChange={(event) => void upload(event)} /></label>}</div>
        <div className="file-list">{currentFiles.length ? currentFiles.map((file) => <div className={`file-row ${previewFileId === file.id ? "is-active" : ""}`} key={file.id}><button onClick={() => setPreviewFileId(file.id)}><span className={`file-kind is-${file.preview}`} aria-hidden="true">{file.source === "sandbox" ? "↻" : file.source === "artifact" ? "↳" : "▱"}</span><span><strong>{file.name}</strong><small>{bytes(file.size)} · {file.source === "sandbox" ? "writing" : file.mimeType}</small></span></button>{file.source !== "sandbox" && <label title="Use in next run"><input type="checkbox" checked={selectedFileIds.has(file.id)} disabled={!canAttach || runState !== "idle"} onChange={() => toggleFile(file.id)} /><span className="sr-only">Use {file.name} in next run</span></label>} {file.source !== "sandbox" && <button className="file-remove" aria-label={`Remove ${file.name}`} onClick={() => void removeFile(file)}>×</button>}</div>) : <div className="file-list-empty"><span>{rightTab === "files" ? "＋" : "◇"}</span><strong>{rightTab === "files" ? "No uploaded files" : "No sandbox output yet"}</strong><small>{rightTab === "files" ? "Attach a supported file from the composer." : "Ask the harness to save results under /mnt/output."}</small></div>}</div>
        <div className="file-preview"><div className="file-preview-heading"><div><strong>{previewFile?.name ?? "Preview"}</strong>{previewFile && <small>{previewFile.sandboxPath ?? previewFile.mimeType}</small>}</div>{previewFile && previewFile.source !== "sandbox" && <a className="button" href={`/api/playground/files?sessionId=${encodeURIComponent(session?.id ?? "")}&fileId=${encodeURIComponent(previewFile.id)}&download=1`}>Download</a>}</div><FilePreview sessionId={session?.id ?? ""} file={previewFile} /></div>
      </>}
    </aside> : <button className="collapsed-panel-button is-right" aria-label="Expand files and sandbox" aria-expanded="false" onClick={showRight}>← Files</button>}

    {pendingApproval && <div className="approval-backdrop"><section className="approval-dialog" role="alertdialog" aria-modal="true" aria-labelledby="playground-approval-title" aria-describedby="playground-approval-description"><header><span className="sheet-eyebrow">Tool permission</span><h2 id="playground-approval-title">Allow {pendingApproval.tool} this time?</h2></header><div className="approval-body"><div className="approval-meter"><span>What it can do</span><strong className={`risk-${pendingApproval.risk}`}>{RISK_LABELS[pendingApproval.risk] ?? pendingApproval.risk}</strong><span>Agent step</span><strong>{pendingApproval.turn}</strong></div><p id="playground-approval-description">Review the exact arguments. This decision applies only to this call.</p><div className="approval-meter"><span>Request size</span><strong>{pendingApproval.inputBytes} bytes</strong><span>Preview</span><strong>{pendingApproval.previewLimited ? "Incomplete" : "Complete"}</strong></div>{pendingApproval.previewLimited && <p className="field-error">The complete arguments cannot be shown safely, so this call cannot be allowed.</p>}<pre>{JSON.stringify(pendingApproval.input, null, 2)}</pre></div><footer><button className="button" disabled={approvalBusy} onClick={() => void decideApproval(false)}>Don&apos;t allow</button><button className="button button-primary" disabled={approvalBusy || pendingApproval.previewLimited} onClick={() => void decideApproval(true)}>{approvalBusy ? "Sending…" : "Allow once"}</button></footer></section></div>}
  </section>;
}
