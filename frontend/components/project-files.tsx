"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type InputHTMLAttributes } from "react";
import { apiErrorMessage, requestJson } from "@/lib/api-client";
import { useI18n } from "./i18n-provider";
import { Button, ConfirmDialog } from "./ui/ui";
import styles from "./project-files.module.css";

interface ProjectFileSummary {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly editable: boolean;
}

interface ProjectFile extends Omit<ProjectFileSummary, "editable"> {
  readonly content: string;
}

const SOURCE_KINDS = {
  prompts: { extension: ".md", initial: "{{input}}\n" },
  context: { extension: ".md", initial: "" },
  schemas: { extension: ".json", initial: "{}\n" },
  tests: { extension: ".json", initial: "[]\n" },
  config: { extension: ".json", initial: "{}\n" },
} as const;

export function ProjectFiles({ locked, onChanged }: { locked: boolean; onChanged: () => void | Promise<void> }) {
  const { t, formatNumber } = useI18n();
  const [root, setRoot] = useState("");
  const [managed, setManaged] = useState(false);
  const [files, setFiles] = useState<readonly ProjectFileSummary[]>([]);
  const [selected, setSelected] = useState<ProjectFile>();
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [createKind, setCreateKind] = useState<keyof typeof SOURCE_KINDS>("prompts");
  const [createName, setCreateName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const folderInput = useRef<HTMLInputElement>(null);
  const dirty = selected !== undefined && content !== selected.content;
  const directoryInput = { webkitdirectory: "", directory: "" } as InputHTMLAttributes<HTMLInputElement>;

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const payload = await requestJson<{
        project: { root: string; managed?: boolean } | null;
        files: ProjectFileSummary[];
      }>("/api/project", { cache: "no-store" });
      setRoot(payload.project?.root ?? "");
      setManaged(payload.project?.managed === true);
      setFiles(payload.files);
      setError("");
    } catch (cause) {
      setError(apiErrorMessage(cause, t("project.loadFailed"), t));
    } finally {
      setBusy(false);
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  const open = async (file: ProjectFileSummary) => {
    if (!file.editable || dirty) return;
    setBusy(true);
    try {
      const payload = await requestJson<{ file: ProjectFile }>(`/api/project?path=${encodeURIComponent(file.path)}`, { cache: "no-store" });
      setSelected(payload.file);
      setContent(payload.file.content);
      setError("");
    } catch (cause) {
      setError(apiErrorMessage(cause, t("project.openFailed"), t));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!selected || !dirty) return;
    setBusy(true);
    try {
      const payload = await requestJson<{ file: ProjectFile }>("/api/project", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: selected.path, content, sha256: selected.sha256 }),
      });
      setSelected(payload.file);
      setContent(payload.file.content);
      setError("");
      await load();
      await onChanged();
    } catch (cause) {
      setError(apiErrorMessage(cause, t("project.saveFailed"), t));
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    const name = createName.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(name)) {
      setError(t("project.nameInvalid"));
      return;
    }
    const source = SOURCE_KINDS[createKind];
    const filename = name.toLocaleLowerCase().endsWith(source.extension) ? name : `${name}${source.extension}`;
    setBusy(true);
    try {
      const payload = await requestJson<{ file: ProjectFile }>("/api/project", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "create", path: `.harnest/${createKind}/${filename}`, content: source.initial }),
      });
      setCreateOpen(false);
      setCreateName("");
      setSelected(payload.file);
      setContent(payload.file.content);
      setError("");
      await load();
    } catch (cause) {
      setError(apiErrorMessage(cause, t("project.createFailed"), t));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await requestJson("/api/project", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: selected.path, sha256: selected.sha256 }),
      });
      setSelected(undefined);
      setContent("");
      setError("");
      await load();
      await onChanged();
    } catch (cause) {
      setError(apiErrorMessage(cause, t("project.deleteFailed"), t));
    } finally {
      setBusy(false);
    }
  };

  const openFolder = async (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = [...(event.target.files ?? [])];
    event.target.value = "";
    if (!selectedFiles.length) return;
    const commonRoot = selectedFiles[0]?.webkitRelativePath.split("/")[0] ?? "Project";
    const entries = selectedFiles.flatMap((file) => {
      const relative = file.webkitRelativePath || file.name;
      const segments = relative.split("/");
      const path = (segments.length > 1 ? segments.slice(1) : segments).join("/");
      if (!path || segments.some((segment) => [".git", "node_modules", ".next", "dist", "build", "coverage"].includes(segment))) return [];
      if (/(?:^|\/)\.env(?:\..+)?$/iu.test(path) && !path.endsWith(".env.example")) return [];
      if (file.size <= 0 || file.size > 16 * 1_048_576) return [];
      return [{ file, path }];
    });
    const total = entries.reduce((sum, { file }) => sum + file.size, 0);
    if (!entries.length || entries.length > 2_000 || total > 64 * 1_048_576) {
      setError(t("project.importLimit"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.set("name", commonRoot);
      form.set("paths", JSON.stringify(entries.map(({ path }) => path)));
      for (const { file } of entries) form.append("file", file, file.name);
      await requestJson("/api/project/import", { method: "POST", body: form }, { timeoutMs: 120_000 });
      globalThis.location.assign("/builder");
    } catch (cause) {
      setError(apiErrorMessage(cause, t("project.importFailed"), t));
      setBusy(false);
    }
  };

  if (!root && !busy && files.length === 0) return <div className={styles.empty}><strong>{t("project.legacyTitle")}</strong><span>{error || t("project.legacyDescription")}</span><Button variant="primary" disabled={locked} onClick={() => folderInput.current?.click()}>{t("project.openFolder")}</Button><input {...directoryInput} ref={folderInput} className={styles.hiddenInput} type="file" multiple onChange={(event) => void openFolder(event)} /></div>;

  return <div className={styles.root}>
    <aside className={styles.sidebar} aria-label={t("project.files")}>
      <div className={styles.projectHeader}><span className={styles.project} title={root}>{root.split(/[\\/]/).filter(Boolean).at(-1) || t("common.loading")}{managed && <small>{t("project.managedCopy")}</small>}</span><span className={styles.headerActions}><Button size="small" disabled={busy || locked || dirty} onClick={() => setCreateOpen((value) => !value)}>{t("project.newSource")}</Button><Button size="small" disabled={busy || locked || dirty} onClick={() => folderInput.current?.click()}>{t("project.openFolder")}</Button></span><input {...directoryInput} ref={folderInput} className={styles.hiddenInput} type="file" multiple onChange={(event) => void openFolder(event)} />{createOpen && <div className={styles.createRow}><select aria-label={t("project.sourceKind")} value={createKind} onChange={(event) => setCreateKind(event.target.value as keyof typeof SOURCE_KINDS)}>{(Object.keys(SOURCE_KINDS) as Array<keyof typeof SOURCE_KINDS>).map((kind) => <option key={kind} value={kind}>{t(`project.kind.${kind}`)}</option>)}</select><input autoFocus aria-label={t("project.sourceName")} value={createName} placeholder={t("project.sourceNamePlaceholder")} onChange={(event) => setCreateName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void create(); }} /><Button size="small" variant="primary" disabled={busy || !createName.trim()} onClick={() => void create()}>{t("common.create")}</Button></div>}</div>
      {files.map((file) => <button
        type="button"
        key={file.path}
        className={styles.file}
        data-active={selected?.path === file.path}
        disabled={busy || !file.editable || (dirty && selected?.path !== file.path)}
        title={file.editable ? file.path : t("project.binary")}
        onClick={() => void open(file)}
      ><span>{file.path.replace(/^\.harnest\//, "")}</span><small>{formatNumber(file.size)} B</small></button>)}
    </aside>
    <section className={styles.editor}>
      {selected ? <>
        <header className={styles.heading}><code>{selected.path}</code>{dirty && <span>{t("save.unsaved")}</span>}</header>
        <textarea className={styles.textarea} value={content} disabled={busy || locked} spellCheck={false} aria-label={selected.path} onChange={(event) => setContent(event.target.value)} />
        <footer className={styles.actions}>
          <span>{error && <strong className={styles.error} role="status">{error}</strong>}</span>
          <span><Button disabled={busy || dirty || locked} onClick={() => setConfirmDelete(true)}>{t("common.remove")}</Button><Button disabled={busy || !dirty || locked} onClick={() => setContent(selected.content)}>{t("common.discard")}</Button><Button variant="primary" disabled={busy || !dirty || locked} onClick={() => void save()}>{busy ? t("save.saving") : t("common.save")}</Button></span>
        </footer>
      </> : <div className={styles.empty}><strong>{t("project.selectTitle")}</strong><span>{error || t("project.selectDescription")}</span></div>}
    </section>
    <ConfirmDialog open={confirmDelete} title={t("project.deleteTitle")} description={t("project.deleteDescription", { path: selected?.path ?? "" })} confirmLabel={t("common.remove")} cancelLabel={t("common.cancel")} danger onOpenChange={setConfirmDelete} onConfirm={() => void remove()} />
  </div>;
}
