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
    const payload = await index.json() as { files: Array<{ path: string; sha256: string }> };
    const prompt = payload.files.find(({ path }) => path === ".harnest/prompts/main.md");
    expect(prompt).toBeTruthy();
    const opened = await GET(new Request("http://127.0.0.1:3000/api/project?path=.harnest%2Fprompts%2Fmain.md"));
    await expect(opened.json()).resolves.toMatchObject({ file: { content: "Initial {{input}}" } });

    const save = (sha256: string, content: string) => PUT(new Request("http://127.0.0.1:3000/api/project", {
      method: "PUT",
      headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "content-type": "application/json" },
      body: JSON.stringify({ path: prompt!.path, sha256, content }),
    }));
    const updated = await save(prompt!.sha256, "Updated {{input}}");
    expect(updated.status).toBe(200);
    await expect(readFile(join(root, ".harnest", "prompts", "main.md"), "utf8")).resolves.toBe("Updated {{input}}");
    const loaded = await loadSpecFile(root);
    expect(loaded.ok && loaded.spec.components[0]?.config).toMatchObject({ template: "Updated {{input}}" });
    expect((await save(prompt!.sha256, "stale {{input}}")).status).toBe(409);
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
    const created = await createdResponse.json() as { file: { archivePath: string; sha256: string } };

    expect((await POST(request({ action: "bind", kind: "context", component: "knowledge", path: created.file.archivePath }))).status).toBe(200);
    const blocked = await DELETE(new Request("http://127.0.0.1:3000/api/project", {
      method: "DELETE",
      headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "content-type": "application/json" },
      body: JSON.stringify({ path: created.file.archivePath, sha256: created.file.sha256 }),
    }));
    expect(blocked.status).toBe(409);

    expect((await POST(request({ action: "bind", kind: "context", component: "knowledge" }))).status).toBe(200);
    const removed = await DELETE(new Request("http://127.0.0.1:3000/api/project", {
      method: "DELETE",
      headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "content-type": "application/json" },
      body: JSON.stringify({ path: created.file.archivePath, sha256: created.file.sha256 }),
    }));
    expect(removed.status).toBe(200);
    await expect(readFile(join(root, ".harnest", "context", "brief.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
