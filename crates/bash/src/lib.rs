//! Bash tool — Rust port of `@agent-sh/harness-bash`.
//!
//! Conforms to `agent-knowledge/design/bash.md`. Same contract as the
//! TS package: `bash` / `bash_output` / `bash_kill` with a session
//! object, tokio-driven process runner, inactivity + wall-clock
//! timeouts, HeadTailBuffer with spill-to-file, background job map.

mod constants;
mod executor;
mod fence;
mod format;
mod run;
mod schema;
mod types;

pub use constants::*;
pub use executor::{default_executor, BashExecutor, BashRunInput, BashRunResult, BackgroundReadResult};
pub use format::{
    format_background_started_text, format_bash_kill_text,
    format_bash_output_text, format_result_text, format_timeout_text,
    HeadTailBuffer,
};
pub use schema::{
    safe_parse_bash_kill_params, safe_parse_bash_output_params,
    safe_parse_bash_params, BashKillParams, BashOutputParams, BashParams,
    BashParseError, BASH_KILL_TOOL_DESCRIPTION, BASH_KILL_TOOL_NAME,
    BASH_OUTPUT_TOOL_DESCRIPTION, BASH_OUTPUT_TOOL_NAME, BASH_TOOL_DESCRIPTION,
    BASH_TOOL_NAME,
};
pub use types::{
    BashBackgroundStarted, BashError, BashKillResult, BashNonzeroExit, BashOk,
    BashOutputResult, BashPermissionPolicy, BashResult, BashSessionConfig,
    BashTimeout, TimeoutReason,
};

pub async fn bash(
    params: serde_json::Value,
    session: &BashSessionConfig,
) -> BashResult {
    run::bash_run(params, session).await
}

pub async fn bash_output(
    params: serde_json::Value,
    session: &BashSessionConfig,
) -> BashOutputResult {
    run::bash_output_run(params, session).await
}

pub async fn bash_kill(
    params: serde_json::Value,
    session: &BashSessionConfig,
) -> BashKillResult {
    run::bash_kill_run(params, session).await
}

/// Expose `applyCwdCarry` equivalent for harnesses that want to mutate
/// logical cwd after a successful `cd` command. Same contract as the TS
/// `applyCwdCarry` — returns whether the cwd changed and whether the
/// attempt escaped the workspace.
pub use run::{apply_cwd_carry, detect_top_level_cd, CwdCarryOutcome};
