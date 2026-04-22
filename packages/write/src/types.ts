import type {
  Ledger,
  PermissionPolicy,
  ReadOperations,
  ToolError,
  WriteOperations,
} from "@agent-sh/harness-core";

export interface EditSpec {
  readonly old_string: string;
  readonly new_string: string;
  readonly replace_all?: boolean;
}

export interface WriteParams {
  readonly path: string;
  readonly content: string;
}

export interface EditParams {
  readonly path: string;
  readonly old_string: string;
  readonly new_string: string;
  readonly replace_all?: boolean;
  readonly dry_run?: boolean;
}

export interface MultiEditParams {
  readonly path: string;
  readonly edits: readonly EditSpec[];
  readonly dry_run?: boolean;
}

export interface ValidateContext {
  readonly path: string;
  readonly content: string;
  readonly previous_content: string | null;
}

export interface ValidateError {
  readonly line?: number;
  readonly message: string;
}

export type ValidateHook = (
  ctx: ValidateContext,
) => Promise<{ ok: boolean; errors?: readonly ValidateError[] }>;

export interface WriteSessionConfig {
  readonly cwd: string;
  readonly permissions: PermissionPolicy;
  readonly ops?: ReadOperations;
  readonly writeOps?: WriteOperations;
  readonly ledger?: Ledger;
  readonly validate?: ValidateHook;
  readonly maxFileSize?: number;
  readonly signal?: AbortSignal;
}

export interface FuzzyCandidate {
  readonly line: number;
  readonly score: number;
  readonly preview: string;
  readonly context: {
    readonly before: readonly string[];
    readonly after: readonly string[];
  };
}

export interface MatchLocation {
  readonly line: number;
  readonly preview: string;
  readonly context: {
    readonly before: readonly string[];
    readonly after: readonly string[];
  };
}

export interface WriteMeta {
  readonly path: string;
  readonly bytes_written: number;
  readonly sha256: string;
  readonly mtime_ms: number;
  readonly created: boolean;
  readonly previous_sha256?: string;
}

export interface EditMeta {
  readonly path: string;
  readonly replacements: number;
  readonly bytes_delta: number;
  readonly sha256: string;
  readonly mtime_ms: number;
  readonly previous_sha256: string;
  readonly warnings?: readonly string[];
}

export interface MultiEditMeta {
  readonly path: string;
  readonly edits_applied: number;
  readonly total_replacements: number;
  readonly bytes_delta: number;
  readonly sha256: string;
  readonly mtime_ms: number;
  readonly previous_sha256: string;
  readonly warnings?: readonly string[];
}

export interface PreviewMeta {
  readonly path: string;
  readonly would_write_bytes: number;
  readonly bytes_delta: number;
  readonly previous_sha256: string;
}

export type TextWriteResult = {
  readonly kind: "text";
  readonly output: string;
  readonly meta: WriteMeta | EditMeta | MultiEditMeta;
};

export type PreviewResult = {
  readonly kind: "preview";
  readonly output: string;
  readonly diff: string;
  readonly meta: PreviewMeta;
};

export type ErrorResult = {
  readonly kind: "error";
  readonly error: ToolError;
};

export type WriteResult = TextWriteResult | ErrorResult;
export type EditResult = TextWriteResult | PreviewResult | ErrorResult;
export type MultiEditResult = TextWriteResult | PreviewResult | ErrorResult;
