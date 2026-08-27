"use client";

import Link from "next/link";
import { useI18n } from "./i18n-provider";
import { Button } from "./ui/ui";
import styles from "./route-state.module.css";

const copyFor = (locale: "en-US" | "ko-KR") => locale === "ko-KR" ? {
  loadingTitle: "Studio를 준비하고 있어요",
  loadingBody: "프로젝트와 실행 상태를 불러오는 중입니다.",
  errorTitle: "화면을 불러오지 못했어요",
  errorBody: "잠시 후 다시 시도하세요. 문제가 계속되면 진단 ID로 서버 로그를 확인할 수 있습니다.",
  missingTitle: "이 화면을 찾을 수 없어요",
  missingBody: "주소가 바뀌었거나 더 이상 제공되지 않는 화면입니다.",
  back: "Builder로 돌아가기",
} : {
  loadingTitle: "Preparing Studio",
  loadingBody: "Loading your project and run state.",
  errorTitle: "This screen could not be loaded",
  errorBody: "Try again in a moment. If it continues, use the diagnostic ID to find the server log.",
  missingTitle: "This screen does not exist",
  missingBody: "The address may have changed or the screen is no longer available.",
  back: "Back to Builder",
};

function Frame({ mark, title, body, animated = false, children }: {
  mark: string;
  title: string;
  body: string;
  animated?: boolean;
  children?: React.ReactNode;
}) {
  return <main className={styles.page}>
    <section className={styles.card}>
      <span className={`${styles.mark} ${animated ? styles.animated : ""}`} aria-hidden="true">{mark}</span>
      <h1>{title}</h1>
      <p>{body}</p>
      {children && <div className={styles.actions}>{children}</div>}
    </section>
  </main>;
}

export function RouteLoading() {
  const { locale } = useI18n();
  const copy = copyFor(locale);
  return <div role="status" aria-live="polite"><Frame mark="…" title={copy.loadingTitle} body={copy.loadingBody} animated /></div>;
}

export function RouteError({ digest, onRetry }: { digest?: string; onRetry: () => void }) {
  const { locale, t } = useI18n();
  const copy = copyFor(locale);
  return <Frame mark="!" title={copy.errorTitle} body={copy.errorBody}>
    <Button variant="primary" onClick={onRetry}>{t("common.retry")}</Button>
    <Link className={styles.secondaryAction} href="/builder">{copy.back}</Link>
    {digest && <code className={styles.digest}>{digest}</code>}
  </Frame>;
}

export function RouteNotFound() {
  const { locale } = useI18n();
  const copy = copyFor(locale);
  return <Frame mark="404" title={copy.missingTitle} body={copy.missingBody}>
    <Link className={styles.primaryAction} href="/builder">{copy.back}</Link>
  </Frame>;
}
