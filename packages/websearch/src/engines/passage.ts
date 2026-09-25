import { MAX_SNIPPET_CAP } from "../constants.js";

/**
 * Query-aware snippet selection for engines that return long page excerpts
 * (Exa highlights, Parallel excerpts). Mirrors the Rust `engines/passage.rs`;
 * both languages must pick the same passage for the same input.
 *
 * The formatter trims every snippet from its start, so a raw excerpt that
 * opens with page chrome ("Keyboard shortcuts", "Toggle navigation") would
 * reach the model as junk. Instead: split the excerpt into lines, drop chrome
 * (very short lines, `...` separators, the page title repeated), pick the line
 * that contains the most distinct query terms (a substantial line beats a
 * short one on a tie, then the earliest wins), and extend it with the
 * following lines up to MAX_SNIPPET_CAP characters. With no query-term hit
 * anywhere, the first substantial line is used.
 *
 * This selects a passage inside ONE result; it does not rescore or reorder
 * results (WS-D19 still rejects home-grown lexical reranking).
 */

/** Lines shorter than this (in code points) are treated as navigation chrome. */
const MIN_LINE_CHARS = 20;
/** Lines at least this long count as substantial content (tie-breaker). */
const SUBSTANTIAL_LINE_CHARS = 40;

const STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "does", "for",
  "from", "how", "in", "is", "it", "of", "on", "or", "the", "to", "vs", "what",
  "when", "where", "which", "who", "why", "with",
]);

/** Code-point length, so Rust `chars().count()` and TS agree. */
function cpLen(s: string): number {
  return Array.from(s).length;
}

export function queryTerms(query: string): string[] {
  const out: string[] = [];
  for (const raw of query.split(/[^\p{Alphabetic}\p{N}]+/u)) {
    const t = raw.toLowerCase();
    if (cpLen(t) < 2 || STOPWORDS.has(t) || out.includes(t)) continue;
    out.push(t);
  }
  return out;
}

function cleanLine(line: string): string {
  return line
    .trim()
    .replace(/^#+/, "")
    .replace(/^[*\-•]+/, "")
    .trim();
}

/**
 * Pick the most query-relevant passage from `text`, at most MAX_SNIPPET_CAP
 * code points, whitespace-collapsed. Lines equal to `title` are skipped.
 */
export function selectPassage(
  text: string,
  query: string,
  title: string,
): string {
  const titleLc = title.trim().toLowerCase();
  const lines = text
    .split(/\r?\n/)
    .map(cleanLine)
    .filter(
      (l) =>
        cpLen(l) >= MIN_LINE_CHARS && l !== "..." && l.toLowerCase() !== titleLc,
    );
  if (lines.length === 0) {
    return truncateCp(collapseWs(text), MAX_SNIPPET_CAP);
  }

  // Rank lines by (distinct query terms, is-substantial); the earliest line
  // wins a full tie.
  const terms = queryTerms(query);
  let best = 0;
  let bestKey = 0;
  lines.forEach((line, i) => {
    const lc = line.toLowerCase();
    const hits = terms.filter((t) => lc.includes(t)).length;
    const key = hits * 2 + (cpLen(line) >= SUBSTANTIAL_LINE_CHARS ? 1 : 0);
    if (key > bestKey) {
      best = i;
      bestKey = key;
    }
  });

  let out = "";
  for (const line of lines.slice(best)) {
    if (cpLen(out) >= MAX_SNIPPET_CAP) break;
    out = out.length === 0 ? line : `${out} ${line}`;
  }
  return truncateCp(collapseWs(out), MAX_SNIPPET_CAP);
}

function collapseWs(s: string): string {
  return s.split(/\s+/).filter((w) => w.length > 0).join(" ");
}

function truncateCp(s: string, max: number): string {
  const cps = Array.from(s);
  return cps.length <= max ? s : cps.slice(0, max).join("");
}
