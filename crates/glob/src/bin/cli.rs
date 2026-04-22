//! `harness-glob-cli` — newline-delimited JSON-RPC bridge.
//!
//! Mirrors harness-grep-cli. method: "glob".

use harness_core::{PermissionPolicy, ToolError, ToolErrorCode};
use harness_glob::{glob, GlobSessionConfig};
use serde::{Deserialize, Serialize};
use serde_json::Value;
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
    default_head_limit: Option<usize>,
    #[serde(default)]
    max_bytes: Option<usize>,
    #[serde(default)]
    max_filesize: Option<u64>,
    #[serde(default)]
    max_paths_scanned: Option<usize>,
    #[serde(default)]
    timeout_ms: Option<u64>,
}

impl SessionSpec {
    fn into_session(self) -> GlobSessionConfig {
        let mut perms = PermissionPolicy::new(self.roots);
        perms.sensitive_patterns = self.sensitive_patterns;
        perms.bypass_workspace_guard = self.bypass_workspace_guard;
        let mut cfg = GlobSessionConfig::new(self.cwd, perms);
        cfg.default_head_limit = self.default_head_limit;
        cfg.max_bytes = self.max_bytes;
        cfg.max_filesize = self.max_filesize;
        cfg.max_paths_scanned = self.max_paths_scanned;
        cfg.timeout_ms = self.timeout_ms;
        cfg
    }
}

#[tokio::main(flavor = "current_thread")]
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

    if req.method != "glob" {
        return Response {
            id: req.id,
            result: None,
            error: Some(RpcError {
                code: -32601,
                message: format!("method not found: {}", req.method),
            }),
        };
    }

    let call: Call = match serde_json::from_value(req.params) {
        Ok(c) => c,
        Err(e) => {
            return Response {
                id: req.id,
                result: Some(
                    serde_json::to_value(harness_glob::GlobResult::Error(
                        harness_glob::ErrorResult {
                            error: ToolError::new(
                                ToolErrorCode::InvalidParam,
                                format!("malformed params: {}", e),
                            ),
                        },
                    ))
                    .unwrap(),
                ),
                error: None,
            };
        }
    };

    let session = call.session.into_session();
    let result = glob(call.params, &session).await;
    Response {
        id: req.id,
        result: Some(serde_json::to_value(result).unwrap_or(Value::Null)),
        error: None,
    }
}
