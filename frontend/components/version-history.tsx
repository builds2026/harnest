"use client";

import { Dialog } from "@base-ui/react/dialog";
import type { HarnessSpec } from "@harnestai/core";
import { useEffect, useRef, useState } from "react";
import { apiErrorMessage, requestJson } from "@/lib/api-client";
import { useI18n } from "./i18n-provider";
import { Button, ConfirmDialog, EmptyState } from "./ui/ui";
import styles from "./version-history.module.css";

interface VersionEntry {
  readonly id: string;
  readonly createdAt: string;
  readonly summary: string;
  readonly bytes: number;
}

interface VersionDiff {
  readonly components: { readonly added: readonly string[]; readonly removed: readonly string[]; readonly changed: readonly string[] };
  readonly connections: { readonly added: readonly string[]; readonly removed: readonly string[]; readonly changed: readonly string[] };
  readonly runtimeChanged: boolean;
  readonly testsChanged: boolean;
}

const changes = (diff?: VersionDiff) => diff ? [
  ...diff.components.added.map((value) => `+ ${value}`),
  ...diff.components.removed.map((value) => `− ${value}`),
  ...diff.components.changed.map((value) => `~ ${value}`),
  ...diff.connections.added.map((value) => `+ ${value}`),
  ...diff.connections.removed.map((value) => `− ${value}`),
  ...diff.connections.changed.map((value) => `~ ${value}`),
] : [];

export function VersionHistory({
  currentYaml,
  onRestored,
}: {
  currentYaml: string;
  onRestored: (spec: HarnessSpec, yaml: string) => void;
}) {
  const { t, formatDate } = useI18n();
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<readonly VersionEntry[]>([]);
  const [selected, setSelected] = useState("");
  const [yaml, setYaml] = useState("");
  const [diff, setDiff] = useState<VersionDiff>();
  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState("");
  const loadSequence = useRef(0);

  useEffect(() => {
    if (!open) return;
    const sequence = ++loadSequence.current;
    setLoading(true);
    void requestJson<{ versions: VersionEntry[] }>("/api/versions")
      .then((payload) => {
        if (sequence !== loadSequence.current) return;
        setVersions(payload.versions);
        setSelected((current) => payload.versions.some(({ id }) => id === current) ? current : payload.versions[0]?.id ?? "");
        setError("");
      })
      .catch((reason: unknown) => {
        if (sequence === loadSequence.current) setError(apiErrorMessage(reason, t("versions.loadFailed"), t));
      })
      .finally(() => { if (sequence === loadSequence.current) setLoading(false); });
  }, [open, t]);

  useEffect(() => {
    if (!open || !selected) { setYaml(""); setDiff(undefined); return; }
    const sequence = ++loadSequence.current;
    setLoading(true);
    void Promise.all([
      requestJson<{ version: { yaml: string } }>(`/api/versions?id=${encodeURIComponent(selected)}`),
      requestJson<{ diff: VersionDiff }>(`/api/versions?from=${encodeURIComponent(selected)}&to=current`),
    ]).then(([preview, comparison]) => {
      if (sequence !== loadSequence.current) return;
      setYaml(preview.version.yaml);
      setDiff(comparison.diff);
      setError("");
    }).catch((reason: unknown) => {
      if (sequence === loadSequence.current) setError(apiErrorMessage(reason, t("versions.previewFailed"), t));
    }).finally(() => { if (sequence === loadSequence.current) setLoading(false); });
  }, [open, selected, t]);

  const restore = async () => {
    if (!selected || restoring) return;
    setRestoring(true);
    try {
      const payload = await requestJson<{ spec: HarnessSpec; yaml: string; versions: VersionEntry[] }>("/api/versions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: selected, currentYaml }),
      });
      setVersions(payload.versions);
      onRestored(payload.spec, payload.yaml);
      setOpen(false);
      setError("");
    } catch (reason) {
      setError(apiErrorMessage(reason, t("versions.restoreFailed"), t));
    } finally {
      setRestoring(false);
    }
  };

  const selectedEntry = versions.find(({ id }) => id === selected);
  const changeList = changes(diff);
  return <>
    <Button size="small" onClick={() => setOpen(true)}>{t("versions.open")}</Button>
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Backdrop className={styles.backdrop} />
        <Dialog.Viewport className={styles.viewport}>
          <Dialog.Popup className={styles.dialog}>
            <header className={styles.header}><div><Dialog.Title>{t("versions.title")}</Dialog.Title><Dialog.Description>{t("versions.description")}</Dialog.Description></div><Dialog.Close aria-label={t("common.close")}>×</Dialog.Close></header>
            {error && <div className={styles.error} role="status">{error}</div>}
            <div className={styles.body}>
              <aside className={styles.list}>{versions.length ? versions.map((version) => <button key={version.id} className={selected === version.id ? styles.selected : ""} onClick={() => setSelected(version.id)}><strong>{version.summary}</strong><span>{formatDate(version.createdAt, { dateStyle: "medium", timeStyle: "short" })}</span><small>{version.id}</small></button>) : !loading && <EmptyState compact title={t("versions.empty")} description={t("versions.emptyDescription")} />}</aside>
              <section className={styles.preview}>
                {selectedEntry ? <><div className={styles.previewHeader}><div><strong>{selectedEntry.summary}</strong><small>{t("versions.preview")}</small></div><Button variant="primary" loading={restoring} onClick={() => setConfirm(true)}>{t("versions.restore")}</Button></div><div className={styles.compare}><strong>{t("versions.compareCurrent")}</strong>{changeList.length ? <ul>{changeList.map((change, index) => <li key={`${change}:${index}`}>{change}</li>)}</ul> : <p>{diff?.runtimeChanged || diff?.testsChanged ? t("versions.settingsChanged") : t("versions.noChanges")}</p>}{diff?.runtimeChanged && <span>{t("versions.runtimeChanged")}</span>}{diff?.testsChanged && <span>{t("versions.testsChanged")}</span>}</div><pre>{loading ? t("common.loading") : yaml}</pre></> : <EmptyState compact title={t("versions.select")} description={t("versions.selectDescription")} />}
              </section>
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
    {confirm && <ConfirmDialog open title={t("versions.restoreConfirm.title")} description={t("versions.restoreConfirm.description")} confirmLabel={t("versions.restore")} cancelLabel={t("common.cancel")} danger onConfirm={() => void restore()} onOpenChange={setConfirm} />}
  </>;
}
