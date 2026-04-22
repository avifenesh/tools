/**
 * Context the zero-match hint needs to tailor its suggestions.
 */
export interface ZeroMatchContext {
  readonly hasRecursiveMarker: boolean;
  readonly explicitPath: boolean;
}

function zeroMatchHint(pattern: string, ctx: ZeroMatchContext): string {
  const suggestions: string[] = [];
  if (!ctx.hasRecursiveMarker) {
    suggestions.push(
      `add '**/' before the pattern to search recursively (e.g. '**/${pattern}')`,
    );
  }
  suggestions.push(
    "broaden the pattern (e.g. replace '.ts' with '.{ts,tsx,js}')",
  );
  if (ctx.explicitPath) {
    suggestions.push("try a different path, or omit 'path' to search the workspace root");
  } else {
    suggestions.push("try a different path");
  }
  return `(No files matched '${pattern}'. Try: ${suggestions.join("; ")}.)`;
}

export function hasRecursiveMarker(pattern: string): boolean {
  return /\*\*/.test(pattern);
}

/**
 * Suggestions for narrowing an over-broad pattern. Kept as concrete
 * templated examples because weak models pattern-match on the example
 * rather than the abstract rule. The order matters: scope → extension
 * → anchor is the same decision tree a human would walk.
 *
 * explicitPath lets us surface the anchor option only when `path` was
 * defaulted — otherwise we're suggesting something the model already did.
 */
function narrowingSuggestions(pattern: string, explicitPath: boolean): string[] {
  const hasExt = /\.[a-zA-Z0-9]+(?:\}|$)/.test(pattern);
  const out: string[] = [];
  out.push(
    "scope to a subdirectory (e.g. 'src/" +
      (pattern.startsWith("**/") ? pattern.slice(3) : pattern) +
      "')",
  );
  if (!hasExt) {
    out.push("pick a specific file extension (e.g. '**/*.ts' or '**/*.md')");
  } else {
    out.push("tighten the extension set");
  }
  if (!explicitPath) {
    out.push(
      "use the 'path' parameter to anchor the search in a subdirectory",
    );
  }
  return out;
}

export function formatPaths(params: {
  pattern: string;
  paths: readonly string[];
  total: number;
  offset: number;
  headLimit: number;
  more: boolean;
  zeroMatchContext: ZeroMatchContext;
}): string {
  const { pattern, paths, total, offset, more, zeroMatchContext } = params;
  const header = `<pattern>${pattern}</pattern>\n<paths>`;
  if (paths.length === 0) {
    return `${header}\n${zeroMatchHint(pattern, zeroMatchContext)}\n</paths>`;
  }
  const body = paths.join("\n");
  const next = offset + paths.length;
  let hint: string;
  if (!more) {
    hint = `(Found ${total} file(s) matching the pattern.)`;
  } else {
    // Truncated result: lead with narrowing, demote pagination to fallback.
    // Heuristic "likely broader than intended":
    // - total is >= 4× the headLimit (runaway match count), OR
    // - pattern is a bare catch-all: '*', '**', '**/*', '**/**' — these
    //   match anything at any depth and almost always indicate the model
    //   didn't think about what it actually wanted.
    // A specific-extension pattern like '**/*.ts' is NOT broad by this
    // heuristic; the model can still page or narrow by subdirectory.
    const bareCatchAll = /^(\*|\*\*|\*\*\/\*|\*\*\/\*\*)$/.test(pattern);
    const isVeryBroad = bareCatchAll || total >= params.headLimit * 4;
    const narrow = narrowingSuggestions(pattern, zeroMatchContext.explicitPath);
    const showing = `(Showing files ${offset + 1}-${next} of ${total} matching '${pattern}'.`;
    const broadNote = isVeryBroad
      ? " This is likely broader than intended."
      : "";
    const narrowLine = `\nTo narrow: ${narrow.join("; ")}.`;
    const pageLine = `\nTo page through instead, re-call with offset: ${next}.)`;
    hint = showing + broadNote + narrowLine + pageLine;
  }
  return `${header}\n${body}\n\n${hint}\n</paths>`;
}
