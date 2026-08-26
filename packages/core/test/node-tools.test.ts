import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  BUILTIN_TOOL_MANIFESTS,
  NodeToolStore,
  generateEditableSchema,
  validateStoredToolManifest,
  type HttpCapabilityRequest,
  type HttpEndpointToolManifest,
  type LocalCommandToolManifest,
  type TypeScriptModuleToolManifest,
} from "../src/node-tools.js";
import type { ToolExecutionContext } from "../src/tool.js";

const context: ToolExecutionContext = {
  signal: new AbortController().signal,
  runId: "tool-store-test",
  nodeId: "tool-node",
  iteration: 0,
  resolveSecret: () => undefined,
};

const objectSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

const httpManifest = (): HttpEndpointToolManifest => ({
  manifestVersion: "1",
  id: "custom.lookup",
  label: "Lookup",
  description: "Look up a record through an approved HTTP host.",
  category: "Custom",
  risk: "external",
  source: "custom",
  kind: "http",
  connectionKinds: ["http-api"],
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      query: {
        type: "object",
        properties: { verbose: { type: "boolean" } },
        additionalProperties: false,
      },
      body: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      },
    },
    required: ["path", "body"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
    additionalProperties: false,
  },
  request: {
    method: "POST",
    url: "https://api.example.test/items/{id}",
    path: { id: "/path/id" },
    query: { verbose: "/query/verbose" },
    body: { source: "property", property: "/body" },
    response: "json",
  },
});

async function project(): Promise<string> {
  return mkdtemp(join(tmpdir(), "harnest-tools-"));
}

describe("custom tool manifests and schema generation", () => {
  it("generates a mutable JSON Schema from an example", () => {
    const schema = generateEditableSchema({ query: "harnest", limit: 3, exact: true }, { title: "Search" });
    expect(schema).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: "Search",
      type: "object",
      required: ["query", "limit", "exact"],
      properties: {
        query: { type: "string", example: "harnest" },
        limit: { type: "integer", example: 3 },
        exact: { type: "boolean", example: true },
      },
    });
    schema.title = "Edited in Studio";
    expect(schema.title).toBe("Edited in Studio");
  });

  it("rejects credential fields, secret-like literals, and unknown manifest fields", () => {
    expect(() => generateEditableSchema({ apiKey: "not-stored-here" }))
      .toThrowError(expect.objectContaining({ code: "TOOL_MANIFEST_SECRET" }));
    expect(() => validateStoredToolManifest({ ...httpManifest(), authorization: "Bearer abc" }))
      .toThrowError(expect.objectContaining({ code: "TOOL_MANIFEST_SECRET" }));
    expect(() => validateStoredToolManifest({ ...httpManifest(), unexpected: true }))
      .toThrowError(expect.objectContaining({ code: "TOOL_MANIFEST_INVALID" }));
    for (const header of ["Host", "Proxy-Authorization", "X-Auth-Token", "Content-Length"]) {
      expect(() => validateStoredToolManifest({
        ...httpManifest(),
        request: { ...httpManifest().request, headers: { [header]: "/header" } },
      })).toThrowError(expect.objectContaining({ code: "TOOL_MANIFEST_SECRET" }));
    }
    expect(() => validateStoredToolManifest({
      ...httpManifest(),
      inputSchema: {
        type: "object",
        properties: { password: { type: "string" } },
      },
    })).toThrowError(expect.objectContaining({ code: "TOOL_MANIFEST_SECRET" }));
    expect(() => validateStoredToolManifest({
      ...httpManifest(),
      inputSchema: { type: "string", pattern: "^(a+)+$" },
    })).toThrowError(expect.objectContaining({ code: "TOOL_MANIFEST_INVALID" }));
  });

  it("does not let stored manifests lower execution risk", () => {
    expect(validateStoredToolManifest({ ...httpManifest(), risk: "read" }).risk).toBe("external");
    expect(validateStoredToolManifest({
      manifestVersion: "1",
      id: "custom.shell",
      label: "Shell",
      description: "Run a command",
      inputSchema: { type: "object" },
      kind: "local-command",
      source: "custom",
      risk: "read",
      command: process.execPath,
    }).risk).toBe("destructive");
  });

  it("persists bounded JSON manifests and supports catalog/get/delete", async () => {
    const root = await project();
    try {
      const store = new NodeToolStore({ projectDirectory: root });
      await expect(store.save(httpManifest())).resolves.toMatchObject({ id: "custom.lookup", kind: "http" });
      await expect(store.get("custom.lookup")).resolves.toMatchObject({ request: { method: "POST" } });
      await expect(store.catalog()).resolves.toMatchObject({ tools: [{ id: "custom.lookup" }], warnings: [] });
      const raw = await readFile(join(root, ".harnest", "tools", "custom.lookup.json"), "utf8");
      expect(raw).not.toMatch(/authorization|apiKey|password|token/i);
      await store.delete("custom.lookup");
      await expect(store.get("custom.lookup")).rejects.toMatchObject({ code: "TOOL_MANIFEST_NOT_FOUND" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("custom tool execution capabilities", () => {
  it("executes HTTP with path/query/body mapping through an approved host", async () => {
    const root = await project();
    try {
      const transport = vi.fn(async (_request: HttpCapabilityRequest) => new Response(
        JSON.stringify({ ok: true }),
        { status: 200, headers: { "content-type": "application/json" } },
      ));
      const authorizeNetworkHost = vi.fn(async ({ url }) => url.host === "api.example.test");
      const store = new NodeToolStore({
        projectDirectory: root,
        capabilities: {
          authorizeNetworkHost,
          performHttp: transport,
        },
      });
      const result = await store.execute(httpManifest(), {
        path: { id: "a/b" },
        query: { verbose: true },
        body: { name: "Ada" },
      }, context, { connectionId: "api-main" });
      expect(result).toEqual({ ok: true });
      expect(authorizeNetworkHost).toHaveBeenCalledWith(expect.objectContaining({
        toolId: "custom.lookup",
        method: "POST",
        connectionId: "api-main",
        url: expect.objectContaining({ host: "api.example.test" }),
      }));
      const capabilityRequest = transport.mock.calls[0]?.[0];
      expect(capabilityRequest).toMatchObject({ connectionId: "api-main" });
      expect(capabilityRequest?.request.url).toBe("https://api.example.test/items/a%2Fb?verbose=true");
      expect(capabilityRequest?.request.method).toBe("POST");
      expect(await capabilityRequest?.request.clone().text()).toBe(JSON.stringify({ name: "Ada" }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed without host approval and bounds HTTP output", async () => {
    const root = await project();
    try {
      const input = { path: { id: "1" }, body: { name: "Ada" } };
      await expect(new NodeToolStore({ projectDirectory: root }).execute(httpManifest(), input, context))
        .rejects.toMatchObject({ code: "TOOL_CAPABILITY_REQUIRED" });
      const store = new NodeToolStore({
        projectDirectory: root,
        maxOutputBytes: 16,
        capabilities: {
          authorizeNetworkHost: () => true,
          fetch: (async () => new Response("x".repeat(32))) as typeof fetch,
        },
      });
      await expect(store.execute({ ...httpManifest(), outputSchema: undefined }, input, context))
        .rejects.toMatchObject({ code: "TOOL_OUTPUT_LIMIT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires the host to attest OS isolation before a local command", async () => {
    const root = await project();
    try {
      const authorizeProcess = vi.fn(async () => true);
      const manifest: LocalCommandToolManifest = {
        manifestVersion: "1",
        id: "custom.process",
        label: "Process",
        description: "Run a reviewed process.",
        inputSchema: objectSchema,
        outputSchema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        },
        kind: "local-command",
        source: "custom",
        risk: "destructive",
        command: process.execPath,
        args: ["-e", "process.stdout.write(JSON.stringify({ok:true}))"],
        stdin: "none",
        output: "json",
      };
      const store = new NodeToolStore({
        projectDirectory: root,
        capabilities: { authorizeProcess },
      });
      await expect(store.execute(manifest, {}, context)).resolves.toEqual({ ok: true });
      expect(authorizeProcess).toHaveBeenCalledWith(expect.objectContaining({
        command: process.execPath,
        isolation: "os-sandbox",
      }));
      expect(BUILTIN_TOOL_MANIFESTS.find(({ id }) => id === "builtin.shell")?.description)
        .toContain("no-network container");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("delegates a connected Python runner without requiring host Python", async () => {
    const root = await project();
    try {
      const authorizeProcess = vi.fn(async () => true);
      const executeProcess = vi.fn(async () => ({ stdout: "5\n", stderr: "", exitCode: 0 }));
      const store = new NodeToolStore({
        projectDirectory: root,
        capabilities: { authorizeProcess, executeProcess },
      });
      await expect(store.executeBuiltin("builtin.code-runner", {
        runtime: "python",
        code: "print(2 + 3)",
      }, context, { connectionId: "python-sandbox" })).resolves.toEqual({
        stdout: "5\n", stderr: "", exitCode: 0,
      });
      expect(authorizeProcess).toHaveBeenCalledWith(expect.objectContaining({
        toolId: "builtin.code-runner",
        command: "python",
        connectionId: "python-sandbox",
      }));
      expect(executeProcess).toHaveBeenCalledWith(expect.objectContaining({
        command: "python",
        connectionId: "python-sandbox",
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("terminates a command at its timeout", async () => {
    const root = await project();
    try {
      const manifest: LocalCommandToolManifest = {
        manifestVersion: "1",
        id: "custom.timeout",
        label: "Timeout",
        description: "Fixture timeout.",
        inputSchema: objectSchema,
        kind: "local-command",
        source: "custom",
        command: process.execPath,
        args: ["-e", "setTimeout(() => undefined, 1000)"],
        stdin: "none",
        timeoutMs: 25,
      };
      const store = new NodeToolStore({
        projectDirectory: root,
        capabilities: { authorizeProcess: () => true },
      });
      await expect(store.execute(manifest, {}, context))
        .rejects.toMatchObject({ code: "TOOL_EXECUTION_TIMEOUT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("escalates past a SIGTERM-ignoring command and rejects within a bounded time", async () => {
    const root = await project();
    try {
      const fixture = join(root, "ignore-term.mjs");
      const marker = join(root, "sigterm-received.txt");
      await writeFile(fixture, `import { writeFileSync } from "node:fs";
const marker = process.argv[2];
process.on("SIGTERM", () => writeFileSync(marker, "received", "utf8"));
setInterval(() => undefined, 1_000);
`, "utf8");
      const manifest: LocalCommandToolManifest = {
        manifestVersion: "1",
        id: "custom.ignore-term",
        label: "Ignore SIGTERM",
        description: "Fixture that requires forced termination.",
        inputSchema: objectSchema,
        kind: "local-command",
        source: "custom",
        command: process.execPath,
        args: [fixture, marker],
        stdin: "none",
        timeoutMs: 500,
      };
      const store = new NodeToolStore({
        projectDirectory: root,
        capabilities: { authorizeProcess: () => true },
      });

      const started = performance.now();
      await expect(store.execute(manifest, {}, context))
        .rejects.toMatchObject({ code: "TOOL_EXECUTION_TIMEOUT" });
      expect(performance.now() - started).toBeLessThan(2_500);
      if (process.platform !== "win32") {
        await expect(readFile(marker, "utf8")).resolves.toBe("received");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("delegates TypeScript execution only to an explicit module capability", async () => {
    const root = await project();
    try {
      await writeFile(join(root, "tool.ts"), "export default (input: unknown) => input;\n", "utf8");
      const manifest: TypeScriptModuleToolManifest = {
        manifestVersion: "1",
        id: "custom.module",
        label: "Module",
        description: "Run a reviewed TypeScript module.",
        inputSchema: objectSchema,
        outputSchema: {
          type: "object",
          properties: { loaded: { type: "boolean" } },
          required: ["loaded"],
          additionalProperties: false,
        },
        kind: "typescript-module",
        source: "module",
        module: "./tool.ts",
      };
      await expect(new NodeToolStore({ projectDirectory: root }).execute(manifest, {}, context))
        .rejects.toMatchObject({ code: "TOOL_CAPABILITY_REQUIRED" });
      const executeModule = vi.fn(async ({ resolvedModule }) => ({ loaded: resolvedModule.endsWith("tool.ts") }));
      const store = new NodeToolStore({
        projectDirectory: root,
        capabilities: { executeModule },
      });
      await expect(store.execute(manifest, {}, context)).resolves.toEqual({ loaded: true });
      expect(executeModule).toHaveBeenCalledWith(expect.objectContaining({
        toolId: "custom.module",
        module: "./tool.ts",
        exportName: "default",
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("OpenAPI operation import", () => {
  it("imports and executes a local OpenAPI 3.0 operation with internal refs", async () => {
    const root = await project();
    try {
      await writeFile(join(root, "openapi.yaml"), `openapi: 3.0.3
info:
  title: Pets
  version: 1.0.0
servers:
  - url: https://api.example.test/v1
paths:
  /pets/{id}:
    get:
      operationId: getPet
      summary: Get pet
      parameters:
        - $ref: '#/components/parameters/PetId'
        - in: query
          name: verbose
          schema:
            type: boolean
      responses:
        '200':
          description: Found
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Pet'
components:
  parameters:
    PetId:
      in: path
      name: id
      required: true
      schema:
        type: string
  schemas:
    Pet:
      type: object
      properties:
        id:
          type: string
      required: [id]
      additionalProperties: false
`, "utf8");
      const transport = vi.fn(async () => new Response(JSON.stringify({ id: "pet-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
      const store = new NodeToolStore({
        projectDirectory: root,
        capabilities: {
          authorizeNetworkHost: () => true,
          fetch: transport as unknown as typeof fetch,
        },
      });
      const imported = await store.importOpenApi("openapi.yaml", { operationIds: ["getPet"] });
      expect(imported).toMatchObject({ warnings: [], tools: [{
        id: "openapi.getpet",
        operationId: "getPet",
        kind: "openapi-operation",
        document: "openapi.yaml",
        request: {
          method: "GET",
          url: "https://api.example.test/v1/pets/{id}",
          path: { id: "/path/id" },
          query: { verbose: "/query/verbose" },
        },
      }] });
      const manifest = imported.tools[0];
      if (!manifest) throw new Error("fixture");
      await expect(store.execute(manifest, {
        path: { id: "pet-1" },
        query: { verbose: true },
      }, context)).resolves.toEqual({ id: "pet-1" });
      expect(String(transport.mock.calls[0]?.[0]))
        .toBe("https://api.example.test/v1/pets/pet-1?verbose=true");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("supports OpenAPI 3.1 but rejects external refs and unsupported versions", async () => {
    const root = await project();
    try {
      const store = new NodeToolStore({ projectDirectory: root });
      await writeFile(join(root, "openapi31.json"), JSON.stringify({
        openapi: "3.1.1",
        info: { title: "Ping", version: "1" },
        servers: [{ url: "https://api.example.test" }],
        paths: {
          "/ping": {
            get: {
              operationId: "ping",
              responses: { "204": { description: "ok" } },
            },
          },
        },
      }), "utf8");
      await expect(store.importOpenApi("openapi31.json"))
        .resolves.toMatchObject({ tools: [{ operationId: "ping" }], warnings: [] });

      await writeFile(join(root, "external.yaml"), `openapi: 3.1.1
info: { title: Unsafe, version: '1' }
paths:
  /unsafe:
    $ref: './other.yaml#/paths/~1unsafe'
`, "utf8");
      await expect(store.importOpenApi("external.yaml"))
        .rejects.toMatchObject({ code: "OPENAPI_EXTERNAL_REF_DENIED" });

      await writeFile(join(root, "future.json"), JSON.stringify({ openapi: "3.2.0", paths: {} }), "utf8");
      await expect(store.importOpenApi("future.json"))
        .rejects.toMatchObject({ code: "OPENAPI_VERSION_UNSUPPORTED" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("built-in tool definitions", () => {
  it.skipIf(process.platform === "win32")("rejects a file swapped after authorization starts", async () => {
    const root = await project();
    const outside = await mkdtemp(join(tmpdir(), "harnest-tool-outside-"));
    try {
      const path = join(root, "note.txt");
      const moved = join(root, "opened.txt");
      const secret = join(outside, "secret.txt");
      await writeFile(path, "safe", "utf8");
      await writeFile(secret, "secret", "utf8");
      const store = new NodeToolStore({
        projectDirectory: root,
        capabilities: {
          authorizeFile: async () => {
            await rename(path, moved);
            await symlink(secret, path, "file");
            return true;
          },
        },
      });
      await expect(store.executeBuiltin("builtin.file", { operation: "read", path: "note.txt" }, context))
        .rejects.toMatchObject({ code: "TOOL_CAPABILITY_DENIED" });
      await expect(readFile(secret, "utf8")).resolves.toBe("secret");
    } finally {
      await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
    }
  });

  it("exposes all built-ins through the same ToolDefinition contract", async () => {
    const root = await project();
    try {
      await mkdir(join(root, "data"));
      await mkdir(join(root, ".harnest"));
      await mkdir(join(root, ".harnest", "context"));
      await writeFile(join(root, "data", "note.txt"), "hello", "utf8");
      await writeFile(join(root, ".harnest", "context", "guide.md"), "portable context", "utf8");
      await writeFile(join(root, ".env"), "SECRET=hidden", "utf8");
      const webSearch = vi.fn(async ({ query }) => ({ query, results: [{ content: "x".repeat(3_000) }] }));
      const webScrape = vi.fn(async () => ({ content: "x".repeat(20_000) }));
      const store = new NodeToolStore({
        projectDirectory: root,
        capabilities: {
          webSearch,
          webScrape,
          authorizeFile: () => true,
        },
      });
      const definitions = store.builtinDefinitions();
      expect(definitions.map(({ id }) => id)).toEqual([
        "builtin.web-search",
        "builtin.web-scrape",
        "builtin.http",
        "builtin.file",
        "builtin.shell",
        "builtin.code-runner",
      ]);
      const search = definitions.find(({ id }) => id === "builtin.web-search");
      const scrape = definitions.find(({ id }) => id === "builtin.web-scrape");
      const file = definitions.find(({ id }) => id === "builtin.file");
      if (!search || !scrape || !file) throw new Error("fixture");
      expect(search.connectionKinds).toEqual(["tool-service"]);
      await expect(search.execute({ query: "Harnest" }, context))
        .resolves.toEqual({
          query: "Harnest",
          results: [{ content: "x".repeat(1_000), contentTruncated: true }],
        });
      await expect(scrape.execute({ url: "https://example.com" }, context))
        .resolves.toEqual({ content: "x".repeat(12_000), truncated: true });
      await expect(file.execute({ operation: "read", path: "data/note.txt" }, context))
        .resolves.toBe("hello");
      await expect(file.execute({ operation: "read", path: ".harnest/context/guide.md" }, context))
        .resolves.toBe("portable context");
      await expect(file.execute({ operation: "read", path: ".env" }, context))
        .rejects.toMatchObject({ code: "TOOL_CAPABILITY_DENIED" });
      await expect(file.execute({ operation: "read", path: "../outside.txt" }, context))
        .rejects.toMatchObject({ code: "TOOL_CAPABILITY_DENIED" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
