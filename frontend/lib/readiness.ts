export type ReadinessStatus = "complete" | "current" | "pending" | "error";
export type ReadinessStepId = "draft" | "connected" | "validated" | "tested" | "ready";

export interface ReadinessStep {
  readonly id: ReadinessStepId;
  readonly status: ReadinessStatus;
}

export interface ReadinessInput {
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly saveError: boolean;
  readonly connectionsLoaded: boolean;
  readonly missingConnections: number;
  readonly checkingValidation: boolean;
  readonly validated: boolean;
  readonly validationErrors: number;
  readonly tested: boolean;
}

export function buildReadiness(input: ReadinessInput): readonly ReadinessStep[] {
  const draftComplete = !input.dirty && !input.saving && !input.saveError;
  const connected = input.connectionsLoaded && input.missingConnections === 0;
  const valid = input.validated && input.validationErrors === 0;
  const ready = draftComplete && connected && valid && input.tested;
  return [
    { id: "draft", status: input.saveError ? "error" : draftComplete ? "complete" : "current" },
    { id: "connected", status: !draftComplete ? "pending" : connected ? "complete" : input.connectionsLoaded ? "error" : "current" },
    { id: "validated", status: input.validationErrors > 0 ? "error" : valid ? "complete" : connected && (input.checkingValidation || draftComplete) ? "current" : "pending" },
    { id: "tested", status: input.tested ? "complete" : valid ? "current" : "pending" },
    { id: "ready", status: ready ? "complete" : input.saveError || input.validationErrors > 0 || (input.connectionsLoaded && input.missingConnections > 0) ? "error" : "pending" },
  ];
}
