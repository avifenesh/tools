import type {
  PermissionPolicy,
  ReadOperations,
  ToolError,
} from "@agent-sh/harness-core";

export type GrepOutputMode = "files_with_matches" | "content" | "count";

export interface GrepParams {
  readonly pattern: string;
  readonly path?: string;
  readonly glob?: string;
  readonly type?: string;
  readonly output_mode?: GrepOutputMode;
  readonly case_insensitive?: boolean;
  readonly multiline?: boolean;
  readonly context_before?: number;
  readonly context_after?: number;
  readonly context?: number;
  readonly head_limit?: number;
  readonly offset?: number;
}

/**
 * Pluggable backend. The default implementation wraps pi0/ripgrep (WASM).
 * A match with `isContext = true` is a context line, not a matching line.
 */
export interface GrepEngineInput {
  readonly pattern: string;
  readonly root: string;
  readonly glob?: string;
  readonly type?: string;
  readonly caseInsensitive?: boolean;
  readonly multiline?: boolean;
  readonly contextBefore?: number;
  readonly contextAfter?: number;
  readonly maxColumns: number;
  readonly maxFilesize: number;
  readonly countOnly?: boolean;
  readonly signal?: AbortSignal;
}

export interface RgMatch {
  readonly path: string;
  readonly lineNumber: number;
  readonly text: string;
  readonly isContext: boolean;
}

export interface RgCount {
  readonly path: string;
  readonly count: number;
}

export interface GrepEngine {
  search(input: GrepEngineInput): AsyncIterable<RgMatch>;
  count(input: GrepEngineInput): AsyncIterable<RgCount>;
}

export interface GrepSessionConfig {
  readonly cwd: string;
  readonly permissions: PermissionPolicy;
  readonly ops?: ReadOperations;
  readonly engine?: GrepEngine;
  readonly defaultHeadLimit?: number;
  readonly maxBytes?: number;
  readonly maxLineLength?: number;
  readonly maxFilesize?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface FilesMatchMeta {
  readonly pattern: string;
  readonly total: number;
  readonly returned: number;
  readonly offset: number;
  readonly headLimit: number;
  readonly more: boolean;
}

export interface ContentMeta {
  readonly pattern: string;
  readonly totalMatches: number;
  readonly totalFiles: number;
  readonly returnedMatches: number;
  readonly offset: number;
  readonly headLimit: number;
  readonly more: boolean;
  readonly byteCap: boolean;
}

export interface CountMeta {
  readonly pattern: string;
  readonly totalFiles: number;
  readonly returnedFiles: number;
  readonly offset: number;
  readonly headLimit: number;
  readonly more: boolean;
}

export type FilesMatchResult = {
  readonly kind: "files_with_matches";
  readonly output: string;
  readonly paths: readonly string[];
  readonly meta: FilesMatchMeta;
};

export type ContentResult = {
  readonly kind: "content";
  readonly output: string;
  readonly meta: ContentMeta;
};

export type CountResult = {
  readonly kind: "count";
  readonly output: string;
  readonly counts: readonly RgCount[];
  readonly meta: CountMeta;
};

export type ErrorGrepResult = {
  readonly kind: "error";
  readonly error: ToolError;
};

export type GrepResult =
  | FilesMatchResult
  | ContentResult
  | CountResult
  | ErrorGrepResult;
