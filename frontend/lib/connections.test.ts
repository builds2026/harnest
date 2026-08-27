import { describe, expect, it } from "vitest";
import { connectionCanRun, connectionDetails, connectionOperationForAction, missingConnectionSetup, type ConnectionSummary } from "./connections";

const provider: ConnectionSummary = {
  id: "gemini", name: "Gemini", kind: "provider", scope: "project", status: "connected",
  config: {}, credentialFields: [], credentialPresence: {},
};

describe("missingConnectionSetup", () => {
  it("reports an unbound component even when a compatible connection exists", () => {
    expect(missingConnectionSetup([{ type: "model", config: {} }], [provider], []))
      .toEqual({ kind: "provider" });
  });

  it("accepts a bound compatible component", () => {
    expect(missingConnectionSetup([{ type: "model", config: { connectionId: "gemini" } }], [provider], []))
      .toBeUndefined();
  });
});

describe("connection operation feedback", () => {
  it("maps server actions to stable transient phases", () => {
    expect(connectionOperationForAction("reauth")).toBe("authorizing");
    expect(connectionOperationForAction("discover")).toBe("discovering");
    expect(connectionOperationForAction("approve-process")).toBe("approving");
    expect(connectionOperationForAction("test")).toBe("testing");
  });
});

describe("Connection run readiness", () => {
  it("requires a confirmed connected status", () => {
    expect(connectionCanRun({ status: "connected" })).toBe(true);
    expect(connectionCanRun({ status: "unknown" })).toBe(false);
  });
});

describe("connection details", () => {
  it("identifies model services by provider and model", () => {
    expect(connectionDetails({ kind: "provider", config: { adapter: "gemini", model: "gemini-2.5-flash" } }))
      .toBe("Google AI Studio · gemini-2.5-flash");
  });
});
