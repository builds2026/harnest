"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

type SkillSourceKind = "local" | "git" | "package";
type InstalledSkill = {
  id: string;
  label: string;
  scriptsPresent: boolean;
  requirements: { tools: string[]; connections: string[]; permissions: string[] };
};
type ScriptReview = { path: string; bytes: number; sha256: string; content: string; approved: boolean };

const requestMessage = async (response: Response) => {
  const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  return payload?.error?.message ?? `Request failed with ${response.status}`;
};

export function SkillManager({ open, onClose, onChanged }: {
  open: boolean;
  onClose: () => void;
  onChanged: () => void | Promise<void>;
}) {
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
  const [reviewSkill, setReviewSkill] = useState<InstalledSkill>();
  const [scripts, setScripts] = useState<ScriptReview[]>([]);
  const first = useRef<HTMLInputElement>(null);

  const loadInstalled = async () => {
    const response = await fetch("/api/skills", { cache: "no-store" });
    if (!response.ok) throw new Error(await requestMessage(response));
    const payload = await response.json() as { skills: InstalledSkill[] };
    setInstalled(payload.skills);
    return payload.skills;
  };

  const review = async (skill: InstalledSkill) => {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/skills?review=${encodeURIComponent(skill.id)}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await requestMessage(response));
      setScripts((await response.json() as { scripts: ScriptReview[] }).scripts);
      setReviewSkill(skill);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Skill scripts could not be reviewed.");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setMessage("");
    setReviewSkill(undefined);
    setScripts([]);
    void loadInstalled().catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Skills could not be loaded."));
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
      const response = await fetch("/api/skills", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source, scope, namespace, approved: kind !== "local" }),
      });
      if (!response.ok) throw new Error(await requestMessage(response));
      const payload = await response.json() as { skill: { label: string; scriptsPresent: boolean }; source: string };
      await onChanged();
      const skills = await loadInstalled();
      setMessage(`${payload.skill.label} installed from ${payload.source}.${payload.skill.scriptsPresent ? " Review its scripts before use." : ""}`);
      const installedSkill = skills.find((skill) => skill.id === payload.skill.label);
      if (installedSkill?.scriptsPresent) await review(installedSkill);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Skill installation failed.");
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
      const response = await fetch("/api/skills", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "approve-scripts",
          skill: reviewSkill.id,
          scripts: pending.map(({ path, sha256 }) => ({ path, sha256 })),
        }),
      });
      if (!response.ok) throw new Error(await requestMessage(response));
      setScripts((current) => current.map((script) => ({ ...script, approved: true })));
      setMessage(`${reviewSkill.label} scripts approved for these exact hashes.`);
      await onChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Skill scripts could not be approved.");
    } finally {
      setBusy(false);
    }
  };

  return <div className="sheet-backdrop">
    <section className="connection-sheet skill-sheet" role="dialog" aria-modal="true" aria-labelledby="skill-sheet-title">
      <header className="sheet-header"><div><span className="sheet-eyebrow">Progressive instruction catalog</span><h2 id="skill-sheet-title">Skills</h2></div><button className="sheet-close" aria-label="Close skills" disabled={busy} onClick={onClose}>×</button></header>
      {message && <div className="sheet-message" role="status">{message}</div>}
      {installed.some((skill) => skill.scriptsPresent) && !reviewSkill && <div className="source-review"><span>Scripts need explicit trust</span><p>Review code and its SHA-256 before allowing a model to load it.</p><div className="sheet-actions">{installed.filter((skill) => skill.scriptsPresent).map((skill) => <button key={skill.id} type="button" className="button" disabled={busy} onClick={() => void review(skill)}>Review {skill.label}</button>)}</div></div>}
      {reviewSkill && <div className="approval-body source-review"><span>{reviewSkill.label} · script review</span><p>Requirements: {[...reviewSkill.requirements.tools.map((value) => `tool:${value}`), ...reviewSkill.requirements.connections.map((value) => `connection:${value}`), ...reviewSkill.requirements.permissions.map((value) => `permission:${value}`)].join(", ") || "none"}</p>{scripts.map((script) => <details key={script.path} open={!script.approved}><summary>{script.approved ? "Approved" : "Review"} · {script.path} · {script.bytes} bytes</summary><code>{script.sha256}</code><pre>{script.content}</pre></details>)}<div className="sheet-actions"><button type="button" className="button" disabled={busy} onClick={() => { setReviewSkill(undefined); setScripts([]); }}>Back</button><button type="button" className="button button-primary" disabled={busy || scripts.every((script) => script.approved)} onClick={() => void approveScripts()}>{busy ? "Approving…" : "Approve exact hashes"}</button></div></div>}
      <form className="connection-form" onSubmit={submit}>
        <h3>Add a skill</h3>
        <div className="field-grid">
          <div className="field"><label htmlFor="skill-source-kind">Source</label><select id="skill-source-kind" value={kind} onChange={(event) => setKind(event.target.value as SkillSourceKind)}><option value="local">Local folder</option><option value="git">GitHub or GitLab</option><option value="package">npm package</option></select></div>
          <div className="field"><label htmlFor="skill-scope">Scope</label><select id="skill-scope" value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}><option value="project">This project</option><option value="user">All local projects</option></select></div>
          <div className="field"><label htmlFor="skill-namespace">Namespace</label><select id="skill-namespace" value={namespace} onChange={(event) => setNamespace(event.target.value as typeof namespace)}><option value="harnest">.harnest</option><option value="agents">.agents compatible</option></select></div>
          {kind === "local" && <div className="field"><label htmlFor="skill-directory">Folder containing SKILL.md</label><input ref={first} id="skill-directory" required placeholder="C:\\path\\to\\skill-name" value={directory} onChange={(event) => setDirectory(event.target.value)} /><span className="field-help">The server copies a bounded, non-symlinked tree into the selected local catalog.</span></div>}
          {kind === "git" && <div className="field"><label htmlFor="skill-repository">Repository URL</label><input ref={first} id="skill-repository" type="url" required placeholder="https://github.com/owner/skill" value={repository} onChange={(event) => setRepository(event.target.value)} /><span className="field-help">Install resolves and records the current exact commit automatically.</span></div>}
          {kind === "package" && <><div className="field"><label htmlFor="skill-package">Package</label><input ref={first} id="skill-package" required placeholder="@scope/skill" value={packageName} onChange={(event) => setPackageName(event.target.value)} /></div><div className="field"><label htmlFor="skill-version">Version <span className="optional">optional</span></label><input id="skill-version" placeholder="latest" value={version} onChange={(event) => setVersion(event.target.value)} /><span className="field-help">The exact version and registry sha512 are verified before extraction.</span></div></>}
          {kind !== "local" && <div className="source-review"><span>Safe install</span><p>Clicking Install approves the resolved immutable source. Links, path traversal, oversized archives, and integrity mismatches are rejected.</p></div>}
        </div>
        <div className="sheet-actions"><button type="button" className="button" disabled={busy} onClick={onClose}>Cancel</button><button className="button button-primary" disabled={busy}>{busy ? "Installing…" : "Install skill"}</button></div>
      </form>
    </section>
  </div>;
}
