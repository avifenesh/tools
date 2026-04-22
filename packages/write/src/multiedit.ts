import { Buffer } from "node:buffer";
import {
  toolError,
  withFileLock,
  type ReadOperations,
  type ToolError,
  type WriteOperations,
} from "@agent-sh/harness-core";
import { applyPipeline } from "./engine.js";
import { unifiedDiff } from "./diff.js";
import { preflightMutation } from "./edit.js";
import { fencePath, resolvePath, resolveSession, sha256Hex } from "./fence.js";
import {
  formatMultiEditSuccess,
  formatPreview,
} from "./format.js";
import { safeParseMultiEditParams } from "./schema.js";
import type {
  EditSpec,
  ErrorResult,
  MultiEditParams,
  MultiEditResult,
  PreviewResult,
  TextWriteResult,
  WriteSessionConfig,
} from "./types.js";

function err(error: ToolError): ErrorResult {
  return { kind: "error", error };
}

export async function multiEdit(
  input: unknown,
  session: WriteSessionConfig,
): Promise<MultiEditResult> {
  const parsed = safeParseMultiEditParams(input);
  if (!parsed.ok) {
    const messages = parsed.issues.map((i) => i.message).join("; ");
    return err(toolError("INVALID_PARAM", messages, { cause: parsed.issues }));
  }
  const params = parsed.value;

  const { ops, writeOps } = resolveSession(session);
  const resolvedPath = await resolvePath(ops, session.cwd, params.path);

  const fence = await fencePath(session, resolvedPath, "multiedit", {
    edit_count: params.edits.length,
    dry_run: params.dry_run === true,
    edit_previews: params.edits.slice(0, 3).map((e) => ({
      old_string_preview: preview(e.old_string),
      new_string_preview: preview(e.new_string),
      replace_all: e.replace_all === true,
    })),
  });
  if (fence !== undefined) return err(fence);

  return withFileLock(resolvedPath, () =>
    executeMultiEdit(ops, writeOps, session, resolvedPath, params),
  );
}

async function executeMultiEdit(
  ops: ReadOperations,
  writeOps: WriteOperations,
  session: WriteSessionConfig,
  resolvedPath: string,
  params: MultiEditParams,
): Promise<MultiEditResult> {
  const preflight = await preflightMutation(ops, session, resolvedPath);
  if ("error" in preflight) return err(preflight.error);
  const { existingContent, existingBytes, previousSha } = preflight;

  const edits: EditSpec[] = params.edits.map((e) => ({
    old_string: e.old_string,
    new_string: e.new_string,
    replace_all: e.replace_all === true,
  }));

  const pipelineResult = applyPipeline(existingContent, edits);
  if (pipelineResult.kind === "err") return err(pipelineResult.error);

  const newContent = pipelineResult.content;
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
          `validate hook rejected the multiedit. The file is unchanged on disk.\n\n${formatValidateErrors(validation.errors ?? [])}`,
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
    output: formatMultiEditSuccess({
      path: resolvedPath,
      editsApplied: edits.length,
      totalReplacements: pipelineResult.totalReplacements,
      bytesBefore: existingBytes.length,
      bytesAfter: newBytes.length,
      warnings: pipelineResult.warnings,
    }),
    meta: {
      path: resolvedPath,
      edits_applied: edits.length,
      total_replacements: pipelineResult.totalReplacements,
      bytes_delta: newBytes.length - existingBytes.length,
      sha256: newSha,
      mtime_ms: mtime,
      previous_sha256: previousSha,
      ...(pipelineResult.warnings.length > 0
        ? { warnings: pipelineResult.warnings }
        : {}),
    },
  };
  return result;
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
