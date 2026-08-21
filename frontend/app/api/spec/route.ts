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
    return Response.json({
      spec: loaded.spec,
      yaml: stringifySpec(loaded.spec),
      file,
      exists: true,
      catalog: resources.components.catalog(),
      diagnostics: resources.diagnostics,
    });
  } catch (error) {
    return diagnosticResponse([requestDiagnostic(error instanceof Error ? error.message : `Could not load '${file}'`)], 500);
  }
}

export async function PUT(request: Request) {
  let yaml: unknown;
  try {
    ({ yaml } = await request.json() as { yaml?: unknown });
  } catch {
    return diagnosticResponse([requestDiagnostic("Request body must be JSON")], 400);
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
  } catch (error) {
    return diagnosticResponse([{
      code: "FILE_WRITE",
      path: harnessFile(),
      message: error instanceof Error ? error.message : "Could not save harnest.yaml",
      severity: "error",
    }], 500);
  }
}
