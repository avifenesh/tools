export const DEFAULT_INACTIVITY_TIMEOUT_MS = 60_000;
export const DEFAULT_WALLCLOCK_BACKSTOP_MS = 300_000;
export const MAX_COMMAND_LENGTH = 16_384;
export const MAX_OUTPUT_BYTES_INLINE = 30_720; // 30 KB per stream
export const MAX_OUTPUT_BYTES_FILE = 10 * 1024 * 1024; // 10 MB per stream
export const BACKGROUND_MAX_JOBS = 16;
export const KILL_GRACE_MS = 5_000;

/**
 * Env var name prefixes that the tool refuses to let the model set via `env`.
 * Defense in depth: even if the harness forwards its environment, the model
 * should not be able to override credentials per-call.
 */
export const SENSITIVE_ENV_PREFIXES: readonly string[] = [
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
