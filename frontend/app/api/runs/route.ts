import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { DiagnosticError, HarnessRuntime, validateSpec, type RunOptions } from "@harnestai/core";
import { loadSpecFile } from "@harnestai/core/node";
import { FileRunStore } from "@harnestai/core/node";
import { CreateRunRequestSchema, type CreateRunContext } from "@harnestai/protocol";
import { ApiRequestError, apiErrorResponse, assertSameOrigin, readJsonBody } from "@/lib/api-server";
import { runRegistry } from "@/lib/run-registry";
import {
  abandonIdempotentRun,
  acquireRunExecutionLease,
  createIdempotencyKey,
  markIdempotentRunStarted,
  reserveIdempotentRun,
  releaseRunExecutionLease,
  waitForIdempotentRun,
} from "@/lib/run-idempotency";
import {
  diagnosticResponse,
  harnessFile,
  hasErrors,
  requestDiagnostic,
  runtimeOptionsFor,
  runtimeResourcesFor,
} from "@/lib/server";

export const runtime = "nodejs";

const sessionFromContext = (context: CreateRunContext): NonNullable<RunOptions["session"]> => {
  const revisions = context.revisions ? {
    ...(context.revisions.conversation === undefined ? {} : { conversation: context.revisions.conversation }),
    ...(context.revisions.memory === undefined ? {} : { memory: context.revisions.memory }),
    ...(context.revisions.pkm === undefined ? {} : { pkm: context.revisions.pkm }),
  } : undefined;
  return {
    contextRef: context.contextRef,
    ...(revisions ? { revisions } : {}),
    ...(context.attachments ? { attachments: context.attachments.map((attachment) => ({
      id: attachment.ref,
      ref: attachment.ref,
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.size,
    })) } : {}),
  };
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const runId = url.searchParams.get("runId");
  const runs = new FileRunStore(dirname(harnessFile()));
  try {
    if (runId) {
      const events = await runs.read(runId);
      return Response.json({ run: { runId, events } });
    }
    const requestedLimit = Number(url.searchParams.get("limit") ?? 50);
    const limit = Number.isFinite(requestedLimit) ? requestedLimit : 50;
    return Response.json({ runs: await runs.list(limit) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load run history";
    const notFound = error && typeof error === "object" && "code" in error && error.code === "ENOENT";
    return diagnosticResponse([requestDiagnostic(message)], notFound ? 404 : 400);
  }
}

export async function POST(request: Request) {
  let input: unknown;
  let resumeRunId: string | undefined;
  let runContext: CreateRunContext | undefined;
  let idempotencyKey: string | undefined;
  try {
    assertSameOrigin(request);
    const body = await readJsonBody(request, 1_048_576);
    const versioned = new URL(request.url).pathname.startsWith("/v1/");
    const parsed = versioned ? CreateRunRequestSchema.safeParse(body) : undefined;
    if (parsed && !parsed.success) {
      throw new ApiRequestError("RUN_INPUT_INVALID", "Run body does not match protocol v1", 400);
    }
    if (!versioned && (!body || typeof body !== "object" || Array.isArray(body) || !Object.hasOwn(body, "input"))) {
      throw new ApiRequestError("RUN_INPUT_INVALID", "Run body requires input");
    }
    input = parsed?.data.input ?? (body as { input: unknown }).input;
    const resume = parsed?.data.resumeRunId ?? (body as { resumeRunId?: unknown }).resumeRunId;
    if (!parsed && resume !== undefined && (typeof resume !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(resume))) {
      throw new ApiRequestError("RUN_RESUME_INVALID", "resumeRunId is invalid");
    }
    resumeRunId = resume as string | undefined;
    runContext = parsed?.data.context;
    idempotencyKey = versioned ? createIdempotencyKey(request.headers.get("idempotency-key")) : undefined;
  } catch (error) {
    return apiErrorResponse(error);
  }

  const projectDirectory = dirname(harnessFile());
  const loaded = await loadSpecFile(harnessFile());
  if (!loaded.ok) return diagnosticResponse(loaded.diagnostics);
  let resources: Awaited<ReturnType<typeof runtimeResourcesFor>>;
  try {
    resources = await runtimeResourcesFor(loaded.spec);
  } catch (error) {
    return diagnosticResponse([requestDiagnostic(error instanceof Error ? error.message : "Could not prepare the Harness runtime")], 500);
  }
  const validation = validateSpec(loaded.spec, {
    registry: resources.adapters,
    components: resources.components,
    tools: resources.tools,
    env: process.env,
  });
  const diagnostics = [...resources.diagnostics, ...validation.diagnostics];
  if (hasErrors(diagnostics)) {
    await resources.services.close();
    return diagnosticResponse(diagnostics);
  }
  let ownedReservationRunId: string | undefined;
  let leasedRunId: string | undefined;
  let leaseTransferred = false;
  let runRegistered = false;
  try {
    const runtimeInstance = new HarnessRuntime(loaded.spec, resources.adapters, runtimeOptionsFor(resources));
    const snapshot = resumeRunId ? await resources.runs.readSnapshot(resumeRunId) : undefined;
    if (resumeRunId && !snapshot) throw new ApiRequestError("RUN_SNAPSHOT_NOT_FOUND", "Run snapshot was not found", 404);
    const durableRunExists = async (runId: string) => runRegistry.has(runId)
      || Boolean(await resources.runs.readSnapshot(runId))
      || await resources.runs.readEvents(runId).then((events) => events.length > 0, () => false);
    const reservation = idempotencyKey ? await reserveIdempotentRun(
      projectDirectory,
      idempotencyKey,
      resumeRunId,
      durableRunExists,
    ) : undefined;
    if (reservation && !reservation.owner) {
      const settled = await waitForIdempotentRun(projectDirectory, idempotencyKey!, 5_000, durableRunExists);
      await resources.services.close();
      return Response.json({
        ok: true,
        runId: settled.runId,
        events: `/api/runs/${encodeURIComponent(settled.runId)}/events`,
        snapshot: `/api/runs/${encodeURIComponent(settled.runId)}/snapshot`,
      }, { status: 202 });
    }
    ownedReservationRunId = reservation?.runId;
    if (resumeRunId && runRegistry.active(resumeRunId)) {
      if (idempotencyKey && ownedReservationRunId) {
        await abandonIdempotentRun(projectDirectory, idempotencyKey, ownedReservationRunId);
        ownedReservationRunId = undefined;
      }
      throw new ApiRequestError("RUN_ALREADY_ACTIVE", `Run '${resumeRunId}' is already active`, 409);
    }
    const executionRunId = resumeRunId ?? reservation?.runId ?? randomUUID();
    await acquireRunExecutionLease(projectDirectory, executionRunId);
    leasedRunId = executionRunId;
    if (idempotencyKey && reservation) await markIdempotentRunStarted(projectDirectory, idempotencyKey, reservation.runId);
    const options: RunOptions = runContext ? { session: sessionFromContext(runContext) } : {};
    const handle = snapshot ? runtimeInstance.resume(input, snapshot, options)
      : runtimeInstance.start(input, options, executionRunId);
    await runRegistry.add(handle, async () => {
      try { await releaseRunExecutionLease(projectDirectory, handle.runId); }
      finally { await resources.services.close(); }
    });
    leaseTransferred = true;
    runRegistered = true;
    return Response.json({
      ok: true,
      runId: handle.runId,
      events: `/api/runs/${encodeURIComponent(handle.runId)}/events`,
      snapshot: `/api/runs/${encodeURIComponent(handle.runId)}/snapshot`,
    }, { status: 202 });
  } catch (error) {
    if (idempotencyKey && ownedReservationRunId && !runRegistered) {
      await abandonIdempotentRun(projectDirectory, idempotencyKey, ownedReservationRunId).catch(() => undefined);
    }
    if (leasedRunId && !leaseTransferred) await releaseRunExecutionLease(projectDirectory, leasedRunId).catch(() => undefined);
    if (!runRegistered) await resources.services.close();
    if (error instanceof ApiRequestError) return apiErrorResponse(error);
    if (error instanceof DiagnosticError) return diagnosticResponse(error.diagnostics);
    return diagnosticResponse([requestDiagnostic(error instanceof Error ? error.message : "Could not start the Harness")], 500);
  }
}
