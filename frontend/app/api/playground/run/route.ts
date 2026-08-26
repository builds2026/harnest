import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import {
  DiagnosticError,
  HarnessRuntime,
  validateSpec,
  type RunEvent,
} from "@harnestai/core";
import { acquireRunExecutionLease, loadSpecFile, releaseRunExecutionLease } from "@harnestai/core/node";
import { ApiRequestError, apiErrorResponse, assertSameOrigin, readJsonBody } from "../../../../lib/api-server";
import { runRegistry } from "../../../../lib/run-registry";
import { applyPlaygroundOverrides, playgroundCapabilities, type PlaygroundFile, type PlaygroundModelOption } from "../../../../lib/playground";
import { playgroundStore } from "../../../../lib/playground-store";
import { diagnosticResponse, harnessFile, hasErrors, runtimeOptionsFor, runtimeResourcesFor } from "../../../../lib/server";

export const runtime = "nodejs";

const text = (value: unknown, name: string, max: number) => {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > max) {
    throw new ApiRequestError("PLAYGROUND_INPUT_INVALID", `${name} must contain 1–${max} UTF-8 bytes`);
  }
  return value;
};

const stringList = (value: unknown, name: string, max: number) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== "string" || item.length > 128)) {
    throw new ApiRequestError("PLAYGROUND_INPUT_INVALID", `${name} is invalid`);
  }
  return [...new Set(value as string[])];
};

const modelSelection = (value: unknown): Pick<PlaygroundModelOption, "componentKey" | "connectionId"> | undefined => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiRequestError("PLAYGROUND_INPUT_INVALID", "Model selection is invalid");
  }
  const input = value as Record<string, unknown>;
  return {
    componentKey: text(input.componentKey, "Model component", 256),
    connectionId: text(input.connectionId, "Model connection", 128),
  };
};

const outputText = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "null";

export async function POST(request: Request) {
  let resources: Awaited<ReturnType<typeof runtimeResourcesFor>> | undefined;
  let workspace: {
    readonly workspaceId: string;
    readonly inputDirectory: string;
    readonly outputDirectory: string;
    readonly files: PlaygroundFile[];
  } | undefined;
  let activeSessionId: string | undefined;
  let leasedRunId: string | undefined;
  let leaseTransferred = false;
  const store = playgroundStore(harnessFile());
  try {
    assertSameOrigin(request);
    const body = await readJsonBody(request, 131_072);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ApiRequestError("PLAYGROUND_INPUT_INVALID", "Playground run body must be an object");
    }
    const input = body as Record<string, unknown>;
    const sessionId = text(input.sessionId, "Session id", 64);
    activeSessionId = sessionId;
    const message = text(input.message, "Message", 65_536);
    const resumeRunId = input.resumeRunId === undefined ? undefined : text(input.resumeRunId, "Resume run id", 128);
    if (resumeRunId && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(resumeRunId)) {
      throw new ApiRequestError("PLAYGROUND_INPUT_INVALID", "Resume run id is invalid");
    }
    const requestedFileIds = stringList(input.fileIds, "File selection", 32);
    const hasFileSelection = Object.hasOwn(input, "fileIds");
    const disabledPluginKeys = stringList(input.disabledPluginKeys, "Plugin selection", 128);
    const model = modelSelection(input.model);
    const loaded = await loadSpecFile(harnessFile());
    if (!loaded.ok) return diagnosticResponse(loaded.diagnostics);
    const capabilities = playgroundCapabilities(loaded.spec);
    const enabledCodeRunner = capabilities.plugins.some((plugin) => plugin.id === "builtin.code-runner"
      && !disabledPluginKeys.includes(plugin.componentKey));
    const session = await store.get(sessionId);
    const conversationCheckpoint = await store.checkpoint(sessionId);
    const fileIds = hasFileSelection ? requestedFileIds : [...(session.activeFileIds ?? [])];
    if (fileIds.length && !enabledCodeRunner && !capabilities.attachments.directModelInput) throw new ApiRequestError(
      "PLAYGROUND_ATTACHMENTS_UNSUPPORTED",
      "This harness must enable multimodal Agent input or its Code Runner before files can be sent",
      422,
    );
    await store.setActiveFiles(sessionId, fileIds);
    const candidate = applyPlaygroundOverrides(loaded.spec, { disabledPluginKeys, ...(model ? { model } : {}) });
    if (enabledCodeRunner || fileIds.length) workspace = await store.prepareWorkspace(sessionId, fileIds);
    resources = await runtimeResourcesFor(candidate, {
      ...(workspace ? { sandboxWorkspace: {
        inputDirectory: workspace.inputDirectory,
        outputDirectory: workspace.outputDirectory,
      } } : {}),
    });
    const validation = validateSpec(candidate, {
      registry: resources.adapters,
      components: resources.components,
      tools: resources.tools,
      env: process.env,
    });
    const diagnostics = [...resources.diagnostics, ...validation.diagnostics];
    if (hasErrors(diagnostics)) {
      await resources.services.close();
      resources = undefined;
      if (workspace) await store.cleanupWorkspace(sessionId, workspace.workspaceId);
      return diagnosticResponse(diagnostics);
    }
    const userMessage = {
      id: randomUUID(),
      role: "user" as const,
      content: message,
      createdAt: new Date().toISOString(),
      ...(fileIds.length ? { fileIds } : {}),
    };
    if (!resumeRunId) await store.append(sessionId, [userMessage]);
    const runtimeInstance = new HarnessRuntime(candidate, resources.adapters, runtimeOptionsFor(resources));
    const resumeSnapshot = resumeRunId ? await resources.runs.readSnapshot(resumeRunId) : undefined;
    if (resumeRunId && !resumeSnapshot) throw new ApiRequestError("RUN_SNAPSHOT_NOT_FOUND", "Run snapshot was not found", 404);
    const executionRunId = resumeRunId ?? randomUUID();
    await acquireRunExecutionLease(dirname(harnessFile()), executionRunId);
    leasedRunId = executionRunId;
    const runOptions = {
      session: {
        id: sessionId,
        messages: session.messages.map(({ role, content }) => ({ role, content })),
        ...(conversationCheckpoint ? { checkpoint: conversationCheckpoint } : {}),
        attachments: workspace?.files ?? [],
        ...(workspace ? { sandboxOutputPath: "/mnt/output" } : {}),
      },
    };
    const handle = resumeSnapshot
      ? runtimeInstance.resume(message, resumeSnapshot, runOptions)
      : runtimeInstance.start(message, runOptions, executionRunId);
    let finalized = false;
    let runId: string | undefined;
    const runWorkspace = enabledCodeRunner ? workspace : undefined;
    const finalize = async (event?: RunEvent): Promise<PlaygroundFile[]> => {
      if (finalized) return [];
      finalized = true;
      let files: PlaygroundFile[] = [];
      try {
        if (workspace) files = await store.finalizeWorkspace(sessionId, workspace.workspaceId, runId);
        if (event?.type === "run-end") {
          await store.append(sessionId, [{
            id: randomUUID(),
            role: "assistant",
            content: outputText(event.output),
            createdAt: new Date().toISOString(),
            runId: event.runId,
            usage: event.usage,
            costUsd: event.costUsd,
            finishReason: event.finishReason,
            ...(files.length ? { fileIds: files.map(({ id }) => id) } : {}),
          }]);
        } else if (event?.type === "error") {
          await store.append(sessionId, [{
            id: randomUUID(),
            role: "assistant",
            content: `Run failed: ${event.message}`,
            createdAt: new Date().toISOString(),
            runId: event.runId,
          }]);
        }
      } finally {
        if (workspace) await store.cleanupWorkspace(sessionId, workspace.workspaceId);
        await resources?.services.close();
      }
      return files;
    };
    let resolveFinalization!: (files: PlaygroundFile[]) => void;
    const finalization = new Promise<PlaygroundFile[]>((resolve) => { resolveFinalization = resolve; });
    runRegistry.add(handle, async () => {
      try {
        const result = await handle.result();
        resolveFinalization(await finalize({
          type: "run-end",
          runId: result.runId,
          timestamp: new Date().toISOString(),
          output: result.output,
          state: result.state,
          usage: result.usage,
          costUsd: result.costUsd,
          iterations: result.iterations,
          durationMs: result.durationMs,
          finishReason: result.finishReason,
          artifacts: result.artifacts,
        }));
      } catch (error) {
        resolveFinalization(await finalize({
          type: "error",
          runId: handle.runId,
          timestamp: new Date().toISOString(),
          code: error && typeof error === "object" && "code" in error ? String(error.code) : "PLAYGROUND_RUN_FAILED",
          message: error instanceof Error ? error.message : "Playground run failed",
          retryable: false,
        }));
      } finally {
        await releaseRunExecutionLease(dirname(harnessFile()), handle.runId);
      }
    });
    leaseTransferred = true;
    const iterator = (runRegistry.stream(handle.runId, 0, [], request.signal) as unknown as AsyncIterable<RunEvent>)[Symbol.asyncIterator]();
    const encoder = new TextEncoder();
    let terminal = false;
    let pendingNext: Promise<IteratorResult<RunEvent>> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (terminal) { controller.close(); return; }
        try {
          pendingNext ??= iterator.next();
          let timer: ReturnType<typeof setTimeout> | undefined;
          const next = runWorkspace ? await Promise.race([
            pendingNext.then((value) => ({ kind: "event" as const, value })),
            new Promise<{ kind: "files" }>((resolve) => { timer = setTimeout(() => resolve({ kind: "files" }), 750); }),
          ]) : { kind: "event" as const, value: await pendingNext };
          if (next.kind === "files") {
            // ponytail: live observation is best-effort; the final bounded scan remains authoritative.
            const files = await store.workspaceFiles(sessionId, runWorkspace!.workspaceId).catch(() => []);
            controller.enqueue(encoder.encode(`${JSON.stringify({
              type: "playground-files",
              timestamp: new Date().toISOString(),
              sessionId,
              live: true,
              files,
            })}\n`));
            return;
          }
          if (timer) clearTimeout(timer);
          pendingNext = undefined;
          if (next.value.done) {
            const event: RunEvent = {
              type: "error",
              runId: runId ?? `playground_${randomUUID()}`,
              timestamp: new Date().toISOString(),
              code: "PLAYGROUND_STREAM_ENDED",
              message: "The run stream ended before a final event arrived",
              retryable: false,
            };
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
            await finalize(event);
            terminal = true;
            return;
          }
          const event = next.value.value;
          if (event.type === "run-start") runId = event.runId;
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          if (event.type === "run-end" || event.type === "error") {
            const files = await finalization;
            if (files.length) controller.enqueue(encoder.encode(`${JSON.stringify({
              type: "playground-files",
              timestamp: new Date().toISOString(),
              sessionId,
              live: false,
              files,
            })}\n`));
            terminal = true;
          }
        } catch (error) {
          const event = {
            type: "error",
            runId: runId ?? `playground_${randomUUID()}`,
            timestamp: new Date().toISOString(),
            code: error instanceof DiagnosticError ? "PLAYGROUND_DIAGNOSTIC" : "PLAYGROUND_RUN_FAILED",
            message: error instanceof Error ? error.message : "Playground run failed",
            retryable: false,
          } as RunEvent;
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          await finalize(event);
          terminal = true;
        }
      },
      async cancel() {
        await iterator.return?.();
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    if (leasedRunId && !leaseTransferred) await releaseRunExecutionLease(dirname(harnessFile()), leasedRunId).catch(() => undefined);
    if (workspace && activeSessionId) await store.cleanupWorkspace(activeSessionId, workspace.workspaceId).catch(() => undefined);
    await resources?.services.close();
    return apiErrorResponse(error instanceof ApiRequestError ? error : new ApiRequestError(
      "PLAYGROUND_RUN_INVALID",
      error instanceof Error ? error.message : "Playground run could not start",
      400,
    ));
  }
}
