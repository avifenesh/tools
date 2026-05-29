pub const DEFAULT_TIMEOUT_MS: u64 = 15_000;
pub const MIN_TIMEOUT_MS: u64 = 2_000;
pub const SESSION_BACKSTOP_MS: u64 = 30_000;

pub const DEFAULT_COUNT: usize = 5;
pub const MIN_COUNT: usize = 1;
pub const MAX_COUNT: usize = 20;

pub const DEFAULT_LANGUAGE: &str = "auto";
pub const DEFAULT_CATEGORIES: &[&str] = &["general"];

pub const MAX_QUERY_LENGTH: usize = 512;
pub const SNIPPET_CAP: usize = 300; // per-result snippet trim

/// Default User-Agent. Harnesses can override via session.default_headers.
/// We deliberately identify as an agent tool — backends that want to gate
/// bots can do so cleanly rather than being surprised later.
pub const DEFAULT_USER_AGENT: &str = "agent-sh-harness-websearch/0.1.0";
