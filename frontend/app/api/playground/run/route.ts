import { randomUUID } from "node:crypto";
import {
  DiagnosticError,
  HarnessRuntime,
  validateSpec,
  type RunEvent,
} from "@harnest/core";
import { loadSpecFile } from "@harnest/core/node";
import { ApiRequestError, apiErrorResponse, assertSameOrigin, readJsonBody } from "../../../../lib/api-server";
import { approvalBroker } from "../../../../lib/approval-broker";
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
    const fileIds = stringList(input.fileIds, "File selection", 32);
    const disabledPluginKeys = stringList(input.disabledPluginKeys, "Plugin selection", 128);
    const model = modelSelection(input.model);
    const loaded = await loadSpecFile(harnessFile());
    if (!loaded.ok) return diagnosticResponse(loaded.diagnostics);
    const capabilities = playgroundCapabilities(loaded.spec);
    const enabledCodeRunner = capabilities.plugins.some((plugin) => plugin.id === "builtin.code-runner"
      && !disabledPluginKeys.includes(plugin.componentKey));
    if (fileIds.length && !enabledCodeRunner) throw new ApiRequestError(
      "PLAYGROUND_ATTACHMENTS_UNSUPPORTED",
      "This harness must enable its Code Runner before files can be sent",
      422,
    );
    const session = await store.get(sessionId);
    const candidate = applyPlaygroundOverrides(loaded.spec, { disabledPluginKeys, ...(model ? { model } : {}) });
    if (enabledCodeRunner) workspace = await store.prepareWorkspace(sessionId, fileIds);
    resources = await runtimeResourcesFor(candidate, {
      requestToolApproval: (approval, context) => approvalBroker.request(approval, context.signal),
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
    await store.append(sessionId, [userMessage]);
    const runtimeInstance = new HarnessRuntime(candidate, resources.adapters, runtimeOptionsFor(resources));
    const iterator = runtimeInstance.stream(message, {
      signal: request.signal,
      session: {
        messages: session.messages.map(({ role, content }) => ({ role, content })),
        attachments: workspace?.files ?? [],
        ...(workspace ? { sandboxOutputPath: "/mnt/output" } : {}),
        maxHistoryMessages: 20,
        maxHistoryBytes: 65_536,
      },
    })[Symbol.asyncIterator]();
    const encoder = new TextEncoder();
    let terminal = false;
    let finalized = false;
    let runId: string | undefined;
    let pendingNext: Promise<IteratorResult<RunEvent>> | undefined;
    const runWorkspace = workspace;
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
            const files = await finalize(event);
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
        await finalize({
          type: "error",
          runId: runId ?? `playground_${randomUUID()}`,
          timestamp: new Date().toISOString(),
          code: "PLAYGROUND_CANCELLED",
          message: "Run cancelled",
          retryable: false,
        });
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
    if (workspace && activeSessionId) await store.cleanupWorkspace(activeSessionId, workspace.workspaceId).catch(() => undefined);
    await resources?.services.close();
    return apiErrorResponse(error instanceof ApiRequestError ? error : new ApiRequestError(
      "PLAYGROUND_RUN_INVALID",
      error instanceof Error ? error.message : "Playground run could not start",
      400,
    ));
  }
}
