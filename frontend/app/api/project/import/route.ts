import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  initializeHarnestProject,
  isSensitiveWorkspacePath,
  loadHarnestProjectManifest,
  loadHarnestProjectSpec,
  resolveHarnessFile,
  writeProjectEnvExample,
} from "@harnestai/core/node";
import { ApiRequestError, apiErrorResponse, assertSameOrigin } from "@/lib/api-server";
import { activateHarnessFile, studioBaseHarnessFile } from "@/lib/server";

export const runtime = "nodejs";

const MAX_IMPORT_FILES = 2_000;
const MAX_IMPORT_BYTES = 64 * 1_048_576;
const MAX_IMPORT_FILE_BYTES = 16 * 1_048_576;

const inside = (root: string, target: string) => {
  const path = relative(root, target);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

const portablePath = (value: unknown): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_024
    || value.includes("\\") || value.includes("\0") || value.startsWith("/")) {
    throw new ApiRequestError("PROJECT_IMPORT_PATH", "Imported project path is invalid");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new ApiRequestError("PROJECT_IMPORT_PATH", "Imported project path contains traversal");
  }
  return segments.join("/");
};

async function importRoot() {
  const base = await realpath(dirname(studioBaseHarnessFile()));
  const hidden = join(base, ".harnest");
  await mkdir(hidden, { mode: 0o700 }).catch((error: unknown) => {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
  });
  const hiddenInfo = await lstat(hidden);
  const hiddenRoot = await realpath(hidden);
  if (!hiddenInfo.isDirectory() || hiddenInfo.isSymbolicLink() || !inside(base, hiddenRoot)) {
    throw new ApiRequestError("PROJECT_IMPORT_STORAGE", "Studio import storage is unsafe", 500);
  }
  const imports = join(hiddenRoot, "imports");
  await mkdir(imports, { mode: 0o700 }).catch((error: unknown) => {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
  });
  const root = join(await realpath(imports), `project-${randomUUID()}`);
  await mkdir(root, { mode: 0o700 });
  return root;
}

export async function POST(request: Request) {
  let root: string | undefined;
  try {
    assertSameOrigin(request);
    const declared = request.headers.get("content-length");
    if (!declared || !/^\d+$/u.test(declared)) {
      throw new ApiRequestError("PROJECT_IMPORT_LENGTH", "Folder import requires a bounded Content-Length", 411);
    }
    if (Number(declared) > MAX_IMPORT_BYTES + 2 * 1_048_576) {
      throw new ApiRequestError("PROJECT_IMPORT_LIMIT", "Folder import exceeds 64 MiB", 413);
    }
    if (!request.headers.get("content-type")?.toLocaleLowerCase().startsWith("multipart/form-data")) {
      throw new ApiRequestError("PROJECT_IMPORT_TYPE", "Folder import must use multipart/form-data", 415);
    }
    const form = await request.formData();
    const files = form.getAll("file");
    let paths: unknown;
    try {
      paths = JSON.parse(String(form.get("paths") ?? "null")) as unknown;
    } catch {
      throw new ApiRequestError("PROJECT_IMPORT_PATH", "Folder import paths are invalid");
    }
    if (!Array.isArray(paths) || paths.length === 0 || paths.length !== files.length || files.length > MAX_IMPORT_FILES
      || files.some((file) => !(file instanceof File))) {
      throw new ApiRequestError("PROJECT_IMPORT_INVALID", "Folder import files are invalid");
    }
    root = await importRoot();
    let total = 0;
    const seen = new Set<string>();
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index] as File;
      const path = portablePath(paths[index]);
      if (seen.has(path)) throw new ApiRequestError("PROJECT_IMPORT_PATH", `Duplicate project path '${path}'`);
      seen.add(path);
      if (file.size <= 0 || file.size > MAX_IMPORT_FILE_BYTES || total + file.size > MAX_IMPORT_BYTES) {
        throw new ApiRequestError("PROJECT_IMPORT_LIMIT", `Project file '${path}' exceeds import limits`, 413);
      }
      total += file.size;
      const target = resolve(root, ...path.split("/"));
      if (!inside(root, target) || isSensitiveWorkspacePath(root, target)) continue;
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, new Uint8Array(await file.arrayBuffer()), { flag: "wx", mode: 0o600 });
    }
    let harness = await resolveHarnessFile(root);
    try {
      await lstat(harness);
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
      const alternate = join(root, "harnest.yml");
      try {
        await lstat(alternate);
        harness = alternate;
      } catch {
        throw new ApiRequestError("PROJECT_IMPORT_HARNESS", "Selected folder requires harnest.yaml or a valid .harnest/project.json", 422);
      }
    }
    let loaded = await loadHarnestProjectSpec(harness);
    if (!loaded.ok) throw new ApiRequestError(
      "PROJECT_IMPORT_INVALID",
      loaded.diagnostics.map(({ message }) => message).join("; "),
      422,
    );
    if (!await loadHarnestProjectManifest(harness)) {
      await initializeHarnestProject(harness, {
        version: 1,
        harness: relative(root, harness).split(sep).join("/"),
        studio: "studio.json",
      }, {
        "studio.json": `${JSON.stringify(loaded.spec.studio ?? { positions: {} }, null, 2)}\n`,
      });
      await writeProjectEnvExample(harness, loaded.spec);
      loaded = await loadHarnestProjectSpec(harness);
      if (!loaded.ok) throw new ApiRequestError("PROJECT_IMPORT_INVALID", "Imported project could not be initialized", 422);
    }
    activateHarnessFile(harness);
    return Response.json({
      ok: true,
      project: {
        name: String(form.get("name") ?? "Imported project").slice(0, 128),
        managed: true,
        fileCount: seen.size,
        bytes: total,
      },
    }, { status: 201 });
  } catch (error) {
    if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
    return apiErrorResponse(error instanceof ApiRequestError ? error : new ApiRequestError(
      "PROJECT_IMPORT_FAILED",
      error instanceof Error ? error.message : "Project folder could not be imported",
      500,
    ));
  }
}
