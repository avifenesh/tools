import { grep, grepToolDefinition } from "@agent-sh/harness-grep";
import type { GrepSessionConfig } from "@agent-sh/harness-grep";
import { formatToolError } from "@agent-sh/harness-core";
import type { OllamaTool } from "./ollama.js";
import type { ToolExecutor } from "./agent.js";

export function makeGrepExecutor(session: GrepSessionConfig): ToolExecutor {
  const tool: OllamaTool = {
    type: "function",
    function: {
      name: grepToolDefinition.name,
      description: grepToolDefinition.description,
      parameters: grepToolDefinition.inputSchema as unknown as Record<
        string,
        unknown
      >,
    },
  };
  return {
    tool,
    async execute(args) {
      const r = await grep(args, session);
      switch (r.kind) {
        case "files_with_matches":
        case "content":
        case "count":
          return r.output;
        case "error":
          return formatToolError(r.error);
      }
    },
  };
}
