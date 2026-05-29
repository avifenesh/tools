use harness_core::{PermissionPolicy, ToolError};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

use crate::engine::WebSearchEngine;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WebSearchTimeRange {
    Day,
    Week,
    Month,
    Year,
    All,
}

impl WebSearchTimeRange {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Day => "day",
            Self::Week => "week",
            Self::Month => "month",
            Self::Year => "year",
            Self::All => "all",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SafeSearch {
    Off,
    Moderate,
    Strict,
}

impl SafeSearch {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Moderate => "moderate",
            Self::Strict => "strict",
        }
    }

    /// SearXNG's numeric safesearch param: off→0, moderate→1, strict→2.
    pub fn to_numeric(self) -> u8 {
        match self {
            Self::Off => 0,
            Self::Moderate => 1,
            Self::Strict => 2,
        }
    }
}

/// Session permission policy plus the autonomous escape hatch for tests.
#[derive(Clone)]
pub struct WebSearchPermissionPolicy {
    pub inner: PermissionPolicy,
    pub unsafe_allow_search_without_hook: bool,
}

impl WebSearchPermissionPolicy {
    pub fn new(inner: PermissionPolicy) -> Self {
        Self {
            inner,
            unsafe_allow_search_without_hook: false,
        }
    }

    pub fn with_unsafe_bypass(mut self, v: bool) -> Self {
        self.unsafe_allow_search_without_hook = v;
        self
    }
}

impl std::fmt::Debug for WebSearchPermissionPolicy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WebSearchPermissionPolicy")
            .field(
                "unsafe_allow_search_without_hook",
                &self.unsafe_allow_search_without_hook,
            )
            .field("inner", &self.inner)
            .finish()
    }
}

#[derive(Clone)]
pub struct WebSearchSessionConfig {
    pub permissions: WebSearchPermissionPolicy,
    pub engine: Arc<dyn WebSearchEngine>,
    /// Base URL of the self-hosted SearXNG instance, e.g. http://127.0.0.1:8888
    pub searxng_url: Option<String>,
    pub default_headers: Option<HashMap<String, String>>,
    pub allow_loopback: bool,
    pub allow_private_networks: bool,
    pub allow_metadata: bool,
    pub resolve_once: bool,
    pub search_timeout_ms: Option<u64>,
    pub session_backstop_ms: Option<u64>,
    /// Log only the query length in the permission hook, not the query text.
    pub redact_query_in_hook: bool,
    pub session_id: Option<String>,
}

impl WebSearchSessionConfig {
    pub fn new(
        permissions: WebSearchPermissionPolicy,
        engine: Arc<dyn WebSearchEngine>,
    ) -> Self {
        Self {
            permissions,
            engine,
            searxng_url: None,
            default_headers: None,
            allow_loopback: false,
            allow_private_networks: false,
            allow_metadata: false,
            resolve_once: true,
            search_timeout_ms: None,
            session_backstop_ms: None,
            redact_query_in_hook: false,
            session_id: None,
        }
    }

    pub fn with_searxng_url(mut self, url: impl Into<String>) -> Self {
        self.searxng_url = Some(url.into());
        self
    }
}

impl std::fmt::Debug for WebSearchSessionConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WebSearchSessionConfig")
            .field("permissions", &self.permissions)
            .field("searxng_url", &self.searxng_url)
            .field("allow_loopback", &self.allow_loopback)
            .field("allow_private_networks", &self.allow_private_networks)
            .field("allow_metadata", &self.allow_metadata)
            .finish()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebSearchResultItem {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchMetadata {
    pub query: String,
    pub backend_host: String,
    pub count: usize,
    pub time_range: WebSearchTimeRange,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebSearchOk {
    pub output: String,
    pub meta: SearchMetadata,
    pub results: Vec<WebSearchResultItem>,
    pub requested: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebSearchEmpty {
    pub output: String,
    pub meta: SearchMetadata,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebSearchError {
    pub error: ToolError,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WebSearchResult {
    #[serde(rename = "ok")]
    Ok(WebSearchOk),
    #[serde(rename = "empty")]
    Empty(WebSearchEmpty),
    #[serde(rename = "error")]
    Error(WebSearchError),
}

impl From<WebSearchError> for WebSearchResult {
    fn from(e: WebSearchError) -> Self {
        WebSearchResult::Error(e)
    }
}
