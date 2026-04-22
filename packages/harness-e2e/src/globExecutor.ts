import { glob, globToolDefinition } from "@agent-sh/harness-glob";
import type { GlobSessionConfig } from "@agent-sh/harness-glob";
import { formatToolError } from "@agent-sh/harness-core";
import type { OllamaTool } from "./ollama.js";
import type { ToolExecutor } from "./agent.js";

export function makeGlobExecutor(session: GlobSessionConfig): ToolExecutor {
  const tool: OllamaTool = {
    type: "function",
    function: {
      name: globToolDefinition.name,
      description: globToolDefinition.description,
      parameters: globToolDefinition.inputSchema as unknown as Record<
        string,
        unknown
      >,
    },
  };
  return {
    tool,
    async execute(args) {
      const r = await glob(args, session);
      switch (r.kind) {
        case "paths":
          return r.output;
        case "error":
          return formatToolError(r.error);
      }
    },
  };
}
