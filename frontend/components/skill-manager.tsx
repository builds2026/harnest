"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

type SkillSourceKind = "local" | "git" | "package";

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
  const [commit, setCommit] = useState("");
  const [packageName, setPackageName] = useState("");
  const [version, setVersion] = useState("");
  const [integrity, setIntegrity] = useState("");
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setMessage("");
    setApproved(false);
    queueMicrotask(() => first.current?.focus());
  }, [open]);

  const review = useMemo(() => kind === "git"
    ? `git:${repository || "<repository>"}#${commit || "<exact 40/64-char commit>"}`
    : kind === "package"
      ? `package:${packageName || "<package>"}@${version || "<exact version>"}:${integrity || "<sha512 integrity>"}`
      : `local:${directory || "<folder>"}`, [commit, directory, integrity, kind, packageName, repository, version]);

  if (!open) return null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const source = kind === "local" ? { kind, directory }
        : kind === "git" ? { kind, repository, commit }
          : { kind, package: packageName, version, integrity };
      const response = await fetch("/api/skills", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source, scope, namespace, approved }),
      });
      if (!response.ok) throw new Error(await requestMessage(response));
      const payload = await response.json() as { skill: { label: string; scriptsPresent: boolean } };
      await onChanged();
      setMessage(`${payload.skill.label} installed.${payload.skill.scriptsPresent ? " Scripts remain approval-gated." : ""}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Skill installation failed.");
    } finally {
      setBusy(false);
    }
  };

  return <div className="sheet-backdrop">
    <section className="connection-sheet skill-sheet" role="dialog" aria-modal="true" aria-labelledby="skill-sheet-title">
      <header className="sheet-header"><div><span className="sheet-eyebrow">Progressive instruction catalog</span><h2 id="skill-sheet-title">Add skill</h2></div><button className="sheet-close" aria-label="Close add skill" disabled={busy} onClick={onClose}>×</button></header>
      {message && <div className="sheet-message" role="status">{message}</div>}
      <form className="connection-form" onSubmit={submit}>
        <div className="field-grid">
          <div className="field"><label htmlFor="skill-source-kind">Source</label><select id="skill-source-kind" value={kind} onChange={(event) => { setKind(event.target.value as SkillSourceKind); setApproved(false); }}><option value="local">Local folder</option><option value="git">Git · exact commit</option><option value="package">Package · exact version + integrity</option></select></div>
          <div className="field"><label htmlFor="skill-scope">Scope</label><select id="skill-scope" value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}><option value="project">This project</option><option value="user">All local projects</option></select></div>
          <div className="field"><label htmlFor="skill-namespace">Namespace</label><select id="skill-namespace" value={namespace} onChange={(event) => setNamespace(event.target.value as typeof namespace)}><option value="harnest">.harnest</option><option value="agents">.agents compatible</option></select></div>
          {kind === "local" && <div className="field"><label htmlFor="skill-directory">Folder containing SKILL.md</label><input ref={first} id="skill-directory" required placeholder="C:\\path\\to\\skill-name" value={directory} onChange={(event) => setDirectory(event.target.value)} /><span className="field-help">The server copies a bounded, non-symlinked tree into the selected local catalog.</span></div>}
          {kind === "git" && <><div className="field"><label htmlFor="skill-repository">HTTPS repository</label><input ref={first} id="skill-repository" type="url" required value={repository} onChange={(event) => setRepository(event.target.value)} /></div><div className="field"><label htmlFor="skill-commit">Exact commit object ID</label><input id="skill-commit" required pattern="[A-Fa-f0-9]{40}|[A-Fa-f0-9]{64}" value={commit} onChange={(event) => setCommit(event.target.value)} /></div></>}
          {kind === "package" && <><div className="field"><label htmlFor="skill-package">Package</label><input ref={first} id="skill-package" required value={packageName} onChange={(event) => setPackageName(event.target.value)} /></div><div className="field"><label htmlFor="skill-version">Exact version</label><input id="skill-version" required placeholder="1.2.3" value={version} onChange={(event) => setVersion(event.target.value)} /></div><div className="field"><label htmlFor="skill-integrity">Registry integrity</label><textarea id="skill-integrity" required placeholder="sha512-…" value={integrity} onChange={(event) => setIntegrity(event.target.value)} /></div></>}
          <div className="source-review"><span>Source lock</span><code>{review}</code><p>Catalog responses expose frontmatter, requirements, provenance, and trust state only—never Skill instructions or resources.</p></div>
          {kind !== "local" && <div className="field field-checkbox"><input id="skill-approval" type="checkbox" required checked={approved} onChange={(event) => setApproved(event.target.checked)} /><label htmlFor="skill-approval">I approve this exact pinned source</label><span className="field-help">Remote materialization is fail-closed unless the Studio host configures a pinned-source provider.</span></div>}
        </div>
        <div className="sheet-actions"><button type="button" className="button" disabled={busy} onClick={onClose}>Cancel</button><button className="button button-primary" disabled={busy}>{busy ? "Installing…" : "Install skill"}</button></div>
      </form>
    </section>
  </div>;
}
