//! `harness-write-cli` — JSON-RPC bridge. Methods: write, edit, multiedit, read_record.
//!
//! The harness is expected to wire its own Read ledger. For the
//! engine-swap shim we include a `read_record` RPC that lets the TS
//! side register a read event in the Rust in-process ledger, so that
//! write/edit can pass read-before-edit checks when the e2e harness is
//! using the TS read tool but the Rust write tool.

use harness_core::{PermissionPolicy, ToolError, ToolErrorCode};
use harness_write::{
    edit, multi_edit, write, InMemoryLedger, LedgerEntry, WriteSessionConfig,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::{Arc, OnceLock};
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
    max_file_size: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct ReadRecord {
    path: String,
    sha256: String,
    #[serde(default)]
    mtime_ms: Option<u64>,
    #[serde(default)]
    size_bytes: Option<u64>,
}

fn ledger() -> &'static Arc<InMemoryLedger> {
    static LEDGER: OnceLock<Arc<InMemoryLedger>> = OnceLock::new();
    LEDGER.get_or_init(|| Arc::new(InMemoryLedger::new()))
}

impl SessionSpec {
    fn into_session(self) -> WriteSessionConfig {
        let mut perms = PermissionPolicy::new(self.roots);
        perms.sensitive_patterns = self.sensitive_patterns;
        perms.bypass_workspace_guard = self.bypass_workspace_guard;
        let mut cfg = WriteSessionConfig::new(self.cwd, perms, ledger().clone());
        cfg.max_file_size = self.max_file_size;
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

    if req.method.as_str() == "read_record" {
        let rec: ReadRecord = match serde_json::from_value(req.params.clone()) {
            Ok(r) => r,
            Err(e) => {
                return Response {
                    id: req.id,
                    result: Some(tool_error_to_value(ToolError::new(
                        ToolErrorCode::InvalidParam,
                        format!("malformed read_record: {}", e),
                    ))),
                    error: None,
                };
            }
        };
        use harness_write::Ledger;
        ledger().record(LedgerEntry {
            path: rec.path,
            sha256: rec.sha256,
            mtime_ms: rec.mtime_ms.unwrap_or(0),
            size_bytes: rec.size_bytes.unwrap_or(0),
            timestamp_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
        });
        return Response {
            id: req.id,
            result: Some(serde_json::json!({ "kind": "ok" })),
            error: None,
        };
    }

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
        "write" => serde_json::to_value(write(call.params, &session).await).ok(),
        "edit" => serde_json::to_value(edit(call.params, &session).await).ok(),
        "multiedit" => serde_json::to_value(multi_edit(call.params, &session).await).ok(),
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
