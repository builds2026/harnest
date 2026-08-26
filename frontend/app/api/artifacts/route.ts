import { dirname } from "node:path";
import { NodeRuntimeServices } from "@harnestai/core/node";
import { ApiRequestError, apiErrorResponse } from "@/lib/api-server";
import { harnessFile } from "@/lib/server";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const runId = url.searchParams.get("runId") ?? "";
  const artifactId = url.searchParams.get("artifactId") ?? "";
  const services = new NodeRuntimeServices(dirname(harnessFile()), { harnessId: harnessFile() });
  try {
    const { artifact, content } = await services.readArtifact(runId, artifactId);
    const download = url.searchParams.get("download") === "1";
    const contentType = /^(?:text\/|application\/(?:json|xml)(?:$|;))/i.test(artifact.mimeType)
      && !/charset=/i.test(artifact.mimeType)
      ? `${artifact.mimeType}; charset=utf-8`
      : artifact.mimeType;
    return new Response(new Uint8Array(content), {
      headers: {
        "cache-control": "private, no-store",
        "content-length": String(content.byteLength),
        "content-type": contentType,
        "content-disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(artifact.name)}`,
        "content-security-policy": "sandbox; default-src 'none'; media-src 'self' blob:; img-src 'self' blob: data:",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return apiErrorResponse(new ApiRequestError(
      "ARTIFACT_NOT_FOUND",
      error instanceof Error ? error.message : "Artifact was not found",
      404,
    ));
  } finally {
    await services.close();
  }
}
