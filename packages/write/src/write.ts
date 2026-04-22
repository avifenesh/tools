import { Buffer } from "node:buffer";
import {
  toolError,
  withFileLock,
  type ReadOperations,
  type ToolError,
} from "@agent-sh/harness-core";
import { fencePath, resolvePath, resolveSession, sha256Hex } from "./fence.js";
import { formatWriteSuccess } from "./format.js";
import { safeParseWriteParams } from "./schema.js";
import type {
  ErrorResult,
  TextWriteResult,
  WriteParams,
  WriteResult,
  WriteSessionConfig,
} from "./types.js";

function err(error: ToolError): ErrorResult {
  return { kind: "error", error };
}

export async function write(
  input: unknown,
  session: WriteSessionConfig,
): Promise<WriteResult> {
  const parsed = safeParseWriteParams(input);
  if (!parsed.ok) {
    const messages = parsed.issues.map((i) => i.message).join("; ");
    return err(toolError("INVALID_PARAM", messages, { cause: parsed.issues }));
  }
  const params = parsed.value;

  const { ops, writeOps } = resolveSession(session);
  const resolvedPath = await resolvePath(ops, session.cwd, params.path);

  const fence = await fencePath(session, resolvedPath, "write", {
    write_bytes: Buffer.byteLength(params.content, "utf8"),
  });
  if (fence !== undefined) return err(fence);

  return withFileLock(resolvedPath, () =>
    executeWrite(ops, writeOps, session, resolvedPath, params),
  );
}

async function executeWrite(
  ops: ReadOperations,
  writeOps: ReturnType<typeof resolveSession>["writeOps"],
  session: WriteSessionConfig,
  resolvedPath: string,
  params: WriteParams,
): Promise<WriteResult> {
  let stat;
  try {
    stat = await ops.stat(resolvedPath);
  } catch (e) {
    return err(
      toolError("IO_ERROR", `stat failed: ${(e as Error).message}`, {
        cause: e,
      }),
    );
  }

  const exists = stat !== undefined && stat.type === "file";
  let previousSha: string | undefined;
  let previousBytes = 0;

  if (stat !== undefined && stat.type === "directory") {
    return err(
      toolError(
        "INVALID_PARAM",
        `Path is a directory, not a file: ${resolvedPath}`,
        { meta: { path: resolvedPath } },
      ),
    );
  }

  if (exists) {
    let existingBytes: Uint8Array;
    try {
      existingBytes = await ops.readFile(resolvedPath);
    } catch (e) {
      return err(
        toolError("IO_ERROR", `read failed: ${(e as Error).message}`, {
          cause: e,
        }),
      );
    }
    previousBytes = existingBytes.length;
    previousSha = sha256Hex(existingBytes);

    const ledgerEntry = session.ledger?.getLatest(resolvedPath);
    if (!ledgerEntry) {
      return err(
        toolError(
          "NOT_READ_THIS_SESSION",
          `Write refuses to overwrite a file that has not been Read in this session: ${resolvedPath}\n\nCall Read on this path first, then retry Write.`,
          { meta: { path: resolvedPath } },
        ),
      );
    }
    if (ledgerEntry.sha256 !== previousSha) {
      return err(
        toolError(
          "STALE_READ",
          `File has changed on disk since the last Read: ${resolvedPath}\n\nOld sha256: ${ledgerEntry.sha256}\nNew sha256: ${previousSha}\n\nRe-Read the file to refresh the ledger, then retry Write.`,
          {
            meta: {
              path: resolvedPath,
              ledger_sha256: ledgerEntry.sha256,
              current_sha256: previousSha,
            },
          },
        ),
      );
    }
  }

  // Validate hook runs on the proposed content.
  if (session.validate) {
    const previousContent = exists
      ? Buffer.from(await ops.readFile(resolvedPath)).toString("utf8")
      : null;
    const validation = await session.validate({
      path: resolvedPath,
      content: params.content,
      previous_content: previousContent,
    });
    if (!validation.ok) {
      return err(
        toolError(
          "VALIDATE_FAILED",
          `validate hook rejected the write.\n\n${formatValidateErrors(validation.errors ?? [])}`,
          { meta: { path: resolvedPath, errors: validation.errors ?? [] } },
        ),
      );
    }
  }

  // Ensure parent directory exists on create path.
  if (!exists) {
    try {
      const parent = pathDirname(resolvedPath);
      await writeOps.mkdirp(parent);
    } catch (e) {
      return err(
        toolError("IO_ERROR", `mkdir failed: ${(e as Error).message}`, {
          cause: e,
        }),
      );
    }
  }

  const bytes = Buffer.from(params.content, "utf8");
  try {
    await writeOps.writeAtomic(resolvedPath, bytes);
  } catch (e) {
    return err(
      toolError("IO_ERROR", `write failed: ${(e as Error).message}`, {
        cause: e,
      }),
    );
  }

  const newSha = sha256Hex(bytes);
  const newStat = await ops.stat(resolvedPath).catch(() => undefined);
  const mtime = newStat?.mtime_ms ?? Date.now();

  if (session.ledger) {
    session.ledger.record({
      path: resolvedPath,
      sha256: newSha,
      mtime_ms: mtime,
      size_bytes: bytes.length,
      lines_returned: 0,
      offset: 0,
      limit: 0,
      timestamp_ms: Date.now(),
    });
  }

  const output = formatWriteSuccess({
    path: resolvedPath,
    created: !exists,
    bytesBefore: previousBytes,
    bytesAfter: bytes.length,
  });

  const result: TextWriteResult = {
    kind: "text",
    output,
    meta: {
      path: resolvedPath,
      bytes_written: bytes.length,
      sha256: newSha,
      mtime_ms: mtime,
      created: !exists,
      ...(previousSha !== undefined ? { previous_sha256: previousSha } : {}),
    },
  };
  return result;
}

function pathDirname(p: string): string {
  const i = p.lastIndexOf("/");
  if (i <= 0) return "/";
  return p.slice(0, i);
}

function formatValidateErrors(
  errors: readonly { line?: number; message: string }[],
): string {
  if (errors.length === 0) return "(no error details provided)";
  return errors
    .map((e) => (e.line !== undefined ? `line ${e.line}: ${e.message}` : e.message))
    .join("\n");
}
