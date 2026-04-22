//! `harness-skill-cli` — JSON-RPC bridge. Method: skill.

use harness_core::{PermissionPolicy, ToolError, ToolErrorCode};
use harness_skill::types::{
    ActivatedSet, SkillPermissionPolicy, SkillSessionConfig, SkillTrustMode, SkillTrustPolicy,
};
use harness_skill::{skill, FilesystemSkillRegistry};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use std::sync::Mutex as StdMutex;

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
    unsafe_allow_skill_without_hook: bool,
    #[serde(default)]
    skill_roots: Vec<String>,
    #[serde(default)]
    trusted_roots: Vec<String>,
    #[serde(default)]
    untrusted_project_skills: Option<SkillTrustMode>,
    #[serde(default)]
    user_initiated: bool,
}

// Persistent activation set keyed by a serialized session fingerprint.
// The e2e harness spawns one CLI process per session, so a process-wide
// singleton is fine. For tests that share sessions we use the cwd as key.
fn global_activated(key: &str) -> ActivatedSet {
    use std::collections::HashMap;
    use std::sync::OnceLock;
    static MAP: OnceLock<StdMutex<HashMap<String, ActivatedSet>>> = OnceLock::new();
    let map = MAP.get_or_init(|| StdMutex::new(HashMap::new()));
    let mut guard = map.lock().unwrap();
    guard
        .entry(key.to_string())
        .or_insert_with(ActivatedSet::new)
        .clone()
}

impl SessionSpec {
    fn into_session(self) -> SkillSessionConfig {
        let mut perms = PermissionPolicy::new(self.roots);
        perms.sensitive_patterns = self.sensitive_patterns;
        perms.bypass_workspace_guard = self.bypass_workspace_guard;
        let skill_perms = SkillPermissionPolicy::new(perms)
            .with_unsafe_bypass(self.unsafe_allow_skill_without_hook);
        let registry_roots = if self.skill_roots.is_empty() {
            vec![format!("{}/.skills", self.cwd)]
        } else {
            self.skill_roots.clone()
        };
        let registry = Arc::new(FilesystemSkillRegistry::new(registry_roots));
        let mut cfg = SkillSessionConfig::new(self.cwd.clone(), skill_perms, registry);
        cfg.trust = SkillTrustPolicy {
            trusted_roots: self.trusted_roots,
            untrusted_project_skills: self.untrusted_project_skills,
        };
        cfg.user_initiated = self.user_initiated;
        cfg.activated = Some(global_activated(&self.cwd));
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
        "skill" => serde_json::to_value(skill(call.params, &session).await).ok(),
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
