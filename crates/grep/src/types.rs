use harness_core::{PermissionPolicy, ToolError};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GrepOutputMode {
    FilesWithMatches,
    Content,
    Count,
}

impl Default for GrepOutputMode {
    fn default() -> Self {
        Self::FilesWithMatches
    }
}

#[derive(Debug, Clone)]
pub struct GrepSessionConfig {
    pub cwd: String,
    pub permissions: PermissionPolicy,
    pub default_head_limit: Option<usize>,
    pub max_bytes: Option<usize>,
    pub max_line_length: Option<usize>,
    pub max_filesize: Option<u64>,
    pub timeout_ms: Option<u64>,
}

impl GrepSessionConfig {
    pub fn new(cwd: impl Into<String>, permissions: PermissionPolicy) -> Self {
        Self {
            cwd: cwd.into(),
            permissions,
            default_head_limit: None,
            max_bytes: None,
            max_line_length: None,
            max_filesize: None,
            timeout_ms: None,
        }
    }
}

/// One matching line from the engine. Mirrors TS `RgMatch`.
#[derive(Debug, Clone)]
pub struct RgMatch {
    pub path: String,
    pub line_number: u64,
    pub text: String,
    pub is_context: bool,
}

/// Per-file count from the engine. Mirrors TS `RgCount`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RgCount {
    pub path: String,
    pub count: u64,
}

// ---- Result union ----

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum GrepResult {
    #[serde(rename = "files_with_matches")]
    FilesWithMatches(FilesMatchResult),
    #[serde(rename = "content")]
    Content(ContentResult),
    #[serde(rename = "count")]
    Count(CountResult),
    #[serde(rename = "error")]
    Error(ErrorResult),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilesMatchResult {
    pub output: String,
    pub paths: Vec<String>,
    pub meta: FilesMatchMeta,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilesMatchMeta {
    pub pattern: String,
    pub total: usize,
    pub returned: usize,
    pub offset: usize,
    pub head_limit: usize,
    pub more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContentResult {
    pub output: String,
    pub meta: ContentMeta,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContentMeta {
    pub pattern: String,
    pub total_matches: usize,
    pub total_files: usize,
    pub returned_matches: usize,
    pub offset: usize,
    pub head_limit: usize,
    pub more: bool,
    pub byte_cap: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CountResult {
    pub output: String,
    pub counts: Vec<RgCount>,
    pub meta: CountMeta,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CountMeta {
    pub pattern: String,
    pub total_files: usize,
    pub returned_files: usize,
    pub offset: usize,
    pub head_limit: usize,
    pub more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorResult {
    pub error: ToolError,
}
