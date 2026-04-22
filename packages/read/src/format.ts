import { MAX_BYTES_LABEL } from "./constants.js";
import type {
  AttachmentReadResult,
  DirReadResult,
  TextReadResult,
} from "./types.js";

export function formatText(
  params: {
    path: string;
    offset: number;
    lines: readonly string[];
    totalLines: number;
    more: boolean;
    byteCap: boolean;
  },
): string {
  const { path, offset, lines, totalLines, more, byteCap } = params;
  const header = `<path>${path}</path>\n<type>file</type>\n<content>`;

  if (lines.length === 0 && totalLines === 0) {
    return `${header}\n(File exists but is empty)\n</content>`;
  }

  const body = lines.map((line, i) => `${offset + i}: ${line}`).join("\n");
  const last = offset + lines.length - 1;
  const next = last + 1;

  let hint: string;
  if (byteCap) {
    const pct = totalLines > 0 ? Math.round((last / totalLines) * 100) : 0;
    const remaining = Math.max(totalLines - last, 0);
    hint = `(Output capped at ${MAX_BYTES_LABEL}. Showing lines ${offset}-${last} of ${totalLines} · ${pct}% covered · ${remaining} lines remaining. Next offset: ${next}.)`;
  } else if (more) {
    const pct = Math.round((last / totalLines) * 100);
    const remaining = Math.max(totalLines - last, 0);
    hint = `(Showing lines ${offset}-${last} of ${totalLines} · ${pct}% covered · ${remaining} lines remaining. Next offset: ${next}.)`;
  } else {
    hint = `(End of file · ${totalLines} lines total)`;
  }

  return `${header}\n${body}\n\n${hint}\n</content>`;
}

export function formatDirectory(params: {
  path: string;
  entries: readonly string[];
  offset: number;
  totalEntries: number;
  more: boolean;
}): string {
  const { path, entries, offset, totalEntries, more } = params;
  const header = `<path>${path}</path>\n<type>directory</type>\n<entries>`;
  const body = entries.join("\n");
  const last = offset + entries.length - 1;
  const next = last + 1;
  const remaining = Math.max(totalEntries - last, 0);
  const hint = more
    ? `(Showing ${entries.length} of ${totalEntries} entries · ${remaining} remaining. Next offset: ${next}.)`
    : `(${totalEntries} entries)`;
  return `${header}\n${body}\n\n${hint}\n</entries>`;
}

export function formatAttachment(kind: "Image" | "PDF"): string {
  return `${kind} read successfully`;
}

export function asTextResult(x: TextReadResult): TextReadResult {
  return x;
}
export function asDirResult(x: DirReadResult): DirReadResult {
  return x;
}
export function asAttachResult(x: AttachmentReadResult): AttachmentReadResult {
  return x;
}
