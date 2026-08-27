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
    expect(["research_agent", "coding_agent"].map((name) =>
      spec.subgraphs?.[name]?.components.find(({ id }) => id === "agent")?.config.toolError))
      .toEqual(["fail", "fail"]);
  });

  it.each(["web-research", "coding-agent", "mcp-agent"] as const)(
    "fails the %s recipe when its required Tool is denied or fails",
    (id) => {
      const spec = templateSpec(id);
      const agent = spec.components.find(({ id: componentId }) => componentId === "agent");
      expect((agent?.config as Record<string, unknown> | undefined)?.toolError).toBe("fail");
    },
  );
});
