"use client";

import type { PortDefinition } from "@harnest/core";
import { Popover } from "@base-ui/react/popover";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { memo, useMemo, useRef, useState, type CSSProperties } from "react";
import { colorFor, componentSummary, glyphFor } from "@/lib/component-catalog";
import type { CanvasPortAnchor, CanvasPortInsertion, HarnessNode } from "@/lib/studio-state";
import { componentLabel } from "@/i18n/manifest";
import { useI18n } from "./i18n-provider";

function PortInsertMenu({
  anchor,
  getOptions,
  onInsert,
}: {
  anchor: CanvasPortAnchor;
  getOptions: (anchor: CanvasPortAnchor) => readonly CanvasPortInsertion[];
  onInsert: (anchor: CanvasPortAnchor, insertion: CanvasPortInsertion) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<readonly CanvasPortInsertion[]>([]);
  const search = useRef<HTMLInputElement>(null);
  const visible = useMemo(() => {
    const value = query.trim().toLocaleLowerCase();
    return options.filter((option) => !value || `${option.label} ${option.type} ${option.category} ${option.description}`
      .toLocaleLowerCase().includes(value));
  }, [options, query]);
  const directionLabel = t(anchor.direction === "output" ? "port.direction.after" : "port.direction.before");
  const target = `${anchor.nodeId}.${anchor.port}`;

  return <Popover.Root open={open} onOpenChange={(next) => {
    setOpen(next);
    if (next) setOptions(getOptions(anchor));
    else setQuery("");
  }} modal="trap-focus">
    <Popover.Trigger
      className="port-add nodrag nopan"
      aria-label={t("port.addAccessible", { direction: directionLabel, target })}
      title={t("port.addTitle", { direction: directionLabel })}
    >+</Popover.Trigger>
    <Popover.Portal>
      <Popover.Positioner side={anchor.direction === "output" ? "right" : "left"} align="center" sideOffset={12} collisionPadding={12}>
        <Popover.Popup className="port-picker" initialFocus={search}>
          <header><span>{t("port.connect", { direction: directionLabel })}</span><strong>{target}</strong></header>
          <label><span className="sr-only">{t("port.search")}</span><input ref={search} type="search" placeholder={t("port.search.placeholder")} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
          <div className="port-picker-list">
            {visible.length ? visible.map((option) => <button
              key={`${option.type}:${option.connectPort}`}
              type="button"
              onClick={() => { onInsert(anchor, option); setOpen(false); }}
            ><span className="port-picker-glyph" style={{ "--port-color": colorFor(option.category) } as CSSProperties}>{glyphFor(option.label)}</span><span><strong>{componentLabel(t, option.type, option.label)}</strong><small>{option.category} · {option.connectPort}:{option.connectType}</small><small>{option.description}</small></span></button>) : <p>{t("port.empty")}</p>}
          </div>
          <Popover.Close className="sr-only">{t("port.close")}</Popover.Close>
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>;
}

function PortRow({
  nodeId,
  direction,
  name,
  definition,
  canInsert,
  getInsertions,
  onInsert,
}: {
  nodeId: string;
  direction: "input" | "output";
  name: string;
  definition: PortDefinition;
  canInsert?: (anchor: CanvasPortAnchor) => boolean;
  getInsertions?: (anchor: CanvasPortAnchor) => readonly CanvasPortInsertion[];
  onInsert?: (anchor: CanvasPortAnchor, insertion: CanvasPortInsertion) => void;
}) {
  const color = colorFor(definition.type);
  const style = { "--port-color": color } as CSSProperties;
  const input = direction === "input";
  const anchor = { nodeId, direction, port: name } as const;
  const insertable = canInsert?.(anchor) ?? false;

  return (
    <div className={`port-row is-${direction}`} style={style}>
      {input && (
        <Handle
          id={name}
          type="target"
          position={Position.Left}
          aria-label={`${name} ${definition.type} input`}
          style={{ left: -17 }}
        />
      )}
      <span>{input ? `${name}:${definition.type}` : ""}</span>
      {input && insertable && getInsertions && onInsert && <PortInsertMenu anchor={anchor} getOptions={getInsertions} onInsert={onInsert} />}
      <span>{input ? "" : `${name}:${definition.type}`}</span>
      {!input && insertable && getInsertions && onInsert && <PortInsertMenu anchor={anchor} getOptions={getInsertions} onInsert={onInsert} />}
      {!input && (
        <Handle
          id={name}
          type="source"
          position={Position.Right}
          aria-label={`${name} ${definition.type} output`}
          style={{ right: -17 }}
        />
      )}
    </div>
  );
}

function HarnessNodeView({ data }: NodeProps<HarnessNode>) {
  const { t } = useI18n();
  const component = data.component;
  const manifest = data.manifest;
  const label = componentLabel(t, manifest.type, manifest.label);
  const color = colorFor(manifest.category);
  const ports = manifest.ports;
  const inputs = Object.entries(ports.inputs) as [string, PortDefinition][];
  const outputs = Object.entries(ports.outputs) as [string, PortDefinition][];
  const runState = data.runState ?? "idle";
  const diagnosticCount = data.diagnostics?.filter((item) => item.severity === "error").length ?? 0;
  const style = { "--node-color": color } as CSSProperties;
  const stateLabel = diagnosticCount ? `${diagnosticCount} validation issue(s)` : runState;

  return (
    <div className={`h-node is-${runState}`} style={style}>
      <div className="node-header">
        <span className="node-glyph" aria-hidden="true">{glyphFor(label)}</span>
        <span>
          <span className="node-label">{component.id}</span>
          <span className="node-kind">{label}</span>
        </span>
        <span className="node-signals">
          {data.iteration !== undefined && <span className="node-iteration" title={`Iteration ${data.iteration}`}>↻{data.iteration}</span>}
          <span
            className={`node-state is-${diagnosticCount ? "error" : runState}`}
            title={stateLabel}
            role="status"
            aria-label={`${component.id}: ${stateLabel}`}
          />
        </span>
      </div>
      <div className="node-body">
        {inputs.map(([name, definition]) => (
          <PortRow
            key={`input-${name}`}
            nodeId={component.id}
            direction="input"
            name={name}
            definition={definition}
            canInsert={data.locked ? undefined : data.canInsertAtPort}
            getInsertions={data.locked ? undefined : data.getPortInsertions}
            onInsert={data.onInsertAtPort}
          />
        ))}
        {manifest.type === "agent" && !inputs.some(([name]) => /skill/i.test(name)) && (
          <div className="agent-attachment-row">
            <button className="node-attachment nodrag nopan" type="button" onClick={() => data.onAddAttachment?.(component.id, "tools")}>+ {t("builder.catalog.tools")}</button>
            <button className="node-attachment nodrag nopan" type="button" onClick={() => data.onAddAttachment?.(component.id, "skills")}>+ {t("builder.catalog.skills")}</button>
          </div>
        )}
        <div className="node-summary" title={componentSummary(component, manifest)}>{componentSummary(component, manifest)}</div>
        {outputs.map(([name, definition]) => (
          <PortRow key={`output-${name}`} nodeId={component.id} direction="output" name={name} definition={definition} canInsert={data.locked ? undefined : data.canInsertAtPort} getInsertions={data.locked ? undefined : data.getPortInsertions} onInsert={data.onInsertAtPort} />
        ))}
      </div>
    </div>
  );
}

export const HarnessNodeComponent = memo(HarnessNodeView);
