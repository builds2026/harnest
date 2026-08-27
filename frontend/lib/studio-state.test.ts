import { BUILTIN_COMPONENT_MANIFESTS, stringifySpec, type HarnessSpec } from "@harnestai/core";
import { describe, expect, it } from "vitest";

import {
  compatiblePortInsertions,
  createDocumentState,
  deleteAgentTemplate,
  deleteDraftSubgraph,
  deleteTeam,
  draftToSpec,
  isEntrypointCandidate,
  parseYamlDraft,
  renameDraftComponent,
  renameDraftSubgraph,
  replaceConnectionReferences,
  subgraphReferenceSummary,
  studioDocumentReducer,
  upsertAgentTemplate,
  upsertTeam,
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
  it("renames a component and every graph/layout reference without crossing graph scopes", () => {
    const draft = createDocumentState({
      version: "0.3",
      components: [
        { id: "source", type: "prompt", config: { template: "{{input}}" } },
        { id: "sink", type: "output", config: {} },
      ],
      connections: [{ from: { component: "source", port: "prompt" }, to: { component: "sink", port: "value" } }],
      entrypoint: "source",
      subgraphs: {
        nested: { components: [{ id: "source", type: "prompt", config: { template: "nested" } }], connections: [], entrypoint: "source" },
      },
      studio: {
        positions: { source: { x: 10, y: 20 }, sink: { x: 300, y: 20 } },
        pinned: ["source"],
        subgraphs: { nested: { positions: { source: { x: 30, y: 40 } } } },
      },
    }, BUILTIN_COMPONENT_MANIFESTS).draft;

    const renamed = renameDraftComponent(draft, "source", "request");
    expect(renamed.root.entrypoint).toBe("request");
    expect(renamed.nodes.map(({ id }) => id)).toEqual(["request", "sink"]);
    expect(renamed.nodes[0]?.data.component.id).toBe("request");
    expect(renamed.edges[0]).toMatchObject({ source: "request", target: "sink", data: {
      connection: { from: { component: "request" }, to: { component: "sink" } },
    } });
    expect(renamed.layout?.pinned).toEqual(["request"]);
    expect(renamed.subgraphs.nested.nodes[0]?.id).toBe("source");
    expect(() => renameDraftComponent(draft, "source", "sink")).toThrow("COMPONENT_ID_COLLISION");
    expect(() => renameDraftComponent(draft, "source", "bad id")).toThrow("INVALID_DRAFT_ID");
  });

  it("renames and deletes subgraphs with callers, templates, teams, and layouts kept consistent", () => {
    const draft = createDocumentState({
      version: "0.3",
      components: [
        { id: "call", type: "subgraph", config: { subgraph: "worker" } },
        { id: "output", type: "output", config: {} },
      ],
      connections: [{ from: { component: "call", port: "value" }, to: { component: "output", port: "value" } }],
      entrypoint: "call",
      subgraphs: {
        worker: { components: [{ id: "workerOutput", type: "output", config: {} }], connections: [], entrypoint: "workerOutput" },
        nested: {
          components: [
            { id: "loop", type: "loop", config: { subgraph: "worker", maxIterations: 2 } },
            { id: "nestedOutput", type: "output", config: {} },
          ],
          connections: [{ from: { component: "loop", port: "value" }, to: { component: "nestedOutput", port: "value" } }],
          entrypoint: "loop",
        },
      },
      agentTemplates: {
        workerTemplate: { description: "Worker", runner: { subgraph: "worker" } },
      },
      teams: {
        workerTeam: { orchestrator: "workerTemplate", members: ["workerTemplate"] },
      },
      studio: {
        positions: { call: { x: 10, y: 20 }, output: { x: 300, y: 20 } },
        pinned: ["call"],
        subgraphs: {
          worker: { positions: { workerOutput: { x: 10, y: 20 } }, direction: "DOWN" },
          nested: { positions: { loop: { x: 10, y: 20 }, nestedOutput: { x: 300, y: 20 } }, pinned: ["loop"] },
        },
      },
    }, BUILTIN_COMPONENT_MANIFESTS).draft;

    expect(subgraphReferenceSummary(draft, "worker")).toEqual({ components: 2, agentTemplates: 1, teams: 1 });
    const renamed = renameDraftSubgraph(draft, "worker", "review");
    expect(renamed.subgraphs.review.layout).toMatchObject({ direction: "DOWN" });
    expect(renamed.subgraphs.worker).toBeUndefined();
    expect(renamed.nodes[0]?.data.component.config).toMatchObject({ subgraph: "review" });
    expect(renamed.subgraphs.nested.nodes[0]?.data.component.config).toMatchObject({ subgraph: "review" });
    expect((renamed.root.agentTemplates as Record<string, { runner: { subgraph: string } }>).workerTemplate.runner.subgraph).toBe("review");
    expect(() => renameDraftSubgraph(draft, "worker", "nested")).toThrow("SUBGRAPH_ID_COLLISION");

    const deleted = deleteDraftSubgraph(draft, "worker");
    expect(deleted.subgraphs.worker).toBeUndefined();
    expect(deleted.nodes.map(({ id }) => id)).toEqual(["output"]);
    expect(deleted.root.entrypoint).toBe("output");
    expect(deleted.edges).toEqual([]);
    expect(deleted.layout?.pinned).toBeUndefined();
    expect(deleted.subgraphs.nested.nodes.map(({ id }) => id)).toEqual(["nestedOutput"]);
    expect(deleted.subgraphs.nested.entrypoint).toBe("nestedOutput");
    expect(deleted.root.agentTemplates).toBeUndefined();
    expect(deleted.root.teams).toBeUndefined();
  });

  it("authors v0.3 definitions while keeping team and graph references valid", () => {
    const draft = createDocumentState({
      version: "0.3",
      components: [
        { id: "teamCall", type: "team", config: { team: "engineering" } },
        { id: "output", type: "output", config: {} },
      ],
      connections: [{ from: { component: "teamCall", port: "value" }, to: { component: "output", port: "value" } }],
      entrypoint: "teamCall",
      subgraphs: { runner: { components: [{ id: "runnerOutput", type: "output", config: {} }], connections: [], entrypoint: "runnerOutput" } },
      agentTemplates: {
        chief: { description: "Plans", runner: { subgraph: "runner" } },
        worker: { description: "Works", runner: { subgraph: "runner" } },
      },
      teams: { engineering: { orchestrator: "chief", members: ["worker"], limits: { maxParallel: 2 } } },
      studio: { positions: { teamCall: { x: 10, y: 20 }, output: { x: 300, y: 20 } }, pinned: ["teamCall"] },
    }, BUILTIN_COMPONENT_MANIFESTS).draft;

    const renamedTemplate = upsertAgentTemplate(draft, "worker", "reviewer", {
      description: "Reviews", capabilities: ["network", "network"], runner: { subgraph: "runner" },
    });
    expect((renamedTemplate.root.teams as Record<string, { members: string[] }>).engineering.members).toEqual(["reviewer"]);
    expect((renamedTemplate.root.agentTemplates as Record<string, { capabilities: string[] }>).reviewer.capabilities).toEqual(["network"]);
    expect(() => upsertAgentTemplate(draft, undefined, "chief", { description: "Duplicate", runner: { subgraph: "runner" } }))
      .toThrow("AGENT_TEMPLATE_ID_COLLISION");

    const renamedTeam = upsertTeam(renamedTemplate, "engineering", "review", {
      orchestrator: "chief", members: ["reviewer"], limits: { maxParallel: 4, maxDepth: 2 },
    });
    expect(renamedTeam.nodes[0]?.data.component.config).toMatchObject({ team: "review" });
    expect(() => upsertTeam(renamedTemplate, undefined, "invalid", { orchestrator: "missing", members: ["reviewer"] }))
      .toThrow("TEAM_REFERENCE_INVALID");

    const deletedTemplate = deleteAgentTemplate(renamedTeam, "chief");
    expect(deletedTemplate.root.teams).toBeUndefined();
    expect(deletedTemplate.nodes.map(({ id }) => id)).toEqual(["output"]);
    expect(deletedTemplate.root.entrypoint).toBe("output");
    expect(deletedTemplate.layout?.pinned).toBeUndefined();
    expect(deleteTeam(renamedTeam, "review").nodes.map(({ id }) => id)).toEqual(["output"]);
  });

  it("replaces stale Connection references in root and subgraphs", () => {
    const draft = createDocumentState({
      ...spec,
      version: "0.2",
      components: spec.components.map((component) => component.type === "model"
        ? { ...component, config: { connectionId: "missing" } }
        : component),
      subgraphs: {
        nested: {
          components: [{ id: "nestedModel", type: "model", config: { connectionId: "fallback", fallbackConnectionId: "missing" } }],
          connections: [],
          entrypoint: "nestedModel",
        },
      },
    }, BUILTIN_COMPONENT_MANIFESTS).draft;

    const replaced = replaceConnectionReferences(draft, "missing", "ready");
    expect((replaced.nodes.find(({ id }) => id === "model")?.data.component.config as Record<string, unknown>).connectionId).toBe("ready");
    expect(replaced.subgraphs.nested.nodes[0]?.data.component.config).toEqual({ connectionId: "fallback", fallbackConnectionId: "ready" });
    expect(replaceConnectionReferences(replaced, "ready", "fallback").subgraphs.nested.nodes[0]?.data.component.config)
      .toEqual({ connectionId: "fallback" });
  });

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
