/**
 * Engine-internal error class. The orchestrator catches and translates
 * these into tool errors; keeping them inside the engine layer means the
 * engine interface returns a plain Promise<WebSearchEngineResult> without
 * a union return shape.
 *
 * `SSRF_BLOCKED` is raised by an engine's `checkHost` callback when a
 * resolved backend host falls into a blocked IP range. The orchestrator
 * maps it straight onto the public `SSRF_BLOCKED` tool-error code, and the
 * FallbackEngine treats it as a per-engine failure (skip + continue) so a
 * single blocked keyless host doesn't sink the whole search.
 */
export type SearchErrorCode =
  | "INVALID_PARAM"
  | "SSRF_BLOCKED"
  | "SERVER_NOT_AVAILABLE"
  | "DNS_ERROR"
  | "TLS_ERROR"
  | "TIMEOUT"
  | "CONNECTION_RESET"
  | "IO_ERROR";

export class SearchError extends Error {
  constructor(
    public readonly code: SearchErrorCode,
    message: string,
    public readonly meta?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "SearchError";
  }
}
