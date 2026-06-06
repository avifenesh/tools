import { toolError, type ToolError } from "@agent-sh/harness-core";
import {
  buildMatchLocations,
  findAllOccurrences,
  findFuzzyCandidates,
  lineOfOffset,
  mapStrippedOffsetToOriginal,
  stripLineWhitespace,
  substringBoundaryCollisions,
} from "./matching.js";
import { detectEol, normalizeLineEndings, restoreLineEndings } from "./normalize.js";
import {
  formatFuzzyCandidates,
  formatMatchLocations,
} from "./format.js";
import type { EditSpec } from "./types.js";

export interface ApplyResult {
  readonly content: string;
  readonly replacements: number;
  readonly warnings: string[];
}

/**
 * Apply a single edit to `content`. Does not touch disk. Returns either the
 * new content + metadata, or a structured ToolError. Caller is responsible for
 * feeding the result into the next edit when in a MultiEdit pipeline.
 *
 * Matching algorithm is the spec's §5.1:
 *   - detect the file's line-ending style (CRLF vs LF) on the raw content
 *   - normalize CRLF→LF on both haystack and needle
 *   - exact substring search
 *   - 0 matches + fuzzy candidates → OLD_STRING_NOT_FOUND
 *   - ≥2 matches + replace_all false → OLD_STRING_NOT_UNIQUE
 *   - apply; on replace_all, collect substring-boundary warnings
 *   - re-apply the original line-ending style to the returned content so a
 *     CRLF file stays CRLF on disk (matching still happens on LF text)
 */
export function applyEdit(
  content: string,
  edit: EditSpec,
): ApplyResult | ToolError {
  const oldRaw = edit.old_string;
  const newRaw = edit.new_string;

  if (oldRaw === newRaw) {
    return toolError(
      "NO_OP_EDIT",
      "old_string equals new_string (no-op edit). If you intended to verify file state, use Read instead.",
    );
  }

  const originalEol = detectEol(content);
  const normalizedContent = normalizeLineEndings(content);
  const normalizedOld = normalizeLineEndings(oldRaw);
  const normalizedNew = normalizeLineEndings(newRaw);

  if (normalizedContent.length === 0) {
    return toolError(
      "EMPTY_FILE",
      "Edit cannot anchor to an empty file. Use Write to create initial content; Edit requires existing text as an anchor.",
    );
  }

  // When ignore_whitespace is true, strip leading/trailing whitespace from
  // each line for matching, then map offsets back to the original content.
  const ignoreWhitespace = edit.ignore_whitespace === true;
  let searchHaystack = normalizedContent;
  let searchNeedle = normalizedOld;

  if (ignoreWhitespace) {
    searchHaystack = stripLineWhitespace(normalizedContent);
    searchNeedle = stripLineWhitespace(normalizedOld);
  }

  const offsets = findAllOccurrences(searchHaystack, searchNeedle);

  if (offsets.length === 0) {
    const candidates = findFuzzyCandidates(normalizedContent, normalizedOld);
    const candidatesBlock = formatFuzzyCandidates(candidates);
    const message =
      candidatesBlock.length > 0
        ? `old_string was not found in the file.\n\nClosest candidates:\n\n${candidatesBlock}\n\nIf one of these is the intended location, re-emit Edit with old_string taken verbatim from the candidate block above. Otherwise, re-Read the file to confirm the expected text is present.`
        : `old_string was not found in the file, and no fuzzy candidates crossed the similarity threshold. Re-Read the file to confirm the expected text is present.`;
    return toolError("OLD_STRING_NOT_FOUND", message, {
      meta: { candidates },
    });
  }

  if (offsets.length > 1 && edit.replace_all !== true) {
    const locations = buildMatchLocations(
      normalizedContent,
      normalizedOld,
      offsets,
    );
    const locationsBlock = formatMatchLocations(locations);
    const message = `old_string matches ${offsets.length} locations; edit requires exactly one match.\n\n${locationsBlock}\n\nWiden old_string with surrounding context so it matches exactly one location, or pass replace_all: true if you intend to replace every occurrence.`;
    return toolError("OLD_STRING_NOT_UNIQUE", message, {
      meta: { match_count: offsets.length, locations },
    });
  }

  // Apply — all matches if replace_all, else the single match.
  let targetOffsets =
    edit.replace_all === true ? offsets : [offsets[0] as number];

  const warnings: string[] = [];

  if (edit.replace_all === true && offsets.length > 1) {
    const flaggedLines = substringBoundaryCollisions(
      normalizedContent,
      normalizedOld,
      targetOffsets,
    );
    if (flaggedLines.length > 0) {
      warnings.push(
        `replace_all pattern "${truncateForWarning(normalizedOld)}" is adjacent to identifier characters at line(s) ${flaggedLines.join(", ")}; verify these replacements did not land inside a larger identifier.`,
      );
    }
  }

  let newContent: string;
  const needleLines = normalizedOld.split("\n").length;
  if (ignoreWhitespace) {
    const mappedOffsets = targetOffsets.map((off) =>
      mapStrippedOffsetToOriginal(normalizedContent, searchHaystack, off),
    );
    if (needleLines > 1) {
      // Multi-line: find actual match boundaries to preserve surrounding text.
      newContent = replaceMultilineMatchesAtOffsets(
        normalizedContent,
        normalizedNew,
        mappedOffsets,
        normalizedOld,
        needleLines,
      );
    } else {
      // Single-line: find the actual span in the original content using
      // the stripped needle to handle leading/trailing whitespace diffs.
      newContent = replaceAtOffsetsWithSpans(
        normalizedContent,
        normalizedOld,
        normalizedNew,
        mappedOffsets,
        normalizedOld.trim(),
      );
    }
  } else {
    newContent = replaceAtOffsets(
      normalizedContent,
      normalizedOld,
      normalizedNew,
      targetOffsets,
    );
  }

  return {
    content: restoreLineEndings(newContent, originalEol),
    replacements: targetOffsets.length,
    warnings,
  };
}

/**
 * Apply a sequence of edits sequentially. Each edit sees the output of the
 * previous one. Fail-fast: on the first error, return { error, index }.
 */
export interface PipelineSuccess {
  readonly kind: "ok";
  readonly content: string;
  readonly totalReplacements: number;
  readonly warnings: readonly string[];
}

export interface PipelineFailure {
  readonly kind: "err";
  readonly error: ToolError;
  readonly index: number;
}

export function applyPipeline(
  initialContent: string,
  edits: readonly EditSpec[],
): PipelineSuccess | PipelineFailure {
  let content = initialContent;
  let totalReplacements = 0;
  const warnings: string[] = [];

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i] as EditSpec;
    const result = applyEdit(content, edit);
    if ("code" in result) {
      return {
        kind: "err",
        error: toolError(result.code, `edit[${i}]: ${result.message}`, {
          meta: {
            edit_index: i,
            ...(result.meta ?? {}),
          },
        }),
        index: i,
      };
    }
    content = result.content;
    totalReplacements += result.replacements;
    for (const w of result.warnings) {
      warnings.push(`edit[${i}]: ${w}`);
    }
  }

  return {
    kind: "ok",
    content,
    totalReplacements,
    warnings,
  };
}

function replaceAtOffsets(
  haystack: string,
  needle: string,
  replacement: string,
  offsets: readonly number[],
): string {
  if (offsets.length === 0) return haystack;
  const parts: string[] = [];
  let cursor = 0;
  for (const off of offsets) {
    parts.push(haystack.slice(cursor, off));
    parts.push(replacement);
    cursor = off + needle.length;
  }
  parts.push(haystack.slice(cursor));
  return parts.join("");
}

/// Like replaceAtOffsets but finds the actual matched span in the haystack
/// at each offset (needed when ignore_whitespace makes span lengths differ).
/// `strippedNeedle` is the leading+trailing whitespace-stripped version of
/// `needle`, used to locate the match when the original line has different
/// whitespace from the caller's old_string.
function replaceAtOffsetsWithSpans(
  haystack: string,
  needle: string,
  replacement: string,
  offsets: readonly number[],
  strippedNeedle: string,
): string {
  if (offsets.length === 0) return haystack;
  const parts: string[] = [];
  let cursor = 0;
  const lines = haystack.split("\n");
  for (const off of offsets) {
    const lineIdx = lineOfOffset(haystack, off) - 1;
    // Find the needle start within the line only (not the rest of the file).
    const lineStart = lineIdx === 0 ? 0 : lines.slice(0, lineIdx).reduce((s, l) => s + l.length + 1, 0);
    const lineEnd = lineIdx === lines.length - 1
      ? haystack.length
      : lines.slice(0, lineIdx + 1).reduce((s, l) => s + l.length + 1, 0);
    const lineSlice = haystack.slice(lineStart, lineEnd);
    const searchFrom = Math.max(0, cursor - lineStart);
    const needleIdx = lineSlice.indexOf(strippedNeedle, searchFrom);
    if (needleIdx >= 0) {
      const actualStart = lineStart + needleIdx;
      const spanEnd = actualStart + strippedNeedle.length;
      parts.push(haystack.slice(cursor, actualStart));
      parts.push(replacement);
      cursor = spanEnd;
    } else {
      // Fallback: stripped needle not found at this line; use estimated span.
      // (Shouldn't happen in normal flow but guards against corruption.)
      const spanEnd = off + needle.length;
      parts.push(haystack.slice(cursor, off));
      parts.push(replacement);
      cursor = spanEnd;
    }
  }
  parts.push(haystack.slice(cursor));
  return parts.join("");
}

/// Multi-line whitespace-tolerant replacement that preserves surrounding text
/// on the first and last matched lines. For a needle like "old1\nold2" matching
/// inside "prefix old1\nold2 suffix", this replaces only "old1\nold2" and
/// preserves "prefix " and " suffix".
/// `needleText` is the original (whitespace-normalized) needle to find boundaries.
function replaceMultilineMatchesAtOffsets(
  content: string,
  replacement: string,
  offsets: readonly number[],
  needleText: string,
  needleLines: number,
): string {
  if (offsets.length === 0) return content;
  const lines = content.split("\n");
  // Get the stripped first/last lines of the needle for boundary search.
  const needleLinesArr = needleText.split("\n");
  const firstLineTrimmed = needleLinesArr[0]?.trim() ?? "";
  const lastLineTrimmed = needleLinesArr[needleLinesArr.length - 1]?.trim() ?? "";

  const parts: string[] = [];
  let cursor = 0;
  for (const off of offsets) {
    const lineIdx = lineOfOffset(content, off) - 1;
    const endLine = Math.min(lineIdx + needleLines, lines.length);

    // Byte position of the start of the first affected line.
    const lineStart = lineIdx === 0
      ? 0
      : lines.slice(0, lineIdx).reduce((s, l) => s + l.length + 1, 0);
    // Byte position of the start of the line AFTER the last affected line.
    const afterEnd = endLine === lines.length
      ? content.length
      : lines.slice(0, endLine).reduce((s, l) => s + l.length + 1, 0);

    // Search for the actual match start within the first line,
// starting from the cursor-relative position to find the correct occurrence.
    const firstLineContent = lines[lineIdx] ?? "";
    const searchFrom = Math.max(0, cursor - lineStart);
    const matchStartInLine = firstLineContent.indexOf(firstLineTrimmed, searchFrom);
    const actualStart = matchStartInLine >= 0
      ? lineStart + matchStartInLine
      : lineStart;

    // Search for the actual match end within the last line.
    const lastLineIdx = endLine - 1;
    const lastLineStart = lastLineIdx === 0
      ? 0
      : lines.slice(0, lastLineIdx).reduce((s, l) => s + l.length + 1, 0);
    const lastLineContent = lines[lastLineIdx] ?? "";
    const matchEndInLine = lastLineContent.indexOf(lastLineTrimmed);
    const actualEnd = matchEndInLine >= 0
      ? lastLineStart + matchEndInLine + lastLineTrimmed.length
      : afterEnd;

    parts.push(content.slice(cursor, actualStart));
    parts.push(replacement);
    // actualEnd already points past the last matched content;
    // content.slice(cursor) will capture the rest including any separator.
    cursor = actualEnd;
  }
  parts.push(content.slice(cursor));
  return parts.join("");
}

function truncateForWarning(s: string): string {
  const oneLine = s.replace(/\n/g, " ");
  if (oneLine.length <= 40) return oneLine;
  return oneLine.slice(0, 37) + "...";
}
