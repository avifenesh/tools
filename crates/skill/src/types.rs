use async_trait::async_trait;
use harness_core::{PermissionPolicy, ToolError};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Clone)]
pub struct SkillPermissionPolicy {
    pub inner: PermissionPolicy,
    pub unsafe_allow_skill_without_hook: bool,
}

impl SkillPermissionPolicy {
    pub fn new(inner: PermissionPolicy) -> Self {
        Self {
            inner,
            unsafe_allow_skill_without_hook: false,
        }
    }

    pub fn with_unsafe_bypass(mut self, v: bool) -> Self {
        self.unsafe_allow_skill_without_hook = v;
        self
    }
}

impl std::fmt::Debug for SkillPermissionPolicy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SkillPermissionPolicy")
            .field(
                "unsafe_allow_skill_without_hook",
                &self.unsafe_allow_skill_without_hook,
            )
            .field("inner", &self.inner)
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillTrustMode {
    HookRequired,
    Warn,
    Allow,
}

#[derive(Debug, Clone, Default)]
pub struct SkillTrustPolicy {
    pub trusted_roots: Vec<String>,
    pub untrusted_project_skills: Option<SkillTrustMode>,
}

/// Session-tracked activated skill set. Clone-cheap via Arc.
#[derive(Clone, Default)]
pub struct ActivatedSet(pub Arc<Mutex<HashSet<String>>>);

impl ActivatedSet {
    pub fn new() -> Self {
        Self::default()
    }
}

impl std::fmt::Debug for ActivatedSet {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ActivatedSet").finish()
    }
}

/// Input args for `skill(input, session)`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillParams {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arguments: Option<SkillArguments>,
}

/// String-form `$ARGUMENTS` OR object-form `${name}`-substitutable map.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SkillArguments {
    String(String),
    Object(HashMap<String, String>),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillEntry {
    pub name: String,
    pub description: String,
    pub dir: String,
    pub root_index: usize,
    pub frontmatter: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shadowed: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoadedSkill {
    pub name: String,
    pub description: String,
    pub dir: String,
    pub root_index: usize,
    pub frontmatter: serde_json::Value,
    pub body: String,
    pub resources: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shadowed: Option<Vec<String>>,
}

/// Pluggable backend for listing + loading skills. `FilesystemSkillRegistry`
/// is the default; adapters can ship for git / HTTP / DB-backed skills.
#[async_trait]
pub trait SkillRegistry: Send + Sync {
    async fn discover(&self) -> Result<Vec<SkillEntry>, String>;
    async fn load(&self, name: &str) -> Result<Option<LoadedSkill>, String>;
}

#[derive(Clone)]
pub struct SkillSessionConfig {
    pub cwd: String,
    pub permissions: SkillPermissionPolicy,
    pub registry: Arc<dyn SkillRegistry>,
    pub trust: SkillTrustPolicy,
    pub user_initiated: bool,
    pub activated: Option<ActivatedSet>,
}

impl SkillSessionConfig {
    pub fn new(
        cwd: impl Into<String>,
        permissions: SkillPermissionPolicy,
        registry: Arc<dyn SkillRegistry>,
    ) -> Self {
        Self {
            cwd: cwd.into(),
            permissions,
            registry,
            trust: SkillTrustPolicy::default(),
            user_initiated: false,
            activated: None,
        }
    }
}

impl std::fmt::Debug for SkillSessionConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SkillSessionConfig")
            .field("cwd", &self.cwd)
            .field("permissions", &self.permissions)
            .field("user_initiated", &self.user_initiated)
            .field("has_activated", &self.activated.is_some())
            .finish()
    }
}

// ---- Result union ----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillOk {
    pub output: String,
    pub name: String,
    pub dir: String,
    pub body: String,
    pub frontmatter: serde_json::Value,
    pub resources: Vec<String>,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillAlreadyLoaded {
    pub output: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillNotFound {
    pub output: String,
    pub name: String,
    pub siblings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillError {
    pub error: ToolError,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SkillResult {
    #[serde(rename = "ok")]
    Ok(SkillOk),
    #[serde(rename = "already_loaded")]
    AlreadyLoaded(SkillAlreadyLoaded),
    #[serde(rename = "not_found")]
    NotFound(SkillNotFound),
    #[serde(rename = "error")]
    Error(SkillError),
}

impl From<SkillError> for SkillResult {
    fn from(e: SkillError) -> Self {
        SkillResult::Error(e)
    }
}
