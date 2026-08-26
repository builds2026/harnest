import { createBuiltinComponentRegistry, parseSpec, stringifySpec } from "@harnestai/core";
import { basename } from "node:path";
import {
  listPortableProjectFiles,
  loadHarnestProjectSpec,
  loadSpecFile,
  saveHarnestProjectSpec,
} from "@harnestai/core/node";
import { EMPTY_SPEC } from "@/lib/default-spec";
import {
  diagnosticResponse,
  fileExists,
  harnessFile,
  requestDiagnostic,
  runtimeResourcesFor,
} from "@/lib/server";
import { hostCapabilityDiagnosticsFor, studioCapabilityPolicy } from "@/lib/runtime-config";
import { ApiRequestError, apiErrorResponse, assertSameOrigin, readJsonBody } from "@/lib/api-server";
import { FileHarnessVersionStore, compareHarnessVersions, summarizeHarnessDiff } from "@/lib/harness-version-store";

export const runtime = "nodejs";

interface SaveCoordinator {
  readonly queues: Map<string, Promise<unknown>>;
  readonly latest: Map<string, number>;
}

const coordinatorGlobal = globalThis as typeof globalThis & { __harnestSpecSaveCoordinator?: SaveCoordinator };
const saveCoordinator = coordinatorGlobal.__harnestSpecSaveCoordinator ??= { queues: new Map(), latest: new Map() };

function serializeSave<T>(file: string, task: () => Promise<T>): Promise<T> {
  const previous = saveCoordinator.queues.get(file) ?? Promise.resolve();
  const next = previous.then(task, task);
  saveCoordinator.queues.set(file, next);
  void next.finally(() => { if (saveCoordinator.queues.get(file) === next) saveCoordinator.queues.delete(file); }).catch(() => undefined);
  return next;
}

export async function GET() {
  const file = harnessFile();
  try {
    if (!(await fileExists(file))) {
      return Response.json({
        spec: EMPTY_SPEC,
        yaml: stringifySpec(EMPTY_SPEC),
        file: basename(file),
        exists: false,
        catalog: createBuiltinComponentRegistry().catalog(),
      });
    }
    const loaded = await loadHarnestProjectSpec(file);
    if (!loaded.ok) return diagnosticResponse(loaded.diagnostics);
    const resources = await runtimeResourcesFor(loaded.spec);
    try {
      return Response.json({
        spec: loaded.spec,
        yaml: stringifySpec(loaded.spec),
        file: basename(file),
        exists: true,
        catalog: resources.components.catalog(),
        diagnostics: resources.diagnostics,
        ...(loaded.project ? { project: {
          root: basename(loaded.project.projectDirectory),
          manifest: loaded.project.manifest,
          files: (await listPortableProjectFiles(file)).map(({ archivePath, size, sha256 }) => ({
            path: archivePath, size, sha256,
          })),
        } } : {}),
      });
    } finally {
      await resources.services.close();
    }
  } catch {
    return diagnosticResponse([requestDiagnostic("Could not load the harness")], 500);
  }
}

export async function PUT(request: Request) {
  let yaml: unknown;
  let baseYaml: unknown;
  let clientRevision: unknown;
  let saveSessionId: unknown;
  try {
    assertSameOrigin(request);
    const body = await readJsonBody(request, 2_097_152);
    ({ yaml, baseYaml, clientRevision, saveSessionId } = body as { yaml?: unknown; baseYaml?: unknown; clientRevision?: unknown; saveSessionId?: unknown });
  } catch (error) {
    return apiErrorResponse(error);
  }
  if (typeof yaml !== "string") return diagnosticResponse([requestDiagnostic("yaml must be a string")], 400);
  if (typeof baseYaml !== "string") return apiErrorResponse(new ApiRequestError(
    "SPEC_CONFLICT",
    "This Builder tab is stale. Refresh it before saving again.",
    409,
  ));

  const parsed = parseSpec(yaml);
  if (!parsed.ok) return diagnosticResponse(parsed.diagnostics);
  const file = harnessFile();
  const session = typeof saveSessionId === "string" && /^[a-f0-9-]{36}$/.test(saveSessionId) ? saveSessionId : "anonymous";
  const scope = `${file}\u0000${session}`;
  const previousRevision = saveCoordinator.latest.get(scope) ?? 0;
  const revision = Number.isInteger(clientRevision) && (clientRevision as number) >= 0
    ? clientRevision as number : previousRevision + 1;
  saveCoordinator.latest.set(scope, Math.max(previousRevision, revision));
  try {
    return await serializeSave(file, async () => {
      if (revision < (saveCoordinator.latest.get(scope) ?? revision)) {
        return Response.json({ ok: true, superseded: true, diagnostics: [] });
      }
      const store = new FileHarnessVersionStore(file);
      let previousYaml: string | undefined;
      if (await fileExists(file)) {
        const previous = await loadSpecFile(file);
        if (previous.ok) {
          previousYaml = stringifySpec(previous.spec);
          if (previousYaml !== baseYaml) return apiErrorResponse(new ApiRequestError(
            "SPEC_CONFLICT",
            "harnest.yaml changed in another tab. Refresh before saving again.",
            409,
          ));
          await store.record(previousYaml, "Current Harness before save");
        }
      } else if (baseYaml !== stringifySpec(EMPTY_SPEC)) return apiErrorResponse(new ApiRequestError(
        "SPEC_CONFLICT",
        "harnest.yaml changed in another tab. Refresh before saving again.",
        409,
      ));
      const savedYaml = stringifySpec(parsed.spec);
      const unchanged = previousYaml === savedYaml;
      if (!unchanged) await saveHarnestProjectSpec(file, parsed.spec);
      await store.record(savedYaml, previousYaml
        ? summarizeHarnessDiff(compareHarnessVersions(previousYaml, savedYaml))
        : "Initial Harness");
      return Response.json({
        ok: true,
        unchanged,
        diagnostics: hostCapabilityDiagnosticsFor(parsed.spec, studioCapabilityPolicy(process.env)),
        yaml: savedYaml,
      });
    });
  } catch {
    return diagnosticResponse([{
      code: "FILE_WRITE",
      path: harnessFile(),
      message: "Could not save harnest.yaml",
      severity: "error",
    }], 500);
  }
}
