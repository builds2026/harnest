import { describe, expect, it } from "vitest";
import { connectionOperationForAction } from "./connections";

describe("connection operation feedback", () => {
  it("maps server actions to stable transient phases", () => {
    expect(connectionOperationForAction("reauth")).toBe("authorizing");
    expect(connectionOperationForAction("discover")).toBe("discovering");
    expect(connectionOperationForAction("approve-process")).toBe("approving");
    expect(connectionOperationForAction("test")).toBe("testing");
  });
});
