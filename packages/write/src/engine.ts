import { toolError, type ToolError } from "@agent-sh/harness-core";
import {
  buildMatchLocations,
  findAllOccurrences,
  findFuzzyCandidates,
  substringBoundaryCollisions,
} from "./matching.js";
import { normalizeLineEndings } from "./normalize.js";
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
 *   - normalize CRLF→LF on both haystack and needle
 *   - exact substring search
 *   - 0 matches + fuzzy candidates → OLD_STRING_NOT_FOUND
 *   - ≥2 matches + replace_all false → OLD_STRING_NOT_UNIQUE
 *   - apply; on replace_all, collect substring-boundary warnings
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

  const normalizedContent = normalizeLineEndings(content);
  const normalizedOld = normalizeLineEndings(oldRaw);
  const normalizedNew = normalizeLineEndings(newRaw);

  if (normalizedContent.length === 0) {
    return toolError(
      "EMPTY_FILE",
      "Edit cannot anchor to an empty file. Use Write to create initial content; Edit requires existing text as an anchor.",
    );
  }

  const offsets = findAllOccurrences(normalizedContent, normalizedOld);

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
  const targetOffsets =
    edit.replace_all === true ? offsets : [offsets[0] as number];
  const warnings: string[] = [];

  if (edit.replace_all === true && offsets.length > 1) {
    const flaggedLines = substringBoundaryCollisions(
      normalizedContent,
      normalizedOld,
      offsets,
    );
    if (flaggedLines.length > 0) {
      warnings.push(
        `replace_all pattern "${truncateForWarning(normalizedOld)}" is adjacent to identifier characters at line(s) ${flaggedLines.join(", ")}; verify these replacements did not land inside a larger identifier.`,
      );
    }
  }

  const newContent = replaceAtOffsets(
    normalizedContent,
    normalizedOld,
    normalizedNew,
    targetOffsets,
  );

  return {
    content: newContent,
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

function truncateForWarning(s: string): string {
  const oneLine = s.replace(/\n/g, " ");
  if (oneLine.length <= 40) return oneLine;
  return oneLine.slice(0, 37) + "...";
}
