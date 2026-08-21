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
import { apiErrorResponse, assertSameOrigin, readJsonBody } from "@/lib/api-server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await readJsonBody(request, 8_192);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) {
      return diagnosticResponse([requestDiagnostic("Test options must be an empty object")], 400);
    }
  } catch (error) {
    return apiErrorResponse(error);
  }

  const loaded = await loadSpecFile(harnessFile());
  if (!loaded.ok) return diagnosticResponse(loaded.diagnostics);
  const resources = await runtimeResourcesFor(loaded.spec);
  try {
    const validation = validateSpec(loaded.spec, {
      registry: resources.adapters,
      components: resources.components,
      tools: resources.tools,
      env: process.env,
    });
    const diagnostics = [...resources.diagnostics, ...validation.diagnostics];
    if (hasErrors(diagnostics)) return diagnosticResponse(diagnostics);
    const report = await runHarnessTests(
      loaded.spec,
      resources.adapters,
      { ...runtimeOptionsFor(resources), signal: request.signal },
    );
    return Response.json(report);
  } catch {
    return diagnosticResponse([requestDiagnostic("Could not run harness tests")], 500);
  } finally {
    await resources.services.close();
  }
}
