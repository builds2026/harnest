import { ApiRequestError, apiErrorResponse, assertSameOrigin, readJsonBody } from "@/lib/api-server";
import { approvalBroker } from "@/lib/approval-broker";

export const runtime = "nodejs";

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const CALL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await readJsonBody(request, 8_192);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ApiRequestError("APPROVAL_INVALID", "Approval decision must be an object");
    }
    const { action, runId, nodeId, callId, turn, approved, inputDigest } = body as Record<string, unknown>;
    if (typeof runId !== "string" || !RUN_ID.test(runId)
      || typeof nodeId !== "string" || !NODE_ID.test(nodeId)
      || typeof callId !== "string" || !CALL_ID.test(callId)
      || !Number.isInteger(turn) || (turn as number) < 1 || (turn as number) > 128) {
      throw new ApiRequestError("APPROVAL_INVALID", "Run, call, or decision is invalid");
    }
    if (action === "inspect") {
      const approval = approvalBroker.pending(runId, nodeId, turn as number, callId);
      if (!approval) throw new ApiRequestError("APPROVAL_NOT_PENDING", "This approval is no longer pending", 409);
      return Response.json({ ok: true, approval });
    }
    if (typeof approved !== "boolean" || typeof inputDigest !== "string" || !DIGEST.test(inputDigest)) {
      throw new ApiRequestError("APPROVAL_INVALID", "Approval decision or input digest is invalid");
    }
    if (!approvalBroker.decide(runId, nodeId, turn as number, callId, inputDigest, approved)) {
      throw new ApiRequestError("APPROVAL_NOT_PENDING", "This approval is no longer pending", 409);
    }
    return Response.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
