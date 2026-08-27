import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeHarnestProject, loadSpecFile, saveSpecFile } from "@harnestai/core/node";
import type { HarnessSpecV02 } from "@harnestai/core";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/api-server", async () => import("../../../lib/api-server"));
vi.mock("@/lib/server", async () => import("../../../lib/server"));

import { DELETE, GET, POST, PUT } from "./route";

const roots: string[] = [];
const originalFile = process.env.HARNEST_FILE;

afterEach(async () => {
  if (originalFile === undefined) delete process.env.HARNEST_FILE;
  else process.env.HARNEST_FILE = originalFile;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("portable project file API", () => {
  it("lists, opens, saves, and conflict-checks bound sources", async () => {
    const root = await mkdtemp(join(tmpdir(), "harnest-project-route-"));
    roots.push(root);
    const file = join(root, "harnest.yaml");
    process.env.HARNEST_FILE = file;
    const spec: HarnessSpecV02 = {
      version: "0.2",
      components: [{ id: "prompt", type: "prompt", config: { template: "Fallback {{input}}" } }],
      connections: [],
      entrypoint: "prompt",
    };
    await saveSpecFile(file, spec);
    await initializeHarnestProject(file, {
      version: 1,
      harness: "harnest.yaml",
      bindings: [{ kind: "prompt", component: "prompt", path: "prompts/main.md" }],
    }, { "prompts/main.md": "Initial {{input}}" });

    const index = await GET(new Request("http://127.0.0.1:3000/api/project"));
    const payload = await index.json() as { project: { managed: boolean; harness: string }; files: Array<{ path: string; sha256: string; previewable: boolean; editable: boolean }> };
    expect(payload.project).toMatchObject({ managed: false, harness: "harnest.yaml" });
    const manifest = payload.files.find(({ path }) => path === ".harnest/project.json");
    expect(manifest).toMatchObject({ previewable: true, editable: false });
    const prompt = payload.files.find(({ path }) => path === ".harnest/prompts/main.md");
    expect(prompt).toBeTruthy();
    const opened = await GET(new Request("http://127.0.0.1:3000/api/project?path=.harnest%2Fprompts%2Fmain.md"));
    const openedPayload = await opened.json() as { file: { path: string; content: string; sha256: string } };
    expect(openedPayload).toMatchObject({ file: { path: ".harnest/prompts/main.md", content: "Initial {{input}}" } });
    expect(openedPayload.file.path).not.toContain(root);

    const save = (path: string, sha256: string, content: string) => PUT(new Request("http://127.0.0.1:3000/api/project", {
      method: "PUT",
      headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "content-type": "application/json" },
      body: JSON.stringify({ path, sha256, content }),
    }));
    const updated = await save(prompt!.path, openedPayload.file.sha256, "Updated {{input}}");
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({ file: { path: ".harnest/prompts/main.md" } });
    await expect(readFile(join(root, ".harnest", "prompts", "main.md"), "utf8")).resolves.toBe("Updated {{input}}");
    const loaded = await loadSpecFile(root);
    expect(loaded.ok && loaded.spec.components[0]?.config).toMatchObject({ template: "Updated {{input}}" });
    expect((await save(prompt!.path, prompt!.sha256, "stale {{input}}")).status).toBe(409);

    const openedManifest = await GET(new Request("http://127.0.0.1:3000/api/project?path=.harnest%2Fproject.json"));
    const manifestPayload = await openedManifest.json() as { file: { content: string; sha256: string; previewable: boolean; editable: boolean } };
    expect(manifestPayload.file).toMatchObject({ previewable: true, editable: false });
    expect((await save(".harnest/project.json", manifestPayload.file.sha256, "{}\n")).status).toBe(422);
    await expect(readFile(join(root, ".harnest", "project.json"), "utf8")).resolves.toBe(manifestPayload.file.content);
  });

  it("creates, binds, unbinds, and safely deletes portable project sources", async () => {
    const root = await mkdtemp(join(tmpdir(), "harnest-project-actions-"));
    roots.push(root);
    const file = join(root, "harnest.yaml");
    process.env.HARNEST_FILE = file;
    await saveSpecFile(file, {
      version: "0.2",
      components: [{ id: "knowledge", type: "context", config: { source: "inline", value: "fallback" } }],
      connections: [],
      entrypoint: "knowledge",
    });
    await initializeHarnestProject(file, { version: 1, harness: "harnest.yaml", bindings: [] });
    const request = (body: unknown) => new Request("http://127.0.0.1:3000/api/project", {
      method: "POST",
      headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const createdResponse = await POST(request({ action: "create", path: ".harnest/context/brief.md", content: "Ground truth" }));
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as { file: { path: string; sha256: string } };
    expect(created.file.path).toBe(".harnest/context/brief.md");

    expect((await POST(request({ action: "bind", kind: "context", component: "knowledge", path: created.file.path }))).status).toBe(200);
    const blocked = await DELETE(new Request("http://127.0.0.1:3000/api/project", {
      method: "DELETE",
      headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "content-type": "application/json" },
      body: JSON.stringify({ path: created.file.path, sha256: created.file.sha256 }),
    }));
    expect(blocked.status).toBe(409);

    expect((await POST(request({ action: "bind", kind: "context", component: "knowledge" }))).status).toBe(200);
    const removed = await DELETE(new Request("http://127.0.0.1:3000/api/project", {
      method: "DELETE",
      headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "content-type": "application/json" },
      body: JSON.stringify({ path: created.file.path, sha256: created.file.sha256 }),
    }));
    expect(removed.status).toBe(200);
    await expect(readFile(join(root, ".harnest", "context", "brief.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
