import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  defaultNodeOperations,
  isInsideAnyRoot,
  matchesAnyPattern,
  toolError,
  withFileLock,
  type ReadOperations,
  type ToolError,
} from "@agent-sh/harness-core";
import { isBinary, isImageMime, isPdfMime } from "./binary.js";
import {
  BINARY_SAMPLE_BYTES,
  DEFAULT_LIMIT,
  MAX_FILE_SIZE,
} from "./constants.js";
import {
  formatAttachment,
  formatDirectory,
  formatText,
} from "./format.js";
import { streamLines } from "./lines.js";
import { safeParseReadParams } from "./schema.js";
import { suggestSiblings } from "./suggest.js";
import type {
  AttachmentReadResult,
  DirReadResult,
  ErrorReadResult,
  ReadParams,
  ReadResult,
  ReadSessionConfig,
  TextReadResult,
} from "./types.js";

function err(error: ToolError): ErrorReadResult {
  return { kind: "error", error };
}

export async function read(
  input: unknown,
  session: ReadSessionConfig,
): Promise<ReadResult> {
  const parsed = safeParseReadParams(input);
  if (!parsed.ok) {
    const messages = parsed.issues.map((i) => i.message).join("; ");
    return err(toolError("INVALID_PARAM", messages, { cause: parsed.issues }));
  }
  const params = parsed.value;

  const ops = session.ops ?? defaultNodeOperations();

  const resolvedPath = await resolvePath(ops, session.cwd, params.path);
  const fence = await fencePath(ops, session, resolvedPath);
  if (fence !== undefined) return err(fence);

  return withFileLock(resolvedPath, () =>
    executeRead(ops, session, resolvedPath, params),
  );
}

async function resolvePath(
  ops: ReadOperations,
  cwd: string,
  input: string,
): Promise<string> {
  const absolute = path.isAbsolute(input) ? input : path.resolve(cwd, input);
  try {
    return await ops.realpath(absolute);
  } catch {
    return absolute;
  }
}

async function fencePath(
  ops: ReadOperations,
  session: ReadSessionConfig,
  resolvedPath: string,
): Promise<ToolError | undefined> {
  const { permissions } = session;

  const isSensitive = matchesAnyPattern(
    resolvedPath,
    permissions.sensitivePatterns,
  );
  const insideWorkspace = isInsideAnyRoot(resolvedPath, permissions.roots);
  const needsAsk =
    isSensitive ||
    (!insideWorkspace && permissions.bypassWorkspaceGuard !== true);

  if (isSensitive && permissions.hook === undefined) {
    return toolError(
      "SENSITIVE",
      `Refusing to read sensitive path: ${resolvedPath}`,
      { meta: { path: resolvedPath } },
    );
  }

  if (
    !insideWorkspace &&
    permissions.bypassWorkspaceGuard !== true &&
    permissions.hook === undefined
  ) {
    if (process.env.E2E_DEBUG_PERMISSIONS) {
      // eslint-disable-next-line no-console
      console.error(
        `[read fencePath] OUTSIDE_WORKSPACE reject: resolvedPath=${JSON.stringify(resolvedPath)} roots=${JSON.stringify(permissions.roots)}`,
      );
    }
    return toolError(
      "OUTSIDE_WORKSPACE",
      `Path is outside all configured workspace roots: ${resolvedPath}`,
      { meta: { path: resolvedPath, roots: permissions.roots } },
    );
  }

  if (permissions.hook !== undefined) {
    const reason = isSensitive
      ? "sensitive"
      : !insideWorkspace
        ? "outside_workspace"
        : "in_workspace";
    const alwaysPatterns = needsAsk
      ? [path.dirname(resolvedPath) + "/*"]
      : ["*"];
    const decision = await permissions.hook({
      tool: "read",
      path: resolvedPath,
      action: "read",
      always_patterns: alwaysPatterns,
      metadata: { reason },
    });
    if (decision === "deny") {
      return toolError(
        "PERMISSION_DENIED",
        `Read denied by user: ${resolvedPath}`,
        { meta: { path: resolvedPath } },
      );
    }
  }

  return undefined;
}

async function executeRead(
  ops: ReadOperations,
  session: ReadSessionConfig,
  resolvedPath: string,
  params: ReadParams,
): Promise<ReadResult> {
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

  if (!stat) {
    const suggestions = await suggestSiblings(ops, resolvedPath);
    const msg =
      suggestions.length > 0
        ? `File not found: ${resolvedPath}\n\nDid you mean one of these?\n${suggestions.join("\n")}`
        : `File not found: ${resolvedPath}`;
    return err(
      toolError("NOT_FOUND", msg, { meta: { path: resolvedPath, suggestions } }),
    );
  }

  if (stat.type === "directory") {
    return readDirectory(ops, resolvedPath, params);
  }

  const maxSize = session.maxFileSize ?? MAX_FILE_SIZE;
  if (stat.size > maxSize) {
    return err(
      toolError(
        "TOO_LARGE",
        `File size ${stat.size} exceeds max ${maxSize}. Use a narrower offset/limit or grep first.`,
        { meta: { path: resolvedPath, size: stat.size, maxSize } },
      ),
    );
  }

  const half = session.modelContextTokens
    ? Math.floor(session.modelContextTokens / 2)
    : undefined;
  const tokensPerByte = session.tokensPerByte ?? 0.3;
  if (half !== undefined && stat.size * tokensPerByte > half) {
    return err(
      toolError(
        "TOO_LARGE",
        `File would consume more than half of the model context (~${Math.floor(stat.size * tokensPerByte)} tokens > ${half}). Use offset/limit or grep first.`,
        { meta: { path: resolvedPath, size: stat.size, half } },
      ),
    );
  }

  const mime = ops.mimeType(resolvedPath);
  if (isImageMime(mime) || isPdfMime(mime)) {
    return readAttachment(ops, resolvedPath, mime, stat.size);
  }

  const sample = await readSample(ops, resolvedPath, stat.size);
  if (isBinary(resolvedPath, sample)) {
    return err(
      toolError("BINARY", `Cannot read binary file: ${resolvedPath}`, {
        meta: { path: resolvedPath },
      }),
    );
  }

  return readText(ops, session, resolvedPath, stat, params);
}

async function readSample(
  ops: ReadOperations,
  p: string,
  size: number,
): Promise<Uint8Array> {
  if (size === 0) return new Uint8Array();
  const bytes = await ops.readFile(p);
  return bytes.length > BINARY_SAMPLE_BYTES
    ? bytes.subarray(0, BINARY_SAMPLE_BYTES)
    : bytes;
}

async function readDirectory(
  ops: ReadOperations,
  resolvedPath: string,
  params: ReadParams,
): Promise<DirReadResult> {
  const entries = await ops.readDirectoryEntries(resolvedPath);
  const named = await Promise.all(
    entries.map(async (e) => {
      if (e.type === "directory") return e.name + "/";
      if (e.type !== "symlink") return e.name;
      const target = await ops
        .stat(path.join(resolvedPath, e.name))
        .catch(() => undefined);
      return target?.type === "directory" ? e.name + "/" : e.name;
    }),
  );
  named.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

  const offset = params.offset ?? 1;
  const limit = params.limit ?? DEFAULT_LIMIT;
  const start = offset - 1;
  const sliced = named.slice(start, start + limit);
  const more = start + sliced.length < named.length;

  const output = formatDirectory({
    path: resolvedPath,
    entries: sliced,
    offset,
    totalEntries: named.length,
    more,
  });

  return {
    kind: "directory",
    output,
    meta: {
      path: resolvedPath,
      totalEntries: named.length,
      returnedEntries: sliced.length,
      offset,
      limit,
      more,
    },
  };
}

async function readAttachment(
  ops: ReadOperations,
  resolvedPath: string,
  mime: string,
  size: number,
): Promise<AttachmentReadResult> {
  const bytes = await ops.readFile(resolvedPath);
  const kind: "Image" | "PDF" = mime === "application/pdf" ? "PDF" : "Image";
  const dataUrl = `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
  return {
    kind: "attachment",
    output: formatAttachment(kind),
    attachments: [{ mime, dataUrl }],
    meta: { path: resolvedPath, mime, size_bytes: size },
  };
}

async function readText(
  ops: ReadOperations,
  session: ReadSessionConfig,
  resolvedPath: string,
  stat: { size: number; mtime_ms: number },
  params: ReadParams,
): Promise<ReadResult> {
  const offset = params.offset ?? 1;
  const limit = params.limit ?? session.defaultLimit ?? DEFAULT_LIMIT;

  if (session.cache) {
    const cached = session.cache.get({
      path: resolvedPath,
      mtime_ms: stat.mtime_ms,
      size_bytes: stat.size,
      offset,
      limit,
    });
    if (cached) {
      if (session.ledger) {
        session.ledger.record({
          path: resolvedPath,
          sha256: cached.meta.sha256,
          mtime_ms: stat.mtime_ms,
          size_bytes: stat.size,
          lines_returned: cached.meta.returnedLines,
          offset,
          limit,
          timestamp_ms: Date.now(),
        });
      }
      return cached;
    }
  }

  const lineStreamOpts: {
    offset: number;
    limit: number;
    maxBytes?: number;
    maxLineLength?: number;
    signal?: AbortSignal;
  } = { offset, limit };
  if (session.maxBytes !== undefined) lineStreamOpts.maxBytes = session.maxBytes;
  if (session.maxLineLength !== undefined)
    lineStreamOpts.maxLineLength = session.maxLineLength;
  if (session.signal !== undefined) lineStreamOpts.signal = session.signal;

  const result = await streamLines(ops, resolvedPath, lineStreamOpts);

  if (result.totalLines > 0 && offset > result.totalLines) {
    return err(
      toolError(
        "INVALID_PARAM",
        `Offset ${offset} is out of range for this file (${result.totalLines} lines)`,
        { meta: { path: resolvedPath, totalLines: result.totalLines } },
      ),
    );
  }

  const bytes = await ops.readFile(resolvedPath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  const output = formatText({
    path: resolvedPath,
    offset,
    lines: result.lines,
    totalLines: result.totalLines,
    more: result.more,
    byteCap: result.byteCap,
  });

  const textResult: TextReadResult = {
    kind: "text",
    output,
    meta: {
      path: resolvedPath,
      totalLines: result.totalLines,
      returnedLines: result.lines.length,
      offset,
      limit,
      byteCap: result.byteCap,
      more: result.more,
      sha256,
      mtime_ms: stat.mtime_ms,
      size_bytes: stat.size,
    },
  };

  if (session.cache) {
    session.cache.set(
      {
        path: resolvedPath,
        mtime_ms: stat.mtime_ms,
        size_bytes: stat.size,
        offset,
        limit,
      },
      textResult,
    );
  }

  if (session.ledger) {
    session.ledger.record({
      path: resolvedPath,
      sha256,
      mtime_ms: stat.mtime_ms,
      size_bytes: stat.size,
      lines_returned: result.lines.length,
      offset,
      limit,
      timestamp_ms: Date.now(),
    });
  }

  return textResult;
}
