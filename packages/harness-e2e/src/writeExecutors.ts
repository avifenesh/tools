import {
  write,
  edit,
  multiEdit,
  writeToolDefinition,
  editToolDefinition,
  multieditToolDefinition,
} from "@agent-sh/harness-write";
import type { WriteSessionConfig } from "@agent-sh/harness-write";
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

export function makeWriteExecutor(session: WriteSessionConfig): ToolExecutor {
  return {
    tool: toOllamaTool(writeToolDefinition),
    async execute(args) {
      const r = await write(args, session);
      switch (r.kind) {
        case "text":
          return r.output;
        case "error":
          return formatToolError(r.error);
      }
    },
  };
}

export function makeEditExecutor(session: WriteSessionConfig): ToolExecutor {
  return {
    tool: toOllamaTool(editToolDefinition),
    async execute(args) {
      const r = await edit(args, session);
      switch (r.kind) {
        case "text":
          return r.output;
        case "preview":
          return r.output;
        case "error":
          return formatToolError(r.error);
      }
    },
  };
}

export function makeMultiEditExecutor(
  session: WriteSessionConfig,
): ToolExecutor {
  return {
    tool: toOllamaTool(multieditToolDefinition),
    async execute(args) {
      const r = await multiEdit(args, session);
      switch (r.kind) {
        case "text":
          return r.output;
        case "preview":
          return r.output;
        case "error":
          return formatToolError(r.error);
      }
    },
  };
}
