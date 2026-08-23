import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ServiceExecutionContext } from "../src/index.js";
import { NodeRuntimeServices } from "../src/node.js";

const context: ServiceExecutionContext = {
  signal: new AbortController().signal,
  runId: "raw-mcp-test",
  nodeId: "mcp-node",
  iteration: 0,
  resolveSecret: () => undefined,
};

describe("NodeRuntimeServices MCP boundary", () => {
  it("fails closed for legacy raw stdio MCP without an OS sandbox", async () => {
    const project = fileURLToPath(new URL("../../../examples/mcp-tool-agent/", import.meta.url));
    const services = new NodeRuntimeServices(project, { allowProcessCommands: ["node"] });
    try {
      await expect(services.callMcpTool({
        transport: "stdio",
        protocol: "legacy",
        command: "node",
        args: ["server.mjs"],
        tool: "lookup-city",
      }, { city: "Seoul" }, context)).rejects.toThrow("Raw MCP stdio is disabled");
    } finally {
      await services.close();
    }
  });

  it("preserves reviewed v1.1 raw Streamable HTTP behind an exact host allowlist", async () => {
    const project = fileURLToPath(new URL("../../../examples/mcp-tool-agent/", import.meta.url));
    const child = spawn(process.execPath, [join(project, "http-server.mjs")], {
      cwd: project,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const port = await new Promise<number>((resolvePort, reject) => {
      const timer = setTimeout(() => reject(new Error("Raw HTTP MCP fixture did not start")), 10_000);
      let output = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
        const match = /PORT (\d+)/.exec(output);
        if (match) {
          clearTimeout(timer);
          resolvePort(Number(match[1]));
        }
      });
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`Raw HTTP MCP fixture exited with ${code}`)));
    });
    const host = `127.0.0.1:${port}`;
    const services = new NodeRuntimeServices(project, { allowNetworkHosts: [host] });
    try {
      await expect(services.callMcpTool({
        transport: "http",
        protocol: "2026-07-28",
        url: `http://${host}/mcp`,
        tool: "lookup-city",
      }, { city: "Seoul" }, { ...context, nodeId: "mcp-http-node" })).resolves.toMatchObject({
        value: { city: "Seoul", country: "South Korea" },
        metadata: { transport: "http", tool: "lookup-city", isError: false },
      });
    } finally {
      await services.close();
      if (child.exitCode === null) {
        const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
        child.kill();
        await exited;
      }
    }
  }, 30_000);
});
