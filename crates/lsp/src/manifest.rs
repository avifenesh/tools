use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::constants::MANIFEST_FILENAME;
use crate::types::{LspManifest, LspServerProfile};

/// Load an .lsp.json manifest from `explicit_path` if given, else from
/// `<workspace_root>/.lsp.json`. Returns Ok(None) when the file is
/// missing (that's not an error; orchestrator returns SERVER_NOT_AVAILABLE).
/// Parse / shape errors are Err(msg).
pub async fn load_manifest(
    explicit_path: Option<&str>,
    workspace_root: &str,
) -> Result<Option<LspManifest>, String> {
    let path: PathBuf = match explicit_path {
        Some(p) => PathBuf::from(p),
        None => Path::new(workspace_root).join(MANIFEST_FILENAME),
    };
    let text = match tokio::fs::read_to_string(&path).await {
        Ok(t) => t,
        Err(_) => return Ok(None),
    };
    let raw: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("Invalid JSON in {}: {}", path.display(), e))?;
    let manifest = normalize_manifest(&raw, &path.display().to_string())?;
    Ok(Some(manifest))
}

fn normalize_manifest(raw: &serde_json::Value, source: &str) -> Result<LspManifest, String> {
    let obj = raw
        .as_object()
        .ok_or_else(|| format!("Invalid LSP manifest at {}: expected object", source))?;
    let servers = obj
        .get("servers")
        .and_then(|v| v.as_object())
        .ok_or_else(|| {
            format!(
                "Invalid LSP manifest at {}: expected {{ servers: {{ ... }} }}",
                source
            )
        })?;
    let mut out: HashMap<String, LspServerProfile> = HashMap::new();
    for (key, value) in servers {
        let profile = normalize_profile(key, value, source)?;
        out.insert(key.clone(), profile);
    }
    Ok(LspManifest { servers: out })
}

fn normalize_profile(
    name: &str,
    raw: &serde_json::Value,
    source: &str,
) -> Result<LspServerProfile, String> {
    let obj = raw.as_object().ok_or_else(|| {
        format!(
            "Invalid LSP server profile '{}' in {}: expected object",
            name, source
        )
    })?;
    let extensions: Vec<String> = obj
        .get("extensions")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    if extensions.is_empty() {
        return Err(format!(
            "LSP server '{}' in {}: 'extensions' must be a non-empty string[]",
            name, source
        ));
    }
    let command: Vec<String> = obj
        .get("command")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    if command.is_empty() {
        return Err(format!(
            "LSP server '{}' in {}: 'command' must be a non-empty string[]",
            name, source
        ));
    }
    let root_patterns = obj.get("rootPatterns").and_then(|v| v.as_array()).map(|arr| {
        arr.iter()
            .filter_map(|x| x.as_str().map(|s| s.to_string()))
            .collect()
    });
    let initialization_options = obj.get("initializationOptions").cloned();
    Ok(LspServerProfile {
        language: name.to_string(),
        extensions,
        command,
        root_patterns,
        initialization_options,
    })
}

pub fn profile_for_path(
    file_path: &str,
    manifest: Option<&LspManifest>,
) -> Option<LspServerProfile> {
    let Some(manifest) = manifest else {
        return None;
    };
    let ext = Path::new(file_path)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| format!(".{}", s.to_ascii_lowercase()))?;
    for profile in manifest.servers.values() {
        if profile
            .extensions
            .iter()
            .any(|e| e.to_ascii_lowercase() == ext)
        {
            return Some(profile.clone());
        }
    }
    None
}

pub async fn find_lsp_root(
    file_path: &str,
    profile: &LspServerProfile,
    workspace_cwd: &str,
) -> String {
    let Some(patterns) = &profile.root_patterns else {
        return workspace_cwd.to_string();
    };
    if patterns.is_empty() {
        return workspace_cwd.to_string();
    }
    let mut current = Path::new(file_path)
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("/"));
    loop {
        for pattern in patterns {
            let candidate = current.join(pattern);
            if tokio::fs::metadata(&candidate).await.is_ok() {
                return current.to_string_lossy().into_owned();
            }
        }
        let parent = current.parent().map(|p| p.to_path_buf());
        match parent {
            Some(p) if p != current => current = p,
            _ => break,
        }
    }
    workspace_cwd.to_string()
}
