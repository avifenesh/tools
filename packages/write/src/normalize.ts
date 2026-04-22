/**
 * Normalize CRLF to LF on a string.
 * Per spec §5.1: CRLF → LF on both sides, nothing else normalized.
 */
export function normalizeLineEndings(input: string): string {
  if (input.length === 0 || input.indexOf("\r") === -1) return input;
  return input.replace(/\r\n/g, "\n");
}
