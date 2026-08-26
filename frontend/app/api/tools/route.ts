import { randomUUID } from "node:crypto";
import type { StoredToolManifest } from "@harnestai/core/node";
import { ApiRequestError, apiErrorResponse, assertSameOrigin, readJsonBody } from "@/lib/api-server";
import { EMPTY_SPEC } from "@/lib/default-spec";
import { runtimeResourcesFor } from "@/lib/server";

export const runtime = "nodejs";

const TOOL_ID = /^[a-z][a-z0-9._-]{0,127}$/;
const CONNECTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiRequestError("TOOL_INPUT_INVALID", "Tool request must be an object");
  }
  return value as Record<string, unknown>;
};

export async function POST(request: Request) {
  let resources: Awaited<ReturnType<typeof runtimeResourcesFor>> | undefined;
  try {
    assertSameOrigin(request);
    const body = record(await readJsonBody(request, 2_097_152));
    const action = body.action;
    if (action !== "save" && action !== "test" && action !== "import-openapi") {
      throw new ApiRequestError("TOOL_ACTION_INVALID", "Tool action is invalid");
    }
    resources = await runtimeResourcesFor(EMPTY_SPEC);
    if (action === "import-openapi") {
      if (typeof body.document !== "string" || !body.document || body.document.length > 1_024
        || (body.operationIds !== undefined && (!Array.isArray(body.operationIds)
          || body.operationIds.length > 128 || body.operationIds.some((id) => typeof id !== "string" || id.length > 200)))) {
        throw new ApiRequestError("OPENAPI_IMPORT_INVALID", "OpenAPI document or operation selection is invalid");
      }
      const imported = await resources.toolStore.importOpenApi(body.document, {
        ...(Array.isArray(body.operationIds) ? { operationIds: body.operationIds as string[] } : {}),
      });
      const tools = await Promise.all(imported.tools.map((tool) => resources!.toolStore.save(tool)));
      return Response.json({ tools, warnings: imported.warnings }, { status: 201 });
    }
    const manifest = record(body.manifest) as unknown as StoredToolManifest;
    if (action === "save") {
      const tool = await resources.toolStore.save(manifest);
      return Response.json({ tool }, { status: 201 });
    }
    if (body.connectionId !== undefined && (typeof body.connectionId !== "string" || !CONNECTION_ID.test(body.connectionId))) {
      throw new ApiRequestError("TOOL_CONNECTION_INVALID", "Tool test connection id is invalid");
    }
    const output = await resources.toolStore.execute(manifest, body.input, {
      signal: request.signal,
      runId: `tool_test_${randomUUID().replaceAll("-", "")}`,
      nodeId: "custom-tool-test",
      iteration: 0,
      resolveSecret: () => undefined,
    }, { ...(typeof body.connectionId === "string" ? { connectionId: body.connectionId } : {}) });
    return Response.json({ ok: true, output });
  } catch (error) {
    return apiErrorResponse(error);
  } finally {
    await resources?.services.close();
  }
}

export async function DELETE(request: Request) {
  let resources: Awaited<ReturnType<typeof runtimeResourcesFor>> | undefined;
  try {
    assertSameOrigin(request);
    const body = record(await readJsonBody(request, 8_192));
    if (typeof body.id !== "string" || !TOOL_ID.test(body.id)) {
      throw new ApiRequestError("TOOL_ID_INVALID", "Tool id is invalid");
    }
    resources = await runtimeResourcesFor(EMPTY_SPEC);
    await resources.toolStore.delete(body.id);
    return new Response(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  } finally {
    await resources?.services.close();
  }
}
