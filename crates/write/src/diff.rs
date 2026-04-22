use similar::{ChangeTag, TextDiff};

pub struct UnifiedDiffArgs<'a> {
    pub old_path: &'a str,
    pub new_path: &'a str,
    pub old_content: &'a str,
    pub new_content: &'a str,
}

/// Produce a unified-diff string. Uses the `similar` crate's grouped
/// hunks. Output shape: `--- old\n+++ new\n@@ ... @@\n ...\n- ...\n+ ...`.
pub fn unified_diff(args: UnifiedDiffArgs<'_>) -> String {
    let diff = TextDiff::from_lines(args.old_content, args.new_content);
    let mut out = String::new();
    out.push_str(&format!("--- {}\n", args.old_path));
    out.push_str(&format!("+++ {}\n", args.new_path));

    for (idx, group) in diff.grouped_ops(3).iter().enumerate() {
        if idx > 0 {
            out.push('\n');
        }
        let first = &group[0];
        let last = &group[group.len() - 1];
        let old_start = first.old_range().start + 1;
        let old_len = last.old_range().end - first.old_range().start;
        let new_start = first.new_range().start + 1;
        let new_len = last.new_range().end - first.new_range().start;
        out.push_str(&format!(
            "@@ -{},{} +{},{} @@\n",
            old_start, old_len, new_start, new_len
        ));
        for op in group {
            for change in diff.iter_changes(op) {
                let sign = match change.tag() {
                    ChangeTag::Equal => ' ',
                    ChangeTag::Delete => '-',
                    ChangeTag::Insert => '+',
                };
                out.push(sign);
                out.push_str(change.value());
                if !out.ends_with('\n') {
                    out.push('\n');
                }
            }
        }
    }

    out
}
