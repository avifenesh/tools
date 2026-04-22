import type {
  PermissionPolicy,
  ReadOperations,
  ToolError,
} from "@agent-sh/harness-core";

export interface GlobParams {
  readonly pattern: string;
  readonly path?: string;
  readonly head_limit?: number;
  readonly offset?: number;
}

/**
 * Pluggable backend. The default implementation wraps pi0/ripgrep --files
 * (no pattern filter — that happens in-process against the enumeration
 * so gitignore/hidden semantics are preserved; see engine.ts).
 */
export interface GlobEngineInput {
  readonly root: string;
  readonly maxFilesize: number;
  readonly signal?: AbortSignal;
}

export interface GlobEngine {
  list(input: GlobEngineInput): AsyncIterable<{ path: string }>;
}

export interface GlobSessionConfig {
  readonly cwd: string;
  readonly permissions: PermissionPolicy;
  readonly ops?: ReadOperations;
  readonly engine?: GlobEngine;
  readonly defaultHeadLimit?: number;
  readonly maxBytes?: number;
  readonly maxFilesize?: number;
  readonly maxPathsScanned?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface GlobPathsMeta {
  readonly pattern: string;
  readonly total: number;
  readonly returned: number;
  readonly offset: number;
  readonly headLimit: number;
  readonly more: boolean;
}

export type GlobPathsResult = {
  readonly kind: "paths";
  readonly output: string;
  readonly paths: readonly string[];
  readonly meta: GlobPathsMeta;
};

export type ErrorGlobResult = {
  readonly kind: "error";
  readonly error: ToolError;
};

export type GlobResult = GlobPathsResult | ErrorGlobResult;
