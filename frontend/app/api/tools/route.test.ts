import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ root: "" }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/api-server", async () => import("../../../lib/api-server"));
vi.mock("@/lib/default-spec", () => ({ EMPTY_SPEC: { version: "0.2", components: [], connections: [], entrypoint: "" } }));
vi.mock("@/lib/server", async () => {
  const { NodeToolStore } = await import("@harnestai/core/node");
  return {
    runtimeResourcesFor: async () => ({
      toolStore: new NodeToolStore({
        projectDirectory: state.root,
        capabilities: {
          authorizeNetworkHost: () => true,
          fetch: async () => Response.json({ ok: true }),
        },
      }),
      services: { close: async () => undefined },
    }),
  };
});

import { DELETE, GET, POST } from "./route";

const roots: string[] = [];
const mutation = (body: unknown, method = "POST") => new Request("http://127.0.0.1:3000/api/tools", {
  method,
  headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "content-type": "application/json" },
  body: JSON.stringify(body),
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("custom Tool API", () => {
  it("lists, saves, tests, imports, and deletes without requiring a Connection", async () => {
    state.root = await mkdtemp(join(tmpdir(), "harnest-tools-route-"));
    roots.push(state.root);
    const manifest = {
      manifestVersion: "1", id: "custom.status", label: "Status", description: "Read status.",
      category: "Custom", risk: "external", kind: "http", source: "custom",
      inputSchema: { type: "object", additionalProperties: false },
      request: { method: "GET", url: "https://api.example.test/status", response: "json" },
    };

    await expect((await GET()).json()).resolves.toMatchObject({ tools: [] });
    const saved = await POST(mutation({ action: "save", manifest }));
    expect(saved.status).toBe(201);
    await expect((await GET()).json()).resolves.toMatchObject({ tools: [{ id: "custom.status" }] });

    const tested = await POST(mutation({ action: "test", manifest, input: {} }));
    expect(tested.status).toBe(200);
    await expect(tested.json()).resolves.toMatchObject({ ok: true, output: { ok: true } });

    await writeFile(join(state.root, "openapi.yaml"), [
      "openapi: 3.0.3",
      "info: { title: Fixture, version: 1.0.0 }",
      "servers: [{ url: https://api.example.test }]",
      "paths:",
      "  /items:",
      "    get:",
      "      operationId: listItems",
      "      responses: { '200': { description: ok } }",
      "",
    ].join("\n"));
    const imported = await POST(mutation({ action: "import-openapi", document: "openapi.yaml" }));
    expect(imported.status).toBe(201);
    await expect(imported.json()).resolves.toMatchObject({ tools: [{ operationId: "listItems" }] });

    expect((await DELETE(mutation({ id: "custom.status" }, "DELETE"))).status).toBe(204);
    const catalog = await (await GET()).json() as { tools: Array<{ id: string }> };
    expect(catalog.tools.map(({ id }) => id)).not.toContain("custom.status");
  });
});
