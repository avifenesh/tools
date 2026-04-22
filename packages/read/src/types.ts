import type {
  Cache,
  Ledger,
  PermissionPolicy,
  ReadOperations,
  ToolError,
} from "@agent-sh/harness-core";

export interface ReadParams {
  readonly path: string;
  readonly offset?: number;
  readonly limit?: number;
}

export interface ReadSessionConfig {
  readonly cwd: string;
  readonly permissions: PermissionPolicy;
  readonly ops?: ReadOperations;
  readonly cache?: Cache<TextReadResult>;
  readonly ledger?: Ledger;
  readonly modelContextTokens?: number;
  readonly tokensPerByte?: number;
  readonly maxFileSize?: number;
  readonly maxBytes?: number;
  readonly defaultLimit?: number;
  readonly maxLineLength?: number;
  readonly signal?: AbortSignal;
}

export interface TextMeta {
  readonly path: string;
  readonly totalLines: number;
  readonly returnedLines: number;
  readonly offset: number;
  readonly limit: number;
  readonly byteCap: boolean;
  readonly more: boolean;
  readonly sha256: string;
  readonly mtime_ms: number;
  readonly size_bytes: number;
}

export interface DirMeta {
  readonly path: string;
  readonly totalEntries: number;
  readonly returnedEntries: number;
  readonly offset: number;
  readonly limit: number;
  readonly more: boolean;
}

export interface AttachmentMeta {
  readonly path: string;
  readonly mime: string;
  readonly size_bytes: number;
}

export interface Attachment {
  readonly mime: string;
  readonly dataUrl: string;
}

export type TextReadResult = {
  readonly kind: "text";
  readonly output: string;
  readonly meta: TextMeta;
};

export type DirReadResult = {
  readonly kind: "directory";
  readonly output: string;
  readonly meta: DirMeta;
};

export type AttachmentReadResult = {
  readonly kind: "attachment";
  readonly output: string;
  readonly attachments: readonly Attachment[];
  readonly meta: AttachmentMeta;
};

export type ErrorReadResult = {
  readonly kind: "error";
  readonly error: ToolError;
};

export type ReadResult =
  | TextReadResult
  | DirReadResult
  | AttachmentReadResult
  | ErrorReadResult;
