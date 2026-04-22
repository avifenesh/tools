use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadParams {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, thiserror::Error)]
pub enum ReadParseError {
    #[error("{0}")]
    Message(String),
}

pub fn safe_parse_read_params(input: &Value) -> Result<ReadParams, ReadParseError> {
    let parsed: ReadParams = serde_json::from_value(input.clone())
        .map_err(|e| ReadParseError::Message(e.to_string()))?;
    if parsed.path.is_empty() {
        return Err(ReadParseError::Message("path must not be empty".to_string()));
    }
    if let Some(o) = parsed.offset {
        if o < 1 {
            return Err(ReadParseError::Message("offset must be >= 1".to_string()));
        }
    }
    if let Some(l) = parsed.limit {
        if l < 1 {
            return Err(ReadParseError::Message("limit must be >= 1".to_string()));
        }
    }
    Ok(parsed)
}

pub const READ_TOOL_NAME: &str = "read";
pub const READ_TOOL_DESCRIPTION: &str = "Read a file or directory from the local filesystem.\n\nUsage:\n- The path parameter should be an absolute path. If relative, it resolves against the session working directory.\n- By default, returns up to 2000 lines from the start of the file.\n- The offset parameter is the 1-indexed line number to start from.\n- For later sections, call this tool again with a larger offset.\n- Use the grep tool for content search in large files; glob to locate files by pattern.\n- Contents are returned with each line prefixed by its line number as \"<line>: <content>\".\n- Any line longer than 2000 characters is truncated.\n- Call this tool in parallel when reading multiple files.\n- Avoid tiny repeated slices (under 30 lines). Read a larger window instead.\n- Images and PDFs are returned as file attachments.\n- Binary files are refused; use specialized tools.";
