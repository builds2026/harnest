import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { createConnection, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_COMPONENT_MANIFESTS } from "@harnestai/core";
import { BUILTIN_TOOL_MANIFESTS } from "@harnestai/core/node";
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTHORING_RESOURCES,
  buildAuthoringMcpServer,
  validateHarnessInput,
} from "./authoring-mcp.js";
import { shippedAdapters } from "./registries.js";

const validYaml = `
version: "0.1"
components:
  - id: prompt
    type: prompt
    config: { template: "Answer: {{input}}" }
  - id: model
    type: model
    config: { adapter: openai, model: test-model }
  - id: agent
    type: agent
    config: {}
  - id: output
    type: output
    config: { format: text }
connections:
  - from: { component: model, port: model }
    to: { component: agent, port: model }
  - from: { component: prompt, port: prompt }
    to: { component: agent, port: prompt }
  - from: { component: agent, port: response }
    to: { component: output, port: value }
entrypoint: output
`;

const withTool = (tool: string, connectionId?: string, source?: string): string => validYaml
  .replace('version: "0.1"', 'version: "0.2"')
  .replace(
    "  - id: output",
    `  - id: tool\n    type: tool\n    config: { tool: ${tool}${connectionId ? `, connectionId: ${connectionId}` : ""}${source ? `, source: ${source}` : ""} }\n  - id: output`,
  )
  .replace(
    "entrypoint: output",
    "  - from: { component: tool, port: tool }\n    to: { component: agent, port: tools }\nentrypoint: output",
  );

const roots: string[] = [];
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url));

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  roots.push(directory);
  return directory;
}

async function workspace(): Promise<string> {
  const root = await temporaryDirectory("harnest-authoring-");
  await mkdir(join(root, "project"));
  await writeFile(join(root, "project", "harnest.yaml"), validYaml);
  return root;
}

async function isolatedHttpRequest(options: {
  readonly port: number;
  readonly method: "POST" | "DELETE";
  readonly body: string;
}): Promise<{ readonly status: number; readonly body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port: options.port,
      path: "/mcp",
      method: options.method,
      agent: false,
      headers: {
        "content-type": "application/json",
        "transfer-encoding": "chunked",
        connection: "close",
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", reject);
    request.end(options.body);
  });
}

async function rawHttpRequest(port: number, target: string, method = "GET", body = ""): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let response = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.end([
      `${method} ${target} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      `Content-Length: ${Buffer.byteLength(body)}`,
      "Connection: close",
      "",
      body,
    ].join("\r\n")));
    socket.on("data", (chunk: string) => { response += chunk; });
    socket.once("end", () => resolve(response));
    socket.once("error", reject);
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("authoring validation", () => {
  it("validates inline YAML and a project directory", async () => {
    const root = await workspace();

    await expect(validateHarnessInput({ workspaceRoot: root, yaml: validYaml }))
      .resolves.toMatchObject({ ok: true });
    await expect(validateHarnessInput({ workspaceRoot: root, path: "project" }))
      .resolves.toMatchObject({ ok: true });
  });

  it("validates against the shipped adapter and built-in Tool registries without executing them", async () => {
    const root = await workspace();
    const adapterRuns = shippedAdapters.map((adapter) => vi.spyOn(adapter, "run"));
    try {
      for (const adapter of shippedAdapters) {
        const result = await validateHarnessInput({
          workspaceRoot: root,
          yaml: validYaml.replace("adapter: openai", `adapter: ${adapter.id}`),
        });
        expect(result.diagnostics).not.toContainEqual(expect.objectContaining({ code: "ADAPTER_NOT_REGISTERED" }));
        expect(result.ok).toBe(true);
      }

      const unknownAdapter = await validateHarnessInput({
        workspaceRoot: root,
        yaml: validYaml.replace("adapter: openai", "adapter: builtin-not-shipped"),
      });
      expect(unknownAdapter.diagnostics).toContainEqual(expect.objectContaining({ code: "ADAPTER_NOT_REGISTERED" }));

      const deferredAdapter = await validateHarnessInput({
        workspaceRoot: root,
        yaml: `${validYaml.replace("adapter: openai", "adapter: echo")}runtime:\n  adapters: [./echo-adapter.mjs]\n`,
      });
      expect(deferredAdapter).toMatchObject({
        ok: true,
        setupRequired: { adapters: ["./echo-adapter.mjs"] },
      });
      expect(deferredAdapter.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "AUTHORING_ADAPTER_REGISTRATION_DEFERRED", severity: "warning" }),
        expect.objectContaining({ code: "AUTHORING_ADAPTER_MODULE_VALIDATION_DEFERRED", severity: "warning" }),
      ]));
      expect(deferredAdapter.diagnostics).not.toContainEqual(expect.objectContaining({ code: "ADAPTER_NOT_REGISTERED" }));

      const unknownTool = await validateHarnessInput({
        workspaceRoot: root,
        yaml: `${withTool("builtin.not-shipped", "cannot-make-a-builtin-exist")}runtime:\n  modules: [./tools.mjs]\n`,
      });
      expect(unknownTool.diagnostics).toContainEqual(expect.objectContaining({ code: "TOOL_NOT_REGISTERED" }));
      const unknownClaimedBuiltin = await validateHarnessInput({
        workspaceRoot: root,
        yaml: `${withTool("not-shipped", "cannot-make-a-builtin-exist", "builtin")}runtime:\n  modules: [./tools.mjs]\n`,
      });
      expect(unknownClaimedBuiltin.diagnostics).toContainEqual(expect.objectContaining({ code: "TOOL_NOT_REGISTERED" }));

      const deferredTool = await validateHarnessInput({
        workspaceRoot: root,
        yaml: `${withTool("custom.lookup", undefined, "module")}runtime:\n  modules: [./tools.mjs]\n`,
      });
      expect(deferredTool).toMatchObject({ ok: true, setupRequired: { modules: ["./tools.mjs"] } });
      expect(deferredTool.diagnostics).toContainEqual(expect.objectContaining({
        code: "AUTHORING_TOOL_REGISTRATION_DEFERRED",
        severity: "warning",
      }));

      const missingToolConnection = await validateHarnessInput({ workspaceRoot: root, yaml: withTool("builtin.web-search") });
      expect(missingToolConnection.diagnostics).toContainEqual(expect.objectContaining({
        code: "TOOL_CONNECTION_REQUIRED",
        message: expect.stringContaining("tool-service"),
        hint: expect.stringContaining("tool-service"),
      }));

      const configuredToolConnection = await validateHarnessInput({
        workspaceRoot: root,
        yaml: withTool("builtin.web-search", "web-main"),
      });
      expect(configuredToolConnection).toMatchObject({
        ok: true,
        setupRequired: { connections: ["web-main"] },
      });
      expect(adapterRuns.every((run) => run.mock.calls.length === 0)).toBe(true);
    } finally {
      adapterRuns.forEach((run) => run.mockRestore());
    }
  }, 15_000);

  it("reports shipped adapter default credential names as later setup without reading the environment", async () => {
    const root = await workspace();
    const result = await validateHarnessInput({ workspaceRoot: root, yaml: validYaml });

    expect(result).toMatchObject({
      ok: true,
      setupRequired: { environmentVariables: ["OPENAI_API_KEY"] },
    });
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({ code: "ENV_MISSING" }));
  });

  it("keeps placeholders structurally valid but warns that runtime configuration remains", async () => {
    const root = await workspace();
    const result = await validateHarnessInput({
      workspaceRoot: root,
      yaml: validYaml.replace("model: test-model", "model: USER_CONFIGURES_MODEL"),
    });

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "AUTHORING_CONFIGURATION_REQUIRED",
      componentId: "model",
      path: "$.components[1].config.model",
      severity: "warning",
    }));
    expect(result.checks).toContain("Declared tests, Connections, credentials, models, Tools, and interactions were not executed");
  });

  it("returns useful diagnostics for malformed and invalid HarnessSpec YAML", async () => {
    const root = await workspace();
    const secret = "sk-malformed-MUST-NOT-LEAK-2f7a";
    const malformed = await validateHarnessInput({ workspaceRoot: root, yaml: `version: [\napiKey: ${secret}` });
    const invalid = await validateHarnessInput({
      workspaceRoot: root,
      yaml: 'version: "0.1"\ncomponents: [{ id: bad, type: unknown, config: {} }]\nentrypoint: missing\n',
    });

    expect(malformed).toMatchObject({ ok: false });
    expect(invalid).toMatchObject({ ok: false });
    expect(JSON.stringify([malformed, invalid])).toMatch(/error|diagnostic|invalid|required/i);
    expect(JSON.stringify(malformed)).not.toContain(secret);
  });

  it("rejects traversal and symlink escapes from the configured workspace", async () => {
    const root = await workspace();
    const outside = await temporaryDirectory("harnest-outside-");
    await writeFile(join(outside, "harnest.yaml"), validYaml);
    await symlink(outside, join(root, "escape"), "dir");

    await expect(validateHarnessInput({ workspaceRoot: root, path: join("..", outside.split("/").at(-1) ?? "outside") }))
      .resolves.toMatchObject({ ok: false, diagnostics: [expect.objectContaining({ code: "AUTHORING_PATH_OUTSIDE_WORKSPACE" })] });
    await expect(validateHarnessInput({ workspaceRoot: root, path: "escape" }))
      .resolves.toMatchObject({ ok: false, diagnostics: [expect.objectContaining({ code: "AUTHORING_PATH_OUTSIDE_WORKSPACE" })] });
  });

  it("redacts absolute diagnostic paths to workspace-relative paths", async () => {
    const root = await workspace();
    await writeFile(join(root, "project", "harnest.yaml"), "#".repeat(1_048_577));

    const result = await validateHarnessInput({ workspaceRoot: root, path: "project" });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "FILE_READ",
      path: "./project/harnest.yaml",
    }));
    expect(JSON.stringify(result)).not.toContain(root);
  });

  it("reports secret-later setup names without reading their values", async () => {
    const root = await workspace();
    const secret = "sk-test-DO-NOT-LEAK-71d69f";
    const configuredYaml = validYaml
      .replace('version: "0.1"', 'version: "0.2"')
      .replace("adapter: openai, model: test-model", "adapter: openai, model: test-model, apiKey: env:OPENAI_API_KEY, connectionId: provider-main");
    await writeFile(join(root, "project", "harnest.yaml"), configuredYaml);
    await writeFile(join(root, "project", ".env"), `OPENAI_API_KEY=${secret}\n`);

    const result = await validateHarnessInput({ workspaceRoot: root, path: "project" });
    expect(result).toMatchObject({
      ok: true,
      setupRequired: {
        environmentVariables: ["OPENAI_API_KEY"],
        connections: ["provider-main"],
      },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("rejects obvious credential literals without returning their values", async () => {
    const root = await workspace();
    const secret = "sk-valid-config-MUST-NOT-BE-ACCEPTED-12345";
    const result = await validateHarnessInput({
      workspaceRoot: root,
      yaml: validYaml.replace("Answer: {{input}}", `Answer with ${secret}: {{input}}`),
    });

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({
        code: "SECRET_LITERAL",
        path: "$.components[0].config.template",
      })],
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("scans materialized prompt and test strings", async () => {
    const root = await workspace();
    const promptSecret = "sk-bound-prompt-MUST-NOT-BE-ACCEPTED-12345";
    const testSecret = "Bearer bound-test-credential-1234567890";
    await mkdir(join(root, "project", ".harnest", "prompts"), { recursive: true });
    await mkdir(join(root, "project", ".harnest", "tests"), { recursive: true });
    await writeFile(join(root, "project", ".harnest", "project.json"), JSON.stringify({
      version: 1,
      harness: "harnest.yaml",
      bindings: [{ kind: "prompt", component: "prompt", path: "prompts/main.md" }],
      tests: ["tests/smoke.json"],
    }));
    await writeFile(join(root, "project", ".harnest", "prompts", "main.md"), promptSecret);
    await writeFile(join(root, "project", ".harnest", "tests", "smoke.json"), JSON.stringify([{
      id: "smoke",
      input: testSecret,
      assertion: { type: "includes", value: "ok" },
    }]));

    const result = await validateHarnessInput({ workspaceRoot: root, path: "project" });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SECRET_LITERAL", path: "$.components[0].config.template" }),
      expect.objectContaining({ code: "SECRET_LITERAL", path: "$.tests[0].input" }),
    ]));
    expect(JSON.stringify(result)).not.toContain(promptSecret);
    expect(JSON.stringify(result)).not.toContain(testSecret);
  });

  it("does not expose credential-shaped model or Connection values through authoring metadata", async () => {
    const root = await workspace();
    const secrets = [
      "sk-secret-model-MUST-NOT-LEAK-123456789",
      "sk-secret-connection-MUST-NOT-LEAK-12345",
    ];
    const yaml = validYaml
      .replace('version: "0.1"', 'version: "0.2"')
      .replace(
        "adapter: openai, model: test-model",
        `adapter: openai, model: ${secrets[0]}, connectionId: ${secrets[1]}`,
      );

    const result = await validateHarnessInput({ workspaceRoot: root, yaml });
    expect(result).toMatchObject({
      ok: false,
      setupRequired: { environmentVariables: [], connections: [], adapters: [], modules: [] },
    });
    expect(result.summary).toBeUndefined();
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SECRET_LITERAL", path: "$.components[1].config.model" }),
      expect.objectContaining({ code: "SECRET_LITERAL", path: "$.components[1].config.connectionId" }),
    ]));
    for (const secret of secrets) expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("redacts credential literals interpolated by other validation diagnostics", async () => {
    const root = await workspace();
    const secret = "sk-unknown-component-must-not-leak-123456789";
    const yaml = validYaml
      .replace('version: "0.1"', 'version: "0.2"')
      .replace("type: model", `type: ${secret}`);

    const result = await validateHarnessInput({ workspaceRoot: root, yaml });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "COMPONENT_NOT_REGISTERED",
      message: expect.stringContaining("<redacted-credential>"),
    }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "SECRET_LITERAL",
      path: "$.components[1].type",
    }));
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("allows benign prompt prose, placeholders, env references, Connection IDs, and credential-free URLs", async () => {
    const root = await workspace();
    const benignYaml = validYaml
      .replace('version: "0.1"', 'version: "0.2"')
      .replace(
        "Answer: {{input}}",
        "Explain why API keys and Bearer credentials stay private. Examples: sk-YOUR_API_KEY, sk-xxxxxxxxxxxxxxxx, and Bearer {{ACCESS_TOKEN}}. Docs: https://api.example.com/v1.",
      )
      .replace(
        "adapter: openai, model: test-model",
        "adapter: openai, model: test-model, apiKey: env:OPENAI_API_KEY, connectionId: provider-main",
      );

    const result = await validateHarnessInput({ workspaceRoot: root, yaml: benignYaml });
    expect(result.ok).toBe(true);
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({ code: "SECRET_LITERAL" }));
  });
});

describe("authoring MCP protocol surface", () => {
  it("publishes readable authoring resources, a design prompt, and validation tool", async () => {
    const root = await workspace();
    const server = buildAuthoringMcpServer({ workspaceRoot: root });
    const client = new Client({ name: "authoring-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listedResources = await client.listResources();
      const configuredUris = AUTHORING_RESOURCES.map((resource) => resource.uri);
      const documentation: string[] = [];
      expect(configuredUris.length).toBeGreaterThan(3);
      expect(listedResources.resources.map((resource) => resource.uri)).toEqual(expect.arrayContaining(configuredUris));

      for (const uri of configuredUris) {
        const read = await client.readResource({ uri });
        documentation.push(JSON.stringify(read.contents));
        expect(read.contents.length).toBeGreaterThan(0);
        expect(JSON.stringify(read.contents).length).toBeGreaterThan(80);
      }

      const components = JSON.stringify(await client.readResource({ uri: "harnest://docs/components" }));
      for (const component of BUILTIN_COMPONENT_MANIFESTS) expect(components).toContain("## `" + component.type + "` —");

      const builtinTools = JSON.stringify(await client.readResource({ uri: "harnest://docs/builtin-tools" }));
      for (const tool of BUILTIN_TOOL_MANIFESTS) expect(builtinTools).toContain("## `" + tool.id + "` —");

      const runtimeDocs = documentation.join("\n");
      for (const topic of [
        "port", "edge", "condition", "state", "subgraph", "loop", "team", "retry", "budget", "trace", "snapshot", "SSE",
        "context", "memory", "PKM", "cache", "citation", "provider", "connection", "skill", "evaluator", "artifact",
      ])
        expect(runtimeDocs).toMatch(new RegExp(topic, "i"));
      for (const interaction of ["select", "input", "form", "file", "oauth", "permission"])
        expect(runtimeDocs).toMatch(new RegExp(`\\b${interaction}\\b`, "i"));
      for (const decision of ["allow_once", "allow_for_run", "allow_always", "deny"])
        expect(runtimeDocs).toContain(decision);

      const schemaResource = await client.readResource({ uri: "harnest://schema/harness-spec.json" });
      const schema = JSON.parse(String(schemaResource.contents[0] && "text" in schemaResource.contents[0] ? schemaResource.contents[0].text : "")) as Record<string, unknown>;
      expect(schema).toMatchObject({ $id: "harnest://schema/harness-spec.json", $schema: expect.stringContaining("2020-12") });

      const prompts = await client.listPrompts();
      expect(prompts.prompts.length).toBeGreaterThan(0);
      const designPrompt = prompts.prompts.find((prompt) => /design|author|harness/i.test(prompt.name));
      expect(designPrompt).toBeDefined();
      const prompt = await client.getPrompt({ name: designPrompt!.name, arguments: { requirement: "Build a support agent" } });
      expect(prompt.messages.length).toBeGreaterThan(0);
      expect(JSON.stringify(prompt)).toContain("do not silently substitute another ID");
      expect(JSON.stringify(prompt)).toContain("Declarative tests cannot inject host permission decisions");

      const tools = await client.listTools();
      const validateTool = tools.tools.find((tool) => /validate.*harness|harness.*validate/i.test(tool.name));
      expect(validateTool).toBeDefined();
      const result = await client.callTool({ name: validateTool!.name, arguments: { path: "project" } });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result)).toContain('"ok":true');
      expect(JSON.stringify(result)).not.toMatch(/sk-test-/);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("hardens the built CLI Streamable HTTP endpoint without breaking MCP clients", async () => {
    const root = await workspace();
    const reservation = createServer();
    await new Promise<void>((resolve, reject) => {
      reservation.once("error", reject);
      reservation.listen(0, "127.0.0.1", resolve);
    });
    const port = (reservation.address() as AddressInfo).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const child = spawn(process.execPath, [
      cli, "mcp", "serve", root, "--transport", "http", "--port", String(port),
      "--host", "0.0.0.0", "--allowed-host", "127.0.0.1",
      "--allowed-origin", "browser.example",
    ], { cwd: repositoryRoot, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const client = new Client({ name: "authoring-http-test", version: "1.0.0" });
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`MCP HTTP server did not start: ${stderr}`)), 10_000);
        const ready = () => {
          if (!stderr.includes("Harnest authoring MCP ready")) return;
          clearTimeout(timeout);
          child.stderr.off("data", ready);
          resolve();
        };
        child.stderr.on("data", ready);
        child.once("error", reject);
        child.once("exit", (code) => reject(new Error(`MCP HTTP server exited early (${code}): ${stderr}`)));
        ready();
      });

      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(health.status).toBe(200);
      await expect(health.json()).resolves.toEqual({ ok: true, service: "harnest-authoring-mcp" });
      expect((await fetch(`http://127.0.0.1:${port}/not-mcp`)).status).toBe(404);

      const badHostStatus = await new Promise<number>((resolve, reject) => {
        const request = httpRequest({ host: "127.0.0.1", port, path: "/mcp", headers: { host: "attacker.example" } }, (response) => {
          response.resume();
          response.once("end", () => resolve(response.statusCode ?? 0));
        });
        request.once("error", reject);
        request.end();
      });
      expect(badHostStatus).toBe(403);
      const badOrigin = await fetch(`http://127.0.0.1:${port}/mcp`, { headers: { origin: "https://attacker.example" } });
      expect(badOrigin.status).toBe(403);

      const unsafeTargets = [
        "//evil.example/mcp",
        `http://127.0.0.1:${port}/mcp`,
        "/mcp?session=attacker",
        "/mcp#fragment",
        "/mcp/../mcp",
        "/m%63p",
        "/health?probe=1",
      ];
      for (const target of unsafeTargets) {
        const rawResponse = await rawHttpRequest(port, target, "POST", "{}");
        expect(rawResponse, target).toMatch(/^HTTP\/1\.1 404 /);
        expect(rawResponse, target).toContain('{"error":"Not found"}');
        expect(rawResponse, target).not.toContain('"jsonrpc"');
      }
      await expect(fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json()))
        .resolves.toEqual({ ok: true, service: "harnest-authoring-mcp" });

      const marker = "RAW-BODY-MUST-NOT-ECHO";
      const malformed = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://browser.example:8443" },
        body: `{${marker}`,
      });
      expect(malformed.status).toBe(400);
      const malformedText = await malformed.text();
      expect(JSON.parse(malformedText)).toMatchObject({ error: { code: -32700, message: "Parse error" }, id: null });
      expect(malformedText).not.toContain(marker);

      const encoded = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", "content-encoding": "gzip" },
        body: "not-really-gzip",
      });
      expect(encoded.status).toBe(415);

      const oversizedBody = JSON.stringify({ marker, padding: "x".repeat(2 * 1_048_576) });
      const oversized = await isolatedHttpRequest({ port, method: "POST", body: oversizedBody });
      expect(oversized.status).toBe(413);
      expect(oversized.body).not.toContain(marker);
      const oversizedDelete = await isolatedHttpRequest({ port, method: "DELETE", body: oversizedBody });
      expect(oversizedDelete.status).toBe(413);

      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
      expect(client.getServerVersion()).toEqual({ name: "harnest-authoring", version: "0.2.0-beta.3" });
      const resources = await client.listResources();
      expect(resources.resources.map(({ uri }) => uri)).toContain("harnest://docs/index");
      await expect(client.readResource({ uri: "harnest://docs/index" })).resolves.toMatchObject({
        contents: [expect.objectContaining({ uri: "harnest://docs/index", text: expect.stringContaining("Harnest") })],
      });

      const validated = await client.callTool({ name: "validate_harness_project", arguments: { path: "project" } });
      expect(validated.isError).not.toBe(true);
      expect(validated.structuredContent).toMatchObject({ ok: true, specVersion: "0.1" });
    } finally {
      await client.close();
      child.kill("SIGTERM");
      if (child.exitCode === null) await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
  }, 30_000);
});
