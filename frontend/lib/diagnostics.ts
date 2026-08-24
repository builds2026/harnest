import type { Diagnostic } from "@harnest/core";

export type DiagnosticRecoveryAction = "focus-field" | "connect-service" | "open-runtime-settings";

export function diagnosticFieldPath(path: string): string | undefined {
  const normalized = path.replace(/^\$\.?/, "").replace(/\[(?:"|')?([^\]"']+)(?:"|')?\]/g, ".$1");
  const config = normalized.match(/(?:^|\.)(?:config|data)\.(.+)$/)?.[1];
  if (config) return config;
  const segments = normalized.split(/[./]/).filter(Boolean);
  return segments.at(-1);
}

export function diagnosticRecoveryAction(diagnostic: Pick<Diagnostic, "code" | "path" | "message" | "componentId">): DiagnosticRecoveryAction {
  const text = `${diagnostic.code} ${diagnostic.message}`.toLocaleUpperCase();
  if (/CONNECTION|CREDENTIAL|PROVIDER|OAUTH|MCP.*AUTH/.test(text)) return "connect-service";
  if (/HOST|CAPABILITY|PERMISSION|ALLOW_FILES|APPROVAL_REQUIRED/.test(text)) return "open-runtime-settings";
  return "focus-field";
}
