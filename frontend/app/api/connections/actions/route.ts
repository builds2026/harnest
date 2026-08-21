import { dirname } from "node:path";
import { ApiRequestError, apiErrorResponse, assertSameOrigin, readJsonBody } from "@/lib/api-server";
import { StudioConnectionService } from "@/lib/connections-server";
import type { ConnectionAction } from "@/lib/connections";
import { harnessFile } from "@/lib/server";

export const runtime = "nodejs";

const ACTIONS = ["test", "discover", "approve-process", "disconnect", "reauth", "revoke"] as const satisfies readonly ConnectionAction[];

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await readJsonBody(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ApiRequestError("CONNECTION_ACTION_INVALID", "Connection action must be an object");
    }
    const { id, action } = body as { id?: unknown; action?: unknown };
    if (typeof id !== "string" || typeof action !== "string" || !ACTIONS.includes(action as typeof ACTIONS[number])) {
      throw new ApiRequestError("CONNECTION_ACTION_INVALID", "Connection id or action is invalid");
    }
    const callback = new URL("/api/connections/oauth/callback", new URL(request.url).origin);
    callback.searchParams.set("id", id);
    const result = await new StudioConnectionService(dirname(harnessFile())).action(
      id,
      action as typeof ACTIONS[number],
      { redirectUrl: callback.toString() },
    );
    return Response.json(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
