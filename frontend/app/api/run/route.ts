import {
  DiagnosticError,
  HarnessRuntime,
  validateSpec,
  type RunEvent,
} from "@harnestai/core";
import { loadSpecFile } from "@harnestai/core/node";
import { ApiRequestError, apiErrorResponse, assertSameOrigin, readJsonBody } from "@/lib/api-server";
import { runRegistry } from "@/lib/run-registry";
import {
  diagnosticResponse,
  harnessFile,
  hasErrors,
  requestDiagnostic,
  runtimeOptionsFor,
  runtimeResourcesFor,
} from "@/lib/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let input: unknown;
  try {
    assertSameOrigin(request);
    const body = await readJsonBody(request, 1_048_576);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiRequestError("RUN_INPUT_INVALID", "Run body must be an object");
    ({ input } = body as { input?: unknown });
  } catch (error) {
    return apiErrorResponse(error);
  }

  const loaded = await loadSpecFile(harnessFile());
  if (!loaded.ok) return diagnosticResponse(loaded.diagnostics);
  const resources = await runtimeResourcesFor(loaded.spec);
  const validation = validateSpec(loaded.spec, {
    registry: resources.adapters,
    components: resources.components,
    tools: resources.tools,
    env: process.env,
  });
  const diagnostics = [...resources.diagnostics, ...validation.diagnostics];
  if (hasErrors(diagnostics)) {
    await resources.services.close();
    return diagnosticResponse(diagnostics);
  }

  let runtimeInstance: HarnessRuntime;
  try {
    runtimeInstance = new HarnessRuntime(loaded.spec, resources.adapters, runtimeOptionsFor(resources));
  } catch (error) {
    await resources.services.close();
    if (error instanceof DiagnosticError) return diagnosticResponse(error.diagnostics);
    return diagnosticResponse([requestDiagnostic("Could not start the harness runtime")], 500);
  }

  const handle = runtimeInstance.start(input, { signal: request.signal });
  await runRegistry.add(handle, () => resources.services.close());
  const iterator = (runRegistry.stream(handle.runId, 0, [], request.signal) as AsyncIterable<RunEvent>)[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(`${JSON.stringify(next.value satisfies RunEvent)}\n`));
      } catch {
        controller.close();
      }
    },
    async cancel() {
      await iterator.return?.();
      await runRegistry.cancel(handle.runId);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-content-type-options": "nosniff",
    },
  });
}
