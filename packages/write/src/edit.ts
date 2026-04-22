import { Buffer } from "node:buffer";
import {
  toolError,
  withFileLock,
  type ReadOperations,
  type ToolError,
  type WriteOperations,
} from "@agent-sh/harness-core";
import { isBinary } from "@agent-sh/harness-read";
import { BINARY_SAMPLE_BYTES, MAX_EDIT_FILE_SIZE } from "./constants.js";
import { applyEdit } from "./engine.js";
import { fencePath, resolvePath, resolveSession, sha256Hex } from "./fence.js";
import {
  formatEditSuccess,
  formatPreview,
} from "./format.js";
import { unifiedDiff } from "./diff.js";
import { safeParseEditParams } from "./schema.js";
import type {
  EditParams,
  EditResult,
  ErrorResult,
  PreviewResult,
  TextWriteResult,
  WriteSessionConfig,
} from "./types.js";

function err(error: ToolError): ErrorResult {
  return { kind: "error", error };
}

export async function edit(
  input: unknown,
  session: WriteSessionConfig,
): Promise<EditResult> {
  const parsed = safeParseEditParams(input);
  if (!parsed.ok) {
    const messages = parsed.issues.map((i) => i.message).join("; ");
    return err(toolError("INVALID_PARAM", messages, { cause: parsed.issues }));
  }
  const params = parsed.value;

  const { ops, writeOps } = resolveSession(session);
  const resolvedPath = await resolvePath(ops, session.cwd, params.path);

  const fence = await fencePath(session, resolvedPath, "edit", {
    old_string_preview: preview(params.old_string),
    new_string_preview: preview(params.new_string),
    replace_all: params.replace_all === true,
    dry_run: params.dry_run === true,
  });
  if (fence !== undefined) return err(fence);

  return withFileLock(resolvedPath, () =>
    executeEdit(ops, writeOps, session, resolvedPath, params),
  );
}

async function executeEdit(
  ops: ReadOperations,
  writeOps: WriteOperations,
  session: WriteSessionConfig,
  resolvedPath: string,
  params: EditParams,
): Promise<EditResult> {
  const preflight = await preflightMutation(ops, session, resolvedPath);
  if ("error" in preflight) return err(preflight.error);
  const { existingContent, existingBytes, previousSha } = preflight;

  const editResult = applyEdit(existingContent, {
    old_string: params.old_string,
    new_string: params.new_string,
    replace_all: params.replace_all === true,
  });
  if ("code" in editResult) return err(editResult);

  const newContent = editResult.content;
  const newBytes = Buffer.from(newContent, "utf8");

  if (params.dry_run === true) {
    const diff = unifiedDiff({
      oldPath: resolvedPath,
      newPath: resolvedPath,
      oldContent: existingContent,
      newContent,
    });
    const result: PreviewResult = {
      kind: "preview",
      output: formatPreview({
        path: resolvedPath,
        diff,
        wouldWriteBytes: newBytes.length,
        bytesBefore: existingBytes.length,
      }),
      diff,
      meta: {
        path: resolvedPath,
        would_write_bytes: newBytes.length,
        bytes_delta: newBytes.length - existingBytes.length,
        previous_sha256: previousSha,
      },
    };
    return result;
  }

  if (session.validate) {
    const validation = await session.validate({
      path: resolvedPath,
      content: newContent,
      previous_content: existingContent,
    });
    if (!validation.ok) {
      return err(
        toolError(
          "VALIDATE_FAILED",
          `validate hook rejected the edit. The file is unchanged on disk.\n\n${formatValidateErrors(validation.errors ?? [])}`,
          { meta: { path: resolvedPath, errors: validation.errors ?? [] } },
        ),
      );
    }
  }

  try {
    await writeOps.writeAtomic(resolvedPath, newBytes);
  } catch (e) {
    return err(
      toolError("IO_ERROR", `write failed: ${(e as Error).message}`, {
        cause: e,
      }),
    );
  }

  const newSha = sha256Hex(newBytes);
  const newStat = await ops.stat(resolvedPath).catch(() => undefined);
  const mtime = newStat?.mtime_ms ?? Date.now();

  if (session.ledger) {
    session.ledger.record({
      path: resolvedPath,
      sha256: newSha,
      mtime_ms: mtime,
      size_bytes: newBytes.length,
      lines_returned: 0,
      offset: 0,
      limit: 0,
      timestamp_ms: Date.now(),
    });
  }

  const result: TextWriteResult = {
    kind: "text",
    output: formatEditSuccess({
      path: resolvedPath,
      replacements: editResult.replacements,
      replaceAll: params.replace_all === true,
      bytesBefore: existingBytes.length,
      bytesAfter: newBytes.length,
      warnings: editResult.warnings,
    }),
    meta: {
      path: resolvedPath,
      replacements: editResult.replacements,
      bytes_delta: newBytes.length - existingBytes.length,
      sha256: newSha,
      mtime_ms: mtime,
      previous_sha256: previousSha,
      ...(editResult.warnings.length > 0
        ? { warnings: editResult.warnings }
        : {}),
    },
  };
  return result;
}

export interface PreflightOk {
  readonly existingContent: string;
  readonly existingBytes: Uint8Array;
  readonly previousSha: string;
}

export interface PreflightErr {
  readonly error: ToolError;
}

/**
 * Shared pre-edit checks for Edit and MultiEdit: file exists, not binary,
 * not too large, has a fresh ledger entry, sha matches.
 */
export async function preflightMutation(
  ops: ReadOperations,
  session: WriteSessionConfig,
  resolvedPath: string,
): Promise<PreflightOk | PreflightErr> {
  let stat;
  try {
    stat = await ops.stat(resolvedPath);
  } catch (e) {
    return {
      error: toolError("IO_ERROR", `stat failed: ${(e as Error).message}`, {
        cause: e,
      }),
    };
  }

  if (!stat) {
    return {
      error: toolError(
        "NOT_FOUND",
        `File not found: ${resolvedPath}. Edit requires an existing file; use Write to create new files.`,
        { meta: { path: resolvedPath } },
      ),
    };
  }

  if (stat.type === "directory") {
    return {
      error: toolError(
        "INVALID_PARAM",
        `Path is a directory, not a file: ${resolvedPath}`,
        { meta: { path: resolvedPath } },
      ),
    };
  }

  const maxSize = session.maxFileSize ?? MAX_EDIT_FILE_SIZE;
  if (stat.size > maxSize) {
    return {
      error: toolError(
        "TOO_LARGE",
        `File size ${stat.size} exceeds max ${maxSize} for in-memory edit. Narrow the file or use a streaming tool.`,
        { meta: { path: resolvedPath, size: stat.size, max: maxSize } },
      ),
    };
  }

  let bytes: Uint8Array;
  try {
    bytes = await ops.readFile(resolvedPath);
  } catch (e) {
    return {
      error: toolError("IO_ERROR", `read failed: ${(e as Error).message}`, {
        cause: e,
      }),
    };
  }

  const sample =
    bytes.length > BINARY_SAMPLE_BYTES
      ? bytes.subarray(0, BINARY_SAMPLE_BYTES)
      : bytes;
  if (isBinary(resolvedPath, sample)) {
    return {
      error: toolError(
        "BINARY_NOT_EDITABLE",
        `Cannot Edit binary file: ${resolvedPath}. Use Write to replace binary content wholesale if intentional.`,
        { meta: { path: resolvedPath } },
      ),
    };
  }

  const ledgerEntry = session.ledger?.getLatest(resolvedPath);
  if (!ledgerEntry) {
    return {
      error: toolError(
        "NOT_READ_THIS_SESSION",
        `File has not been Read in this session: ${resolvedPath}\n\nCall Read on this path first, then retry the edit.`,
        { meta: { path: resolvedPath } },
      ),
    };
  }

  const currentSha = sha256Hex(bytes);
  if (ledgerEntry.sha256 !== currentSha) {
    return {
      error: toolError(
        "STALE_READ",
        `File has changed on disk since the last Read: ${resolvedPath}\n\nOld sha256: ${ledgerEntry.sha256}\nNew sha256: ${currentSha}\n\nRe-Read the file to refresh the ledger, then retry the edit.`,
        {
          meta: {
            path: resolvedPath,
            ledger_sha256: ledgerEntry.sha256,
            current_sha256: currentSha,
          },
        },
      ),
    };
  }

  const content = Buffer.from(bytes).toString("utf8");
  return {
    existingContent: content,
    existingBytes: bytes,
    previousSha: currentSha,
  };
}

function preview(s: string): string {
  if (s.length <= 200) return s;
  return s.slice(0, 200);
}

function formatValidateErrors(
  errors: readonly { line?: number; message: string }[],
): string {
  if (errors.length === 0) return "(no error details provided)";
  return errors
    .map((e) => (e.line !== undefined ? `line ${e.line}: ${e.message}` : e.message))
    .join("\n");
}
