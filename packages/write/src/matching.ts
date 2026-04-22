import {
  CONTEXT_LINES,
  DEFAULT_FUZZY_LENGTH_TOLERANCE,
  DEFAULT_FUZZY_THRESHOLD,
  DEFAULT_FUZZY_TOP_K,
} from "./constants.js";
import { similarity } from "./levenshtein.js";
import type { FuzzyCandidate, MatchLocation } from "./types.js";

/** 1-based line of the offset in the given string. Assumes LF-normalized. */
export function lineOfOffset(text: string, offset: number): number {
  if (offset <= 0) return 1;
  let line = 1;
  const limit = Math.min(offset, text.length);
  for (let i = 0; i < limit; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.split("\n");
}

function contextAround(
  fileLines: readonly string[],
  firstLine1Based: number,
  windowLineCount: number,
): { before: string[]; after: string[] } {
  const firstIdx = firstLine1Based - 1;
  const lastIdx = firstIdx + windowLineCount - 1;
  const beforeStart = Math.max(0, firstIdx - CONTEXT_LINES);
  const beforeEnd = firstIdx;
  const afterStart = lastIdx + 1;
  const afterEnd = Math.min(fileLines.length, lastIdx + 1 + CONTEXT_LINES);
  return {
    before: fileLines.slice(beforeStart, beforeEnd),
    after: fileLines.slice(afterStart, afterEnd),
  };
}

/**
 * Find all exact occurrences of `needle` in `haystack`. Returns start offsets.
 */
export function findAllOccurrences(
  haystack: string,
  needle: string,
): number[] {
  if (needle.length === 0) return [];
  const results: number[] = [];
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    results.push(idx);
    from = idx + needle.length;
  }
  return results;
}

export function buildMatchLocations(
  file: string,
  needle: string,
  offsets: readonly number[],
): MatchLocation[] {
  const fileLines = splitLines(file);
  const needleLineCount = Math.max(1, splitLines(needle).length);
  return offsets.map((off) => {
    const firstLine = lineOfOffset(file, off);
    const ctx = contextAround(fileLines, firstLine, needleLineCount);
    return {
      line: firstLine,
      preview: needle,
      context: ctx,
    };
  });
}

/**
 * Scan the file for windows of length ≈ needle.length that fuzzy-match.
 * Scoring is line-aligned: we slide in line units and compare a window of the
 * same *line count* as the needle, allowing some character-length slack.
 */
export function findFuzzyCandidates(
  file: string,
  needle: string,
  opts: {
    topK?: number;
    threshold?: number;
    lengthTolerance?: number;
  } = {},
): FuzzyCandidate[] {
  if (file.length === 0 || needle.length === 0) return [];
  const topK = opts.topK ?? DEFAULT_FUZZY_TOP_K;
  const threshold = opts.threshold ?? DEFAULT_FUZZY_THRESHOLD;
  const lenTol = opts.lengthTolerance ?? DEFAULT_FUZZY_LENGTH_TOLERANCE;

  const fileLines = splitLines(file);
  const needleLines = splitLines(needle);
  const windowLineCount = Math.max(1, needleLines.length);

  if (fileLines.length < windowLineCount) return [];

  const candidates: Array<{
    line: number;
    score: number;
    windowText: string;
  }> = [];

  for (let i = 0; i + windowLineCount <= fileLines.length; i++) {
    const window = fileLines.slice(i, i + windowLineCount).join("\n");

    const maxLen = Math.max(window.length, needle.length);
    if (maxLen > 0) {
      const delta = Math.abs(window.length - needle.length) / maxLen;
      if (delta > lenTol) continue;
    }

    const score = similarity(window, needle);
    if (score < threshold) continue;
    if (score === 1) continue; // skip exact — caller handles exact separately

    candidates.push({ line: i + 1, score, windowText: window });
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.line - b.line;
  });

  const top = candidates.slice(0, topK);
  return top.map((c) => {
    const ctx = contextAround(fileLines, c.line, windowLineCount);
    return {
      line: c.line,
      score: Math.round(c.score * 100) / 100,
      preview: c.windowText,
      context: ctx,
    };
  });
}

/**
 * Classic substring boundary check: returns true if `old_string` is adjacent
 * to an identifier character at any of the match sites, implying `replace_all`
 * may be stomping on a larger identifier (the `user` vs `username` trap).
 */
export function substringBoundaryCollisions(
  file: string,
  needle: string,
  offsets: readonly number[],
): number[] {
  const flagged: number[] = [];
  const isIdent = (ch: string | undefined): boolean =>
    ch !== undefined && /[A-Za-z0-9_]/.test(ch);
  for (const off of offsets) {
    const before = off > 0 ? file[off - 1] : undefined;
    const after = file[off + needle.length];
    if (isIdent(before) || isIdent(after)) {
      flagged.push(lineOfOffset(file, off));
    }
  }
  return flagged;
}
