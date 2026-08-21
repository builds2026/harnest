import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceExecutionContext } from "../src/index.js";

interface MockMcpResult {
  readonly content: unknown[];
  readonly isError?: boolean;
  readonly structuredContent?: unknown;
}

type MockFunction = ReturnType<typeof vi.fn>;

const mcp = vi.hoisted(() => ({
  clients: [] as Array<{ readonly callTool: MockFunction; readonly close: MockFunction }>,
  outcomes: [] as Array<Error | MockMcpResult>,
}));

vi.mock("@modelcontextprotocol/client", () => {
  class StreamableHTTPClientTransport {
    sessionId?: string;
    readonly terminateSession = vi.fn(async () => undefined);
  }

  class Client {
    readonly callTool = vi.fn(async () => {
      const outcome = mcp.outcomes.shift();
      if (!outcome) throw new Error("Missing mocked MCP outcome");
      if (outcome instanceof Error) throw outcome;
      return outcome;
    });
    readonly close = vi.fn(async () => undefined);
    readonly connect = vi.fn(async () => undefined);
    readonly listTools = vi.fn(async () => ({ tools: [{ name: "fixture-tool" }] }));
    readonly getNegotiatedProtocolVersion = vi.fn(() => "test-protocol");

    constructor() {
      mcp.clients.push(this);
    }
  }

  return { Client, StreamableHTTPClientTransport };
});

vi.mock("@modelcontextprotocol/client/stdio", () => ({
  getDefaultEnvironment: () => ({}),
  StdioClientTransport: class StdioClientTransport {},
}));

import { NodeRuntimeServices } from "../src/node.js";

const config = {
  transport: "stdio",
  command: "fixture-command",
  tool: "fixture-tool",
} as const;

const context: ServiceExecutionContext = {
  signal: new AbortController().signal,
  runId: "mcp-cache-test",
  nodeId: "mcp-node",
  iteration: 0,
  resolveSecret: () => undefined,
};

const success = (value: unknown): MockMcpResult => ({ content: [], structuredContent: value });

describe("NodeRuntimeServices MCP connection cache", () => {
  beforeEach(() => {
    mcp.clients.length = 0;
    mcp.outcomes.length = 0;
  });

  it("closes and evicts a connection when callTool throws, then reconnects without retrying", async () => {
    mcp.outcomes.push(new Error("transport dropped"), success({ recovered: true }));
    const services = new NodeRuntimeServices(process.cwd(), {
      allowProcessCommands: [config.command],
    });

    try {
      await expect(services.callMcpTool(config, {}, context)).rejects.toThrow("transport dropped");
      expect(mcp.clients).toHaveLength(1);
      expect(mcp.clients[0]?.callTool).toHaveBeenCalledTimes(1);
      expect(mcp.clients[0]?.close).toHaveBeenCalledTimes(1);

      await expect(services.callMcpTool(config, {}, context)).resolves.toMatchObject({
        value: { recovered: true },
      });
      expect(mcp.clients).toHaveLength(2);
      expect(mcp.clients[1]?.callTool).toHaveBeenCalledTimes(1);
    } finally {
      await services.close();
    }
  });

  it("keeps the connection cached for a normal MCP isError result", async () => {
    mcp.outcomes.push(
      { content: [], isError: true },
      success({ reused: true }),
    );
    const services = new NodeRuntimeServices(process.cwd(), {
      allowProcessCommands: [config.command],
    });

    try {
      await expect(services.callMcpTool(config, {}, context)).rejects.toThrow("returned an error result");
      expect(mcp.clients).toHaveLength(1);
      expect(mcp.clients[0]?.close).not.toHaveBeenCalled();

      await expect(services.callMcpTool(config, {}, context)).resolves.toMatchObject({
        value: { reused: true },
      });
      expect(mcp.clients).toHaveLength(1);
      expect(mcp.clients[0]?.callTool).toHaveBeenCalledTimes(2);
    } finally {
      await services.close();
    }
  });
});
