import { validateSpec } from "@harnest/core";
import { loadSpecFile } from "@harnest/core/node";
import { ApiRequestError, apiErrorResponse, assertSameOrigin, readJsonBody } from "../../../lib/api-server";
import { StudioConnectionService } from "../../../lib/connections-server";
import { playgroundCapabilities } from "../../../lib/playground";
import { playgroundStore } from "../../../lib/playground-store";
import { diagnosticResponse, harnessFile, hasErrors, runtimeResourcesFor } from "../../../lib/server";
import { dirname } from "node:path";

export const runtime = "nodejs";

const storeError = (error: unknown, status = 400) => error instanceof ApiRequestError
  ? error
  : new ApiRequestError("PLAYGROUND_INVALID", error instanceof Error ? error.message : "Playground request is invalid", status);

async function projectState() {
  const file = harnessFile();
  const loaded = await loadSpecFile(file);
  if (!loaded.ok) return { ok: false, diagnostics: loaded.diagnostics } as const;
  const resources = await runtimeResourcesFor(loaded.spec);
  try {
    const validation = validateSpec(loaded.spec, {
      registry: resources.adapters,
      components: resources.components,
      tools: resources.tools,
      env: process.env,
    });
    const diagnostics = [...resources.diagnostics, ...validation.diagnostics];
    const connections = await new StudioConnectionService(dirname(file)).list();
    const names = new Map(connections.map((connection) => [connection.id, connection.name]));
    const capabilities = playgroundCapabilities(loaded.spec);
    return {
      ok: true,
      diagnostics,
      capabilities: {
        ...capabilities,
        models: capabilities.models.map((model) => ({
          ...model,
          label: `${names.get(model.connectionId) ?? model.connectionId}${model.model ? ` · ${model.model}` : ""}${model.fallback ? " · fallback" : ""}`,
        })),
      },
    } as const;
  } finally {
    await resources.services.close();
  }
}

export async function GET(request: Request) {
  try {
    const state = await projectState();
    if (!state.ok) return diagnosticResponse(state.diagnostics);
    const store = playgroundStore(harnessFile());
    const sessionId = new URL(request.url).searchParams.get("sessionId");
    return Response.json({
      ok: true,
      file: harnessFile(),
      ready: !hasErrors(state.diagnostics),
      diagnostics: state.diagnostics,
      capabilities: state.capabilities,
      retentionDays: 30,
      ...(sessionId
        ? { session: await store.get(sessionId), files: await store.files(sessionId) }
        : { sessions: await store.list() }),
    }, { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  } catch (error) {
    return apiErrorResponse(storeError(error));
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await readJsonBody(request, 1_024);
    if (!body || typeof body !== "object" || Array.isArray(body)
      || (body as Record<string, unknown>).action !== "create") {
      throw new ApiRequestError("PLAYGROUND_INVALID", "Create requires action 'create'");
    }
    const session = await playgroundStore(harnessFile()).create();
    return Response.json({ ok: true, session }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(storeError(error));
  }
}

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await readJsonBody(request, 1_024);
    const sessionId = body && typeof body === "object" && !Array.isArray(body)
      && typeof (body as Record<string, unknown>).sessionId === "string"
      ? (body as { sessionId: string }).sessionId : "";
    await playgroundStore(harnessFile()).delete(sessionId);
    return new Response(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(storeError(error));
  }
}
