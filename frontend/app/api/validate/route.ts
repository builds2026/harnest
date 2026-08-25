import { compileSpec, parseSpec, validateSpec } from "@harnest/core";
import { apiErrorResponse, assertSameOrigin, readJsonBody } from "../../../lib/api-server";
import { diagnosticResponse, hasErrors, requestDiagnostic, runtimeResourcesFor } from "../../../lib/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
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
  if (!parsed.ok) return Response.json({ ok: false, diagnostics: parsed.diagnostics });
  let resources: Awaited<ReturnType<typeof runtimeResourcesFor>> | undefined;
  try {
    resources = await runtimeResourcesFor(parsed.spec);
    const validation = validateSpec(parsed.spec, {
      registry: resources.adapters,
      components: resources.components,
      tools: resources.tools,
      env: process.env,
    });
    const diagnostics = [...resources.diagnostics, ...validation.diagnostics];
    const catalog = resources.components.catalog();
    if (hasErrors(diagnostics)) return Response.json({ ok: false, diagnostics, catalog });
    const compiled = compileSpec(parsed.spec, {
      registry: resources.adapters,
      components: resources.components,
      tools: resources.tools,
      env: process.env,
    });
    if (!compiled.ok) return Response.json({ ok: false, diagnostics: [...resources.diagnostics, ...compiled.diagnostics], catalog });
    return Response.json({
      ok: true,
      diagnostics: compiled.diagnostics,
      catalog,
      plan: {
        nodeCount: compiled.plan.nodes.length,
        edgeCount: compiled.plan.edges.length,
        layerCount: compiled.plan.layers.length,
        entrypoint: compiled.plan.entrypoint,
        sourceVersion: compiled.plan.sourceVersion,
        timeoutMs: compiled.plan.runtime.timeoutMs,
      },
    });
  } catch {
    return diagnosticResponse([requestDiagnostic("Could not validate the harness")], 500);
  } finally {
    await resources?.services.close();
  }
}
