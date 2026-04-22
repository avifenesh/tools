export type ToolErrorCode =
  | "NOT_FOUND"
  | "BINARY"
  | "TOO_LARGE"
  | "OUTSIDE_WORKSPACE"
  | "SENSITIVE"
  | "PERMISSION_DENIED"
  | "INVALID_PARAM"
  | "IO_ERROR"
  | "NOT_READ_THIS_SESSION"
  | "STALE_READ"
  | "OLD_STRING_NOT_FOUND"
  | "OLD_STRING_NOT_UNIQUE"
  | "EMPTY_FILE"
  | "NO_OP_EDIT"
  | "BINARY_NOT_EDITABLE"
  | "NOTEBOOK_UNSUPPORTED"
  | "DENIED_BY_HOOK"
  | "VALIDATE_FAILED"
  | "INVALID_REGEX"
  | "TIMEOUT"
  | "KILLED"
  | "INVALID_URL"
  | "SSRF_BLOCKED"
  | "DNS_ERROR"
  | "TLS_ERROR"
  | "CONNECTION_RESET"
  | "OVERSIZE"
  | "UNSUPPORTED_CONTENT_TYPE"
  | "REDIRECT_LOOP"
  | "INTERACTIVE_DETECTED"
  | "SERVER_NOT_AVAILABLE"
  | "SERVER_CRASHED"
  | "POSITION_INVALID"
  | "INVALID_FRONTMATTER"
  | "NAME_MISMATCH"
  | "DISABLED"
  | "NOT_TRUSTED";

export interface ToolError {
  readonly code: ToolErrorCode;
  readonly message: string;
  readonly cause?: unknown;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export function toolError(
  code: ToolErrorCode,
  message: string,
  opts: { cause?: unknown; meta?: Readonly<Record<string, unknown>> } = {},
): ToolError {
  return opts.cause !== undefined && opts.meta !== undefined
    ? { code, message, cause: opts.cause, meta: opts.meta }
    : opts.cause !== undefined
      ? { code, message, cause: opts.cause }
      : opts.meta !== undefined
        ? { code, message, meta: opts.meta }
        : { code, message };
}

export function formatToolError(err: ToolError): string {
  return `Error [${err.code}]: ${err.message}`;
}
