import type { HarnessSpec, RunEvent } from "@harnestai/core";

export interface ExperimentVariant {
  readonly id: string;
  readonly label: string;
  readonly componentId: string;
  readonly config: Readonly<Record<string, unknown>>;
}

export function applyExperimentVariant(spec: HarnessSpec, variant: ExperimentVariant): HarnessSpec {
  const copy = structuredClone(spec);
  const component = copy.components.find(({ id }) => id === variant.componentId);
  if (!component) throw new Error(`Component '${variant.componentId}' does not exist`);
  component.config = { ...component.config, ...variant.config };
  return copy;
}

export function experimentQuality(trace: readonly RunEvent[]) {
  const evaluations = trace.filter((event) => event.type === "evaluation");
  if (!evaluations.length) return undefined;
  const scores = evaluations.flatMap((event) => typeof event.score === "number" ? [event.score] : []);
  return {
    passed: evaluations.filter((event) => event.passed).length,
    total: evaluations.length,
    ...(scores.length ? { averageScore: scores.reduce((total, score) => total + score, 0) / scores.length } : {}),
  };
}

export const formatExperimentValue = (value: unknown) => typeof value === "string"
  ? value
  : JSON.stringify(value, null, 2) ?? "null";

export function parseExperimentValue(text: string, sample: unknown): unknown {
  if (typeof sample === "string") return text;
  if (typeof sample === "number") {
    const value = Number(text);
    if (!Number.isFinite(value)) throw new Error("Enter a finite number");
    return value;
  }
  if (typeof sample === "boolean") {
    if (text === "true") return true;
    if (text === "false") return false;
    throw new Error("Enter true or false");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Enter valid JSON");
  }
}
