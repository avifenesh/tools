/// Max length of the skill name per agentskills.io spec.
pub const MAX_NAME_LENGTH: usize = 64;

/// Max length of the description per agentskills.io spec.
pub const MAX_DESCRIPTION_LENGTH: usize = 1024;

/// Max length of the compatibility string per agentskills.io spec.
pub const MAX_COMPATIBILITY_LENGTH: usize = 500;

/// Max length of argument-hint (Claude Code convention; we cap at 200).
pub const MAX_ARGUMENT_HINT_LENGTH: usize = 200;

/// Upper bound on resources enumerated per folder in the <resources> block.
pub const MAX_RESOURCES_PER_FOLDER: usize = 10;

/// Threshold for fuzzy NOT_FOUND sibling suggestions.
pub const FUZZY_SIBLING_LIMIT: usize = 3;
pub const FUZZY_SIBLING_THRESHOLD: f64 = 0.6;

/// Well-known resource subfolders per the agentskills.io spec.
pub const RESOURCE_FOLDERS: &[&str] = &["scripts", "references", "assets"];

/// SKILL.md filename. Case-sensitive per spec.
pub const SKILL_FILENAME: &str = "SKILL.md";
