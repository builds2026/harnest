import { describe, expect, it } from "vitest";
import { buildReadiness } from "./readiness";

describe("harness readiness", () => {
  const readyInput = {
    dirty: false,
    saving: false,
    saveError: false,
    connectionsLoaded: true,
    missingConnections: 0,
    checkingValidation: false,
    validated: true,
    validationErrors: 0,
    tested: true,
  } as const;

  it("marks the entire lifecycle complete only after a successful run", () => {
    expect(buildReadiness(readyInput).every(({ status }) => status === "complete")).toBe(true);
    expect(buildReadiness({ ...readyInput, tested: false }).find(({ id }) => id === "tested")?.status).toBe("current");
  });

  it("keeps connection and validation failures actionable", () => {
    const steps = buildReadiness({ ...readyInput, missingConnections: 1, validated: false, tested: false });
    expect(steps.find(({ id }) => id === "connected")?.status).toBe("error");
    expect(steps.find(({ id }) => id === "ready")?.status).toBe("error");
  });
});
