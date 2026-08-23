import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { saveSpecFile } from "@harnest/core/node";
import type { HarnessSpec, ModelAdapter } from "@harnest/core";
import { Harnest } from "../src/index";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Harnest SDK", () => {
  it("loads and invokes a harness through the high-level API", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harnest-sdk-"));
    directories.push(directory);
    const file = join(directory, "harnest.yaml");
    const spec: HarnessSpec = {
      version: "0.2",
      components: [
        { id: "model", type: "model", config: { adapter: "sdk-test", model: "deterministic" } },
        { id: "prompt", type: "prompt", config: { template: "Answer {{input}}" } },
        { id: "agent", type: "agent", config: {} },
        { id: "output", type: "output", config: { format: "text" } },
      ],
      connections: [
        { from: { component: "model", port: "model" }, to: { component: "agent", port: "model" } },
        { from: { component: "prompt", port: "prompt" }, to: { component: "agent", port: "prompt" } },
        { from: { component: "agent", port: "response" }, to: { component: "output", port: "value" } },
      ],
      entrypoint: "output",
    };
    await saveSpecFile(file, spec);
    const adapter: ModelAdapter = {
      id: "sdk-test",
      capabilities: { streaming: true, json: false, cancellation: true },
      async *run(request) {
        yield { type: "text-delta", text: request.messages.findLast((message) => message.role === "user")?.content ?? "" };
        yield { type: "finish", reason: "stop" };
      },
    };

    const harness = await Harnest.load(file, { adapters: [adapter], persistRuns: false });
    try {
      const result = await harness.invoke("hello");
      expect(result.output).toBe("Answer hello");
      expect(result.runId).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      await harness.close();
    }
    await expect(harness.invoke("closed")).rejects.toThrow("closed");
  });
});
