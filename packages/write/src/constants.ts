/** Top-K fuzzy candidates returned on OLD_STRING_NOT_FOUND. */
export const DEFAULT_FUZZY_TOP_K = 3;

/** Minimum Levenshtein similarity (0..1) to include as a fuzzy candidate. */
export const DEFAULT_FUZZY_THRESHOLD = 0.7;

/** Allowed length ratio delta between window and old_string when fuzzy-matching. */
export const DEFAULT_FUZZY_LENGTH_TOLERANCE = 0.15;

/** Lines of context to include before/after each fuzzy or non-unique match. */
export const CONTEXT_LINES = 3;

/** Max file size (bytes) the Edit/MultiEdit path will touch in v1. */
export const MAX_EDIT_FILE_SIZE = 5 * 1024 * 1024;

/** Bytes sampled for binary detection on the pre-edit target. */
export const BINARY_SAMPLE_BYTES = 4096;
