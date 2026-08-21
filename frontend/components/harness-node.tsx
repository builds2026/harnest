"use client";

import type { PortDefinition } from "@harnest/core";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { memo, type CSSProperties } from "react";
import { colorFor, componentSummary, glyphFor } from "@/lib/component-catalog";
import type { HarnessNode } from "@/lib/studio-state";

function PortRow({
  direction,
  name,
  definition,
  onAdd,
}: {
  direction: "input" | "output";
  name: string;
  definition: PortDefinition;
  onAdd?: () => void;
}) {
  const color = colorFor(definition.type);
  const style = { "--port-color": color } as CSSProperties;
  const input = direction === "input";

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
      {input && onAdd && <button className="port-add nodrag nopan" type="button" aria-label={`Add compatible ${name}`} title={`Add compatible ${name}`} onClick={onAdd}>+</button>}
      <span>{input ? "" : `${name}:${definition.type}`}</span>
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
            direction="input"
            name={name}
            definition={definition}
            onAdd={manifest.type === "agent" && /tool/i.test(name)
              ? () => data.onAddAttachment?.(component.id, "tools")
              : manifest.type === "agent" && /skill/i.test(name)
                ? () => data.onAddAttachment?.(component.id, "skills")
                : undefined}
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
          <PortRow key={`output-${name}`} direction="output" name={name} definition={definition} />
        ))}
      </div>
    </div>
  );
}

export const HarnessNodeComponent = memo(HarnessNodeView);
