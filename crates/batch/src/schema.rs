use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Targets for batch operations. Uses `kind`-based tagging to match
/// the Node schema shape: `{ kind: "subdirs", path: "..." }`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum BatchTarget {
    /// Run the command in each immediate subdirectory of the given path.
    Subdirs {
        /// Root directory to scan for subdirectories.
        path: String,
        /// Optional glob filter for subdirectory names (e.g., "*.git").
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name_filter: Option<String>,
    },
    /// Run the command in each path matching the glob.
    Glob {
        /// Glob pattern (e.g., "~/projects/**/*.git").
        pattern: String,
    },
    /// Run the command in each explicitly listed path.
    Explicit {
        paths: Vec<String>,
    },
}

/// How to execute the batch command.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum BatchMode {
    /// Run sequentially, accumulating results.
    #[default]
    Sequential,
    /// Run in parallel (max_concurrent controls concurrency).
    Parallel,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchParams {
    /// Shell command to run in each target directory. Use `$TARGET` to
    /// reference the current directory path.
    pub command: String,
    /// What directories/paths to operate on.
    pub targets: BatchTarget,
    /// Execution mode.
    #[serde(default)]
    pub mode: BatchMode,
    /// Maximum concurrent commands for parallel mode (default 4).
    #[serde(default = "default_max_concurrent", alias = "max_concurrent")]
    pub max_concurrent: usize,
    /// Timeout per command in seconds (default 120).
    #[serde(default = "default_timeout_secs", alias = "timeout_secs")]
    pub timeout_secs: u64,
    /// If true, stop on first failure.
    #[serde(default, alias = "fail_fast")]
    pub fail_fast: bool,
    /// If true, return only a summary (not full per-target output).
    #[serde(default, alias = "summary_only")]
    pub summary_only: bool,
}

fn default_max_concurrent() -> usize {
    4
}

fn default_timeout_secs() -> u64 {
    120
}

#[derive(Debug, Clone, thiserror::Error)]
pub enum BatchParseError {
    #[error("{0}")]
    Message(String),
}

pub fn safe_parse_batch_params(input: &Value) -> Result<BatchParams, BatchParseError> {
    let parsed: BatchParams = serde_json::from_value(input.clone())
        .map_err(|e| BatchParseError::Message(e.to_string()))?;
    if parsed.command.is_empty() {
        return Err(BatchParseError::Message(
            "command must not be empty".to_string(),
        ));
    }
    Ok(parsed)
}
