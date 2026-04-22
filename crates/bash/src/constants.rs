pub const DEFAULT_INACTIVITY_TIMEOUT_MS: u64 = 60_000;
pub const DEFAULT_WALLCLOCK_BACKSTOP_MS: u64 = 300_000;
pub const MAX_COMMAND_LENGTH: usize = 16_384;
pub const MAX_OUTPUT_BYTES_INLINE: usize = 30_720;
pub const MAX_OUTPUT_BYTES_FILE: usize = 10 * 1024 * 1024;
pub const BACKGROUND_MAX_JOBS: usize = 16;
pub const KILL_GRACE_MS: u64 = 5_000;

/// Env var prefixes the tool refuses to let the model set. Mirrors the
/// TS `SENSITIVE_ENV_PREFIXES` list.
pub const SENSITIVE_ENV_PREFIXES: &[&str] = &[
    "AWS_",
    "BEDROCK_",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
    "NPM_TOKEN",
    "DOCKERHUB_TOKEN",
    "SLACK_",
    "STRIPE_",
];
