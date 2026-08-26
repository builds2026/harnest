import type { HarnessSpec } from "@harnestai/core";
import { describe, expect, it } from "vitest";
import {
  hostCapabilityDiagnosticsFor,
  runtimeServiceOptionsFor,
  studioCapabilityPolicy,
} from "./runtime-config";

describe("Studio runtime capability scoping", () => {
  it("keeps file roots graph-aware and passes host allowlists for Connection-backed execution", () => {
    const spec = {
      version: "0.2",
      components: [
        { id: "docs", type: "context", config: { source: "directory", path: "docs" } },
        { id: "remote", type: "mcp-tool", config: { transport: "http", url: "https://MCP.example.test/rpc", tool: "search" } },
      ],
      connections: [],
      entrypoint: "remote",
      subgraphs: {
        worker: {
          components: [{ id: "local", type: "mcp-tool", config: { transport: "stdio", command: "approved-mcp", tool: "read" } }],
          connections: [],
          entrypoint: "local",
        },
      },
    } satisfies HarnessSpec;

    expect(runtimeServiceOptionsFor(spec)).toEqual({});
    expect(hostCapabilityDiagnosticsFor(spec, studioCapabilityPolicy({})).map((diagnostic) => diagnostic.code)).toEqual([
      "HOST_FILE_CAPABILITY_DENIED",
      "HOST_NETWORK_CAPABILITY_DENIED",
      "HOST_PROCESS_CAPABILITY_DENIED",
    ]);
    expect(runtimeServiceOptionsFor(spec, {
      allowModules: false,
      allowFiles: true,
      contextRoots: ["docs"],
      processCommands: ["approved-mcp", "not-in-spec"],
      networkHosts: ["mcp.example.test", "not-in-spec.example"],
      approvedToolIds: ["saved.read"],
    })).toEqual({
      allowFileSystem: true,
      allowedContextRoots: ["docs"],
      allowProcessCommands: ["approved-mcp", "not-in-spec"],
      allowNetworkHosts: ["mcp.example.test", "not-in-spec.example"],
      approvedToolIds: ["saved.read"],
    });
    expect(hostCapabilityDiagnosticsFor(spec, {
      allowModules: false,
      allowFiles: true,
      contextRoots: ["docs"],
      processCommands: ["approved-mcp"],
      networkHosts: ["mcp.example.test"],
      approvedToolIds: [],
    })).toEqual([]);
  });

  it("keeps all external capabilities closed for a pure graph", () => {
    const spec = {
      version: "0.2",
      components: [{ id: "prompt", type: "prompt", config: { template: "{{input}}" } }],
      connections: [],
      entrypoint: "prompt",
    } satisfies HarnessSpec;

    expect(runtimeServiceOptionsFor(spec)).toEqual({});
  });

  it("requires exact host environment opt-ins", () => {
    expect(studioCapabilityPolicy({
      HARNEST_ALLOW_MODULES: "true",
      HARNEST_ALLOW_FILES: "yes",
      HARNEST_CONTEXT_ROOTS: "docs, knowledge",
      HARNEST_ALLOW_PROCESS: "approved-mcp, second",
      HARNEST_ALLOW_NETWORK: "MCP.EXAMPLE.TEST, localhost:3333",
      HARNEST_APPROVE_TOOLS: "saved.read, saved.write",
    })).toEqual({
      allowModules: false,
      allowFiles: false,
      contextRoots: ["docs", "knowledge"],
      processCommands: ["approved-mcp", "second"],
      networkHosts: ["mcp.example.test", "localhost:3333"],
      approvedToolIds: ["saved.read", "saved.write"],
    });
    expect(studioCapabilityPolicy({ HARNEST_ALLOW_MODULES: "1", HARNEST_ALLOW_FILES: "1" }))
      .toMatchObject({ allowModules: true, allowFiles: true });
  });
});
