export const DEFAULT_TIMEOUT_MS = 30_000;
export const MIN_TIMEOUT_MS = 1_000;
export const SESSION_BACKSTOP_MS = 120_000;

export const DEFAULT_MAX_REDIRECTS = 5;
export const MAX_MAX_REDIRECTS = 10;

export const INLINE_MARKDOWN_CAP = 200 * 1024; // 200 KB
export const INLINE_RAW_CAP = 2 * 1024 * 1024; // 2 MB
export const SPILL_HARD_CAP = 10 * 1024 * 1024; // 10 MB
export const SPILL_HEAD_BYTES = 100 * 1024; // 100 KB head
export const SPILL_TAIL_BYTES = 100 * 1024; // 100 KB tail

export const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const MAX_URL_LENGTH = 2 * 1024; // 2 KB

/**
 * Content-types that pass through as text. Anything else gets rejected
 * with UNSUPPORTED_CONTENT_TYPE and a bash+curl hint.
 */
export const TEXT_PASSTHROUGH_TYPES: readonly string[] = [
  "text/plain",
  "text/html",
  "text/csv",
  "text/markdown",
  "text/xml",
  "text/x-markdown",
  "text/css",
  "text/javascript",
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/xhtml+xml",
  "application/javascript",
  "application/x-javascript",
  "application/rss+xml",
  "application/atom+xml",
  "application/vnd.api+json",
];

/**
 * Content-types that enter the readability + turndown extractor when
 * extract: "markdown" (the default). Other text types pass through raw.
 */
export const HTML_EXTRACTABLE_TYPES: readonly string[] = [
  "text/html",
  "application/xhtml+xml",
];

/**
 * Headers that the tool manages and refuses to let the model override.
 * Setting these from user input breaks either semantics (Host) or framing
 * (Content-Length, Transfer-Encoding, Connection).
 */
export const MANAGED_HEADERS: readonly string[] = [
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "upgrade",
];

/**
 * Default User-Agent. Harnesses can override via session.defaultHeaders.
 * We deliberately identify as an agent tool — sites that want to block
 * bots can do so cleanly rather than being surprised later.
 */
export const DEFAULT_USER_AGENT = "agent-sh-harness-webfetch/0.1.0";
