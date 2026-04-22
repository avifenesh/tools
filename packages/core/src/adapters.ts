export interface ToolJSONSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ToolJSONSchema;
}

export interface OpenAITool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: ToolJSONSchema;
    readonly strict?: boolean;
  };
}

export interface BedrockTool {
  readonly toolSpec: {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: {
      readonly json: ToolJSONSchema;
    };
  };
}

export interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ToolJSONSchema;
}

export function toOpenAITool(
  def: ToolDefinition,
  opts: { strict?: boolean } = {},
): OpenAITool {
  return {
    type: "function",
    function: {
      name: def.name,
      description: def.description,
      parameters: def.inputSchema,
      ...(opts.strict !== undefined ? { strict: opts.strict } : {}),
    },
  };
}

export function toBedrockTool(def: ToolDefinition): BedrockTool {
  return {
    toolSpec: {
      name: def.name,
      description: def.description,
      inputSchema: { json: def.inputSchema },
    },
  };
}

export function toMcpTool(def: ToolDefinition): McpTool {
  return {
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
  };
}
