import path from "node:path";
import picomatch from "picomatch";
import { toolError, type ToolError } from "@agent-sh/harness-core";
import {
  DEFAULT_HEAD_LIMIT,
  DEFAULT_OFFSET,
  DEFAULT_TIMEOUT_MS,
  GLOB_MAX_BYTES,
  GLOB_MAX_FILE_SIZE,
  GLOB_MAX_PATHS_SCANNED,
} from "./constants.js";
import { defaultGlobEngine } from "./engine.js";
import { fenceGlob, resolveOps, resolveSearchPath } from "./fence.js";
import { formatPaths, hasRecursiveMarker } from "./format.js";
import { safeParseGlobParams } from "./schema.js";
import { suggestSiblings } from "./suggest.js";
import type {
  ErrorGlobResult,
  GlobEngine,
  GlobEngineInput,
  GlobPathsResult,
  GlobParams,
  GlobResult,
  GlobSessionConfig,
} from "./types.js";

function err(error: ToolError): ErrorGlobResult {
  return { kind: "error", error };
}

interface NormalizedParams {
  readonly pattern: string;
  readonly rawPath: string | undefined;
  readonly headLimit: number;
  readonly offset: number;
}

/**
 * Split an absolute-path pattern into (root, relative-pattern). Weak models
 * (observed: gemma family) routinely pass the absolute search root INSIDE
 * the `pattern` field instead of using `path:` — e.g.
 *   { pattern: "/tmp/project/**\/*.tsx" }
 * instead of
 *   { pattern: "**\/*.tsx", path: "/tmp/project" }
 *
 * Our matcher evaluates against paths relative to the search root, so the
 * absolute-prefixed pattern never matches anything. Without a fix the model
 * thrashes (6+ calls), exceeds the G7 budget, and hits workspace fences when
 * it tries to "broaden" by moving up.
 *
 * We silently split here. If `path` was already supplied we trust the model
 * — auto-redirecting would second-guess a correct call. The returned
 * `patternWasSplit` flag lets tests assert this happened.
 */
function splitAbsolutePattern(
  pattern: string,
  existingPath: string | undefined,
): { pattern: string; redirectedPath: string | undefined; wasSplit: boolean } {
  if (existingPath !== undefined) {
    return { pattern, redirectedPath: undefined, wasSplit: false };
  }
  // Only touch absolute patterns — POSIX (`/`) or Windows drive (`C:`).
  const isAbsolute =
    pattern.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(pattern);
  if (!isAbsolute) {
    return { pattern, redirectedPath: undefined, wasSplit: false };
  }
  // Find the first path segment containing a glob wildcard. Everything up
  // to that segment is an absolute directory that belongs in `path:`.
  const segments = pattern.split("/");
  const wildcardIdx = segments.findIndex((seg) => /[*?{[\]]/.test(seg));
  if (wildcardIdx < 0) {
    // No wildcards anywhere — the whole "pattern" is really a path.
    // Let the normal pipeline reject or treat as a direct file match;
    // splitting here would collapse to a zero-segment pattern.
    return { pattern, redirectedPath: undefined, wasSplit: false };
  }
  if (wildcardIdx === 0) {
    // Pattern starts with a wildcard despite starting with '/'. That's
    // unusual shape; leave it alone.
    return { pattern, redirectedPath: undefined, wasSplit: false };
  }
  const prefix = segments.slice(0, wildcardIdx).join("/") || "/";
  const rest = segments.slice(wildcardIdx).join("/");
  return { pattern: rest, redirectedPath: prefix, wasSplit: true };
}

function normalizeParams(p: GlobParams): NormalizedParams {
  const split = splitAbsolutePattern(p.pattern, p.path);
  return {
    pattern: split.pattern,
    rawPath: split.redirectedPath ?? p.path,
    headLimit: p.head_limit ?? DEFAULT_HEAD_LIMIT,
    offset: p.offset ?? DEFAULT_OFFSET,
  };
}

function engineInput(
  _n: NormalizedParams,
  session: GlobSessionConfig,
  root: string,
  signal: AbortSignal,
): GlobEngineInput {
  return {
    root,
    maxFilesize: session.maxFilesize ?? GLOB_MAX_FILE_SIZE,
    signal,
  };
}

// Compile a picomatch matcher for bash-glob semantics against paths
// relative to the search root. Case-insensitive by default (G-D9).
// Matches against the path relative to the search root, not absolute,
// so a model-supplied pattern behaves exactly like it would in bash.
function compileMatcher(pattern: string): (absPath: string, root: string) => boolean {
  // basename: false so bare '*.ts' matches only top-level, not nested.
  // The zero-match hint then steers the model to '**/*.ts' — the forgotten-**
  // failure-mode guardrail. A bare name with no wildcards ('UserService.ts')
  // still resolves via picomatch to an exact-basename match.
  const matcher = picomatch(pattern, {
    nocase: true,
    dot: false,
  });
  return (absPath: string, root: string) => {
    const rel = path.relative(root, absPath);
    if (rel === "" || rel.startsWith("..")) return false;
    return matcher(rel);
  };
}

/**
 * Compose an AbortSignal that fires if either the session signal aborts or
 * the per-call timeout elapses. Returned `cancel` clears the timer.
 */
function withTimeout(session: GlobSessionConfig): {
  signal: AbortSignal;
  cancel: () => void;
  timedOut: () => boolean;
} {
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

export async function glob(
  input: unknown,
  session: GlobSessionConfig,
): Promise<GlobResult> {
  const parsed = safeParseGlobParams(input);
  if (!parsed.ok) {
    const messages = parsed.issues.map((i) => i.message).join("; ");
    return err(toolError("INVALID_PARAM", messages, { cause: parsed.issues }));
  }
  const params = parsed.value;
  const normed = normalizeParams(params);

  const ops = resolveOps(session);
  const root = await resolveSearchPath(ops, session.cwd, normed.rawPath);
  const fenceError = await fenceGlob(session, root);
  if (fenceError) return err(fenceError);

  // Verify the path exists with fuzzy sibling suggestions on miss — mirrors
  // Read and Grep so the model can self-correct typos in one turn.
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

  const { signal, cancel, timedOut } = withTimeout(session);
  const engine: GlobEngine = session.engine ?? defaultGlobEngine;
  const ei = engineInput(normed, session, root, signal);

  try {
    return await runGlob(normed, engine, ei, session, timedOut);
  } finally {
    cancel();
  }
}

async function runGlob(
  n: NormalizedParams,
  engine: GlobEngine,
  ei: GlobEngineInput,
  session: GlobSessionConfig,
  timedOut: () => boolean,
): Promise<GlobPathsResult | ErrorGlobResult> {
  const scanCap = session.maxPathsScanned ?? GLOB_MAX_PATHS_SCANNED;
  const matches = compileMatcher(n.pattern);
  const seen = new Set<string>();
  const all: string[] = [];
  let scanned = 0;
  try {
    for await (const { path: p } of engine.list(ei)) {
      scanned++;
      if (scanned > scanCap) {
        const scopeTail = n.pattern.startsWith("**/")
          ? n.pattern.slice(3)
          : n.pattern;
        const narrow: string[] = [
          `scope with a directory prefix (e.g. 'src/${scopeTail}')`,
          `filter by extension (e.g. '**/*.{ts,tsx}')`,
        ];
        if (n.rawPath === undefined) {
          narrow.push(
            "use the 'path' parameter to anchor in a subdirectory",
          );
        }
        return err(
          toolError(
            "IO_ERROR",
            `Pattern '${n.pattern}' matched too many files (>${scanCap}).\nTry: ${narrow.join("; ")}.`,
            { meta: { pattern: n.pattern, scanCap } },
          ),
        );
      }
      if (seen.has(p)) continue;
      seen.add(p);
      if (matches(p, ei.root)) all.push(p);
    }
  } catch (e) {
    if (timedOut()) return err(timeoutError(all.length));
    throw e;
  }
  if (timedOut()) return err(timeoutError(all.length));

  const sorted = await sortByMtime(all);
  const total = sorted.length;
  const start = Math.min(n.offset, total);

  // Walk forward from offset until head_limit or byte cap.
  const maxBytes = session.maxBytes ?? GLOB_MAX_BYTES;
  const window: string[] = [];
  let bytes = 0;
  for (let i = start; i < total && window.length < n.headLimit; i++) {
    const p = sorted[i];
    if (!p) break;
    const line = Buffer.byteLength(p, "utf8") + 1; // +1 for \n
    if (bytes + line > maxBytes && window.length > 0) break;
    bytes += line;
    window.push(p);
  }

  const end = start + window.length;
  const more = end < total;
  const output = formatPaths({
    pattern: n.pattern,
    paths: window,
    total,
    offset: start,
    headLimit: n.headLimit,
    more,
    zeroMatchContext: {
      hasRecursiveMarker: hasRecursiveMarker(n.pattern),
      explicitPath: n.rawPath !== undefined,
    },
  });

  return {
    kind: "paths",
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

function timeoutError(partial: number): ToolError {
  return toolError(
    "TIMEOUT",
    "Glob exceeded the per-call timeout. Narrow the pattern or scope the path.",
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
