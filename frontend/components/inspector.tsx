"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Tabs } from "@base-ui/react/tabs";
import type { HarnessSpec, InspectorField } from "@harnestai/core";
import { configValue, withConfigValue } from "@/lib/component-catalog";
import type {
  HarnessComponent,
  HarnessConnection,
  HarnessEdge,
  HarnessNode,
} from "@/lib/studio-state";
import {
  connectionCanRun,
  connectionDetails,
  type ConnectionKind,
  type ConnectionSummary,
} from "@/lib/connections";
import type { ToolCatalogItem } from "@/lib/studio-catalog";
import { componentLabel, connectionLabel, fieldLabel } from "@/i18n/manifest";
import { useI18n } from "./i18n-provider";
import { apiErrorMessage, requestJson } from "@/lib/api-client";

type EdgeCondition = { source?: string; path?: string; op?: string; value?: unknown };
type EdgeState = { key?: string; merge?: string };
type EditableConnection = HarnessConnection & {
  condition?: EdgeCondition;
  select?: string;
  state?: EdgeState;
};

interface ProjectBindingView {
  readonly kind: "prompt" | "context" | "schema";
  readonly component: string;
  readonly graph?: string;
  readonly path: string;
}

function ProjectBindingField({ component, graph, locked, onChanged }: {
  component: HarnessComponent;
  graph?: string;
  locked: boolean;
  onChanged: () => void | Promise<void>;
}) {
  const { t } = useI18n();
  const kind = component.type === "prompt" ? "prompt" : component.type === "context" ? "context" : component.type === "output" ? "schema" : undefined;
  const root = kind === "prompt" ? ".harnest/prompts/" : kind === "context" ? ".harnest/context/" : ".harnest/schemas/";
  const [files, setFiles] = useState<readonly string[]>([]);
  const [selected, setSelected] = useState("");
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    if (!kind) return;
    try {
      const payload = await requestJson<{
        project: { manifest: { bindings?: ProjectBindingView[] } } | null;
        files: Array<{ path: string }>;
      }>("/api/project", { cache: "no-store" });
      setAvailable(Boolean(payload.project));
      setFiles(payload.files.map(({ path }) => path).filter((path) => path.startsWith(root)));
      setSelected(payload.project?.manifest.bindings?.find((binding) => binding.kind === kind
        && binding.component === component.id && binding.graph === graph)?.path
        ? `.harnest/${payload.project.manifest.bindings.find((binding) => binding.kind === kind && binding.component === component.id && binding.graph === graph)!.path}`
        : "");
      setError("");
    } catch (cause) {
      setError(apiErrorMessage(cause, t("project.loadFailed"), t));
    }
  }, [component.id, graph, kind, root, t]);
  useEffect(() => { void load(); }, [load]);
  if (!kind || !available) return null;
  const bind = async (path: string) => {
    setBusy(true);
    try {
      await requestJson("/api/project", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "bind", kind, component: component.id, ...(graph ? { graph } : {}), ...(path ? { path } : {}) }),
      });
      setSelected(path);
      setError("");
      await onChanged();
      await load();
    } catch (cause) {
      setError(apiErrorMessage(cause, t("project.bindFailed"), t));
    } finally {
      setBusy(false);
    }
  };
  return <div className="field" data-config-path="projectBinding"><label htmlFor={`project-binding-${component.id}`}>{t("project.sourceBinding")}</label><select id={`project-binding-${component.id}`} value={selected} disabled={locked || busy} onChange={(event) => void bind(event.target.value)}><option value="">{t("project.inlineSource")}</option>{files.map((path) => <option key={path} value={path}>{path.replace(root, "")}</option>)}</select><span className="field-help">{t("project.sourceBindingHelp")}</span>{error && <span className="field-error" role="status">{error}</span>}</div>;
}

const optionalText = (value: string) => value === "" ? undefined : value;
const fieldId = (prefix: string, path: string) => `${prefix}-${path.replace(/[^A-Za-z0-9_-]/g, "-")}`;

function JsonField({
  id,
  label,
  value,
  required,
  disabled,
  path,
  onChange,
}: {
  id: string;
  label: string;
  value: unknown;
  required?: boolean;
  disabled?: boolean;
  path?: string;
  onChange: (value: unknown) => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState(() => value === undefined ? "" : JSON.stringify(value, null, 2));
  const [error, setError] = useState("");
  const messageId = `${id}-message`;

  useEffect(() => {
    setText(value === undefined ? "" : JSON.stringify(value, null, 2));
    setError("");
  }, [value]);

  const commit = () => {
    if (!text.trim() && !required) {
      onChange(undefined);
      setError("");
      return;
    }
    try {
      onChange(JSON.parse(text) as unknown);
      setError("");
    } catch {
      setError(t("inspector.jsonInvalid"));
    }
  };

  return (
    <div className="field" data-config-path={path}>
      <label htmlFor={id}>{label}</label>
      <textarea
        id={id}
        className="nodrag"
        spellCheck={false}
        required={required}
        disabled={disabled}
        value={text}
        aria-invalid={Boolean(error)}
        aria-describedby={messageId}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
      />
      <span id={messageId} className={`field-help ${error ? "is-error" : ""}`}>{error || t("inspector.jsonHelp")}</span>
    </div>
  );
}

function ConfigField({
  component,
  field,
  disabled,
  onChange,
}: {
  component: HarnessComponent;
  field: InspectorField;
  disabled: boolean;
  onChange: (component: HarnessComponent) => void;
}) {
  const { t } = useI18n();
  const prefix = useId().replace(/:/g, "");
  const id = fieldId(`${prefix}-${component.id}`, field.path);
  const label = fieldLabel(t, field.path, field.label);
  const config = component.config as Record<string, unknown>;
  const value = configValue(config, field.path);
  const update = (next: unknown) => onChange({
    ...component,
    config: withConfigValue(config, field.path, next),
  } as HarnessComponent);

  if (field.control === "json") return (
    <JsonField id={id} label={label} value={value} required={field.required} disabled={disabled} path={field.path} onChange={update} />
  );

  if (field.control === "checkbox") return (
    <div className="field field-checkbox" data-config-path={field.path}>
      <input id={id} type="checkbox" disabled={disabled} checked={Boolean(value)} onChange={(event) => update(event.target.checked)} />
      <label htmlFor={id}>{label}</label>
    </div>
  );

  if (field.control === "select") return (
    <div className="field" data-config-path={field.path}>
      <label htmlFor={id}>{label}</label>
      <select id={id} required={field.required} disabled={disabled} value={value === undefined ? "" : String(value)} onChange={(event) => {
        const selected = field.options?.find((option) => String(option.value) === event.target.value);
        update(selected?.value ?? optionalText(event.target.value));
      }}>
        {!field.required && <option value="">{t("common.notSet")}</option>}
        {field.options?.map((option) => <option key={String(option.value)} value={String(option.value)}>{option.label}</option>)}
      </select>
    </div>
  );

  const multiline = field.control === "textarea";
  return (
    <div className="field" data-config-path={field.path}>
      <label htmlFor={id}>{label}</label>
      {multiline ? (
        <textarea id={id} required={field.required} disabled={disabled} value={value === undefined ? "" : String(value)} onChange={(event) => update(field.required ? event.target.value : optionalText(event.target.value))} />
      ) : (
        <input
          id={id}
          type={field.control === "number" ? "number" : "text"}
          required={field.required}
          disabled={disabled}
          value={value === undefined ? "" : String(value)}
          onChange={(event) => update(field.control === "number"
            ? event.target.value === "" ? undefined : Number(event.target.value)
            : field.required ? event.target.value : optionalText(event.target.value))}
        />
      )}
    </div>
  );
}

const connectionKindsFor = (
  component: HarnessComponent,
  tools: readonly ToolCatalogItem[] = [],
): readonly ConnectionKind[] => {
  if (component.type === "model") return ["provider"];
  if (component.type === "mcp-tool") return component.config.transport === "stdio"
    ? ["mcp-stdio"]
    : component.config.transport === "http"
      ? ["mcp-http"]
      : ["mcp-http", "mcp-stdio"];
  if (component.type === "local-tool") return ["tool-service", "http-api", "local-runtime"];
  if (component.type === "tool") {
    const toolId = typeof component.config.tool === "string" ? component.config.tool : "";
    const catalogKinds = tools.find((tool) => tool.id === toolId)?.connectionKinds;
    if (catalogKinds?.length) return catalogKinds;
    if (component.config.source === "mcp") return ["mcp-http", "mcp-stdio"];
    if (["builtin.code-runner", "builtin.file", "builtin.shell"].includes(toolId)) return ["local-runtime"];
    if (toolId === "builtin.web-search") return ["tool-service"];
    if (toolId === "builtin.http") return ["http-api"];
    return ["tool-service", "http-api", "local-runtime"];
  }
  return [];
};

const advancedField = (component: HarnessComponent, field: InspectorField) => {
  if (component.type === "model") return ["adapter", "baseUrl", "inputCostPerMillion", "outputCostPerMillion"].includes(field.path);
  if (component.type === "agent") return ["timeoutMs", "maxToolCalls", "toolTimeoutMs", "compactAtTokens", "maxTokens", "maxCostUsd", "allowTools", "denyTools", "toolError"].includes(field.path);
  if (component.type === "mcp-tool") return ["transport", "protocol", "command", "args", "url", "headers", "timeoutMs"].includes(field.path);
  if (component.type === "tool") return ["tool", "action", "source", "inputSchema", "outputSchema"].includes(field.path);
  return field.control === "json" && (field.path === "schema" || field.path === "inputSchema" || field.path === "outputSchema");
};

function ConnectionField({
  component,
  connections,
  tools,
  locked,
  onChange,
  onConnect,
}: {
  component: HarnessComponent;
  connections: readonly ConnectionSummary[];
  tools: readonly ToolCatalogItem[];
  locked: boolean;
  onChange: (component: HarnessComponent) => void;
  onConnect: (kind?: ConnectionKind) => void;
}) {
  const { t } = useI18n();
  const kinds = connectionKindsFor(component, tools);
  if (!kinds.length) return null;
  const config = component.config as Record<string, unknown>;
  const selectedId = typeof config.connectionId === "string" ? config.connectionId : "";
  const fallbackId = component.type === "model" && typeof config.fallbackConnectionId === "string"
    ? config.fallbackConnectionId : "";
  const compatible = connections.filter((connection) => kinds.includes(connection.kind));
  const selected = connections.find((connection) => connection.id === selectedId);
  const preferred = kinds[0];
  const update = (connectionId: string) => onChange({
    ...component,
    config: withConfigValue(
      withConfigValue(config, "connectionId", connectionId || undefined),
      "fallbackConnectionId",
      connectionId && connectionId !== fallbackId ? fallbackId || undefined : undefined,
    ),
  } as HarnessComponent);
  const updateFallback = (connectionId: string) => onChange({
    ...component,
    config: withConfigValue(config, "fallbackConnectionId", connectionId || undefined),
  } as HarnessComponent);

  return (
    <div className="connection-field" data-config-path="connectionId">
      <div className="field-section">{t("inspector.connection")}</div>
      <div className="field">
        <label htmlFor={`connection-${component.id}`}>{t("inspector.reusableConnection")}</label>
        <select id={`connection-${component.id}`} disabled={locked} value={selectedId} onChange={(event) => update(event.target.value)}>
          <option value="">{t("inspector.chooseConnection")}</option>
          {compatible.map((connection) => <option key={connection.id} value={connection.id} disabled={!connectionCanRun(connection)}>{connection.name} · {connectionDetails(connection) ?? connectionLabel(t, connection.kind)} · {t(`connections.status.${connection.status}`)}</option>)}
        </select>
        {selected
          ? <span className={`field-help connection-inline-status is-${selected.status}`}>{t(`connections.status.${selected.status}`)}</span>
          : <span className="field-help">{t("inspector.credentialHelp")}</span>}
      </div>
      {component.type === "model" && <div className="field">
        <label htmlFor={`fallback-connection-${component.id}`}>{t("inspector.fallback")}</label>
        <select id={`fallback-connection-${component.id}`} disabled={locked || !selectedId} value={fallbackId} onChange={(event) => updateFallback(event.target.value)}>
          <option value="">{t("inspector.noFallback")}</option>
          {compatible.filter(({ id }) => id !== selectedId).map((connection) => <option key={connection.id} value={connection.id} disabled={!connectionCanRun(connection)}>{connection.name} · {connectionDetails(connection) ?? connectionLabel(t, connection.kind)} · {t(`connections.status.${connection.status}`)}</option>)}
        </select>
        <span className="field-help">{t("inspector.fallbackHelp")}</span>
      </div>}
      <button type="button" className="button" disabled={locked} onClick={() => onConnect(preferred)}>{compatible.length ? t("inspector.manageConnections") : t("common.connect")}</button>
    </div>
  );
}

function ToolCatalogField({
  component,
  tools,
  locked,
  onChange,
}: {
  component: HarnessComponent;
  tools: readonly ToolCatalogItem[];
  locked: boolean;
  onChange: (component: HarnessComponent) => void;
}) {
  const { t } = useI18n();
  const config = component.config as Record<string, unknown>;
  const selected = typeof config.tool === "string" ? config.tool : "";
  const categories = [...new Set(tools.filter(({ installed }) => installed).map(({ category }) => category))].sort();
  const selectTool = (tool: ToolCatalogItem) => {
    const preserved = { ...config };
    for (const key of ["tool", "label", "description", "risk", "source", "action", "connectionId", "inputSchema", "outputSchema"]) {
      delete preserved[key];
    }
    onChange({
      ...component,
      config: {
        ...preserved,
        tool: tool.id,
        label: tool.label,
        description: tool.description,
        risk: tool.risk ?? "external",
        source: tool.source ?? "custom",
        ...(tool.action ? { action: tool.action } : {}),
        ...(tool.connectionId ? { connectionId: tool.connectionId } : {}),
        ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
      },
    } as HarnessComponent);
  };
  const quick = ["builtin.web-search", "builtin.code-runner", "builtin.shell"]
    .flatMap((id) => tools.find((tool) => tool.installed && tool.id === id) ?? []);
  return <div className="field" data-config-path="tool">
    <label htmlFor={`tool-catalog-${component.id}`}>{t("inspector.toolChoice")}</label>
    {quick.length > 0 && <div className="connection-kind-grid" aria-label={t("inspector.toolQuickChoices")}>
      {quick.map((tool) => <button type="button" key={tool.id} className={`connection-kind ${selected === tool.id ? "is-active" : ""}`} aria-pressed={selected === tool.id} disabled={locked} onClick={() => selectTool(tool)}><strong>{tool.label}</strong><span>{tool.description}</span></button>)}
    </div>}
    <select id={`tool-catalog-${component.id}`} required disabled={locked} value={selected} onChange={(event) => {
      const tool = tools.find(({ id }) => id === event.target.value);
      if (!tool) return;
      selectTool(tool);
    }}>
      <option value="">{t("inspector.toolChoicePlaceholder")}</option>
      {categories.map((category) => <optgroup key={category} label={category}>{tools.filter((tool) => tool.installed && tool.category === category).map((tool) => <option key={tool.id} value={tool.id}>{tool.label}</option>)}</optgroup>)}
    </select>
    <span className="field-help">{t("inspector.toolChoiceHelp")}</span>
  </div>;
}

function ComponentPolicyFields({
  component,
  locked,
  onChange,
}: {
  component: HarnessComponent;
  locked: boolean;
  onChange: (component: HarnessComponent) => void;
}) {
  const { t } = useI18n();
  const record = component as HarnessComponent & { policy?: Record<string, unknown> };
  const policy = record.policy ?? {};
  const retry = policy.retry && typeof policy.retry === "object" && !Array.isArray(policy.retry)
    ? policy.retry as Record<string, unknown> : {};
  const update = (next: Record<string, unknown>) => {
    const candidate = { ...component } as HarnessComponent & { policy?: Record<string, unknown> };
    if (Object.keys(next).length) candidate.policy = next; else delete candidate.policy;
    onChange(candidate as HarnessComponent);
  };
  const patch = (key: string, value: unknown) => {
    const next = { ...policy };
    if (value === undefined) delete next[key]; else next[key] = value;
    update(next);
  };
  const patchRetry = (key: string, value: unknown) => {
    const next = { ...retry };
    if (value === undefined) delete next[key]; else next[key] = value;
    if (Object.keys(next).length && typeof next.maxAttempts !== "number") next.maxAttempts = 3;
    patch("retry", Object.keys(next).length ? next : undefined);
  };
  const value = (input: string) => input === "" ? undefined : Number(input);
  return <details className="advanced-panel"><summary>{t("inspector.executionPolicy")}</summary><div className="field-grid">
    <div className="field" data-config-path="policy.timeoutMs"><label htmlFor={`policy-timeout-${component.id}`}>{t("inspector.policy.timeout")}</label><input id={`policy-timeout-${component.id}`} type="number" min={1} max={600000} disabled={locked} value={typeof policy.timeoutMs === "number" ? policy.timeoutMs : ""} onChange={(event) => patch("timeoutMs", value(event.target.value))} /></div>
    <div className="field" data-config-path="policy.retry.maxAttempts"><label htmlFor={`policy-attempts-${component.id}`}>{t("inspector.policy.maxAttempts")}</label><input id={`policy-attempts-${component.id}`} type="number" min={1} max={10} disabled={locked} value={typeof retry.maxAttempts === "number" ? retry.maxAttempts : ""} onChange={(event) => patchRetry("maxAttempts", value(event.target.value))} /></div>
    <div className="field" data-config-path="policy.retry.backoffMs"><label htmlFor={`policy-backoff-${component.id}`}>{t("inspector.policy.backoff")}</label><input id={`policy-backoff-${component.id}`} type="number" min={0} max={60000} disabled={locked} value={typeof retry.backoffMs === "number" ? retry.backoffMs : ""} onChange={(event) => patchRetry("backoffMs", value(event.target.value))} /></div>
    <div className="field" data-config-path="policy.retry.maxBackoffMs"><label htmlFor={`policy-max-backoff-${component.id}`}>{t("inspector.policy.maxBackoff")}</label><input id={`policy-max-backoff-${component.id}`} type="number" min={0} max={60000} disabled={locked} value={typeof retry.maxBackoffMs === "number" ? retry.maxBackoffMs : ""} onChange={(event) => patchRetry("maxBackoffMs", value(event.target.value))} /></div>
  </div></details>;
}

function EdgeInspector({
  edge,
  locked,
  onChange,
  onDelete,
}: {
  edge: HarnessEdge;
  locked: boolean;
  onChange: (connection: HarnessConnection) => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const connection = edge.data?.connection as EditableConnection;
  const id = useId().replace(/:/g, "");
  const condition = connection.condition ?? {};
  const state = connection.state ?? {};
  const patch = (value: Partial<EditableConnection>) => onChange({ ...connection, ...value } as HarnessConnection);
  const patchCondition = (value: Partial<EdgeCondition>) => {
    const next = { ...condition, ...value };
    patch({ condition: Object.values(next).some((item) => item !== undefined && item !== "") ? next : undefined });
  };
  const patchState = (value: Partial<EdgeState>) => {
    const next = { ...state, ...value };
    patch({ state: Object.values(next).some((item) => item !== undefined && item !== "") ? next : undefined });
  };

  return (
    <div className="inspector-body">
      <div className="component-id"><span>{edge.id}</span><span>{t("inspector.connection")}</span></div>
      <div className="edge-route">{connection.from.component}.{connection.from.port}<span>→</span>{connection.to.component}.{connection.to.port}</div>
      <fieldset disabled={locked} className="inspector-fieldset">
        <div className="field-grid">
          <div className="field-section">{t("inspector.edge.condition")}</div>
          <div className="field"><label htmlFor={`${id}-source`}>{t("inspector.edge.source")}</label><select id={`${id}-source`} value={condition.source ?? ""} onChange={(event) => patchCondition({ source: optionalText(event.target.value) })}><option value="">{t("inspector.edge.source.default")}</option><option value="value">{t("inspector.edge.source.value")}</option><option value="state">{t("inspector.edge.source.state")}</option><option value="input">{t("inspector.edge.source.input")}</option></select></div>
          <div className="field"><label htmlFor={`${id}-path`}>{t("inspector.edge.jsonPointer")}</label><input id={`${id}-path`} placeholder="/result/score" value={condition.path ?? ""} onChange={(event) => patchCondition({ path: optionalText(event.target.value) })} /></div>
          <div className="field"><label htmlFor={`${id}-operator`}>{t("inspector.edge.operator")}</label><select id={`${id}-operator`} value={condition.op ?? ""} onChange={(event) => patchCondition({ op: optionalText(event.target.value) })}><option value="">{t("inspector.edge.always")}</option>{["equals", "notEquals", "contains", "matches", "exists", "truthy", "gt", "gte", "lt", "lte"].map((operator) => <option key={operator} value={operator}>{operator}</option>)}</select></div>
          <JsonField id={`${id}-condition-value`} label={t("inspector.edge.compare")} value={condition.value} disabled={locked} onChange={(value) => patchCondition({ value })} />
          <div className="field-section">{t("inspector.edge.dataFlow")}</div>
          <div className="field"><label htmlFor={`${id}-select`}>{t("inspector.edge.selectPointer")}</label><input id={`${id}-select`} placeholder="/answer/text" value={connection.select ?? ""} onChange={(event) => patch({ select: optionalText(event.target.value) })} /></div>
          <div className="field"><label htmlFor={`${id}-state-key`}>{t("inspector.edge.stateKey")}</label><input id={`${id}-state-key`} placeholder="draft" value={state.key ?? ""} onChange={(event) => patchState({ key: optionalText(event.target.value) })} /></div>
          <div className="field"><label htmlFor={`${id}-state-merge`}>{t("inspector.edge.merge")}</label><select id={`${id}-state-merge`} value={state.merge ?? ""} onChange={(event) => patchState({ merge: optionalText(event.target.value) })}><option value="">{t("inspector.edge.merge.default")}</option><option value="replace">{t("inspector.edge.merge.replace")}</option><option value="append">{t("inspector.edge.merge.append")}</option></select></div>
        </div>
      </fieldset>
      <div className="inspector-actions"><button className="button" disabled={locked} onClick={onDelete}>{t("inspector.deleteConnection")}</button></div>
    </div>
  );
}

export function Inspector({
  node,
  edge,
  entrypoint,
  canSetEntrypoint,
  locked,
  onChange,
  onEdgeChange,
  onDelete,
  onDeleteEdge,
  onSetEntrypoint,
  onOpenSubgraph,
  subgraphs,
  connections,
  tools,
  onOpenConnections,
  focusPath,
  focusVersion = 0,
  specVersion,
  projectGraph,
  projectLocked = false,
  onProjectChanged,
  pinned = false,
  onPinnedChange,
  onRename,
}: {
  node?: HarnessNode;
  edge?: HarnessEdge;
  entrypoint: string;
  canSetEntrypoint: boolean;
  locked: boolean;
  onChange: (component: HarnessComponent) => void;
  onEdgeChange: (connection: HarnessConnection) => void;
  onDelete: () => void;
  onDeleteEdge: () => void;
  onSetEntrypoint: () => void;
  onOpenSubgraph?: (name: string) => void;
  subgraphs?: readonly string[];
  connections?: readonly ConnectionSummary[];
  tools?: readonly ToolCatalogItem[];
  onOpenConnections?: (kind?: ConnectionKind) => void;
  focusPath?: string;
  focusVersion?: number;
  specVersion: HarnessSpec["version"];
  projectGraph?: string;
  projectLocked?: boolean;
  onProjectChanged?: () => void | Promise<void>;
  pinned?: boolean;
  onPinnedChange?: (pinned: boolean) => void;
  onRename?: (nextId: string) => string | undefined;
}) {
  const { t } = useI18n();
  const inspectorRef = useRef<HTMLDivElement>(null);
  const [renameId, setRenameId] = useState(node?.id ?? "");
  const [renameError, setRenameError] = useState("");
  useEffect(() => {
    setRenameId(node?.id ?? "");
    setRenameError("");
  }, [node?.id]);
  useEffect(() => {
    if (!focusPath || !node) return undefined;
    let timeout: number | undefined;
    const frame = requestAnimationFrame(() => {
      const candidates = [...(inspectorRef.current?.querySelectorAll<HTMLElement>("[data-config-path]") ?? [])];
      const normalized = focusPath.replace(/^\$\.?/, "");
      const target = candidates.find((element) => {
        const path = element.dataset.configPath;
        return Boolean(path && (normalized === path || normalized.endsWith(`.${path}`) || normalized.endsWith(`/${path}`)));
      });
      if (!target) return;
      const advanced = target.closest<HTMLDetailsElement>("details");
      if (advanced) advanced.open = true;
      target.classList.add("is-diagnostic-focus");
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      target.querySelector<HTMLElement>("input, select, textarea, button")?.focus({ preventScroll: true });
      timeout = window.setTimeout(() => target.classList.remove("is-diagnostic-focus"), 1_800);
    });
    return () => {
      cancelAnimationFrame(frame);
      if (timeout) window.clearTimeout(timeout);
    };
  }, [focusPath, focusVersion, node?.id]);

  if (edge) return <EdgeInspector edge={edge} locked={locked} onChange={onEdgeChange} onDelete={onDeleteEdge} />;
  if (!node) return <div className="inspector-empty">{t("inspector.empty")}</div>;

  const component = node.data.component;
  const manifest = node.data.manifest;
  const config = component.config as Record<string, unknown>;
  const subgraph = component.type === "subgraph" || component.type === "loop"
    ? [config.subgraph, config.ref, config.name].find((value): value is string => typeof value === "string" && Boolean(value))
    : undefined;
  const hasConnectionField = connectionKindsFor(component, tools).length > 0;
  const editableFields = manifest.inspector.filter((field) => field.path !== "connectionId" && field.path !== "fallbackConnectionId" && field.path !== "apiKey"
    && !(component.type === "tool" && field.path === "tool"));
  const primaryFields = editableFields.filter((field) => !advancedField(component, field));
  const advancedFields = editableFields.filter((field) => advancedField(component, field));
  const lastRun = node.data.lastRun;

  return (
    <div ref={inspectorRef} className="inspector-body">
      <div className="component-id"><span>{component.id}</span><span>{componentLabel(t, manifest.type, manifest.label)}{entrypoint === component.id ? ` · ${t("inspector.entrypoint")}` : ""}</span></div>
      <Tabs.Root key={component.id} defaultValue="settings" className="inspector-tabs">
        <Tabs.List className="inspector-tab-list" aria-label={`${component.id} inspector`}>
          <Tabs.Tab value="settings">{t("inspector.settings")}</Tabs.Tab>
          <Tabs.Tab value="last-run">{t("inspector.lastRun")}{lastRun ? <span className={`tab-state is-${lastRun.state}`} /> : null}</Tabs.Tab>
          <Tabs.Indicator className="inspector-tab-indicator" />
        </Tabs.List>
        <Tabs.Panel value="settings" className="inspector-tab-panel">
          <fieldset disabled={locked} className="inspector-fieldset">
            <div className="field-grid">
              {onRename && <form className="field" data-config-path="id" onSubmit={(event) => {
                event.preventDefault();
                const nextId = renameId.trim();
                if (nextId === component.id) {
                  setRenameError("");
                  return;
                }
                setRenameError(onRename(nextId) ?? "");
              }}>
                <label htmlFor={`component-id-${component.id}`}>{t("inspector.componentId")}</label>
                <input id={`component-id-${component.id}`} value={renameId} maxLength={64} pattern="[A-Za-z][A-Za-z0-9_-]*" aria-invalid={Boolean(renameError)} onChange={(event) => { setRenameId(event.target.value); setRenameError(""); }} />
                {renameError && <span className="field-help is-error" role="alert">{renameError}</span>}
                <button className="button" type="submit" disabled={locked || renameId.trim() === component.id}>{t("inspector.rename")}</button>
              </form>}
              {component.type === "tool" && <ToolCatalogField component={component} tools={tools ?? []} locked={locked} onChange={onChange} />}
              {onOpenConnections && hasConnectionField && <ConnectionField component={component} connections={connections ?? []} tools={tools ?? []} locked={locked} onChange={onChange} onConnect={onOpenConnections} />}
              {onProjectChanged && <ProjectBindingField component={component} graph={projectGraph} locked={locked || projectLocked} onChanged={onProjectChanged} />}
              {component.type === "model" && typeof config.apiKey === "string" && config.apiKey.length > 0 && <div className="field-help is-error">{t("inspector.legacySecret")}</div>}
              {primaryFields.length
                ? primaryFields.map((field) => <ConfigField key={field.path} component={component} field={field} disabled={locked} onChange={onChange} />)
                : <div className="field-help">{t("inspector.noConfig")}</div>}
              {advancedFields.length > 0 && <details className="advanced-panel"><summary>{t("inspector.advanced")}</summary><div className="field-grid">{advancedFields.map((field) => <ConfigField key={field.path} component={component} field={field} disabled={locked} onChange={onChange} />)}</div></details>}
              {specVersion !== "0.1" && <ComponentPolicyFields component={component} locked={locked} onChange={onChange} />}
            </div>
          </fieldset>
          <div className="inspector-actions is-split">
            <span>
              {subgraph && onOpenSubgraph && <button className="button" disabled={locked} onClick={() => onOpenSubgraph(subgraph)}>{subgraphs?.includes(subgraph) ? t("inspector.openSubgraph") : t("inspector.createSubgraph")}</button>}
              {canSetEntrypoint && entrypoint !== component.id && <button className="button" disabled={locked} onClick={onSetEntrypoint}>{t("inspector.setEntrypoint")}</button>}
              {specVersion === "0.3" && onPinnedChange && <button className="button" disabled={locked} aria-pressed={pinned} onClick={() => onPinnedChange(!pinned)}>{t(pinned ? "inspector.unpin" : "inspector.pin")}</button>}
            </span>
            <button className="button" disabled={locked} onClick={onDelete}>{t("inspector.deleteComponent")}</button>
          </div>
        </Tabs.Panel>
        <Tabs.Panel value="last-run" className="inspector-tab-panel">
          {lastRun ? <div className="last-run-summary"><div className={`last-run-state is-${lastRun.state}`}><span>{lastRun.state}</span><strong>{lastRun.durationMs === undefined ? t("inspector.inProgress") : `${Math.round(lastRun.durationMs)} ms`}</strong></div><dl><div><dt>{t("inspector.run")}</dt><dd>{lastRun.runId ?? t("inspector.currentTrace")}</dd></div><div><dt>{t("inspector.events")}</dt><dd>{lastRun.eventCount}</dd></div><div><dt>{t("inspector.validation")}</dt><dd>{node.data.diagnostics?.length ? t("save.issues", { count: node.data.diagnostics.length }) : t("inspector.noIssues")}</dd></div></dl>{lastRun.error && <p role="alert">{lastRun.error}</p>}</div> : <div className="inspector-run-empty"><span>◇</span><strong>{t("inspector.noRun")}</strong><p>{t("inspector.noRunDescription")}</p></div>}
        </Tabs.Panel>
      </Tabs.Root>
    </div>
  );
}
