use harness_core::{PermissionPolicy, ToolError};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::engine::WebFetchEngine;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum WebFetchMethod {
    Get,
    Post,
}

impl WebFetchMethod {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WebFetchExtract {
    Markdown,
    Raw,
    Both,
}

impl WebFetchExtract {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Markdown => "markdown",
            Self::Raw => "raw",
            Self::Both => "both",
        }
    }
}

/// Session permission policy plus the autonomous escape hatch for tests.
#[derive(Clone)]
pub struct WebFetchPermissionPolicy {
    pub inner: PermissionPolicy,
    pub unsafe_allow_fetch_without_hook: bool,
}

impl WebFetchPermissionPolicy {
    pub fn new(inner: PermissionPolicy) -> Self {
        Self {
            inner,
            unsafe_allow_fetch_without_hook: false,
        }
    }

    pub fn with_unsafe_bypass(mut self, v: bool) -> Self {
        self.unsafe_allow_fetch_without_hook = v;
        self
    }
}

impl std::fmt::Debug for WebFetchPermissionPolicy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WebFetchPermissionPolicy")
            .field(
                "unsafe_allow_fetch_without_hook",
                &self.unsafe_allow_fetch_without_hook,
            )
            .field("inner", &self.inner)
            .finish()
    }
}

pub type WebFetchCache = Arc<Mutex<HashMap<String, CachedResponse>>>;

#[derive(Clone)]
pub struct WebFetchSessionConfig {
    pub permissions: WebFetchPermissionPolicy,
    pub engine: Arc<dyn WebFetchEngine>,
    pub default_headers: Option<HashMap<String, String>>,
    pub allow_loopback: bool,
    pub allow_private_networks: bool,
    pub allow_metadata: bool,
    pub resolve_once: bool,
    pub default_timeout_ms: Option<u64>,
    pub session_backstop_ms: Option<u64>,
    pub max_redirects: Option<u32>,
    pub inline_markdown_cap: Option<usize>,
    pub inline_raw_cap: Option<usize>,
    pub spill_hard_cap: Option<usize>,
    pub cache_ttl_ms: Option<u64>,
    pub spill_dir: Option<String>,
    pub session_id: Option<String>,
    pub cache: Option<WebFetchCache>,
}

impl WebFetchSessionConfig {
    pub fn new(
        permissions: WebFetchPermissionPolicy,
        engine: Arc<dyn WebFetchEngine>,
    ) -> Self {
        Self {
            permissions,
            engine,
            default_headers: None,
            allow_loopback: false,
            allow_private_networks: false,
            allow_metadata: false,
            resolve_once: true,
            default_timeout_ms: None,
            session_backstop_ms: None,
            max_redirects: None,
            inline_markdown_cap: None,
            inline_raw_cap: None,
            spill_hard_cap: None,
            cache_ttl_ms: None,
            spill_dir: None,
            session_id: None,
            cache: None,
        }
    }

    pub fn with_cache(mut self) -> Self {
        self.cache = Some(Arc::new(Mutex::new(HashMap::new())));
        self
    }
}

impl std::fmt::Debug for WebFetchSessionConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WebFetchSessionConfig")
            .field("permissions", &self.permissions)
            .field("allow_loopback", &self.allow_loopback)
            .field("allow_private_networks", &self.allow_private_networks)
            .field("allow_metadata", &self.allow_metadata)
            .field("has_cache", &self.cache.is_some())
            .finish()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedResponse {
    pub at_ms: u64,
    pub status: u16,
    pub final_url: String,
    pub redirect_chain: Vec<String>,
    pub content_type: String,
    pub body: Vec<u8>,
    pub extract: WebFetchExtract,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extracted_markdown: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FetchMetadata {
    pub url: String,
    pub final_url: String,
    pub method: WebFetchMethod,
    pub status: u16,
    pub content_type: String,
    pub redirect_chain: Vec<String>,
    pub fetched_ms: u64,
    pub from_cache: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_age_sec: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebFetchOk {
    pub output: String,
    pub meta: FetchMetadata,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_markdown: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_raw: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_path: Option<String>,
    pub byte_cap: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebFetchRedirectLoop {
    pub output: String,
    pub meta: FetchMetadata,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebFetchHttpError {
    pub output: String,
    pub meta: FetchMetadata,
    pub body_raw: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebFetchError {
    pub error: ToolError,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WebFetchResult {
    #[serde(rename = "ok")]
    Ok(WebFetchOk),
    #[serde(rename = "redirect_loop")]
    RedirectLoop(WebFetchRedirectLoop),
    #[serde(rename = "http_error")]
    HttpError(WebFetchHttpError),
    #[serde(rename = "error")]
    Error(WebFetchError),
}

impl From<WebFetchError> for WebFetchResult {
    fn from(e: WebFetchError) -> Self {
        WebFetchResult::Error(e)
    }
}
