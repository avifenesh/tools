use std::path::Path;

use crate::constants::BINARY_EXTENSIONS;

pub fn is_binary_by_extension(filepath: &str) -> bool {
    let ext = Path::new(filepath)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| format!(".{}", s.to_ascii_lowercase()));
    match ext {
        Some(e) => BINARY_EXTENSIONS.contains(&e.as_str()),
        None => false,
    }
}

pub fn is_binary_by_content(sample: &[u8]) -> bool {
    if sample.is_empty() {
        return false;
    }
    let mut non_printable = 0usize;
    for &b in sample {
        if b == 0 {
            return true;
        }
        if b < 9 || (b > 13 && b < 32) {
            non_printable += 1;
        }
    }
    (non_printable as f64 / sample.len() as f64) > 0.3
}

pub fn is_binary(filepath: &str, sample: &[u8]) -> bool {
    is_binary_by_extension(filepath) || is_binary_by_content(sample)
}

pub fn is_image_mime(mime: &str) -> bool {
    mime.starts_with("image/") && mime != "image/svg+xml"
}

pub fn is_pdf_mime(mime: &str) -> bool {
    mime == "application/pdf"
}

/// Minimal MIME-from-extension guesser. We only need to distinguish
/// attachments (images/PDF) from text from binary; the TS version uses
/// mime-type lib but the subset of extensions we care about is tiny.
pub fn mime_for(path: &str) -> String {
    let lower = path.to_ascii_lowercase();
    let ext = Path::new(&lower)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "webp" => "image/webp",
        "tif" | "tiff" => "image/tiff",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "json" => "application/json",
        "xml" => "application/xml",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" => "application/javascript",
        "ts" | "tsx" | "md" | "txt" | "csv" => "text/plain",
        _ => "application/octet-stream",
    }
    .to_string()
}
