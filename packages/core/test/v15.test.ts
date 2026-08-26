import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  normalizePermissionDecision,
  AdapterRegistry,
  HarnessRuntime,
  parseRunCommand,
  publicRunSnapshot,
  RunControl,
  ToolRegistry,
  normalizeContextSources,
  runtimeServicesFromProviders,
  createHttpHostProviders,
  validateContextCitations,
  type HostProviders,
  type HarnessSpec,
  type ModelAdapter,
  type OrchestrationEvent,
  type RunEvent,
  type ServiceExecutionContext,
} from "../src/index.js";
import { FileRunStore, NodeRuntimeServices, resolveMcpElicitation } from "../src/node.js";

const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("Expected test state was not created");
  return value;
};
const exec = promisify(execFile);

describe("v1.5 interaction contracts", () => {
  it("round-trips MCP form elicitation without widening the schema", async () => {
    let request: Parameters<NonNullable<ServiceExecutionContext["requestInteraction"]>>[0] | undefined;
    const context: ServiceExecutionContext = {
      signal: new AbortController().signal,
      runId: "mcp-run",
      nodeId: "mcp-node",
      iteration: 0,
      resolveSecret: () => undefined,
      requestInteraction: async (candidate) => {
        request = candidate;
        return {
          interactionId: "mcp-form",
          checkpointDigest: "a".repeat(64),
          action: "submit",
          value: { region: "eu", replicas: 2 },
        };
      },
    };
    await expect(resolveMcpElicitation({
      mode: "form",
      message: "Deployment settings",
      requestedSchema: {
        type: "object",
        properties: {
          region: { type: "string", enum: ["us", "eu"] },
          replicas: { type: "integer", minimum: 1, maximum: 5 },
        },
        required: ["region"],
      },
    }, context, "deploy")).resolves.toEqual({
      action: "accept",
      content: { region: "eu", replicas: 2 },
    });
    expect(request).toMatchObject({
      kind: "form",
      requester: { kind: "mcp", id: "deploy" },
      message: "Deployment settings",
      schema: { type: "object", required: ["region"], additionalProperties: false },
    });
  });

  it.each([
    ["decline", "decline"],
    ["cancel", "cancel"],
  ] as const)("maps MCP %s without carrying response values", async (action, expected) => {
    const context: ServiceExecutionContext = {
      signal: new AbortController().signal,
      runId: "mcp-run",
      nodeId: "mcp-node",
      iteration: 0,
      resolveSecret: () => undefined,
      requestInteraction: async () => ({
        interactionId: "mcp-form",
        checkpointDigest: "a".repeat(64),
        action,
        value: { token: "must-not-cross" },
      }),
    };
    await expect(resolveMcpElicitation({
      message: "Continue?",
      requestedSchema: { type: "object", properties: {} },
    }, context)).resolves.toEqual({ action: expected });
  });

  it("maps URL elicitation to OAuth connection metadata and rejects token channels", async () => {
    let submitted: unknown = { connectionRef: "connection:github" };
    let request: Parameters<NonNullable<ServiceExecutionContext["requestInteraction"]>>[0] | undefined;
    const context: ServiceExecutionContext = {
      signal: new AbortController().signal,
      runId: "mcp-run",
      nodeId: "mcp-node",
      iteration: 0,
      resolveSecret: () => undefined,
      requestInteraction: async (candidate) => {
        request = candidate;
        return { interactionId: "mcp-url", checkpointDigest: "b".repeat(64), action: "submit", value: submitted };
      },
    };
    const params = {
      mode: "url" as const,
      message: "Connect GitHub",
      elicitationId: "github-oauth",
      url: "https://github.example/authorize?client_id=public",
    };
    await expect(resolveMcpElicitation(params, context, "github.search")).resolves.toEqual({
      action: "accept", content: { connectionRef: "connection:github" },
    });
    expect(request).toMatchObject({
      kind: "oauth",
      requester: { kind: "mcp", id: "github.search" },
      data: { url: params.url, elicitationId: "github-oauth" },
    });
    submitted = { token: "oauth-secret" };
    await expect(resolveMcpElicitation(params, context)).rejects.toThrow(/tokens|connectionRef/i);
    await expect(resolveMcpElicitation({ ...params, url: "https://github.example/authorize?access_token=secret" }, context))
      .rejects.toThrow(/tokens or credentials/i);
    await expect(resolveMcpElicitation({
      mode: "form",
      message: "Bad form",
      requestedSchema: { type: "object", properties: { apiKey: { type: "string" } } },
    }, context)).rejects.toThrow(/credential field/i);
  });

  it("pauses durably, rejects stale responses, and grants an exact Tool for the run", async () => {
    const control = new RunControl("run_v15");
    const events: OrchestrationEvent[] = [];
    control.attach((event) => events.push(event));
    const waiting = control.requestInteraction({
      id: "permission_call_1",
      nodeId: "agent",
      kind: "permission",
      requester: { kind: "tool", id: "builtin.shell" },
      title: "Tool permission",
      message: "Allow shell?",
      blocking: "run",
      data: { permission: { toolId: "builtin.shell", action: "git status" } },
    });
    const request = control.snapshot().pendingInteractions?.[0];
    expect(control.snapshot()).toMatchObject({ status: "paused", processedInteractionIds: [] });
    expect(events.map(({ type }) => type)).toContain("run-paused");

    await expect(control.send({
      type: "interaction-response",
      response: {
        interactionId: request?.id,
        checkpointDigest: "0".repeat(64),
        action: "submit",
        permission: "allow_for_run",
      },
    })).rejects.toThrow("stale");
    await control.send({
      type: "interaction-response",
      response: {
        interactionId: request?.id,
        checkpointDigest: request?.checkpoint.digest,
        action: "submit",
        permission: "allow_for_run",
      },
    });
    await expect(waiting).resolves.toMatchObject({ action: "submit", permission: "allow_for_run" });
    const resolved = events.find((event) => event.type === "interaction-resolved");
    expect(resolved).toMatchObject({ response: { action: "submit", permission: "allow_for_run" } });
    expect(JSON.stringify(resolved)).not.toContain("value");
    expect(JSON.stringify(resolved)).not.toContain("checkpointDigest");
    expect(control.hasRunPermission({ id: "builtin.shell", action: "git status" })).toBe(true);
    expect(control.hasRunPermission({ id: "builtin.shell", action: "git push" })).toBe(false);
    expect(control.snapshot()).toMatchObject({ status: "running", processedInteractionIds: ["permission_call_1"] });
  });

  it("normalizes provider sources and reports only supplied citations", () => {
    const sources = normalizeContextSources([
      { content: "first", provenance: { source: "pkm", title: "One" } },
      { content: "second", provenance: { source: "memory", title: "Two" } },
    ]);
    expect(sources.map(({ label }) => label)).toEqual(["S1", "S2"]);
    expect(validateContextCitations("Use [S1], not [S9].", sources)).toEqual({ valid: ["S1"], invented: ["S9"] });
  });

  it.each(["select", "input", "form", "file", "oauth", "permission"] as const)(
    "round-trips the %s interaction kind",
    async (kind) => {
      const control = new RunControl(`run_${kind}`);
      const waiting = control.requestInteraction({
        id: `interaction_${kind}`,
        nodeId: "node",
        kind,
        requester: { kind: "harness", id: "node" },
        title: "Title",
        message: "Message",
        blocking: "run",
        ...(kind === "permission" ? { data: { permission: { toolId: "tool" } } } : {}),
      });
      const request = required(control.snapshot().pendingInteractions?.[0]);
      control.resolveInteraction({
        interactionId: request.id,
        checkpointDigest: request.checkpoint.digest,
        action: "submit",
        ...(kind === "permission" ? { permission: "allow_once" }
          : kind === "file" ? { value: { fileRef: "file", mimeType: "text/plain", size: 1, sha256: "a".repeat(64) } }
          : kind === "oauth" ? { value: { connectionRef: "connection" } }
          : { value: { ok: true } }),
      });
      await expect(waiting).resolves.toMatchObject({ interactionId: request.id, action: "submit" });
    },
  );

  it.each(["submit", "decline", "cancel"] as const)("accepts the %s interaction outcome once", async (action) => {
    const control = new RunControl(`run_${action}`);
    const waiting = control.requestInteraction({
      id: `interaction_${action}`, nodeId: "node", kind: "input",
      requester: { kind: "harness", id: "node" }, title: "Title", message: "Message", blocking: "run",
    });
    const request = required(control.snapshot().pendingInteractions?.[0]);
    const response = { interactionId: request.id, checkpointDigest: request.checkpoint.digest, action };
    expect(control.resolveInteraction(response)).toMatchObject({ action });
    expect(control.resolveInteraction(response)).toMatchObject({ action });
    await expect(waiting).resolves.toMatchObject({ action });
  });

  it("expires an interaction, rejects its waiter, and rejects a late response", async () => {
    const control = new RunControl("run_expiry");
    const waiting = control.requestInteraction({
      id: "interaction_expiry", nodeId: "node", kind: "input",
      requester: { kind: "harness", id: "node" }, title: "Title", message: "Message", blocking: "run",
      expiresAt: new Date(Date.now() + 10).toISOString(),
    });
    const request = required(control.snapshot().pendingInteractions?.[0]);
    await expect(waiting).rejects.toThrow("expired");
    expect(control.snapshot()).toMatchObject({ status: "running", processedInteractionIds: [request.id] });
    expect(() => control.resolveInteraction({
      interactionId: request.id, checkpointDigest: request.checkpoint.digest, action: "submit",
    })).toThrow("expired");
  });

  it("lets an independent Team sibling finish before marking a task-blocked run paused", async () => {
    const control = new RunControl("run_team_pause");
    const team = { orchestrator: "worker", members: ["worker"], limits: {
      maxInstances: 4, maxDepth: 1, maxParallel: 2, maxMessages: 10, maxPlanRevisions: 2,
    } };
    control.registerTeam("team", team);
    const blockedTask = control.createTask("team", { id: "blocked", goal: "wait", agent: "worker" });
    const siblingTask = control.createTask("team", { id: "sibling", goal: "finish", agent: "worker" });
    const blockedAgent = control.spawnAgent("team", "worker", team.limits, undefined, blockedTask.id);
    const siblingAgent = control.spawnAgent("team", "worker", team.limits, undefined, siblingTask.id);
    control.startTask(blockedTask.id, blockedAgent.id, new AbortController().signal);
    control.startTask(siblingTask.id, siblingAgent.id, new AbortController().signal);
    const waiting = control.requestInteraction({
      id: "interaction_team", nodeId: "node", taskId: blockedTask.id, agentId: blockedAgent.id,
      kind: "input", requester: { kind: "agent", id: blockedAgent.id },
      title: "Need input", message: "Wait", blocking: "task",
    });
    expect(control.snapshot().status).toBe("running");
    control.finishTask(siblingTask.id, "done");
    expect(control.snapshot()).toMatchObject({ status: "paused", tasks: expect.arrayContaining([
      expect.objectContaining({ id: "sibling", status: "completed" }),
    ]) });
    const request = required(control.snapshot().pendingInteractions?.[0]);
    control.resolveInteraction({ interactionId: request.id, checkpointDigest: request.checkpoint.digest, action: "submit", value: "go" });
    await waiting;
  });

  it("replays a private response when resume receives the command before waiter registration", async () => {
    const original = new RunControl("run_resume_race");
    original.requestInteraction({
      id: "interaction_race", nodeId: "node", kind: "input",
      requester: { kind: "harness", id: "node" }, title: "Title", message: "Message", blocking: "run",
    }).catch(() => undefined);
    const snapshot = original.snapshot();
    const request = required(snapshot.pendingInteractions?.[0]);
    const resumed = new RunControl(snapshot.runId, snapshot);
    await resumed.send({ type: "interaction-response", response: {
      interactionId: request.id, checkpointDigest: request.checkpoint.digest,
      action: "submit", value: { private: "answer" },
    } });
    expect(resumed.snapshot().interactionResponses?.[request.id]).toMatchObject({ value: { private: "answer" } });
    await expect(resumed.requestInteraction({
      id: request.id, nodeId: request.nodeId, kind: request.kind, requester: request.requester,
      title: request.title, message: request.message, blocking: request.blocking,
    })).resolves.toMatchObject({ value: { private: "answer" } });
  });

  it("resumes a standalone Interaction with a stable id and accepts an early response", async () => {
    const graph = {
      version: "0.2",
      components: [
        { id: "ask", type: "interaction", config: { kind: "input", title: "Name", message: "Your name?", schema: { type: "string", minLength: 1 } } },
        { id: "output", type: "output", config: {} },
      ],
      connections: [{ from: { component: "ask", port: "value" }, to: { component: "output", port: "value" } }],
      entrypoint: "output",
    } satisfies HarnessSpec;
    const runtime = new HarnessRuntime(graph, new AdapterRegistry());
    const first = runtime.start(undefined);
    let pending: ReturnType<typeof first.snapshot>["pendingInteractions"];
    for await (const event of first.events) {
      if (event.type === "interaction-requested") { pending = first.snapshot().pendingInteractions; break; }
    }
    const snapshot = first.snapshot();
    expect(pending?.[0]?.id).toBe("interaction_ask_0");
    await first.cancel();

    const resumed = runtime.resume(undefined, snapshot);
    const request = required(pending?.[0]);
    await resumed.send({ type: "interaction-response", response: {
      interactionId: request.id,
      checkpointDigest: request.checkpoint.digest,
      action: "submit",
      value: "Ada",
    } });
    await expect(resumed.result()).resolves.toMatchObject({ output: "Ada" });
  });

  it("rejects allow_always when preview or permission resource is incomplete", () => {
    for (const data of [
      { permission: { toolId: "tool" }, previewLimited: true, resourceResolved: true },
      { permission: { toolId: "tool" }, previewLimited: false, resourceResolved: false },
    ]) {
      const control = new RunControl(`run_${String(data.previewLimited)}_${String(data.resourceResolved)}`);
      control.requestInteraction({
        id: "interaction_permission", nodeId: "node", kind: "permission",
        requester: { kind: "tool", id: "tool" }, title: "Permission", message: "Allow?", blocking: "run", data,
      }).catch(() => undefined);
      const request = required(control.snapshot().pendingInteractions?.[0]);
      expect(() => control.resolveInteraction({
        interactionId: request.id, checkpointDigest: request.checkpoint.digest,
        action: "submit", permission: "allow_always",
      })).toThrow("complete preview");
    }
  });

  it("rejects credential/nested form schemas and bounds file/OAuth response metadata", () => {
    const base = { nodeId: "node", requester: { kind: "harness" as const, id: "node" }, title: "Title", message: "Message", blocking: "run" as const };
    for (const schema of [
      { type: "object", properties: { accessToken: { type: "string" } }, required: [], additionalProperties: false },
      { type: "object", properties: { nested: { type: "object", properties: {} } }, required: [], additionalProperties: false },
    ]) expect(() => new RunControl("run_schema").requestInteraction({ ...base, kind: "form", schema })).toThrow();

    const fileControl = new RunControl("run_file_response");
    fileControl.requestInteraction({ id: "file_response", ...base, kind: "file" }).catch(() => undefined);
    const file = required(fileControl.snapshot().pendingInteractions?.[0]);
    expect(() => fileControl.resolveInteraction({
      interactionId: file.id, checkpointDigest: file.checkpoint.digest, action: "submit",
      value: { fileRef: "ref", mimeType: "text/plain", size: 1, sha256: "a".repeat(64), bytes: "forbidden" },
    })).toThrow("only fileRef");

    const oauthControl = new RunControl("run_oauth_response");
    oauthControl.requestInteraction({ id: "oauth_response", ...base, kind: "oauth" }).catch(() => undefined);
    const oauth = required(oauthControl.snapshot().pendingInteractions?.[0]);
    expect(() => oauthControl.resolveInteraction({
      interactionId: oauth.id, checkpointDigest: oauth.checkpoint.digest, action: "submit",
      value: { connectionRef: "connection", accessToken: "forbidden" },
    })).toThrow("only a connectionRef");
  });

  it("validates submitted select/input/form values at the RunControl boundary", () => {
    const cases = [
      { kind: "select" as const, schema: { type: "string", enum: ["safe"] }, value: "unsafe", error: /allowed/ },
      { kind: "input" as const, schema: { type: "string", minLength: 3, maxLength: 5 }, value: "x", error: /minLength/ },
      { kind: "form" as const, schema: {
        type: "object", properties: { count: { type: "integer", minimum: 1, maximum: 3 } },
        required: ["count"], additionalProperties: false,
      }, value: { count: 4 }, error: /maximum/ },
    ];
    for (const [index, candidate] of cases.entries()) {
      const control = new RunControl(`run_value_${index}`);
      control.requestInteraction({
        id: `value_${index}`, nodeId: "node", kind: candidate.kind,
        requester: { kind: "harness", id: "node" }, title: "Value", message: "Value", blocking: "run",
        schema: candidate.schema,
      }).catch(() => undefined);
      const request = required(control.snapshot().pendingInteractions?.[0]);
      expect(() => control.resolveInteraction({
        interactionId: request.id, checkpointDigest: request.checkpoint.digest, action: "submit", value: candidate.value,
      })).toThrow(candidate.error);
    }
  });

  it("exports a public snapshot without private recovery values or context references", () => {
    const control = new RunControl("run_public_snapshot");
    control.requestInteraction({
      id: "private_interaction", nodeId: "node", kind: "input",
      requester: { kind: "harness", id: "node" }, title: "Private", message: "Private", blocking: "run",
      data: {
        contextRef: "opaque-private-reference",
        nested: { context_ref: "also-private", apiKey: "private-key", accessToken: "private-token" },
      },
    }).catch(() => undefined);
    const privatePending = control.snapshot().pendingInteractions;
    const request = required(privatePending?.[0]);
    control.resolveInteraction({
      interactionId: request.id, checkpointDigest: request.checkpoint.digest,
      action: "submit", value: { private: "answer" },
    });
    control.saveTurnCheckpoint("run:node:0", {
      nodeId: "node", iteration: 0, nextTurn: 1, messages: [], siblingResults: [], completed: false,
    });
    const snapshot = publicRunSnapshot({ ...control.snapshot(), pendingInteractions: privatePending });
    expect(snapshot).not.toHaveProperty("interactionResponses");
    expect(snapshot).not.toHaveProperty("turnCheckpoints");
    expect(JSON.stringify(snapshot)).not.toContain("opaque-private-reference");
    expect(JSON.stringify(snapshot)).not.toContain("contextRef");
    expect(JSON.stringify(snapshot)).not.toContain("private-key");
    expect(JSON.stringify(snapshot)).not.toContain("private-token");
    expect(snapshot.pendingInteractions?.[0]?.data).toMatchObject({
      nested: { apiKey: "[REDACTED]", accessToken: "[REDACTED]" },
    });
  });

  it("adapts revision-aware host conversation/cache/file/connection providers", async () => {
    const cachePuts: unknown[] = [];
    const providers = {
      runs: {
        append() {}, commit() {}, async readEvents() { return []; }, async readSnapshot() { return undefined; },
      },
      cache: {
        async get() { return undefined; },
        async put(request: unknown) {
          cachePuts.push(request);
          return { namespace: "provider-prompt" as const, key: "k", value: {}, etag: "e", expiresAt: new Date(Date.now() + 1000).toISOString() };
        },
        async delete() { return true; },
      },
      files: {
        async read() { return { file: { ref: "file_1", name: "x", mimeType: "text/plain", size: 2 }, stream: (async function* () { yield new TextEncoder().encode("ok"); })() }; },
        async create() { return { ref: "file_1" }; }, async commit() { return { ref: "file_1", name: "x", mimeType: "text/plain" }; },
      },
      connections: {
        async resolve() { return {
          id: "model", kind: "provider", configuration: { model: "safe", baseUrl: "https://provider.invalid/v1" },
          async fetch() { return new Response("injected"); },
          async execute() { return "provider-tool"; },
        }; },
      },
    } satisfies HostProviders;
    const services = runtimeServicesFromProviders(providers, {
      async readAttachment() { return new TextEncoder().encode("legacy"); },
      async resolveConnection() { return { value: { model: "legacy" } }; },
      async fetchProvider() { return new Response("legacy"); },
      async executeTool() { return { value: "legacy-tool" }; },
    });
    await services.promptCache?.set({
      key: "a".repeat(64), adapterId: "fake", model: "m", resource: "opaque",
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 1000).toISOString(),
    });
    await expect(services.readAttachment?.({ id: "file_1", ref: "external", name: "x", mimeType: "text/plain", size: 2 }, {
      signal: new AbortController().signal, runId: "run", nodeId: "node", iteration: 0, resolveSecret: () => undefined,
    })).resolves.toEqual(new TextEncoder().encode("ok"));
    await expect(services.resolveConnection?.("model", {
      signal: new AbortController().signal, runId: "run", nodeId: "node", iteration: 0, resolveSecret: () => undefined,
    })).resolves.toMatchObject({ value: { model: "safe", connectionId: "model", connectionKind: "provider" } });
    await expect(services.fetchProvider?.("https://provider.invalid/v1/models", undefined, {
      signal: new AbortController().signal, runId: "run", nodeId: "node", iteration: 0, resolveSecret: () => undefined,
    })).resolves.toBeInstanceOf(Response);
    await expect(services.executeTool?.({ id: "remote-tool", connectionId: "model", action: "call" }, {}, {
      signal: new AbortController().signal, runId: "run", nodeId: "node", iteration: 0, resolveSecret: () => undefined,
    })).resolves.toEqual({ value: "provider-tool" });
    const localFallback = runtimeServicesFromProviders({ ...providers, connections: {
      ...providers.connections,
      async resolve() { return { id: "", kind: "" }; },
    } }, { async executeTool() { return { value: "local-tool" }; } });
    await expect(localFallback.executeTool?.({ id: "builtin.code-runner", connectionId: "sandbox-main" }, {}, {
      signal: new AbortController().signal, runId: "run", nodeId: "node", iteration: 0, resolveSecret: () => undefined,
    })).resolves.toEqual({ value: "local-tool" });
    const unsafe = runtimeServicesFromProviders({ ...providers, connections: {
      async resolve() { return { id: "bad", kind: "provider", configuration: { accessToken: "must-not-escape" } }; },
    } });
    await expect(unsafe.resolveConnection?.("bad", {
      signal: new AbortController().signal, runId: "run", nodeId: "node", iteration: 0, resolveSecret: () => undefined,
    })).rejects.toThrow("credential material");
    expect(cachePuts).toEqual([]);
  });

  it("scopes credential-injecting Provider connections to the resolving run and node", async () => {
    const providers = {
      runs: { append() {}, commit() {}, async readEvents() { return []; }, async readSnapshot() { return undefined; } },
      connections: { async resolve({ connectionId }: { connectionId: string }) { return {
        id: connectionId,
        kind: "provider",
        configuration: { baseUrl: "https://provider.invalid/v1" },
        async fetch() { return new Response(connectionId); },
      }; } },
    } satisfies HostProviders;
    const services = runtimeServicesFromProviders(providers);
    const scoped = (runId: string, nodeId: string): ServiceExecutionContext => ({
      signal: new AbortController().signal, runId, nodeId, iteration: 0, resolveSecret: () => undefined,
    });
    await services.resolveConnection?.("tenant-a", scoped("run-a", "model"));
    await services.resolveConnection?.("tenant-b", scoped("run-b", "model"));
    await expect((await services.fetchProvider?.("https://provider.invalid/v1/models", undefined, scoped("run-a", "model")))?.text())
      .resolves.toBe("tenant-a");
    await expect((await services.fetchProvider?.("https://provider.invalid/v1/models", undefined, scoped("run-b", "model")))?.text())
      .resolves.toBe("tenant-b");
    await expect(services.fetchProvider?.("https://provider.invalid/v1/models", undefined, scoped("run-a", "other")))
      .rejects.toThrow(/run node/);
  });

  it("keeps HTTP Host Provider bearer credentials closed over while forwarding opaque contextRef", async () => {
    const requests: Array<{ authorization: string | null; body: unknown }> = [];
    const providers = createHttpHostProviders({
      baseUrl: "https://host.invalid/api/providers/context",
      token: "private-bearer-token",
      runs: { append() {}, commit() {}, async readEvents() { return []; }, async readSnapshot() { return undefined; } },
      fetch: async (_url, init) => {
        requests.push({ authorization: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
        return Response.json({ result: { messages: [], revision: 4, sources: [] } });
      },
    });
    const service: ServiceExecutionContext = {
      signal: new AbortController().signal, runId: "run-http", nodeId: "node-http", iteration: 0,
      contextRef: "opaque-context-ref",
      resolveSecret: () => undefined,
    };
    const result = await providers.conversation?.read({ contextRef: "opaque-context-ref", revision: 4 }, service);
    expect(result).toMatchObject({ revision: 4 });
    expect(requests).toEqual([{
      authorization: "Bearer private-bearer-token",
      body: {
        operation: "conversation.read",
        request: { revision: 4 },
        contextRef: "opaque-context-ref",
      },
    }]);
    expect(JSON.stringify(result)).not.toContain("private-bearer-token");
    expect(JSON.stringify(publicRunSnapshot({
      runId: "run-http", revision: 0, status: "running", tasks: [], agents: [], messages: [], revisions: [], proposals: [],
      pendingInteractions: [], updatedAt: new Date().toISOString(),
    }))).not.toContain("private-bearer-token");
    const noScope = { ...service, contextRef: undefined } as ServiceExecutionContext;
    await expect(providers.cache?.get({ namespace: "context", key: "a".repeat(64) }, noScope)).rejects.toThrow(/contextRef/);
    await expect(providers.permissions?.list({ harnessId: "harness" }, noScope)).rejects.toThrow(/contextRef/);
    await expect(providers.connections?.resolve({ connectionId: "provider", purpose: "metadata" }, noScope)).rejects.toThrow(/contextRef/);
  });

  it("uses Conversation revisions in prompt-cache identity and flags invented citations", async () => {
    let revision = 1;
    const keys: string[] = [];
    const historyCounts: number[] = [];
    const adapter: ModelAdapter = {
      id: "provider-context",
      capabilities: { streaming: true, json: false, cancellation: true, promptCaching: ["automatic"] },
      async *run(request) {
        keys.push(request.promptCache?.key ?? "");
        historyCounts.push(request.messages.filter((message) => typeof message.content === "string" && message.content.startsWith("history-")).length);
        yield { type: "text-delta", text: "[S1] [S2] [S3] [S4] [S9]" };
        yield { type: "finish", reason: "stop" };
      },
    };
    const providers = {
      runs: { append() {}, commit() {}, async readEvents() { return []; }, async readSnapshot() { return undefined; } },
      conversation: { async read(request) {
        const second = request.cursor === "next";
        return {
          messages: Array.from({ length: 9 }, (_, index) => ({ role: "user" as const, content: `history-${second ? 9 + index : index}` })),
          revision,
          ...(second ? {} : { cursor: "next", sources: [{ content: "source", provenance: { source: "pkm" } }] }),
        };
      } },
      memory: {
        async search(request: { namespace: "user" | "conversation" | "pkm" }) { return {
          revision: request.namespace === "pkm" ? 12 : 11,
          records: [{
            id: `${request.namespace}-1`, namespace: request.namespace,
            value: `${request.namespace} memory`,
            provenance: { source: request.namespace, uri: `memory://${request.namespace}` },
            revision: request.namespace === "pkm" ? 12 : 11,
          }],
        }; },
        async upsert(request: { namespace: "user" | "conversation" | "pkm"; value: unknown; provenance: { source: string } }) {
          return { id: "memory", namespace: request.namespace, value: request.value, provenance: request.provenance, revision: 1 };
        },
        async delete() { return { revision: 1 }; },
      },
    } satisfies HostProviders;
    const graph = {
      version: "0.1",
      components: [
        { id: "model", type: "model", config: { adapter: adapter.id, model: "fixture" } },
        { id: "prompt", type: "prompt", config: { template: "{{input}}" } },
        { id: "agent", type: "agent", config: {} },
        { id: "output", type: "output", config: { format: "text" } },
      ],
      connections: [
        { from: { component: "model", port: "model" }, to: { component: "agent", port: "model" } },
        { from: { component: "prompt", port: "prompt" }, to: { component: "agent", port: "prompt" } },
        { from: { component: "agent", port: "response" }, to: { component: "output", port: "value" } },
      ], entrypoint: "output",
    } satisfies HarnessSpec;
    const runtime = new HarnessRuntime(graph, new AdapterRegistry().register(adapter), { providers });
    const first = await runtime.invoke("one", { session: { id: "conversation", contextRef: "opaque-context" } });
    revision = 2;
    await runtime.invoke("two", { session: { id: "conversation", contextRef: "opaque-context" } });
    expect(keys[0]).not.toBe(keys[1]);
    expect(historyCounts).toEqual([18, 18]);
    expect(first.trace).toContainEqual(expect.objectContaining({
      type: "context-use", source: "citation-validation",
      metadata: { valid: ["S1", "S2", "S3", "S4"], invented: ["S9"] },
    }));
    expect(first.trace).toContainEqual(expect.objectContaining({
      type: "citations",
      citations: [
        { label: "S1", provenance: { source: "pkm" } },
        { label: "S2", provenance: { source: "user", uri: "memory://user", revision: 11 } },
        { label: "S3", provenance: { source: "conversation", uri: "memory://conversation", revision: 11 } },
        { label: "S4", provenance: { source: "pkm", uri: "memory://pkm", revision: 12 } },
      ],
      invented: ["S9"],
    }));
  });

  it("uses the context CacheProvider with revision identity and excludes contextRef from its key", async () => {
    const entries = new Map<string, unknown>();
    const cacheRequests: Array<{ namespace: string; key: string }> = [];
    let conversationReads = 0;
    let memorySearches = 0;
    const adapter: ModelAdapter = {
      id: "context-cache-fixture",
      capabilities: { streaming: true, json: false, cancellation: true },
      async *run() { yield { type: "text-delta", text: "done" }; yield { type: "finish", reason: "stop" }; },
    };
    const providers = {
      runs: { append() {}, commit() {}, async readEvents() { return []; }, async readSnapshot() { return undefined; } },
      conversation: { async read() { conversationReads += 1; return { messages: [], revision: 1, sources: [] }; } },
      memory: {
        async search(request: { namespace: "user" | "conversation" | "pkm" }) { memorySearches += 1; return { records: [], revision: request.namespace === "pkm" ? 2 : 1 }; },
        async upsert(request: { namespace: "user" | "conversation" | "pkm"; value: unknown; provenance: { source: string } }) {
          return { id: "m", namespace: request.namespace, value: request.value, provenance: request.provenance, revision: 1 };
        },
        async delete() { return { revision: 1 }; },
      },
      cache: {
        async get(request: { namespace: "context" | "provider-prompt"; key: string }) {
          cacheRequests.push(request);
          const value = entries.get(request.key);
          return value === undefined ? undefined : {
            namespace: request.namespace, key: request.key, value, etag: "etag", expiresAt: new Date(Date.now() + 60_000).toISOString(),
          };
        },
        async put(request: { namespace: "context" | "provider-prompt"; key: string; value: unknown }) {
          cacheRequests.push(request);
          entries.set(request.key, request.value);
          return { ...request, etag: "etag", expiresAt: new Date(Date.now() + 60_000).toISOString() };
        },
        async delete() { return true; },
      },
    } satisfies HostProviders;
    const graph = {
      version: "0.1",
      components: [
        { id: "model", type: "model", config: { adapter: adapter.id, model: "fixture" } },
        { id: "prompt", type: "prompt", config: { template: "{{input}}" } },
        { id: "agent", type: "agent", config: {} },
        { id: "output", type: "output", config: {} },
      ],
      connections: [
        { from: { component: "model", port: "model" }, to: { component: "agent", port: "model" } },
        { from: { component: "prompt", port: "prompt" }, to: { component: "agent", port: "prompt" } },
        { from: { component: "agent", port: "response" }, to: { component: "output", port: "value" } },
      ], entrypoint: "output",
    } satisfies HarnessSpec;
    const runtime = new HarnessRuntime(graph, new AdapterRegistry().register(adapter), { providers });
    const session = { contextRef: "private-context-ref", revisions: { conversation: 1, memory: 1, pkm: 2 } } as const;
    await runtime.invoke("one", { session });
    await runtime.invoke("two", { session });
    expect(conversationReads).toBe(1);
    expect(memorySearches).toBe(3);
    expect(entries.size).toBe(1);
    expect(cacheRequests.every(({ namespace, key }) => namespace === "context"
      && /^[a-f0-9]{64}$/.test(key) && !key.includes("private-context-ref"))).toBe(true);
  });

  it("routes Memory components through namespaced revision/provenance providers", async () => {
    const searches: unknown[] = [];
    const providers = {
      runs: { append() {}, commit() {}, async readEvents() { return []; }, async readSnapshot() { return undefined; } },
      memory: {
        async search(request: unknown) {
          searches.push(request);
          return { revision: 7, records: [{
            id: "memory_1", namespace: "pkm" as const, value: "remembered",
            provenance: { source: "document", revision: 6 }, revision: 7,
          }] };
        },
        async upsert(request: { namespace: "user" | "conversation" | "pkm"; value: unknown; provenance: { source: string } }) {
          return { id: "memory_1", namespace: request.namespace, value: request.value, provenance: request.provenance, revision: 8 };
        },
        async delete() { return { revision: 9 }; },
      },
    } satisfies HostProviders;
    const graph = {
      version: "0.2",
      components: [
        { id: "memory", type: "memory", config: { key: "topic", operation: "read", namespace: "pkm", revision: 6 } },
        { id: "output", type: "output", config: {} },
      ],
      connections: [{ from: { component: "memory", port: "memory" }, to: { component: "output", port: "value" } }],
      entrypoint: "output",
    } satisfies HarnessSpec;
    await expect(new HarnessRuntime(graph, new AdapterRegistry(), { providers }).invoke("query", {
      session: { contextRef: "private-context" },
    })).resolves.toMatchObject({ output: ["remembered"] });
    expect(searches).toEqual([expect.objectContaining({ namespace: "pkm", revision: 6, contextRef: "private-context" })]);
  });

  it("resolves external conversation context by opaque contextRef without exposing host identity", async () => {
    const reads: unknown[] = [];
    const providers = {
      runs: { append() {}, commit() {}, async readEvents() { return []; }, async readSnapshot() { return undefined; } },
      conversation: { async read(request: unknown) {
        reads.push(request);
        return {
          messages: [], revision: 3,
          sources: [{ content: "bounded context", provenance: { source: "host", sourceId: "doc-1" } }],
        };
      } },
    } satisfies HostProviders;
    const graph = {
      version: "0.2",
      components: [
        { id: "context", type: "context", config: { source: "external", conversationId: "legacy-db-id" } },
        { id: "output", type: "output", config: {} },
      ],
      connections: [{ from: { component: "context", port: "context" }, to: { component: "output", port: "value" } }],
      entrypoint: "output",
    } satisfies HarnessSpec;
    const result = await new HarnessRuntime(graph, new AdapterRegistry(), { providers }).invoke("query", {
      session: { id: "user-visible-id", contextRef: "opaque-host-reference" },
    });
    expect(reads).toEqual([{ contextRef: "opaque-host-reference" }]);
    expect(JSON.stringify(result.trace)).not.toContain("opaque-host-reference");
    expect(JSON.stringify(result.trace)).not.toContain("user-visible-id");
    expect(JSON.stringify(result.trace)).not.toContain("legacy-db-id");
  });

  it("uses Node persistent allow_always grants for canonical start/send and supports revoke", async () => {
    const root = await mkdtemp(join(tmpdir(), "harnest-node-permission-"));
    try {
      let executions = 0;
      let turns = 0;
      const adapter: ModelAdapter = {
        id: "node-permission",
        capabilities: { streaming: true, json: false, cancellation: true, tools: true },
        async *run(request) {
          turns += 1;
          if (turns % 2 === 1) {
            yield { type: "tool-call", call: { id: `call_${turns}`, name: request.tools?.[0]?.name ?? "", input: {} } };
            yield { type: "finish", reason: "tool" };
          } else { yield { type: "text-delta", text: "done" }; yield { type: "finish", reason: "stop" }; }
        },
      };
      const tools = new ToolRegistry().register({
        id: "node.danger", label: "Danger", description: "Danger", risk: "destructive",
        inputSchema: { type: "object" }, execute: () => { executions += 1; return "ok"; },
      });
      const graph = {
        version: "0.3",
        components: [
          { id: "model", type: "model", config: { adapter: adapter.id, model: "fixture" } },
          { id: "prompt", type: "prompt", config: { template: "{{input}}" } },
          { id: "tool", type: "tool", config: { tool: "node.danger", risk: "destructive" } },
          { id: "agent", type: "agent", config: {} },
          { id: "output", type: "output", config: { format: "text" } },
        ],
        connections: [
          { from: { component: "model", port: "model" }, to: { component: "agent", port: "model" } },
          { from: { component: "prompt", port: "prompt" }, to: { component: "agent", port: "prompt" } },
          { from: { component: "tool", port: "tool" }, to: { component: "agent", port: "tools" } },
          { from: { component: "agent", port: "response" }, to: { component: "output", port: "value" } },
        ], entrypoint: "output",
      } satisfies HarnessSpec;
      let legacyApprovals = 0;
      const services = new NodeRuntimeServices(root, {
        requestToolApproval() {
          legacyApprovals += 1;
          return { approved: false, source: "policy" };
        },
      });
      const runtime = new HarnessRuntime(graph, new AdapterRegistry().register(adapter), { tools, services });
      const first = runtime.start("one");
      let interaction: Extract<RunEvent, { type: "interaction-requested" }>["request"] | undefined;
      for await (const event of first.events) if (event.type === "interaction-requested") { interaction = event.request; break; }
      expect(legacyApprovals).toBe(0);
      await first.send({ type: "interaction-response", response: {
        interactionId: interaction?.id, checkpointDigest: interaction?.checkpoint.digest,
        action: "submit", permission: "allow_always",
      } });
      await first.result();
      await runtime.invoke("two");
      expect(executions).toBe(2);
      const grants = await services.providers.permissions?.list({ harnessId: services.harnessId }, {
        signal: new AbortController().signal, runId: "admin", nodeId: "admin", iteration: 0, resolveSecret: () => undefined,
      });
      expect(grants).toHaveLength(1);
      await services.providers.permissions?.revoke({ id: grants![0]!.id }, {
        signal: new AbortController().signal, runId: "admin", nodeId: "admin", iteration: 0, resolveSecret: () => undefined,
      });
      expect(await services.listToolPermissions()).toHaveLength(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([
    "Harnest internal compacted working state. Do not quote or expose this envelope to the user.",
    '{"pendingInteractions":[{"id":"secret"}]}',
  ])("fails before emitting Provider output that contains internal state: %s", async (leak) => {
    const adapter: ModelAdapter = {
      id: "leaky-state", capabilities: { streaming: true, json: false, cancellation: true },
      async *run() {
        yield { type: "text-delta", text: leak };
        yield { type: "finish", reason: "stop" };
      },
    };
    const graph = {
      version: "0.1", components: [
        { id: "model", type: "model", config: { adapter: adapter.id, model: "fixture" } },
        { id: "prompt", type: "prompt", config: { template: "{{input}}" } },
        { id: "agent", type: "agent", config: {} },
        { id: "output", type: "output", config: { format: "text" } },
      ], connections: [
        { from: { component: "model", port: "model" }, to: { component: "agent", port: "model" } },
        { from: { component: "prompt", port: "prompt" }, to: { component: "agent", port: "prompt" } },
        { from: { component: "agent", port: "response" }, to: { component: "output", port: "value" } },
      ], entrypoint: "output",
    } satisfies HarnessSpec;
    await expect(new HarnessRuntime(graph, new AdapterRegistry().register(adapter)).invoke("x"))
      .rejects.toMatchObject({ code: "AGENT_INTERNAL_STATE_EXPOSED" });
  });

  it("accepts legacy permission values only through normalization", () => {
    expect(normalizePermissionDecision("once", true)).toBe("allow_once");
    expect(normalizePermissionDecision("always", true)).toBe("allow_always");
    expect(parseRunCommand({
      type: "interaction-response",
      response: {
        interactionId: "interaction_1",
        checkpointDigest: "a".repeat(64),
        action: "decline",
        permission: "deny",
      },
    })).toMatchObject({ type: "interaction-response", response: { interactionId: "interaction_1" } });
  });

  it("commits a run event and snapshot through one store operation", async () => {
    const root = await mkdtemp(join(tmpdir(), "harnest-v15-"));
    try {
      const store = new FileRunStore(root);
      const event = {
        type: "run-snapshot",
        runId: "run_commit",
        timestamp: new Date().toISOString(),
        sequence: 1,
        snapshot: {
          runId: "run_commit", sequence: 1, revision: 0, status: "paused",
          tasks: [], agents: [], messages: [], revisions: [], proposals: [],
          pendingInteractions: [], runGrants: [], processedInteractionIds: [],
          updatedAt: new Date().toISOString(),
        },
      } satisfies RunEvent;
      await store.commit(event, event.snapshot);
      await expect(store.read("run_commit")).resolves.toHaveLength(1);
      await expect(store.readSnapshot("run_commit")).resolves.toMatchObject({ status: "paused", sequence: 1 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps public run snapshot graph records usable in persisted events", async () => {
    const root = await mkdtemp(join(tmpdir(), "harnest-v15-public-snapshot-"));
    try {
      const store = new FileRunStore(root);
      const timestamp = new Date().toISOString();
      const snapshot = {
        runId: "run_public", sequence: 1, revision: 0, status: "running" as const,
        tasks: [{ id: "research", teamId: "team", goal: "Research", assignee: "researcher", dependsOn: [], status: "running" as const, createdAt: timestamp, updatedAt: timestamp }],
        agents: [{ id: "researcher_1", teamId: "team", template: "researcher", depth: 1, status: "running" as const, createdAt: timestamp, updatedAt: timestamp }],
        messages: [], revisions: [], proposals: [], updatedAt: timestamp,
      };
      await store.commit({ type: "run-snapshot", runId: snapshot.runId, timestamp, sequence: 1, snapshot }, snapshot);
      await expect(store.readEvents(snapshot.runId)).resolves.toMatchObject([{ snapshot: { tasks: [{ id: "research" }], agents: [{ id: "researcher_1" }] } }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists a complete user-facing run result within the trace budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "harnest-v15-run-result-"));
    try {
      const store = new FileRunStore(root);
      const output = "verified answer ".repeat(600);
      await store.append({
        type: "run-end", runId: "run_result", timestamp: new Date().toISOString(), sequence: 1,
        output, state: {}, usage: {}, costUsd: 0, iterations: 1, durationMs: 10, finishReason: "stop",
      });
      await expect(store.readEvents("run_result")).resolves.toMatchObject([{ output }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers an interrupted event/snapshot commit without duplicating an appended event", async () => {
    const root = await mkdtemp(join(tmpdir(), "harnest-v15-journal-"));
    try {
      const store = new FileRunStore(root);
      const snapshot = (sequence: number) => ({
        runId: "run_recovery", sequence, revision: sequence, status: "paused" as const,
        tasks: [], agents: [], messages: [], revisions: [], proposals: [],
        pendingInteractions: [], runGrants: [], processedInteractionIds: [],
        updatedAt: new Date(1_700_000_000_000 + sequence).toISOString(),
      });
      const event = (sequence: number) => ({
        type: "run-snapshot" as const, runId: "run_recovery", timestamp: new Date().toISOString(),
        sequence, snapshot: snapshot(sequence),
      });
      await store.commit(event(1), snapshot(1));
      const journal = join(root, ".harnest", "runs", "run_recovery", "commit.json");
      await writeFile(journal, `${JSON.stringify({ version: 1, event: event(2), snapshot: snapshot(2) })}\n`, "utf8");
      await expect(store.readSnapshot("run_recovery")).resolves.toMatchObject({ sequence: 2, revision: 2 });
      await expect(store.readEvents("run_recovery")).resolves.toHaveLength(2);
      await expect(readFile(journal)).rejects.toMatchObject({ code: "ENOENT" });

      const third = event(3);
      await store.append(third);
      await writeFile(journal, `${JSON.stringify({ version: 1, event: third, snapshot: snapshot(3) })}\n`, "utf8");
      await expect(store.readSnapshot("run_recovery")).resolves.toMatchObject({ sequence: 3, revision: 3 });
      const recovered = await store.readEvents("run_recovery");
      expect(recovered.map(({ sequence }) => sequence)).toEqual([1, 2, 3]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("round-trips private recovery snapshots without trace-style truncation", async () => {
    const root = await mkdtemp(join(tmpdir(), "harnest-v15-private-snapshot-"));
    try {
      const store = new FileRunStore(root);
      const largeResult = "result".repeat(20_000);
      const messages = Array.from({ length: 64 }, (_, index) => ({
        id: `message_${index}`, from: "agent_1", to: { kind: "run" as const },
        kind: "message" as const, content: `message ${index}`, createdAt: new Date().toISOString(),
      }));
      await store.saveSnapshot({
        runId: "run_private", revision: 1, status: "paused", tasks: [], agents: [], messages,
        revisions: [], proposals: [], updatedAt: new Date().toISOString(),
        turnCheckpoints: {
          "run:agent:0": {
            nextTurn: 1, workingState: {}, usage: {}, usageKnown: true, costUsd: 0, costKnown: true,
            finishReason: "tool", toolCalls: 1, fallbackUsed: false, pendingCalls: [], updatedAt: new Date().toISOString(),
            siblingResults: [{ callId: "call_1", name: "fixture", tool: "fixture", ok: true, output: largeResult }],
          },
        },
      });
      const restored = await store.readSnapshot("run_private");
      expect(restored?.messages).toHaveLength(64);
      expect(restored?.turnCheckpoints?.["run:agent:0"]?.siblingResults?.[0]?.output).toBe(largeResult);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps cross-instance readers away from an active recovery journal", async () => {
    const root = await mkdtemp(join(tmpdir(), "harnest-v15-run-lock-"));
    try {
      const writer = new FileRunStore(root);
      const reader = new FileRunStore(root);
      const snapshot = {
        runId: "run_locked", revision: 1, status: "paused" as const, tasks: [], agents: [], messages: [],
        revisions: [], proposals: [], updatedAt: new Date().toISOString(),
      };
      await writer.saveSnapshot(snapshot);
      await Promise.all(Array.from({ length: 20 }, async (_, index) => {
        const next = { ...snapshot, sequence: index + 2, revision: index + 2 };
        await Promise.all([
          writer.commit({
            type: "run-snapshot", runId: "run_locked", timestamp: new Date().toISOString(),
            sequence: index + 2, snapshot: next,
          }, next),
          reader.readSnapshot("run_locked"),
          reader.readEvents("run_locked"),
        ]);
      }));
      await expect(reader.readSnapshot("run_locked")).resolves.toMatchObject({ runId: "run_locked", revision: 21 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes commits from separate FileRunStore instances without snapshot regression", async () => {
    const root = await mkdtemp(join(tmpdir(), "harnest-v15-cross-store-"));
    try {
      const first = new FileRunStore(root);
      const second = new FileRunStore(root);
      const snapshot = (sequence: number) => ({
        runId: "run_cross_store", sequence, revision: sequence, status: "paused" as const,
        tasks: [], agents: [], messages: [], revisions: [], proposals: [], updatedAt: new Date().toISOString(),
      });
      const event = (sequence: number) => ({
        type: "run-snapshot" as const, runId: "run_cross_store", timestamp: new Date().toISOString(),
        sequence, snapshot: snapshot(sequence),
      });
      await Promise.all([first.commit(event(1), snapshot(1)), second.commit(event(2), snapshot(2))]);
      await expect(first.readSnapshot("run_cross_store")).resolves.toMatchObject({ sequence: 2, revision: 2 });
      await expect(second.readEvents("run_cross_store")).resolves.toEqual([
        expect.objectContaining({ sequence: 1 }), expect.objectContaining({ sequence: 2 }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects conflicting cross-process commits instead of regressing a Run", async () => {
    const root = await mkdtemp(join(tmpdir(), "harnest-cross-process-"));
    const module = pathToFileURL(join(process.cwd(), "packages/core/dist/node.js")).href;
    const script = `
      import { FileRunStore } from ${JSON.stringify(module)};
      const [root, runId, rawSequence] = process.argv.slice(1);
      const sequence = Number(rawSequence);
      const snapshot = { runId, sequence, revision: sequence, status: "paused", tasks: [], agents: [], messages: [], revisions: [], proposals: [], updatedAt: new Date().toISOString() };
      await new FileRunStore(root).commit({ type: "run-snapshot", runId, timestamp: new Date().toISOString(), sequence, snapshot }, snapshot);
    `;
    try {
      for (let index = 0; index < 4; index += 1) {
        const runId = `run_cross_process_${index}`;
        const outcomes = await Promise.allSettled([1, 2].map((sequence) => exec(
          process.execPath, ["--input-type=module", "-e", script, root, runId, String(sequence)],
        ).then(() => sequence)));
        const committed = outcomes.flatMap((outcome) => outcome.status === "fulfilled" ? [outcome.value] : []);
        expect(committed.length).toBeGreaterThan(0);
        const store = new FileRunStore(root);
        const snapshot = required(await store.readSnapshot(runId));
        const sequences = (await store.readEvents(runId)).flatMap(({ sequence }) => sequence === undefined ? [] : [sequence]);
        expect(sequences).toEqual([...new Set(sequences)].sort((left, right) => left - right));
        expect(snapshot.sequence).toBe(sequences.at(-1));
        if (committed.length === 2) expect(snapshot.sequence).toBe(2);
        else expect(committed).toContain(snapshot.sequence);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);

  it("pauses before a dangerous Tool side effect and resumes through RunHandle.send", async () => {
    let turns = 0;
    let executions = 0;
    const adapter: ModelAdapter = {
      id: "interaction-fixture",
      capabilities: { streaming: true, json: false, cancellation: true, tools: true },
      async *run(request) {
        turns += 1;
        if (turns === 1) {
          yield { type: "tool-call", call: {
            id: "danger_1", name: request.tools?.[0]?.name ?? "", input: { apiKey: "secret-value", contextRef: "opaque-ref" },
          } };
          yield { type: "finish", reason: "tool" };
        } else {
          yield { type: "text-delta", text: "done" };
          yield { type: "finish", reason: "stop" };
        }
      },
    };
    const tools = new ToolRegistry().register({
      id: "fixture.danger", label: "Danger", description: "Danger fixture", risk: "destructive",
      inputSchema: { type: "object", properties: { apiKey: { type: "string" }, contextRef: { type: "string" } }, additionalProperties: false },
      execute: () => { executions += 1; return "ok"; },
    });
    const spec = {
      version: "0.3",
      components: [
        { id: "model", type: "model", config: { adapter: adapter.id, model: "fixture" } },
        { id: "prompt", type: "prompt", config: { template: "{{input}}" } },
        { id: "tool", type: "tool", config: { tool: "fixture.danger", risk: "destructive" } },
        { id: "agent", type: "agent", config: {} },
        { id: "output", type: "output", config: { format: "text" } },
      ],
      connections: [
        { from: { component: "model", port: "model" }, to: { component: "agent", port: "model" } },
        { from: { component: "prompt", port: "prompt" }, to: { component: "agent", port: "prompt" } },
        { from: { component: "tool", port: "tool" }, to: { component: "agent", port: "tools" } },
        { from: { component: "agent", port: "response" }, to: { component: "output", port: "value" } },
      ],
      entrypoint: "output",
      runtime: { timeoutMs: 200 },
    } satisfies HarnessSpec;
    const commits: Array<{ event: RunEvent; snapshot: ReturnType<RunControl["snapshot"]> }> = [];
    const handle = new HarnessRuntime(spec, new AdapterRegistry().register(adapter), {
      tools,
      eventSink: {
        append() {},
        commit(event, snapshot) { commits.push({ event, snapshot }); },
      },
    }).start("go");
    let request: Extract<RunEvent, { type: "interaction-requested" }>["request"] | undefined;
    for await (const event of handle.events) {
      if (event.type === "interaction-requested") { request = event.request; break; }
    }
    expect(executions).toBe(0);
    expect(request?.data).toMatchObject({ input: { apiKey: "[REDACTED]", contextRef: "[REDACTED]" } });
    expect(JSON.stringify(request)).not.toContain("secret-value");
    expect(JSON.stringify(request)).not.toContain("opaque-ref");
    expect(commits.some(({ event, snapshot }) => event.type === "interaction-requested"
      && snapshot.pendingInteractions?.some(({ id }) => id === request?.id))).toBe(true);
    expect(handle.snapshot()).toMatchObject({
      status: "paused",
      turnCheckpoints: expect.objectContaining({
        "run:agent:0": expect.objectContaining({ pendingCalls: [expect.objectContaining({ id: "danger_1" })] }),
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(handle.snapshot()).toMatchObject({ status: "paused" });
    await handle.send({
      type: "interaction-response",
      response: {
        interactionId: request?.id,
        checkpointDigest: request?.checkpoint.digest,
        action: "submit",
        permission: "allow_once",
      },
    });
    await expect(handle.result()).resolves.toMatchObject({ output: "done" });
    expect(executions).toBe(1);
  });

  it("requires recovery confirmation for an in-flight external Tool and never replays it automatically", async () => {
    let turns = 0;
    let executions = 0;
    const adapter: ModelAdapter = {
      id: "recovery-fixture",
      capabilities: { streaming: true, json: false, cancellation: true, tools: true },
      async *run(request) {
        turns += 1;
        if (turns === 1) {
          yield { type: "tool-call", call: { id: "external_1", name: request.tools?.[0]?.name ?? "", input: { target: "remote" } } };
          yield { type: "finish", reason: "tool" };
        } else {
          yield { type: "text-delta", text: "recovered" };
          yield { type: "finish", reason: "stop" };
        }
      },
    };
    const tools = new ToolRegistry().register({
      id: "fixture.external", label: "External", description: "External fixture", risk: "external",
      inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"], additionalProperties: false },
      execute: () => { executions += 1; return "remote result"; },
    });
    const graph = {
      version: "0.3",
      components: [
        { id: "model", type: "model", config: { adapter: adapter.id, model: "fixture" } },
        { id: "prompt", type: "prompt", config: { template: "{{input}}" } },
        { id: "tool", type: "tool", config: { tool: "fixture.external", risk: "external" } },
        { id: "agent", type: "agent", config: {} },
        { id: "output", type: "output", config: { format: "text" } },
      ],
      connections: [
        { from: { component: "model", port: "model" }, to: { component: "agent", port: "model" } },
        { from: { component: "prompt", port: "prompt" }, to: { component: "agent", port: "prompt" } },
        { from: { component: "tool", port: "tool" }, to: { component: "agent", port: "tools" } },
        { from: { component: "agent", port: "response" }, to: { component: "output", port: "value" } },
      ], entrypoint: "output",
    } satisfies HarnessSpec;
    const runtime = new HarnessRuntime(graph, new AdapterRegistry().register(adapter), { tools });
    const first = runtime.start("go");
    for await (const event of first.events) if (event.type === "interaction-requested") break;
    const paused = first.snapshot();
    await first.cancel();
    executions = 1; // The external side effect completed, then the process crashed before the result checkpoint.
    const checkpointKey = Object.keys(paused.turnCheckpoints ?? {})[0]!;
    const uncertain = {
      ...paused,
      status: "running" as const,
      pendingInteractions: [],
      turnCheckpoints: {
        ...paused.turnCheckpoints,
        [checkpointKey]: { ...required(paused.turnCheckpoints?.[checkpointKey]), inFlightCalls: ["external_1"] },
      },
    };
    const resumed = runtime.resume("go", uncertain);
    let recovery: Extract<RunEvent, { type: "interaction-requested" }>["request"] | undefined;
    for await (const event of resumed.events) {
      if (event.type === "interaction-requested") { recovery = event.request; break; }
    }
    expect(recovery).toMatchObject({
      id: "recovery_agent_0_external_1", kind: "select",
      data: { reason: "recovery_required", toolId: "fixture.external", callId: "external_1" },
    });
    expect(executions).toBe(1);
    await resumed.send({ type: "interaction-response", response: {
      interactionId: recovery?.id,
      checkpointDigest: recovery?.checkpoint.digest,
      action: "submit",
      value: "mark_completed",
    } });
    await expect(resumed.result()).resolves.toMatchObject({ output: "recovered" });
    expect(executions).toBe(1);
  });
});
