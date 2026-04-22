import { toolError, type ToolError } from "@agent-sh/harness-core";
import {
  DEFAULT_HEAD_LIMIT,
  DEFAULT_OFFSET,
  DEFAULT_TIMEOUT_MS,
  GREP_MAX_BYTES,
  GREP_MAX_FILE_SIZE,
  GREP_MAX_LINE_LENGTH,
} from "./constants.js";
import { compileProbe, defaultGrepEngine } from "./engine.js";
import { fenceSearch, resolveOps, resolveSearchPath } from "./fence.js";
import {
  formatContent,
  formatCount,
  formatFilesWithMatches,
} from "./format.js";
import { safeParseGrepParams } from "./schema.js";
import { suggestSiblings } from "./suggest.js";
import type {
  ContentResult,
  CountResult,
  ErrorGrepResult,
  FilesMatchResult,
  GrepEngine,
  GrepEngineInput,
  GrepParams,
  GrepResult,
  GrepSessionConfig,
  RgCount,
  RgMatch,
} from "./types.js";

function err(error: ToolError): ErrorGrepResult {
  return { kind: "error", error };
}

interface NormalizedParams {
  readonly pattern: string;
  readonly rawPath: string | undefined;
  readonly glob: string | undefined;
  readonly type: string | undefined;
  readonly outputMode: "files_with_matches" | "content" | "count";
  readonly caseInsensitive: boolean;
  readonly multiline: boolean;
  readonly contextBefore: number;
  readonly contextAfter: number;
  readonly headLimit: number;
  readonly offset: number;
}

function normalizeParams(p: GrepParams): NormalizedParams | ToolError {
  const outputMode = p.output_mode ?? "files_with_matches";
  const contextBefore = p.context_before ?? p.context ?? 0;
  const contextAfter = p.context_after ?? p.context ?? 0;

  if (outputMode !== "content" && (contextBefore > 0 || contextAfter > 0)) {
    return toolError(
      "INVALID_PARAM",
      "context_before / context_after / context are only valid with output_mode: content",
    );
  }

  return {
    pattern: p.pattern,
    rawPath: p.path,
    glob: p.glob,
    type: p.type,
    outputMode,
    caseInsensitive: p.case_insensitive ?? false,
    multiline: p.multiline ?? false,
    contextBefore,
    contextAfter,
    headLimit: p.head_limit ?? DEFAULT_HEAD_LIMIT,
    offset: p.offset ?? DEFAULT_OFFSET,
  };
}

function engineInput(
  n: NormalizedParams,
  session: GrepSessionConfig,
  root: string,
  signal: AbortSignal,
): GrepEngineInput {
  return {
    pattern: n.pattern,
    root,
    maxColumns: session.maxLineLength ?? GREP_MAX_LINE_LENGTH,
    maxFilesize: session.maxFilesize ?? GREP_MAX_FILE_SIZE,
    signal,
    ...(n.glob !== undefined ? { glob: n.glob } : {}),
    ...(n.type !== undefined ? { type: n.type } : {}),
    ...(n.caseInsensitive ? { caseInsensitive: true } : {}),
    ...(n.multiline ? { multiline: true } : {}),
    ...(n.contextBefore > 0 ? { contextBefore: n.contextBefore } : {}),
    ...(n.contextAfter > 0 ? { contextAfter: n.contextAfter } : {}),
  };
}

/**
 * Compose an AbortSignal that fires if either the session signal aborts or
 * the per-call timeout elapses. Returned `cancel` clears the timer.
 */
function withTimeout(
  session: GrepSessionConfig,
): { signal: AbortSignal; cancel: () => void; timedOut: () => boolean } {
  const ctl = new AbortController();
  let timedOut = false;
  const timeoutMs = session.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const t = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, timeoutMs);
  const outerAbort = () => ctl.abort();
  if (session.signal) {
    if (session.signal.aborted) ctl.abort();
    else session.signal.addEventListener("abort", outerAbort, { once: true });
  }
  return {
    signal: ctl.signal,
    cancel: () => {
      clearTimeout(t);
      if (session.signal) session.signal.removeEventListener("abort", outerAbort);
    },
    timedOut: () => timedOut,
  };
}

export async function grep(
  input: unknown,
  session: GrepSessionConfig,
): Promise<GrepResult> {
  const parsed = safeParseGrepParams(input);
  if (!parsed.ok) {
    const messages = parsed.issues.map((i) => i.message).join("; ");
    return err(toolError("INVALID_PARAM", messages, { cause: parsed.issues }));
  }
  const params = parsed.value;
  const normed = normalizeParams(params);
  if ("code" in normed) return err(normed);

  const ops = resolveOps(session);
  const root = await resolveSearchPath(ops, session.cwd, normed.rawPath);
  const fenceError = await fenceSearch(session, root);
  if (fenceError) return err(fenceError);

  // Verify the path exists. A non-existent search root should be NOT_FOUND
  // with up to 3 fuzzy sibling suggestions so the model can self-correct in
  // one turn rather than get a silent no-results page. Pattern mirrors Read.
  const stat = await ops.stat(root).catch(() => undefined);
  if (!stat) {
    const suggestions = await suggestSiblings(ops, root);
    const msg =
      suggestions.length > 0
        ? `Path does not exist: ${root}\n\nDid you mean one of these?\n${suggestions.join("\n")}`
        : `Path does not exist: ${root}`;
    return err(
      toolError("NOT_FOUND", msg, {
        meta: { path: root, suggestions },
      }),
    );
  }

  const compile = await compileProbe(normed.pattern);
  if (!compile.ok) {
    return err(
      toolError(
        "INVALID_REGEX",
        `${compile.message}\n\nHint: escape literal regex metacharacters (e.g. 'interface\\{\\}' for 'interface{}'), or use a character class. '.' does not match newlines unless multiline: true.`,
        { meta: { pattern: normed.pattern } },
      ),
    );
  }

  const { signal, cancel, timedOut } = withTimeout(session);
  const engine: GrepEngine = session.engine ?? defaultGrepEngine;
  const ei = engineInput(normed, session, root, signal);

  try {
    switch (normed.outputMode) {
      case "files_with_matches":
        return await runFilesMode(normed, engine, ei, timedOut);
      case "count":
        return await runCountMode(normed, engine, ei, timedOut);
      case "content":
        return await runContentMode(normed, engine, ei, session, timedOut);
    }
  } finally {
    cancel();
  }
}

async function runFilesMode(
  n: NormalizedParams,
  engine: GrepEngine,
  ei: GrepEngineInput,
  timedOut: () => boolean,
): Promise<FilesMatchResult | ErrorGrepResult> {
  const seen = new Set<string>();
  const filesByMtime: Array<{ path: string }> = [];
  try {
    for await (const m of engine.search(ei)) {
      if (m.isContext) continue;
      if (seen.has(m.path)) continue;
      seen.add(m.path);
      filesByMtime.push({ path: m.path });
    }
  } catch (e) {
    if (timedOut()) return err(timeoutError(seen.size));
    throw e;
  }
  if (timedOut()) return err(timeoutError(seen.size));

  const sorted = await sortByMtime(filesByMtime.map((x) => x.path));
  const total = sorted.length;
  const start = Math.min(n.offset, total);
  const end = Math.min(start + n.headLimit, total);
  const window = sorted.slice(start, end);
  const more = end < total;
  const output = formatFilesWithMatches({
    pattern: n.pattern,
    paths: window,
    total,
    offset: start,
    headLimit: n.headLimit,
    more,
    zeroMatchContext: {
      caseInsensitive: n.caseInsensitive,
      glob: n.glob,
      type: n.type,
    },
  });
  return {
    kind: "files_with_matches",
    output,
    paths: window,
    meta: {
      pattern: n.pattern,
      total,
      returned: window.length,
      offset: start,
      headLimit: n.headLimit,
      more,
    },
  };
}

async function runCountMode(
  n: NormalizedParams,
  engine: GrepEngine,
  ei: GrepEngineInput,
  timedOut: () => boolean,
): Promise<CountResult | ErrorGrepResult> {
  const counts: RgCount[] = [];
  try {
    for await (const c of engine.count(ei)) counts.push(c);
  } catch (e) {
    if (timedOut()) return err(timeoutError(counts.length));
    throw e;
  }
  if (timedOut()) return err(timeoutError(counts.length));

  const sorted = [...counts].sort((a, b) => a.path.localeCompare(b.path));
  const total = sorted.length;
  const start = Math.min(n.offset, total);
  const end = Math.min(start + n.headLimit, total);
  const window = sorted.slice(start, end);
  const more = end < total;
  const output = formatCount({
    pattern: n.pattern,
    counts: window,
    total,
    offset: start,
    headLimit: n.headLimit,
    more,
    zeroMatchContext: {
      caseInsensitive: n.caseInsensitive,
      glob: n.glob,
      type: n.type,
    },
  });
  return {
    kind: "count",
    output,
    counts: window,
    meta: {
      pattern: n.pattern,
      totalFiles: total,
      returnedFiles: window.length,
      offset: start,
      headLimit: n.headLimit,
      more,
    },
  };
}

async function runContentMode(
  n: NormalizedParams,
  engine: GrepEngine,
  ei: GrepEngineInput,
  session: GrepSessionConfig,
  timedOut: () => boolean,
): Promise<ContentResult | ErrorGrepResult> {
  const matches: RgMatch[] = [];
  try {
    for await (const m of engine.search(ei)) matches.push(m);
  } catch (e) {
    if (timedOut()) return err(timeoutError(matches.length));
    throw e;
  }
  if (timedOut()) return err(timeoutError(matches.length));

  // Group by file; sort files by mtime newest-first; within a file, by line.
  const byFile = new Map<string, RgMatch[]>();
  for (const m of matches) {
    const arr = byFile.get(m.path) ?? [];
    arr.push(m);
    byFile.set(m.path, arr);
  }
  const sortedPaths = await sortByMtime([...byFile.keys()]);
  const flat: RgMatch[] = [];
  for (const p of sortedPaths) {
    const arr = byFile.get(p) ?? [];
    arr.sort((a, b) => a.lineNumber - b.lineNumber);
    for (const m of arr) flat.push(m);
  }

  const totalMatches = flat.length;
  const totalFiles = sortedPaths.length;
  const start = Math.min(n.offset, totalMatches);

  const maxBytes = session.maxBytes ?? GREP_MAX_BYTES;
  const maxLineLength = session.maxLineLength ?? GREP_MAX_LINE_LENGTH;

  // Walk forward from offset until we hit head_limit OR the byte cap.
  let bytes = 0;
  let currentFile = "";
  const window: { path: string; line: number; text: string }[] = [];
  let byteCap = false;

  for (let i = start; i < totalMatches && window.length < n.headLimit; i++) {
    const m = flat[i];
    if (!m) break;
    const truncated =
      m.text.length > maxLineLength
        ? m.text.slice(0, maxLineLength) + "... (line truncated to " +
          maxLineLength + " chars)"
        : m.text;
    // Budget: new-file separator (blank + path line + \n) + indented line.
    const fileBlockBytes =
      m.path !== currentFile
        ? Buffer.byteLength(m.path, "utf8") + (currentFile === "" ? 1 : 2)
        : 0;
    const lineBytes =
      Buffer.byteLength(`  ${m.lineNumber}: ${truncated}`, "utf8") + 1;
    if (bytes + fileBlockBytes + lineBytes > maxBytes && window.length > 0) {
      byteCap = true;
      break;
    }
    bytes += fileBlockBytes + lineBytes;
    currentFile = m.path;
    window.push({ path: m.path, line: m.lineNumber, text: truncated });
  }

  const more = start + window.length < totalMatches;
  const output = formatContent({
    pattern: n.pattern,
    matches: window,
    totalMatches,
    totalFiles,
    offset: start,
    headLimit: n.headLimit,
    more,
    byteCap,
    maxBytes,
    zeroMatchContext: {
      caseInsensitive: n.caseInsensitive,
      glob: n.glob,
      type: n.type,
    },
  });

  return {
    kind: "content",
    output,
    meta: {
      pattern: n.pattern,
      totalMatches,
      totalFiles,
      returnedMatches: window.length,
      offset: start,
      headLimit: n.headLimit,
      more,
      byteCap,
    },
  };
}

function timeoutError(partial: number): ToolError {
  return toolError(
    "TIMEOUT",
    "Grep exceeded the per-call timeout. Narrow the pattern, scope the path, or add a glob/type filter.",
    { meta: { partial_count: partial } },
  );
}

/**
 * Sort paths by mtime descending, with path ascending as the tie-breaker.
 * Paths that fail to stat keep their relative order and sort last.
 */
async function sortByMtime(paths: readonly string[]): Promise<string[]> {
  const fs = await import("node:fs/promises");
  const withTimes = await Promise.all(
    paths.map(async (p) => {
      try {
        const s = await fs.stat(p);
        return { path: p, mtime: s.mtimeMs };
      } catch {
        return { path: p, mtime: -Infinity };
      }
    }),
  );
  withTimes.sort((a, b) => {
    if (a.mtime !== b.mtime) return b.mtime - a.mtime;
    return a.path.localeCompare(b.path);
  });
  return withTimes.map((x) => x.path);
}
