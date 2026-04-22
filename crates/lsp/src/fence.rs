use harness_core::{PermissionDecision, ToolError, ToolErrorCode};
use harness_core::permissions::PermissionQuery;
use std::path::Path;

use crate::types::{LspOperation, LspSessionConfig};

pub fn fence_lsp(session: &LspSessionConfig, resolved: Option<&Path>) -> Option<ToolError> {
    let Some(resolved) = resolved else {
        return None; // workspaceSymbol
    };
    let perms = &session.permissions.inner;
    let path_str = resolved.to_string_lossy();

    let is_sensitive = perms
        .sensitive_patterns
        .iter()
        .any(|p| matches_pattern(&path_str, p));
    if is_sensitive && perms.hook.is_none() {
        return Some(
            ToolError::new(
                ToolErrorCode::Sensitive,
                format!("Refusing to query sensitive path: {}", path_str),
            )
            .with_meta(serde_json::json!({ "path": path_str })),
        );
    }

    let inside = perms.roots.iter().any(|root| is_inside(&path_str, root));
    if !inside && !perms.bypass_workspace_guard && perms.hook.is_none() {
        return Some(
            ToolError::new(
                ToolErrorCode::OutsideWorkspace,
                format!(
                    "Path is outside all configured workspace roots: {}",
                    path_str
                ),
            )
            .with_meta(
                serde_json::json!({ "path": path_str, "roots": perms.roots }),
            ),
        );
    }
    None
}

pub struct AskArgs<'a> {
    pub operation: LspOperation,
    pub path: Option<&'a str>,
    pub language: Option<&'a str>,
    pub line: Option<u32>,
    pub character: Option<u32>,
    pub query: Option<&'a str>,
}

pub enum PermissionOutcome {
    Allow,
    Deny { reason: String },
}

pub async fn ask_permission(
    session: &LspSessionConfig,
    args: AskArgs<'_>,
) -> PermissionOutcome {
    let perms = &session.permissions.inner;
    let pattern = format!("Lsp({}:*)", args.operation.as_str());

    if perms.hook.is_none() {
        if session.permissions.unsafe_allow_lsp_without_hook {
            return PermissionOutcome::Allow;
        }
        return PermissionOutcome::Deny {
            reason: "lsp tool has no permission hook configured; refusing to spawn language servers against untrusted code. Wire a hook or set permissions.unsafe_allow_lsp_without_hook for test fixtures.".to_string(),
        };
    }

    let metadata = serde_json::json!({
        "operation": args.operation.as_str(),
        "language": args.language,
        "line": args.line,
        "character": args.character,
        "query": args.query,
    });
    let query = PermissionQuery {
        tool: "lsp".to_string(),
        path: args.path.unwrap_or(&session.cwd).to_string(),
        action: "read".to_string(),
        always_patterns: vec![pattern.clone()],
        metadata,
    };
    let hook = perms.hook.as_ref().unwrap();
    let decision = (hook)(query).await;
    match decision {
        PermissionDecision::Allow | PermissionDecision::AllowOnce => PermissionOutcome::Allow,
        PermissionDecision::Deny => PermissionOutcome::Deny {
            reason: format!(
                "LSP operation blocked by permission policy. Pattern hint: {}",
                pattern
            ),
        },
        PermissionDecision::Ask => PermissionOutcome::Deny {
            reason: "Permission hook returned 'ask' but lsp runs in autonomous mode. Configure the hook to return allow or deny.".to_string(),
        },
    }
}

fn is_inside(candidate: &str, root: &str) -> bool {
    if candidate == root {
        return true;
    }
    candidate.starts_with(root)
        && (candidate.len() == root.len()
            || candidate.as_bytes().get(root.len()) == Some(&b'/'))
}

fn matches_pattern(path: &str, pattern: &str) -> bool {
    if path == pattern {
        return true;
    }
    if let Some(rest) = pattern.strip_prefix("**/") {
        if !rest.contains('/') && !rest.contains('*') {
            let bn = Path::new(path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");
            if bn == rest {
                return true;
            }
            if path.ends_with(&format!("/{}", rest)) {
                return true;
            }
        }
        if let Some(suffix) = rest.strip_prefix("*.") {
            let bn = Path::new(path)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("");
            return bn == suffix;
        }
    }
    if let Some(ext) = pattern.strip_prefix("*.") {
        if !ext.contains('/') && !ext.contains('*') {
            let bn_ext = Path::new(path)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("");
            return bn_ext == ext;
        }
    }
    path.contains(pattern)
}
