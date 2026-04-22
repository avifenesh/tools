use serde_json::{Map, Value};

pub struct FormatSkillArgs<'a> {
    pub name: &'a str,
    pub dir: &'a str,
    pub frontmatter: &'a Value,
    pub body: &'a str,
    pub resources: &'a [String],
    pub bytes: u64,
}

pub fn format_skill(args: FormatSkillArgs<'_>) -> String {
    let fm_serialized = serialize_frontmatter(args.frontmatter);
    let resources_block = if args.resources.is_empty() {
        String::new()
    } else {
        format!("<resources>\n{}\n</resources>", args.resources.join("\n"))
    };
    let hint = format!(
        "(Skill \"{}\" activated. Body is {} bytes. Scripts available via bash({}/scripts/<name>). References via read({}/references/<name>).)",
        args.name, args.bytes, args.dir, args.dir
    );

    let mut parts: Vec<String> = vec![
        format!("<skill name=\"{}\" dir=\"{}\">", args.name, args.dir),
        "<frontmatter>".to_string(),
        fm_serialized,
        "</frontmatter>".to_string(),
        "<instructions>".to_string(),
        args.body.to_string(),
        "</instructions>".to_string(),
    ];
    if !resources_block.is_empty() {
        parts.push(resources_block);
    }
    parts.push("</skill>".to_string());
    parts.push(hint);
    parts.into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n")
}

pub fn format_already_loaded(name: &str) -> String {
    format!(
        "(Skill \"{}\" is already active in this session. No new content was added.)",
        name
    )
}

pub fn format_not_found(name: &str, siblings: &[String]) -> String {
    if siblings.is_empty() {
        format!(
            "(No skill matches \"{}\". Check the catalog for installed skill names.)",
            name
        )
    } else {
        format!(
            "(No skill matches \"{}\". Did you mean: {}? Run with a listed name from the catalog.)",
            name,
            siblings.join(", ")
        )
    }
}

/// Re-serialize frontmatter to YAML-ish form. Not round-trip fidelity —
/// the model just needs to see the declared metadata above the body.
fn serialize_frontmatter(fm: &Value) -> String {
    let mut lines: Vec<String> = Vec::new();
    if let Value::Object(map) = fm {
        for (k, v) in map {
            lines.push(render_kv(k, v, 0));
        }
    }
    lines.join("\n")
}

fn render_kv(key: &str, value: &Value, indent: usize) -> String {
    let pad = "  ".repeat(indent);
    match value {
        Value::Null => format!("{}{}:", pad, key),
        Value::Bool(b) => format!("{}{}: {}", pad, key, b),
        Value::Number(n) => format!("{}{}: {}", pad, key, n),
        Value::String(s) => {
            if s.contains('\n') {
                let body = s
                    .split('\n')
                    .map(|line| format!("{}  {}", pad, line))
                    .collect::<Vec<_>>()
                    .join("\n");
                format!("{}{}: |\n{}", pad, key, body)
            } else {
                format!("{}{}: {}", pad, key, quote_if_needed(s))
            }
        }
        Value::Array(arr) => {
            if arr.is_empty() {
                format!("{}{}: []", pad, key)
            } else {
                let items: Vec<String> = arr
                    .iter()
                    .map(|v| match v {
                        Value::String(s) => quote_if_needed(s),
                        other => serde_json::to_string(other).unwrap_or_default(),
                    })
                    .collect();
                format!("{}{}: [{}]", pad, key, items.join(", "))
            }
        }
        Value::Object(map) => render_map(key, map, indent),
    }
}

fn render_map(key: &str, map: &Map<String, Value>, indent: usize) -> String {
    let pad = "  ".repeat(indent);
    if map.is_empty() {
        return format!("{}{}: {{}}", pad, key);
    }
    let nested: Vec<String> = map.iter().map(|(k, v)| render_kv(k, v, indent + 1)).collect();
    format!("{}{}:\n{}", pad, key, nested.join("\n"))
}

fn quote_if_needed(s: &str) -> String {
    let simple = !s.is_empty()
        && s.chars().all(|c| {
            c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.' || c == '/'
        });
    if simple {
        s.to_string()
    } else {
        // JSON-style double-quoted escaping handles all edge cases YAML
        // readers tolerate as quoted strings.
        serde_json::to_string(s).unwrap_or_else(|_| format!("\"{}\"", s))
    }
}
