import { describe, expect, it } from "vitest";
import type { HarnessSpec } from "@harnest/core";
import { applyPlaygroundOverrides, filePreview, playgroundCapabilities } from "./playground";

const spec = (): HarnessSpec => ({
  version: "0.2",
  components: [
    { id: "model", type: "model", config: { connectionId: "gemini", fallbackConnectionId: "local", model: "gemini-test" } },
    { id: "runner", type: "tool", config: { tool: "builtin.code-runner", connectionId: "python" } },
    { id: "search", type: "tool", config: { tool: "builtin.web-search", connectionId: "firecrawl" } },
    { id: "agent", type: "agent", config: {} },
  ],
  connections: [
    { from: { component: "model", port: "model" }, to: { component: "agent", port: "model" } },
    { from: { component: "runner", port: "tool" }, to: { component: "agent", port: "tools" } },
    { from: { component: "search", port: "tool" }, to: { component: "agent", port: "tools" } },
  ],
  entrypoint: "agent",
  subgraphs: {
    helper: {
      components: [
        { id: "runner", type: "tool", config: { tool: "builtin.code-runner", connectionId: "node" } },
        { id: "agent", type: "agent", config: {} },
      ],
      connections: [{ from: { component: "runner", port: "tool" }, to: { component: "agent", port: "tools" } }],
      entrypoint: "agent",
    },
  },
});

describe("Playground harness projection", () => {
  it("exposes only declared capabilities and applies scoped overrides to a clone", () => {
    const original = spec();
    const capabilities = playgroundCapabilities(original);
    expect(capabilities.attachments.enabled).toBe(true);
    expect(capabilities.models.map(({ connectionId }) => connectionId)).toEqual(["gemini", "local"]);
    expect(capabilities.plugins.map(({ componentKey }) => componentKey)).toContain("subgraph:helper/runner");

    const changed = applyPlaygroundOverrides(original, {
      disabledPluginKeys: ["root/runner"],
      model: { componentKey: "root/model", connectionId: "local" },
    });
    expect(changed.version).toBe("0.2");
    if (changed.version !== "0.2") throw new Error("fixture version changed");
    expect(changed.components.some(({ id }) => id === "runner")).toBe(false);
    expect(changed.connections.some(({ from }) => from.component === "runner")).toBe(false);
    expect(changed.subgraphs?.helper?.components.some(({ id }) => id === "runner")).toBe(true);
    expect(changed.components.find(({ id }) => id === "model")?.config.connectionId).toBe("local");
    expect(original).toEqual(spec());
    expect(() => applyPlaygroundOverrides(original, { disabledPluginKeys: ["root/not-installed"] })).toThrow(/not part/);
  });

  it("does not advertise unsupported v0.1 attachments and classifies safe previews", () => {
    const legacy: HarnessSpec = {
      version: "0.1",
      components: [{ id: "model", type: "model", config: { adapter: "local", model: "test" } }],
      connections: [],
      entrypoint: "model",
    };
    expect(playgroundCapabilities(legacy).attachments.enabled).toBe(false);
    expect(filePreview("image/png", "plot.png")).toBe("image");
    expect(filePreview("image/svg+xml", "unsafe.svg")).toBe("none");
    expect(filePreview("application/octet-stream", "report.csv")).toBe("text");
  });
});
