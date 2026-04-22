use harness_core::{PermissionPolicy, ToolError};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

use crate::executor::BashExecutor;

/// Permission policy with the autonomous-mode escape hatch for tests.
#[derive(Clone)]
pub struct BashPermissionPolicy {
    pub inner: PermissionPolicy,
    pub unsafe_allow_bash_without_hook: bool,
}

impl BashPermissionPolicy {
    pub fn new(inner: PermissionPolicy) -> Self {
        Self {
            inner,
            unsafe_allow_bash_without_hook: false,
        }
    }

    pub fn with_unsafe_bypass(mut self, bypass: bool) -> Self {
        self.unsafe_allow_bash_without_hook = bypass;
        self
    }
}

impl std::fmt::Debug for BashPermissionPolicy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BashPermissionPolicy")
            .field("unsafe_allow_bash_without_hook", &self.unsafe_allow_bash_without_hook)
            .field("inner", &self.inner)
            .finish()
    }
}

/// Runtime-tracked mutable cwd for the session. Shared across calls via
/// `Arc<Mutex<_>>`. Mirrors the TS `session.logicalCwd.value`.
#[derive(Debug, Clone)]
pub struct LogicalCwd {
    pub inner: Arc<Mutex<String>>,
}

impl LogicalCwd {
    pub fn new(initial: impl Into<String>) -> Self {
        Self {
            inner: Arc::new(Mutex::new(initial.into())),
        }
    }

    pub fn get(&self) -> String {
        self.inner.lock().unwrap().clone()
    }

    pub fn set(&self, v: impl Into<String>) {
        *self.inner.lock().unwrap() = v.into();
    }
}

#[derive(Clone)]
pub struct BashSessionConfig {
    pub cwd: String,
    pub permissions: BashPermissionPolicy,
    pub env: Option<std::collections::HashMap<String, String>>,
    pub executor: Arc<dyn BashExecutor>,
    pub default_inactivity_timeout_ms: Option<u64>,
    pub wallclock_backstop_ms: Option<u64>,
    pub max_command_length: Option<usize>,
    pub max_output_bytes_inline: Option<usize>,
    pub max_output_bytes_file: Option<usize>,
    pub max_background_jobs: Option<usize>,
    pub logical_cwd: Option<LogicalCwd>,
}

impl BashSessionConfig {
    pub fn new(
        cwd: impl Into<String>,
        permissions: BashPermissionPolicy,
        executor: Arc<dyn BashExecutor>,
    ) -> Self {
        let cwd = cwd.into();
        Self {
            cwd: cwd.clone(),
            permissions,
            env: None,
            executor,
            default_inactivity_timeout_ms: None,
            wallclock_backstop_ms: None,
            max_command_length: None,
            max_output_bytes_inline: None,
            max_output_bytes_file: None,
            max_background_jobs: None,
            logical_cwd: None,
        }
    }

    pub fn with_logical_cwd_carry(mut self) -> Self {
        self.logical_cwd = Some(LogicalCwd::new(self.cwd.clone()));
        self
    }
}

impl std::fmt::Debug for BashSessionConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BashSessionConfig")
            .field("cwd", &self.cwd)
            .field("permissions", &self.permissions)
            .field("has_env", &self.env.is_some())
            .finish()
    }
}

// ---- Result union ----

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TimeoutReason {
    InactivityTimeout,
    WallClockBackstop,
}

impl TimeoutReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::InactivityTimeout => "inactivity timeout",
            Self::WallClockBackstop => "wall-clock backstop",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BashOk {
    pub output: String,
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_path: Option<String>,
    pub byte_cap: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BashNonzeroExit {
    pub output: String,
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_path: Option<String>,
    pub byte_cap: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BashTimeout {
    pub output: String,
    pub stdout: String,
    pub stderr: String,
    pub reason: TimeoutReason,
    pub duration_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BashBackgroundStarted {
    pub output: String,
    pub job_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BashError {
    pub error: ToolError,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BashResult {
    #[serde(rename = "ok")]
    Ok(BashOk),
    #[serde(rename = "nonzero_exit")]
    NonzeroExit(BashNonzeroExit),
    #[serde(rename = "timeout")]
    Timeout(BashTimeout),
    #[serde(rename = "background_started")]
    BackgroundStarted(BashBackgroundStarted),
    #[serde(rename = "error")]
    Error(BashError),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BashOutputResult {
    #[serde(rename = "output")]
    Output {
        output: String,
        running: bool,
        exit_code: Option<i32>,
        stdout: String,
        stderr: String,
        total_bytes_stdout: u64,
        total_bytes_stderr: u64,
        next_since_byte: u64,
    },
    #[serde(rename = "error")]
    Error(BashError),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BashKillResult {
    #[serde(rename = "killed")]
    Killed {
        output: String,
        job_id: String,
        signal: String,
    },
    #[serde(rename = "error")]
    Error(BashError),
}
