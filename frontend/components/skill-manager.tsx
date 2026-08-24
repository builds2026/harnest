"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { apiErrorMessage, requestJson } from "@/lib/api-client";
import { useI18n } from "./i18n-provider";

type SkillSourceKind = "local" | "git" | "package";
type InstalledSkill = {
  id: string;
  label: string;
  scriptsPresent: boolean;
  requirements: { tools: string[]; connections: string[]; permissions: string[] };
};
type ScriptReview = { path: string; bytes: number; sha256: string; content: string; approved: boolean };

export function SkillManager({ open, onClose, onChanged }: {
  open: boolean;
  onClose: () => void;
  onChanged: () => void | Promise<void>;
}) {
  const { t } = useI18n();
  const [kind, setKind] = useState<SkillSourceKind>("local");
  const [scope, setScope] = useState<"project" | "user">("project");
  const [namespace, setNamespace] = useState<"harnest" | "agents">("harnest");
  const [directory, setDirectory] = useState("");
  const [repository, setRepository] = useState("");
  const [packageName, setPackageName] = useState("");
  const [version, setVersion] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [installed, setInstalled] = useState<InstalledSkill[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [reviewSkill, setReviewSkill] = useState<InstalledSkill>();
  const [scripts, setScripts] = useState<ScriptReview[]>([]);
  const first = useRef<HTMLInputElement>(null);

  const loadInstalled = async () => {
    const payload = await requestJson<{ skills: InstalledSkill[]; warnings: string[] }>("/api/skills", { cache: "no-store" });
    setInstalled(payload.skills);
    setWarnings(payload.warnings);
    return payload.skills;
  };

  const review = async (skill: InstalledSkill) => {
    setBusy(true);
    setMessage("");
    try {
      setScripts((await requestJson<{ scripts: ScriptReview[] }>(`/api/skills?review=${encodeURIComponent(skill.id)}`, { cache: "no-store" })).scripts);
      setReviewSkill(skill);
    } catch (error) {
      setMessage(apiErrorMessage(error, t("skills.reviewFailed"), t));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setMessage("");
    setReviewSkill(undefined);
    setScripts([]);
    void loadInstalled().catch((error: unknown) => setMessage(apiErrorMessage(error, t("skills.loadFailed"), t)));
    queueMicrotask(() => first.current?.focus());
  }, [open]);

  if (!open) return null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const source = kind === "local" ? { kind, directory }
        : kind === "git" ? { kind, repository }
          : { kind, package: packageName, ...(version ? { version } : {}) };
      const payload = await requestJson<{ skill: { label: string; scriptsPresent: boolean }; source: string }>("/api/skills", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source, scope, namespace, approved: kind !== "local" }),
      }, { timeoutMs: 120_000 });
      await onChanged();
      const skills = await loadInstalled();
      setMessage(`${t("skills.installed", { name: payload.skill.label, source: payload.source })}${payload.skill.scriptsPresent ? t("skills.installedReview") : ""}`);
      const installedSkill = skills.find((skill) => skill.id === payload.skill.label);
      if (installedSkill?.scriptsPresent) await review(installedSkill);
    } catch (error) {
      setMessage(apiErrorMessage(error, t("skills.installFailed"), t));
    } finally {
      setBusy(false);
    }
  };

  const approveScripts = async () => {
    if (!reviewSkill) return;
    const pending = scripts.filter((script) => !script.approved);
    if (!pending.length) return;
    setBusy(true);
    setMessage("");
    try {
      await requestJson<unknown>("/api/skills", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "approve-scripts",
          skill: reviewSkill.id,
          scripts: pending.map(({ path, sha256 }) => ({ path, sha256 })),
        }),
      }, { timeoutMs: 120_000 });
      setScripts((current) => current.map((script) => ({ ...script, approved: true })));
      setMessage(t("skills.approvedMessage", { name: reviewSkill.label }));
      await onChanged();
    } catch (error) {
      setMessage(apiErrorMessage(error, t("skills.approvalFailed"), t));
    } finally {
      setBusy(false);
    }
  };

  return <Dialog.Root open={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="sheet-backdrop" />
      <Dialog.Viewport className="connection-sheet-viewport">
    <Dialog.Popup className="connection-sheet skill-sheet">
      <header className="sheet-header"><div><span className="sheet-eyebrow">{t("skills.eyebrow")}</span><Dialog.Title id="skill-sheet-title">{t("skills.title")}</Dialog.Title></div><Dialog.Close className="sheet-close" aria-label={t("skills.close")} disabled={busy}>×</Dialog.Close></header>
      {message && <div className="sheet-message" role="status">{message}</div>}
      {warnings.length > 0 && <details className="source-review"><summary>{t("skills.warning", { count: warnings.length })}</summary><p>{t("skills.warningHelp")}</p><ul>{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></details>}
      {installed.some((skill) => skill.scriptsPresent) && !reviewSkill && <div className="source-review"><span>{t("skills.scriptsTrust")}</span><p>{t("skills.scriptsTrustHelp")}</p><div className="sheet-actions">{installed.filter((skill) => skill.scriptsPresent).map((skill) => <button key={skill.id} type="button" className="button" disabled={busy} onClick={() => void review(skill)}>{t("skills.review", { name: skill.label })}</button>)}</div></div>}
      {reviewSkill && <div className="approval-body source-review"><span>{t("skills.scriptReview", { name: reviewSkill.label })}</span><p>{t("skills.requirements", { value: [...reviewSkill.requirements.tools.map((value) => `tool:${value}`), ...reviewSkill.requirements.connections.map((value) => `connection:${value}`), ...reviewSkill.requirements.permissions.map((value) => `permission:${value}`)].join(", ") || t("common.none") })}</p>{scripts.map((script) => <details key={script.path} open={!script.approved}><summary>{script.approved ? t("skills.approved") : t("skills.reviewState")} · {script.path} · {script.bytes} bytes</summary><code>{script.sha256}</code><pre>{script.content}</pre></details>)}<div className="sheet-actions"><button type="button" className="button" disabled={busy} onClick={() => { setReviewSkill(undefined); setScripts([]); }}>{t("common.back")}</button><button type="button" className="button button-primary" disabled={busy || scripts.every((script) => script.approved)} onClick={() => void approveScripts()}>{busy ? t("skills.approving") : t("skills.approve")}</button></div></div>}
      <form className="connection-form" onSubmit={submit}>
        <h3>{t("skills.add")}</h3>
        <div className="field-grid">
          <div className="field"><label htmlFor="skill-source-kind">{t("skills.source")}</label><select id="skill-source-kind" value={kind} onChange={(event) => setKind(event.target.value as SkillSourceKind)}><option value="local">{t("skills.source.local")}</option><option value="git">{t("skills.source.git")}</option><option value="package">{t("skills.source.package")}</option></select></div>
          <div className="field"><label htmlFor="skill-scope">{t("skills.scope")}</label><select id="skill-scope" value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}><option value="project">{t("connections.form.scope.project")}</option><option value="user">{t("connections.form.scope.user")}</option></select></div>
          <div className="field"><label htmlFor="skill-namespace">{t("skills.namespace")}</label><select id="skill-namespace" value={namespace} onChange={(event) => setNamespace(event.target.value as typeof namespace)}><option value="harnest">{t("skills.namespace.harnest")}</option><option value="agents">{t("skills.namespace.agents")}</option></select></div>
          {kind === "local" && <div className="field"><label htmlFor="skill-directory">{t("skills.folder")}</label><input ref={first} id="skill-directory" required placeholder="C:\\path\\to\\skill-name" value={directory} onChange={(event) => setDirectory(event.target.value)} /><span className="field-help">{t("skills.folderHelp")}</span></div>}
          {kind === "git" && <div className="field"><label htmlFor="skill-repository">{t("skills.repository")}</label><input ref={first} id="skill-repository" type="url" required placeholder="https://github.com/owner/skill" value={repository} onChange={(event) => setRepository(event.target.value)} /><span className="field-help">{t("skills.repositoryHelp")}</span></div>}
          {kind === "package" && <><div className="field"><label htmlFor="skill-package">{t("skills.package")}</label><input ref={first} id="skill-package" required placeholder="@scope/skill" value={packageName} onChange={(event) => setPackageName(event.target.value)} /></div><div className="field"><label htmlFor="skill-version">{t("skills.version")} <span className="optional">{t("skills.optional")}</span></label><input id="skill-version" placeholder="latest" value={version} onChange={(event) => setVersion(event.target.value)} /><span className="field-help">{t("skills.versionHelp")}</span></div></>}
          {kind !== "local" && <div className="source-review"><span>{t("skills.safeInstall")}</span><p>{t("skills.safeInstallHelp")}</p></div>}
        </div>
        <div className="sheet-actions"><button type="button" className="button" disabled={busy} onClick={onClose}>{t("common.cancel")}</button><button className="button button-primary" disabled={busy}>{busy ? t("skills.installing") : t("skills.install")}</button></div>
      </form>
    </Dialog.Popup>
      </Dialog.Viewport>
    </Dialog.Portal>
  </Dialog.Root>;
}
