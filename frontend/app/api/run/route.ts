import {
  DiagnosticError,
  HarnessRuntime,
  validateSpec,
  type RunEvent,
} from "@harnest/core";
import { loadSpecFile } from "@harnest/core/node";
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
    ({ input } = await request.json() as { input?: unknown });
  } catch {
    return diagnosticResponse([requestDiagnostic("Request body must be JSON")], 400);
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
  if (hasErrors(diagnostics)) return diagnosticResponse(diagnostics);

  let runtimeInstance: HarnessRuntime;
  try {
    runtimeInstance = new HarnessRuntime(loaded.spec, resources.adapters, runtimeOptionsFor(resources));
  } catch (error) {
    if (error instanceof DiagnosticError) return diagnosticResponse(error.diagnostics);
    return diagnosticResponse([requestDiagnostic(error instanceof Error ? error.message : "Could not start the harness runtime")], 500);
  }

  const iterator = runtimeInstance.stream(input, { signal: request.signal })[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          await resources.services.close();
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(`${JSON.stringify(next.value satisfies RunEvent)}\n`));
      } catch {
        await resources.services.close();
        controller.close();
      }
    },
    async cancel() {
      await iterator.return?.();
      await resources.services.close();
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
