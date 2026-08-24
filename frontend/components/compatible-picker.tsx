"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { connectionCanRun, type ConnectionKind, type ConnectionSummary } from "@/lib/connections";
import type { SkillCatalogItem, ToolCatalogItem } from "@/lib/studio-catalog";
import { useI18n } from "./i18n-provider";

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
  const { t } = useI18n();
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
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="picker-backdrop" />
        <Dialog.Viewport className="connection-sheet-viewport">
      <Dialog.Popup className="compatible-picker">
        <header className="picker-header"><div><span className="sheet-eyebrow">{t("picker.compatible", { id: nodeId })}</span><Dialog.Title id="compatible-picker-title">{t(slot === "tools" ? "picker.addTool" : "picker.addSkill")}</Dialog.Title></div><Dialog.Close className="sheet-close" aria-label={t("picker.close")}>×</Dialog.Close></header>
        <div className="picker-search"><label className="sr-only" htmlFor="compatible-search">{t("picker.search")}</label><input ref={search} id="compatible-search" type="search" placeholder={t("picker.search")} value={query} onChange={(event) => setQuery(event.target.value)} /></div>
        <div className="picker-list">
          {items.length ? items.map((item) => {
            const compatible = item.connectionKinds?.some((kind) => connections.some((connection) =>
              connection.kind === kind && connectionCanRun(connection)));
            const required = item.connectionKinds?.length && !compatible ? item.connectionKinds[0] : undefined;
            const unavailable = "installed" in item && item.installed === false;
            return <article key={item.id} className="picker-item"><div><strong>{item.label}</strong><span>{item.category} · {item.description}{"scriptsPresent" in item && item.scriptsPresent ? ` · ${t("picker.scriptsGated")}` : ""}</span></div>{required
              ? <button className="button" onClick={() => onConnect(required, item.id)}>{t("picker.connectFirst")}</button>
              : <button className="button button-primary" disabled={unavailable} title={unavailable ? t("picker.installHelp") : undefined} onClick={() => slot === "tools" ? onTool(item as ToolCatalogItem) : onSkill(item as SkillCatalogItem)}>{unavailable ? t("picker.notInstalled") : t("common.add")}</button>}</article>;
          }) : <div className="connection-empty"><strong>{t(slot === "skills" ? "picker.emptySkills" : "picker.emptyTools")}</strong><span>{t(slot === "skills" ? "picker.emptySkillsHelp" : "picker.emptyToolsHelp")}</span></div>}
        </div>
      </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
