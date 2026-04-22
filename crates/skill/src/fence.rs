use harness_core::permissions::PermissionQuery;
use harness_core::{PermissionDecision, ToolError, ToolErrorCode};
use std::path::Path;

use crate::types::{LoadedSkill, SkillSessionConfig, SkillTrustMode};

#[derive(Debug, Clone)]
pub enum PermissionOutcome {
    Allow,
    Deny { why: String },
}

pub enum PermissionReason {
    Normal,
    UntrustedProjectSkill,
}

pub fn fence_skill(
    session: &SkillSessionConfig,
    skill: &LoadedSkill,
) -> Option<ToolError> {
    let perms = &session.permissions.inner;
    let path_str = skill.dir.clone();

    let is_sensitive = perms
        .sensitive_patterns
        .iter()
        .any(|p| matches_pattern(&path_str, p));
    if is_sensitive && perms.hook.is_none() {
        return Some(
            ToolError::new(
                ToolErrorCode::Sensitive,
                format!("Refusing to activate skill in sensitive path: {}", path_str),
            )
            .with_meta(serde_json::json!({ "name": skill.name, "dir": path_str })),
        );
    }

    let inside = perms.roots.iter().any(|root| is_inside(&path_str, root));
    if !inside && !perms.bypass_workspace_guard && perms.hook.is_none() {
        return Some(
            ToolError::new(
                ToolErrorCode::OutsideWorkspace,
                format!(
                    "Skill directory is outside all configured workspace roots: {}",
                    path_str
                ),
            )
            .with_meta(serde_json::json!({
                "name": skill.name,
                "dir": path_str,
                "roots": perms.roots,
            })),
        );
    }
    None
}

pub fn resolve_trust_mode(session: &SkillSessionConfig, skill_dir: &str) -> (bool, SkillTrustMode) {
    let trusted = session
        .trust
        .trusted_roots
        .iter()
        .any(|r| is_inside(skill_dir, r));
    if trusted {
        return (true, SkillTrustMode::Allow);
    }
    let mode = session
        .trust
        .untrusted_project_skills
        .unwrap_or(SkillTrustMode::HookRequired);
    (false, mode)
}

pub async fn ask_permission(
    session: &SkillSessionConfig,
    skill: &LoadedSkill,
    reason: PermissionReason,
) -> PermissionOutcome {
    let perms = &session.permissions.inner;
    let pattern = format!("Skill(name:{})", skill.name);

    if perms.hook.is_none() {
        if matches!(reason, PermissionReason::UntrustedProjectSkill) {
            return PermissionOutcome::Deny {
                why: "untrusted project skill; no permission hook is configured to review it"
                    .to_string(),
            };
        }
        if session.permissions.unsafe_allow_skill_without_hook {
            return PermissionOutcome::Allow;
        }
        return PermissionOutcome::Deny {
            why: "skill tool has no permission hook configured; refusing to activate untrusted skills. Wire a hook or set permissions.unsafe_allow_skill_without_hook for test fixtures."
                .to_string(),
        };
    }

    let reason_str = match reason {
        PermissionReason::Normal => "normal",
        PermissionReason::UntrustedProjectSkill => "untrusted_project_skill",
    };
    let metadata = serde_json::json!({
        "name": skill.name,
        "root_index": skill.root_index,
        "frontmatter": skill.frontmatter,
        "reason": reason_str,
    });
    let query = PermissionQuery {
        tool: "skill".to_string(),
        path: skill.dir.clone(),
        action: "activate".to_string(),
        always_patterns: vec![pattern.clone()],
        metadata,
    };
    let hook = perms.hook.as_ref().unwrap();
    let decision = hook(query).await;
    match decision {
        PermissionDecision::Allow | PermissionDecision::AllowOnce => PermissionOutcome::Allow,
        PermissionDecision::Deny => PermissionOutcome::Deny {
            why: format!(
                "skill activation blocked by permission policy. Pattern hint: {}",
                pattern
            ),
        },
        PermissionDecision::Ask => PermissionOutcome::Deny {
            why: "permission hook returned 'ask' but skill runs in autonomous mode. Configure the hook to return allow or deny.".to_string(),
        },
    }
}

fn is_inside(candidate: &str, root: &str) -> bool {
    if candidate == root {
        return true;
    }
    if !candidate.starts_with(root) {
        return false;
    }
    // Only consider it inside if the next char is a path separator.
    match candidate.as_bytes().get(root.len()) {
        Some(b'/') | Some(b'\\') => true,
        None => true,
        _ => false,
    }
}

fn matches_pattern(path: &str, pattern: &str) -> bool {
    // Exact string match first — cheap.
    if path == pattern {
        return true;
    }
    // Use globset for real glob semantics, mirroring the TS matcher at
    // packages/core/src/permissions.ts. `literal_separator(true)` keeps
    // `*` from crossing path segments. Fallback to substring if the
    // pattern is globset-unparseable.
    let pat_lower = pattern.to_ascii_lowercase();
    let path_lower = path.to_ascii_lowercase();
    let base_name = Path::new(&path_lower)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    match globset::GlobBuilder::new(&pat_lower)
        .literal_separator(true)
        .build()
    {
        Ok(glob) => {
            let m = glob.compile_matcher();
            m.is_match(&path_lower) || m.is_match(base_name)
        }
        Err(_) => path_lower.contains(&pat_lower),
    }
}
