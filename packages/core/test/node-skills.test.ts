import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  NodeSkillStore,
  SkillStoreError,
  skillInstallSourceKey,
  type GitSkillInstallSource,
} from "../src/node-skills.js";

const skillDocument = (
  name: string,
  description: string,
  body = "# Instructions\n\nDo the bounded thing.\n",
): string => `---
name: ${name}
description: ${description}
metadata:
  harnest-tools: http.request, file.read
  harnest-connections: provider-main
  harnest-permissions: filesystem:read
---
${body}`;

async function createSkill(
  base: string,
  namespace: "agents" | "harnest",
  name: string,
  description: string,
  body?: string,
): Promise<string> {
  const directory = join(base, `.${namespace}`, "skills", name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), skillDocument(name, description, body), "utf8");
  return directory;
}

async function workspace(): Promise<{ root: string; project: string; user: string }> {
  const root = await mkdtemp(join(tmpdir(), "harnest-skills-"));
  const project = join(root, "project");
  const user = join(root, "user");
  await Promise.all([mkdir(project), mkdir(user)]);
  return { root, project, user };
}

describe("NodeSkillStore", () => {
  it("discovers metadata only with deterministic project/user and namespace precedence", async () => {
    const fixture = await workspace();
    try {
      await createSkill(fixture.user, "agents", "shared-skill", "user agents");
      await createSkill(fixture.user, "harnest", "shared-skill", "user harnest");
      await createSkill(fixture.project, "agents", "shared-skill", "project agents");
      await createSkill(
        fixture.project,
        "harnest",
        "shared-skill",
        "project harnest",
        `# Body\n${"x".repeat(4_096)}`,
      );
      const store = new NodeSkillStore({
        projectDirectory: fixture.project,
        userDirectory: fixture.user,
        maxFrontmatterBytes: 2_048,
        maxSkillBytes: 256,
      });

      const catalog = await store.catalog();
      expect(catalog.skills).toHaveLength(1);
      expect(catalog.skills[0]).toMatchObject({
        name: "shared-skill",
        description: "project harnest",
        scope: "project",
        namespace: "harnest",
        descriptor: {
          requirements: {
            tools: ["http.request", "file.read"],
            connections: ["provider-main"],
            permissions: ["filesystem:read"],
          },
        },
      });
      expect(catalog.warnings.filter((warning) => warning.includes("shadowed"))).toHaveLength(3);
      await expect(store.activate("shared-skill")).rejects.toMatchObject({ code: "SKILL_READ_LIMIT" });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("loads only a requested contained resource and requires hash-bound script approval", async () => {
    const fixture = await workspace();
    try {
      const directory = await createSkill(fixture.project, "agents", "resource-skill", "Resources");
      await Promise.all([
        mkdir(join(directory, "references")),
        mkdir(join(directory, "scripts")),
      ]);
      await writeFile(join(directory, "references", "guide.md"), "guide", "utf8");
      await writeFile(join(directory, "scripts", "run.mjs"), "export default 1;", "utf8");
      const denied = new NodeSkillStore({
        projectDirectory: fixture.project,
        userDirectory: fixture.user,
      });

      await expect(denied.loadResource("resource-skill", "references/guide.md"))
        .resolves.toMatchObject({ content: "guide", script: false, trusted: false, bytes: 5 });
      await expect(denied.loadResource("resource-skill", "../outside.txt"))
        .rejects.toMatchObject({ code: "SKILL_RESOURCE_INVALID" });
      await expect(denied.loadResource("resource-skill", "scripts/run.mjs"))
        .rejects.toMatchObject({ code: "SKILL_SCRIPT_APPROVAL_REQUIRED" });

      const authorizeScript = vi.fn(async ({ resource, sha256 }) =>
        resource === "scripts/run.mjs" && /^sha256-[a-f0-9]{64}$/.test(sha256));
      const approved = new NodeSkillStore({
        projectDirectory: fixture.project,
        userDirectory: fixture.user,
        authorizeScript,
      });
      await expect(approved.loadResource("resource-skill", "scripts/run.mjs"))
        .resolves.toMatchObject({ content: "export default 1;", script: true, trusted: true });
      expect(authorizeScript).toHaveBeenCalledOnce();
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("installs a local folder atomically with provenance and content hash", async () => {
    const fixture = await workspace();
    try {
      const source = join(fixture.root, "local-skill");
      await mkdir(join(source, "references"), { recursive: true });
      await writeFile(join(source, "SKILL.md"), skillDocument("local-skill", "Local install"), "utf8");
      await writeFile(join(source, "references", "note.md"), "note", "utf8");
      await writeFile(join(source, ".harnest-provenance.json"), JSON.stringify({ kind: "git", commit: "spoof" }), "utf8");
      const store = new NodeSkillStore({
        projectDirectory: fixture.project,
        userDirectory: fixture.user,
      });

      const installed = await store.install(
        { kind: "local", directory: source },
        { scope: "project", namespace: "harnest" },
      );
      expect(installed).toMatchObject({
        name: "local-skill",
        scope: "project",
        namespace: "harnest",
        provenance: { kind: "local" },
      });
      expect(installed.provenance.contentHash).toMatch(/^sha256-[a-f0-9]{64}$/);
      expect(JSON.parse(await readFile(join(installed.directory, ".harnest-provenance.json"), "utf8")))
        .toMatchObject({ kind: "local", contentHash: installed.provenance.contentHash });
      await writeFile(join(installed.directory, "references", "note.md"), "tampered", "utf8");
      const tampered = (await store.catalog()).skills.find(({ name }) => name === "local-skill");
      expect(tampered).toMatchObject({ provenance: installed.provenance, provenanceVerified: false });
      await expect(store.activate("local-skill")).rejects.toMatchObject({ code: "SKILL_CATALOG_INVALID" });
      await expect(store.loadResource("local-skill", "references/note.md"))
        .rejects.toMatchObject({ code: "SKILL_CATALOG_INVALID" });
      await expect(store.install(
        { kind: "local", directory: source },
        { scope: "project", namespace: "harnest" },
      )).rejects.toMatchObject({ code: "SKILL_INSTALL_EXISTS" });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("defers bounded provenance verification until activation", async () => {
    const fixture = await workspace();
    try {
      const source = join(fixture.root, "bounded-skill");
      await mkdir(join(source, "references", "deep", "level"), { recursive: true });
      await writeFile(join(source, "SKILL.md"), skillDocument("bounded-skill", "Bounded provenance"), "utf8");
      await writeFile(join(source, "references", "large.md"), "x".repeat(256), "utf8");
      await writeFile(join(source, "references", "deep", "level", "note.md"), "note", "utf8");
      const installer = new NodeSkillStore({
        projectDirectory: fixture.project,
        userDirectory: fixture.user,
      });
      await installer.install(
        { kind: "local", directory: source },
        { scope: "project", namespace: "harnest" },
      );

      const limits = [
        { maxProvenanceFiles: 1 },
        { maxProvenanceTotalBytes: 32 },
        { maxProvenanceFileBytes: 32 },
        { maxProvenanceDepth: 1 },
      ] as const;
      for (const limit of limits) {
        const store = new NodeSkillStore({
          projectDirectory: fixture.project,
          userDirectory: fixture.user,
          ...limit,
        });
        const catalog = await store.catalog();
        expect(catalog.skills).toContainEqual(expect.objectContaining({
          name: "bounded-skill",
          description: "Bounded provenance",
          provenanceVerified: false,
        }));
        expect(catalog.warnings).not.toContainEqual(expect.stringContaining("provenance verification"));
        await expect(store.activate("bounded-skill")).rejects.toMatchObject({ code: "SKILL_READ_LIMIT" });
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects invalid install scope and namespace before creating directories", async () => {
    const fixture = await workspace();
    try {
      const source = join(fixture.root, "scope-skill");
      await mkdir(source);
      await writeFile(join(source, "SKILL.md"), skillDocument("scope-skill", "Scope"), "utf8");
      const store = new NodeSkillStore({ projectDirectory: fixture.project, userDirectory: fixture.user });
      await expect(store.install(
        { kind: "local", directory: source },
        { scope: "project", namespace: "../../../outside" } as never,
      )).rejects.toMatchObject({ code: "SKILL_INSTALL_INVALID" });
      await expect(readFile(join(fixture.root, "outside", "SKILL.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("fails closed for unpinned or unapproved Git/package sources", async () => {
    const fixture = await workspace();
    try {
      const store = new NodeSkillStore({
        projectDirectory: fixture.project,
        userDirectory: fixture.user,
      });
      await expect(store.install(
        { kind: "git", repository: "https://example.com/skill.git", commit: "main" },
        { scope: "project" },
      )).rejects.toMatchObject({ code: "SKILL_INSTALL_INVALID" });
      await expect(store.install(
        { kind: "package", package: "safe-skill", version: "latest", integrity: "missing" },
        { scope: "project" },
      )).rejects.toMatchObject({ code: "SKILL_INSTALL_INVALID" });

      const source: GitSkillInstallSource = {
        kind: "git",
        repository: "https://example.com/skill.git",
        commit: "a".repeat(40),
      };
      await expect(store.install(source, { scope: "project" }))
        .rejects.toMatchObject({ code: "SKILL_INSTALL_APPROVAL_REQUIRED" });
      await expect(store.install(source, {
        scope: "project",
        approval: { sourceKey: skillInstallSourceKey(source) },
      })).rejects.toMatchObject({ code: "SKILL_INSTALL_PROVIDER_REQUIRED" });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("preserves pinned remote provenance when an approved materializer is configured", async () => {
    const fixture = await workspace();
    try {
      const materialized = join(fixture.root, "remote-skill");
      await mkdir(materialized);
      await writeFile(
        join(materialized, "SKILL.md"),
        skillDocument("remote-skill", "Pinned remote"),
        "utf8",
      );
      const source: GitSkillInstallSource = {
        kind: "git",
        repository: "https://example.com/remote-skill.git",
        commit: "b".repeat(40),
      };
      const materializeRemote = vi.fn(async () => materialized);
      const store = new NodeSkillStore({
        projectDirectory: fixture.project,
        userDirectory: fixture.user,
        materializeRemote,
      });
      const installed = await store.install(source, {
        scope: "project",
        approval: { sourceKey: skillInstallSourceKey(source) },
      });
      expect(installed.provenance).toMatchObject({
        kind: "git",
        repository: source.repository,
        commit: source.commit,
      });
      expect(materializeRemote).toHaveBeenCalledWith(source);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("uses stable structured errors", () => {
    const error = new SkillStoreError("SKILL_NOT_FOUND", "missing", { skill: "missing" });
    expect(error).toMatchObject({ name: "SkillStoreError", code: "SKILL_NOT_FOUND", skill: "missing" });
  });
});
