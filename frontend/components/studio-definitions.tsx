"use client";

import { Dialog } from "@base-ui/react/dialog";
import type { AgentTemplateSpec, TeamLimits, TeamSpec } from "@harnestai/core/browser";
import { useMemo, useState, type FormEvent } from "react";
import {
  deleteAgentTemplate,
  deleteTeam,
  upsertAgentTemplate,
  upsertTeam,
  type HarnessDraft,
} from "@/lib/studio-state";
import { useI18n } from "./i18n-provider";
import { Button, ConfirmDialog } from "./ui/ui";
import styles from "./studio-definitions.module.css";

type TemplateForm = { previousId?: string; id: string; description: string; capabilities: string; runner: "subgraph" | "a2a"; reference: string };
type LimitKey = keyof TeamLimits;
type TeamForm = { previousId?: string; id: string; orchestrator: string; members: string[]; limits: Record<LimitKey, string> };
type DeleteTarget = { kind: "template" | "team"; id: string; references: number };

const limitKeys: readonly LimitKey[] = ["maxInstances", "maxDepth", "maxParallel", "maxMessages", "maxPlanRevisions"];
const values = <Value,>(value: unknown) => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, Value> : {};

const errorKey = (error: unknown) => {
  const code = error instanceof Error ? error.message : "";
  if (code.endsWith("COLLISION")) return "definitions.error.collision" as const;
  if (code.includes("SUBGRAPH_MISSING")) return "definitions.error.subgraph" as const;
  if (code.includes("REFERENCE")) return "definitions.error.reference" as const;
  if (code.includes("LIMIT")) return "definitions.error.limit" as const;
  return "definitions.error.invalid" as const;
};

export function StudioDefinitions({ draft, locked, onChange }: {
  draft: HarnessDraft;
  locked: boolean;
  onChange: (draft: HarnessDraft) => void;
}) {
  const { t } = useI18n();
  const templates = values<AgentTemplateSpec>(draft.root.agentTemplates);
  const teams = values<TeamSpec>(draft.root.teams);
  const templateIds = Object.keys(templates);
  const subgraphs = Object.keys(draft.subgraphs);
  const [templateForm, setTemplateForm] = useState<TemplateForm>();
  const [teamForm, setTeamForm] = useState<TeamForm>();
  const [formError, setFormError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>();
  const referencedTeams = useMemo(() => Object.values(teams).reduce((counts, team) => {
    counts[team.orchestrator] = (counts[team.orchestrator] ?? 0) + 1;
    for (const member of team.members) counts[member] = (counts[member] ?? 0) + 1;
    return counts;
  }, {} as Record<string, number>), [teams]);
  const teamReferences = (id: string) => [draft.nodes, ...Object.values(draft.subgraphs).map(({ nodes }) => nodes)].flat()
    .filter((node) => node.data.component.type === "team" && (node.data.component.config as Record<string, unknown>).team === id).length;

  const editTemplate = (id?: string) => {
    const template = id ? templates[id] : undefined;
    const runner = template?.runner && "a2a" in template.runner ? "a2a" : "subgraph";
    setFormError("");
    setTemplateForm({
      ...(id ? { previousId: id } : {}),
      id: id ?? "",
      description: template?.description ?? "",
      capabilities: template?.capabilities?.join(", ") ?? "",
      runner,
      reference: template?.runner ? runner === "a2a" ? (template.runner as { a2a: { connection: string } }).a2a.connection : (template.runner as { subgraph: string }).subgraph : subgraphs[0] ?? "",
    });
  };
  const editTeam = (id?: string) => {
    const team = id ? teams[id] : undefined;
    setFormError("");
    setTeamForm({
      ...(id ? { previousId: id } : {}),
      id: id ?? "",
      orchestrator: team?.orchestrator ?? templateIds[0] ?? "",
      members: team?.members ? [...team.members] : templateIds.slice(0, 1),
      limits: Object.fromEntries(limitKeys.map((key) => [key, team?.limits?.[key]?.toString() ?? ""])) as Record<LimitKey, string>,
    });
  };
  const saveTemplate = (event: FormEvent) => {
    event.preventDefault();
    if (!templateForm) return;
    try {
      const capabilities = [...new Set(templateForm.capabilities.split(",").map((item) => item.trim()).filter(Boolean))];
      onChange(upsertAgentTemplate(draft, templateForm.previousId, templateForm.id.trim(), {
        description: templateForm.description,
        ...(capabilities.length ? { capabilities } : {}),
        runner: templateForm.runner === "subgraph"
          ? { subgraph: templateForm.reference }
          : { a2a: { connection: templateForm.reference.trim() } },
      }));
      setTemplateForm(undefined);
    } catch (error) {
      setFormError(t(errorKey(error)));
    }
  };
  const saveTeam = (event: FormEvent) => {
    event.preventDefault();
    if (!teamForm) return;
    try {
      const limits = Object.fromEntries(limitKeys.flatMap((key) => teamForm.limits[key] ? [[key, Number(teamForm.limits[key])]] : [])) as TeamLimits;
      onChange(upsertTeam(draft, teamForm.previousId, teamForm.id.trim(), {
        orchestrator: teamForm.orchestrator,
        members: teamForm.members,
        ...(Object.keys(limits).length ? { limits } : {}),
      }));
      setTeamForm(undefined);
    } catch (error) {
      setFormError(t(errorKey(error)));
    }
  };

  if (draft.root.version !== "0.3") return <div className="empty-dock">{t("definitions.requiresV03")}</div>;
  return <div className={styles.workspace}>
    <section className={styles.section} aria-labelledby="agent-templates-heading">
      <header><div><strong id="agent-templates-heading">{t("definitions.templates")}</strong><span>{t("definitions.templates.description")}</span></div><Button size="small" disabled={locked} onClick={() => editTemplate()}>{t("definitions.template.add")}</Button></header>
      <div className={styles.list}>{templateIds.length ? templateIds.map((id) => {
        const template = templates[id];
        const runner = "subgraph" in template.runner ? template.runner.subgraph : template.runner.a2a.connection;
        return <details key={id} className={styles.card}><summary><span><strong>{id}</strong><small>{template.description}</small></span><span>{runner}</span></summary><dl><div><dt>{t("definitions.runner")}</dt><dd>{"subgraph" in template.runner ? t("definitions.runner.subgraph") : t("definitions.runner.a2a")} · {runner}</dd></div><div><dt>{t("definitions.capabilities")}</dt><dd>{template.capabilities?.join(", ") || t("common.none")}</dd></div></dl><footer><Button size="small" disabled={locked} onClick={() => editTemplate(id)}>{t("common.edit")}</Button><Button size="small" variant="danger" disabled={locked} onClick={() => setDeleteTarget({ kind: "template", id, references: referencedTeams[id] ?? 0 })}>{t("common.delete")}</Button></footer></details>;
      }) : <div className={styles.empty}><strong>{t("definitions.templates.empty")}</strong><span>{t("definitions.templates.emptyDescription")}</span></div>}</div>
    </section>
    <section className={styles.section} aria-labelledby="teams-heading">
      <header><div><strong id="teams-heading">{t("definitions.teams")}</strong><span>{t("definitions.teams.description")}</span></div><Button size="small" disabled={locked || !templateIds.length} onClick={() => editTeam()}>{t("definitions.team.add")}</Button></header>
      <div className={styles.list}>{Object.keys(teams).length ? Object.entries(teams).map(([id, team]) => <details key={id} className={styles.card}><summary><span><strong>{id}</strong><small>{team.members.join(", ")}</small></span><span>{team.orchestrator}</span></summary><dl><div><dt>{t("definitions.orchestrator")}</dt><dd>{team.orchestrator}</dd></div><div><dt>{t("definitions.members")}</dt><dd>{team.members.join(", ")}</dd></div>{Object.entries(team.limits ?? {}).map(([key, value]) => <div key={key}><dt>{t(`definitions.limit.${key}` as "definitions.limit.maxInstances")}</dt><dd>{value}</dd></div>)}</dl><footer><Button size="small" disabled={locked} onClick={() => editTeam(id)}>{t("common.edit")}</Button><Button size="small" variant="danger" disabled={locked} onClick={() => setDeleteTarget({ kind: "team", id, references: teamReferences(id) })}>{t("common.delete")}</Button></footer></details>) : <div className={styles.empty}><strong>{t("definitions.teams.empty")}</strong><span>{t(templateIds.length ? "definitions.teams.emptyDescription" : "definitions.teams.needsTemplate")}</span></div>}</div>
    </section>

    <Dialog.Root open={Boolean(templateForm)} onOpenChange={(open) => { if (!open) setTemplateForm(undefined); }}>
      <Dialog.Portal><Dialog.Backdrop className="settings-backdrop" /><Dialog.Viewport className="settings-viewport"><Dialog.Popup className={styles.dialog}><Dialog.Title>{t(templateForm?.previousId ? "definitions.template.edit" : "definitions.template.add")}</Dialog.Title><Dialog.Description>{t("definitions.template.help")}</Dialog.Description>{templateForm && <form onSubmit={saveTemplate}>
        <label><span>{t("definitions.id")}</span><input autoFocus required maxLength={64} pattern="[A-Za-z][A-Za-z0-9_-]*" value={templateForm.id} onChange={(event) => setTemplateForm({ ...templateForm, id: event.target.value })} /></label>
        <label><span>{t("definitions.description")}</span><textarea required maxLength={2000} value={templateForm.description} onChange={(event) => setTemplateForm({ ...templateForm, description: event.target.value })} /></label>
        <label><span>{t("definitions.capabilities")}</span><input value={templateForm.capabilities} placeholder="network, process" onChange={(event) => setTemplateForm({ ...templateForm, capabilities: event.target.value })} /><small>{t("definitions.capabilities.help")}</small></label>
        <label><span>{t("definitions.runner")}</span><select value={templateForm.runner} onChange={(event) => setTemplateForm({ ...templateForm, runner: event.target.value as TemplateForm["runner"], reference: event.target.value === "subgraph" ? subgraphs[0] ?? "" : "" })}><option value="subgraph">{t("definitions.runner.subgraph")}</option><option value="a2a">{t("definitions.runner.a2a")}</option></select></label>
        {templateForm.runner === "subgraph" ? <label><span>{t("definitions.subgraph")}</span><select required value={templateForm.reference} onChange={(event) => setTemplateForm({ ...templateForm, reference: event.target.value })}><option value="">{t("common.select")}</option>{subgraphs.map((name) => <option key={name}>{name}</option>)}</select></label> : <label><span>{t("definitions.a2aConnection")}</span><input required maxLength={128} value={templateForm.reference} onChange={(event) => setTemplateForm({ ...templateForm, reference: event.target.value })} /></label>}
        {formError && <p role="alert" className="field-error">{formError}</p>}<footer><Dialog.Close className="button">{t("common.cancel")}</Dialog.Close><Button type="submit" variant="primary">{t("common.save")}</Button></footer>
      </form>}</Dialog.Popup></Dialog.Viewport></Dialog.Portal>
    </Dialog.Root>

    <Dialog.Root open={Boolean(teamForm)} onOpenChange={(open) => { if (!open) setTeamForm(undefined); }}>
      <Dialog.Portal><Dialog.Backdrop className="settings-backdrop" /><Dialog.Viewport className="settings-viewport"><Dialog.Popup className={styles.dialog}><Dialog.Title>{t(teamForm?.previousId ? "definitions.team.edit" : "definitions.team.add")}</Dialog.Title><Dialog.Description>{t("definitions.team.help")}</Dialog.Description>{teamForm && <form onSubmit={saveTeam}>
        <label><span>{t("definitions.id")}</span><input autoFocus required maxLength={64} pattern="[A-Za-z][A-Za-z0-9_-]*" value={teamForm.id} onChange={(event) => setTeamForm({ ...teamForm, id: event.target.value })} /></label>
        <label><span>{t("definitions.orchestrator")}</span><select required value={teamForm.orchestrator} onChange={(event) => setTeamForm({ ...teamForm, orchestrator: event.target.value })}>{templateIds.map((id) => <option key={id}>{id}</option>)}</select></label>
        <fieldset><legend>{t("definitions.members")}</legend>{templateIds.map((id) => <label className={styles.check} key={id}><input type="checkbox" checked={teamForm.members.includes(id)} onChange={(event) => setTeamForm({ ...teamForm, members: event.target.checked ? [...teamForm.members, id] : teamForm.members.filter((member) => member !== id) })} /><span>{id}</span></label>)}</fieldset>
        <details><summary>{t("definitions.limits")}</summary><div className={styles.limits}>{limitKeys.map((key) => <label key={key}><span>{t(`definitions.limit.${key}` as "definitions.limit.maxInstances")}</span><input type="number" min={1} value={teamForm.limits[key]} onChange={(event) => setTeamForm({ ...teamForm, limits: { ...teamForm.limits, [key]: event.target.value } })} /></label>)}</div></details>
        {formError && <p role="alert" className="field-error">{formError}</p>}<footer><Dialog.Close className="button">{t("common.cancel")}</Dialog.Close><Button type="submit" variant="primary">{t("common.save")}</Button></footer>
      </form>}</Dialog.Popup></Dialog.Viewport></Dialog.Portal>
    </Dialog.Root>

    {deleteTarget && <ConfirmDialog open danger title={t(deleteTarget.kind === "template" ? "definitions.template.deleteTitle" : "definitions.team.deleteTitle", { id: deleteTarget.id })} description={t(deleteTarget.kind === "template" ? "definitions.template.deleteDescription" : "definitions.team.deleteDescription", { count: deleteTarget.references })} confirmLabel={t("common.delete")} cancelLabel={t("common.cancel")} onConfirm={() => onChange(deleteTarget.kind === "template" ? deleteAgentTemplate(draft, deleteTarget.id) : deleteTeam(draft, deleteTarget.id))} onOpenChange={(open) => { if (!open) setDeleteTarget(undefined); }} />}
  </div>;
}
