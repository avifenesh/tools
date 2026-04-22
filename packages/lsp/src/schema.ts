import * as v from "valibot";
import type { ToolDefinition } from "@agent-sh/harness-core";
import type { LspOperation, LspParams } from "./types.js";

const OperationSchema = v.picklist(
  [
    "hover",
    "definition",
    "references",
    "documentSymbol",
    "workspaceSymbol",
    "implementation",
  ],
  "operation must be one of: hover, definition, references, documentSymbol, workspaceSymbol, implementation",
);

export const LspParamsSchema = v.strictObject({
  operation: OperationSchema,
  path: v.optional(v.pipe(v.string(), v.minLength(1, "path must not be empty"))),
  line: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1, "line is 1-indexed; must be >= 1")),
  ),
  character: v.optional(
    v.pipe(
      v.number(),
      v.integer(),
      v.minValue(1, "character is 1-indexed; must be >= 1"),
    ),
  ),
  query: v.optional(v.pipe(v.string(), v.minLength(1, "query must not be empty"))),
  head_limit: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1, "head_limit must be >= 1")),
  ),
});

export type ParsedLspParams = v.InferOutput<typeof LspParamsSchema>;

/**
 * Alias table mirroring the pattern from grep/glob/bash/webfetch. LSP
 * has its own cluster of common model-typos: lots of editor-plugin
 * naming conventions (row/col, file_path, didOpen, etc.).
 */
const KNOWN_PARAM_ALIASES: Record<string, string> = {
  op: "unknown parameter 'op'. Use 'operation' instead.",
  action: "unknown parameter 'action'. Use 'operation' instead.",
  verb: "unknown parameter 'verb'. Use 'operation' instead.",
  method: "unknown parameter 'method'. Use 'operation' instead.",

  file: "unknown parameter 'file'. Use 'path' instead.",
  file_path: "unknown parameter 'file_path'. Use 'path' instead.",
  filename: "unknown parameter 'filename'. Use 'path' instead.",
  uri: "unknown parameter 'uri'. Use 'path' instead (absolute filesystem path, not a file:// URI).",

  row: "unknown parameter 'row'. Use 'line' instead (1-indexed).",
  line_number: "unknown parameter 'line_number'. Use 'line' instead.",
  ln: "unknown parameter 'ln'. Use 'line' instead.",

  col: "unknown parameter 'col'. Use 'character' instead (1-indexed).",
  column: "unknown parameter 'column'. Use 'character' instead.",
  ch: "unknown parameter 'ch'. Use 'character' instead.",
  offset: "unknown parameter 'offset'. Use 'character' instead (1-indexed column, not byte offset).",

  symbol: "unknown parameter 'symbol'. Use 'query' instead (for workspaceSymbol).",
  term: "unknown parameter 'term'. Use 'query' instead.",
  name: "unknown parameter 'name'. Use 'query' instead (for workspaceSymbol) or call 'definition' with a path+position.",
  pattern: "unknown parameter 'pattern'. Use 'query' instead.",

  limit: "unknown parameter 'limit'. Use 'head_limit' instead (default 200).",
  max_results:
    "unknown parameter 'max_results'. Use 'head_limit' instead (default 200).",
  max_count:
    "unknown parameter 'max_count'. Use 'head_limit' instead (default 200).",

  language:
    "unknown parameter 'language'. Language is detected automatically from the 'path' extension via .lsp.json. For cross-language workspaceSymbol, the session's primary language is used.",
  lang: "unknown parameter 'lang'. Language is detected automatically from 'path'.",
  include_declaration:
    "unknown parameter 'include_declaration'. References always include the declaration in v1; no per-call toggle.",
  open: "unknown parameter 'open'. File sync (didOpen/didChange) is handled internally; don't manage it manually.",
  didOpen:
    "unknown parameter 'didOpen'. File sync is handled internally by the tool.",
  start_position:
    "unknown parameter 'start_position'. Use 'line' + 'character' (1-indexed, single position).",
  end_position:
    "unknown parameter 'end_position'. Use 'line' + 'character' (1-indexed, single position).",
  range:
    "unknown parameter 'range'. LSP operations take a single position; use 'line' + 'character'.",
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

/**
 * Per-operation required-field validator. Runs AFTER strictObject passes,
 * since strictObject can't do cross-field conditional rules.
 */
export function validatePerOp(
  params: LspParams,
): { ok: true } | { ok: false; message: string } {
  const op = params.operation;
  const needsPos =
    op === "hover" ||
    op === "definition" ||
    op === "references" ||
    op === "implementation";
  const needsPath =
    needsPos || op === "documentSymbol";
  if (needsPath && params.path === undefined) {
    return {
      ok: false,
      message: `operation '${op}' requires 'path'`,
    };
  }
  if (needsPos) {
    if (params.line === undefined || params.character === undefined) {
      return {
        ok: false,
        message: `operation '${op}' requires 'line' and 'character' (both 1-indexed)`,
      };
    }
  }
  if (op === "workspaceSymbol") {
    if (params.query === undefined || params.query.length === 0) {
      return {
        ok: false,
        message: "operation 'workspaceSymbol' requires a non-empty 'query'",
      };
    }
  }
  return { ok: true };
}

export function safeParseLspParams(input: unknown):
  | { ok: true; value: LspParams }
  | { ok: false; issues: v.BaseIssue<unknown>[] } {
  const aliases = checkAliases(input);
  if (aliases.length > 0) {
    return { ok: false, issues: makeAliasIssues(aliases) };
  }
  const result = v.safeParse(LspParamsSchema, input);
  if (!result.success) return { ok: false, issues: result.issues };
  const perOp = validatePerOp(result.output as LspParams);
  if (!perOp.ok) {
    return { ok: false, issues: makeAliasIssues([perOp.message]) };
  }
  return { ok: true, value: result.output };
}

export const LSP_TOOL_NAME = "lsp";

export const LSP_TOOL_DESCRIPTION = `Language-server operations for code navigation: hover, definition, references, document and workspace symbols, implementation. Positions are 1-INDEXED (matches grep/read output).

Operations:
- hover: type and documentation for the symbol at path:line:character.
- definition: where the symbol at path:line:character is defined.
- references: every place the symbol at path:line:character is used (capped at head_limit, default 200).
- documentSymbol: outline of all symbols in 'path' (no position needed).
- workspaceSymbol: find symbols matching 'query' across the workspace.
- implementation: for an interface or abstract method, which concrete types implement it.

Usage:
- Positions are 1-INDEXED. Line 1 is the first line; character 1 is the first column. If you have positions from grep or Read output, use them directly.
- First call for a language spawns its language server. If the server is still indexing, the tool returns 'server_starting' with a retry hint. Wait the suggested time and call again.
- Diagnostics (compiler errors, lints) run AUTOMATICALLY after Write/Edit calls; you see them in the post-edit hook output. Do NOT ask for them via this tool.
- Language is detected from the path extension via .lsp.json; no per-call language parameter.`;

export const lspToolDefinition: ToolDefinition = {
  name: LSP_TOOL_NAME,
  description: LSP_TOOL_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: [
          "hover",
          "definition",
          "references",
          "documentSymbol",
          "workspaceSymbol",
          "implementation",
        ],
        description:
          "Which LSP operation to run. hover/definition/references/implementation need path+line+character; documentSymbol needs path; workspaceSymbol needs query.",
      },
      path: {
        type: "string",
        description:
          "Absolute path to the source file. Required for all operations except workspaceSymbol.",
      },
      line: {
        type: "integer",
        minimum: 1,
        description:
          "1-indexed line number. Required for hover / definition / references / implementation.",
      },
      character: {
        type: "integer",
        minimum: 1,
        description: "1-indexed character column (not byte offset).",
      },
      query: {
        type: "string",
        description:
          "Symbol name or substring for workspaceSymbol. Case-sensitivity depends on the language server.",
      },
      head_limit: {
        type: "integer",
        minimum: 1,
        description:
          "Cap on locations returned by references / workspaceSymbol. Default 200.",
      },
    },
    required: ["operation"],
    additionalProperties: false,
  },
};
