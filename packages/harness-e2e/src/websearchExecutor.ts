import {
  websearch,
  websearchToolDefinition,
} from "@agent-sh/harness-websearch";
import type { WebSearchSessionConfig } from "@agent-sh/harness-websearch";
import { formatToolError } from "@agent-sh/harness-core";
import type { OllamaTool } from "./ollama.js";
import type { ToolExecutor } from "./agent.js";

export function makeWebSearchExecutor(
  session: WebSearchSessionConfig,
): ToolExecutor {
  const tool: OllamaTool = {
    type: "function",
    function: {
      name: websearchToolDefinition.name,
      description: websearchToolDefinition.description,
      parameters: websearchToolDefinition.inputSchema as unknown as Record<
        string,
        unknown
      >,
    },
  };
  return {
    tool,
    async execute(args) {
      const r = await websearch(args, session);
      switch (r.kind) {
        case "ok":
        case "empty":
          return r.output;
        case "error":
          return formatToolError(r.error);
      }
    },
  };
}
