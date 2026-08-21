import { dirname } from "node:path";
import {
  NodeSkillStore,
  skillInstallSourceKey,
  type SkillCatalogEntry,
  type SkillInstallSource,
} from "@harnest/core/node";
import { ApiRequestError, apiErrorResponse, assertSameOrigin, readJsonBody } from "@/lib/api-server";
import { harnessFile } from "@/lib/server";

export const runtime = "nodejs";

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiRequestError("SKILL_INSTALL_INVALID", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
};

const safeSkill = (skill: SkillCatalogEntry) => ({
  id: skill.name,
  label: skill.name,
  description: skill.description,
  scope: skill.scope,
  namespace: skill.namespace,
  requirements: skill.descriptor.requirements,
  scriptsPresent: skill.scriptsPresent,
  scriptTrust: skill.scriptTrust,
  provenance: skill.provenance,
});

const store = () => new NodeSkillStore({ projectDirectory: dirname(harnessFile()) });

export async function GET() {
  try {
    const catalog = await store().catalog();
    return Response.json({ skills: catalog.skills.map(safeSkill), warnings: catalog.warnings }, {
      headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const body = record(await readJsonBody(request, 65_536), "Skill install");
    if (body.scope !== "project" && body.scope !== "user") {
      throw new ApiRequestError("SKILL_INSTALL_INVALID", "Skill scope must be project or user");
    }
    if (body.namespace !== undefined && body.namespace !== "agents" && body.namespace !== "harnest") {
      throw new ApiRequestError("SKILL_INSTALL_INVALID", "Skill namespace is invalid");
    }
    const candidate = record(body.source, "Skill source");
    let source: SkillInstallSource;
    if (candidate.kind === "local" && typeof candidate.directory === "string" && candidate.directory.length <= 1_024) {
      source = { kind: "local", directory: candidate.directory };
    } else if (candidate.kind === "git" && typeof candidate.repository === "string" && typeof candidate.commit === "string") {
      source = { kind: "git", repository: candidate.repository, commit: candidate.commit };
    } else if (candidate.kind === "package" && typeof candidate.package === "string"
      && typeof candidate.version === "string" && typeof candidate.integrity === "string") {
      source = { kind: "package", package: candidate.package, version: candidate.version, integrity: candidate.integrity };
    } else {
      throw new ApiRequestError("SKILL_INSTALL_INVALID", "Skill source is invalid");
    }
    const remote = source.kind !== "local";
    if (remote && body.approved !== true) {
      throw new ApiRequestError("SKILL_INSTALL_APPROVAL_REQUIRED", "Pinned remote source approval is required", 409);
    }
    const skill = await store().install(source, {
      scope: body.scope,
      ...(typeof body.namespace === "string" ? { namespace: body.namespace as "agents" | "harnest" } : {}),
      ...(source.kind !== "local" ? { approval: { sourceKey: skillInstallSourceKey(source) } } : {}),
    });
    return Response.json({ skill: safeSkill(skill) }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
