import { parseSpec, validateSpec } from "@harnest/core";
import { diagnosticResponse, hasErrors, requestDiagnostic, runtimeResourcesFor } from "@/lib/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let yaml: unknown;
  try {
    ({ yaml } = await request.json() as { yaml?: unknown });
  } catch {
    return diagnosticResponse([requestDiagnostic("Request body must be JSON")], 400);
  }
  if (typeof yaml !== "string") return diagnosticResponse([requestDiagnostic("yaml must be a string")], 400);

  const parsed = parseSpec(yaml);
  if (!parsed.ok) return Response.json({ ok: false, diagnostics: parsed.diagnostics });
  try {
    const resources = await runtimeResourcesFor(parsed.spec);
    const validation = validateSpec(parsed.spec, {
      registry: resources.adapters,
      components: resources.components,
      tools: resources.tools,
      env: process.env,
    });
    const diagnostics = [...resources.diagnostics, ...validation.diagnostics];
    return Response.json({ ok: !hasErrors(diagnostics), diagnostics, catalog: resources.components.catalog() });
  } catch (error) {
    return diagnosticResponse([requestDiagnostic(error instanceof Error ? error.message : "Could not validate the harness")], 500);
  }
}
