import type { FuzzyCandidate, MatchLocation } from "./types.js";

export function formatWriteSuccess(opts: {
  path: string;
  created: boolean;
  bytesBefore: number;
  bytesAfter: number;
}): string {
  const { path, created, bytesBefore, bytesAfter } = opts;
  const header = `<path>${path}</path>`;
  const summary = created
    ? `Wrote ${bytesAfter} bytes to ${path}`
    : `Overwrote ${path} (was ${bytesBefore} bytes, now ${bytesAfter} bytes, ${deltaStr(bytesBefore, bytesAfter)})`;
  return `${header}\n<result>\n${summary}\n</result>`;
}

export function formatEditSuccess(opts: {
  path: string;
  replacements: number;
  replaceAll: boolean;
  bytesBefore: number;
  bytesAfter: number;
  warnings?: readonly string[];
}): string {
  const { path, replacements, replaceAll, bytesBefore, bytesAfter } = opts;
  const header = `<path>${path}</path>`;
  const mode = replaceAll ? " (replace_all)" : "";
  const noun = replacements === 1 ? "replacement" : "replacements";
  const lines = [
    `Edited ${path}: ${replacements} ${noun}${mode} (${deltaStr(bytesBefore, bytesAfter)})`,
  ];
  if (opts.warnings && opts.warnings.length > 0) {
    for (const w of opts.warnings) lines.push(`Warning: ${w}`);
  }
  return `${header}\n<result>\n${lines.join("\n")}\n</result>`;
}

export function formatMultiEditSuccess(opts: {
  path: string;
  editsApplied: number;
  totalReplacements: number;
  bytesBefore: number;
  bytesAfter: number;
  warnings?: readonly string[];
}): string {
  const {
    path,
    editsApplied,
    totalReplacements,
    bytesBefore,
    bytesAfter,
  } = opts;
  const header = `<path>${path}</path>`;
  const lines = [
    `MultiEdit ${path}: ${editsApplied} edits applied, ${totalReplacements} total replacements (${deltaStr(bytesBefore, bytesAfter)})`,
  ];
  if (opts.warnings && opts.warnings.length > 0) {
    for (const w of opts.warnings) lines.push(`Warning: ${w}`);
  }
  return `${header}\n<result>\n${lines.join("\n")}\n</result>`;
}

export function formatPreview(opts: {
  path: string;
  diff: string;
  wouldWriteBytes: number;
  bytesBefore: number;
}): string {
  const { path, diff, wouldWriteBytes, bytesBefore } = opts;
  const header = `<path>${path}</path>`;
  return `${header}\n<preview>\n${diff}</preview>\n(would write ${wouldWriteBytes} bytes, ${deltaStr(bytesBefore, wouldWriteBytes)}; no changes applied)`;
}

export function formatMatchLocations(
  matches: readonly MatchLocation[],
): string {
  if (matches.length === 0) return "";
  const blocks = matches.map((m) => {
    const before = m.context.before.map((l) => `  ${l}`).join("\n");
    const after = m.context.after.map((l) => `  ${l}`).join("\n");
    const previewLines = m.preview
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n");
    const parts = [`Line ${m.line}:`];
    if (before) parts.push(before);
    parts.push(previewLines);
    if (after) parts.push(after);
    return parts.join("\n");
  });
  return blocks.join("\n\n");
}

export function formatFuzzyCandidates(
  candidates: readonly FuzzyCandidate[],
): string {
  if (candidates.length === 0) return "";
  const blocks = candidates.map((c) => {
    const before = c.context.before.map((l) => `  ${l}`).join("\n");
    const after = c.context.after.map((l) => `  ${l}`).join("\n");
    const previewLines = c.preview
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n");
    const parts = [`Candidate at line ${c.line} (similarity ${c.score.toFixed(2)}):`];
    if (before) parts.push(before);
    parts.push(previewLines);
    if (after) parts.push(after);
    return parts.join("\n");
  });
  return blocks.join("\n\n");
}

function deltaStr(before: number, after: number): string {
  const delta = after - before;
  if (delta === 0) return "no byte change";
  if (delta > 0) return `+${delta} bytes`;
  return `${delta} bytes`;
}
