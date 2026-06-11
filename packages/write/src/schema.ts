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
  ignore_whitespace: v.optional(v.boolean()),
});

const EditSpecSchema = v.object({
  old_string: NonEmptyString,
  new_string: v.string(),
  replace_all: v.optional(v.boolean()),
  ignore_whitespace: v.optional(v.boolean()),
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
/**
 * Canonical MultiEdit tool name. Matches the `multiEdit` entry point and the
 * snake_case convention used by every other multi-word tool name in the
 * workspace (`bash_output`, `bash_kill`).
 */
export const MULTIEDIT_TOOL_NAME = "multi_edit";
/**
 * Legacy MultiEdit tool name (pre-0.6.0 spelling). Still accepted as an alias
 * anywhere tool names are matched/dispatched, but deprecated.
 *
 * @deprecated Use {@link MULTIEDIT_TOOL_NAME} (`"multi_edit"`). The
 * `"multiedit"` spelling will be removed in a future major release.
 */
export const MULTIEDIT_TOOL_NAME_LEGACY = "multiedit";

let warnedLegacyMultiEditToolName = false;

/**
 * Emits a one-time (per process) deprecation warning telling the caller to
 * migrate from `"multiedit"` to `"multi_edit"`. Subsequent calls are no-ops,
 * so dispatch loops do not spam logs.
 */
export function warnLegacyMultiEditToolName(): void {
  if (warnedLegacyMultiEditToolName) return;
  warnedLegacyMultiEditToolName = true;
  const message =
    '[harness-write] DEPRECATION: tool name "multiedit" is deprecated; use "multi_edit". ' +
    'The "multiedit" spelling will be removed in a future major release.';
  if (typeof process !== "undefined" && typeof process.emitWarning === "function") {
    process.emitWarning(message, "DeprecationWarning");
  } else {
    // eslint-disable-next-line no-console
    console.warn(message);
  }
}

/**
 * Returns `true` if `name` names the MultiEdit tool — either the canonical
 * `"multi_edit"` or the deprecated legacy `"multiedit"` spelling.
 *
 * When the legacy spelling is seen, a one-time process-wide deprecation
 * warning is emitted (see {@link warnLegacyMultiEditToolName}). Use this
 * helper at dispatch points so both spellings keep working during the
 * migration window.
 */
export function isMultiEditToolName(name: string): boolean {
  if (name === MULTIEDIT_TOOL_NAME) return true;
  if (name === MULTIEDIT_TOOL_NAME_LEGACY) {
    warnLegacyMultiEditToolName();
    return true;
  }
  return false;
}

export const WRITE_TOOL_DESCRIPTION = `Create a new file, or overwrite an existing file.

Usage:
- New file (path does not exist): call Write directly. No prior Read is required.
- Existing file: Read it first in this session. Overwriting an un-Read file still succeeds but returns a Warning (and may prompt a permission hook); if the file changed on disk since your Read, Write fails with STALE_READ. Reading first protects against clobbering unseen content.
- Prefer Edit or MultiEdit for targeted changes to existing files. Use Write only for new files or genuine wholesale rewrites.
- Write is atomic: bytes land via a temporary file + rename, so readers either see the old content or the new content, never partial.
- Binary content is allowed (pass bytes encoded as the content string); the tool does not inspect content for text-ness.
- Path must be absolute. If relative, it resolves against the session cwd.`;

export const EDIT_TOOL_DESCRIPTION = `Replace exactly one occurrence of old_string with new_string in a file.

Usage:
- Read the file first in this session. Editing an un-Read file still succeeds but returns a Warning (and may prompt a permission hook). If the file changed on disk since the Read, Edit fails with STALE_READ.
- old_string must match the file content exactly, character for character, including whitespace and indentation.
- If old_string appears more than once, the call fails with OLD_STRING_NOT_UNIQUE and lists every match location. Widen old_string with surrounding context until unique, or pass replace_all: true for rename-style changes.
- If old_string does not match, the call fails with OLD_STRING_NOT_FOUND and returns the top fuzzy candidates with line numbers so you can correct the string and retry.
- Use dry_run: true to preview the unified diff without writing.
- Line endings are normalized to LF for matching, so old_string may use LF even when the file is CRLF; the file's original CRLF/LF style is preserved on disk. Tabs and other whitespace are exact.
- Edits on binary files or notebooks are refused.`;

export const MULTIEDIT_TOOL_DESCRIPTION = `Apply a sequence of edits to a single file atomically.

Usage:
- edits is an ordered list of { old_string, new_string, replace_all? } objects.
- Edits apply sequentially in memory: later edits see the output of earlier edits. This lets you rename a function and then change its signature in one call.
- If any edit fails (no match, non-unique without replace_all, no-op, etc.), none of the edits are applied and the file is untouched.
- Read the file first in this session. Editing an un-Read file still succeeds but returns a Warning (and may prompt a permission hook). If the file changed on disk since the Read, the call fails with STALE_READ.
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
      ignore_whitespace: {
        type: "boolean",
        description:
          "If true, ignore leading/trailing whitespace differences when matching old_string.",
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
            ignore_whitespace: { type: "boolean" },
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
