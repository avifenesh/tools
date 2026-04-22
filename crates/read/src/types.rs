use harness_core::{PermissionPolicy, ToolError};
use serde::{Deserialize, Serialize};

#[derive(Clone)]
pub struct ReadSessionConfig {
    pub cwd: String,
    pub permissions: PermissionPolicy,
    pub model_context_tokens: Option<u64>,
    pub tokens_per_byte: Option<f64>,
    pub max_file_size: Option<u64>,
    pub max_bytes: Option<usize>,
    pub default_limit: Option<usize>,
    pub max_line_length: Option<usize>,
}

impl ReadSessionConfig {
    pub fn new(cwd: impl Into<String>, permissions: PermissionPolicy) -> Self {
        Self {
            cwd: cwd.into(),
            permissions,
            model_context_tokens: None,
            tokens_per_byte: None,
            max_file_size: None,
            max_bytes: None,
            default_limit: None,
            max_line_length: None,
        }
    }
}

impl std::fmt::Debug for ReadSessionConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ReadSessionConfig")
            .field("cwd", &self.cwd)
            .field("permissions", &self.permissions)
            .finish()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextMeta {
    pub path: String,
    pub total_lines: usize,
    pub returned_lines: usize,
    pub offset: usize,
    pub limit: usize,
    pub byte_cap: bool,
    pub more: bool,
    pub sha256: String,
    pub mtime_ms: u64,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirMeta {
    pub path: String,
    pub total_entries: usize,
    pub returned_entries: usize,
    pub offset: usize,
    pub limit: usize,
    pub more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachmentMeta {
    pub path: String,
    pub mime: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Attachment {
    pub mime: String,
    pub data_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextReadResult {
    pub output: String,
    pub meta: TextMeta,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirReadResult {
    pub output: String,
    pub meta: DirMeta,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachmentReadResult {
    pub output: String,
    pub attachments: Vec<Attachment>,
    pub meta: AttachmentMeta,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorReadResult {
    pub error: ToolError,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ReadResult {
    #[serde(rename = "text")]
    Text(TextReadResult),
    #[serde(rename = "directory")]
    Directory(DirReadResult),
    #[serde(rename = "attachment")]
    Attachment(AttachmentReadResult),
    #[serde(rename = "error")]
    Error(ErrorReadResult),
}

impl From<ErrorReadResult> for ReadResult {
    fn from(e: ErrorReadResult) -> Self {
        ReadResult::Error(e)
    }
}
