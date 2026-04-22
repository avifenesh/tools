import { read, readToolDefinition } from "@agent-sh/harness-read";
import type { ReadSessionConfig } from "@agent-sh/harness-read";
import { formatToolError } from "@agent-sh/harness-core";
import type { OllamaTool } from "./ollama.js";
import type { ToolExecutor } from "./agent.js";

export function makeReadExecutor(session: ReadSessionConfig): ToolExecutor {
  const tool: OllamaTool = {
    type: "function",
    function: {
      name: readToolDefinition.name,
      description: readToolDefinition.description,
      parameters: readToolDefinition.inputSchema as unknown as Record<
        string,
        unknown
      >,
    },
  };
  return {
    tool,
    async execute(args) {
      const result = await read(args, session);
      switch (result.kind) {
        case "text":
          return result.output;
        case "directory":
          return result.output;
        case "attachment": {
          const mime = result.attachments[0]?.mime ?? "application/octet-stream";
          return `${result.output}\n(mime=${mime}, bytes=${result.meta.size_bytes}; attachment body omitted in text channel)`;
        }
        case "error":
          return formatToolError(result.error);
      }
    },
  };
}
