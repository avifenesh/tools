//! `harness-websearch-cli` — JSON-RPC bridge. Method: websearch.

use harness_core::{PermissionPolicy, ToolError, ToolErrorCode};
use harness_websearch::{
    websearch, EngineBaseUrls, WebSearchPermissionPolicy, WebSearchSessionConfig,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

#[derive(Debug, Deserialize)]
struct Request {
    #[serde(default)]
    id: Value,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Serialize)]
struct Response {
    id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<RpcError>,
}

#[derive(Debug, Serialize)]
struct RpcError {
    code: i32,
    message: String,
}

#[derive(Debug, Deserialize)]
struct Call {
    params: Value,
    session: SessionSpec,
}

#[derive(Debug, Deserialize)]
struct SessionSpec {
    #[serde(default)]
    roots: Vec<String>,
    #[serde(default)]
    sensitive_patterns: Vec<String>,
    #[serde(default)]
    bypass_workspace_guard: bool,
    #[serde(default)]
    unsafe_allow_search_without_hook: bool,
    #[serde(default)]
    searxng_url: Option<String>,
    #[serde(default)]
    brave_api_key: Option<String>,
    #[serde(default)]
    tavily_api_key: Option<String>,
    #[serde(default)]
    disable_mojeek: bool,
    #[serde(default)]
    snippet_cap: Option<usize>,
    #[serde(default)]
    fallback_to_keyless: bool,
    #[serde(default)]
    engine_base_urls: Option<EngineBaseUrlsSpec>,
    #[serde(default)]
    default_headers: Option<HashMap<String, String>>,
    #[serde(default)]
    allow_loopback: bool,
    #[serde(default)]
    allow_private_networks: bool,
    #[serde(default)]
    allow_metadata: bool,
    #[serde(default)]
    search_timeout_ms: Option<u64>,
    #[serde(default)]
    session_backstop_ms: Option<u64>,
    #[serde(default)]
    redact_query_in_hook: bool,
    #[serde(default)]
    session_id: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct EngineBaseUrlsSpec {
    #[serde(default)]
    mojeek: Option<String>,
    #[serde(default)]
    marginalia: Option<String>,
    #[serde(default)]
    wikipedia: Option<String>,
    #[serde(default)]
    brave: Option<String>,
    #[serde(default)]
    tavily: Option<String>,
}

impl From<EngineBaseUrlsSpec> for EngineBaseUrls {
    fn from(s: EngineBaseUrlsSpec) -> Self {
        EngineBaseUrls {
            mojeek: s.mojeek,
            marginalia: s.marginalia,
            wikipedia: s.wikipedia,
            brave: s.brave,
            tavily: s.tavily,
        }
    }
}

impl SessionSpec {
    fn into_session(self) -> WebSearchSessionConfig {
        let mut perms = PermissionPolicy::new(self.roots);
        perms.sensitive_patterns = self.sensitive_patterns;
        perms.bypass_workspace_guard = self.bypass_workspace_guard;
        let ws_perms = WebSearchPermissionPolicy::new(perms)
            .with_unsafe_bypass(self.unsafe_allow_search_without_hook);
        // Zero-config by default: no explicit engine override, so the resolver
        // picks the keyless chain unless a key / searxng_url is provided.
        let mut cfg = WebSearchSessionConfig::auto(ws_perms);
        cfg.searxng_url = self.searxng_url;
        cfg.brave_api_key = self.brave_api_key;
        cfg.tavily_api_key = self.tavily_api_key;
        cfg.disable_mojeek = self.disable_mojeek;
        cfg.snippet_cap = self.snippet_cap;
        cfg.fallback_to_keyless = self.fallback_to_keyless;
        cfg.engine_base_urls = self.engine_base_urls.map(Into::into);
        cfg.default_headers = self.default_headers;
        cfg.allow_loopback = self.allow_loopback;
        cfg.allow_private_networks = self.allow_private_networks;
        cfg.allow_metadata = self.allow_metadata;
        cfg.search_timeout_ms = self.search_timeout_ms;
        cfg.session_backstop_ms = self.session_backstop_ms;
        cfg.redact_query_in_hook = self.redact_query_in_hook;
        cfg.session_id = self.session_id;
        cfg
    }
}

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let stdin = tokio::io::stdin();
    let stdout = tokio::io::stdout();
    let mut reader = BufReader::new(stdin).lines();
    let mut stdout = stdout;

    while let Some(line) = reader.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let resp = handle_line(&line).await;
        let encoded = serde_json::to_string(&resp).unwrap_or_else(|_| {
            r#"{"id":null,"error":{"code":-32603,"message":"serialization failed"}}"#.to_string()
        });
        stdout.write_all(encoded.as_bytes()).await?;
        stdout.write_all(b"\n").await?;
        stdout.flush().await?;
    }
    Ok(())
}

async fn handle_line(line: &str) -> Response {
    let req: Request = match serde_json::from_str(line) {
        Ok(r) => r,
        Err(e) => {
            return Response {
                id: Value::Null,
                result: None,
                error: Some(RpcError {
                    code: -32700,
                    message: format!("parse error: {}", e),
                }),
            };
        }
    };

    let call: Call = match serde_json::from_value(req.params.clone()) {
        Ok(c) => c,
        Err(e) => {
            return Response {
                id: req.id,
                result: Some(tool_error_to_value(ToolError::new(
                    ToolErrorCode::InvalidParam,
                    format!("malformed params: {}", e),
                ))),
                error: None,
            };
        }
    };

    let session = call.session.into_session();

    let result = match req.method.as_str() {
        "websearch" => serde_json::to_value(websearch(call.params, &session).await).ok(),
        other => {
            return Response {
                id: req.id,
                result: None,
                error: Some(RpcError {
                    code: -32601,
                    message: format!("method not found: {}", other),
                }),
            };
        }
    };

    Response {
        id: req.id,
        result,
        error: None,
    }
}

fn tool_error_to_value(e: ToolError) -> Value {
    serde_json::json!({
        "kind": "error",
        "error": e,
    })
}
