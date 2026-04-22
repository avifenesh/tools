import * as v from "valibot";
import type { ToolDefinition } from "@agent-sh/harness-core";
import type { ReadParams } from "./types.js";

export const ReadParamsSchema = v.object({
  path: v.pipe(v.string(), v.minLength(1, "path must not be empty")),
  offset: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1, "offset must be >= 1")),
  ),
  limit: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1, "limit must be >= 1")),
  ),
});

export type ParsedReadParams = v.InferOutput<typeof ReadParamsSchema>;

export function parseReadParams(input: unknown): ParsedReadParams {
  return v.parse(ReadParamsSchema, input);
}

export function safeParseReadParams(input: unknown):
  | { ok: true; value: ReadParams }
  | { ok: false; issues: v.BaseIssue<unknown>[] } {
  const result = v.safeParse(ReadParamsSchema, input);
  if (result.success) return { ok: true, value: result.output };
  return { ok: false, issues: result.issues };
}

export const READ_TOOL_NAME = "read";

export const READ_TOOL_DESCRIPTION = `Read a file or directory from the local filesystem.

Usage:
- The path parameter should be an absolute path. If relative, it resolves against the session working directory.
- By default, returns up to 2000 lines from the start of the file.
- The offset parameter is the 1-indexed line number to start from.
- For later sections, call this tool again with a larger offset.
- Use the grep tool for content search in large files; glob to locate files by pattern.
- Contents are returned with each line prefixed by its line number as "<line>: <content>".
- Any line longer than 2000 characters is truncated.
- Call this tool in parallel when reading multiple files.
- Avoid tiny repeated slices (under 30 lines). Read a larger window instead.
- Images and PDFs are returned as file attachments.
- Binary files are refused; use specialized tools.`;

export const readToolDefinition: ToolDefinition = {
  name: READ_TOOL_NAME,
  description: READ_TOOL_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Absolute path (preferred) or path relative to the session cwd.",
      },
      offset: {
        type: "integer",
        minimum: 1,
        description: "1-indexed line number to start reading from.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        description: "Maximum number of lines to read. Defaults to 2000.",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
};
