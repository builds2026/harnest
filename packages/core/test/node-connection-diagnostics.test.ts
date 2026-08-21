import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ToolRegistry, type HarnessSpecV02 } from "../src/index.js";
import { NodeRuntimeServices } from "../src/node.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Node Connection diagnostics", () => {
  it("rejects missing, unavailable, wrong-kind, and wrong-transport graph bindings", async () => {
    const project = await mkdtemp(join(tmpdir(), "harnest-connection-diagnostics-"));
    roots.push(project);
    await mkdir(join(project, ".harnest"));
    const timestamp = new Date(0).toISOString();
    await writeFile(join(project, ".harnest", "connections.json"), JSON.stringify({
      version: 1,
      connections: [
        {
          id: "provider_disconnected", scope: "project", kind: "provider", name: "Disconnected provider",
          config: { adapter: "openai", model: "fixture" }, credentialFields: [], status: { state: "disconnected" },
          createdAt: timestamp, updatedAt: timestamp,
        },
        {
          id: "provider_ready", scope: "project", kind: "provider", name: "Provider",
          config: { adapter: "openai", model: "fixture" }, credentialFields: [], status: { state: "unknown" },
          createdAt: timestamp, updatedAt: timestamp,
        },
        {
          id: "mcp_stdio", scope: "project", kind: "mcp", name: "stdio MCP",
          config: { transport: "stdio", command: process.execPath, args: [] }, credentialFields: [], status: { state: "unknown" },
          createdAt: timestamp, updatedAt: timestamp,
        },
      ],
    }), "utf8");

    const tools = new ToolRegistry().register({
      id: "remote.lookup",
      label: "Remote lookup",
      description: "HTTP MCP only",
      inputSchema: { type: "object" },
      connectionKinds: ["mcp-http"],
      execute: () => null,
    });
    const spec: HarnessSpecV02 = {
      version: "0.2",
      components: [
        { id: "missing", type: "model", config: { connectionId: "missing_provider" } },
        { id: "disconnected", type: "model", config: { connectionId: "provider_disconnected" } },
        { id: "wrongModelKind", type: "model", config: { connectionId: "mcp_stdio" } },
        { id: "wrongMcpKind", type: "mcp-tool", config: { connectionId: "provider_ready", tool: "lookup" } },
        { id: "wrongTransport", type: "tool", config: { tool: "remote.lookup", connectionId: "mcp_stdio" } },
        { id: "validMcp", type: "mcp-tool", config: { connectionId: "mcp_stdio", tool: "lookup" } },
      ],
      connections: [],
      entrypoint: "missing",
    };
    const services = new NodeRuntimeServices(project);
    try {
      const diagnostics = await services.connectionDiagnostics(spec, tools);
      expect(diagnostics.map(({ code, componentId }) => [code, componentId])).toEqual([
        ["CONNECTION_NOT_FOUND", "missing"],
        ["CONNECTION_DISCONNECTED", "disconnected"],
        ["CONNECTION_TYPE_MISMATCH", "wrongModelKind"],
        ["CONNECTION_TYPE_MISMATCH", "wrongMcpKind"],
        ["CONNECTION_TYPE_MISMATCH", "wrongTransport"],
      ]);
      expect(diagnostics.find(({ componentId }) => componentId === "wrongTransport")?.message).toContain("mcp-stdio");
    } finally {
      await services.close();
    }
  });
});
