"use client";

import { Dialog } from "@base-ui/react/dialog";
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent, type InputHTMLAttributes } from "react";
import { apiErrorMessage, requestJson } from "@/lib/api-client";
import { useI18n } from "./i18n-provider";
import { Badge, Button, ConfirmDialog, Field, InlineNotice, Input, SelectControl, Skeleton } from "./ui/ui";
import styles from "./project-files.module.css";

interface ProjectFileSummary {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly previewable: boolean;
  readonly editable: boolean;
}

interface ProjectFile extends ProjectFileSummary {
  readonly content: string;
}

interface ImportSelection {
  readonly name: string;
  readonly entries: readonly { file: File; path: string }[];
  readonly total: number;
  readonly excluded: number;
  readonly valid: boolean;
}

type Operation = "load" | "open" | "save" | "create" | "delete" | "import";
type Feedback = { tone: "success" | "warning" | "danger"; text: string; retry?: () => void };

const SOURCE_KINDS = {
  prompts: { extension: ".md", initial: "{{input}}\n" },
  context: { extension: ".md", initial: "" },
  schemas: { extension: ".json", initial: "{}\n" },
  tests: { extension: ".json", initial: "[]\n" },
  config: { extension: ".json", initial: "{}\n" },
} as const;

const MAX_IMPORT_FILES = 2_000;
const MAX_IMPORT_BYTES = 64 * 1_048_576;
const MAX_IMPORT_FILE_BYTES = 16 * 1_048_576;
const EXCLUDED_DIRECTORIES = new Set([".git", "node_modules", ".next", "dist", "build", "coverage"]);
const IMPORT_NOTICE = "harnest.project.imported";

const importSelection = (selectedFiles: readonly File[]): ImportSelection => {
  const name = selectedFiles[0]?.webkitRelativePath.split("/")[0] || "Project";
  const entries = selectedFiles.flatMap((file) => {
    const relative = file.webkitRelativePath || file.name;
    const segments = relative.split("/");
    const path = (segments.length > 1 ? segments.slice(1) : segments).join("/");
    if (!path || segments.some((segment) => EXCLUDED_DIRECTORIES.has(segment))) return [];
    if (/(?:^|\/)\.env(?:\..+)?$/iu.test(path) && !path.endsWith(".env.example")) return [];
    if (file.size <= 0 || file.size > MAX_IMPORT_FILE_BYTES) return [];
    return [{ file, path }];
  });
  const total = entries.reduce((sum, { file }) => sum + file.size, 0);
  return {
    name,
    entries,
    total,
    excluded: selectedFiles.length - entries.length,
    valid: entries.length > 0 && entries.length <= MAX_IMPORT_FILES && total <= MAX_IMPORT_BYTES,
  };
};

export function ProjectFiles({ locked, onChanged }: { locked: boolean; onChanged: () => void | Promise<void> }) {
  const { t, formatNumber } = useI18n();
  const [root, setRoot] = useState("");
  const [harness, setHarness] = useState("");
  const [managed, setManaged] = useState(false);
  const [files, setFiles] = useState<readonly ProjectFileSummary[]>([]);
  const [selected, setSelected] = useState<ProjectFile>();
  const [content, setContent] = useState("");
  const [operation, setOperation] = useState<Operation>();
  const [feedback, setFeedback] = useState<Feedback>();
  const [dialogError, setDialogError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [createKind, setCreateKind] = useState<keyof typeof SOURCE_KINDS>("prompts");
  const [createName, setCreateName] = useState("");
  const [pendingImport, setPendingImport] = useState<ImportSelection>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const folderInput = useRef<HTMLInputElement>(null);
  const dirty = selected !== undefined && content !== selected.content;
  const busy = operation !== undefined;
  const directoryInput = { webkitdirectory: "", directory: "" } as InputHTMLAttributes<HTMLInputElement>;

  const refresh = useCallback(async () => {
    const payload = await requestJson<{
      project: { root: string; harness?: string; managed?: boolean } | null;
      files: ProjectFileSummary[];
    }>("/api/project", { cache: "no-store" });
    setRoot(payload.project?.root ?? "");
    setHarness(payload.project?.harness ?? "");
    setManaged(payload.project?.managed === true);
    setFiles(payload.files);
  }, []);

  const load = useCallback(async () => {
    setOperation("load");
    try {
      await refresh();
    } catch (cause) {
      setFeedback({ tone: "danger", text: apiErrorMessage(cause, t("project.loadFailed"), t), retry: () => void load() });
    } finally {
      setOperation(undefined);
    }
  }, [refresh, t]);

  useEffect(() => {
    try {
      const imported = sessionStorage.getItem(IMPORT_NOTICE);
      if (imported) {
        const value = JSON.parse(imported) as { name?: unknown; fileCount?: unknown; excludedCount?: unknown };
        if (typeof value.name === "string" && typeof value.fileCount === "number" && typeof value.excludedCount === "number") {
          setFeedback({ tone: "success", text: t("project.imported", { name: value.name, count: value.fileCount, excluded: value.excludedCount }) });
        }
        sessionStorage.removeItem(IMPORT_NOTICE);
      }
    } catch {
      sessionStorage.removeItem(IMPORT_NOTICE);
    }
    void load();
  }, [load, t]);

  const open = async (file: ProjectFileSummary) => {
    if (!file.previewable || dirty || busy) return;
    setOperation("open");
    setFeedback(undefined);
    try {
      const payload = await requestJson<{ file: ProjectFile }>(`/api/project?path=${encodeURIComponent(file.path)}`, { cache: "no-store" });
      setSelected(payload.file);
      setContent(payload.file.content);
    } catch (cause) {
      setFeedback({ tone: "danger", text: apiErrorMessage(cause, t("project.openFailed"), t), retry: () => void open(file) });
    } finally {
      setOperation(undefined);
    }
  };

  const save = async () => {
    if (!selected?.editable || !dirty || busy) return;
    setOperation("save");
    setFeedback(undefined);
    try {
      const payload = await requestJson<{ file: ProjectFile }>("/api/project", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: selected.path, content, sha256: selected.sha256 }),
      });
      setSelected(payload.file);
      setContent(payload.file.content);
      await refresh();
      await onChanged();
      setFeedback({ tone: "success", text: t("project.saved") });
    } catch (cause) {
      setFeedback({ tone: "danger", text: apiErrorMessage(cause, t("project.saveFailed"), t), retry: () => void save() });
    } finally {
      setOperation(undefined);
    }
  };

  const create = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy) return;
    const name = createName.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(name)) {
      setDialogError(t("project.nameInvalid"));
      return;
    }
    const source = SOURCE_KINDS[createKind];
    const filename = name.toLocaleLowerCase().endsWith(source.extension) ? name : `${name}${source.extension}`;
    setOperation("create");
    setDialogError("");
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
      await refresh();
      setFeedback({ tone: "success", text: t("project.created", { path: payload.file.path }) });
    } catch (cause) {
      setDialogError(apiErrorMessage(cause, t("project.createFailed"), t));
    } finally {
      setOperation(undefined);
    }
  };

  const remove = async () => {
    if (!selected?.editable || busy) return;
    const target = selected;
    setOperation("delete");
    setFeedback(undefined);
    try {
      await requestJson("/api/project", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: target.path, sha256: target.sha256 }),
      });
      setSelected(undefined);
      setContent("");
      await refresh();
      await onChanged();
      setFeedback({ tone: "success", text: t("project.deleted", { path: target.path }) });
    } catch (cause) {
      setFeedback({ tone: "danger", text: apiErrorMessage(cause, t("project.deleteFailed"), t), retry: () => void remove() });
    } finally {
      setOperation(undefined);
    }
  };

  const chooseFolder = (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = [...(event.target.files ?? [])];
    event.target.value = "";
    if (!selectedFiles.length) return;
    setDialogError("");
    setPendingImport(importSelection(selectedFiles));
  };

  const importFolder = async () => {
    if (!pendingImport?.valid || busy) return;
    setOperation("import");
    setDialogError("");
    try {
      const form = new FormData();
      form.set("name", pendingImport.name);
      form.set("paths", JSON.stringify(pendingImport.entries.map(({ path }) => path)));
      for (const { file } of pendingImport.entries) form.append("file", file, file.name);
      const payload = await requestJson<{ project: { name: string; fileCount: number; excludedCount: number; bytes: number } }>(
        "/api/project/import",
        { method: "POST", body: form },
        { timeoutMs: 120_000 },
      );
      sessionStorage.setItem(IMPORT_NOTICE, JSON.stringify({
        ...payload.project,
        excludedCount: payload.project.excludedCount + pendingImport.excluded,
      }));
      globalThis.location.assign("/builder");
    } catch (cause) {
      setDialogError(apiErrorMessage(cause, t("project.importFailed"), t));
      setOperation(undefined);
    }
  };

  const folderPicker = <input {...directoryInput} ref={folderInput} className={styles.hiddenInput} type="file" multiple disabled={busy || locked || dirty} onChange={chooseFolder} />;
  const importDialog = <Dialog.Root open={Boolean(pendingImport)} onOpenChange={(next) => { if (!next && operation !== "import") setPendingImport(undefined); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className={styles.dialogBackdrop} />
      <Dialog.Viewport className={styles.dialogViewport}>
        <Dialog.Popup className={styles.dialog}>
          <Dialog.Title>{t("project.importTitle")}</Dialog.Title>
          <Dialog.Description>{t("project.importDescription")}</Dialog.Description>
          {pendingImport && <div className={styles.importSummary}>
            <strong>{pendingImport.name}</strong>
            <span>{t("project.importSummary", { count: pendingImport.entries.length, size: formatNumber(pendingImport.total), excluded: pendingImport.excluded })}</span>
            <small>{t("project.importRequirements")}</small>
          </div>}
          {pendingImport && !pendingImport.valid && <InlineNotice tone="danger">{t("project.importLimit")}</InlineNotice>}
          {dialogError && <InlineNotice tone="danger">{dialogError}</InlineNotice>}
          <div className={styles.dialogActions}><Dialog.Close disabled={operation === "import"} className={styles.dialogButton}>{t("common.cancel")}</Dialog.Close><Button variant="primary" loading={operation === "import"} disabled={!pendingImport?.valid} onClick={() => void importFolder()}>{t("project.importAction")}</Button></div>
        </Dialog.Popup>
      </Dialog.Viewport>
    </Dialog.Portal>
  </Dialog.Root>;

  if (!root && operation === "load") return <div className={styles.loading}><Skeleton lines={5} label={t("common.loading")} /></div>;

  if (!root && !busy && files.length === 0) return <>
    <div className={styles.empty}>
      <strong>{t("project.legacyTitle")}</strong>
      <span>{t("project.legacyDescription")}</span>
      {locked && <InlineNotice tone="warning">{t("project.lockedHelp")}</InlineNotice>}
      {feedback?.tone === "danger" && <InlineNotice tone="danger" action={feedback.retry ? <Button size="small" onClick={feedback.retry}>{t("common.retry")}</Button> : undefined}>{feedback.text}</InlineNotice>}
      <Button variant="primary" disabled={locked} onClick={() => folderInput.current?.click()}>{t("project.openFolder")}</Button>
      <small>{t("project.openFolderHelp")}</small>
      {folderPicker}
    </div>
    {importDialog}
  </>;

  const guard = locked ? t("project.lockedHelp") : dirty ? t("project.dirtyHelp") : undefined;
  return <>
    <div className={styles.root}>
      <aside className={styles.sidebar} aria-label={t("project.files")}>
        <div className={styles.projectHeader}>
          <span className={styles.eyebrow}>{t("project.current")}</span>
          <div className={styles.projectIdentity}><strong title={root}>{root || t("common.loading")}</strong><Badge tone={managed ? "info" : "neutral"}>{managed ? t("project.managedCopy") : t("project.cliProject")}</Badge></div>
          <code className={styles.harness}>{harness}</code>
          <p>{managed ? t("project.managedCopyHelp") : t("project.cliProjectHelp")}</p>
          <div className={styles.headerActions}><Button size="small" disabled={busy || locked || dirty} onClick={() => { setDialogError(""); setCreateOpen(true); }}>{t("project.newSource")}</Button><Button size="small" disabled={busy || locked || dirty} onClick={() => folderInput.current?.click()}>{t("project.openFolder")}</Button></div>
          {folderPicker}
        </div>
        {guard && <InlineNotice tone="warning">{guard}</InlineNotice>}
        {feedback && <InlineNotice tone={feedback.tone} action={feedback.retry ? <Button size="small" onClick={feedback.retry}>{t("common.retry")}</Button> : undefined}>{feedback.text}</InlineNotice>}
        <div className={styles.fileList} aria-busy={busy || undefined}>
          {files.map((file) => <button
            type="button"
            key={file.path}
            className={styles.file}
            data-active={selected?.path === file.path}
            disabled={busy || !file.previewable || dirty}
            title={!file.previewable ? t("project.binary") : file.editable ? file.path : t("project.readOnlyHelp")}
            onClick={() => void open(file)}
          ><span>{file.path.replace(/^\.harnest\//, "")}</span><small>{formatNumber(file.size)} B · {file.editable ? t("project.textFile") : t("project.readOnly")}</small></button>)}
          {!files.length && <p className={styles.noFiles}>{t("project.noSources")}</p>}
        </div>
      </aside>
      <section className={styles.editor}>
        {selected ? <>
          <header className={styles.heading}><code>{selected.path}</code><span>{dirty && <Badge tone="warning">{t("save.unsaved")}</Badge>}{!selected.editable && <Badge tone="neutral">{t("project.readOnly")}</Badge>}{locked && <Badge tone="warning">{t("project.locked")}</Badge>}</span></header>
          <textarea className={styles.textarea} value={content} readOnly={busy || locked || !selected.editable} spellCheck={false} aria-label={selected.path} aria-describedby={!selected.editable ? "project-read-only-help" : undefined} onChange={(event) => setContent(event.target.value)} />
          <footer className={styles.actions}>
            <span>{operation && <strong role="status">{t(`project.progress.${operation}`)}</strong>}{!selected.editable && <span id="project-read-only-help">{t("project.readOnlyHelp")}</span>}</span>
            <span><Button variant="danger" disabled={busy || dirty || locked || !selected.editable} onClick={() => setConfirmDelete(true)}>{t("project.deleteAction")}</Button><Button disabled={busy || !dirty || locked || !selected.editable} onClick={() => setContent(selected.content)}>{t("common.discard")}</Button><Button variant="primary" loading={operation === "save"} disabled={!dirty || locked || !selected.editable} onClick={() => void save()}>{t("common.save")}</Button></span>
          </footer>
        </> : <div className={styles.empty}><strong>{t("project.selectTitle")}</strong><span>{t("project.selectDescription")}</span></div>}
      </section>
    </div>
    <Dialog.Root open={createOpen} onOpenChange={(next) => { if (!next && operation !== "create") setCreateOpen(false); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className={styles.dialogBackdrop} />
        <Dialog.Viewport className={styles.dialogViewport}>
          <Dialog.Popup className={styles.dialog}>
            <Dialog.Title>{t("project.createTitle")}</Dialog.Title>
            <Dialog.Description>{t("project.createDescription")}</Dialog.Description>
            <form className={styles.createForm} onSubmit={(event) => void create(event)}>
              <div className={styles.formField}><span>{t("project.sourceKind")}</span><SelectControl className={styles.select} label={t("project.sourceKind")} value={createKind} options={(Object.keys(SOURCE_KINDS) as Array<keyof typeof SOURCE_KINDS>).map((kind) => ({ value: kind, label: `${t(`project.kind.${kind}`)} · ${SOURCE_KINDS[kind].extension}` }))} onValueChange={(value) => setCreateKind(value as keyof typeof SOURCE_KINDS)} /><small>{t("project.sourceKindsHelp")}</small></div>
              <Field label={t("project.sourceName")} htmlFor="project-source-name" error={dialogError || undefined}><Input autoFocus id="project-source-name" value={createName} placeholder={t("project.sourceNamePlaceholder")} onChange={(event) => setCreateName(event.target.value)} /></Field>
              <div className={styles.dialogActions}><Dialog.Close disabled={operation === "create"} className={styles.dialogButton}>{t("common.cancel")}</Dialog.Close><Button variant="primary" loading={operation === "create"} disabled={!createName.trim()}>{t("common.create")}</Button></div>
            </form>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
    {importDialog}
    <ConfirmDialog open={confirmDelete} title={t("project.deleteTitle")} description={t("project.deleteDescription", { path: selected?.path ?? "" })} confirmLabel={t("project.deleteAction")} cancelLabel={t("common.cancel")} danger confirmDisabled={busy} onOpenChange={setConfirmDelete} onConfirm={() => void remove()} />
  </>;
}
