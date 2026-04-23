use harness_core::{PermissionPolicy, ToolError, ToolErrorCode};
use std::path::{Path, PathBuf};

pub fn resolve_search_path(cwd: &str, input: Option<&str>) -> PathBuf {
    let raw = input.unwrap_or(cwd);
    let p = Path::new(raw);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        Path::new(cwd).join(p)
    }
}

pub fn fence_glob(
    permissions: &PermissionPolicy,
    resolved: &Path,
) -> Option<ToolError> {
    let path_str = resolved.to_string_lossy();

    let is_sensitive = permissions
        .sensitive_patterns
        .iter()
        .any(|p| matches_pattern(&path_str, p));
    if is_sensitive && permissions.hook.is_none() {
        return Some(
            ToolError::new(
                ToolErrorCode::Sensitive,
                format!("Refusing to glob sensitive path: {}", path_str),
            )
            .with_meta(serde_json::json!({ "path": path_str })),
        );
    }

    let inside = permissions
        .roots
        .iter()
        .any(|root| is_inside(&path_str, root));
    if !inside && !permissions.bypass_workspace_guard && permissions.hook.is_none() {
        return Some(
            ToolError::new(
                ToolErrorCode::OutsideWorkspace,
                format!(
                    "Path is outside all configured workspace roots: {}",
                    path_str
                ),
            )
            .with_meta(
                serde_json::json!({ "path": path_str, "roots": permissions.roots }),
            ),
        );
    }

    None
}

fn is_inside(candidate: &str, root: &str) -> bool {
    if candidate == root {
        return true;
    }
    candidate.starts_with(root)
        && (candidate.len() == root.len()
            || matches!(
                candidate.as_bytes().get(root.len()),
                Some(&b'/') | Some(&b'\\')
            ))
}

/// Same minimal sensitive-pattern matcher the grep crate uses — keeps
/// the fence logic byte-identical in behavior without pulling a full
/// globset dep through the core layer.
fn matches_pattern(path: &str, pattern: &str) -> bool {
    if path == pattern {
        return true;
    }
    if let Some(rest) = pattern.strip_prefix("**/") {
        if !rest.contains('/') && !rest.contains('*') {
            let bn = std::path::Path::new(path)
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
            let bn = std::path::Path::new(path)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("");
            return bn == suffix;
        }
    }
    if let Some(ext) = pattern.strip_prefix("*.") {
        if !ext.contains('/') && !ext.contains('*') {
            let bn_ext = std::path::Path::new(path)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("");
            return bn_ext == ext;
        }
    }
    path.contains(pattern)
}
