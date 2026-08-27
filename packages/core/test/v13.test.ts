import { describe, expect, it } from "vitest";
import { describeHarness, type HarnessSpec } from "../src/index.js";

describe("v1.3 Integration Contract", () => {
  it("describes portable capabilities without exposing provider secrets", () => {
    const spec = {
      version: "0.2",
      components: [
        { id: "model", type: "model", config: { adapter: "gemini", model: "gemini-2.5-flash", connectionId: "gemini-main", apiKey: "never-print-me" } },
        { id: "prompt", type: "prompt", config: { template: "{{input}}" } },
        { id: "runner", type: "tool", config: { tool: "builtin.code-runner", source: "builtin", risk: "external", connectionId: "sandbox-main" } },
        { id: "agent", type: "agent", config: {} },
        { id: "output", type: "output", config: { format: "json", schema: { type: "object" } } },
      ],
      connections: [
        { from: { component: "model", port: "model" }, to: { component: "agent", port: "model" } },
        { from: { component: "prompt", port: "prompt" }, to: { component: "agent", port: "prompt" } },
        { from: { component: "runner", port: "tool" }, to: { component: "agent", port: "tools" } },
        { from: { component: "agent", port: "response" }, to: { component: "output", port: "value" } },
      ],
      entrypoint: "output",
      runtime: { timeoutMs: 30_000, retry: { maxAttempts: 2 }, budget: { maxTokens: 8_000, maxCostUsd: 1 } },
      tests: [{ id: "shape", input: "hello", assertions: [{ type: "output-schema", schema: { type: "object" } }] }],
    } satisfies HarnessSpec;

    const contract = describeHarness(spec);
    expect(contract.capabilities).toEqual(expect.arrayContaining(["conversation", "file-attachments", "code-sandbox", "artifacts", "evaluation"]));
    expect(contract.requiredConnections).toEqual(["gemini-main", "sandbox-main"]);
    expect(contract.plan).toEqual({
      nodeCount: 5,
      edgeCount: 4,
      layerCount: 3,
      entrypoint: "output",
      sourceVersion: "0.2",
      timeoutMs: 30_000,
    });
    expect(contract.output).toEqual({ component: "output", format: "json", schemaDeclared: true });
    expect(contract.policy).toEqual({ timeoutMs: 30_000, retryAttempts: 2, maxTokens: 8_000, maxCostUsd: 1 });
    expect(contract.integrationSurfaces.map(({ id }) => id)).toEqual(["sdk", "cli", "http"]);
    expect(JSON.stringify(contract)).not.toContain("never-print-me");
  });

  it("includes remote Agent Template connections once in sorted order", () => {
    const spec = {
      version: "0.3",
      components: [
        { id: "tool", type: "tool", config: { tool: "fixture", connectionId: "shared" } },
        { id: "output", type: "output", config: {} },
      ],
      connections: [],
      entrypoint: "output",
      agentTemplates: {
        remote: { description: "Remote agent", runner: { a2a: { connection: "remote" } } },
        duplicate: { description: "Shared remote agent", runner: { a2a: { connection: "shared" } } },
      },
    } satisfies HarnessSpec;

    expect(describeHarness(spec).requiredConnections).toEqual(["remote", "shared"]);
  });
});
