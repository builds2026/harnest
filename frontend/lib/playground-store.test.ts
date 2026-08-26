import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { FilePlaygroundStore } from "./playground-store";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("FilePlaygroundStore", () => {
  it("compacts evicted conversation turns into a private typed checkpoint", async () => {
    const project = await mkdtemp(join(tmpdir(), "harnest-playground-checkpoint-"));
    roots.push(project);
    const store = new FilePlaygroundStore(project);
    const created = await store.create();
    const now = new Date().toISOString();
    await store.append(created.id, Array.from({ length: 202 }, (_, index) => ({
      id: `message-${index}`,
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: index === 0 ? "Immutable original objective" : `turn ${index}`,
      createdAt: now,
      ...(index === 1 ? { runId: "run_evidence", finishReason: "stop" } : {}),
    })));
    const session = await store.get(created.id);
    expect(session.messages).toHaveLength(200);
    expect("checkpoint" in session).toBe(false);
    await expect(store.checkpoint(created.id)).resolves.toMatchObject({
      originalRequest: "Immutable original objective",
      decisions: ["turn 1"],
      evidence: ["run:run_evidence"],
      currentResult: "turn 1",
      compactedMessages: 2,
    });
  });

  it("deduplicates uploads, stages only selected files, and indexes sandbox artifacts", async () => {
    const project = await mkdtemp(join(tmpdir(), "harnest-playground-"));
    roots.push(project);
    const store = new FilePlaygroundStore(project);
    const created = await store.create();
    const first = await store.upload(created.id, {
      name: "../input.csv",
      mimeType: "text/csv",
      content: Buffer.from("value\n42\n"),
    });
    const duplicate = await store.upload(created.id, {
      name: "copy.csv",
      mimeType: "text/csv",
      content: Buffer.from("value\n42\n"),
    });
    const unused = await store.upload(created.id, {
      name: "unused.txt",
      mimeType: "text/plain",
      content: Buffer.from("do not stage"),
    });
    expect(duplicate.id).toBe(first.id);
    expect(first.name).toBe("input.csv");
    expect((await store.get(created.id)).activeFileIds).toContain(first.id);

    await store.setActiveFiles(created.id, [first.id]);
    await store.append(created.id, [{
      id: "message-1",
      role: "user",
      content: "Analyze this file",
      createdAt: new Date().toISOString(),
      fileIds: [first.id],
    }, {
      id: "message-2",
      role: "assistant",
      content: "I can read it",
      createdAt: new Date().toISOString(),
    }, {
      id: "message-3",
      role: "user",
      content: "Read it again",
      createdAt: new Date().toISOString(),
    }]);
    expect((await store.get(created.id)).activeFileIds).toEqual([first.id]);
    const workspace = await store.prepareWorkspace(created.id);
    expect(workspace.files.map(({ id }) => id)).toEqual([first.id]);
    expect(await readFile(join(workspace.inputDirectory, `${first.id}.csv`), "utf8")).toBe("value\n42\n");
    await mkdir(join(workspace.outputDirectory, "reports"));
    await writeFile(join(workspace.outputDirectory, "reports", "summary.json"), "{\"total\":42}");
    await expect(store.workspaceFiles(created.id, workspace.workspaceId)).resolves.toEqual([
      expect.objectContaining({ name: "summary.json", source: "sandbox", sandboxPath: "/mnt/output/reports/summary.json" }),
    ]);
    const artifacts = await store.finalizeWorkspace(created.id, workspace.workspaceId, "run_test");
    expect(artifacts).toEqual([expect.objectContaining({ name: "summary.json", source: "artifact", runId: "run_test" })]);
    const artifact = artifacts[0];
    if (!artifact) throw new Error("artifact was not indexed");
    await expect(store.content(created.id, artifact.id)).resolves.toMatchObject({ content: Buffer.from("{\"total\":42}") });

    await store.removeFile(created.id, unused.id);
    expect((await store.files(created.id)).some(({ id }) => id === unused.id)).toBe(false);
    await store.cleanupWorkspace(created.id, workspace.workspaceId);

    const nextWorkspace = await store.prepareWorkspace(created.id);
    expect(nextWorkspace.files.map(({ id }) => id)).toEqual([first.id]);
    expect(await readFile(join(nextWorkspace.inputDirectory, `${first.id}.csv`), "utf8")).toBe("value\n42\n");
    await store.cleanupWorkspace(created.id, nextWorkspace.workspaceId);
    await store.delete(created.id);
    expect(await store.list()).toEqual([]);
  });
});
