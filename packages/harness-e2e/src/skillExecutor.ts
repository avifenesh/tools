import { skill, skillToolDefinition } from "@agent-sh/harness-skill";
import type { SkillSessionConfig } from "@agent-sh/harness-skill";
import { formatToolError } from "@agent-sh/harness-core";
import type { OllamaTool } from "./ollama.js";
import type { ToolExecutor } from "./agent.js";

export function makeSkillExecutor(session: SkillSessionConfig): ToolExecutor {
  const tool: OllamaTool = {
    type: "function",
    function: {
      name: skillToolDefinition.name,
      description: skillToolDefinition.description,
      parameters: skillToolDefinition.inputSchema as unknown as Record<
        string,
        unknown
      >,
    },
  };
  return {
    tool,
    async execute(args) {
      const r = await skill(args, session);
      switch (r.kind) {
        case "ok":
        case "already_loaded":
        case "not_found":
          return r.output;
        case "error":
          return formatToolError(r.error);
      }
    },
  };
}
