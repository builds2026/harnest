import { parseSpec, stringifySpec } from "@harnestai/core";
import { loadSpecFile, saveSpecFile } from "@harnestai/core/node";
import { ApiRequestError, apiErrorResponse, assertSameOrigin, readJsonBody } from "@/lib/api-server";
import {
  FileHarnessVersionStore,
  compareHarnessVersions,
  summarizeHarnessDiff,
} from "@/lib/harness-version-store";
import { fileExists, harnessFile } from "@/lib/server";

export const runtime = "nodejs";

const currentYaml = async () => {
  const loaded = await loadSpecFile(harnessFile());
  if (!loaded.ok) throw new ApiRequestError("HARNESS_VERSION_CURRENT_INVALID", "The current Harness cannot be versioned until its YAML is valid", 422);
  return stringifySpec(loaded.spec);
};

export async function GET(request: Request) {
  try {
    const store = new FileHarnessVersionStore(harnessFile());
    if (await fileExists(harnessFile())) await store.record(await currentYaml(), "Current Harness");
    const query = new URL(request.url).searchParams;
    const id = query.get("id");
    const from = query.get("from");
    const to = query.get("to");
    if (id) {
      const version = await store.get(id);
      return Response.json({ version });
    }
    if (from && to) {
      const left = from === "current" ? await currentYaml() : (await store.get(from)).yaml;
      const right = to === "current" ? await currentYaml() : (await store.get(to)).yaml;
      return Response.json({ diff: compareHarnessVersions(left, right) });
    }
    return Response.json({ versions: await store.list() });
  } catch (error) {
    return apiErrorResponse(error instanceof ApiRequestError ? error : new ApiRequestError(
      "HARNESS_VERSION_READ_FAILED",
      error instanceof Error ? error.message : "Harness versions could not be loaded",
      500,
    ));
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await readJsonBody(request, 2_105_344);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ApiRequestError("HARNESS_VERSION_RESTORE_INVALID", "Restore request must be an object");
    }
    const { id, currentYaml: clientYaml } = body as Record<string, unknown>;
    if (typeof id !== "string" || typeof clientYaml !== "string") {
      throw new ApiRequestError("HARNESS_VERSION_RESTORE_INVALID", "Version id and current YAML are required");
    }
    const current = parseSpec(clientYaml);
    if (!current.ok) throw new ApiRequestError(
      "HARNESS_VERSION_CURRENT_INVALID",
      "Fix or discard invalid YAML before restoring a version",
      422,
    );
    const store = new FileHarnessVersionStore(harnessFile());
    const target = await store.get(id);
    const parsedTarget = parseSpec(target.yaml);
    if (!parsedTarget.ok) throw new ApiRequestError("HARNESS_VERSION_SNAPSHOT_INVALID", "The selected version is no longer valid", 409);
    await store.record(stringifySpec(current.spec), `State preserved before restoring ${id}`, true);
    await saveSpecFile(harnessFile(), parsedTarget.spec);
    const yaml = stringifySpec(parsedTarget.spec);
    const summary = `Restored ${id}: ${summarizeHarnessDiff(compareHarnessVersions(stringifySpec(current.spec), yaml))}`;
    const restored = await store.record(yaml, summary, true);
    return Response.json({ ok: true, restored, spec: parsedTarget.spec, yaml, versions: await store.list() });
  } catch (error) {
    return apiErrorResponse(error instanceof ApiRequestError ? error : new ApiRequestError(
      "HARNESS_VERSION_RESTORE_FAILED",
      error instanceof Error ? error.message : "Harness version could not be restored",
      500,
    ));
  }
}
