import { dirname } from "node:path";
import { apiErrorResponse, assertSameOrigin, readJsonBody } from "@/lib/api-server";
import { StudioConnectionService, parseConnectionMutation } from "@/lib/connections-server";
import { harnessFile } from "@/lib/server";

export const runtime = "nodejs";

const service = () => new StudioConnectionService(dirname(harnessFile()));

export async function GET() {
  try {
    return Response.json({ connections: await service().list() }, {
      headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const connection = await service().create(parseConnectionMutation(await readJsonBody(request)));
    return Response.json({ connection }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const input = parseConnectionMutation(await readJsonBody(request), true);
    const connection = await service().update(input as typeof input & { id: string });
    return Response.json({ connection });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await readJsonBody(request);
    const id = body && typeof body === "object" && !Array.isArray(body) && typeof (body as { id?: unknown }).id === "string"
      ? (body as { id: string }).id
      : "";
    await service().delete(id);
    return new Response(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
