import { createBuiltinComponentRegistry, parseSpec, stringifySpec } from "@harnest/core";
import { loadSpecFile, saveSpecFile } from "@harnest/core/node";
import { EMPTY_SPEC } from "@/lib/default-spec";
import {
  diagnosticResponse,
  fileExists,
  harnessFile,
  requestDiagnostic,
  runtimeResourcesFor,
} from "@/lib/server";
import { hostCapabilityDiagnosticsFor, studioCapabilityPolicy } from "@/lib/runtime-config";
import { apiErrorResponse, assertSameOrigin, readJsonBody } from "@/lib/api-server";

export const runtime = "nodejs";

export async function GET() {
  const file = harnessFile();
  try {
    if (!(await fileExists(file))) {
      return Response.json({
        spec: EMPTY_SPEC,
        yaml: stringifySpec(EMPTY_SPEC),
        file,
        exists: false,
        catalog: createBuiltinComponentRegistry().catalog(),
      });
    }
    const loaded = await loadSpecFile(file);
    if (!loaded.ok) return diagnosticResponse(loaded.diagnostics);
    const resources = await runtimeResourcesFor(loaded.spec);
    try {
      return Response.json({
        spec: loaded.spec,
        yaml: stringifySpec(loaded.spec),
        file,
        exists: true,
        catalog: resources.components.catalog(),
        diagnostics: resources.diagnostics,
      });
    } finally {
      await resources.services.close();
    }
  } catch {
    return diagnosticResponse([requestDiagnostic("Could not load the harness")], 500);
  }
}

export async function PUT(request: Request) {
  let yaml: unknown;
  try {
    assertSameOrigin(request);
    const body = await readJsonBody(request, 2_097_152);
    ({ yaml } = body as { yaml?: unknown });
  } catch (error) {
    return apiErrorResponse(error);
  }
  if (typeof yaml !== "string") return diagnosticResponse([requestDiagnostic("yaml must be a string")], 400);

  const parsed = parseSpec(yaml);
  if (!parsed.ok) return diagnosticResponse(parsed.diagnostics);
  try {
    await saveSpecFile(harnessFile(), parsed.spec);
    return Response.json({
      ok: true,
      diagnostics: hostCapabilityDiagnosticsFor(parsed.spec, studioCapabilityPolicy(process.env)),
      yaml: stringifySpec(parsed.spec),
    });
  } catch {
    return diagnosticResponse([{
      code: "FILE_WRITE",
      path: harnessFile(),
      message: "Could not save harnest.yaml",
      severity: "error",
    }], 500);
  }
}
