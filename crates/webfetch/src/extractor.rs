use readable_readability::Readability;

/// Parse out the major content-type sans parameters.
///   "text/html; charset=utf-8" -> "text/html"
pub fn parse_content_type_base(header: &str) -> String {
    let base = match header.find(';') {
        Some(i) => &header[..i],
        None => header,
    };
    base.trim().to_ascii_lowercase()
}

pub fn is_html_like(content_type_base: &str) -> bool {
    content_type_base == "text/html" || content_type_base == "application/xhtml+xml"
}

/// Run readability + html2md. Returns markdown + fallback flag.
pub fn extract_markdown(html: &str, _url: &str) -> (String, bool) {
    // Readability extracts main-content as a DOM fragment and a title.
    let mut parser = Readability::new();
    let (node, metadata) = parser.parse(html);
    // Serialize the extracted fragment back to HTML so html2md can run.
    let mut extracted_html = Vec::new();
    if node.serialize(&mut extracted_html).is_ok() {
        if let Ok(frag) = String::from_utf8(extracted_html) {
            if !frag.trim().is_empty() {
                let md = html2md::parse_html(&frag);
                let title = metadata
                    .page_title
                    .map(|t| format!("# {}\n\n", t))
                    .unwrap_or_default();
                return (format!("{}{}", title, md).trim_end().to_string() + "\n", false);
            }
        }
    }
    // Fallback: run html2md on the raw page.
    let md = html2md::parse_html(html);
    (md, true)
}
