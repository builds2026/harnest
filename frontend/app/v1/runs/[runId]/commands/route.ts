import { dirname } from "node:path";
import { RunCommandSchema, type RunCommand } from "@harnestai/protocol";
import { FileRunStore } from "@harnestai/core/node";
import { ApiRequestError, apiErrorResponse, assertSameOrigin, readJsonBody } from "@/lib/api-server";
import { runRegistry } from "@/lib/run-registry";
import { harnessFile } from "@/lib/server";

export const runtime = "nodejs";

const toCoreCommand = (command: RunCommand) => {
  const id = command.commandId;
  if (command.type === "interaction.response") {
    return { ...(id ? { id } : {}), type: "interaction-response", response: command.response };
  }
  const value = { ...command } as Record<string, unknown>;
  delete value.commandId;
  return { ...(id ? { id } : {}), ...value };
};

export async function POST(request: Request, context: { params: Promise<{ runId: string }> }) {
  try {
    assertSameOrigin(request);
    const { runId } = await context.params;
    const parsed = RunCommandSchema.safeParse(await readJsonBody(request, 1_048_576));
    if (!parsed.success) throw new ApiRequestError("RUN_COMMAND_INVALID", "Run command does not match protocol v1", 400);
    if (!await runRegistry.send(runId, toCoreCommand(parsed.data))) {
      const snapshot = await new FileRunStore(dirname(harnessFile())).readSnapshot(runId);
      if (snapshot?.status === "paused") throw new ApiRequestError(
        "RUN_RECOVERY_REQUIRED",
        "Resume this Run with POST /v1/runs and the original context before sending a command",
        409,
      );
      throw new ApiRequestError("RUN_NOT_ACTIVE", "Run is not active", 409);
    }
    return Response.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
