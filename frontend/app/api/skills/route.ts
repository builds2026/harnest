import { dirname } from "node:path";
import {
  materializeRemoteSkill,
  NodeSkillStore,
  remoteSkillSourceLabel,
  resolveRemoteSkillSource,
  skillInstallSourceKey,
  type SkillCatalogEntry,
  type SkillInstallSource,
} from "@harnestai/core/node";
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

const projectDirectory = () => dirname(harnessFile());

const store = () => new NodeSkillStore({ projectDirectory: projectDirectory() });

export async function GET(request: Request) {
  try {
    const skillStore = store();
    const review = new URL(request.url).searchParams.get("review");
    if (review) return Response.json({ scripts: await skillStore.reviewScripts(review) }, {
      headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
    });
    const catalog = await skillStore.catalog();
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
    const body = record(await readJsonBody(request, 600_000), "Skill install");
    if (body.action === "approve-scripts") {
      if (typeof body.skill !== "string" || !Array.isArray(body.scripts) || body.scripts.length > 128) {
        throw new ApiRequestError("SKILL_SCRIPT_APPROVAL_INVALID", "Skill script approval is invalid");
      }
      const skillStore = store();
      const approved = [];
      for (const candidate of body.scripts) {
        const script = record(candidate, "Skill script approval");
        if (typeof script.path !== "string" || typeof script.sha256 !== "string") {
          throw new ApiRequestError("SKILL_SCRIPT_APPROVAL_INVALID", "Skill script path and hash are required");
        }
        approved.push(await skillStore.approveScript(body.skill, script.path, script.sha256));
      }
      return Response.json({ scripts: approved });
    }
    if (body.action === "create") {
      if (typeof body.document !== "string" || Buffer.byteLength(body.document, "utf8") > 524_288
        || (body.source !== undefined && body.source !== "editor" && body.source !== "upload")) {
        throw new ApiRequestError("SKILL_INSTALL_INVALID", "Skill document is invalid");
      }
      if (body.scope !== undefined && body.scope !== "project" && body.scope !== "user") {
        throw new ApiRequestError("SKILL_INSTALL_INVALID", "Skill scope must be project or user");
      }
      if (body.namespace !== undefined && body.namespace !== "agents" && body.namespace !== "harnest") {
        throw new ApiRequestError("SKILL_INSTALL_INVALID", "Skill namespace is invalid");
      }
      const skill = await store().create(body.document, {
        ...(typeof body.scope === "string" ? { scope: body.scope as "project" | "user" } : {}),
        ...(typeof body.namespace === "string" ? { namespace: body.namespace as "agents" | "harnest" } : {}),
        ...(typeof body.source === "string" ? { source: body.source as "editor" | "upload" } : {}),
      });
      return Response.json({
        skill: safeSkill(skill),
        source: body.source === "upload" ? "SKILL.md upload" : "Studio editor",
      }, { status: 201 });
    }
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
    } else if (candidate.kind === "git" && typeof candidate.repository === "string") {
      source = await resolveRemoteSkillSource({
        kind: "git",
        repository: candidate.repository,
        ...(typeof candidate.commit === "string" && candidate.commit ? { commit: candidate.commit } : {}),
      });
    } else if (candidate.kind === "package" && typeof candidate.package === "string") {
      source = await resolveRemoteSkillSource({
        kind: "package",
        package: candidate.package,
        ...(typeof candidate.version === "string" && candidate.version ? { version: candidate.version } : {}),
        ...(typeof candidate.integrity === "string" && candidate.integrity ? { integrity: candidate.integrity } : {}),
      });
    } else {
      throw new ApiRequestError("SKILL_INSTALL_INVALID", "Skill source is invalid");
    }
    const remote = source.kind !== "local";
    if (remote && body.approved !== true) {
      throw new ApiRequestError("SKILL_INSTALL_APPROVAL_REQUIRED", "Pinned remote source approval is required", 409);
    }
    const materialized = source.kind === "local" ? undefined : await materializeRemoteSkill(source);
    try {
      const skillStore = materialized
        ? new NodeSkillStore({ projectDirectory: projectDirectory(), materializeRemote: () => materialized.directory })
        : store();
      const skill = await skillStore.install(source, {
        scope: body.scope,
        ...(typeof body.namespace === "string" ? { namespace: body.namespace as "agents" | "harnest" } : {}),
        ...(source.kind !== "local" ? { approval: { sourceKey: skillInstallSourceKey(source) } } : {}),
      });
      return Response.json({
        skill: safeSkill(skill),
        source: source.kind === "local" ? "Local folder" : remoteSkillSourceLabel(source),
      }, { status: 201 });
    } finally {
      await materialized?.cleanup();
    }
  } catch (error) {
    return apiErrorResponse(error);
  }
}
