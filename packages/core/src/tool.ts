export interface ToolExecutionContext {
  readonly signal: AbortSignal;
  readonly runId: string;
  readonly nodeId: string;
  readonly iteration: number;
  resolveSecret(reference: string): string | undefined;
}

export interface ToolManifest {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface ToolDefinition extends ToolManifest {
  execute(input: unknown, context: ToolExecutionContext): Promise<unknown> | unknown;
}

export class ToolRegistryError extends Error {
  readonly code: "TOOL_INVALID" | "TOOL_DUPLICATE" | "TOOL_NOT_FOUND";
  readonly toolId: string;

  constructor(code: ToolRegistryError["code"], toolId: string, message: string) {
    super(message);
    this.name = "ToolRegistryError";
    this.code = code;
    this.toolId = toolId;
  }
}

const TOOL_ID = /^[a-z][a-z0-9._-]*$/;

export class ToolRegistry {
  readonly #tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): this {
    if (!tool || typeof tool !== "object" || !TOOL_ID.test(tool.id)
      || !tool.label || !tool.description || typeof tool.execute !== "function"
      || !tool.inputSchema || typeof tool.inputSchema !== "object") {
      throw new ToolRegistryError("TOOL_INVALID", typeof tool?.id === "string" ? tool.id : "unknown", "Tool does not implement the ToolDefinition contract");
    }
    if (this.#tools.has(tool.id)) {
      throw new ToolRegistryError("TOOL_DUPLICATE", tool.id, `Tool '${tool.id}' is already registered`);
    }
    this.#tools.set(tool.id, tool);
    return this;
  }

  has(id: string): boolean {
    return this.#tools.has(id);
  }

  get(id: string): ToolDefinition {
    const tool = this.#tools.get(id);
    if (!tool) throw new ToolRegistryError("TOOL_NOT_FOUND", id, `Tool '${id}' is not registered`);
    return tool;
  }

  list(): readonly ToolDefinition[] {
    return [...this.#tools.values()];
  }

  catalog(): readonly ToolManifest[] {
    return this.list().map(({ id, label, description, inputSchema }) => ({ id, label, description, inputSchema }));
  }
}
