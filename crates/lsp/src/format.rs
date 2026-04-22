use crate::types::{LspLocation, LspOperation, LspSymbolInfo};

pub struct FormatHoverArgs<'a> {
    pub path: &'a str,
    pub line: u32,
    pub character: u32,
    pub contents: &'a str,
}

pub fn format_hover(args: FormatHoverArgs<'_>) -> String {
    format!(
        "<operation>hover</operation>\n<path>{}</path>\n<position>{}:{}</position>\n<contents>\n{}\n</contents>",
        args.path, args.line, args.character, args.contents
    )
}

pub struct FormatLocationsArgs<'a> {
    pub operation: LspOperation,
    pub path: &'a str,
    pub line: u32,
    pub character: u32,
    pub locations: &'a [LspLocation],
    pub total: Option<usize>,
    pub truncated: bool,
}

pub fn format_locations(args: FormatLocationsArgs<'_>) -> String {
    let header = format!(
        "<operation>{}</operation>\n<path>{}</path>\n<position>{}:{}</position>",
        args.operation.as_str(),
        args.path,
        args.line,
        args.character
    );
    let body = args
        .locations
        .iter()
        .map(|l| format!("{}:{}:{}  {}", l.path, l.line, l.character, l.preview))
        .collect::<Vec<_>>()
        .join("\n");
    let hint = if args.truncated && args.total.is_some() {
        format!(
            "(Showing {} of {} {}. Narrow by directory via grep if you need more.)",
            args.locations.len(),
            args.total.unwrap(),
            args.operation.as_str()
        )
    } else {
        let noun = match args.operation {
            LspOperation::References => "reference",
            LspOperation::Implementation => "implementation",
            _ => "definition",
        };
        format!("({} {}(s).)", args.locations.len(), noun)
    };
    format!("{}\n<locations>\n{}\n</locations>\n{}", header, body, hint)
}

pub struct FormatDocSymbolsArgs<'a> {
    pub path: &'a str,
    pub symbols: &'a [LspSymbolInfo],
}

pub fn format_document_symbols(args: FormatDocSymbolsArgs<'_>) -> String {
    let header = format!(
        "<operation>documentSymbol</operation>\n<path>{}</path>",
        args.path
    );
    let body = render_symbol_tree(args.symbols, 0);
    format!("{}\n<symbols>\n{}\n</symbols>", header, body)
}

pub struct FormatWorkspaceSymbolsArgs<'a> {
    pub query: &'a str,
    pub symbols: &'a [LspSymbolInfo],
    pub total: usize,
    pub truncated: bool,
}

pub fn format_workspace_symbols(args: FormatWorkspaceSymbolsArgs<'_>) -> String {
    let header = format!(
        "<operation>workspaceSymbol</operation>\n<query>{}</query>",
        args.query
    );
    let body = args
        .symbols
        .iter()
        .map(|s| format!("{}:{}: {} {}", s.path, s.line, s.kind, s.name))
        .collect::<Vec<_>>()
        .join("\n");
    let hint = if args.truncated {
        format!(
            "(Showing {} of {} matches. Narrow the query.)",
            args.symbols.len(),
            args.total
        )
    } else {
        format!("({} match(es).)", args.total)
    };
    format!("{}\n<matches>\n{}\n</matches>\n{}", header, body, hint)
}

fn render_symbol_tree(symbols: &[LspSymbolInfo], depth: usize) -> String {
    let indent = "  ".repeat(depth);
    let mut lines: Vec<String> = Vec::new();
    for s in symbols {
        lines.push(format!("{}{}: {} {}", indent, s.line, s.kind, s.name));
        if let Some(children) = &s.children {
            if !children.is_empty() {
                lines.push(render_symbol_tree(children, depth + 1));
            }
        }
    }
    lines.join("\n")
}

pub struct FormatNoResultsArgs<'a> {
    pub operation: LspOperation,
    pub hint: &'a str,
}

pub fn format_no_results(args: FormatNoResultsArgs<'_>) -> String {
    format!(
        "<operation>{}</operation>\n(No results. {})",
        args.operation.as_str(),
        args.hint
    )
}

pub struct FormatServerStartingArgs<'a> {
    pub operation: LspOperation,
    pub language: &'a str,
    pub retry_ms: u64,
}

pub fn format_server_starting(args: FormatServerStartingArgs<'_>) -> String {
    format!(
        "<operation>{}</operation>\n(Language server for {} is still indexing. Retry in ~{}ms.)",
        args.operation.as_str(),
        args.language,
        args.retry_ms
    )
}

pub fn cap_hover_markdown(contents: &str, max_bytes: usize) -> (String, bool) {
    let total = contents.as_bytes().len();
    if total <= max_bytes {
        return (contents.to_string(), false);
    }
    // Byte-safe truncation that preserves UTF-8 boundaries.
    let cut = if contents.is_char_boundary(max_bytes) {
        max_bytes
    } else {
        let mut i = max_bytes;
        while i > 0 && !contents.is_char_boundary(i) {
            i -= 1;
        }
        i
    };
    (
        format!(
            "{}\n... (hover truncated at {} bytes of {})",
            &contents[..cut],
            max_bytes,
            total
        ),
        true,
    )
}

pub fn cap_preview(line: &str, max_len: usize) -> String {
    if line.chars().count() <= max_len {
        return line.to_string();
    }
    let cut: String = line.chars().take(max_len).collect();
    format!("{}... (truncated)", cut)
}

pub fn no_results_hint(op: LspOperation) -> &'static str {
    match op {
        LspOperation::Hover => "The position might be on whitespace or inside a comment.",
        LspOperation::Definition => {
            "Symbol may be a primitive type (no source definition) or outside the indexed workspace."
        }
        LspOperation::References => {
            "No references found. The symbol is either unused or only defined. You may also be 1 character off — check the exact column in the source."
        }
        LspOperation::Implementation => {
            "The symbol may not be an interface or abstract method, or no concrete implementations exist in the workspace."
        }
        LspOperation::DocumentSymbol => {
            "The file has no recognizable symbols (empty file, markdown, or unsupported syntax)."
        }
        LspOperation::WorkspaceSymbol => {
            "No symbols matched the query. Try a broader query or a substring."
        }
    }
}
