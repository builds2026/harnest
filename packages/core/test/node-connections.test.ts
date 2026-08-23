import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AdapterRegistry,
  HarnessRuntime,
  type HarnessSpecV02,
  type ModelAdapter,
  type ServiceExecutionContext,
  type ToolBinding,
} from "../src/index.js";
import {
  ConnectionManager,
  guardedFetch,
  mcpToolApprovalId,
  NodeRuntimeServices,
} from "../src/node.js";
import { containerRunArguments, credentialBackendCommand, pinnedLookup } from "../src/node-connections.js";

const temporaryRoots: string[] = [];

async function temporaryProject(): Promise<{ project: string; userData: string }> {
  const root = await mkdtemp(join(tmpdir(), "harnest-connection-test-"));
  temporaryRoots.push(root);
  const project = await mkdtemp(join(root, "project-"));
  const userData = await mkdtemp(join(root, "user-"));
  return { project, userData };
}

const context: ServiceExecutionContext = {
  signal: new AbortController().signal,
  runId: "connection-test",
  nodeId: "connection-node",
  iteration: 0,
  resolveSecret: () => undefined,
};

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("container sandbox arguments", () => {
  it("mounts selected input read-only and output writable while rejecting ambiguous sources", () => {
    const profile = {
      id: "python", scope: "project", kind: "local-runtime", name: "Python",
      config: { sandbox: "container", image: "python:3.13-alpine" },
      credentialFields: [], status: { state: "connected" }, createdAt: "now", updatedAt: "now",
    } as const;
    const args = containerRunArguments(profile, "sandbox", ["python", "-"], [], undefined, [
      { source: process.cwd(), target: "/mnt/data", readOnly: true },
      { source: process.cwd(), target: "/mnt/output", readOnly: false },
    ]);
    expect(args).toContain(`type=bind,source=${process.cwd()},target=/mnt/data,readonly`);
    expect(args).toContain(`type=bind,source=${process.cwd()},target=/mnt/output`);
    expect(args).toEqual(expect.arrayContaining(["--network", "none", "--read-only", "--cap-drop", "ALL"]));
    expect(() => containerRunArguments(profile, "sandbox", ["python", "-"], [], undefined, [
      { source: `${process.cwd()},other`, target: "/mnt/data", readOnly: true },
    ])).toThrow(/mount is invalid/);
  });
});

describe.sequential("ConnectionManager credential boundary", () => {
  it("uses OS credential stores without placing the vault key in command arguments", () => {
    const id = "0123456789abcdef0123456789abcdef";
    const mac = credentialBackendCommand("darwin", "store", id);
    const linux = credentialBackendCommand("linux", "store", id);
    expect(mac).toMatchObject({ protection: "macos-keychain", args: expect.arrayContaining(["-w"]) });
    expect(mac.args.at(-1)).toBe("-w");
    expect(linux).toMatchObject({ protection: "linux-secret-service", args: expect.arrayContaining(["store"]) });
    expect([...mac.args, ...linux.args].some((argument) => /^[A-Za-z0-9+/]{43}=$/u.test(argument))).toBe(false);
    expect(() => credentialBackendCommand("freebsd", "store", id)).toThrow(/DPAPI.*Keychain.*Secret Service/);
  });

  it("rejects hostnames that resolve to private addresses before connecting", async () => {
    await expect(guardedFetch(true)("https://localhost/private")).rejects.toThrow(/private or reserved address/);
    await expect(guardedFetch(true)(new Request("https://localhost/private")))
      .rejects.toThrow(/private or reserved address/);
  });

  it("returns a pinned address in both Node lookup callback shapes", async () => {
    const lookup = pinnedLookup({ address: "8.8.8.8", family: 4 });
    await expect(new Promise((resolve, reject) => lookup("example.test", { all: true }, (error, addresses) => {
      if (error) reject(error); else resolve(addresses);
    }))).resolves.toEqual([{ address: "8.8.8.8", family: 4 }]);
    await expect(new Promise((resolve, reject) => lookup("example.test", {}, (error, address, family) => {
      if (error) reject(error); else resolve({ address, family });
    }))).resolves.toEqual({ address: "8.8.8.8", family: 4 });
  });

  it("tests and executes a SearXNG Search Connection through the shared Web Search contract", async () => {
    const { project, userData } = await temporaryProject();
    const requests: string[] = [];
    const server = createServer((request, outgoing) => {
      requests.push(request.url ?? "");
      outgoing.writeHead(200, { "content-type": "application/json" });
      if (request.url === "/scrape") {
        outgoing.end(JSON.stringify({ page: { title: "Public page", source: "http://8.8.8.8/page", markdown: "# Extracted" } }));
        return;
      }
      outgoing.end(JSON.stringify({
        results: [{ title: "Harnest", url: "https://example.com/harnest", content: "Harness result" }],
        next: "page-2",
      }));
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Search fixture did not bind a TCP port");
      const manager = new ConnectionManager(project, { userDataDirectory: userData });
      const connection = await manager.create({
        id: "searxng_fixture",
        scope: "project",
        kind: "tool-service",
        name: "SearXNG fixture",
        config: {
          connector: "searxng",
          url: `http://127.0.0.1:${address.port}/search`,
          method: "GET",
          requestEncoding: "query",
          queryParameter: "q",
          limitParameter: "limit",
          cursorParameter: "page",
          nextCursorPath: "/next",
          staticParameters: { format: "json" },
          responseItemsPath: "/results",
          snippetField: "content",
          scrapeUrl: `http://127.0.0.1:${address.port}/scrape`,
          scrapeUrlParameter: "url",
          scrapeStaticParameters: { format: "markdown" },
          scrapeContentPath: "/page/markdown",
          scrapeTitlePath: "/page/title",
          scrapeSourceUrlPath: "/page/source",
        },
      });
      await expect(manager.test(connection.id)).resolves.toMatchObject({ status: { state: "connected" } });
      const services = new NodeRuntimeServices(project, { connectionManager: manager });
      const result = await services.executeTool({
        id: "builtin.web-search",
        source: "builtin",
        connectionId: connection.id,
      }, { query: "agent harness", limit: 3, cursor: "page-1" }, context);
      expect(result.value).toEqual({
        provider: "searxng",
        nextCursor: "page-2",
        results: [{
          title: "Harnest",
          url: "https://example.com/harnest",
          snippet: "Harness result",
          content: "Harness result",
        }],
      });
      expect(requests).toHaveLength(2);
      expect(new URL(requests[1]!, "http://fixture").searchParams.get("q")).toBe("agent harness");
      expect(new URL(requests[1]!, "http://fixture").searchParams.get("format")).toBe("json");
      expect(new URL(requests[1]!, "http://fixture").searchParams.get("page")).toBe("page-1");
      await expect(services.executeTool({
        id: "builtin.web-scrape",
        source: "builtin",
        connectionId: connection.id,
      }, { url: "http://8.8.8.8/page" }, context)).resolves.toMatchObject({ value: {
        provider: "searxng", url: "http://8.8.8.8/page", title: "Public page", content: "# Extracted",
      } });
      expect(requests).toHaveLength(3);
      await services.close();
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it("marks a Firecrawl Search Connection without an API key as needing authentication", async () => {
    const { project, userData } = await temporaryProject();
    const manager = new ConnectionManager(project, { userDataDirectory: userData });
    const connection = await manager.create({
      id: "firecrawl_fixture",
      scope: "project",
      kind: "tool-service",
      name: "Firecrawl fixture",
      config: {
        connector: "firecrawl",
        url: "https://api.firecrawl.dev/v2/search",
        authScheme: "bearer",
        testUrl: "https://api.firecrawl.dev/v2/team/credit-usage",
      },
    });

    await expect(manager.test(connection.id)).rejects.toMatchObject({ code: "CONNECTION_TEST_FAILED" });
    await expect(manager.require(connection.id)).resolves.toMatchObject({ status: { state: "needs_auth" } });
  });

  it("probes generic HTTP API reachability and authentication status", async () => {
    const { project, userData } = await temporaryProject();
    const server = createServer((request, response) => response.writeHead(request.url === "/ready" ? 204 : 401).end());
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("HTTP fixture did not bind a TCP port");
      const manager = new ConnectionManager(project, { userDataDirectory: userData });
      await manager.create({
        id: "http_ready_fixture", scope: "project", kind: "http-api", name: "Ready API",
        config: { url: `http://127.0.0.1:${address.port}/ready` },
      });
      await manager.create({
        id: "http_auth_fixture", scope: "project", kind: "http-api", name: "Auth API",
        config: { url: `http://127.0.0.1:${address.port}/auth` },
      });
      await expect(manager.test("http_ready_fixture")).resolves.toMatchObject({ status: { state: "connected" } });
      await expect(manager.test("http_auth_fixture")).rejects.toMatchObject({ code: "CONNECTION_TEST_FAILED" });
      await expect(manager.require("http_auth_fixture")).resolves.toMatchObject({ status: { state: "needs_auth" } });
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it("runs code through an approved resource-bounded container engine", async () => {
    if (process.platform !== "win32") return;
    const { project, userData } = await temporaryProject();
    const engineDirectory = join(project, "fake-container-engine");
    await mkdir(engineDirectory);
    const engine = join(engineDirectory, "docker.exe");
    const invocationLog = join(engineDirectory, "invocations.ndjson");
    await copyFile(process.execPath, engine);
    await writeFile(join(engineDirectory, "image"), `console.log("sha256:${"a".repeat(64)}")\n`, "utf8");
    await writeFile(join(engineDirectory, "run"), `const { spawn } = require("node:child_process")
require("node:fs").appendFileSync(${JSON.stringify(invocationLog)}, JSON.stringify(process.argv) + "\\n")
if (!process.argv.includes("sha256:${"a".repeat(64)}")) process.exit(2)
const child = spawn(process.execPath, ["-"], { stdio: ["pipe", "inherit", "inherit"] })
process.stdin.pipe(child.stdin)
child.on("exit", (code) => process.exit(code ?? 1))
`, "utf8");
    await writeFile(join(engineDirectory, "rm"), "process.exit(0)\n", "utf8");
    const manager = new ConnectionManager(project, { userDataDirectory: userData });
    const connection = await manager.create({
      id: "sandbox_fixture",
      scope: "project",
      kind: "local-runtime",
      name: "Sandbox fixture",
      config: {
        sandbox: "container",
        engine,
        image: "fixture@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        runtime: "node",
        network: "none",
        memoryMb: 128,
        cpus: 0.5,
        pids: 16,
      },
    });
    await expect(manager.test(connection.id)).resolves.toMatchObject({ status: { state: "connected" } });
    await manager.approveProcess(connection.id);
    const inputDirectory = join(project, ".harnest", "sandbox-input");
    const outputDirectory = join(project, ".harnest", "sandbox-output");
    await Promise.all([mkdir(inputDirectory), mkdir(outputDirectory)]);
    const services = new NodeRuntimeServices(project, {
      connectionManager: manager,
      sandboxWorkspace: { inputDirectory, outputDirectory },
      allowModuleExecution: true,
    });
    await expect(services.executeTool({
      id: "builtin.code-runner",
      source: "builtin",
      connectionId: connection.id,
    }, { runtime: "node", code: "console.log(2 + 3)" }, context)).resolves.toMatchObject({
      value: { stdout: "5\n", exitCode: 0 },
    });
    const invocations = async () => (await readFile(invocationLog, "utf8")).trim().split(/\r?\n/u)
      .map((line) => JSON.parse(line) as string[]);
    expect((await invocations()).at(-1)).toEqual(expect.arrayContaining([
      expect.stringContaining("target=/mnt/data,readonly"),
      expect.stringContaining("target=/mnt/output"),
    ]));
    const unsafeServices = new NodeRuntimeServices(project, {
      connectionManager: manager,
      sandboxWorkspace: { inputDirectory: project },
    });
    await expect(unsafeServices.executeTool({
      id: "builtin.code-runner",
      source: "builtin",
      connectionId: connection.id,
    }, { runtime: "node", code: "console.log('unsafe')" }, context)).rejects.toThrow("outside the project");
    await unsafeServices.close();
    await writeFile(join(project, "custom-tool.ts"), "export default ({ value }: { value: number }) => ({ doubled: value * 2 })\n", "utf8");
    await services.toolStore.save({
      manifestVersion: "1",
      id: "custom.isolated-module",
      label: "Isolated module",
      description: "Containerized TypeScript fixture.",
      inputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false },
      outputSchema: { type: "object", properties: { doubled: { type: "number" } }, required: ["doubled"], additionalProperties: false },
      connectionKinds: ["local-runtime"],
      kind: "typescript-module",
      source: "module",
      module: "./custom-tool.ts",
    });
    await expect(services.executeTool({
      id: "custom.isolated-module",
      source: "module",
      connectionId: connection.id,
    }, { value: 4 }, context)).resolves.toMatchObject({ value: { doubled: 8 } });
    expect((await invocations()).at(-1)?.some((value) => value.includes("target=/mnt/"))).toBe(false);
    await services.close();
  });

  it("rejects unsafe JSON Schemas before persisting discovered MCP Tools", async () => {
    const { project, userData } = await temporaryProject();
    const manager = new ConnectionManager(project, { userDataDirectory: userData });
    await manager.create({
      id: "unsafe_schema_fixture",
      scope: "project",
      kind: "mcp",
      name: "Unsafe schema fixture",
      config: { transport: "http", url: "https://mcp.example/tools" },
    });

    await expect(manager.storeDiscoveredTools("unsafe_schema_fixture", [{
      name: "slow-match",
      inputSchema: { type: "string", pattern: "^(a+)+$" },
    }])).rejects.toMatchObject({ code: "CONNECTION_INVALID" });
    expect((await manager.require("unsafe_schema_fixture")).tools).toBeUndefined();
  });

  it("uses the trusted system PowerShell path for DPAPI", async () => {
    if (process.platform !== "win32") return;
    const { project, userData } = await temporaryProject();
    await writeFile(join(project, "powershell.exe"), "untrusted project executable", "utf8");
    const previousDirectory = process.cwd();
    const previousPath = process.env.PATH;
    try {
      process.chdir(project);
      process.env.PATH = project;
      const manager = new ConnectionManager(project, { userDataDirectory: userData });
      await expect(manager.create({
        id: "trusted_dpapi",
        scope: "project",
        kind: "provider",
        name: "Trusted DPAPI",
        config: { adapter: "openai", model: "fixture" },
      }, { apiKey: "encrypted-by-system-helper" })).resolves.toMatchObject({ id: "trusted_dpapi" });
    } finally {
      process.chdir(previousDirectory);
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it("never returns or stores a plaintext credential in public metadata", async () => {
    const { project, userData } = await temporaryProject();
    const manager = new ConnectionManager(project, { userDataDirectory: userData });
    const secret = `fixture-secret-${Date.now()}`;

    if (process.platform !== "win32") {
      await expect(manager.create({
        id: "provider_fixture",
        scope: "project",
        kind: "provider",
        name: "Fixture Provider",
        config: { adapter: "openai", model: "fixture-model" },
      }, { apiKey: secret })).rejects.toMatchObject({ code: "CREDENTIAL_BACKEND_UNAVAILABLE" });
      return;
    }

    const created = await manager.create({
      id: "provider_fixture",
      scope: "project",
      kind: "provider",
      name: "Fixture Provider",
      config: { adapter: "openai", model: "fixture-model" },
    }, { prefix: "fixture", apiKey: secret });

    expect(created.credentialFields).toEqual(["apiKey", "prefix"]);
    expect(JSON.stringify(created)).not.toContain(secret);
    expect(await manager.list({ text: "fixture", scope: "project", kind: "provider" })).toHaveLength(1);
    const protocolUntested = await manager.test(created.id);
    expect(protocolUntested.status).toMatchObject({ state: "unknown" });
    expect(protocolUntested.status.message).toContain("no protocol test is available");

    const paths = manager.paths();
    expect(await readFile(paths.projectMetadata, "utf8")).not.toContain(secret);
    for (const file of paths.credentialFiles) {
      expect(await readFile(file, "utf8")).not.toContain(secret);
    }

    const reopened = new ConnectionManager(project, { userDataDirectory: userData });
    expect(await reopened.resolveCredential(created.id, "apiKey")).toBe(secret);
    await expect(reopened.redactSensitiveOutput(created.id, {
      message: `server echoed ${secret}`,
    })).resolves.toEqual({ message: "server echoed [REDACTED]" });

    const services = new NodeRuntimeServices(project, { connectionManager: reopened });
    const resolved = await services.resolveConnection(created.id, context);
    const value = resolved.value as Record<string, unknown>;
    expect(value).toMatchObject({
      adapter: "openai",
      model: "fixture-model",
      connectionId: created.id,
      connectionKind: "provider",
    });
    expect(value.apiKey).toBe(reopened.credentialReference(created.id, "apiKey"));
    expect(JSON.stringify(resolved)).not.toContain(secret);
    expect(services.resolveConnectionSecret(String(value.apiKey))).toBe(secret);
    await services.close();
    expect(services.resolveConnectionSecret(String(value.apiKey))).toBeUndefined();

    const adapter: ModelAdapter = {
      id: "openai",
      capabilities: { streaming: true, json: false, cancellation: true },
      async *run(request, adapterContext) {
        expect(request).toMatchObject({ model: "fixture-model", apiKey: reopened.credentialReference(created.id, "apiKey") });
        expect(adapterContext.resolveSecret(String(request.apiKey))).toBe(secret);
        yield { type: "text-delta", text: "Connection resolved." };
        yield { type: "finish", reason: "stop" };
      },
    };
    const connectionServices = new NodeRuntimeServices(project, { connectionManager: reopened });
    const spec: HarnessSpecV02 = {
      version: "0.2",
      components: [
        { id: "model", type: "model", config: { connectionId: created.id } },
        { id: "prompt", type: "prompt", config: { template: "{{input}}" } },
        { id: "agent", type: "agent", config: {} },
        { id: "output", type: "output", config: {} },
      ],
      connections: [
        { from: { component: "model", port: "model" }, to: { component: "agent", port: "model" } },
        { from: { component: "prompt", port: "prompt" }, to: { component: "agent", port: "prompt" } },
        { from: { component: "agent", port: "response" }, to: { component: "output", port: "value" } },
      ],
      entrypoint: "output",
    };
    const execution = await new HarnessRuntime(spec, new AdapterRegistry().register(adapter), {
      services: connectionServices,
    }).invoke("hello");
    expect(execution.output).toBe("Connection resolved.");
    expect(connectionServices.resolveConnectionSecret(reopened.credentialReference(created.id, "apiKey"))).toBeUndefined();
    await connectionServices.close();

    const disconnected = await reopened.disconnect(created.id);
    expect(disconnected.status.state).toBe("disconnected");
    expect(disconnected.credentialFields).toEqual([]);
    expect(await reopened.resolveCredential(created.id, "apiKey")).toBeUndefined();
    expect(await reopened.delete(created.id)).toBe(true);
    expect(await reopened.get(created.id)).toBeUndefined();
  });

  it("injects HTTP credentials only on the Connection origin and redacts echoed secrets", async () => {
    if (process.platform !== "win32") return;
    const { project, userData } = await temporaryProject();
    const secret = `Bearer tool-secret-${Date.now()}`;
    let receivedAuthorization = "";
    const server = createServer((request, outgoing) => {
      receivedAuthorization = request.headers.authorization ?? "";
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ authorization: receivedAuthorization }));
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("HTTP fixture did not bind a TCP port");
      const origin = `http://127.0.0.1:${address.port}`;
      const manager = new ConnectionManager(project, { userDataDirectory: userData });
      const profile = await manager.create({
        id: "http_fixture",
        scope: "project",
        kind: "http-api",
        name: "HTTP Fixture",
        config: { url: origin, headerCredentials: { Authorization: "token" } },
      }, { token: secret });
      const services = new NodeRuntimeServices(project, {
        connectionManager: manager,
        allowNetworkHosts: true,
      });
      const binding: ToolBinding = {
        id: "builtin.http",
        label: "HTTP Request",
        description: "Fixture",
        inputSchema: { type: "object" },
        risk: "external",
        source: "builtin",
        connectionId: profile.id,
      };
      await expect(services.executeTool(binding, { url: `${origin}/echo` }, context)).resolves.toMatchObject({
        value: { authorization: "[REDACTED]" },
      });
      expect(receivedAuthorization).toBe(secret);
      await expect(services.executeTool(binding, {
        url: `http://localhost:${address.port}/cross-origin`,
      }, context)).rejects.toThrow(/not bound to HTTP origin|literal loopback/);
      await services.close();
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it("rejects credentials after Connection security metadata is edited out of band", async () => {
    if (process.platform !== "win32") return;
    const { project, userData } = await temporaryProject();
    const manager = new ConnectionManager(project, { userDataDirectory: userData });
    await manager.create({
      id: "bound_http_fixture",
      scope: "project",
      kind: "http-api",
      name: "Bound HTTP Fixture",
      config: { url: "https://api.example", headerCredentials: { Authorization: "token" } },
    }, { token: "Bearer must-not-move" });

    const metadataPath = manager.paths().projectMetadata;
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as {
      connections: Array<{ id: string; config: Record<string, unknown> }>;
    };
    const edited = metadata.connections.find((connection) => connection.id === "bound_http_fixture");
    if (!edited) throw new Error("Connection fixture metadata is missing");
    edited.config.url = "https://attacker.example";
    await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`, "utf8");

    const reopened = new ConnectionManager(project, { userDataDirectory: userData });
    await expect(reopened.resolveCredential("bound_http_fixture", "token")).rejects.toMatchObject({
      code: "CREDENTIAL_STORE_FAILED",
    });
  });

  it("rolls back pending credentials when Connection metadata creation fails", async () => {
    if (process.platform !== "win32") return;
    const { project, userData } = await temporaryProject();
    const manager = new ConnectionManager(project, { userDataDirectory: userData });
    const metadataDirectory = join(project, ".harnest");
    await mkdir(metadataDirectory);
    const lockPath = join(metadataDirectory, "connections.json.lock");
    await writeFile(lockPath, "held\n", "utf8");
    let clock = Date.now();
    const clockSpy = vi.spyOn(Date, "now").mockImplementation(() => (clock += 20_000));
    try {
      await expect(manager.create({
        id: "rolled_back_fixture",
        scope: "project",
        kind: "http-api",
        name: "Rolled Back Fixture",
        config: { url: "https://api.example", headerCredentials: { Authorization: "token" } },
      }, { token: "Bearer orphan-secret" })).rejects.toMatchObject({ code: "CREDENTIAL_STORE_FAILED" });
    } finally {
      clockSpy.mockRestore();
      await rm(lockPath, { force: true });
    }

    const createdAt = new Date().toISOString();
    await writeFile(manager.paths().projectMetadata, `${JSON.stringify({
      version: 1,
      connections: [{
        id: "rolled_back_fixture",
        scope: "project",
        kind: "http-api",
        name: "Forged Fixture",
        config: { url: "https://api.example", headerCredentials: { Authorization: "token" } },
        credentialFields: ["token"],
        status: { state: "unknown" },
        createdAt,
        updatedAt: createdAt,
      }],
    })}\n`, "utf8");
    const reopened = new ConnectionManager(project, { userDataDirectory: userData });
    await expect(reopened.resolveCredential("rolled_back_fixture", "token")).resolves.toBeUndefined();
  });

  it("restores the previous config binding and credentials when metadata update fails", async () => {
    if (process.platform !== "win32") return;
    const { project, userData } = await temporaryProject();
    const manager = new ConnectionManager(project, { userDataDirectory: userData });
    await manager.create({
      id: "update_rollback_fixture",
      scope: "project",
      kind: "http-api",
      name: "Original Fixture",
      config: { url: "https://original.example", headerCredentials: { Authorization: "token" } },
    }, { token: "Bearer original-secret" });

    const lockPath = `${manager.paths().projectMetadata}.lock`;
    await writeFile(lockPath, "held\n", "utf8");
    let clock = Date.now();
    const clockSpy = vi.spyOn(Date, "now").mockImplementation(() => (clock += 20_000));
    try {
      await expect(manager.update("update_rollback_fixture", {
        name: "Changed Fixture",
        config: { url: "https://changed.example", headerCredentials: { Authorization: "token" } },
      }, { token: "Bearer changed-secret" })).rejects.toMatchObject({ code: "CREDENTIAL_STORE_FAILED" });
    } finally {
      clockSpy.mockRestore();
      await rm(lockPath, { force: true });
    }

    await expect(manager.require("update_rollback_fixture")).resolves.toMatchObject({
      name: "Original Fixture",
      config: { url: "https://original.example", headerCredentials: { Authorization: "token" } },
    });
    await expect(manager.resolveCredential("update_rollback_fixture", "token")).resolves.toBe("Bearer original-secret");
  });

  it("rejects secrets in public config before touching the credential store", async () => {
    const { project, userData } = await temporaryProject();
    const manager = new ConnectionManager(project, { userDataDirectory: userData });
    await expect(manager.create({
      scope: "user",
      kind: "provider",
      name: "Unsafe",
      config: { adapter: "openai", model: "fixture", apiKey: "must-not-be-public" },
    })).rejects.toMatchObject({ code: "CONNECTION_INVALID" });
    await expect(manager.create({
      scope: "project",
      kind: "http-api",
      name: "Unsafe camel case",
      config: { url: "https://api.example", authToken: "must-not-be-public" },
    })).rejects.toMatchObject({ code: "CONNECTION_INVALID" });
    await expect(manager.create({
      scope: "project",
      kind: "http-api",
      name: "Unsafe header",
      config: { url: "https://api.example", headers: { "X-Auth": "Bearer must-not-be-public" } },
    })).rejects.toMatchObject({ code: "CONNECTION_INVALID" });
    for (const field of ["auth", "apiTokenValue", "arbitrary"] as const) {
      await expect(manager.create({
        scope: "project",
        kind: "provider",
        name: `Unknown ${field}`,
        config: { adapter: "openai", model: "fixture", [field]: "opaque-random-value" },
      })).rejects.toMatchObject({ code: "CONNECTION_INVALID" });
    }
  });

  it("binds OAuth credentials to their issuer and keeps static fields when OAuth is invalidated", async () => {
    const { project, userData } = await temporaryProject();
    const manager = new ConnectionManager(project, { userDataDirectory: userData });
    if (process.platform !== "win32") return;

    await manager.create({
      id: "oauth_fixture",
      scope: "user",
      kind: "mcp",
      name: "OAuth Fixture",
      config: { transport: "http", url: "https://resource.example/mcp", oauth: true },
    }, { tenantHint: "private-tenant" });
    const discovered = await manager.storeDiscoveredTools("oauth_fixture", [{
      name: "echo",
      description: "server reflected private-tenant",
      inputSchema: { type: "object", default: "private-tenant" },
    }]);
    expect(discovered.tools?.[0]).toMatchObject({
      description: "server reflected [REDACTED]",
      inputSchema: { default: "[REDACTED]" },
    });
    expect(await readFile(manager.paths().userMetadata, "utf8")).not.toContain("private-tenant");
    const first = await manager.oauthProviderFor("oauth_fixture", "http://127.0.0.1:43119/callback");
    const issuerA = { issuer: "https://issuer-a.example" };
    const issuerB = { issuer: "https://issuer-b.example" };
    await first.saveClientInformation?.({ client_id: "client-a" }, issuerA);
    await first.saveTokens?.({ access_token: "access-a", token_type: "bearer" }, issuerA);

    const reopened = new ConnectionManager(project, { userDataDirectory: userData });
    const second = await reopened.oauthProviderFor("oauth_fixture", "http://127.0.0.1:43119/callback");
    await expect(second.tokens?.(issuerA)).resolves.toMatchObject({ access_token: "access-a" });
    await expect(second.tokens?.(issuerB)).resolves.toBeUndefined();
    await expect(second.tokens?.()).resolves.toMatchObject({ access_token: "access-a" });

    const state = await second.state?.();
    expect(typeof state).toBe("string");
    await second.saveCodeVerifier?.("pkce-verifier");
    await expect(second.codeVerifier?.()).resolves.toBe("pkce-verifier");
    await expect(reopened.finishOAuth(
      "oauth_fixture",
      new URLSearchParams({ state: "wrong-state", code: "unused" }),
      { allowNetworkHosts: ["resource.example"] },
    )).rejects.toMatchObject({ code: "OAUTH_STATE_INVALID" });

    await second.invalidateCredentials?.("tokens");
    expect(await reopened.resolveCredential("oauth_fixture", "tenantHint")).toBe("private-tenant");
    await expect(second.tokens?.(issuerA)).resolves.toBeUndefined();
  });

  it("allows only authorization hosts declared by protected resource metadata", async () => {
    const { project, userData } = await temporaryProject();
    const authorization = createServer((request, response) => {
      if (!request.url?.includes(".well-known")) return response.writeHead(404).end();
      const address = authorization.address();
      if (!address || typeof address === "string") return response.writeHead(500).end();
      const issuer = `http://127.0.0.1:${address.port}`;
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      }));
    });
    await new Promise<void>((resolveListen) => authorization.listen(0, "127.0.0.1", resolveListen));
    const authorizationAddress = authorization.address();
    if (!authorizationAddress || typeof authorizationAddress === "string") throw new Error("Authorization fixture did not bind");
    const authorizationHost = `127.0.0.1:${authorizationAddress.port}`;
    const resource = createServer((request, response) => {
      if (!request.url?.includes(".well-known")) return response.writeHead(401).end();
      const address = resource.address();
      if (!address || typeof address === "string") return response.writeHead(500).end();
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        resource: `http://127.0.0.1:${address.port}/mcp`,
        authorization_servers: [`http://${authorizationHost}`],
        scopes_supported: ["tools:read"],
      }));
    });
    await new Promise<void>((resolveListen) => resource.listen(0, "127.0.0.1", resolveListen));
    const resourceAddress = resource.address();
    if (!resourceAddress || typeof resourceAddress === "string") throw new Error("Resource fixture did not bind");
    const resourceHost = `127.0.0.1:${resourceAddress.port}`;
    const manager = new ConnectionManager(project, { userDataDirectory: userData });
    try {
      await manager.create({
        id: "split_oauth_fixture",
        scope: "project",
        kind: "mcp",
        name: "Split OAuth Fixture",
        config: { transport: "http", url: `http://${resourceHost}/mcp`, oauth: true },
      });
      await expect(manager.oauthNetworkHostsFor("split_oauth_fixture", [resourceHost])).resolves.toEqual(
        expect.arrayContaining([resourceHost, authorizationHost]),
      );
    } finally {
      await Promise.all([
        new Promise<void>((resolveClose) => resource.close(() => resolveClose())),
        new Promise<void>((resolveClose) => authorization.close(() => resolveClose())),
      ]);
    }
  });

  it("atomically consumes an OAuth callback state exactly once", async () => {
    const { project, userData } = await temporaryProject();
    if (process.platform !== "win32") return;
    let tokenRequests = 0;
    const server = createServer(async (request, outgoing) => {
      if (request.url !== "/token") {
        outgoing.statusCode = 404;
        outgoing.end();
        return;
      }
      tokenRequests += 1;
      await new Promise<void>((resolveBody, rejectBody) => {
        request.once("end", resolveBody);
        request.once("error", rejectBody);
        request.resume();
      });
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 75));
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ access_token: "callback-token", token_type: "Bearer" }));
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("OAuth callback fixture did not bind");
    const host = `127.0.0.1:${address.port}`;
    const issuer = `http://${host}`;
    const manager = new ConnectionManager(project, { userDataDirectory: userData });
    try {
      await manager.create({
        id: "oauth_replay_fixture",
        scope: "project",
        kind: "mcp",
        name: "OAuth Replay Fixture",
        config: { transport: "http", url: `${issuer}/mcp`, oauth: true },
      });
      const provider = await manager.oauthProviderFor("oauth_replay_fixture", "http://127.0.0.1:43119/callback");
      const state = await provider.state?.();
      if (typeof state !== "string") throw new Error("OAuth provider did not create state");
      await provider.saveCodeVerifier?.("fixture-code-verifier");
      await provider.saveDiscoveryState?.({
        authorizationServerUrl: issuer,
        authorizationServerMetadata: {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          response_types_supported: ["code"],
          token_endpoint_auth_methods_supported: ["none"],
        },
      });
      await provider.saveClientInformation?.({ client_id: "callback-client" }, { issuer });
      const callback = () => manager.finishOAuth(
        "oauth_replay_fixture",
        new URLSearchParams({ state, code: "fixture-code" }),
        { allowNetworkHosts: [host] },
      );
      const outcomes = await Promise.allSettled([callback(), callback()]);
      expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      const rejected = outcomes.find(({ status }) => status === "rejected");
      expect(rejected).toMatchObject({ status: "rejected", reason: { code: "OAUTH_STATE_INVALID" } });
      expect(tokenRequests).toBe(1);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  }, 30_000);

  it("completes discovery, PKCE consent, callback, refresh, scope re-consent, and revoke", async () => {
    if (process.platform !== "win32") return;
    const { project, userData } = await temporaryProject();
    let issuer = "";
    let redirectUrl = "";
    let authorizationCount = 0;
    let refreshCount = 0;
    const codes = new Map<string, { challenge: string; scope: string }>();
    const revoked: string[] = [];
    const body = async (request: IncomingMessage) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).toString("utf8");
    };
    const server = createServer(async (request, response) => {
      try {
        const url = new URL(request.url ?? "/", issuer || "http://127.0.0.1");
        if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({
            resource: `${issuer}/mcp`, authorization_servers: [issuer], scopes_supported: ["tools:read", "tools:write"],
          }));
          return;
        }
        if (url.pathname === "/.well-known/oauth-authorization-server") {
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            registration_endpoint: `${issuer}/register`,
            revocation_endpoint: `${issuer}/revoke`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            token_endpoint_auth_methods_supported: ["none"],
            code_challenge_methods_supported: ["S256"],
            scopes_supported: ["tools:read", "tools:write", "offline_access"],
          }));
          return;
        }
        if (url.pathname === "/register") {
          const registered = JSON.parse(await body(request)) as { redirect_uris?: string[] };
          redirectUrl = registered.redirect_uris?.[0] ?? "";
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ ...registered, client_id: "fixture-client", token_endpoint_auth_method: "none" }));
          return;
        }
        if (url.pathname === "/authorize") {
          authorizationCount += 1;
          const code = `code-${authorizationCount}`;
          codes.set(code, {
            challenge: url.searchParams.get("code_challenge") ?? "",
            scope: url.searchParams.get("scope") ?? "",
          });
          const callback = new URL(url.searchParams.get("redirect_uri") ?? redirectUrl);
          callback.searchParams.set("code", code);
          callback.searchParams.set("state", url.searchParams.get("state") ?? "");
          response.writeHead(302, { location: callback.toString() }).end();
          return;
        }
        if (url.pathname === "/token") {
          const form = new URLSearchParams(await body(request));
          if (form.get("grant_type") === "refresh_token") {
            refreshCount += 1;
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify({
              access_token: `refreshed-${refreshCount}`, refresh_token: form.get("refresh_token"), token_type: "Bearer",
            }));
            return;
          }
          const grant = codes.get(form.get("code") ?? "");
          const verifier = form.get("code_verifier") ?? "";
          if (!grant || createHash("sha256").update(verifier).digest("base64url") !== grant.challenge) {
            response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_grant" }));
            return;
          }
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({
            access_token: `access-${authorizationCount}`,
            refresh_token: `refresh-${authorizationCount}`,
            token_type: "Bearer",
            scope: grant.scope,
          }));
          return;
        }
        if (url.pathname === "/revoke") {
          revoked.push(new URLSearchParams(await body(request)).get("token") ?? "");
          response.writeHead(200).end();
          return;
        }
        if (url.pathname === "/mcp") {
          response.writeHead(403, {
            "www-authenticate": `Bearer error="insufficient_scope", scope="tools:write"`,
          }).end();
          return;
        }
        response.writeHead(404).end();
      } catch (error) {
        response.writeHead(500).end(error instanceof Error ? error.message : "fixture failure");
      }
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("OAuth E2E fixture did not bind");
    const host = `127.0.0.1:${address.port}`;
    issuer = `http://${host}`;
    const manager = new ConnectionManager(project, { userDataDirectory: userData });
    const authorize = async (scope: string) => {
      const started = await manager.beginOAuth("oauth_e2e_fixture", {
        redirectUrl: "http://127.0.0.1:43119/callback",
        scope,
        allowNetworkHosts: [host],
      });
      expect(started.status).toBe("redirect");
      const consent = await fetch(started.authorizationUrl!, { redirect: "manual" });
      const callback = new URL(consent.headers.get("location")!);
      return manager.finishOAuth("oauth_e2e_fixture", callback.searchParams, { allowNetworkHosts: [host] });
    };
    try {
      await manager.create({
        id: "oauth_e2e_fixture", scope: "project", kind: "mcp", name: "OAuth E2E Fixture",
        config: { transport: "http", url: `${issuer}/mcp`, oauth: true },
      });
      await expect(authorize("tools:read")).resolves.toMatchObject({ status: { state: "unknown" } });
      await expect(manager.beginOAuth("oauth_e2e_fixture", {
        redirectUrl: "http://127.0.0.1:43119/callback", allowNetworkHosts: [host],
      })).resolves.toMatchObject({ status: "authorized" });
      expect(refreshCount).toBe(1);
      await expect(manager.test("oauth_e2e_fixture", { allowNetworkHosts: [host] }))
        .rejects.toMatchObject({ code: "CONNECTION_TEST_FAILED" });
      expect((await manager.require("oauth_e2e_fixture")).status.state).toBe("insufficient_scope");
      await expect(authorize("tools:write")).resolves.toMatchObject({ status: { state: "unknown" } });
      expect(authorizationCount).toBe(2);
      await expect(manager.disconnect("oauth_e2e_fixture", { revoke: true, allowNetworkHosts: [host] }))
        .resolves.toMatchObject({ status: { state: "disconnected" } });
      expect(revoked).toEqual(["refresh-2", "access-2"]);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  }, 30_000);

  it("bounds stalled OAuth discovery requests", async () => {
    if (process.platform !== "win32") return;
    const { project, userData } = await temporaryProject();
    const server = createServer(() => undefined);
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("OAuth stall fixture did not bind");
    const host = `127.0.0.1:${address.port}`;
    const manager = new ConnectionManager(project, { userDataDirectory: userData });
    try {
      await manager.create({
        id: "oauth_stall_fixture",
        scope: "project",
        kind: "mcp",
        name: "OAuth Stall Fixture",
        config: { transport: "http", url: `http://${host}/mcp`, oauth: true },
      });
      await expect(manager.beginOAuth("oauth_stall_fixture", {
        redirectUrl: "http://127.0.0.1:43119/callback",
        allowNetworkHosts: [host],
        timeoutMs: 50,
      })).rejects.toMatchObject({ code: "OAUTH_INVALID" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });
});

describe.sequential("saved MCP Connections", () => {
  it("denies risky Tool calls by default and honors exact-id preapproval", async () => {
    const { project } = await temporaryProject();
    const tool: ToolBinding = {
      id: "http.send",
      label: "Send",
      description: "Send a request",
      inputSchema: { type: "object" },
      risk: "external",
    };
    const request = {
      runId: context.runId,
      nodeId: context.nodeId,
      callId: "call-1",
      turn: 1,
      tool,
      input: {},
    };
    const denied = new NodeRuntimeServices(project);
    expect(await denied.requestToolApproval(request, context)).toMatchObject({ approved: false, source: "policy" });
    await denied.close();

    const approved = new NodeRuntimeServices(project, { approvedToolIds: [tool.id] });
    expect(await approved.requestToolApproval(request, context)).toMatchObject({ approved: true, source: "user" });
    await approved.close();

    let prompted = 0;
    const studioApproved = new NodeRuntimeServices(project, {
      approvedToolIds: [tool.id],
      requestToolApproval: () => {
        prompted += 1;
        return { approved: false, source: "user" };
      },
    });
    expect(await studioApproved.requestToolApproval(request, context)).toMatchObject({ approved: true, source: "user" });
    expect(prompted).toBe(0);
    await studioApproved.close();
  });

  it("binds MCP preapproval to the saved Connection and exact discovered action", async () => {
    const { project, userData } = await temporaryProject();
    const manager = new ConnectionManager(project, { userDataDirectory: userData });
    const profile = await manager.create({
      id: "approval_mcp",
      scope: "project",
      kind: "mcp",
      name: "Approval MCP",
      config: { transport: "http", url: "http://127.0.0.1:43120/mcp" },
    });
    await manager.storeDiscoveredTools(profile.id, [
      { name: "safe-read", inputSchema: { type: "object" } },
      { name: "danger-write", inputSchema: { type: "object" } },
    ]);
    const approvedId = mcpToolApprovalId(profile.id, "safe-read");
    const services = new NodeRuntimeServices(project, {
      connectionManager: manager,
      approvedToolIds: [approvedId],
    });
    const request = {
      runId: context.runId,
      nodeId: context.nodeId,
      callId: "call-mcp",
      turn: 1,
      input: {},
      tool: {
        id: approvedId,
        label: "Safe read",
        description: "Saved MCP Tool",
        inputSchema: { type: "object" },
        risk: "external" as const,
        source: "mcp" as const,
        connectionId: profile.id,
        action: "safe-read",
      },
    };
    expect(await services.requestToolApproval(request, context)).toMatchObject({ approved: true });
    expect(await services.requestToolApproval({
      ...request,
      tool: { ...request.tool, action: "danger-write" },
    }, context)).toMatchObject({ approved: false, source: "policy" });
    await services.close();

    const collision = new NodeRuntimeServices(project, {
      connectionManager: manager,
      approvedToolIds: ["builtin.http"],
    });
    expect(await collision.requestToolApproval({
      ...request,
      tool: { ...request.tool, id: "builtin.http", action: "danger-write" },
    }, context)).toMatchObject({ approved: false, source: "policy" });
    await collision.close();
  });

  it("requires a full stdio launch fingerprint and executes discovered Tools by Connection ID", async () => {
    const { project, userData } = await temporaryProject();
    const manager = new ConnectionManager(project, { userDataDirectory: userData });
    if (process.platform !== "win32") {
      await manager.create({
        id: "stdio_fixture",
        scope: "project",
        kind: "mcp",
        name: "stdio Fixture",
        config: { transport: "stdio", command: executable, args: ["fixture.mjs"] },
      });
      await expect(manager.approveProcess("stdio_fixture")).rejects.toMatchObject({ code: "CREDENTIAL_BACKEND_UNAVAILABLE" });
      return;
    }

    const server = fileURLToPath(new URL("../../../examples/mcp-tool-agent/server.mjs", import.meta.url));
    const engineDirectory = join(project, "fake-mcp-container-engine");
    await mkdir(engineDirectory);
    const engine = join(engineDirectory, "docker.exe");
    await copyFile(process.execPath, engine);
    await writeFile(join(engineDirectory, "image"), `console.log("sha256:${"b".repeat(64)}")\n`, "utf8");
    await writeFile(join(engineDirectory, "run"), `const { spawn } = require("node:child_process")
const serverIndex = process.argv.findIndex((value) => value.endsWith("server.mjs"))
const child = spawn(process.execPath, process.argv.slice(serverIndex), { stdio: "inherit", env: process.env })
child.on("exit", (code) => process.exit(code ?? 1))
`, "utf8");
    await writeFile(join(engineDirectory, "rm"), "process.exit(0)\n", "utf8");
    await manager.create({
      id: "stdio_fixture",
      scope: "project",
      kind: "mcp",
      name: "stdio Fixture",
      config: {
        transport: "stdio",
        sandbox: "container",
        engine,
        image: `fixture@sha256:${"b".repeat(64)}`,
        command: "node",
        args: [server],
        network: "none",
        memoryMb: 128,
        cpus: 0.5,
        pids: 16,
        environmentCredentials: { HARNEST_FIXTURE: "fixtureEnv" },
      },
    }, { fixtureEnv: "first" });
    const profile = await manager.require("stdio_fixture", "mcp");
    await expect(manager.assertProcessApproved(profile)).rejects.toMatchObject({ code: "PROCESS_APPROVAL_REQUIRED" });
    await manager.approveProcess(profile.id);
    await expect(manager.assertProcessApproved(profile)).resolves.toBe(`sha256:${"b".repeat(64)}`);

    const tested = await manager.test(profile.id, { timeoutMs: 10_000 });
    expect(tested.status.state).toBe("connected");
    expect(tested.tools?.map(({ name }) => name)).toEqual(expect.arrayContaining(["lookup-city", "fail-city"]));

    const services = new NodeRuntimeServices(project, {
      connectionManager: manager,
    });
    try {
      await expect(services.callMcpTool({
        connectionId: profile.id,
        tool: "lookup-city",
      }, { city: "Seoul" }, context)).resolves.toMatchObject({
        value: { city: "Seoul", country: "South Korea" },
        metadata: { transport: "stdio", tool: "lookup-city" },
      });

      const binding: ToolBinding = {
        id: "city.lookup",
        action: "lookup-city",
        connectionId: profile.id,
        label: "Lookup city",
        description: "Find a country",
        inputSchema: { type: "object" },
        risk: "read",
        source: "mcp",
      };
      await expect(services.executeTool(binding, { city: "Tokyo" }, context)).resolves.toMatchObject({
        value: { city: "Tokyo", country: "Japan" },
      });
    } finally {
      await services.close();
    }

    await manager.update(profile.id, {}, { fixtureEnv: "second" });
    await expect(manager.assertProcessApproved(await manager.require(profile.id))).rejects.toMatchObject({
      code: "PROCESS_APPROVAL_REQUIRED",
    });
    await manager.approveProcess(profile.id);

    await manager.update(profile.id, {
      config: { ...profile.config, args: [server, "--changed"] },
    });
    await expect(manager.assertProcessApproved(await manager.require(profile.id))).rejects.toMatchObject({
      code: "PROCESS_APPROVAL_REQUIRED",
    });
  }, 30_000);

  it("discovers, tests, and executes a saved Streamable HTTP Connection", async () => {
    const { project, userData } = await temporaryProject();
    const fixture = fileURLToPath(new URL("../../../examples/mcp-tool-agent/http-server.mjs", import.meta.url));
    const child = spawn(process.execPath, [fixture], {
      cwd: project,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const port = await new Promise<number>((resolvePort, reject) => {
      const timeout = setTimeout(() => reject(new Error("HTTP MCP fixture did not start")), 10_000);
      let output = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
        const match = /PORT (\d+)/u.exec(output);
        if (!match?.[1]) return;
        clearTimeout(timeout);
        resolvePort(Number(match[1]));
      });
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`HTTP MCP fixture exited with ${code}`)));
    });
    const host = `127.0.0.1:${port}`;
    const manager = new ConnectionManager(project, { userDataDirectory: userData });
    try {
      await manager.create({
        id: "http_fixture",
        scope: "project",
        kind: "mcp",
        name: "HTTP Fixture",
        config: { transport: "http", protocol: "2026-07-28", url: `http://${host}/mcp` },
      });
      const tested = await manager.test("http_fixture", { allowNetworkHosts: [host], timeoutMs: 10_000 });
      expect(tested.status.state).toBe("connected");
      expect(tested.tools?.map(({ name }) => name)).toContain("lookup-city");

      const services = new NodeRuntimeServices(project, { connectionManager: manager });
      try {
        await expect(services.callMcpTool({
          connectionId: "http_fixture",
          tool: "lookup-city",
        }, { city: "Seoul" }, context)).resolves.toMatchObject({
          value: { city: "Seoul", country: "South Korea" },
          metadata: { transport: "http", tool: "lookup-city" },
        });
        await manager.disconnect("http_fixture");
        await expect(services.callMcpTool({
          connectionId: "http_fixture",
          tool: "lookup-city",
        }, { city: "Tokyo" }, context)).rejects.toThrow("disconnected");
      } finally {
        await services.close();
      }
    } finally {
      if (child.exitCode === null) {
        child.kill();
        await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
      }
    }
  }, 30_000);

  it("persists actionable authentication and scope failure states", async () => {
    const { project, userData } = await temporaryProject();
    let response: "unauthorized" | "scope" = "unauthorized";
    const server = createServer((_request, outgoing) => {
      if (response === "unauthorized") {
        outgoing.writeHead(401, { "www-authenticate": "Bearer" });
      } else {
        outgoing.writeHead(403, {
          "www-authenticate": "Bearer error=\"insufficient_scope\", scope=\"tools:call\"",
        });
      }
      outgoing.end();
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Authentication fixture did not bind");
    const host = `127.0.0.1:${address.port}`;
    const manager = new ConnectionManager(project, { userDataDirectory: userData });
    try {
      await manager.create({
        id: "auth_state_fixture",
        scope: "project",
        kind: "mcp",
        name: "Auth State Fixture",
        config: { transport: "http", url: `http://${host}/mcp` },
      });
      await expect(manager.test("auth_state_fixture", { allowNetworkHosts: [host] })).rejects.toMatchObject({
        code: "CONNECTION_TEST_FAILED",
      });
      expect((await manager.require("auth_state_fixture")).status.state).toBe("needs_auth");

      response = "scope";
      await expect(manager.test("auth_state_fixture", { allowNetworkHosts: [host] })).rejects.toMatchObject({
        code: "CONNECTION_TEST_FAILED",
      });
      expect((await manager.require("auth_state_fixture")).status.state).toBe("insufficient_scope");
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it("revokes refresh and access tokens and preserves pending state when the endpoint fails", async () => {
    const { project, userData } = await temporaryProject();
    if (process.platform !== "win32") return;
    let fail = false;
    const revoked: URLSearchParams[] = [];
    const server = createServer(async (request, outgoing) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      revoked.push(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
      outgoing.statusCode = fail ? 503 : 200;
      outgoing.end();
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Revocation fixture did not bind");
    const host = `127.0.0.1:${address.port}`;
    const issuer = `http://${host}`;
    const discovery = {
      authorizationServerUrl: issuer,
      authorizationServerMetadata: {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        revocation_endpoint: `${issuer}/revoke`,
        response_types_supported: ["code"],
        token_endpoint_auth_methods_supported: ["none"],
      },
    };
    const manager = new ConnectionManager(project, { userDataDirectory: userData });
    const prepare = async (id: string) => {
      await manager.create({
        id,
        scope: "project",
        kind: "mcp",
        name: id,
        config: { transport: "http", url: `${issuer}/mcp`, oauth: true },
      });
      const provider = await manager.oauthProviderFor(id, "http://127.0.0.1:43119/callback");
      await provider.saveDiscoveryState?.(discovery);
      await provider.saveClientInformation?.({ client_id: "fixture-client" }, { issuer });
      await provider.saveTokens?.({
        access_token: `${id}-access`,
        refresh_token: `${id}-refresh`,
        token_type: "bearer",
      }, { issuer });
    };
    try {
      await prepare("revoke_success");
      const disconnected = await manager.disconnect("revoke_success", { revoke: true, allowNetworkHosts: [host] });
      expect(disconnected.status.state).toBe("disconnected");
      expect(revoked.map((body) => body.get("token_type_hint"))).toEqual(["refresh_token", "access_token"]);
      expect(revoked.map((body) => body.get("token"))).toEqual(["revoke_success-refresh", "revoke_success-access"]);

      revoked.length = 0;
      fail = true;
      await prepare("revoke_pending");
      const pending = await manager.disconnect("revoke_pending", { revoke: true, allowNetworkHosts: [host] });
      expect(pending.status.state).toBe("revocation_pending");
      expect(pending.status.message).toContain("HTTP 503");
      const provider = await manager.oauthProviderFor("revoke_pending");
      await expect(provider.tokens?.({ issuer })).resolves.toMatchObject({ access_token: "revoke_pending-access" });
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  }, 30_000);
});
