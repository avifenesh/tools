use crate::constants::max_bytes_label;

pub struct FormatTextArgs<'a> {
    pub path: &'a str,
    pub offset: usize,
    pub lines: &'a [String],
    pub total_lines: usize,
    pub more: bool,
    pub byte_cap: bool,
}

pub fn format_text(args: FormatTextArgs<'_>) -> String {
    let header = format!(
        "<path>{}</path>\n<type>file</type>\n<content>",
        args.path
    );

    if args.lines.is_empty() && args.total_lines == 0 {
        return format!("{}\n(File exists but is empty)\n</content>", header);
    }

    let body: String = args
        .lines
        .iter()
        .enumerate()
        .map(|(i, line)| format!("{}: {}", args.offset + i, line))
        .collect::<Vec<_>>()
        .join("\n");
    let last = args.offset + args.lines.len() - 1;
    let next = last + 1;

    let hint = if args.byte_cap {
        let pct = if args.total_lines > 0 {
            (last as f64 / args.total_lines as f64 * 100.0).round() as i64
        } else {
            0
        };
        let remaining = args.total_lines.saturating_sub(last);
        format!(
            "(Output capped at {}. Showing lines {}-{} of {} · {}% covered · {} lines remaining. Next offset: {}.)",
            max_bytes_label(),
            args.offset,
            last,
            args.total_lines,
            pct,
            remaining,
            next
        )
    } else if args.more {
        let pct = (last as f64 / args.total_lines as f64 * 100.0).round() as i64;
        let remaining = args.total_lines.saturating_sub(last);
        format!(
            "(Showing lines {}-{} of {} · {}% covered · {} lines remaining. Next offset: {}.)",
            args.offset, last, args.total_lines, pct, remaining, next
        )
    } else {
        format!("(End of file · {} lines total)", args.total_lines)
    };

    format!("{}\n{}\n\n{}\n</content>", header, body, hint)
}

pub struct FormatDirArgs<'a> {
    pub path: &'a str,
    pub entries: &'a [String],
    pub offset: usize,
    pub total_entries: usize,
    pub more: bool,
}

pub fn format_directory(args: FormatDirArgs<'_>) -> String {
    let header = format!(
        "<path>{}</path>\n<type>directory</type>\n<entries>",
        args.path
    );
    let body = args.entries.join("\n");
    let last = args.offset + args.entries.len() - 1;
    let next = last + 1;
    let remaining = args.total_entries.saturating_sub(last);
    let hint = if args.more {
        format!(
            "(Showing {} of {} entries · {} remaining. Next offset: {}.)",
            args.entries.len(),
            args.total_entries,
            remaining,
            next
        )
    } else {
        format!("({} entries)", args.total_entries)
    };
    format!("{}\n{}\n\n{}\n</entries>", header, body, hint)
}

pub fn format_attachment(kind: &str) -> String {
    format!("{} read successfully", kind)
}
