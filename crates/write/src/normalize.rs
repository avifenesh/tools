/// Normalize CRLF → LF. Matches the TS normalizer exactly.
pub fn normalize_line_endings(s: &str) -> String {
    s.replace("\r\n", "\n")
}
