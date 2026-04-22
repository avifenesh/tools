# Learning Guide: Write and Edit Tools in AI Agent Harnesses

**Generated**: 2026-04-19
**Sources**: 22 resources analyzed
**Depth**: medium
**Scope**: How harnesses let LLMs create and modify files across Claude Code, OpenAI Codex, Aider, Cline, OpenCode, and Continue.

---

## Prerequisites

- Familiarity with LLM tool-use / function calling (the agentic loop: model emits tool call, harness executes, returns result).
- Basic understanding of unified diff syntax (`+`, `-`, hunks, context lines).
- A mental model of a harness as the trusted code around an LLM: it enforces invariants, validates inputs, applies filesystem mutations, and feeds back errors.

---

## TL;DR

- **There are really only three families of file-mutation tools**: (1) full-file Write, (2) exact-string replacement (`Edit` / `str_replace` / `SEARCH/REPLACE`), and (3) patch/diff application (`apply_patch`, udiff). Every major harness combines these in different ratios.
- **Exact-string replacement beats whole-file writes at scale**: Aider's benchmarks show that capable models (Claude 3+, GPT-4+, Gemini 2.5) reach 80-88% correct on polyglot coding tasks with diff-style formats, while weaker models regress and need whole-file rewrites.
- **Read-before-Edit is a hard invariant** in Claude Code, the Agent SDK, and OpenCode: the Edit / Write tools refuse to run on a file the model has not read in the current session. This is a staleness guard, not a safety theater.
- **Patches should be line-number-free and context-anchored**: OpenAI's V4A format (used by `apply_patch` in Responses/Codex) and Aider's udiff both omit line numbers deliberately — they are brittle across any background modification.
- **Atomic multi-edit tools (MultiEdit, *** Begin Patch ... *** End Patch) exist because partial-application is worse than no-application**: Anthropic's `MultiEdit` and OpenAI's `apply_patch` both apply-all-or-nothing to avoid half-migrated files.
- **The dominant anti-pattern is rewriting whole files for small changes** — it burns tokens, loses context, and is a leading cause of "lazy coding" (`# ... existing code ...`) placeholders in the output.

---

## Core Concepts

### 1. The three file-mutation primitives

Every harness builds file editing from some subset of:

| Primitive | Claude Code | OpenAI/Codex | Aider | Cline | OpenCode |
|-----------|-------------|--------------|-------|-------|----------|
| **Full overwrite** | `Write` | `apply_patch` (create_file) | `whole` format | `write_to_file` | `write` |
| **Exact string replace** | `Edit`, `MultiEdit`, `str_replace_based_edit_tool` | (via `apply_patch`) | `diff` (SEARCH/REPLACE) | `replace_in_file` (SEARCH/REPLACE) | `edit`, `multiedit` |
| **Diff/patch application** | (via Bash + `patch`) | `apply_patch` V4A | `udiff`, `diff-fenced` | (via SEARCH/REPLACE) | `apply_patch` |
| **Notebook-specific** | `NotebookEdit` | — | — | — | — |

The tool name matters less than the *format* the LLM emits. All replace-style tools boil down to "find this exact substring, swap for that one." All patch-style tools boil down to "given these context lines and these +/- lines, locate and apply."

### 2. Claude Code's Write / Edit / MultiEdit / NotebookEdit

From the Claude Code tools reference and the Agent SDK built-in tool list:

- **`Write(file_path, content)`** — creates a new file or *overwrites* an existing one with `content`. Permission-required. Overwrites silently; there is no merge.
- **`Edit(file_path, old_string, new_string, replace_all?)`** — exact string replacement. `old_string` must match exactly once unless `replace_all: true`. Permission-required.
- **`MultiEdit(file_path, edits[])`** — batches multiple `Edit` operations on one file. Critically atomic: "if any edit fails, none will be applied." Each later edit runs on the result of the previous one.
- **`NotebookEdit(notebook_path, ...)`** — cell-aware editing for `.ipynb` files. Treats notebooks as structured cell arrays rather than JSON blobs, so the model never has to hand-write notebook JSON.
- **`str_replace_based_edit_tool`** (`text_editor_20250728`) — the Anthropic API's built-in "schema-less" text editor tool for client SDKs. Commands: `view`, `str_replace`, `create`, `insert`. (An older `undo_edit` command existed in `text_editor_20250124` but was removed in the Claude 4 line.)

### 3. The "Read before Edit" invariant

Both Claude Code's Edit tool and OpenCode's edit tool enforce:

> You must read a file using the Read tool before attempting any edits, or the operation will fail.

Reasons, in order of importance:

1. **Avoids stale-content clobbering.** Without a recent read, the model's `old_string` reflects its training-time guess, not reality. On any post-build/post-git-checkout file, this produces silent incorrect edits or outright failures.
2. **Anchors line numbers and indentation.** The Read result includes line prefixes like `"19: for num in range(...)"`; the model uses these to scope `insert` and `view_range` commands precisely.
3. **Forces the model to see comments, docstrings, and license headers** that must be preserved verbatim — Aider calls this out: "Every SEARCH section must EXACTLY MATCH the existing file content, character for character, including all comments, docstrings, etc."
4. **Makes failures diagnostic.** When an Edit fails with "no match found," the preceding Read in the transcript is the ground truth the model can diff against.

The invariant is harness-enforced, not model-enforced. The Write tool inherits a milder version: "you must read an existing file's contents using the Read tool before attempting to modify it."

### 4. Edit formats: Aider's taxonomy and benchmarks

Aider popularized the systematic comparison of edit formats. From the Aider docs and leaderboards:

- **`whole`** — LLM returns the whole updated file in a fenced markdown block. Simple, reliable for weak models (GPT-3.5 circa 2023 scored ~46% on first attempt with `whole`; function-call variants scored worse). Expensive in tokens; encourages lazy placeholders on long files.
- **`diff` (SEARCH/REPLACE)** — merge-conflict-style blocks (`<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`). File path on its own line. First match replacement. Blocks should be concise (no long runs of unchanged lines) and broken into multiple blocks for multiple non-contiguous changes. Used by Claude 3+ and most frontier models.
- **`diff-fenced`** — same as `diff` but with the file path inside the fence. A model-specific workaround for Gemini, which often breaks standard fencing.
- **`udiff`** — unified-diff format based on `diff -U0`, but *without line numbers*. Introduced specifically to reduce "lazy coding" in GPT-4 Turbo. Improved benchmark accuracy from 20% to 61%, a 3× reduction in laziness. Hypothesis: patch formats psychologically cue the model that it's writing for a machine, not a human, which drives rigor.
- **`architect`** — two-model pattern. A strong "architect" model plans in plain text; a cheaper "editor" model applies diffs using `editor-diff` or `editor-whole`.

From the Aider polyglot leaderboard (late 2025):
- GPT-5 (high effort) + diff: **88.0%** correct
- o3-pro (high) + diff: 84.9%
- Gemini 2.5 Pro + diff-fenced: 83.1% (and 99.6% well-formed responses — the highest measured)
- o3 + gpt-4.1 in architect mode: 78.2% with 100% well-formed

Two takeaways: diff variants dominate the top of the board, and *well-formedness* (the LLM emits parseable edits at all) is a separate axis from *correctness* (the code works).

### 5. OpenAI's apply_patch and the V4A diff format

`apply_patch` is OpenAI's canonical file-mutation tool, used by Codex CLI and exposed in the Responses API for GPT-4.1 / GPT-5 / GPT-5.1. Structure:

```
*** Begin Patch
*** Update File: path/to/file.py
@@ def greet():
 context line
-    print("hi")
+    print("hello")
 context line
*** End Patch
```

Operations: `*** Add File:` (every following line starts with `+`), `*** Update File:` (optional `*** Move to:` for rename, one or more `@@` context anchors, then `±` lines), `*** Delete File:` (no body).

V4A design choices:

- **No line numbers**, ever. Context lines (usually 3 before and 3 after each change) locate the hunk, so the patch survives if the file was edited elsewhere between being read and being patched.
- **`@@` anchors** scope to functions or classes, reducing ambiguity in long files. Multiple `@@` statements narrow the location further.
- **Indentation is semantically significant** — a space-prefixed context line must match the file's whitespace exactly.
- **Fuzzy matching on Unicode normalization** — ASCII-only patches can update lines with curly quotes or typographic punctuation, which the model often strips.
- **Multiple operations in one patch are applied in descending order by default** to preserve index validity during sequential modification.

The Agents SDK (TypeScript and Python) ships helpers `applyDiff` and `ApplyPatchTool` that parse V4A and hand a simple API to your harness. OpenAI explicitly recommends the combination of `apply_patch` + shell tool for discovery: the model uses shell/Read for navigation, then emits a patch.

### 6. Cline: write_to_file vs replace_in_file

Cline uses an XML-flavored tool protocol:

```xml
<write_to_file>
<path>src/components/Header.tsx</path>
<content>[full file content]</content>
</write_to_file>
```

`replace_in_file` uses Aider-style SEARCH/REPLACE blocks. The heuristic Cline teaches the LLM: **use `write_to_file` for brand-new files or ≥50% rewrites; use `replace_in_file` for targeted edits.** Cline's "Background Edit" feature streams replace_in_file results line-by-line with green/red coloring into the chat panel instead of a diff editor tab, which is how it handles many-small-edits flows without swamping the editor UI.

### 7. OpenCode: edit, write, multiedit, apply_patch under one permission

OpenCode exposes four file mutation tools, all gated by a single `edit` permission:

- `edit` — exact string replacement. Same read-before-edit invariant as Claude Code. Same guidance: match indentation exactly, don't include line-number prefixes, avoid emojis unless requested.
- `write` — create or overwrite, read-before-write on existing files.
- `multiedit` — atomic batch of edits on one file. All-or-nothing. Edits are sequential; an earlier edit can produce the exact string a later edit looks for.
- `apply_patch` — V4A-compatible patch application.

### 8. Continue

Continue positions itself more as an AI code-review / checks tool (`.continue/checks/*.md`) than a full edit agent. Its editing lives in the IDE extension layer rather than as a prominent tool schema; most day-to-day mutation happens via "apply to file" from chat suggestions, which is whole-file or diff replacement depending on the mode.

---

## Code Examples

### Claude Code: Read → Edit → verify

```typescript
// Agent SDK: built-in tools handle the loop
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "Find and fix the off-by-one in auth.ts",
  options: { allowedTools: ["Read", "Edit", "Bash"] }
})) {
  console.log(message);
}
```

Under the hood the model will emit (conceptually):

```json
// 1. Read first — mandatory before Edit
{ "name": "Read", "input": { "file_path": "/repo/src/auth.ts" } }

// 2. Targeted Edit with enough context for uniqueness
{
  "name": "Edit",
  "input": {
    "file_path": "/repo/src/auth.ts",
    "old_string": "for (let i = 0; i <= tokens.length; i++) {",
    "new_string": "for (let i = 0; i < tokens.length; i++) {"
  }
}

// 3. Verify by running tests
{ "name": "Bash", "input": { "command": "npm test -- auth" } }
```

### Claude Code: MultiEdit for atomic refactors

```json
{
  "name": "MultiEdit",
  "input": {
    "file_path": "/repo/src/db.ts",
    "edits": [
      { "oldString": "function connectDb(",         "newString": "function connectDatabase(" },
      { "oldString": "await connectDb(",            "newString": "await connectDatabase(", "replaceAll": true },
      { "oldString": "export { connectDb };",       "newString": "export { connectDatabase };" }
    ]
  }
}
```

Because MultiEdit is atomic, a typo in edit 2 aborts edits 1 and 3 — the file never enters a half-renamed state.

### Anthropic API: str_replace command

```json
{
  "type": "tool_use",
  "name": "str_replace_based_edit_tool",
  "input": {
    "command": "str_replace",
    "path": "primes.py",
    "old_str": "    for num in range(2, limit + 1)",
    "new_str": "    for num in range(2, limit + 1):"
  }
}
```

Tool results come back as `"Successfully replaced text at exactly one location."` on success, or structured errors with `is_error: true` for multiple-match / no-match / permission cases.

### Aider: SEARCH/REPLACE block

```
mathweb/flask/app.py
```python
<<<<<<< SEARCH
from flask import Flask
=======
import math
from flask import Flask
>>>>>>> REPLACE
```
```

Rules (from Aider's `editblock_prompts.py`): include full file path on its own line; the SEARCH section must match character-for-character including comments and docstrings; only the first match is replaced; break large changes into multiple small blocks; use two blocks to *move* code (delete, then insert).

### Aider: unified diff

```diff
--- mathweb/flask/app.py
+++ mathweb/flask/app.py
@@ ... @@
-from flask import Flask
+import math
+from flask import Flask
```

No line numbers in the `@@` header. Aider's parser applies nine recovery strategies when the patch doesn't apply cleanly, including whitespace normalization, ellipsis expansion, and fuzzy matching at ~80% similarity within ±10% length variation.

### OpenAI apply_patch (V4A)

```
*** Begin Patch
*** Update File: src/services/payments.py
@@ class PaymentService:
@@     def charge(self, amount):
-        if amount < 0:
-            raise ValueError("negative")
+        if amount <= 0:
+            raise ValueError("non-positive")
         return self._gateway.charge(amount)
*** End Patch
```

Claude-style equivalent: one `Read` + one `Edit`. V4A equivalent carries the function/class anchor inline so no extra Read is needed if the context lines are unique — at the cost of the model occasionally miscounting context.

### Cline: replace_in_file

```xml
<replace_in_file>
<path>src/api.ts</path>
<diff>
<<<<<<< SEARCH
const BASE_URL = "http://localhost:3000"
=======
const BASE_URL = process.env.API_URL ?? "http://localhost:3000"
>>>>>>> REPLACE
</diff>
</replace_in_file>
```

### OpenCode: multiedit atomic batch

```json
{
  "name": "multiedit",
  "input": {
    "file_path": "/repo/utils.ts",
    "edits": [
      { "oldString": "const VERSION = \"1.0.0\"", "newString": "const VERSION = \"1.1.0\"" },
      { "oldString": "function v1_format(", "newString": "function v1_1_format(" }
    ]
  }
}
```

---

## Common Pitfalls

| Pitfall | Why It Happens | How to Avoid |
|---------|---------------|--------------|
| Rewriting a whole file to change three lines | The model picked `Write` when `Edit` would do. Often caused by the model not having read the file in this turn, so it doesn't trust its `old_string`. | Pre-pend a Read. Tell the model explicitly to prefer `Edit` / `MultiEdit`. Some harnesses (OpenCode) enforce this via tool descriptions. |
| `str_replace` / `Edit` fails with "no match found" | Invisible differences: trailing whitespace, tabs vs spaces, CRLF vs LF, or the file changed since the Read. | Ensure `old_string` was copied from the most recent Read output. Check for `\r\n`. If you're stitching from memory, don't — read again. |
| `str_replace` fails with "multiple matches" | `old_string` isn't unique in the file. Common on boilerplate like `return None` or `} else {`. | Widen `old_string` with surrounding context lines until unique. Or use `replace_all: true` when you *want* all occurrences (rename-style). |
| `replace_all` accidentally replacing substrings | `replace_all` on an unescaped, short pattern catches unintended matches (`user` inside `username`). | Make the pattern word-boundary safe by including surrounding punctuation (`"user "`, `"(user)"`). For identifier renames, prefer LSP-based rename if the harness exposes it, else MultiEdit with precise contexts. |
| Lazy placeholders in generated code (`# ... existing code ...`) | Model uses whole-file format on a long file and elides to save output tokens. | Switch to diff/udiff format for strong models. Aider found udiff cut laziness 3×. Increase `max_tokens`. Ask explicitly: "do not elide existing code; return the complete updated region." |
| Patches that don't apply | Missing context lines, wrong indentation, or line numbers hallucinated into a format that forbids them. | Use line-number-free formats (V4A, udiff-no-numbers). Let the harness's fuzzy matcher take three swings, then fail fast with a diagnostic back to the model. |
| Half-applied multi-file refactor | Harness applied edits file-by-file, a middle one failed, earlier ones remain. | Use atomic tools (MultiEdit is *per-file* atomic; for cross-file atomicity you need harness-level transactions or a dry-run pass). Commit after each successful "green" checkpoint so rollback is cheap. |
| Emoji / comment bloat on save | Models love to add `// 🚀 Optimized!` and pedagogical comments. Inflates diffs and causes review fatigue. | Tool descriptions in OpenCode and Claude Code now explicitly say "avoid emojis unless the user specifically requests them." Reinforce in CLAUDE.md / AGENTS.md. |
| Editing a file the model hasn't read this session | Claude Code / OpenCode reject it up front. Other harnesses (Aider, Cline) may succeed with stale content and produce subtle bugs. | Treat Read-before-Edit as universal practice. In prompts: "always read the file first, even if you believe you already know its contents." |
| Notebook JSON corruption | Model tries to edit `.ipynb` as plain text, loses cell boundaries or output structure. | Use `NotebookEdit` (Claude Code) which understands cells. If not available, read-parse-edit-write the JSON with a shell helper rather than string-replacing JSON. |
| Bypassing the tool to call `sed -i` via Bash | Skips all safety (permission prompts, diff preview, checkpointing). | Harnesses like Claude Code recommend explicit `Edit` for mutations; reserve Bash for verification. Configure permissions to block risky shell patterns. |

---

## Best Practices

Synthesized across Anthropic Claude Code docs, OpenAI Codex/Responses docs, Aider research, Cline, and OpenCode:

1. **Prefer the smallest-scope tool that does the job.** Edit > MultiEdit > Write. Never `Write` a file you can `Edit`.
2. **Read before you Edit, every time.** Even on files the model "knows." The invariant exists because staleness is silent.
3. **Use diff/patch formats on strong models, whole-file only on weak ones.** Aider benchmarks show frontier models (Claude 3+, GPT-4+, Gemini 2.5) perform best with diff variants; weaker models regress without whole-file format.
4. **Ban line numbers in patch formats.** Both V4A and Aider's udiff exclude them deliberately. They're a correctness liability with zero upside.
5. **Keep SEARCH blocks concise.** No long runs of unchanged lines. This reduces the odds of a whitespace mismatch and makes the diff reviewable.
6. **Break large refactors into multiple small blocks.** Aider rule: "Break large changes into multiple smaller blocks." Small, uniquely-anchored blocks apply more reliably than one sprawling hunk.
7. **Use atomic multi-edit when multiple changes share fate.** Don't let a renamed function and its three call sites get out of sync. `MultiEdit` / one-big-`apply_patch` guarantees all-or-nothing.
8. **Verify after every non-trivial edit.** Run tests, linters, or typecheck. Anthropic's guidance is explicit: "Give Claude a way to verify its work. This is the single highest-leverage thing you can do."
9. **Return *diagnostic* error results to the model.** On match failure, include how many matches were found and suggest adding context. Aider provides detailed diagnostics showing expected vs. actual; Claude Code returns "Found 3 matches for replacement text. Please provide more context." These messages feed back into the agentic loop.
10. **Checkpoint before risky changes.** Claude Code auto-checkpoints; Aider auto-commits; Codex runs in git-backed sandboxes. If your harness doesn't, add a pre-tool hook that snapshots.
11. **Scope permissions to edit-only when you don't need Bash.** A read-only agent cannot corrupt your tree. A write-allowed agent with no shell cannot `rm -rf`. Orthogonal permissions are cheap.
12. **Log every file mutation.** PostToolUse hooks on `Edit|Write|MultiEdit|NotebookEdit` gated audit logs. The Agent SDK docs show exactly this pattern.
13. **Teach the model your repo's formatting rules in CLAUDE.md / AGENTS.md**, not in the edit itself. Indentation preferences, file-header requirements, ban on emojis: put these up front so Edits respect them.
14. **For large files, use `view_range` / partial reads before editing.** The `str_replace_based_edit_tool` supports `view_range: [start, end]` and an optional `max_characters` cap (added in `text_editor_20250728`). Reading a 10k-line file whole is both slow and a context-rot risk.
15. **Use `architect` mode for hard refactors.** A planner model drafts changes in prose; a cheaper editor model turns prose into diffs. Aider measured competitive correctness with better cost profile and 100% well-formed output for o3 + gpt-4.1.

---

## Further Reading

| Resource | Type | Why Recommended |
|----------|------|-----------------|
| [Claude Code Tools Reference](https://code.claude.com/docs/en/tools-reference) | Official docs | Canonical list of Write, Edit, MultiEdit, NotebookEdit with permission semantics |
| [Anthropic Text Editor Tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/text-editor-tool) | Official docs | Full spec of `str_replace_based_edit_tool`, including view/str_replace/create/insert commands |
| [Claude Agent SDK Overview](https://code.claude.com/docs/en/agent-sdk/overview) | Official docs | Shows how built-in Write/Edit tools are exposed via Python and TypeScript SDKs |
| [Claude Code Best Practices](https://code.claude.com/docs/en/best-practices) | Official docs | Verify-your-work and Read-before-Edit patterns explained in context |
| [Aider Edit Formats](https://aider.chat/docs/more/edit-formats.html) | Docs | Taxonomy: whole, diff, diff-fenced, udiff, architect |
| [Aider Unified Diffs Writeup](https://aider.chat/docs/unified-diffs.html) | Research post | Why udiff was invented and how it cut laziness 3× |
| [Aider Leaderboards](https://aider.chat/docs/leaderboards/) | Benchmark | Hard numbers: which format + model combos actually work |
| [Aider 2023 Benchmarks](https://aider.chat/2023/07/02/benchmarks.html) | Research post | Original analysis showing whole > function-calls for GPT-3.5 |
| [Aider 2024 January Benchmarks](https://aider.chat/2024/01/25/benchmarks-0125.html) | Research post | SEARCH/REPLACE vs udiff tradeoffs on GPT-4 Turbo |
| [Aider Troubleshooting: Edit Errors](https://aider.chat/docs/troubleshooting/edit-errors.html) | Docs | Diagnosis playbook when models refuse to emit parseable edits |
| [Aider's editblock_prompts.py](https://github.com/Aider-AI/aider/blob/main/aider/coders/editblock_prompts.py) | Source code | The actual prompt that teaches models SEARCH/REPLACE |
| [Aider's udiff_prompts.py](https://github.com/Aider-AI/aider/blob/main/aider/coders/udiff_prompts.py) | Source code | The exact rules Aider teaches for udiff |
| [Aider's editblock_coder.py](https://github.com/Aider-AI/aider/blob/main/aider/coders/editblock_coder.py) | Source code | Parsing, fuzzy matching, and recovery strategies |
| [OpenAI apply_patch Tool](https://developers.openai.com/api/docs/guides/tools-apply-patch) | Official docs | The V4A format used by Codex and Responses API |
| [OpenAI Codex apply-patch source](https://github.com/openai/codex/blob/main/codex-rs/apply-patch/src/lib.rs) | Source code | Reference parser for V4A patches |
| [OpenAI GPT-4.1 Prompting Guide](https://developers.openai.com/cookbook/examples/gpt4-1_prompting_guide) | Cookbook | V4A format details plus SEARCH/REPLACE and pseudo-XML alternatives |
| [Cline Tools Reference](https://docs.cline.bot/tools-reference/all-cline-tools) | Official docs | Complete `write_to_file` / `replace_in_file` parameter list |
| [Cline Background Edit](https://docs.cline.bot/features/background-edit) | Official docs | UX model for streaming many-small-edit flows |
| [OpenCode edit tool description](https://raw.githubusercontent.com/sst/opencode/dev/packages/opencode/src/tool/edit.txt) | Source | Read-before-edit invariant in another harness |
| [OpenCode write tool description](https://raw.githubusercontent.com/sst/opencode/dev/packages/opencode/src/tool/write.txt) | Source | Write tool's read-before-write requirement |
| [OpenCode apply_patch tool description](https://raw.githubusercontent.com/sst/opencode/dev/packages/opencode/src/tool/apply_patch.txt) | Source | V4A-compatible header operations |
| [Anthropic: Writing Tools for Agents](https://www.anthropic.com/engineering/writing-tools-for-agents) | Engineering blog | Broader design principles behind how Anthropic shapes file-mutation tools |

---

*This guide was synthesized from 22 sources. See `resources/agent-write-edit-tools-sources.json` for full source metadata.*
