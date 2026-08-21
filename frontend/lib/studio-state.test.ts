import { BUILTIN_COMPONENT_MANIFESTS, stringifySpec, type HarnessSpec } from "@harnest/core";
import { describe, expect, it } from "vitest";

import {
  createDocumentState,
  draftToSpec,
  isEntrypointCandidate,
  parseYamlDraft,
  studioDocumentReducer,
} from "./studio-state";

const spec: HarnessSpec = {
  version: "0.1",
  components: [
    { id: "model", type: "model", config: { adapter: "echo", model: "echo-v1" } },
    { id: "prompt", type: "prompt", config: { template: "Answer {{input}}" } },
    { id: "agent", type: "agent", config: {} },
    { id: "output", type: "output", config: { format: "text" } },
  ],
  connections: [
    { from: { component: "model", port: "model" }, to: { component: "agent", port: "model" } },
    { from: { component: "prompt", port: "prompt" }, to: { component: "agent", port: "prompt" } },
    { from: { component: "agent", port: "response" }, to: { component: "output", port: "value" } },
  ],
  entrypoint: "output",
  studio: { positions: { model: { x: 10, y: 20 } } },
};

describe("Studio document state", () => {
  it("keeps the last valid canvas while YAML is invalid", () => {
    const initial = createDocumentState(spec, BUILTIN_COMPONENT_MANIFESTS);
    const parsed = parseYamlDraft("version: [", BUILTIN_COMPONENT_MANIFESTS);
    const edited = studioDocumentReducer(initial, {
      type: "edit-yaml",
      text: "version: [",
      pendingSpec: parsed.spec,
      diagnostics: parsed.diagnostics,
      parseOk: parsed.parseOk,
    });

    expect(edited.yamlState).toBe("invalid");
    expect(edited.draft).toBe(initial.draft);
    expect(draftToSpec(edited.draft).components).toEqual(spec.components);
  });

  it("applies valid YAML as the single graph draft", () => {
    const changed: HarnessSpec = {
      ...spec,
      components: spec.components.map((component) => component.type === "prompt"
        ? { ...component, config: { template: "Changed {{input}}" } }
        : component),
    };
    const initial = createDocumentState(spec, BUILTIN_COMPONENT_MANIFESTS);
    const parsed = parseYamlDraft(stringifySpec(changed), BUILTIN_COMPONENT_MANIFESTS);
    const edited = studioDocumentReducer(initial, {
      type: "edit-yaml",
      text: stringifySpec(changed),
      pendingSpec: parsed.spec,
      diagnostics: parsed.diagnostics,
      parseOk: parsed.parseOk,
    });
    const applied = studioDocumentReducer(edited, { type: "apply-yaml" });

    expect(applied.yamlState).toBe("synced");
    expect(draftToSpec(applied.draft).components).toEqual(changed.components);
    expect(applied.semanticRevision).toBe(1);
  });

  it("round-trips v0.2 edge semantics and named subgraph layouts", () => {
    const advanced: HarnessSpec = {
      version: "0.2",
      components: [
        { id: "source", type: "prompt", config: { template: "{{input}}" } },
        { id: "sink", type: "output", config: { format: "text" } },
      ],
      connections: [{
        id: "conditioned",
        from: { component: "source", port: "prompt" },
        to: { component: "sink", port: "value" },
        condition: { source: "input", path: "/enabled", op: "equals", value: true },
        select: "/answer",
        state: { key: "latest.answer", merge: "replace" },
      }],
      entrypoint: "sink",
      subgraphs: {
        revise: {
          components: [
            { id: "innerSource", type: "prompt", config: { template: "Revise {{input}}" } },
            { id: "innerSink", type: "output", config: { format: "text" } },
          ],
          connections: [{
            from: { component: "innerSource", port: "prompt" },
            to: { component: "innerSink", port: "value" },
          }],
          entrypoint: "innerSink",
        },
      },
      studio: {
        positions: { source: { x: 10, y: 20 }, sink: { x: 330, y: 20 } },
        subgraphs: { revise: { positions: { innerSource: { x: 15, y: 25 }, innerSink: { x: 335, y: 25 } } } },
      },
    };

    expect(draftToSpec(createDocumentState(advanced, BUILTIN_COMPONENT_MANIFESTS).draft)).toEqual(advanced);
  });

  it("keeps the builtin Output eligible as an entrypoint even though it exposes a value port", () => {
    const draft = createDocumentState(spec, BUILTIN_COMPONENT_MANIFESTS).draft;
    const output = draft.nodes.find((node) => node.id === "output")!;
    expect(Object.keys(output.data.manifest.ports.outputs)).toContain("value");
    expect(isEntrypointCandidate(output, draft.edges)).toBe(true);
  });
});
