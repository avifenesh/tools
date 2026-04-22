import * as v from "valibot";
import type { ToolDefinition } from "@agent-sh/harness-core";
import type { EditParams, MultiEditParams, WriteParams } from "./types.js";

const NonEmptyString = v.pipe(v.string(), v.minLength(1));

export const WriteParamsSchema = v.object({
  path: v.pipe(v.string(), v.minLength(1, "path must not be empty")),
  content: v.string(),
});

export const EditParamsSchema = v.object({
  path: v.pipe(v.string(), v.minLength(1, "path must not be empty")),
  old_string: NonEmptyString,
  new_string: v.string(),
  replace_all: v.optional(v.boolean()),
  dry_run: v.optional(v.boolean()),
});

const EditSpecSchema = v.object({
  old_string: NonEmptyString,
  new_string: v.string(),
  replace_all: v.optional(v.boolean()),
});

export const MultiEditParamsSchema = v.object({
  path: v.pipe(v.string(), v.minLength(1, "path must not be empty")),
  edits: v.pipe(
    v.array(EditSpecSchema),
    v.minLength(1, "edits must contain at least one edit"),
  ),
  dry_run: v.optional(v.boolean()),
});

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: v.BaseIssue<unknown>[] };

export function safeParseWriteParams(input: unknown): ParseResult<WriteParams> {
  const r = v.safeParse(WriteParamsSchema, input);
  return r.success
    ? { ok: true, value: r.output }
    : { ok: false, issues: r.issues };
}

export function safeParseEditParams(input: unknown): ParseResult<EditParams> {
  const r = v.safeParse(EditParamsSchema, input);
  return r.success
    ? { ok: true, value: r.output }
    : { ok: false, issues: r.issues };
}

export function safeParseMultiEditParams(
  input: unknown,
): ParseResult<MultiEditParams> {
  const r = v.safeParse(MultiEditParamsSchema, input);
  return r.success
    ? { ok: true, value: r.output }
    : { ok: false, issues: r.issues };
}

export const WRITE_TOOL_NAME = "write";
export const EDIT_TOOL_NAME = "edit";
export const MULTIEDIT_TOOL_NAME = "multiedit";

export const WRITE_TOOL_DESCRIPTION = `Create a new file, or overwrite an existing file.

Usage:
- New file (path does not exist): call Write directly. No prior Read is required.
- Existing file: you must Read it first in this session, or Write fails with NOT_READ_THIS_SESSION. This protects against clobbering unseen content.
- Prefer Edit or MultiEdit for targeted changes to existing files. Use Write only for new files or genuine wholesale rewrites.
- Write is atomic: bytes land via a temporary file + rename, so readers either see the old content or the new content, never partial.
- Binary content is allowed (pass bytes encoded as the content string); the tool does not inspect content for text-ness.
- Path must be absolute. If relative, it resolves against the session cwd.`;

export const EDIT_TOOL_DESCRIPTION = `Replace exactly one occurrence of old_string with new_string in a file.

Usage:
- The file must have been Read first in this session. Edit refuses if there is no ledger entry for the path, or if the file has changed on disk since the Read (STALE_READ).
- old_string must match the file content exactly, character for character, including whitespace and indentation.
- If old_string appears more than once, the call fails with OLD_STRING_NOT_UNIQUE and lists every match location. Widen old_string with surrounding context until unique, or pass replace_all: true for rename-style changes.
- If old_string does not match, the call fails with OLD_STRING_NOT_FOUND and returns the top fuzzy candidates with line numbers so you can correct the string and retry.
- Use dry_run: true to preview the unified diff without writing.
- CRLF is normalized to LF on both sides; tabs and other whitespace are exact.
- Edits on binary files or notebooks are refused.`;

export const MULTIEDIT_TOOL_DESCRIPTION = `Apply a sequence of edits to a single file atomically.

Usage:
- edits is an ordered list of { old_string, new_string, replace_all? } objects.
- Edits apply sequentially in memory: later edits see the output of earlier edits. This lets you rename a function and then change its signature in one call.
- If any edit fails (no match, non-unique without replace_all, no-op, etc.), none of the edits are applied and the file is untouched.
- The file must have been Read first in this session, and must not have changed on disk since the Read.
- Use dry_run: true to preview the final unified diff without writing.`;

export const writeToolDefinition: ToolDefinition = {
  name: WRITE_TOOL_NAME,
  description: WRITE_TOOL_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Absolute path (preferred) or path relative to the session cwd.",
      },
      content: {
        type: "string",
        description: "The full file content to write.",
      },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
};

export const editToolDefinition: ToolDefinition = {
  name: EDIT_TOOL_NAME,
  description: EDIT_TOOL_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Absolute path (preferred) or path relative to the session cwd.",
      },
      old_string: {
        type: "string",
        description:
          "The exact text to find. Must match character-for-character, including whitespace.",
      },
      new_string: {
        type: "string",
        description: "The text to replace old_string with.",
      },
      replace_all: {
        type: "boolean",
        description:
          "If true, replace every occurrence of old_string. Default false (unique-or-error).",
      },
      dry_run: {
        type: "boolean",
        description:
          "If true, return the unified diff without writing to disk.",
      },
    },
    required: ["path", "old_string", "new_string"],
    additionalProperties: false,
  },
};

export const multieditToolDefinition: ToolDefinition = {
  name: MULTIEDIT_TOOL_NAME,
  description: MULTIEDIT_TOOL_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Absolute path (preferred) or path relative to the session cwd.",
      },
      edits: {
        type: "array",
        description:
          "Ordered list of edits. Each edit sees the output of previous edits.",
        items: {
          type: "object",
          properties: {
            old_string: { type: "string" },
            new_string: { type: "string" },
            replace_all: { type: "boolean" },
          },
          required: ["old_string", "new_string"],
          additionalProperties: false,
        },
      },
      dry_run: {
        type: "boolean",
        description:
          "If true, return the final unified diff without writing to disk.",
      },
    },
    required: ["path", "edits"],
    additionalProperties: false,
  },
};
