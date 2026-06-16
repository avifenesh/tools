---
"@agent-sh/harness-bash": patch
"@agent-sh/harness-webfetch": patch
"@agent-sh/harness-tools": patch
---

Cap large shell and web fetch outputs to bounded previews while spilling full content to disk.

WebFetch now returns a 64 KB head/tail preview for spilled raw responses and keeps default HTML output on the cleaned markdown path unless raw HTML is explicitly requested.

Bash now renders capped stdout/stderr as head/tail previews, keeps the full log on disk, and steers capped curl/wget page output back to WebFetch for cleaned content.
