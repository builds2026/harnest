import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectionManager, initializeHarnestProject, saveSpecFile } from "@harnestai/core/node";
import type { HarnessSpec, ModelAdapter, RunEvent } from "@harnestai/core";
import { Harnest } from "../src/node";

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
    await initializeHarnestProject(file, {
      version: 1,
      harness: "harnest.yaml",
      bindings: [{ kind: "prompt", component: "prompt", path: "prompts/main.md" }],
    }, { "prompts/main.md": "Project prompt {{input}}" });
    const adapter: ModelAdapter = {
      id: "sdk-test",
      capabilities: { streaming: true, json: false, cancellation: true },
      async *run(request) {
        yield { type: "text-delta", text: request.messages.findLast((message) => message.role === "user")?.content ?? "" };
        yield { type: "finish", reason: "stop" };
      },
    };

    const harness = await Harnest.load(directory, { adapters: [adapter], persistRuns: false });
    try {
      expect(harness.contract).toMatchObject({ specVersion: "0.2", entrypoint: "output", capabilities: ["conversation"] });
      const result = await harness.invoke("hello");
      expect(result.output).toBe("Project prompt hello");
      expect(result.runId).toMatch(/^[0-9a-f-]{36}$/);
      const handle = harness.start("streamed");
      const events = [];
      for await (const event of handle.events) events.push(event);
      await expect(handle.result()).resolves.toMatchObject({ output: "Project prompt streamed" });
      expect(events.map(({ type }) => type)).toContain("run-end");
    } finally {
      await harness.close();
    }
    await expect(harness.invoke("closed")).rejects.toThrow("closed");
  });

  it("uses the shared Harness, Tool, and Connection permission store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harnest-sdk-permissions-"));
    directories.push(directory);
    const file = join(directory, "harnest.yaml");
    await saveSpecFile(file, {
      version: "0.2",
      components: [{ id: "prompt", type: "prompt", config: { template: "{{input}}" } }],
      connections: [],
      entrypoint: "prompt",
    });
    const harness = await Harnest.load(file, { persistRuns: false });
    try {
      expect(await harness.listPermissions()).toEqual([]);
      expect(await harness.revokePermission("builtin.shell", "runtime-main")).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it("requires a controllable RunHandle when compatibility calls need permission", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harnest-sdk-interaction-"));
    directories.push(directory);
    await writeFile(join(directory, "runtime.mjs"), `
      export const tool = {
        id: "fixture.write", label: "Write", description: "Fixture side effect", risk: "write", source: "module",
        inputSchema: { type: "object", additionalProperties: false }, execute() { return "written"; },
      };
      export default {
        id: "fixture-agent", capabilities: { streaming: true, json: false, cancellation: true, tools: true },
        async *run(request) {
          const result = [...request.messages].reverse().find((message) => message.role === "tool");
          if (!result) { yield { type: "tool-call", call: { id: "write-1", name: request.tools[0].name, input: {} } }; yield { type: "finish", reason: "tool" }; return; }
          yield { type: "text-delta", text: "written" }; yield { type: "finish", reason: "stop" };
        },
      };
    `, "utf8");
    await writeFile(join(directory, "harnest.yaml"), `
version: "0.2"
components:
  - { id: tool, type: tool, config: { tool: fixture.write, source: module } }
  - { id: model, type: model, config: { adapter: fixture-agent, model: fixture } }
  - { id: prompt, type: prompt, config: { template: "{{input}}" } }
  - { id: agent, type: agent, config: { toolError: fail } }
  - { id: output, type: output, config: {} }
connections:
  - { from: { component: tool, port: tool }, to: { component: agent, port: tools } }
  - { from: { component: model, port: model }, to: { component: agent, port: model } }
  - { from: { component: prompt, port: prompt }, to: { component: agent, port: prompt } }
  - { from: { component: agent, port: response }, to: { component: output, port: value } }
entrypoint: output
runtime: { adapters: [./runtime.mjs], modules: [./runtime.mjs] }
`, "utf8");
    const harness = await Harnest.load(directory, { allowModuleExecution: true, persistRuns: false });
    try {
      await expect(harness.invoke("write")).rejects.toMatchObject({ code: "RUN_INTERACTION_REQUIRED" });
      await expect((async () => {
        for await (const event of harness.stream("write")) void event;
      })()).rejects.toMatchObject({ code: "RUN_INTERACTION_REQUIRED" });

      const handle = harness.start("write");
      let request: Extract<RunEvent, { type: "interaction-requested" }>["request"] | undefined;
      for await (const event of handle.events) if (event.type === "interaction-requested") { request = event.request; break; }
      expect(request).toBeDefined();
      await handle.send({ type: "interaction-response", response: {
        interactionId: request!.id,
        checkpointDigest: request!.checkpoint.digest,
        action: "decline",
        permission: "deny",
      } });
      await expect(handle.result()).rejects.toMatchObject({ code: "TOOL_APPROVAL_DENIED" });
    } finally {
      await harness.close();
    }
  });

  it("probes required local runtimes before reporting healthy", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harnest-sdk-health-"));
    directories.push(directory);
    const manager = new ConnectionManager(directory, {
      userDataDirectory: join(directory, "user"),
      credentialKey: new Uint8Array(32).fill(7),
    });
    await manager.create({
      id: "sandbox-main",
      scope: "project",
      kind: "local-runtime",
      name: "Sandbox",
      config: { command: process.execPath, args: [] },
    });
    await manager.approveProcess("sandbox-main");
    const file = join(directory, "harnest.yaml");
    await saveSpecFile(file, {
      version: "0.2",
      components: [
        { id: "tool", type: "tool", config: { tool: "builtin.code-runner", connectionId: "sandbox-main" } },
        { id: "output", type: "output", config: {} },
      ],
      connections: [{ from: { component: "tool", port: "tool" }, to: { component: "output", port: "value" } }],
      entrypoint: "output",
    });
    const harness = await Harnest.load(file, { persistRuns: false, services: { connectionManager: manager } });
    try {
      await expect(harness.localConnectionHealth()).resolves.toMatchObject({
        ok: true,
        requiredConnections: ["sandbox-main"],
        readyConnections: ["sandbox-main"],
      });
      await manager.update("sandbox-main", {
        name: "Sandbox",
        config: { command: process.execPath, args: ["--version"] },
      });
      await expect(harness.localConnectionHealth()).resolves.toMatchObject({
        ok: false,
        requiredConnections: ["sandbox-main"],
        readyConnections: [],
        errors: [expect.objectContaining({ connectionId: "sandbox-main" })],
      });
    } finally {
      await harness.close();
    }
  });

  it("loads HTTP Host Providers from environment only as a complete pair and keeps a local RunStore", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harnest-sdk-providers-"));
    directories.push(directory);
    const file = join(directory, "harnest.yaml");
    await saveSpecFile(file, {
      version: "0.2",
      components: [{ id: "prompt", type: "prompt", config: { template: "{{input}}" } }],
      connections: [],
      entrypoint: "prompt",
    });
    await expect(Harnest.load(file, {
      env: { HARNEST_PROVIDER_URL: "https://host.invalid/api/providers/context" },
      persistRuns: false,
    })).rejects.toThrow(/configured together/);
    const harness = await Harnest.load(file, {
      env: {
        HARNEST_PROVIDER_URL: "https://host.invalid/api/providers/context",
        HARNEST_PROVIDER_TOKEN: "private-token",
      },
      persistRuns: false,
    });
    try {
      const result = await harness.invoke("local");
      await expect(harness.readRunSnapshot(result.runId)).resolves.toMatchObject({ status: "succeeded" });
      expect(JSON.stringify(result.trace)).not.toContain("private-token");
    } finally {
      await harness.close();
    }

    const externalFile = join(directory, "external.yaml");
    await saveSpecFile(externalFile, {
      version: "0.2",
      components: [
        { id: "model", type: "model", config: { connectionId: "host-owned-model", model: "remote" } },
        { id: "prompt", type: "prompt", config: { template: "{{input}}" } },
        { id: "agent", type: "agent", config: {} },
        { id: "output", type: "output", config: { format: "text" } },
      ],
      connections: [
        { from: { component: "model", port: "model" }, to: { component: "agent", port: "model" } },
        { from: { component: "prompt", port: "prompt" }, to: { component: "agent", port: "prompt" } },
        { from: { component: "agent", port: "response" }, to: { component: "output", port: "value" } },
      ],
      entrypoint: "output",
    });
    const external = await Harnest.load(externalFile, {
      env: {
        HARNEST_PROVIDER_URL: "https://host.invalid/api/providers/context",
        HARNEST_PROVIDER_TOKEN: "private-token",
      },
      persistRuns: false,
    });
    expect(external.diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: expect.stringMatching(/connection/i), severity: "error" }),
    ]));
    await external.close();
  });
});
