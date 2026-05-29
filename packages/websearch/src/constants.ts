export const DEFAULT_TIMEOUT_MS = 15_000;
export const MIN_TIMEOUT_MS = 2_000;
export const SESSION_BACKSTOP_MS = 30_000;

export const DEFAULT_COUNT = 5;
export const MIN_COUNT = 1;
export const MAX_COUNT = 20;

export const DEFAULT_TIME_RANGE = "all" as const;
export const DEFAULT_LANGUAGE = "auto";
export const DEFAULT_SAFE_SEARCH = "moderate" as const;
export const DEFAULT_CATEGORIES: readonly string[] = ["general"];

export const MAX_QUERY_LENGTH = 512;
export const SNIPPET_CAP = 300; // per-result snippet trim

/**
 * Default User-Agent. Harnesses can override via session.defaultHeaders.
 * We deliberately identify as an agent tool — backends that want to gate
 * bots can do so cleanly rather than being surprised later.
 */
export const DEFAULT_USER_AGENT = "agent-sh-harness-websearch/0.2.0";
