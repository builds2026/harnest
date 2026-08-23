import { ApiRequestError, apiErrorResponse, assertSameOrigin, readJsonBody } from "../../../../lib/api-server";
import { playgroundStore } from "../../../../lib/playground-store";
import { harnessFile } from "../../../../lib/server";

export const runtime = "nodejs";

const MAX_UPLOAD_BODY = 66 * 1_048_576;

const storeError = (error: unknown, status = 400) => error instanceof ApiRequestError
  ? error
  : new ApiRequestError("PLAYGROUND_FILE_INVALID", error instanceof Error ? error.message : "File request is invalid", status);

const identifiers = (request: Request) => {
  const search = new URL(request.url).searchParams;
  return { sessionId: search.get("sessionId") ?? "", fileId: search.get("fileId") ?? "" };
};

export async function GET(request: Request) {
  try {
    const { sessionId, fileId } = identifiers(request);
    const store = playgroundStore(harnessFile());
    if (!fileId) return Response.json({ ok: true, files: await store.files(sessionId) }, {
      headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
    });
    const { file, content } = await store.content(sessionId, fileId);
    const requested = request.headers.get("range")?.match(/^bytes=(\d+)-(\d*)$/u);
    const start = requested ? Number(requested[1]) : 0;
    const requestedEnd = requested?.[2] ? Number(requested[2]) : content.byteLength - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd)
      || start < 0 || requestedEnd < start || start >= content.byteLength) {
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${content.byteLength}` } });
    }
    const end = Math.min(requestedEnd, content.byteLength - 1);
    const body = content.subarray(start, end + 1);
    const download = new URL(request.url).searchParams.get("download") === "1";
    return new Response(new Uint8Array(body), {
      status: requested ? 206 : 200,
      headers: {
        "accept-ranges": "bytes",
        "cache-control": "private, no-store",
        "content-length": String(body.byteLength),
        "content-range": requested ? `bytes ${start}-${end}/${content.byteLength}` : `bytes 0-${end}/${content.byteLength}`,
        "content-type": file.mimeType,
        "content-disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        "content-security-policy": "sandbox; default-src 'none'; media-src 'self' blob:; img-src 'self' blob: data:",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return apiErrorResponse(storeError(error, 404));
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const declared = request.headers.get("content-length");
    if (!declared || !/^\d+$/u.test(declared)) {
      throw new ApiRequestError("PLAYGROUND_LENGTH_REQUIRED", "File uploads require a bounded Content-Length", 411);
    }
    if (Number(declared) > MAX_UPLOAD_BODY) {
      throw new ApiRequestError("PLAYGROUND_FILE_TOO_LARGE", "Upload body exceeds 66 MiB", 413);
    }
    if (!request.headers.get("content-type")?.toLocaleLowerCase().startsWith("multipart/form-data")) {
      throw new ApiRequestError("REQUEST_CONTENT_TYPE", "File upload must use multipart/form-data", 415);
    }
    const form = await request.formData();
    const sessionId = form.get("sessionId");
    const value = form.get("file");
    if (typeof sessionId !== "string" || !(value instanceof File)) {
      throw new ApiRequestError("PLAYGROUND_FILE_INVALID", "Upload requires a session and one file");
    }
    if (value.size > 64 * 1_048_576) throw new ApiRequestError("PLAYGROUND_FILE_TOO_LARGE", "File exceeds 64 MiB", 413);
    const file = await playgroundStore(harnessFile()).upload(sessionId, {
      name: value.name,
      mimeType: value.type,
      content: new Uint8Array(await value.arrayBuffer()),
    });
    return Response.json({ ok: true, file }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(storeError(error));
  }
}

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await readJsonBody(request, 2_048);
    const input = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
    if (typeof input.sessionId !== "string" || typeof input.fileId !== "string") {
      throw new ApiRequestError("PLAYGROUND_FILE_INVALID", "Delete requires sessionId and fileId");
    }
    await playgroundStore(harnessFile()).removeFile(input.sessionId, input.fileId);
    return new Response(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(storeError(error));
  }
}
