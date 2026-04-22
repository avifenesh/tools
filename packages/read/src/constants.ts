export const DEFAULT_LIMIT = 2000;
export const MAX_LINE_LENGTH = 2000;
export const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`;
export const MAX_BYTES = 50 * 1024;
export const MAX_BYTES_LABEL = `${MAX_BYTES / 1024} KB`;
export const MAX_FILE_SIZE = 5 * 1024 * 1024;
export const BINARY_SAMPLE_BYTES = 4096;
export const FUZZY_SUGGESTION_LIMIT = 3;

export const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  ".zip",
  ".tar",
  ".gz",
  ".exe",
  ".dll",
  ".so",
  ".class",
  ".jar",
  ".war",
  ".7z",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".odt",
  ".ods",
  ".odp",
  ".bin",
  ".dat",
  ".obj",
  ".o",
  ".a",
  ".lib",
  ".wasm",
  ".pyc",
  ".pyo",
]);
