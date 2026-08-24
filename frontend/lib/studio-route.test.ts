import { describe, expect, it } from "vitest";
import { surfaceFromPathname } from "./studio-route";

describe("Studio routes", () => {
  it("maps known routes and safely falls back to builder", () => {
    expect(surfaceFromPathname("/playground")).toBe("playground");
    expect(surfaceFromPathname("/runs/last")).toBe("runs");
    expect(surfaceFromPathname("/settings")).toBe("settings");
    expect(surfaceFromPathname("/")).toBe("builder");
    expect(surfaceFromPathname("/unknown")).toBe("builder");
  });
});
