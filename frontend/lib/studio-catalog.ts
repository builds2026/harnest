import type { ComponentManifest, GraphBody, HarnessSpec } from "@harnestai/core";
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
  {
    id: "dynamic-team",
    label: "Dynamic Agent Team",
    description: "Classify intent, spawn bounded specialists, collaborate, re-plan, and synthesize one final answer.",
    category: "Agents",
    connectionKinds: ["provider", "tool-service", "local-runtime"],
    toolIds: ["builtin.web-search", "builtin.code-runner"],
    sampleInput: "Research the options, test the strongest approach, and return a verified recommendation.",
  },
] as const satisfies readonly TemplateCatalogItem[];

export type TemplateId = "rag" | "web-research" | "coding-agent" | "mcp-agent" | "evaluation-loop" | "dynamic-team";

const edge = (id: string, from: string, fromPort: string, to: string, toPort: string) => ({
  id,
  from: { component: from, port: fromPort },
  to: { component: to, port: toPort },
});

const baseAgent = (prompt: string): HarnessSpec => ({
  version: "0.2" as const,
  components: [
    { id: "model", type: "model", config: { adapter: "gemini", model: "gemini-2.5-flash" } },
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

const agentGraph = (prompt: string, structured = false, tool?: "web" | "code"): GraphBody => {
  const components: GraphBody["components"] = [
    { id: "model", type: "model", config: { adapter: "gemini", model: "gemini-2.5-flash" } },
    { id: "prompt", type: "prompt", config: { template: prompt } },
    ...(tool ? [{
      id: "tool",
      type: "tool",
      config: tool === "web"
        ? { tool: "builtin.web-search", source: "builtin", risk: "external" }
        : { tool: "builtin.code-runner", source: "builtin", risk: "destructive" },
    } as GraphBody["components"][number]] : []),
    { id: "agent", type: "agent", config: { maxTurns: 10, maxToolCalls: 32, toolError: tool ? "fail" : "model" } },
    { id: "output", type: "output", config: structured ? {
      format: "json",
      schema: {
        type: "object",
        properties: {
          status: { enum: ["direct", "tasks", "complete"] },
          finalAnswer: {},
          tasks: { type: "array", items: { type: "object", properties: {
            id: { type: "string" }, goal: { type: "string" }, agent: { type: "string" },
            dependsOn: { type: "array", items: { type: "string" } },
          }, required: ["id", "goal", "agent"] } },
        },
      },
    } : { format: "text" } },
  ];
  return {
    components,
    connections: [
      edge("model", "model", "model", "agent", "model"),
      edge("prompt", "prompt", "prompt", "agent", "prompt"),
      ...(tool ? [edge("tool", "tool", "tool", "agent", "tools")] : []),
      edge("output", "agent", "response", "output", "value"),
    ],
    entrypoint: "output",
  };
};

export function templateSpec(id: TemplateId): HarnessSpec {
  if (id === "dynamic-team") return {
    version: "0.3",
    components: [
      { id: "routing_model", type: "model", config: { adapter: "gemini", model: "gemini-2.5-flash" } },
      { id: "routing_prompt", type: "prompt", config: { template: "Classify the request. Use direct only for simple questions, research for evidence gathering, and engineering for implementation or multi-step verification.\n\n{{input}}" } },
      { id: "classify", type: "classifier", config: { routes: ["direct", "research", "engineering"], fallback: "engineering", minConfidence: 0.65 } },
      { id: "direct", type: "subgraph", config: { subgraph: "direct_agent" } },
      { id: "research_team", type: "team", config: { team: "engineering" } },
      { id: "engineering_team", type: "team", config: { team: "engineering" } },
      { id: "result", type: "join", config: { mode: "concat", separator: "\n" } },
      { id: "output", type: "output", config: { format: "text" } },
    ],
    connections: [
      edge("routing_model", "routing_model", "model", "classify", "model"),
      edge("routing_prompt", "routing_prompt", "prompt", "classify", "prompt"),
      { ...edge("direct_route", "classify", "decision", "direct", "value"), select: "/value", condition: { path: "/route", op: "equals", value: "direct" } },
      { ...edge("research_route", "classify", "decision", "research_team", "value"), select: "/value", condition: { path: "/route", op: "equals", value: "research" } },
      { ...edge("engineering_route", "classify", "decision", "engineering_team", "value"), select: "/value", condition: { path: "/route", op: "equals", value: "engineering" } },
      edge("direct_result", "direct", "value", "result", "values"),
      edge("research_result", "research_team", "value", "result", "values"),
      edge("engineering_result", "engineering_team", "value", "result", "values"),
      edge("final_output", "result", "value", "output", "value"),
    ],
    entrypoint: "output",
    subgraphs: {
      direct_agent: agentGraph("Answer the original request directly and concisely. The request is in value.\n\n{{input}}"),
      chief_agent: agentGraph("You are the Team orchestrator. For phase=plan, create a minimal dependency-aware task list using researcher, coder, and reviewer. For phase=synthesize, return only the verified final answer.\n\n{{input}}", true),
      research_agent: agentGraph("Gather current evidence with Web Search. Send concise findings to the Team and report a sourced result.\n\n{{input}}", false, "web"),
      coding_agent: agentGraph("Use the isolated Code Runner only when execution materially verifies the task. Report artifacts and concise results.\n\n{{input}}", false, "code"),
      review_agent: agentGraph("Review completed work for correctness, missing evidence, and unmet requirements. Propose a plan update when necessary.\n\n{{input}}"),
    },
    agentTemplates: {
      chief: { description: "Plans, delegates, accepts bounded revisions, and synthesizes the user answer", runner: { subgraph: "chief_agent" } },
      researcher: { description: "Finds and cites current external evidence", capabilities: ["network"], runner: { subgraph: "research_agent" } },
      coder: { description: "Runs isolated code and produces artifacts", capabilities: ["process", "workspace-write"], runner: { subgraph: "coding_agent" } },
      reviewer: { description: "Checks evidence and goal completion", runner: { subgraph: "review_agent" } },
    },
    teams: {
      engineering: {
        orchestrator: "chief",
        members: ["researcher", "coder", "reviewer"],
        limits: { maxInstances: 8, maxDepth: 2, maxParallel: 4, maxMessages: 64, maxPlanRevisions: 16 },
      },
    },
    runtime: { timeoutMs: 600_000, budget: { maxTokens: 1_000_000 } },
    studio: {
      positions: {
        routing_model: { x: 60, y: 40 }, routing_prompt: { x: 60, y: 220 }, classify: { x: 390, y: 130 },
        direct: { x: 740, y: 20 }, research_team: { x: 740, y: 190 }, engineering_team: { x: 740, y: 360 },
        result: { x: 1090, y: 190 }, output: { x: 1400, y: 190 },
      },
      pinned: ["classify"],
      direction: "RIGHT",
      subgraphs: Object.fromEntries(["direct_agent", "chief_agent", "research_agent", "coding_agent", "review_agent"].map((name) => [name, {
        positions: { model: { x: 40, y: 30 }, prompt: { x: 40, y: 210 }, ...(name === "research_agent" || name === "coding_agent" ? { tool: { x: 40, y: 390 } } : {}), agent: { x: 390, y: 130 }, output: { x: 720, y: 130 } },
        direction: "RIGHT" as const,
      }])),
    },
  };
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
    const agent = spec.components.find((component) => component.id === "agent");
    if (agent) agent.config = {
      ...agent.config,
      toolError: "fail",
      ...(id === "web-research" ? { maxToolCalls: 1, maxTurns: 3 } : {}),
    };
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
    const agent = spec.components.find((component) => component.id === "agent");
    if (agent) agent.config = { ...agent.config, toolError: "fail" };
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
