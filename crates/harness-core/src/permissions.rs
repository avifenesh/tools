use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

/// Hook decision. Mirrors `PermissionDecision` in the TS harness-core.
/// Autonomous tools treat `Ask` as `Deny` at the tool boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionDecision {
    Allow,
    AllowOnce,
    Deny,
    Ask,
}

/// Inputs handed to the permission hook. Shape-compatible with the TS
/// `PermissionQuery` (slightly relaxed: `metadata` is a free-form JSON
/// object since different tools carry different fields).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionQuery {
    pub tool: String,
    pub path: String,
    pub action: String,
    pub always_patterns: Vec<String>,
    #[serde(default)]
    pub metadata: Value,
}

/// Pluggable hook surface. The `dyn` future keeps the trait
/// object-safe so sessions can hold a boxed hook without committing to a
/// specific async runtime in the trait.
pub type PermissionHook = Arc<
    dyn Fn(PermissionQuery) -> Pin<Box<dyn Future<Output = PermissionDecision> + Send>>
        + Send
        + Sync,
>;

/// Session-scoped permission policy. Mirrors `PermissionPolicy` in TS:
/// workspace `roots`, `sensitive_patterns` for deny lists, optional
/// `hook` for allow/deny decisions, and a `bypass_workspace_guard`
/// escape hatch for callers that own their own fence.
#[derive(Clone)]
pub struct PermissionPolicy {
    pub roots: Vec<String>,
    pub sensitive_patterns: Vec<String>,
    pub hook: Option<PermissionHook>,
    pub bypass_workspace_guard: bool,
}

impl PermissionPolicy {
    pub fn new(roots: impl IntoIterator<Item = String>) -> Self {
        Self {
            roots: roots.into_iter().collect(),
            sensitive_patterns: Vec::new(),
            hook: None,
            bypass_workspace_guard: false,
        }
    }

    pub fn with_sensitive_patterns(
        mut self,
        patterns: impl IntoIterator<Item = String>,
    ) -> Self {
        self.sensitive_patterns = patterns.into_iter().collect();
        self
    }
}

impl std::fmt::Debug for PermissionPolicy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PermissionPolicy")
            .field("roots", &self.roots)
            .field("sensitive_patterns", &self.sensitive_patterns)
            .field("has_hook", &self.hook.is_some())
            .field("bypass_workspace_guard", &self.bypass_workspace_guard)
            .finish()
    }
}
