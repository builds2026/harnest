import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/api-server", async () => import("../../../../lib/api-server"));
vi.mock("@/lib/server", async () => import("../../../../lib/server"));

import { harnessFile } from "../../../../lib/server";
import { POST } from "./route";

const originalFile = process.env.HARNEST_FILE;

afterEach(() => {
  if (originalFile === undefined) delete process.env.HARNEST_FILE;
  else process.env.HARNEST_FILE = originalFile;
  void harnessFile();
});

describe("project folder import", () => {
  it("opens a browser-selected project as a managed, secret-filtered workspace", async () => {
    const base = await mkdtemp(join(tmpdir(), "harnest-project-import-"));
    const baseHarness = join(base, "harnest.yaml");
    process.env.HARNEST_FILE = baseHarness;
    await writeFile(baseHarness, "version: '0.1'\ncomponents: []\nconnections: []\nentrypoint: missing\n", "utf8");
    const yaml = `version: '0.1'
components:
  - id: prompt
    type: prompt
    config:
      template: Hello
connections: []
entrypoint: prompt
`;
    const form = new FormData();
    form.set("name", "selected-project");
    form.set("paths", JSON.stringify(["harnest.yaml", "src/index.ts", ".env", ".harnest/context/guide.md"]));
    form.append("file", new File([yaml], "harnest.yaml", { type: "application/yaml" }));
    form.append("file", new File(["export const answer = 42;\n"], "index.ts", { type: "text/typescript" }));
    form.append("file", new File(["SECRET=hidden\n"], ".env", { type: "text/plain" }));
    form.append("file", new File(["portable context\n"], "guide.md", { type: "text/markdown" }));
    try {
      const response = await POST(new Request("http://127.0.0.1/api/project/import", {
        method: "POST",
        headers: { host: "127.0.0.1", origin: "http://127.0.0.1", "content-length": "100000" },
        body: form,
      }));
      const payload = await response.json() as { project: { managed: boolean; name?: string }; error?: unknown };
      expect(response.status, JSON.stringify(payload.error)).toBe(201);
      expect(payload.project).toMatchObject({ managed: true, name: "selected-project" });
      const importedHarness = harnessFile();
      const importedRoot = dirname(importedHarness);
      expect(importedHarness).toBe(join(importedRoot, "harnest.yaml"));
      await expect(readFile(join(importedRoot, "src", "index.ts"), "utf8"))
        .resolves.toBe("export const answer = 42;\n");
      await expect(readFile(join(importedRoot, ".harnest", "context", "guide.md"), "utf8"))
        .resolves.toBe("portable context\n");
      await expect(stat(join(importedRoot, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(importedRoot, ".harnest", "project.json"), "utf8"))
        .resolves.toContain('"harness": "harnest.yaml"');
      delete (globalThis as typeof globalThis & { __harnestStudioActiveProject?: unknown }).__harnestStudioActiveProject;
      expect(harnessFile()).toBe(importedHarness);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
