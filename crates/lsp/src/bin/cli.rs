//! `harness-lsp-cli` — JSON-RPC bridge. Method: lsp.

use harness_core::{PermissionPolicy, ToolError, ToolErrorCode};
use harness_lsp::{lsp, LspPermissionPolicy, LspSessionConfig, SpawnLspClient};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
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
    cwd: String,
    #[serde(default)]
    roots: Vec<String>,
    #[serde(default)]
    sensitive_patterns: Vec<String>,
    #[serde(default)]
    bypass_workspace_guard: bool,
    #[serde(default)]
    unsafe_allow_lsp_without_hook: bool,
    #[serde(default)]
    manifest: Option<harness_lsp::LspManifest>,
    #[serde(default)]
    manifest_path: Option<String>,
    #[serde(default)]
    default_head_limit: Option<usize>,
    #[serde(default)]
    default_timeout_ms: Option<u64>,
    #[serde(default)]
    session_backstop_ms: Option<u64>,
    #[serde(default)]
    max_hover_markdown_bytes: Option<usize>,
    #[serde(default)]
    max_preview_line_length: Option<usize>,
}

fn client() -> Arc<SpawnLspClient> {
    use std::sync::OnceLock;
    static CLIENT: OnceLock<Arc<SpawnLspClient>> = OnceLock::new();
    CLIENT.get_or_init(|| Arc::new(SpawnLspClient::new())).clone()
}

impl SessionSpec {
    fn into_session(self) -> LspSessionConfig {
        let mut perms = PermissionPolicy::new(self.roots);
        perms.sensitive_patterns = self.sensitive_patterns;
        perms.bypass_workspace_guard = self.bypass_workspace_guard;
        let lsp_perms = LspPermissionPolicy::new(perms)
            .with_unsafe_bypass(self.unsafe_allow_lsp_without_hook);
        let mut cfg = LspSessionConfig::new(self.cwd, lsp_perms, client());
        cfg.manifest = self.manifest;
        cfg.manifest_path = self.manifest_path;
        cfg.default_head_limit = self.default_head_limit;
        cfg.default_timeout_ms = self.default_timeout_ms;
        cfg.session_backstop_ms = self.session_backstop_ms;
        cfg.max_hover_markdown_bytes = self.max_hover_markdown_bytes;
        cfg.max_preview_line_length = self.max_preview_line_length;
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
        "lsp" => serde_json::to_value(lsp(call.params, &session).await).ok(),
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
