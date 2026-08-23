"use client";

import { useEffect, useId, useState } from "react";
import type { InspectorField } from "@harnest/core";
import { configValue, withConfigValue } from "@/lib/component-catalog";
import type {
  HarnessComponent,
  HarnessConnection,
  HarnessEdge,
  HarnessNode,
} from "@/lib/studio-state";
import {
  connectionCanRun,
  connectionKindLabel,
  type ConnectionKind,
  type ConnectionSummary,
} from "@/lib/connections";
import type { ToolCatalogItem } from "@/lib/studio-catalog";

type EdgeCondition = { source?: string; path?: string; op?: string; value?: unknown };
type EdgeState = { key?: string; merge?: string };
type EditableConnection = HarnessConnection & {
  condition?: EdgeCondition;
  select?: string;
  state?: EdgeState;
};

const optionalText = (value: string) => value === "" ? undefined : value;
const fieldId = (prefix: string, path: string) => `${prefix}-${path.replace(/[^A-Za-z0-9_-]/g, "-")}`;

function JsonField({
  id,
  label,
  value,
  required,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: unknown;
  required?: boolean;
  disabled?: boolean;
  onChange: (value: unknown) => void;
}) {
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
      setError("Enter valid JSON before leaving this field.");
    }
  };

  return (
    <div className="field">
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
      <span id={messageId} className={`field-help ${error ? "is-error" : ""}`}>{error || "JSON is applied when focus leaves the field."}</span>
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
  const prefix = useId().replace(/:/g, "");
  const id = fieldId(`${prefix}-${component.id}`, field.path);
  const config = component.config as Record<string, unknown>;
  const value = configValue(config, field.path);
  const update = (next: unknown) => onChange({
    ...component,
    config: withConfigValue(config, field.path, next),
  } as HarnessComponent);

  if (field.control === "json") return (
    <JsonField id={id} label={field.label} value={value} required={field.required} disabled={disabled} onChange={update} />
  );

  if (field.control === "checkbox") return (
    <div className="field field-checkbox">
      <input id={id} type="checkbox" disabled={disabled} checked={Boolean(value)} onChange={(event) => update(event.target.checked)} />
      <label htmlFor={id}>{field.label}</label>
    </div>
  );

  if (field.control === "select") return (
    <div className="field">
      <label htmlFor={id}>{field.label}</label>
      <select id={id} required={field.required} disabled={disabled} value={value === undefined ? "" : String(value)} onChange={(event) => {
        const selected = field.options?.find((option) => String(option.value) === event.target.value);
        update(selected?.value ?? optionalText(event.target.value));
      }}>
        {!field.required && <option value="">Not set</option>}
        {field.options?.map((option) => <option key={String(option.value)} value={String(option.value)}>{option.label}</option>)}
      </select>
    </div>
  );

  const multiline = field.control === "textarea";
  return (
    <div className="field">
      <label htmlFor={id}>{field.label}</label>
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
    <div className="connection-field">
      <div className="field-section">Connection</div>
      <div className="field">
        <label htmlFor={`connection-${component.id}`}>Reusable connection</label>
        <select id={`connection-${component.id}`} disabled={locked} value={selectedId} onChange={(event) => update(event.target.value)}>
          <option value="">Choose a connection</option>
          {compatible.map((connection) => <option key={connection.id} value={connection.id} disabled={!connectionCanRun(connection)}>{connection.name} · {connectionKindLabel(connection.kind)} · {connection.status.replaceAll("_", " ")}</option>)}
        </select>
        {selected
          ? <span className={`field-help connection-inline-status is-${selected.status}`}>{selected.status.replaceAll("_", " ")}</span>
          : <span className="field-help">Credentials stay in the local store; only this ID is saved in harnest.yaml.</span>}
      </div>
      {component.type === "model" && <div className="field">
        <label htmlFor={`fallback-connection-${component.id}`}>Fallback provider</label>
        <select id={`fallback-connection-${component.id}`} disabled={locked || !selectedId} value={fallbackId} onChange={(event) => updateFallback(event.target.value)}>
          <option value="">No fallback</option>
          {compatible.filter(({ id }) => id !== selectedId).map((connection) => <option key={connection.id} value={connection.id} disabled={!connectionCanRun(connection)}>{connection.name} · {connection.status.replaceAll("_", " ")}</option>)}
        </select>
        <span className="field-help">Used once when the primary provider reports a retryable failure.</span>
      </div>}
      <button type="button" className="button" disabled={locked} onClick={() => onConnect(preferred)}>{compatible.length ? "Manage connections" : "Connect"}</button>
    </div>
  );
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
      <div className="component-id"><span>{edge.id}</span><span>Connection</span></div>
      <div className="edge-route">{connection.from.component}.{connection.from.port}<span>→</span>{connection.to.component}.{connection.to.port}</div>
      <fieldset disabled={locked} className="inspector-fieldset">
        <div className="field-grid">
          <div className="field-section">Condition</div>
          <div className="field"><label htmlFor={`${id}-source`}>Source</label><select id={`${id}-source`} value={condition.source ?? ""} onChange={(event) => patchCondition({ source: optionalText(event.target.value) })}><option value="">Default (edge value)</option><option value="value">Edge value (explicit)</option><option value="state">Run state</option><option value="input">Run input</option></select></div>
          <div className="field"><label htmlFor={`${id}-path`}>JSON Pointer</label><input id={`${id}-path`} placeholder="/result/score" value={condition.path ?? ""} onChange={(event) => patchCondition({ path: optionalText(event.target.value) })} /></div>
          <div className="field"><label htmlFor={`${id}-operator`}>Operator</label><select id={`${id}-operator`} value={condition.op ?? ""} onChange={(event) => patchCondition({ op: optionalText(event.target.value) })}><option value="">Always</option>{["equals", "notEquals", "contains", "matches", "exists", "truthy", "gt", "gte", "lt", "lte"].map((operator) => <option key={operator} value={operator}>{operator}</option>)}</select></div>
          <JsonField id={`${id}-condition-value`} label="Compare with" value={condition.value} disabled={locked} onChange={(value) => patchCondition({ value })} />
          <div className="field-section">Data flow</div>
          <div className="field"><label htmlFor={`${id}-select`}>Select JSON Pointer</label><input id={`${id}-select`} placeholder="/answer/text" value={connection.select ?? ""} onChange={(event) => patch({ select: optionalText(event.target.value) })} /></div>
          <div className="field"><label htmlFor={`${id}-state-key`}>State key</label><input id={`${id}-state-key`} placeholder="draft" value={state.key ?? ""} onChange={(event) => patchState({ key: optionalText(event.target.value) })} /></div>
          <div className="field"><label htmlFor={`${id}-state-merge`}>Merge strategy</label><select id={`${id}-state-merge`} value={state.merge ?? ""} onChange={(event) => patchState({ merge: optionalText(event.target.value) })}><option value="">Default (replace)</option><option value="replace">Replace (explicit)</option><option value="append">Append</option></select></div>
        </div>
      </fieldset>
      <div className="inspector-actions"><button className="button" disabled={locked} onClick={onDelete}>Delete connection</button></div>
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
}) {
  if (edge) return <EdgeInspector edge={edge} locked={locked} onChange={onEdgeChange} onDelete={onDeleteEdge} />;
  if (!node) return <div className="inspector-empty">Select a component or connection to configure its runtime contract.</div>;

  const component = node.data.component;
  const manifest = node.data.manifest;
  const config = component.config as Record<string, unknown>;
  const subgraph = component.type === "subgraph" || component.type === "loop"
    ? [config.subgraph, config.ref, config.name].find((value): value is string => typeof value === "string" && Boolean(value))
    : undefined;
  const hasConnectionField = connectionKindsFor(component, tools).length > 0;
  const editableFields = manifest.inspector.filter((field) => field.path !== "connectionId" && field.path !== "apiKey");
  const primaryFields = editableFields.filter((field) => !advancedField(component, field));
  const advancedFields = editableFields.filter((field) => advancedField(component, field));

  return (
    <div className="inspector-body">
      <div className="component-id"><span>{component.id}</span><span>{manifest.label}{entrypoint === component.id ? " · entrypoint" : ""}</span></div>
      <fieldset disabled={locked} className="inspector-fieldset">
        <div className="field-grid">
          {onOpenConnections && hasConnectionField && <ConnectionField component={component} connections={connections ?? []} tools={tools ?? []} locked={locked} onChange={onChange} onConnect={onOpenConnections} />}
          {component.type === "model" && typeof config.apiKey === "string" && config.apiKey.length > 0 && <div className="field-help is-error">This legacy Model contains a plaintext API key. Move it to a write-only Provider Connection, then remove it in Advanced YAML.</div>}
          {primaryFields.length
            ? primaryFields.map((field) => <ConfigField key={field.path} component={component} field={field} disabled={locked} onChange={onChange} />)
            : <div className="field-help">This component has no editable configuration.</div>}
          {advancedFields.length > 0 && <details className="advanced-panel"><summary>Advanced</summary><div className="field-grid">{advancedFields.map((field) => <ConfigField key={field.path} component={component} field={field} disabled={locked} onChange={onChange} />)}</div></details>}
        </div>
      </fieldset>
      <div className="inspector-actions is-split">
        <span>
          {subgraph && onOpenSubgraph && <button className="button" disabled={locked} onClick={() => onOpenSubgraph(subgraph)}>{subgraphs?.includes(subgraph) ? "Open subgraph" : "Create subgraph"}</button>}
          {canSetEntrypoint && entrypoint !== component.id && <button className="button" disabled={locked} onClick={onSetEntrypoint}>Set as entrypoint</button>}
        </span>
        <button className="button" disabled={locked} onClick={onDelete}>Delete component</button>
      </div>
    </div>
  );
}
