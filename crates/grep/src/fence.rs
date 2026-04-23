use harness_core::{PermissionPolicy, ToolError, ToolErrorCode};
use std::path::{Path, PathBuf};

/// Resolve the requested search path: accept absolute, or resolve against
/// session cwd. Keep it literal — no symlink expansion at this layer (we
/// rely on the OS for that when walking).
pub fn resolve_search_path(cwd: &str, input: Option<&str>) -> PathBuf {
    let raw = input.unwrap_or(cwd);
    let p = Path::new(raw);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        Path::new(cwd).join(p)
    }
}

/// Workspace + sensitive-path fence. Matches TS `fenceSearch` semantics:
/// deny on sensitive-pattern match (no hook), deny on outside-workspace
/// (no hook + no bypass), otherwise allow.
///
/// The permission hook integration is omitted in this port for v1 —
/// Rust sessions that need a hook pass their own wrapper around
/// [`grep`] and invoke the hook before calling. (This keeps the
/// `grep()` entry point sync-from-the-outside while we port.)
pub fn fence_search(
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
                format!("Refusing to grep sensitive path: {}", path_str),
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

/// Minimal glob-style matcher for sensitive patterns. We support:
///   `**/.env`       — any-depth .env file
///   `.env`          — exact basename match
///   `*.pem`         — extension glob
///   literal strings — exact substring match as a fallback
///
/// Matches the DEFAULT_SENSITIVE_PATTERNS shape from harness-core without
/// pulling in a full globset dep at the core layer. Good enough for fence
/// duty; anyone with complex needs can wire a custom PermissionPolicy.
fn matches_pattern(path: &str, pattern: &str) -> bool {
    // Exact equality
    if path == pattern {
        return true;
    }
    // `**/x` → path ends with `/x` OR basename equals `x`
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
            // `**/*.pem` → any file with that extension
            let bn = std::path::Path::new(path)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("");
            return bn == suffix;
        }
    }
    // `*.pem` → extension match on the basename
    if let Some(ext) = pattern.strip_prefix("*.") {
        if !ext.contains('/') && !ext.contains('*') {
            let bn_ext = std::path::Path::new(path)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("");
            return bn_ext == ext;
        }
    }
    // Literal substring fallback (rare sensitive-pattern shapes).
    path.contains(pattern)
}
