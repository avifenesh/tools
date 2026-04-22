use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WriteParams {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EditParams {
    pub path: String,
    pub old_string: String,
    pub new_string: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replace_all: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EditSpec {
    pub old_string: String,
    pub new_string: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replace_all: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MultiEditParams {
    pub path: String,
    pub edits: Vec<EditSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

#[derive(Debug, Clone, thiserror::Error)]
pub enum WriteParseError {
    #[error("{0}")]
    Message(String),
}

pub fn safe_parse_write_params(input: &Value) -> Result<WriteParams, WriteParseError> {
    let parsed: WriteParams = serde_json::from_value(input.clone())
        .map_err(|e| WriteParseError::Message(e.to_string()))?;
    if parsed.path.is_empty() {
        return Err(WriteParseError::Message("path must not be empty".to_string()));
    }
    Ok(parsed)
}

pub fn safe_parse_edit_params(input: &Value) -> Result<EditParams, WriteParseError> {
    let parsed: EditParams = serde_json::from_value(input.clone())
        .map_err(|e| WriteParseError::Message(e.to_string()))?;
    if parsed.path.is_empty() {
        return Err(WriteParseError::Message("path must not be empty".to_string()));
    }
    if parsed.old_string.is_empty() {
        return Err(WriteParseError::Message(
            "old_string must not be empty".to_string(),
        ));
    }
    Ok(parsed)
}

pub fn safe_parse_multi_edit_params(input: &Value) -> Result<MultiEditParams, WriteParseError> {
    let parsed: MultiEditParams = serde_json::from_value(input.clone())
        .map_err(|e| WriteParseError::Message(e.to_string()))?;
    if parsed.path.is_empty() {
        return Err(WriteParseError::Message("path must not be empty".to_string()));
    }
    if parsed.edits.is_empty() {
        return Err(WriteParseError::Message(
            "edits must contain at least one edit".to_string(),
        ));
    }
    for (i, e) in parsed.edits.iter().enumerate() {
        if e.old_string.is_empty() {
            return Err(WriteParseError::Message(format!(
                "edits[{}].old_string must not be empty",
                i
            )));
        }
    }
    Ok(parsed)
}

pub const WRITE_TOOL_NAME: &str = "write";
pub const EDIT_TOOL_NAME: &str = "edit";
pub const MULTIEDIT_TOOL_NAME: &str = "multiedit";

pub const WRITE_TOOL_DESCRIPTION: &str = "Create a new file, or overwrite an existing file.\n\nUsage:\n- New file (path does not exist): call Write directly. No prior Read is required.\n- Existing file: you must Read it first in this session, or Write fails with NOT_READ_THIS_SESSION.\n- Prefer Edit or MultiEdit for targeted changes to existing files.\n- Write is atomic: bytes land via a temporary file + rename.\n- Path must be absolute. If relative, it resolves against the session cwd.";

pub const EDIT_TOOL_DESCRIPTION: &str = "Replace exactly one occurrence of old_string with new_string in a file.\n\nUsage:\n- The file must have been Read first in this session.\n- old_string must match the file content exactly, character for character, including whitespace and indentation.\n- If old_string appears more than once, the call fails with OLD_STRING_NOT_UNIQUE.\n- If old_string does not match, the call fails with OLD_STRING_NOT_FOUND and returns the top fuzzy candidates.\n- Use dry_run: true to preview the unified diff without writing.\n- CRLF is normalized to LF on both sides.";

pub const MULTIEDIT_TOOL_DESCRIPTION: &str = "Apply a sequence of edits to a single file atomically.\n\nUsage:\n- edits is an ordered list of { old_string, new_string, replace_all? } objects.\n- Edits apply sequentially in memory: later edits see the output of earlier edits.\n- If any edit fails, none of the edits are applied and the file is untouched.\n- The file must have been Read first in this session.\n- Use dry_run: true to preview the final unified diff without writing.";
