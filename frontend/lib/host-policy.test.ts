import { describe, expect, it } from "vitest";
import { studioRestartCommand } from "./host-policy";

describe("Studio host policy guidance", () => {
  it("preserves current policy and adds exact least-privilege spec requirements", () => {
    const command = studioRestartCommand("my harness.yaml", "3100", {
      version: "0.3",
      components: [
        { id: "context", type: "context", config: { source: "file", path: "docs/guide.md" } },
        { id: "stdio", type: "mcp-tool", config: { transport: "stdio", command: "npx", args: ["server"] } },
        { id: "http", type: "mcp-tool", config: { transport: "http", url: "https://MCP.example.test/tools" } },
      ],
      connections: [],
      entrypoint: "context",
      runtime: { modules: ["./runtime.mjs"] },
    }, {
      allowModules: false,
      allowFiles: false,
      contextRoots: ["knowledge"],
      processCommands: [],
      networkHosts: [],
      approvedToolIds: ["custom.review"],
    });
    expect(command).toBe("harnest studio 'my harness.yaml' --port 3100 --allow-modules --allow-files --context-root knowledge --context-root docs/guide.md --allow-process npx --allow-network mcp.example.test --approve-tool custom.review");
  });
});
