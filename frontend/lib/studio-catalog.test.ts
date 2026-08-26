import { describe, expect, it } from "vitest";
import { validateSpec } from "@harnestai/core";
import { templateSpec } from "./studio-catalog";

describe("Dynamic Team recipe", () => {
  it("produces a valid v0.3 classifier and bounded Team Harness", () => {
    const spec = templateSpec("dynamic-team");
    expect(validateSpec(spec).diagnostics).toEqual([]);
    expect(spec.version).toBe("0.3");
    if (spec.version !== "0.3") return;
    expect(spec.agentTemplates?.researcher?.capabilities).toContain("network");
    expect(spec.teams?.engineering?.limits?.maxParallel).toBe(4);
    expect(spec.studio?.pinned).toEqual(["classify"]);
  });
});
