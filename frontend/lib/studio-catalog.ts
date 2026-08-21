import type { ComponentManifest, HarnessSpec } from "@harnest/core";
import type { ConnectionKind } from "./connections";

export type PaletteKind = "components" | "tools" | "skills" | "connections" | "templates";

export interface ToolCatalogItem {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly category: string;
  readonly installed: boolean;
  readonly source?: string;
  readonly risk?: "read" | "write" | "external" | "destructive";
  readonly connectionKinds?: readonly ConnectionKind[];
  readonly connectionId?: string;
  readonly action?: string;
  readonly inputSchema?: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
}

export interface SkillCatalogItem {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly category: string;
  readonly scope?: "project" | "user";
  readonly trusted?: boolean;
  readonly source?: string;
  readonly connectionKinds?: readonly ConnectionKind[];
  readonly toolIds?: readonly string[];
  readonly requirements?: {
    readonly tools: readonly string[];
    readonly connections: readonly string[];
    readonly permissions: readonly string[];
  };
  readonly scriptsPresent?: boolean;
  readonly scriptTrust?: "not-required" | "approval-required";
  readonly provenance?: Readonly<Record<string, string | undefined>>;
}

export interface TemplateCatalogItem {
  readonly id: TemplateId;
  readonly label: string;
  readonly description: string;
  readonly category: string;
  readonly connectionKinds?: readonly ConnectionKind[];
  readonly toolIds?: readonly string[];
  readonly skillIds?: readonly string[];
  readonly sampleInput: string;
}

export interface ConnectionTypeCatalogItem {
  readonly id: ConnectionKind;
  readonly label: string;
  readonly description: string;
  readonly category: string;
  readonly secretFields: readonly { id: string; label: string }[];
}

export interface StudioCatalogPayload {
  readonly components: readonly ComponentManifest[];
  readonly tools: readonly ToolCatalogItem[];
  readonly skills: readonly SkillCatalogItem[];
  readonly templates: readonly TemplateCatalogItem[];
  readonly connectionTypes: readonly ConnectionTypeCatalogItem[];
  readonly warnings?: readonly string[];
}

export const TEMPLATE_CATALOG = [
  {
    id: "rag",
    label: "RAG Agent",
    description: "Ground an answer in connected project knowledge.",
    category: "Knowledge",
    connectionKinds: ["provider"],
    sampleInput: "How does this project protect context files?",
  },
  {
    id: "web-research",
    label: "Web Research",
    description: "Search, synthesize, and return a cited research brief.",
    category: "Research",
    connectionKinds: ["provider", "tool-service"],
    toolIds: ["builtin.web-search"],
    sampleInput: "Research the latest stable MCP transport guidance.",
  },
  {
    id: "coding-agent",
    label: "Coding Agent",
    description: "Inspect a workspace and run bounded code tools.",
    category: "Development",
    connectionKinds: ["provider", "local-runtime"],
    toolIds: ["builtin.code-runner"],
    sampleInput: "Summarize the project entry points.",
  },
  {
    id: "mcp-agent",
    label: "MCP Agent",
    description: "Discover and use one selected MCP server tool.",
    category: "Tools",
    connectionKinds: ["provider", "mcp-http"],
    sampleInput: "Use the connected MCP tool to answer this request.",
  },
  {
    id: "evaluation-loop",
    label: "Evaluation Loop",
    description: "Generate, evaluate, and improve with a hard iteration bound.",
    category: "Evaluation",
    connectionKinds: ["provider"],
    sampleInput: "Draft a concise answer and improve it once.",
  },
] as const satisfies readonly TemplateCatalogItem[];

export type TemplateId = "rag" | "web-research" | "coding-agent" | "mcp-agent" | "evaluation-loop";

const edge = (id: string, from: string, fromPort: string, to: string, toPort: string) => ({
  id,
  from: { component: from, port: fromPort },
  to: { component: to, port: toPort },
});

const baseAgent = (prompt: string): HarnessSpec => ({
  version: "0.2" as const,
  components: [
    { id: "model", type: "model", config: { connectionId: "" } },
    { id: "prompt", type: "prompt", config: { template: prompt } },
    { id: "agent", type: "agent", config: {} },
    { id: "output", type: "output", config: { format: "text" } },
  ],
  connections: [
    edge("model_to_agent", "model", "model", "agent", "model"),
    edge("prompt_to_agent", "prompt", "prompt", "agent", "prompt"),
    edge("agent_to_output", "agent", "response", "output", "value"),
  ],
  entrypoint: "output",
  studio: { positions: {
    model: { x: 60, y: 40 }, prompt: { x: 60, y: 220 }, agent: { x: 390, y: 120 }, output: { x: 720, y: 120 },
  } },
});

export function templateSpec(id: TemplateId): HarnessSpec {
  if (id === "rag") {
    const spec = baseAgent("Answer only from the connected context.\n\n{{input}}");
    spec.components.splice(2, 0, { id: "knowledge", type: "context", config: { source: "text", text: "" } });
    spec.connections.splice(2, 0, edge("knowledge_to_agent", "knowledge", "context", "agent", "context"));
    spec.studio!.positions.knowledge = { x: 60, y: 400 };
    return spec;
  }
  if (id === "web-research" || id === "coding-agent") {
    const toolId = id === "web-research" ? "builtin.web-search" : "builtin.code-runner";
    const spec = baseAgent(id === "web-research"
      ? "Call Web Search exactly once. Set its query field to the exact user request and limit to 5. Then stop searching and synthesize only the returned results into a cited brief.\n\nUser request: {{input}}"
      : "Use only the connected, approved code result.\n\n{{input}}");
    if (id === "web-research") {
      const agent = spec.components.find((component) => component.id === "agent");
      if (agent) agent.config = { ...agent.config, maxToolCalls: 1, maxTurns: 3 };
    }
    spec.components.splice(2, 0, { id: "tool", type: "tool", config: {
      tool: toolId,
      risk: id === "web-research" ? "external" : "destructive",
      source: "builtin",
    } });
    spec.connections.splice(2, 0, edge("tool_to_agent", "tool", "tool", "agent", "tools"));
    spec.studio!.positions.tool = { x: 60, y: 400 };
    return spec;
  }
  if (id === "mcp-agent") {
    const spec = baseAgent("Use the connected MCP result to answer clearly.\n\n{{input}}");
    spec.components.splice(2, 0, {
      id: "mcp", type: "tool", config: { tool: "", action: "", connectionId: "", risk: "external", source: "mcp" },
    });
    spec.connections.splice(2, 0, edge("mcp_to_agent", "mcp", "tool", "agent", "tools"));
    spec.studio!.positions.mcp = { x: 60, y: 400 };
    return spec;
  }

  return {
    version: "0.2",
    components: [
      { id: "improve", type: "loop", config: { subgraph: "revision", maxIterations: 2 } },
      { id: "output", type: "output", config: { format: "text" } },
    ],
    connections: [edge("improve_to_output", "improve", "value", "output", "value")],
    entrypoint: "output",
    subgraphs: {
      revision: {
        components: [
          { id: "model", type: "model", config: { connectionId: "" } },
          { id: "prompt", type: "prompt", config: { template: "Improve this answer once.\n\n{{input}}" } },
          { id: "agent", type: "agent", config: {} },
          { id: "output", type: "output", config: { format: "text" } },
        ],
        connections: [
          edge("revision_model", "model", "model", "agent", "model"),
          edge("revision_prompt", "prompt", "prompt", "agent", "prompt"),
          edge("revision_output", "agent", "response", "output", "value"),
        ],
        entrypoint: "output",
      },
    },
    studio: {
      positions: { improve: { x: 160, y: 140 }, output: { x: 500, y: 140 } },
      subgraphs: { revision: { positions: {
        model: { x: 40, y: 30 }, prompt: { x: 40, y: 210 }, agent: { x: 360, y: 120 }, output: { x: 680, y: 120 },
      } } },
    },
  };
}

export const CONNECTION_TYPE_CATALOG = [
  { id: "provider", label: "AI model", description: "Google AI Studio, OpenAI, Anthropic, Ollama, or a compatible endpoint.", category: "Model", secretFields: [{ id: "apiKey", label: "API key" }] },
  { id: "mcp-http", label: "MCP server", description: "Paste a server URL; OAuth discovery runs in your browser by default.", category: "Tools", secretFields: [{ id: "token", label: "Bearer token" }] },
  { id: "mcp-stdio", label: "MCP · stdio", description: "Project-bounded local MCP process.", category: "MCP", secretFields: [] },
  { id: "http-api", label: "Custom HTTP API", description: "Connect an endpoint, then add operations manually or from OpenAPI.", category: "API", secretFields: [{ id: "token", label: "Token" }] },
  { id: "tool-service", label: "Web Search", description: "Firecrawl, SearXNG, or any API that follows the Search connector contract.", category: "Tools", secretFields: [{ id: "token", label: "API token" }] },
  { id: "local-runtime", label: "Local runtime", description: "Approved local command or code runtime.", category: "Local", secretFields: [] },
] as const satisfies readonly ConnectionTypeCatalogItem[];
