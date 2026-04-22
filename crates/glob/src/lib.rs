//! Glob tool — Rust port of `@agent-sh/harness-glob`.
//!
//! Conforms to `agent-knowledge/design/glob.md` (language-neutral spec).
//! Same two-stage pipeline as the TS version: `ignore` walker for
//! gitignore-respecting enumeration, then in-process `globset` match
//! with bash-glob semantics.

mod constants;
mod engine;
mod fence;
mod format;
mod run;
mod schema;
mod suggest;
mod types;

pub use constants::*;
pub use engine::{default_engine, GlobEngine, GlobEngineInput};
pub use format::{format_paths, has_recursive_marker};
pub use schema::{
    safe_parse_glob_params, GlobParams, GlobParseError, GLOB_TOOL_DESCRIPTION,
    GLOB_TOOL_NAME,
};
pub use suggest::suggest_siblings;
pub use types::{
    ErrorResult, GlobPathsMeta, GlobPathsResult, GlobResult, GlobSessionConfig,
};

pub async fn glob(
    params: serde_json::Value,
    session: &GlobSessionConfig,
) -> GlobResult {
    run::run(params, session).await
}
