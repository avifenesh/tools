pub const DEFAULT_LIMIT: usize = 2000;
pub const MAX_LINE_LENGTH: usize = 2000;
pub const MAX_BYTES: usize = 50 * 1024;
pub const MAX_FILE_SIZE: u64 = 5 * 1024 * 1024;
pub const BINARY_SAMPLE_BYTES: usize = 4096;
pub const FUZZY_SUGGESTION_LIMIT: usize = 3;

pub fn max_line_suffix() -> String {
    format!("... (line truncated to {} chars)", MAX_LINE_LENGTH)
}

pub fn max_bytes_label() -> String {
    format!("{} KB", MAX_BYTES / 1024)
}

pub const BINARY_EXTENSIONS: &[&str] = &[
    ".zip", ".tar", ".gz", ".exe", ".dll", ".so", ".class", ".jar", ".war", ".7z", ".doc",
    ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp", ".bin", ".dat", ".obj",
    ".o", ".a", ".lib", ".wasm", ".pyc", ".pyo",
];
