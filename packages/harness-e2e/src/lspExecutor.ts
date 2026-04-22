import {
  lsp,
  lspToolDefinition,
} from "@agent-sh/harness-lsp";
import type { LspSessionConfig } from "@agent-sh/harness-lsp";
import { formatToolError } from "@agent-sh/harness-core";
import type { OllamaTool } from "./ollama.js";
import type { ToolExecutor } from "./agent.js";

export function makeLspExecutor(session: LspSessionConfig): ToolExecutor {
  const tool: OllamaTool = {
    type: "function",
    function: {
      name: lspToolDefinition.name,
      description: lspToolDefinition.description,
      parameters: lspToolDefinition.inputSchema as unknown as Record<
        string,
        unknown
      >,
    },
  };
  return {
    tool,
    async execute(args) {
      const r = await lsp(args, session);
      switch (r.kind) {
        case "hover":
        case "definition":
        case "references":
        case "documentSymbol":
        case "workspaceSymbol":
        case "implementation":
        case "no_results":
        case "server_starting":
          return r.output;
        case "error":
          return formatToolError(r.error);
      }
    },
  };
}
