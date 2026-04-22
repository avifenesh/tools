//! Skill tool — Rust port of `@agent-sh/harness-skill`.
//!
//! Conforms to `agent-knowledge/design/skill.md`. Authored-skill
//! activation only (v1): SKILL.md with frontmatter, progressive
//! disclosure of resources, permission-gated activation, trust-gated
//! project skills, session-scoped dedupe, pluggable `SkillRegistry`.

pub mod constants;
pub mod fence;
pub mod format;
pub mod frontmatter;
pub mod registry;
pub mod run;
pub mod schema;
pub mod substitute;
pub mod suggest;
pub mod types;

pub use registry::FilesystemSkillRegistry;
pub use run::skill;

pub use constants::*;
pub use schema::{
    alias_hint, is_valid_skill_name, safe_parse_skill_params, SkillParseError,
    SKILL_TOOL_DESCRIPTION, SKILL_TOOL_NAME,
};
pub use types::{
    ActivatedSet, LoadedSkill, SkillAlreadyLoaded, SkillArguments, SkillEntry, SkillError,
    SkillNotFound, SkillOk, SkillParams, SkillPermissionPolicy, SkillRegistry, SkillResult,
    SkillSessionConfig, SkillTrustMode, SkillTrustPolicy,
};
