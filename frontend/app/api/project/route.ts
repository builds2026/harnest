import {
  HarnestProjectError,
  bindHarnestProjectAsset,
  createPortableProjectTextFile,
  deletePortableProjectFile,
  listPortableProjectFiles,
  loadHarnestProjectManifest,
  readPortableProjectTextFile,
  writePortableProjectTextFile,
} from "@harnestai/core/node";
import { basename } from "node:path";
import { ApiRequestError, apiErrorResponse, assertSameOrigin, readJsonBody } from "@/lib/api-server";
import { harnessFile, studioBaseHarnessFile } from "@/lib/server";

export const runtime = "nodejs";

const textExtensions = /\.(?:cjs|css|csv|html|js|json|jsx|md|mjs|py|sh|toml|ts|tsx|txt|xml|ya?ml)$/i;
const protectedProjectFiles = new Set([".harnest/project.json", ".harnest/studio.json"]);

const fileCapabilities = (path: string, size: number) => {
  const previewable = textExtensions.test(path) && size <= 4_194_304;
  return { previewable, editable: previewable && !protectedProjectFiles.has(path) };
};

const browserFile = ({ archivePath, size, sha256, content }: {
  readonly archivePath: string;
  readonly size: number;
  readonly sha256: string;
  readonly content: string;
}) => ({ path: archivePath, size, sha256, content, ...fileCapabilities(archivePath, size) });

function projectError(error: unknown) {
  if (!(error instanceof HarnestProjectError)) return error;
  const status = error.code === "PROJECT_ASSET_CONFLICT" ? 409
    : error.code === "PROJECT_ASSET_EXISTS" || error.code === "PROJECT_ASSET_REFERENCED" ? 409
      : error.code === "PROJECT_ASSET_NOT_PORTABLE" ? 404 : 422;
  return new ApiRequestError(error.code, error.message, status);
}

export async function GET(request: Request) {
  try {
    const file = harnessFile();
    const project = await loadHarnestProjectManifest(file);
    if (!project) return Response.json({ project: null, files: [] });
    const selected = new URL(request.url).searchParams.get("path");
    if (selected) return Response.json({ file: browserFile(await readPortableProjectTextFile(file, selected)) });
    const files = (await listPortableProjectFiles(file)).map(({ archivePath, size, sha256 }) => ({
      path: archivePath,
      size,
      sha256,
      ...fileCapabilities(archivePath, size),
    }));
    return Response.json({
      project: {
        root: basename(project.projectDirectory),
        harness: project.manifest.harness,
        manifest: project.manifest,
        managed: file !== studioBaseHarnessFile(),
      },
      files,
    });
  } catch (error) {
    return apiErrorResponse(projectError(error));
  }
}

export async function PUT(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await readJsonBody(request, 4_325_376);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ApiRequestError("PROJECT_ASSET_INVALID", "Project asset update must be an object");
    }
    const { path, content, sha256 } = body as Record<string, unknown>;
    if (typeof path !== "string" || typeof content !== "string" || typeof sha256 !== "string"
      || !/^sha256:[a-f0-9]{64}$/.test(`sha256:${sha256.replace(/^sha256:/, "")}`)) {
      throw new ApiRequestError("PROJECT_ASSET_INVALID", "Project path, text content, and SHA-256 revision are required");
    }
    if (protectedProjectFiles.has(path)) {
      throw new ApiRequestError("PROJECT_ASSET_READ_ONLY", "Project metadata is read-only in Studio", 422);
    }
    const file = await writePortableProjectTextFile(harnessFile(), path, content, sha256.replace(/^sha256:/, ""));
    return Response.json({ ok: true, file: browserFile(file) });
  } catch (error) {
    return apiErrorResponse(projectError(error));
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await readJsonBody(request, 4_325_376);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ApiRequestError("PROJECT_ASSET_INVALID", "Project action must be an object");
    }
    const value = body as Record<string, unknown>;
    if (value.action === "create") {
      if (typeof value.path !== "string" || typeof value.content !== "string") {
        throw new ApiRequestError("PROJECT_ASSET_INVALID", "Project path and initial text content are required");
      }
      return Response.json({ ok: true, file: browserFile(await createPortableProjectTextFile(harnessFile(), value.path, value.content)) }, { status: 201 });
    }
    if (value.action === "bind") {
      if ((value.kind !== "prompt" && value.kind !== "context" && value.kind !== "schema")
        || typeof value.component !== "string"
        || (value.graph !== undefined && typeof value.graph !== "string")
        || (value.path !== undefined && typeof value.path !== "string")) {
        throw new ApiRequestError("PROJECT_BINDING_INVALID", "Project binding is invalid");
      }
      const manifest = await bindHarnestProjectAsset(harnessFile(), {
        kind: value.kind,
        component: value.component,
        ...(value.graph ? { graph: value.graph } : {}),
      }, value.path as string | undefined);
      return Response.json({ ok: true, manifest });
    }
    throw new ApiRequestError("PROJECT_ACTION_INVALID", "Unknown project action");
  } catch (error) {
    return apiErrorResponse(projectError(error));
  }
}

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await readJsonBody(request, 8_192);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ApiRequestError("PROJECT_ASSET_INVALID", "Project deletion must be an object");
    }
    const { path, sha256 } = body as Record<string, unknown>;
    if (typeof path !== "string" || typeof sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(sha256)) {
      throw new ApiRequestError("PROJECT_ASSET_INVALID", "Project path and SHA-256 revision are required");
    }
    await deletePortableProjectFile(harnessFile(), path, sha256);
    return Response.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(projectError(error));
  }
}
