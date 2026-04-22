use harness_core::{PermissionPolicy, ToolError};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone)]
pub struct GlobSessionConfig {
    pub cwd: String,
    pub permissions: PermissionPolicy,
    pub default_head_limit: Option<usize>,
    pub max_bytes: Option<usize>,
    pub max_filesize: Option<u64>,
    pub max_paths_scanned: Option<usize>,
    pub timeout_ms: Option<u64>,
}

impl GlobSessionConfig {
    pub fn new(cwd: impl Into<String>, permissions: PermissionPolicy) -> Self {
        Self {
            cwd: cwd.into(),
            permissions,
            default_head_limit: None,
            max_bytes: None,
            max_filesize: None,
            max_paths_scanned: None,
            timeout_ms: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GlobPathsMeta {
    pub pattern: String,
    pub total: usize,
    pub returned: usize,
    pub offset: usize,
    pub head_limit: usize,
    pub more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GlobPathsResult {
    pub output: String,
    pub paths: Vec<String>,
    pub meta: GlobPathsMeta,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorResult {
    pub error: ToolError,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum GlobResult {
    #[serde(rename = "paths")]
    Paths(GlobPathsResult),
    #[serde(rename = "error")]
    Error(ErrorResult),
}
