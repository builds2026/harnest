import { runHarnessTests, validateSpec } from "@harnest/core";
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
  try {
    // The endpoint currently has no options, but rejects accidental malformed payloads.
    const body = await request.text();
    if (body) JSON.parse(body);
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

  try {
    const report = await runHarnessTests(
      loaded.spec,
      resources.adapters,
      { ...runtimeOptionsFor(resources), signal: request.signal },
    );
    return Response.json(report);
  } catch (error) {
    return diagnosticResponse([requestDiagnostic(error instanceof Error ? error.message : "Could not run harness tests")], 500);
  } finally {
    await resources.services.close();
  }
}
