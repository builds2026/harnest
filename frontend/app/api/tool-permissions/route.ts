import { dirname } from "node:path";
import { NodeRuntimeServices } from "@harnestai/core/node";
import { ApiRequestError, apiErrorResponse, assertSameOrigin, readJsonBody } from "@/lib/api-server";
import { harnessFile } from "@/lib/server";

export const runtime = "nodejs";

const TOOL_ID = /^[a-z][a-z0-9._-]{0,127}$/;
const CONNECTION_ID = /^[a-z][a-z0-9._-]{0,127}$/;
const CAPABILITIES = new Set(["tool-execution", "workspace-read", "workspace-write", "process", "network", "module-execution"]);

const services = () => new NodeRuntimeServices(dirname(harnessFile()), { harnessId: harnessFile() });

export async function GET() {
  const runtimeServices = services();
  try {
    const permissions = (await runtimeServices.listToolPermissions()).map(({ harnessId: _harnessId, ...permission }) => permission);
    return Response.json({ permissions });
  } catch (error) {
    return apiErrorResponse(new ApiRequestError(
      "TOOL_PERMISSIONS_READ_FAILED",
      error instanceof Error ? error.message : "Tool permissions could not be loaded",
      500,
    ));
  } finally {
    await runtimeServices.close();
  }
}

export async function DELETE(request: Request) {
  let runtimeServices: NodeRuntimeServices | undefined;
  try {
    assertSameOrigin(request);
    const body = await readJsonBody(request, 8_192);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ApiRequestError("TOOL_PERMISSION_INVALID", "Tool permission must be an object");
    }
    const { toolId, connectionId, capability, resource } = body as Record<string, unknown>;
    if (typeof toolId !== "string" || !TOOL_ID.test(toolId)
      || (connectionId !== undefined && (typeof connectionId !== "string" || !CONNECTION_ID.test(connectionId)))
      || (capability !== undefined && (typeof capability !== "string" || !CAPABILITIES.has(capability)))
      || (resource !== undefined && (typeof resource !== "string" || resource.length > 512))) {
      throw new ApiRequestError("TOOL_PERMISSION_INVALID", "Tool or Connection id is invalid");
    }
    runtimeServices = services();
    const revoked = await runtimeServices.revokeToolPermission(
      toolId,
      connectionId as string | undefined,
      capability as Parameters<NodeRuntimeServices["revokeToolPermission"]>[2],
      resource as string | undefined,
    );
    if (!revoked) throw new ApiRequestError("TOOL_PERMISSION_NOT_FOUND", "Tool permission was not found", 404);
    return Response.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  } finally {
    await runtimeServices?.close();
  }
}
