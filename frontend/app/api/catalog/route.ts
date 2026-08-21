import { dirname } from "node:path";
import { type ConnectionProfile, type ConnectionTool, type HarnessSpec, type ToolManifest } from "@harnest/core";
import { ConnectionManager, NodeSkillStore, loadSpecFile, mcpToolApprovalId } from "@harnest/core/node";
import { CONNECTION_TYPE_CATALOG, TEMPLATE_CATALOG, type SkillCatalogItem, type StudioCatalogPayload, type ToolCatalogItem } from "@/lib/studio-catalog";
import { apiErrorResponse } from "@/lib/api-server";
import { fileExists, harnessFile, runtimeResourcesFor } from "@/lib/server";
import { EMPTY_SPEC } from "@/lib/default-spec";

export const runtime = "nodejs";

const toolItem = (tool: ToolManifest): ToolCatalogItem => ({
  id: tool.id,
  label: tool.label,
  description: tool.description,
  category: tool.category ?? "Tools",
  installed: true,
  ...(tool.source ? { source: tool.source } : {}),
  ...(tool.risk ? { risk: tool.risk } : {}),
  ...(tool.connectionKinds ? { connectionKinds: tool.connectionKinds as ToolCatalogItem["connectionKinds"] } : {}),
  inputSchema: tool.inputSchema,
  ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
});

const connectionKind = (profile: ConnectionProfile): ToolCatalogItem["connectionKinds"] => profile.kind === "mcp"
  ? [profile.config.transport === "stdio" ? "mcp-stdio" : "mcp-http"]
  : [profile.kind];

const mcpToolItem = (profile: ConnectionProfile, tool: ConnectionTool): ToolCatalogItem => ({
  id: mcpToolApprovalId(profile.id, tool.name),
  label: tool.title ?? tool.name,
  description: tool.description ?? `Discovered from ${profile.name}`,
  category: "MCP",
  installed: true,
  source: "mcp",
  risk: tool.annotations?.destructiveHint === true ? "destructive" : "external",
  connectionKinds: connectionKind(profile),
  connectionId: profile.id,
  action: tool.name,
  inputSchema: tool.inputSchema,
  ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
});

export async function GET() {
  try {
    let spec: HarnessSpec = EMPTY_SPEC;
    const file = harnessFile();
    const projectDirectory = dirname(file);
    if (await fileExists(file)) {
      const loaded = await loadSpecFile(file);
      if (loaded.ok) spec = loaded.spec;
    }
    const resources = await runtimeResourcesFor(spec);
    const components = resources.components.catalog();
    let installedTools: ToolCatalogItem[];
    try {
      installedTools = resources.tools.catalog().map(toolItem);
    } finally {
      await resources.services.close();
    }
    const connectionProfiles = await new ConnectionManager(projectDirectory).list();
    const connectionTools = connectionProfiles.flatMap((profile) => (profile.tools ?? []).map((tool) => mcpToolItem(profile, tool)));
    const tools = [...installedTools, ...connectionTools].filter((tool, index, all) =>
      all.findIndex((candidate) => candidate.id === tool.id && candidate.connectionId === tool.connectionId) === index);
    const skillCatalog = await new NodeSkillStore({ projectDirectory }).catalog();
    const skills: SkillCatalogItem[] = skillCatalog.skills.map((skill) => ({
      id: skill.name,
      label: skill.name,
      description: skill.description,
      category: skill.namespace === "harnest" ? "Harnest" : "Agent",
      scope: skill.scope,
      trusted: skill.scriptTrust === "not-required",
      source: skill.provenance.kind,
      toolIds: skill.descriptor.requirements.tools,
      requirements: skill.descriptor.requirements,
      scriptsPresent: skill.scriptsPresent,
      scriptTrust: skill.scriptTrust,
      provenance: { ...skill.provenance },
    }));
    const payload: StudioCatalogPayload = {
      components,
      tools,
      skills,
      templates: TEMPLATE_CATALOG,
      connectionTypes: CONNECTION_TYPE_CATALOG,
      warnings: skillCatalog.warnings,
    };
    return Response.json(payload, { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
