import { PROTOCOL_VERSION } from "@harnestai/protocol";

export const runtime = "nodejs";

export function GET() {
  return Response.json({
    protocolVersion: PROTOCOL_VERSION,
    transports: ["http", "sse"],
    reconnect: { lastEventId: true, after: true },
    commands: ["message", "task-directive", "plan-patch", "interaction.response", "cancel"],
    interactions: ["select", "input", "form", "file", "oauth", "permission"],
    permissions: ["allow_once", "allow_for_run", "allow_always", "deny"],
  }, { headers: { "cache-control": "no-store" } });
}
