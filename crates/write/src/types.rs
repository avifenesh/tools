use harness_core::{PermissionPolicy, ToolError};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::ledger::Ledger;

#[derive(Clone)]
pub struct WriteSessionConfig {
    pub cwd: String,
    pub permissions: PermissionPolicy,
    pub ledger: Arc<dyn Ledger>,
    pub max_file_size: Option<u64>,
}

impl WriteSessionConfig {
    pub fn new(
        cwd: impl Into<String>,
        permissions: PermissionPolicy,
        ledger: Arc<dyn Ledger>,
    ) -> Self {
        Self {
            cwd: cwd.into(),
            permissions,
            ledger,
            max_file_size: None,
        }
    }
}

impl std::fmt::Debug for WriteSessionConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WriteSessionConfig")
            .field("cwd", &self.cwd)
            .field("permissions", &self.permissions)
            .finish()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MatchLocation {
    pub line: usize,
    pub preview: String,
    pub context_before: Vec<String>,
    pub context_after: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FuzzyCandidate {
    pub line: usize,
    pub score: f64,
    pub preview: String,
    pub context_before: Vec<String>,
    pub context_after: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WriteMeta {
    pub path: String,
    pub bytes_written: u64,
    pub sha256: String,
    pub mtime_ms: u64,
    pub created: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditMeta {
    pub path: String,
    pub replacements: usize,
    pub bytes_delta: i64,
    pub sha256: String,
    pub mtime_ms: u64,
    pub previous_sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warnings: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MultiEditMeta {
    pub path: String,
    pub edits_applied: usize,
    pub total_replacements: usize,
    pub bytes_delta: i64,
    pub sha256: String,
    pub mtime_ms: u64,
    pub previous_sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warnings: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreviewMeta {
    pub path: String,
    pub would_write_bytes: u64,
    pub bytes_delta: i64,
    pub previous_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AnyMeta {
    Write(WriteMeta),
    Edit(EditMeta),
    MultiEdit(MultiEditMeta),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextWriteResult {
    pub output: String,
    pub meta: AnyMeta,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreviewResult {
    pub output: String,
    pub diff: String,
    pub meta: PreviewMeta,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorResult {
    pub error: ToolError,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WriteResult {
    #[serde(rename = "text")]
    Text(TextWriteResult),
    #[serde(rename = "error")]
    Error(ErrorResult),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EditResult {
    #[serde(rename = "text")]
    Text(TextWriteResult),
    #[serde(rename = "preview")]
    Preview(PreviewResult),
    #[serde(rename = "error")]
    Error(ErrorResult),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MultiEditResult {
    #[serde(rename = "text")]
    Text(TextWriteResult),
    #[serde(rename = "preview")]
    Preview(PreviewResult),
    #[serde(rename = "error")]
    Error(ErrorResult),
}
