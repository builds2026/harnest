import { BUILTIN_COMPONENT_MANIFESTS, stringifySpec, type HarnessSpec } from "@harnestai/core";
import { describe, expect, it } from "vitest";

import {
  compatiblePortInsertions,
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
        { id: "source", type: "prompt", config: { template: "{{input}}" }, policy: {
          timeoutMs: 4_000,
          retry: { maxAttempts: 3, backoffMs: 50, maxBackoffMs: 500 },
        } },
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
      runtime: {
        timeoutMs: 120_000,
        adapters: ["@example/adapter"],
        modules: ["@example/components"],
        retry: { maxAttempts: 2, backoffMs: 100, maxBackoffMs: 1_000 },
        budget: { maxTokens: 250_000, maxCostUsd: 2.5 },
      },
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

  it("keeps editable and advanced test cases in the semantic draft", () => {
    const withTests: HarnessSpec = {
      version: "0.2",
      components: spec.components,
      connections: spec.connections,
      entrypoint: spec.entrypoint,
      tests: [
        { id: "contains", input: "hello", assertion: { type: "includes", value: "hello" } },
        { id: "bounded", input: { topic: "status" }, assertions: [
          { type: "latency", maxMs: 2_000 },
          { type: "iterations", max: 3 },
        ] },
      ],
    };

    expect(draftToSpec(createDocumentState(withTests, BUILTIN_COMPONENT_MANIFESTS).draft).tests).toEqual(withTests.tests);
  });

  it("offers only components that can connect to the selected typed port", () => {
    const draft = createDocumentState(spec, BUILTIN_COMPONENT_MANIFESTS).draft;

    expect(compatiblePortInsertions(draft, BUILTIN_COMPONENT_MANIFESTS, {
      nodeId: "model", direction: "output", port: "model",
    })).toEqual(expect.arrayContaining([expect.objectContaining({ type: "agent", connectPort: "model" })]));
    expect(compatiblePortInsertions(draft, BUILTIN_COMPONENT_MANIFESTS, {
      nodeId: "output", direction: "input", port: "value",
    })).toEqual([]);
    expect(compatiblePortInsertions(draft, BUILTIN_COMPONENT_MANIFESTS, {
      nodeId: "output", direction: "output", port: "value",
    })).toEqual([]);
  });

  it("undoes semantic edits and treats a drag as one layout change", () => {
    const initial = createDocumentState(spec, BUILTIN_COMPONENT_MANIFESTS);
    const changed = structuredClone(initial.draft);
    changed.nodes[1]!.data.component.config = { template: "Changed {{input}}" };
    const edited = studioDocumentReducer(initial, { type: "replace-draft", draft: changed, touch: "semantic" });
    const undone = studioDocumentReducer(edited, { type: "undo" });
    const redone = studioDocumentReducer(undone, { type: "redo" });

    expect(undone.draft.nodes[1]!.data.component.config).toEqual({ template: "Answer {{input}}" });
    expect(redone.draft.nodes[1]!.data.component.config).toEqual({ template: "Changed {{input}}" });

    const moving = structuredClone(initial.draft);
    moving.nodes[0]!.position = { x: 30, y: 40 };
    const transient = studioDocumentReducer(initial, { type: "replace-draft", draft: moving, touch: "transient" });
    const moved = structuredClone(transient.draft);
    moved.nodes[0]!.position = { x: 90, y: 100 };
    const committed = studioDocumentReducer(transient, { type: "replace-draft", draft: moved, touch: "layout" });

    expect(studioDocumentReducer(committed, { type: "undo" }).draft.nodes[0]!.position).toEqual({ x: 10, y: 20 });
  });

  it("ignores an autosave response when a newer revision already exists", () => {
    const initial = createDocumentState(spec, BUILTIN_COMPONENT_MANIFESTS);
    const firstDraft = structuredClone(initial.draft);
    firstDraft.nodes[1]!.data.component.config = { template: "First {{input}}" };
    const first = studioDocumentReducer(initial, { type: "replace-draft", draft: firstDraft, touch: "semantic" });
    const secondDraft = structuredClone(first.draft);
    secondDraft.nodes[1]!.data.component.config = { template: "Second {{input}}" };
    const second = studioDocumentReducer(first, { type: "replace-draft", draft: secondDraft, touch: "semantic" });

    const staleResponse = studioDocumentReducer(second, { type: "save-result", revision: first.revision });
    expect(staleResponse.savedRevision).toBe(0);
    expect(studioDocumentReducer(staleResponse, { type: "save-result", revision: second.revision }).savedRevision).toBe(second.revision);
  });

  it("keeps canvas selection and edit history when the catalog finishes loading", () => {
    const initial = createDocumentState(spec, []);
    const selectedDraft = structuredClone(initial.draft);
    selectedDraft.nodes[1]!.selected = true;
    selectedDraft.nodes[1]!.data.component.config = { template: "Editing {{input}}" };
    const editing = studioDocumentReducer(initial, {
      type: "replace-draft",
      draft: selectedDraft,
      touch: "semantic",
    });

    const loaded = studioDocumentReducer(editing, {
      type: "set-catalog",
      catalog: BUILTIN_COMPONENT_MANIFESTS,
    });

    expect(loaded.draft.nodes[1]).toMatchObject({
      selected: true,
      data: {
        component: { config: { template: "Editing {{input}}" } },
        manifest: { type: "prompt" },
      },
    });
    expect(studioDocumentReducer(loaded, { type: "undo" }).draft.nodes[1]!.data.manifest.type).toBe("prompt");
  });
});
