import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringifySpec } from "@harnestai/core";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/api-server", async () => import("../../../lib/api-server"));
vi.mock("@/lib/default-spec", async () => import("../../../lib/default-spec"));
vi.mock("@/lib/harness-version-store", async () => import("../../../lib/harness-version-store"));
vi.mock("@/lib/runtime-config", async () => import("../../../lib/runtime-config"));
vi.mock("@/lib/server", async () => import("../../../lib/server"));

import { GET, PUT } from "./route";
import { FileHarnessVersionStore } from "@/lib/harness-version-store";

const request = (yaml: string, baseYaml: string) => new Request("http://127.0.0.1:3000/api/spec", {
  method: "PUT",
  headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "content-type": "application/json" },
  body: JSON.stringify({ yaml, baseYaml, clientRevision: 1, saveSessionId: crypto.randomUUID() }),
});

describe("Studio spec save", () => {
  const previous = process.env.HARNEST_FILE;
  afterEach(() => { if (previous === undefined) delete process.env.HARNEST_FILE; else process.env.HARNEST_FILE = previous; });

  it("rejects a stale tab instead of overwriting a newer save", async () => {
    const project = await mkdtemp(join(tmpdir(), "harnest-spec-save-"));
    process.env.HARNEST_FILE = join(project, "harnest.yaml");
    try {
      const base = await (await GET()).json() as { yaml: string };
      const first = stringifySpec({ version: "0.2", components: [{ id: "first", type: "prompt", config: { template: "first" } }], connections: [], entrypoint: "first" });
      expect((await PUT(request(first, base.yaml))).status).toBe(200);
      const stale = stringifySpec({ version: "0.2", components: [{ id: "stale", type: "prompt", config: { template: "stale" } }], connections: [], entrypoint: "stale" });
      const conflict = await PUT(request(stale, base.yaml));
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({ error: { code: "SPEC_CONFLICT" } });
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it("reports the current read-only Studio host capability policy", async () => {
    const project = await mkdtemp(join(tmpdir(), "harnest-policy-view-"));
    const previousModules = process.env.HARNEST_ALLOW_MODULES;
    process.env.HARNEST_FILE = join(project, "harnest.yaml");
    delete process.env.HARNEST_ALLOW_MODULES;
    process.env.HARNEST_ALLOW_FILES = "1";
    process.env.HARNEST_CONTEXT_ROOTS = "docs,knowledge";
    try {
      expect(await (await GET()).json()).toMatchObject({
        capabilityPolicy: { allowFiles: true, allowModules: false, contextRoots: ["docs", "knowledge"] },
      });
    } finally {
      delete process.env.HARNEST_ALLOW_FILES;
      delete process.env.HARNEST_CONTEXT_ROOTS;
      if (previousModules === undefined) delete process.env.HARNEST_ALLOW_MODULES;
      else process.env.HARNEST_ALLOW_MODULES = previousModules;
      await rm(project, { recursive: true, force: true });
    }
  });

  it("persists layout-only saves without adding version-history entries", async () => {
    const project = await mkdtemp(join(tmpdir(), "harnest-layout-save-"));
    process.env.HARNEST_FILE = join(project, "harnest.yaml");
    try {
      const base = await (await GET()).json() as { yaml: string };
      const semantic = stringifySpec({
        version: "0.2",
        components: [{ id: "prompt", type: "prompt", config: { template: "hello" } }],
        connections: [],
        entrypoint: "prompt",
        studio: { positions: { prompt: { x: 10, y: 20 } } },
      });
      expect((await PUT(request(semantic, base.yaml))).status).toBe(200);
      const saved = await (await GET()).json() as { yaml: string };
      const store = new FileHarnessVersionStore(process.env.HARNEST_FILE);
      const before = await store.list();
      const layout = stringifySpec({
        version: "0.2",
        components: [{ id: "prompt", type: "prompt", config: { template: "hello" } }],
        connections: [],
        entrypoint: "prompt",
        studio: { positions: { prompt: { x: 300, y: 400 } } },
      });

      expect((await PUT(request(layout, saved.yaml))).status).toBe(200);
      expect(await store.list()).toHaveLength(before.length);
      expect((await (await GET()).json() as { yaml: string }).yaml).toContain("x: 300");
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});
