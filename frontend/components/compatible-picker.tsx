"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { connectionCanRun, type ConnectionKind, type ConnectionSummary } from "@/lib/connections";
import type { SkillCatalogItem, ToolCatalogItem } from "@/lib/studio-catalog";

export function CompatiblePicker({
  open,
  slot,
  nodeId,
  tools,
  skills,
  connections,
  onClose,
  onTool,
  onSkill,
  onConnect,
}: {
  open: boolean;
  slot: "tools" | "skills";
  nodeId: string;
  tools: readonly ToolCatalogItem[];
  skills: readonly SkillCatalogItem[];
  connections: readonly ConnectionSummary[];
  onClose: () => void;
  onTool: (tool: ToolCatalogItem) => void;
  onSkill: (skill: SkillCatalogItem) => void;
  onConnect: (kind: ConnectionKind, itemId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    queueMicrotask(() => search.current?.focus());
  }, [open]);

  const items = useMemo(() => {
    const value = query.trim().toLocaleLowerCase();
    return (slot === "tools" ? tools : skills).filter((item) => !value
      || `${item.label} ${item.description} ${item.category}`.toLocaleLowerCase().includes(value));
  }, [query, skills, slot, tools]);

  if (!open) return null;
  return (
    <div className="picker-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="compatible-picker" role="dialog" aria-modal="true" aria-labelledby="compatible-picker-title">
        <header className="picker-header"><div><span className="sheet-eyebrow">Compatible with {nodeId}</span><h2 id="compatible-picker-title">Add {slot === "tools" ? "a tool" : "a skill"}</h2></div><button className="sheet-close" aria-label="Close compatible picker" onClick={onClose}>×</button></header>
        <div className="picker-search"><label className="sr-only" htmlFor="compatible-search">Search compatible items</label><input ref={search} id="compatible-search" type="search" placeholder={`Search ${slot}`} value={query} onChange={(event) => setQuery(event.target.value)} /></div>
        <div className="picker-list">
          {items.length ? items.map((item) => {
            const compatible = item.connectionKinds?.some((kind) => connections.some((connection) =>
              connection.kind === kind && connectionCanRun(connection)));
            const required = item.connectionKinds?.length && !compatible ? item.connectionKinds[0] : undefined;
            const unavailable = "installed" in item && item.installed === false;
            return <article key={item.id} className="picker-item"><div><strong>{item.label}</strong><span>{item.category} · {item.description}{"scriptsPresent" in item && item.scriptsPresent ? " · scripts approval-gated" : ""}</span></div>{required
              ? <button className="button" onClick={() => onConnect(required, item.id)}>Connect first</button>
              : <button className="button button-primary" disabled={unavailable} title={unavailable ? "Install this tool package before adding it" : undefined} onClick={() => slot === "tools" ? onTool(item as ToolCatalogItem) : onSkill(item as SkillCatalogItem)}>{unavailable ? "Not installed" : "Add"}</button>}</article>;
          }) : <div className="connection-empty"><strong>No compatible {slot}</strong><span>{slot === "skills" ? "Add a project or user skill to make it available here." : "Install a tool package or change the search."}</span></div>}
        </div>
      </section>
    </div>
  );
}
