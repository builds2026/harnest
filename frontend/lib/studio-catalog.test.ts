import { describe, expect, it } from "vitest";
import { TEMPLATE_CATALOG, templateSpec } from "./studio-catalog";

const allComponents = (id: Parameters<typeof templateSpec>[0]) => {
  const spec = templateSpec(id);
  return [
    ...spec.components,
    ...(spec.version === "0.2"
      ? Object.values(spec.subgraphs ?? {}).flatMap((graph) => graph.components)
      : []),
  ];
};

describe("Studio commissioning templates", () => {
  it("ships five graphs without trusted runtime module shortcuts", () => {
    expect(TEMPLATE_CATALOG.map((template) => template.id)).toEqual([
      "rag",
      "web-research",
      "coding-agent",
      "mcp-agent",
      "evaluation-loop",
    ]);
    for (const template of TEMPLATE_CATALOG) {
      const spec = templateSpec(template.id);
      expect(spec.runtime?.adapters ?? []).toEqual([]);
      for (const model of allComponents(template.id).filter((component) => component.type === "model")) {
        expect((model.config as Record<string, unknown>).connectionId).toBe("");
      }
    }
  });

  it("uses executable Tool references with exact builtin ids", () => {
    const web = allComponents("web-research").find((component) => component.id === "tool");
    const webAgent = allComponents("web-research").find((component) => component.id === "agent");
    const code = allComponents("coding-agent").find((component) => component.id === "tool");
    expect(web).toMatchObject({ type: "tool", config: { tool: "builtin.web-search", source: "builtin" } });
    expect(webAgent).toMatchObject({ type: "agent", config: { maxToolCalls: 1, maxTurns: 3 } });
    expect(code).toMatchObject({ type: "tool", config: { tool: "builtin.code-runner", source: "builtin" } });
  });

  it("keeps RAG unready until real knowledge is supplied", () => {
    const knowledge = allComponents("rag").find((component) => component.id === "knowledge");
    expect(knowledge).toMatchObject({ type: "context", config: { source: "text", text: "" } });
  });
});
