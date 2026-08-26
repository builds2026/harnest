import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSpec, stringifySpec, type HarnessSpecV02 } from "@harnestai/core";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/api-server", async () => import("../../../lib/api-server"));
vi.mock("@/lib/harness-version-store", async () => import("../../../lib/harness-version-store"));
vi.mock("@/lib/server", async () => import("../../../lib/server"));

import { GET, POST } from "./route";

const roots: string[] = [];
const originalFile = process.env.HARNEST_FILE;

afterEach(async () => {
  if (originalFile === undefined) delete process.env.HARNEST_FILE;
  else process.env.HARNEST_FILE = originalFile;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const spec = (template: string): HarnessSpecV02 => ({
  version: "0.2",
  components: [{ id: "prompt", type: "prompt", config: { template } }],
  connections: [],
  entrypoint: "prompt",
});

describe("Harness version API", () => {
  it("compares versions and preserves the current state before restore", async () => {
    const root = await mkdtemp(join(tmpdir(), "harnest-version-route-"));
    roots.push(root);
    const file = join(root, "harnest.yaml");
    process.env.HARNEST_FILE = file;
    const firstYaml = stringifySpec(spec("first {{input}}"));
    const secondYaml = stringifySpec(spec("second {{input}}"));
    await writeFile(file, firstYaml);

    const firstIndex = await GET(new Request("http://127.0.0.1:3000/api/versions"));
    const firstPayload = await firstIndex.json() as { versions: Array<{ id: string }> };
    const firstId = firstPayload.versions[0]?.id;
    expect(firstId).toBeTruthy();

    await writeFile(file, secondYaml);
    await GET(new Request("http://127.0.0.1:3000/api/versions"));
    const comparison = await GET(new Request(`http://127.0.0.1:3000/api/versions?from=${firstId}&to=current`));
    expect(await comparison.json()).toMatchObject({ diff: { components: { changed: ["root/prompt"] } } });

    const restored = await POST(new Request("http://127.0.0.1:3000/api/versions", {
      method: "POST",
      headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "content-type": "application/json" },
      body: JSON.stringify({ id: firstId, currentYaml: secondYaml }),
    }));
    expect(restored.status).toBe(200);
    const restoredSpec = parseSpec(await readFile(file, "utf8"));
    expect(restoredSpec.ok && restoredSpec.spec.components[0]?.config).toMatchObject({ template: "first {{input}}" });
    const payload = await restored.json() as { versions: Array<{ summary: string }> };
    expect(payload.versions.some(({ summary }) => summary.includes("State preserved before restoring"))).toBe(true);
    expect(payload.versions.some(({ summary }) => summary.includes("Restored"))).toBe(true);
  });
});
