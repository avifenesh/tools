import {
  bash,
  bashKill,
  bashOutput,
  bashToolDefinition,
  bashOutputToolDefinition,
  bashKillToolDefinition,
} from "@agent-sh/harness-bash";
import type { BashSessionConfig } from "@agent-sh/harness-bash";
import { formatToolError } from "@agent-sh/harness-core";
import type { OllamaTool } from "./ollama.js";
import type { ToolExecutor } from "./agent.js";

function toOllamaTool(def: {
  name: string;
  description: string;
  inputSchema: unknown;
}): OllamaTool {
  return {
    type: "function",
    function: {
      name: def.name,
      description: def.description,
      parameters: def.inputSchema as Record<string, unknown>,
    },
  };
}

export function makeBashExecutor(session: BashSessionConfig): ToolExecutor {
  return {
    tool: toOllamaTool(bashToolDefinition),
    async execute(args) {
      const r = await bash(args, session);
      switch (r.kind) {
        case "ok":
        case "nonzero_exit":
        case "timeout":
        case "background_started":
          return r.output;
        case "error":
          return formatToolError(r.error);
      }
    },
  };
}

export function makeBashOutputExecutor(
  session: BashSessionConfig,
): ToolExecutor {
  return {
    tool: toOllamaTool(bashOutputToolDefinition),
    async execute(args) {
      const r = await bashOutput(args, session);
      switch (r.kind) {
        case "output":
          return r.output;
        case "error":
          return formatToolError(r.error);
      }
    },
  };
}

export function makeBashKillExecutor(
  session: BashSessionConfig,
): ToolExecutor {
  return {
    tool: toOllamaTool(bashKillToolDefinition),
    async execute(args) {
      const r = await bashKill(args, session);
      switch (r.kind) {
        case "killed":
          return r.output;
        case "error":
          return formatToolError(r.error);
      }
    },
  };
}
