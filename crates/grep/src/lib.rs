//! Grep tool — Rust port of `@agent-sh/harness-grep`.
//!
//! Conforms to `agent-knowledge/design/grep.md` (language-neutral spec).
//! Public surface mirrors the TS package: `grep(params, session)`
//! returns a discriminated `GrepResult` union. Alias pushback, zero-match
//! hint, `NOT_FOUND` with fuzzy siblings, `INVALID_REGEX` with escape
//! hint — all carry over.
//!
//! Engine: BurntSushi/ripgrep's library form (`grep-searcher` + `grep-regex`)
//! and `ignore` for .gitignore-aware file walking. No WASM, no shell-out.

mod constants;
mod engine;
mod fence;
mod format;
mod schema;
mod suggest;
mod types;

pub use constants::*;
pub use engine::{default_engine, GrepEngine, GrepEngineInput};
pub use format::{format_content, format_count, format_files_with_matches};
pub use schema::{
    parse_grep_params, safe_parse_grep_params, GrepParams, GrepParseError,
    GREP_TOOL_DESCRIPTION, GREP_TOOL_NAME,
};
pub use suggest::suggest_siblings;
pub use types::{
    ContentMeta, ContentResult, CountMeta, CountResult, ErrorResult,
    FilesMatchMeta, FilesMatchResult, GrepOutputMode, GrepResult,
    GrepSessionConfig, RgCount, RgMatch,
};

/// Top-level entry point. Parse + fence + engine + format, returning a
/// discriminated result shape. This is the `grep()` function from the TS
/// package, same contract.
pub async fn grep(
    params: serde_json::Value,
    session: &GrepSessionConfig,
) -> GrepResult {
    run::run(params, session).await
}

mod run;
