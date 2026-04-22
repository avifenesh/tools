pub fn has_recursive_marker(pattern: &str) -> bool {
    pattern.contains("**")
}

#[derive(Debug, Clone, Copy)]
pub struct ZeroMatchContext {
    pub has_recursive_marker: bool,
    pub explicit_path: bool,
}

fn zero_match_hint(pattern: &str, ctx: ZeroMatchContext) -> String {
    let mut suggestions: Vec<String> = Vec::new();
    if !ctx.has_recursive_marker {
        suggestions.push(format!(
            "add '**/' before the pattern to search recursively (e.g. '**/{}')",
            pattern
        ));
    }
    suggestions.push("broaden the pattern (e.g. replace '.ts' with '.{ts,tsx,js}')".to_string());
    if ctx.explicit_path {
        suggestions.push("try a different path, or omit 'path' to search the workspace root".to_string());
    } else {
        suggestions.push("try a different path".to_string());
    }
    format!("(No files matched '{}'. Try: {}.)", pattern, suggestions.join("; "))
}

/// Mirror the `narrowingSuggestions` helper from the TS side.
fn narrowing_suggestions(pattern: &str, explicit_path: bool) -> Vec<String> {
    let has_ext = regex_like_has_ext(pattern);
    let mut out: Vec<String> = Vec::new();
    let tail = if let Some(rest) = pattern.strip_prefix("**/") {
        rest.to_string()
    } else {
        pattern.to_string()
    };
    out.push(format!("scope to a subdirectory (e.g. 'src/{}')", tail));
    if !has_ext {
        out.push("pick a specific file extension (e.g. '**/*.ts' or '**/*.md')".to_string());
    } else {
        out.push("tighten the extension set".to_string());
    }
    if !explicit_path {
        out.push("use the 'path' parameter to anchor the search in a subdirectory".to_string());
    }
    out
}

fn regex_like_has_ext(pattern: &str) -> bool {
    // Roughly matches `/\.[a-zA-Z0-9]+(?:\}|$)/` — "has an extension
    // token near the tail". Cheap heuristic.
    let trimmed = pattern.trim_end_matches('}');
    match trimmed.rfind('.') {
        None => false,
        Some(i) => {
            if i + 1 >= pattern.len() {
                return false;
            }
            let tail = &pattern[i + 1..];
            tail.chars().all(|c| c.is_ascii_alphanumeric() || c == '}' || c == ',' || c == '{')
        }
    }
}

pub struct FormatPathsArgs<'a> {
    pub pattern: &'a str,
    pub paths: &'a [String],
    pub total: usize,
    pub offset: usize,
    pub head_limit: usize,
    pub more: bool,
    pub zero_match_context: ZeroMatchContext,
}

pub fn format_paths(args: FormatPathsArgs<'_>) -> String {
    let header = format!("<pattern>{}</pattern>\n<paths>", args.pattern);
    if args.paths.is_empty() {
        let hint = zero_match_hint(args.pattern, args.zero_match_context);
        return format!("{}\n{}\n</paths>", header, hint);
    }
    let body = args.paths.join("\n");
    let next = args.offset + args.paths.len();
    let hint = if !args.more {
        format!("(Found {} file(s) matching the pattern.)", args.total)
    } else {
        // Truncated: lead with narrowing, demote pagination.
        let bare_catch_all = matches!(args.pattern, "*" | "**" | "**/*" | "**/**");
        let is_very_broad = bare_catch_all || args.total >= args.head_limit * 4;
        let narrow = narrowing_suggestions(args.pattern, args.zero_match_context.explicit_path);
        let showing = format!(
            "(Showing files {}-{} of {} matching '{}'.",
            args.offset + 1,
            next,
            args.total,
            args.pattern
        );
        let broad = if is_very_broad {
            " This is likely broader than intended."
        } else {
            ""
        };
        let narrow_line = format!("\nTo narrow: {}.", narrow.join("; "));
        let page_line = format!("\nTo page through instead, re-call with offset: {}.)", next);
        format!("{}{}{}{}", showing, broad, narrow_line, page_line)
    };
    format!("{}\n{}\n\n{}\n</paths>", header, body, hint)
}
