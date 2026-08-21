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
}) {
  if (edge) return <EdgeInspector edge={edge} locked={locked} onChange={onEdgeChange} onDelete={onDeleteEdge} />;
  if (!node) return <div className="inspector-empty">Select a component or connection to configure its runtime contract.</div>;

  const component = node.data.component;
  const manifest = node.data.manifest;
  const config = component.config as Record<string, unknown>;
  const subgraph = component.type === "subgraph" || component.type === "loop"
    ? [config.subgraph, config.ref, config.name].find((value): value is string => typeof value === "string" && Boolean(value))
    : undefined;

  return (
    <div className="inspector-body">
      <div className="component-id"><span>{component.id}</span><span>{manifest.label}{entrypoint === component.id ? " · entrypoint" : ""}</span></div>
      <fieldset disabled={locked} className="inspector-fieldset">
        <div className="field-grid">
          {manifest.inspector.length
            ? manifest.inspector.map((field) => <ConfigField key={field.path} component={component} field={field} disabled={locked} onChange={onChange} />)
            : <div className="field-help">This component has no editable configuration.</div>}
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
