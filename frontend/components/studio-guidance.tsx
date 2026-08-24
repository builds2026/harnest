"use client";

import type { ReactNode } from "react";
import { useI18n } from "./i18n-provider";
import type { ReadinessStep, ReadinessStepId } from "@/lib/readiness";
import { Button } from "./ui/ui";
import styles from "./studio-guidance.module.css";

const keyForStep: Readonly<Record<ReadinessStepId, "readiness.draft" | "readiness.connected" | "readiness.validated" | "readiness.tested" | "readiness.ready">> = {
  draft: "readiness.draft",
  connected: "readiness.connected",
  validated: "readiness.validated",
  tested: "readiness.tested",
  ready: "readiness.ready",
};

export function ReadinessTrail({ steps, compact = false }: { steps: readonly ReadinessStep[]; compact?: boolean }) {
  const { t } = useI18n();
  return <ol className={`${styles.trail} ${compact ? styles.compact : ""}`} aria-label={t("readiness.label")}>
    {steps.map((step) => <li key={step.id} className={styles[step.status]} aria-label={t(keyForStep[step.id])} title={t(keyForStep[step.id])} aria-current={step.status === "current" ? "step" : undefined}>
      <span aria-hidden="true">{step.status === "complete" ? "✓" : step.status === "error" ? "!" : ""}</span>
      <strong>{t(keyForStep[step.id])}</strong>
    </li>)}
  </ol>;
}

export interface SetupJourneyStep {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly complete: boolean;
  readonly action?: ReactNode;
}

export function SetupJourney({ steps, onDismiss }: { steps: readonly SetupJourneyStep[]; onDismiss: () => void }) {
  const { t } = useI18n();
  const complete = steps.filter((step) => step.complete).length;
  return <aside className={styles.journey} aria-labelledby="setup-journey-title">
    <header><div><span>{t("setup.eyebrow")}</span><strong id="setup-journey-title">{t("setup.title")}</strong><p>{t("setup.description")}</p></div><button type="button" aria-label={t("setup.dismiss")} title={t("setup.dismiss")} onClick={onDismiss}>×</button></header>
    <div className={styles.progress}><span style={{ width: `${(complete / Math.max(1, steps.length)) * 100}%` }} /><small>{complete}/{steps.length}</small></div>
    <ol>{steps.map((step, index) => <li key={step.id} className={step.complete ? styles.stepComplete : index === complete ? styles.stepCurrent : ""}>
      <span aria-hidden="true">{step.complete ? "✓" : index + 1}</span>
      <div><strong>{step.title}</strong><p>{step.description}</p>{!step.complete && step.action}</div>
    </li>)}</ol>
  </aside>;
}

export function JourneyAction({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return <Button size="small" variant="primary" onClick={onClick}>{children}</Button>;
}
