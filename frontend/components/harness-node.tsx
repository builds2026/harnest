"use client";

import type { PortDefinition } from "@harnest/core";
import { Popover } from "@base-ui/react/popover";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { memo, useMemo, useRef, useState, type CSSProperties } from "react";
import { colorFor, componentSummary, glyphFor } from "@/lib/component-catalog";
import type { CanvasPortAnchor, CanvasPortInsertion, HarnessNode } from "@/lib/studio-state";

function PortInsertMenu({
  anchor,
  getOptions,
  onInsert,
}: {
  anchor: CanvasPortAnchor;
  getOptions: (anchor: CanvasPortAnchor) => readonly CanvasPortInsertion[];
  onInsert: (anchor: CanvasPortAnchor, insertion: CanvasPortInsertion) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<readonly CanvasPortInsertion[]>([]);
  const search = useRef<HTMLInputElement>(null);
  const visible = useMemo(() => {
    const value = query.trim().toLocaleLowerCase();
    return options.filter((option) => !value || `${option.label} ${option.type} ${option.category} ${option.description}`
      .toLocaleLowerCase().includes(value));
  }, [options, query]);
  const directionLabel = anchor.direction === "output" ? "after" : "before";

  return <Popover.Root open={open} onOpenChange={(next) => {
    setOpen(next);
    if (next) setOptions(getOptions(anchor));
    else setQuery("");
  }} modal="trap-focus">
    <Popover.Trigger
      className="port-add nodrag nopan"
      aria-label={`Add a compatible component ${directionLabel} ${anchor.nodeId}.${anchor.port}`}
      title={`Add compatible component ${directionLabel} this port`}
    >+</Popover.Trigger>
    <Popover.Portal>
      <Popover.Positioner side={anchor.direction === "output" ? "right" : "left"} align="center" sideOffset={12} collisionPadding={12}>
        <Popover.Popup className="port-picker" initialFocus={search}>
          <header><span>Connect {directionLabel}</span><strong>{anchor.nodeId}.{anchor.port}</strong></header>
          <label><span className="sr-only">Search compatible components</span><input ref={search} type="search" placeholder="Search components…" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
          <div className="port-picker-list">
            {visible.length ? visible.map((option) => <button
              key={`${option.type}:${option.connectPort}`}
              type="button"
              onClick={() => { onInsert(anchor, option); setOpen(false); }}
            ><span className="port-picker-glyph" style={{ "--port-color": colorFor(option.category) } as CSSProperties}>{glyphFor(option.label)}</span><span><strong>{option.label}</strong><small>{option.category} · {option.connectPort}:{option.connectType}</small><small>{option.description}</small></span></button>) : <p>No compatible component matches this search.</p>}
          </div>
          <Popover.Close className="sr-only">Close compatible component menu</Popover.Close>
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
  const component = data.component;
  const manifest = data.manifest;
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
        <span className="node-glyph" aria-hidden="true">{glyphFor(manifest.label)}</span>
        <span>
          <span className="node-label">{component.id}</span>
          <span className="node-kind">{manifest.label}</span>
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
            <button className="node-attachment nodrag nopan" type="button" onClick={() => data.onAddAttachment?.(component.id, "tools")}>+ Tool</button>
            <button className="node-attachment nodrag nopan" type="button" onClick={() => data.onAddAttachment?.(component.id, "skills")}>+ Skill</button>
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
