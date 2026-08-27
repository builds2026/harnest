import { link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HarnessSpec } from "../src/spec.js";
import {
  initializeHarnestProject,
  bindHarnestProjectAsset,
  createPortableProjectTextFile,
  deletePortableProjectFile,
  HarnestProjectManifestSchema,
  listPortableProjectFiles,
  loadHarnestProjectSpec,
  loadSpecFile,
  projectEnvironmentReferences,
  resolveHarnessFile,
  readPortableProjectTextFile,
  saveHarnestProjectSpec,
  saveSpecFile,
  writePortableProjectTextFile,
  writeProjectEnvExample,
  type HarnestProjectManifest,
} from "../src/node.js";

const spec = (): HarnessSpec => ({
  version: "0.2",
  components: [
    { id: "prompt", type: "prompt", config: { template: "Inline fallback" } },
    { id: "knowledge", type: "context", config: { source: "text", text: "Inline context" } },
    { id: "output", type: "output", config: { format: "text" } },
  ],
  connections: [],
  entrypoint: "output",
  studio: { positions: {} },
});

const project = async () => {
  const directory = await mkdtemp(join(tmpdir(), "harnest-project-"));
  const file = join(directory, "harnest.yaml");
  await saveSpecFile(file, spec());
  return { directory, file };
};

describe("Harnest project source model", () => {
  it("keeps legacy YAML unchanged when no project manifest exists", async () => {
    const { file } = await project();
    const loaded = await loadHarnestProjectSpec(file);
    expect(loaded).toMatchObject({ ok: true, file });
    if (!loaded.ok) return;
    expect(loaded.project).toBeUndefined();
    expect(loaded.spec).toEqual(loaded.sourceSpec);
  });

  it("materializes Prompt, Context, Schema, Test, and Studio assets and resolves a project directory", async () => {
    const { directory, file } = await project();
    const manifest: HarnestProjectManifest = {
      version: 1,
      harness: "harnest.yaml",
      bindings: [
        { kind: "prompt", component: "prompt", path: "prompts/main.md" },
        { kind: "context", component: "knowledge", path: "context/guide.md" },
        { kind: "schema", component: "output", path: "schemas/output.json" },
      ],
      tests: ["tests/smoke.json"],
      studio: "studio.json",
    };
    await initializeHarnestProject(file, manifest, {
      "prompts/main.md": "Use the project source.\n\n{{input}}\n",
      "context/guide.md": "Grounded project context",
      "schemas/output.json": JSON.stringify({ type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false }),
      "tests/smoke.json": JSON.stringify([{ id: "smoke", input: "hello", assertion: { type: "includes", value: "hello" } }]),
      "studio.json": JSON.stringify({ positions: { output: { x: 10, y: 20 } } }),
    });

    expect(await resolveHarnessFile(directory)).toBe(file);
    const loaded = await loadSpecFile(directory);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.spec.components.find(({ id }) => id === "prompt")?.config.template).toContain("project source");
    expect(loaded.spec.components.find(({ id }) => id === "knowledge")?.config).toMatchObject({
      source: "file",
      path: ".harnest/context/guide.md",
    });
    expect(loaded.spec.components.find(({ id }) => id === "output")?.config).toMatchObject({
      format: "json",
      schema: { type: "object" },
    });
    expect(loaded.spec.tests).toHaveLength(1);
    expect(loaded.spec.studio?.positions.output).toEqual({ x: 10, y: 20 });

    const portable = await listPortableProjectFiles(file);
    expect(portable.map(({ archivePath }) => archivePath)).toEqual(expect.arrayContaining([
      ".harnest/project.json",
      ".harnest/prompts/main.md",
      ".harnest/context/guide.md",
      ".harnest/schemas/output.json",
      ".harnest/tests/smoke.json",
      ".harnest/studio.json",
    ]));
    expect(new Set(portable.map(({ archivePath }) => archivePath)).size).toBe(portable.length);
  });

  it("rejects traversal and symbolic-link project assets", async () => {
    const { directory, file } = await project();
    await mkdir(join(directory, ".harnest"));
    await writeFile(join(directory, ".harnest", "project.json"), JSON.stringify({
      version: 1,
      harness: "harnest.yaml",
      bindings: [{ kind: "prompt", component: "prompt", path: "../secret.txt" }],
    }));
    const traversal = await loadSpecFile(file);
    expect(traversal).toMatchObject({ ok: false, diagnostics: [expect.objectContaining({ code: "PROJECT_MANIFEST_INVALID" })] });

    await writeFile(join(directory, "outside.md"), "outside");
    await mkdir(join(directory, ".harnest", "prompts"));
    await symlink(join(directory, "outside.md"), join(directory, ".harnest", "prompts", "linked.md"));
    await writeFile(join(directory, ".harnest", "project.json"), JSON.stringify({
      version: 1,
      harness: "harnest.yaml",
      bindings: [{ kind: "prompt", component: "prompt", path: "prompts/linked.md" }],
    }));
    const linked = await loadSpecFile(file);
    expect(linked).toMatchObject({ ok: false, diagnostics: [expect.objectContaining({ code: "PROJECT_ASSET_LINK" })] });
  });

  it("bounds Harness YAML reads and rejects a symbolic-link Harness file", async () => {
    const { directory, file } = await project();
    await writeFile(file, "#".repeat(1_048_577));
    await expect(loadHarnestProjectSpec(file)).resolves.toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "FILE_READ", message: expect.stringContaining("exceeds 1048576 bytes") })],
    });

    const outside = join(await mkdtemp(join(tmpdir(), "harnest-project-outside-")), "harnest.yaml");
    await saveSpecFile(outside, spec());
    await rm(file);
    await symlink(outside, file);
    await expect(loadHarnestProjectSpec(directory)).resolves.toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "FILE_READ" })],
    });
  });

  it("bounds aggregate project assets before materializing the Harness", async () => {
    const { directory, file } = await project();
    const schemas = Array.from({ length: 5 }, (_, index) => `schemas/large-${index}.json`);
    await mkdir(join(directory, ".harnest", "schemas"), { recursive: true });
    await writeFile(join(directory, ".harnest", "project.json"), JSON.stringify({
      version: 1,
      harness: "harnest.yaml",
      bindings: schemas.map((path) => ({ kind: "schema", component: "output", path })),
    }));
    const largeSchema = JSON.stringify({ description: "x".repeat(3_999_950) });
    await Promise.all(schemas.map((path) => writeFile(join(directory, ".harnest", path), largeSchema)));

    await expect(loadHarnestProjectSpec(file)).resolves.toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "PROJECT_MATERIALIZATION_LIMIT" })],
    });
  });

  it("rejects a Harness file hard-linked outside its project", async () => {
    const { directory, file } = await project();
    const outside = join(await mkdtemp(join(tmpdir(), "harnest-project-outside-")), "harnest.yaml");
    await rm(file);
    await saveSpecFile(outside, spec());
    await link(outside, file);

    await expect(loadHarnestProjectSpec(directory)).resolves.toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "FILE_READ" })],
    });
  });

  it("keeps portable sources separate from credentials and runtime state", async () => {
    expect(HarnestProjectManifestSchema.safeParse({
      version: 1,
      harness: "harnest.yaml",
      portable: { include: ["connections.json"] },
    }).success).toBe(false);
    expect(HarnestProjectManifestSchema.safeParse({
      version: 1,
      harness: "nested/harnest.yaml",
    }).success).toBe(false);
    const { file } = await project();
    await expect(initializeHarnestProject(file, {
      version: 1,
      harness: "harnest.yaml",
    }, { "tool-permissions.json": "{}" })).rejects.toThrow("invalid path");
  });

  it("validates every declared portable include and its descendants", async () => {
    const { directory, file } = await project();
    await initializeHarnestProject(file, {
      version: 1,
      harness: "harnest.yaml",
      portable: { include: ["tools", "tools/missing.mjs"] },
    });
    await expect(loadHarnestProjectSpec(file)).resolves.toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({
        code: "PROJECT_ASSET_MISSING",
        path: "$..harnest.tools/missing.mjs",
      })],
    });

    await mkdir(join(directory, ".harnest", "tools", "nested"));
    await symlink(file, join(directory, ".harnest", "tools", "nested", "linked.yaml"));
    await writeFile(join(directory, ".harnest", "project.json"), JSON.stringify({
      version: 1,
      harness: "harnest.yaml",
      portable: { include: ["tools"] },
    }));
    await expect(loadHarnestProjectSpec(file)).resolves.toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "PROJECT_ASSET_LINK" })],
    });
  });

  it("discovers env references and creates a non-secret example once", async () => {
    const { directory, file } = await project();
    const configured = spec();
    configured.components[0]!.config = {
      template: "Explain env:NAME and env:SEARCH_TOKEN without treating them as configured values.",
    };
    configured.components[1]!.config = {
      source: "text",
      text: "Context prose may also explain env:CONTEXT_TOKEN without declaring it.",
    };
    configured.components.push({
      id: "model",
      type: "model",
      config: { adapter: "openai", model: "test", apiKey: "env:MODEL_KEY" },
    });
    expect(projectEnvironmentReferences(configured)).toEqual(["MODEL_KEY"]);
    expect(await writeProjectEnvExample(file, configured)).toBe(true);
    expect(await writeProjectEnvExample(file, configured)).toBe(false);
    expect(await readFile(join(directory, ".env.example"), "utf8")).toBe([
      "# Copy this file to .env and provide values locally. Never commit .env.",
      "MODEL_KEY=",
      "",
    ].join("\n"));
  });

  it("round-trips Studio saves into bound project sources and detects concurrent asset edits", async () => {
    const { directory, file } = await project();
    await initializeHarnestProject(file, {
      version: 1,
      harness: "harnest.yaml",
      bindings: [
        { kind: "prompt", component: "prompt", path: "prompts/main.md" },
        { kind: "schema", component: "output", path: "schemas/output.json" },
      ],
      tests: ["tests/main.json"],
      studio: "studio.json",
    }, {
      "prompts/main.md": "Initial {{input}}",
      "schemas/output.json": JSON.stringify({ type: "object" }),
      "tests/main.json": "[]",
      "studio.json": JSON.stringify({ positions: {} }),
    });
    const loaded = await loadSpecFile(directory);
    if (!loaded.ok) throw new Error("fixture did not load");
    const next = structuredClone(loaded.spec);
    next.components.find(({ id }) => id === "prompt")!.config.template = "Edited prompt {{input}}";
    next.components.find(({ id }) => id === "output")!.config.schema = {
      type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false,
    };
    next.tests = [{ id: "saved", input: "hello", assertion: { type: "includes", value: "hello" } }];
    next.studio = { positions: { output: { x: 30, y: 40 } } };
    await saveHarnestProjectSpec(directory, next);
    const roundTrip = await loadSpecFile(file);
    expect(roundTrip).toMatchObject({ ok: true, spec: next });
    await expect(readFile(join(directory, ".harnest", "prompts", "main.md"), "utf8"))
      .resolves.toBe("Edited prompt {{input}}");

    const opened = await readPortableProjectTextFile(file, ".harnest/prompts/main.md");
    const edited = await writePortableProjectTextFile(file, opened.archivePath, "Asset editor {{input}}", opened.sha256);
    expect(edited.content).toBe("Asset editor {{input}}");
    await expect(writePortableProjectTextFile(file, opened.archivePath, "stale {{input}}", opened.sha256))
      .rejects.toThrow("changed since it was opened");
  });

  it("prunes bindings when a bound component is deleted and preserves its source file", async () => {
    const { directory, file } = await project();
    await initializeHarnestProject(file, {
      version: 1,
      harness: "harnest.yaml",
      bindings: [{ kind: "prompt", component: "prompt", path: "prompts/main.md" }],
    }, { "prompts/main.md": "Preserve this source {{input}}" });
    const loaded = await loadSpecFile(file);
    if (!loaded.ok) throw new Error("fixture did not load");
    const next = structuredClone(loaded.spec);
    next.components = next.components.filter(({ id }) => id !== "prompt");
    await saveHarnestProjectSpec(file, next);
    const reopened = await loadSpecFile(file);
    expect(reopened).toMatchObject({ ok: true, spec: next });
    await expect(readFile(join(directory, ".harnest", "prompts", "main.md"), "utf8"))
      .resolves.toBe("Preserve this source {{input}}");
    await expect(readFile(join(directory, ".harnest", "project.json"), "utf8"))
      .resolves.not.toContain('"component": "prompt"');
  });

  it("creates, binds, conflict-checks, unbinds, and deletes portable project sources", async () => {
    const { file } = await project();
    await initializeHarnestProject(file, { version: 1, harness: "harnest.yaml" });
    const created = await createPortableProjectTextFile(file, ".harnest/context/new.md", "New context\n");
    expect(created.content).toBe("New context\n");
    await expect(createPortableProjectTextFile(file, created.archivePath, "duplicate"))
      .rejects.toThrow("already exists");
    await bindHarnestProjectAsset(file, { kind: "context", component: "knowledge" }, created.archivePath);
    const bound = await loadSpecFile(file);
    expect(bound.ok && bound.spec.components.find(({ id }) => id === "knowledge")?.config).toMatchObject({
      source: "file", path: ".harnest/context/new.md",
    });
    await expect(deletePortableProjectFile(file, created.archivePath, created.sha256))
      .rejects.toThrow("Unbind");
    await bindHarnestProjectAsset(file, { kind: "context", component: "knowledge" });
    await deletePortableProjectFile(file, created.archivePath, created.sha256);
    expect((await listPortableProjectFiles(file)).some(({ archivePath }) => archivePath === created.archivePath)).toBe(false);
  });
});
