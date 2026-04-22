import {
  webfetch,
  webfetchToolDefinition,
} from "@agent-sh/harness-webfetch";
import type { WebFetchSessionConfig } from "@agent-sh/harness-webfetch";
import { formatToolError } from "@agent-sh/harness-core";
import type { OllamaTool } from "./ollama.js";
import type { ToolExecutor } from "./agent.js";

export function makeWebFetchExecutor(
  session: WebFetchSessionConfig,
): ToolExecutor {
  const tool: OllamaTool = {
    type: "function",
    function: {
      name: webfetchToolDefinition.name,
      description: webfetchToolDefinition.description,
      parameters: webfetchToolDefinition.inputSchema as unknown as Record<
        string,
        unknown
      >,
    },
  };
  return {
    tool,
    async execute(args) {
      const r = await webfetch(args, session);
      switch (r.kind) {
        case "ok":
        case "redirect_loop":
        case "http_error":
          return r.output;
        case "error":
          return formatToolError(r.error);
      }
    },
  };
}
