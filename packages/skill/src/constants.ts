/** Max length of the skill name per agentskills.io spec. */
export const MAX_NAME_LENGTH = 64;

/** Max length of the description per agentskills.io spec. */
export const MAX_DESCRIPTION_LENGTH = 1024;

/** Max length of the compatibility string per agentskills.io spec. */
export const MAX_COMPATIBILITY_LENGTH = 500;

/** Max length of argument-hint (Claude Code convention; we cap at 200). */
export const MAX_ARGUMENT_HINT_LENGTH = 200;

/** Upper bound on resources enumerated per folder in the <resources> block. */
export const MAX_RESOURCES_PER_FOLDER = 10;

/** Threshold for fuzzy NOT_FOUND sibling suggestions. */
export const FUZZY_SIBLING_LIMIT = 3;
export const FUZZY_SIBLING_THRESHOLD = 0.6;

/** Well-known resource subfolders per the agentskills.io spec. */
export const RESOURCE_FOLDERS = ["scripts", "references", "assets"] as const;

/** SKILL.md filename. Case-sensitive per spec. */
export const SKILL_FILENAME = "SKILL.md";

/** The skill name must match this pattern (lowercase-kebab-case). */
export const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
