import * as v from "valibot";
import type { ToolDefinition } from "@agent-sh/harness-core";
import type { GlobParams } from "./types.js";

export const GlobParamsSchema = v.strictObject({
  pattern: v.pipe(v.string(), v.minLength(1, "pattern is required")),
  path: v.optional(v.pipe(v.string(), v.minLength(1, "path must not be empty"))),
  head_limit: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1, "head_limit must be >= 1")),
  ),
  offset: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(0, "offset must be >= 0")),
  ),
});

export type ParsedGlobParams = v.InferOutput<typeof GlobParamsSchema>;

export function parseGlobParams(input: unknown): ParsedGlobParams {
  return v.parse(GlobParamsSchema, input);
}

/**
 * Unknown keys we've observed models send when they meant a different
 * parameter. strictObject rejects them with a generic "Unknown key: X"
 * issue; we pre-check and return a targeted hint instead so the model
 * can self-correct in one turn.
 *
 * Keep this list tight. Mirrors grep's KNOWN_PARAM_ALIASES pattern.
 */
const KNOWN_PARAM_ALIASES: Record<string, string> = {
  glob: "unknown parameter 'glob'. Use 'pattern' instead (this tool IS glob; the pattern goes in the 'pattern' field).",
  glob_pattern: "unknown parameter 'glob_pattern'. Use 'pattern' instead.",
  pattern_glob: "unknown parameter 'pattern_glob'. Use 'pattern' instead.",
  regex:
    "unknown parameter 'regex'. Glob uses glob syntax, not regex — use 'pattern' with syntax like '**/*.ts'. If you want to search file CONTENTS by regex, use the grep tool instead.",
  query: "unknown parameter 'query'. Use 'pattern' instead.",
  filter: "unknown parameter 'filter'. Use 'pattern' instead.",
  file_pattern: "unknown parameter 'file_pattern'. Use 'pattern' instead.",
  name: "unknown parameter 'name'. Use 'pattern' instead (e.g. '**/User*.ts').",
  cwd: "unknown parameter 'cwd'. Use 'path' instead.",
  dir: "unknown parameter 'dir'. Use 'path' instead.",
  directory: "unknown parameter 'directory'. Use 'path' instead.",
  dir_path: "unknown parameter 'dir_path'. Use 'path' instead.",
  root: "unknown parameter 'root'. Use 'path' instead.",
  limit: "unknown parameter 'limit'. Use 'head_limit' instead (default 250).",
  max_results:
    "unknown parameter 'max_results'. Use 'head_limit' instead (default 250).",
  max_count:
    "unknown parameter 'max_count'. Use 'head_limit' instead (default 250).",
  max_depth:
    "unknown parameter 'max_depth'. Depth is controlled by the pattern itself — use '*' for one level, '**/*' for any depth.",
  skip: "unknown parameter 'skip'. Use 'offset' instead.",
  recursive:
    "unknown parameter 'recursive'. Recursion is controlled by the pattern — prefix with '**/' for recursive (e.g. '**/*.ts'), or omit for top-level only.",
  case_sensitive:
    "unknown parameter 'case_sensitive'. Not supported per-call — glob is case-insensitive by default; use a case-specific pattern if you need exact casing.",
  ignore_case:
    "unknown parameter 'ignore_case'. Glob is case-insensitive by default; no flag needed.",
  insensitive:
    "unknown parameter 'insensitive'. Glob is case-insensitive by default; no flag needed.",
  include_hidden:
    "unknown parameter 'include_hidden'. Hidden files are excluded by default and cannot be included per-call; this is a session-config decision.",
  hidden:
    "unknown parameter 'hidden'. Hidden files are excluded by default and cannot be included per-call.",
  no_ignore:
    "unknown parameter 'no_ignore'. Gitignore respect is on by default and cannot be disabled per-call.",
  follow_symlinks:
    "unknown parameter 'follow_symlinks'. Symlinks are not followed; this is not configurable per-call.",
  exclude: "unknown parameter 'exclude'. Use a negated glob pattern like '!node_modules/**' within 'pattern', or rely on .gitignore.",
  exclude_patterns:
    "unknown parameter 'exclude_patterns'. Use a negated segment in 'pattern' or rely on .gitignore.",
};

function checkAliases(input: unknown): string[] {
  if (input === null || typeof input !== "object") return [];
  const hints: string[] = [];
  for (const key of Object.keys(input as Record<string, unknown>)) {
    const hint = KNOWN_PARAM_ALIASES[key];
    if (hint) hints.push(hint);
  }
  return hints;
}

function makeAliasIssues(messages: string[]): v.BaseIssue<unknown>[] {
  return messages.map(
    (m) =>
      ({
        kind: "validation",
        type: "custom",
        input: undefined,
        expected: null,
        received: "unknown",
        message: m,
      }) as unknown as v.BaseIssue<unknown>,
  );
}

export function safeParseGlobParams(input: unknown):
  | { ok: true; value: GlobParams }
  | { ok: false; issues: v.BaseIssue<unknown>[] } {
  const aliases = checkAliases(input);
  if (aliases.length > 0) {
    return { ok: false, issues: makeAliasIssues(aliases) };
  }
  const result = v.safeParse(GlobParamsSchema, input);
  if (result.success) return { ok: true, value: result.output };
  return { ok: false, issues: result.issues };
}

export const GLOB_TOOL_NAME = "glob";

export const GLOB_TOOL_DESCRIPTION = `Find files by name pattern. Returns absolute paths sorted by modification time, newest first.

Usage:
- pattern is required. Bash-style glob syntax: '*' matches within one path segment (does not cross '/'), '**' matches any number of segments, '?' matches one character, '{a,b,c}' is brace expansion. Case-insensitive by default.
- To search recursively across subdirectories, include '**/'. Example: '**/*.ts' finds every TypeScript file; 'src/**/*.{ts,tsx}' restricts to src/. A bare '*.ts' matches only top-level files — it is NOT recursive. A bare name like 'UserService.ts' matches only that exact top-level file; use '**/UserService.ts' to find it at any depth.
- path defaults to the session cwd. Absolute paths preferred; relative paths resolve against cwd.
- Results are sorted by modification time (newest first), capped at head_limit (default 250). Use offset to page: next_offset = previous_offset + returned_count.
- .gitignore, .ignore, and .rgignore are respected. Hidden files (dotfiles) are skipped. node_modules, .git, and other ignored paths will not appear.
- Prefer this tool over 'find' or 'ls -R' for filename search. If you need to search file CONTENTS, use the grep tool instead.
- Call in parallel for independent searches. When the task requires many rounds of pattern exploration, consider delegating to a sub-agent.`;

export const globToolDefinition: ToolDefinition = {
  name: GLOB_TOOL_NAME,
  description: GLOB_TOOL_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description:
          "Glob pattern to match file paths. Use '**/' for recursive search (e.g. '**/*.ts'). Bare '*.ts' matches only the top level.",
      },
      path: {
        type: "string",
        description:
          "Directory to search in. Absolute preferred; relative resolves against cwd. Defaults to cwd. IMPORTANT: Omit this field to use the default. DO NOT pass \"undefined\" or \"null\".",
      },
      head_limit: {
        type: "integer",
        minimum: 1,
        description: "Max paths to return. Default 250.",
      },
      offset: {
        type: "integer",
        minimum: 0,
        description:
          "Skip first N paths. Use next_offset from a previous call to page.",
      },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
};
