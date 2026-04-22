//! `harness-webfetch-cli` — JSON-RPC bridge. Method: webfetch.

use harness_core::{PermissionPolicy, ToolError, ToolErrorCode};
use harness_webfetch::{
    default_engine, webfetch, WebFetchPermissionPolicy, WebFetchSessionConfig,
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
    unsafe_allow_fetch_without_hook: bool,
    #[serde(default)]
    default_headers: Option<HashMap<String, String>>,
    #[serde(default)]
    allow_loopback: bool,
    #[serde(default)]
    allow_private_networks: bool,
    #[serde(default)]
    allow_metadata: bool,
    #[serde(default)]
    default_timeout_ms: Option<u64>,
    #[serde(default)]
    session_backstop_ms: Option<u64>,
    #[serde(default)]
    max_redirects: Option<u32>,
    #[serde(default)]
    inline_markdown_cap: Option<usize>,
    #[serde(default)]
    inline_raw_cap: Option<usize>,
    #[serde(default)]
    spill_hard_cap: Option<usize>,
    #[serde(default)]
    spill_dir: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
}

impl SessionSpec {
    fn into_session(self) -> WebFetchSessionConfig {
        let mut perms = PermissionPolicy::new(self.roots);
        perms.sensitive_patterns = self.sensitive_patterns;
        perms.bypass_workspace_guard = self.bypass_workspace_guard;
        let bash_perms = WebFetchPermissionPolicy::new(perms)
            .with_unsafe_bypass(self.unsafe_allow_fetch_without_hook);
        let mut cfg = WebFetchSessionConfig::new(bash_perms, default_engine());
        cfg.default_headers = self.default_headers;
        cfg.allow_loopback = self.allow_loopback;
        cfg.allow_private_networks = self.allow_private_networks;
        cfg.allow_metadata = self.allow_metadata;
        cfg.default_timeout_ms = self.default_timeout_ms;
        cfg.session_backstop_ms = self.session_backstop_ms;
        cfg.max_redirects = self.max_redirects;
        cfg.inline_markdown_cap = self.inline_markdown_cap;
        cfg.inline_raw_cap = self.inline_raw_cap;
        cfg.spill_hard_cap = self.spill_hard_cap;
        cfg.spill_dir = self.spill_dir;
        cfg.session_id = self.session_id;
        cfg = cfg.with_cache();
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
        "webfetch" => serde_json::to_value(webfetch(call.params, &session).await).ok(),
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
