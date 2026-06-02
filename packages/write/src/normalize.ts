/**
 * Normalize CRLF to LF on a string.
 * Per spec §5.1: CRLF → LF on both sides, nothing else normalized.
 */
export function normalizeLineEndings(input: string): string {
  if (input.length === 0 || input.indexOf("\r") === -1) return input;
  return input.replace(/\r\n/g, "\n");
}

/** Line-ending style detected on the *unnormalized* file content. */
export type Eol = "crlf" | "lf";

/**
 * Detect the dominant line ending on raw (unnormalized) input. Any CRLF
 * present marks the file as `crlf`; otherwise `lf`. Used so Edit/MultiEdit can
 * re-apply the original style after matching is done on LF-normalized text.
 */
export function detectEol(input: string): Eol {
  return input.indexOf("\r\n") === -1 ? "lf" : "crlf";
}

/**
 * Re-apply the original line-ending style to LF-normalized content. `lf` is
 * assumed CR-free (it came out of the LF-normalized matching pipeline), so for
 * `crlf` we can safely turn every bare LF back into CRLF. For `lf` the content
 * is returned untouched.
 */
export function restoreLineEndings(lf: string, eol: Eol): string {
  if (eol === "lf" || lf.indexOf("\n") === -1) return lf;
  return lf.replace(/\n/g, "\r\n");
}
