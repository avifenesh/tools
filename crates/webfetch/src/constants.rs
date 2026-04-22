pub const DEFAULT_TIMEOUT_MS: u64 = 30_000;
pub const MIN_TIMEOUT_MS: u64 = 1_000;
pub const SESSION_BACKSTOP_MS: u64 = 120_000;

pub const DEFAULT_MAX_REDIRECTS: u32 = 5;
pub const MAX_MAX_REDIRECTS: u32 = 10;

pub const INLINE_MARKDOWN_CAP: usize = 200 * 1024; // 200 KB
pub const INLINE_RAW_CAP: usize = 2 * 1024 * 1024; // 2 MB
pub const SPILL_HARD_CAP: usize = 10 * 1024 * 1024; // 10 MB
pub const SPILL_HEAD_BYTES: usize = 100 * 1024;
pub const SPILL_TAIL_BYTES: usize = 100 * 1024;

pub const CACHE_TTL_MS: u64 = 5 * 60 * 1000;
pub const MAX_URL_LENGTH: usize = 2 * 1024;

/// Content-types that pass through as text. Anything else gets rejected
/// with UNSUPPORTED_CONTENT_TYPE and a bash+curl hint.
pub const TEXT_PASSTHROUGH_TYPES: &[&str] = &[
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

pub const HTML_EXTRACTABLE_TYPES: &[&str] = &["text/html", "application/xhtml+xml"];

/// Headers the tool manages; user-supplied copies are silently dropped.
pub const MANAGED_HEADERS: &[&str] = &[
    "host",
    "content-length",
    "transfer-encoding",
    "connection",
    "upgrade",
];

pub const DEFAULT_USER_AGENT: &str = "agent-sh-harness-webfetch/0.1.0";
