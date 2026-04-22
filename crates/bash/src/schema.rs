use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

use crate::constants::MAX_COMMAND_LENGTH;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BashParams {
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<std::collections::HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BashOutputParams {
    pub job_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since_byte: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head_limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BashKillParams {
    pub job_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signal: Option<String>,
}

#[derive(Debug, Clone, thiserror::Error)]
pub enum BashParseError {
    #[error("{0}")]
    Message(String),
}

fn known_alias_hint(key: &str) -> Option<&'static str> {
    match key {
        "cmd" => Some("unknown parameter 'cmd'. Use 'command' instead."),
        "shell_command" => Some("unknown parameter 'shell_command'. Use 'command' instead."),
        "script" => Some("unknown parameter 'script'. Use 'command' instead."),
        "run" => Some("unknown parameter 'run'. Use 'command' instead."),
        "directory" => Some("unknown parameter 'directory'. Use 'cwd' instead."),
        "dir" => Some("unknown parameter 'dir'. Use 'cwd' instead."),
        "path" => Some("unknown parameter 'path'. Use 'cwd' instead."),
        "working_directory" => Some("unknown parameter 'working_directory'. Use 'cwd' instead."),
        "timeout" => Some(
            "unknown parameter 'timeout'. Use 'timeout_ms' instead (milliseconds, not seconds). For 30s pass timeout_ms: 30000.",
        ),
        "time_limit" => Some("unknown parameter 'time_limit'. Use 'timeout_ms' instead (milliseconds)."),
        "timeout_seconds" => Some("unknown parameter 'timeout_seconds'. Use 'timeout_ms' instead (multiply by 1000)."),
        "env_vars" => Some("unknown parameter 'env_vars'. Use 'env' instead."),
        "environment" => Some("unknown parameter 'environment'. Use 'env' instead."),
        "lang" => Some(
            "unknown parameter 'lang'. Bash runs shell commands; invoke other languages via the command itself (e.g. 'python -c \"...\"', 'node -e \"...\"').",
        ),
        "language" => Some(
            "unknown parameter 'language'. Invoke other languages via the command (e.g. 'python -c \"...\"', 'node -e \"...\"').",
        ),
        "interpreter" => Some(
            "unknown parameter 'interpreter'. Invoke the interpreter inside the command itself (e.g. 'python -c \"...\"').",
        ),
        "runtime" => Some(
            "unknown parameter 'runtime'. Invoke the runtime inside the command itself (e.g. 'node -e \"...\"').",
        ),
        "stdin" => Some(
            "unknown parameter 'stdin'. Interactive stdin is not supported in v1. Pipe data into the command instead (e.g. 'echo \"y\" | npm init').",
        ),
        "input" => Some(
            "unknown parameter 'input'. Interactive input is not supported in v1. Make the command non-interactive with flags like --yes.",
        ),
        "sandbox" => Some("unknown parameter 'sandbox'. Sandboxing is configured on the session, not per-call."),
        "sandbox_mode" => Some("unknown parameter 'sandbox_mode'. Sandboxing is configured on the session, not per-call."),
        "permissions" => Some("unknown parameter 'permissions'. The permission hook is configured on the session."),
        "network" => Some("unknown parameter 'network'. Network access is configured on the session / executor adapter."),
        "network_access" => Some("unknown parameter 'network_access'. Network access is configured on the session / executor adapter."),
        "shell" => Some("unknown parameter 'shell'. Shell binary is configured on the session."),
        "shell_binary" => Some("unknown parameter 'shell_binary'. Shell binary is configured on the session."),
        _ => None,
    }
}

fn canonical_bash_fields() -> HashSet<&'static str> {
    [
        "command",
        "cwd",
        "timeout_ms",
        "description",
        "background",
        "env",
    ]
    .into_iter()
    .collect()
}

pub fn safe_parse_bash_params(input: &Value) -> Result<BashParams, BashParseError> {
    if let Some(obj) = input.as_object() {
        let canonical = canonical_bash_fields();
        let mut alias_hints: Vec<String> = Vec::new();
        let mut unknown: Vec<String> = Vec::new();
        for key in obj.keys() {
            if canonical.contains(key.as_str()) {
                continue;
            }
            if let Some(hint) = known_alias_hint(key.as_str()) {
                alias_hints.push(hint.to_string());
            } else {
                unknown.push(format!("unknown parameter '{}'.", key));
            }
        }
        if !alias_hints.is_empty() || !unknown.is_empty() {
            let mut msgs = alias_hints;
            msgs.extend(unknown);
            return Err(BashParseError::Message(msgs.join("; ")));
        }
    }

    let parsed: BashParams = serde_json::from_value(input.clone())
        .map_err(|e| BashParseError::Message(e.to_string()))?;

    if parsed.command.trim().is_empty() {
        return Err(BashParseError::Message("command is required".to_string()));
    }
    if parsed.command.len() > MAX_COMMAND_LENGTH {
        return Err(BashParseError::Message(format!(
            "command exceeds {} bytes",
            MAX_COMMAND_LENGTH
        )));
    }
    if let Some(ms) = parsed.timeout_ms {
        if ms < 100 {
            return Err(BashParseError::Message(
                "timeout_ms must be >= 100 ms".to_string(),
            ));
        }
    }
    Ok(parsed)
}

pub fn safe_parse_bash_output_params(
    input: &Value,
) -> Result<BashOutputParams, BashParseError> {
    let parsed: BashOutputParams = serde_json::from_value(input.clone())
        .map_err(|e| BashParseError::Message(e.to_string()))?;
    if parsed.job_id.is_empty() {
        return Err(BashParseError::Message("job_id is required".to_string()));
    }
    Ok(parsed)
}

pub fn safe_parse_bash_kill_params(input: &Value) -> Result<BashKillParams, BashParseError> {
    let parsed: BashKillParams = serde_json::from_value(input.clone())
        .map_err(|e| BashParseError::Message(e.to_string()))?;
    if parsed.job_id.is_empty() {
        return Err(BashParseError::Message("job_id is required".to_string()));
    }
    if let Some(ref sig) = parsed.signal {
        if sig != "SIGTERM" && sig != "SIGKILL" {
            return Err(BashParseError::Message(
                "signal must be 'SIGTERM' or 'SIGKILL'".to_string(),
            ));
        }
    }
    Ok(parsed)
}

pub const BASH_TOOL_NAME: &str = "bash";
pub const BASH_TOOL_DESCRIPTION: &str = "Run a single shell command in a bash subprocess. Output is captured and returned with the exit code. See design/bash.md for the full contract.";

pub const BASH_OUTPUT_TOOL_NAME: &str = "bash_output";
pub const BASH_OUTPUT_TOOL_DESCRIPTION: &str = "Poll a backgrounded bash job's output since a given byte offset.";

pub const BASH_KILL_TOOL_NAME: &str = "bash_kill";
pub const BASH_KILL_TOOL_DESCRIPTION: &str = "Send a termination signal to a backgrounded bash job.";
