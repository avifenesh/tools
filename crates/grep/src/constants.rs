//! Tunables that match the TS grep package. Kept here so the e2e
//! parity tests can assert same defaults.

pub const DEFAULT_HEAD_LIMIT: usize = 250;
pub const DEFAULT_OFFSET: usize = 0;
pub const GREP_MAX_LINE_LENGTH: usize = 2000;
pub const GREP_MAX_BYTES: usize = 51_200; // 50 KB
pub const GREP_MAX_FILE_SIZE: u64 = 5 * 1024 * 1024;
pub const DEFAULT_TIMEOUT_MS: u64 = 30_000;
pub const FUZZY_SUGGESTION_LIMIT: usize = 3;
