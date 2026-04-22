# Learning Guide: Glob, Grep, and File-Discovery Tools in AI Agent Harnesses

**Generated**: 2026-04-19
**Sources**: 22 resources analyzed
**Depth**: medium
**Topic slug**: agent-search-tools

## Prerequisites

- Familiarity with at least one AI coding agent (Claude Code, Codex CLI, Aider, Cline, or OpenCode).
- Basic command-line search tools: `grep`, `find`, `ls`, and ideally `rg` (ripgrep).
- Working knowledge of regular expressions and glob patterns.
- Awareness that LLM context windows are finite and tool output counts against them.

## TL;DR

- Every modern coding-agent harness exposes some shape of "find files by name" + "search files by content" primitive. Claude Code, OpenCode, Cline, and Codex all converge on ripgrep as the engine; the differences are in the *tool surface* and *result shaping* presented to the model.
- Prefer dedicated `Glob` / `Grep` tools over running bare `grep`, `find`, or `ls` through a `Bash` tool. Dedicated tools enforce permissions, respect `.gitignore`, page output, and avoid leaking full command output into context.
- Glob is for "which files exist?" (name/pattern). Grep is for "which lines match?" (content). Reach for a sub-agent / Task delegation when the answer needs many reads and you only care about the conclusion.
- Ripgrep has real gotchas: literal braces need escaping (use `interface\{\}`), multi-line patterns need `-U --multiline-dotall`, `--type` and `--glob` behave differently, and results respect `.gitignore` by default.
- Pagination is the hidden battle. Use `head_limit`, `offset`, context flags (`-C`/`-A`/`-B`) and output modes (`files_with_matches` / `count` / `content`) deliberately to keep the context window from filling with irrelevant hits.

## Core Concepts

### 1. Two Primitives: Name Search vs. Content Search

Across harnesses, file discovery splits cleanly into two primitives:

| Primitive | Question it answers | Canonical name | Backed by |
|-----------|--------------------|----|-----------|
| **Glob** | "What files match this path pattern?" | `Glob`, `glob`, `find_files` | `glob(3)` / ripgrep `--files -g` |
| **Grep** | "Which lines in the tree match this regex?" | `Grep`, `grep`, `search_files` | ripgrep (`rg`) |

Claude Code's built-in `Glob` tool takes a pattern (e.g. `**/*.ts`) and an optional `path`, returning matching paths **sorted by modification time** (newest first). OpenCode ships an almost identical `glob` tool with the same `b.mtime - a.mtime` sort. Modtime sorting is a deliberate heuristic: recently touched files are almost always the interesting ones during active work.

Claude Code's `Grep` is a wrapper around ripgrep. It exposes:
- `pattern`: regex (ripgrep / Rust regex syntax).
- `path`: file or directory to search in.
- `glob`: file-pattern filter (`"*.{ts,tsx}"`).
- `type`: ripgrep file-type filter (`js`, `py`, `rust`, ...), more efficient than `glob` for standard types.
- `output_mode`: `content` (matching lines with optional context), `files_with_matches` (paths only, default), `count` (match counts).
- `-A` / `-B` / `-C`: context lines (only valid with `output_mode: content`).
- `-n`: line numbers (defaults to true for content mode).
- `-i`: case-insensitive.
- `multiline`: enables `.` to match newlines and cross-line patterns.
- `head_limit`: first N lines/entries of output, like `| head -N`.
- `offset`: skip first N entries before applying `head_limit`, like `| tail -n +N | head -N`.

**Key insight**: the `output_mode` dimension is what makes grep-as-a-tool fundamentally different from `bash rg`. The agent can ask "do any files match?" (cheap: `files_with_matches`) before paying the token cost of "show me the matching lines" (expensive: `content`).

### 2. Ripgrep as the Universal Engine

Almost every high-quality search tool in an agent harness is ripgrep with a different wrapper:

- **Claude Code `Grep`**: wraps ripgrep directly.
- **OpenCode `grep`**: calls `../file/ripgrep`'s `rg.search()`, groups results by file, caps at 100 matches, truncates lines over 2000 chars.
- **Cline `search_files`**: uses `ripgrep` under the hood (via VS Code's bundled binary), accepts `path`, `regex`, optional `file_pattern` for glob filtering.
- **Codex CLI**: does not expose a dedicated grep tool; the agent runs `rg` (and `ls`/`find`/`grep`) through the shell tool, which the sandbox pre-approves as read-only.

Ripgrep is preferred because it:
1. Respects `.gitignore`, `.ignore`, `.rgignore`, and hidden-file rules by default.
2. Skips binary files (anything with NUL bytes) unless `-uuu` is set.
3. Is Unicode-first with a finite-automaton engine (linear-time regex by default).
4. Ships SIMD-accelerated literal matching and incremental buffered reading.
5. Has a rich `--type` system that is cheaper than glob filters for common languages.

### 3. Harness Taxonomy

| Harness | Glob equivalent | Grep equivalent | Listing | Notes |
|---------|----------------|-----------------|---------|-------|
| **Claude Code** | `Glob` tool (modtime-sorted) | `Grep` tool (rg-backed, rich flags) | `Bash(ls)` or implied via Read | First-class dedicated tools; Bash available but deprecated for search |
| **OpenCode** | `glob` tool | `grep` tool (rg-backed) | `read` + `bash` | Mirrors Claude Code's surface; `ls` is not a dedicated tool |
| **Cline** | `list_files` (with optional `recursive`) | `search_files` (regex + `file_pattern`) | `list_files`, `list_code_definition_names` | XML-style parameters; adds symbol listing |
| **Codex CLI** | No dedicated tool — `shell` runs `rg --files`, `find`, `ls` | No dedicated tool — `shell` runs `rg` | Same `shell` tool | Sandbox auto-approves `rg`, `ls`, `find`, `grep` as read-only |
| **Aider** | `/ls` (user) and repo-map | No agent-facing grep; relies on `/add` + repo-map | `/ls`, `/map` | User-driven; tree-sitter repo-map replaces autonomous search |
| **Continue** | No built-in search tool in agent mode (via 2026-04); relies on context providers + MCP | Same | Same | Different model: context providers inject files, MCP adds tools |
| **OpenAI `file_search` (Responses/Assistants)** | N/A — vector-store retrieval, not filesystem | N/A | N/A | Orthogonal primitive; RAG over uploaded files, not the working tree |

The split matters: `file_search` in OpenAI's Assistants/Responses APIs is *semantic retrieval over a vector store*, not filesystem discovery. Don't confuse it with Codex CLI's shell-based file search.

### 4. When to Glob vs. Grep vs. Delegate to a Sub-agent

Anthropic's guidance in the Claude Code best-practices docs and the multi-agent research system post converges on one rule: **the cheapest tool that answers the question wins**, and investigation should not clutter the main context.

Decision heuristic:

| Question | Tool |
|----------|------|
| "Is there a file named X?" | `Glob` with `**/X*` |
| "What files were modified recently?" | `Glob` (modtime-sorted) with `**/*` |
| "Does this identifier appear anywhere?" | `Grep` with `output_mode: files_with_matches` |
| "Show me the call sites of `foo()` with 3 lines of context." | `Grep` with `output_mode: content`, `-C 3` |
| "Open-ended: 'how does auth work?'" | Sub-agent / Task — the exploration would pollute main context |
| "Need to list all matching lines across 2000 files and summarize." | Sub-agent — returns a summary, not raw hits |

The [Claude Code context-window walkthrough](https://code.claude.com/docs/en/context-window) shows a grep of `refreshToken` consuming ~600 tokens and a single file read consuming 2,400. File reads dominate; search results are cheap if you use the right `output_mode`. But running a grep and then reading 10 hits costs far more than sending one sub-agent that returns the one-paragraph conclusion.

Best-practices doc pull-quote: "Since context is your fundamental constraint, subagents are one of the most powerful tools available. When Claude researches a codebase it reads lots of files, all of which consume your context. Subagents run in separate context windows and report back summaries."

### 5. Aider Takes a Different Path: Repo-Map Instead of Search

Aider sidesteps agent-driven search almost entirely. Instead:

1. User explicitly runs `/add <file>` to bring files into the chat.
2. Aider maintains a **repo-map**: a tree-sitter-parsed, PageRank-ranked summary of definitions and references across the entire repo (default ~1,000 tokens via `--map-tokens`).
3. The map is shipped with every user turn, so the model sees "important classes and functions along with their types and call signatures" without searching.

Comparison:
- Grep/glob answer "where is X textually?"
- Aider's repo-map answers "what is structurally important, ranked by graph centrality?"

Repo-map uses `networkx.pagerank()` over the identifier graph, with file caching keyed on mtimes in a `diskcache.Cache`. Files mentioned in the chat get a 50× rank boost. This is effectively a pre-computed semantic index in lieu of live search.

### 6. Cline's XML Tools and Symbol Listing

Cline exposes four read-side tools that together cover the search space:

- `read_file` — content.
- `list_files` — directory contents (optionally recursive).
- `search_files` — regex over a tree with optional `file_pattern` glob filter.
- `list_code_definition_names` — extracts top-level definitions (functions, classes) from files in a directory.

`list_code_definition_names` is the most distinctive: it's a "zoom out" primitive that lets the agent map an unfamiliar directory without reading every file. Example XML invocation shape:

```xml
<search_files>
  <path>src</path>
  <regex>function\s+\w+\(</regex>
  <file_pattern>*.ts</file_pattern>
</search_files>
```

### 7. Codex's Sandbox Model

OpenAI's Codex CLI deliberately does not ship dedicated `Glob`/`Grep` tools. Instead, the `shell` tool is the single surface for local file operations, and the sandbox pre-classifies commands:

> With `--ask-for-approval untrusted`, "Codex runs only known-safe read operations automatically."

Pre-approved (no prompt) commands include `rg`, `ls`, `find`, `grep`. Write-capable operations or anything that could mutate state require explicit approval. This is a different philosophy: security is enforced at the sandbox layer, not by designing a narrower tool surface. For the LLM, it means "run whatever shell command fits" — including full `rg` flag sets.

The downside: the model must know ripgrep's flag syntax and the harness has no opportunity to enforce pagination, output-mode discipline, or result capping. It is the LLM's job to write `rg ... | head -50` or use `-m` / `--max-count`.

### 8. Pagination and Token Budget

Every dedicated search tool has a "how do I not blow up the context window" story. Patterns:

- **OpenCode**: caps grep results at 100 matches with a truncation notice; truncates lines over 2000 chars. Glob caps at 100 files.
- **Claude Code**: `head_limit` (defaults to 250 for Grep) + `offset` give `tail -n +N | head -N` semantics across all output modes. `context`/`-C` controls line-context tokens.
- **Cline**: results are file-grouped with limits applied server-side before reaching the model.
- **Codex**: no harness-level cap; the agent pipes through `head`/`tail` or uses `rg -m`.

Rule of thumb, from Anthropic's "Building Effective Agents" and the context-rot coverage in Claude Code docs: **always reach for the cheapest output mode first**. `files_with_matches` tells you if work is needed; only upgrade to `content` with context when the agent actually needs to read lines.

### 9. `ls` vs. Dedicated List Tools

Directory listing is the most contested primitive.

- Claude Code historically had a dedicated `LS` tool; in 2025+ documentation and harness builds, listing is usually folded into `Glob` (for pattern-based listing) or `Bash(ls)` for an interactive look.
- OpenCode has no `list` tool; it uses `glob` + `read`.
- Cline keeps `list_files` as a first-class tool with `recursive` as a parameter.
- Codex runs `ls` via shell.

When to use each:
- Use `Glob` when you can express intent as a pattern (`**/*.test.ts`). It returns paths with modtime ordering, which is usually more useful than `ls`.
- Use `Bash(ls)` / a dedicated `list_files` when you explicitly want to see the structure of one directory, including hidden files and non-glob-matching items, or when you need `ls -la` style metadata.
- Never use `Bash(ls -R)` for a recursive listing — it is the dominant anti-pattern for context bloat on a large tree.

## Code Examples

### Basic: File Discovery With Glob

```javascript
// Claude Code / OpenCode
// Find TypeScript test files, newest first
await Glob({ pattern: "**/*.test.{ts,tsx}" });

// Scoped to a subdirectory
await Glob({ pattern: "**/*.sql", path: "src/migrations" });
```

### Content Search With Appropriate Output Mode

```javascript
// Cheap: "does this symbol exist at all?"
await Grep({
  pattern: "refreshToken",
  output_mode: "files_with_matches",
});

// Targeted: show call sites with 3 lines of context
await Grep({
  pattern: "function\\s+refreshToken\\(",
  output_mode: "content",
  "-C": 3,
  glob: "*.{ts,tsx}",
  head_limit: 50,
});

// Count hits per file (good for hotspot analysis)
await Grep({
  pattern: "TODO|FIXME",
  output_mode: "count",
  type: "py",
});
```

### Ripgrep Gotcha: Literal Braces

```bash
# WRONG - braces are regex repetition operators
rg "interface{}" src/

# RIGHT - escape the braces
rg "interface\{\}" src/

# OR - use fixed-string mode
rg -F "interface{}" src/
```

In Go specifically, `interface{}` is a common search target. Agents frequently miss this.

### Ripgrep Gotcha: Multiline Patterns

```bash
# Default: pattern cannot span lines
rg "struct Foo \{.*field" src/   # will never match multi-line structs

# Fix: enable multiline with dot-all
rg -U --multiline-dotall "struct Foo \{[\s\S]*?field" src/
```

In Claude Code's `Grep`, this is the `multiline: true` parameter. Note: PCRE2 multiline forces file loads into memory and disables parallelism, so it is noticeably slower.

### Type vs. Glob Filter

```bash
# More efficient - uses ripgrep's type database
rg "useState" --type ts

# Equivalent via glob - fine, but parses every file to check extension
rg "useState" -g "*.ts" -g "*.tsx"

# Exclude a type
rg "password" -T md
```

In tool form, the Claude Code `Grep` exposes both `type` and `glob` fields. Prefer `type` for standard languages, fall back to `glob` for custom patterns (`"*.{vue,svelte}"`, `"**/fixtures/**"`).

### Pagination With head_limit / offset

```javascript
// Page 1
await Grep({
  pattern: "TODO",
  output_mode: "content",
  head_limit: 50,
});

// Page 2
await Grep({
  pattern: "TODO",
  output_mode: "content",
  head_limit: 50,
  offset: 50,
});
```

### Sub-agent Delegation for Research-heavy Search

```
# In the main Claude Code session
"Use a subagent to find every place we construct a JWT, summarize the
auth flow in <= 10 bullet points, and list the 3 files most worth
reading next."
```

The sub-agent runs its own Glob/Grep/Read loop in a separate context window and returns only the summary, preserving main-conversation tokens.

## Common Pitfalls

| Pitfall | Why It Happens | How to Avoid |
|---------|---------------|--------------|
| Running `grep -r` via Bash instead of `Grep` tool | Muscle memory; model generalizes from training data | Prefer dedicated `Grep` — respects `.gitignore`, paginates, integrates with permission system |
| `ls -R` or `find . -type f` at the repo root | Trying to "see everything" before acting | Use `Glob` with a specific pattern; or delegate exploration to a sub-agent |
| Literal braces/parens unescaped in regex | Agent writes patterns as if they were substring searches | Escape with `\{ \}` or use ripgrep `-F` / tool `fixed_strings` option |
| `Grep` returns 500 matches, agent reads all of them | Default `output_mode: content` with no `head_limit` | Start with `files_with_matches`, only upgrade to content for specific files |
| Searching for cross-line patterns in default mode | Forgetting `multiline`; patterns like `class.*\{.*method` silently miss | Set `multiline: true` (harness) or `-U --multiline-dotall` (rg) |
| Relying on `type ts` and missing `.tsx` | `--type ts` does not include `tsx` in ripgrep's default definitions | Use `glob: "*.{ts,tsx}"` or define a custom `--type-add` |
| Searching binary / vendored directories | Agent explicitly sets `-uuu` or `--no-ignore` out of frustration | Respect `.gitignore`; add missing patterns there rather than disabling |
| `file_search` (OpenAI Assistants) confused with filesystem grep | Same noun, different concept | Treat OpenAI `file_search` as semantic RAG over a vector store, not working-tree search |
| Aider user expects the agent to auto-find files | Aider is intentionally `/add`-driven with repo-map | Use `/ls`, `/map`, then `/add`; do not expect agent autonomy here |
| Pasting huge `grep` output back into the chat manually | Bypassing the harness's pagination | Let the tool handle truncation, or use a sub-agent to pre-summarize |

## Best Practices

Synthesized from 22 sources:

1. **Pick the right primitive**: Glob for names, Grep for content, Bash(ls) only when you explicitly want non-pattern listing. (Claude Code docs, OpenCode docs.)
2. **Start cheap, escalate carefully**: `files_with_matches` → `count` → `content with -C`. Only materialize full matches when you know which file you care about. (Anthropic best-practices.)
3. **Prefer `type` over `glob` for standard languages** but know ripgrep's type definitions are not exhaustive (`ts` vs `tsx`, `js` vs `jsx`). Check `rg --type-list`. (Ripgrep GUIDE.)
4. **Always provide `head_limit`** (or accept the harness default) on broad patterns. Use `offset` for pagination. (Claude Code / OpenCode implementations.)
5. **Respect `.gitignore`** rather than bypassing with `-uu`. If you need to search vendored dirs often, add `.rgignore` exceptions. (Ripgrep FAQ.)
6. **Escape regex metacharacters** (`{`, `}`, `(`, `)`, `.`, `*`, `+`, `?`, `^`, `$`, `|`, `\`) or use `-F`/fixed-strings mode. (Rust regex docs; ripgrep FAQ.)
7. **Delegate exploration to a sub-agent** when the answer is a summary, not raw hits. Keeps main context clean. (Anthropic multi-agent research, Claude Code sub-agents docs.)
8. **Avoid `Bash(grep)` / `Bash(find)` / `Bash(ls -R)`** when dedicated tools exist. The dedicated tools give you permission gating, output shaping, and pagination for free. (Claude Code best practices, OpenCode tool design.)
9. **In Aider workflows**, prime the repo-map and add files with `/add` — do not fight the design by expecting grep-like exploration. (Aider usage docs.)
10. **Treat OpenAI `file_search` as a different primitive**: it retrieves from a vector store, it does not discover files on disk. (OpenAI platform docs.)
11. **Tool descriptions are prompts too**: Anthropic's advice in "Building Effective Agents" — spend as much time on tool schemas as on system prompts. Clear descriptions help the model pick Glob vs Grep vs sub-agent correctly. (Anthropic engineering blog.)
12. **Watch out for context rot**: every grep/glob hit you surface sits in the conversation forever unless compacted. Use the tool, summarize, drop. (Claude Code context-window walkthrough.)

## Further Reading

| Resource | Type | Why Recommended |
|----------|------|-----------------|
| [Claude Code overview](https://code.claude.com/docs/en/overview) | Official Docs | Entry point for Claude Code's tool model |
| [Claude Code best practices](https://code.claude.com/docs/en/best-practices) | Official Docs | Canonical guidance on context, sub-agents, Glob/Grep usage |
| [Claude Code sub-agents](https://code.claude.com/docs/en/sub-agents) | Official Docs | When to delegate search-heavy tasks |
| [Claude Code context window visualization](https://code.claude.com/docs/en/context-window) | Official Docs | Shows actual token cost of Glob/Grep/Read operations |
| [Ripgrep GUIDE.md](https://github.com/BurntSushi/ripgrep/blob/master/GUIDE.md) | Official Docs | Pattern syntax, type filters, output modes, context flags |
| [Ripgrep FAQ.md](https://github.com/BurntSushi/ripgrep/blob/master/FAQ.md) | Official Docs | Multiline mode, PCRE2, encoding, common errors |
| [Ripgrep homepage](https://burntsushi.net/ripgrep/) | Project Page | Design philosophy, why `.gitignore`-aware search matters |
| [Rust regex syntax](https://docs.rs/regex/latest/regex/) | Language Docs | Metacharacters, escaping, character classes used by ripgrep |
| [Aider repomap](https://aider.chat/docs/repomap.html) | Official Docs | Repo-map as an alternative to autonomous search |
| [Aider commands](https://aider.chat/docs/usage/commands.html) | Official Docs | `/add`, `/ls`, `/map`, `/read-only` slash-command model |
| [Aider tips](https://aider.chat/docs/usage/tips.html) | Official Docs | "Add the files you think need to be edited" philosophy |
| [Aider repomap.py source](https://github.com/Aider-AI/aider/blob/main/aider/repomap.py) | Source Code | Tree-sitter + PageRank implementation |
| [Cline tools guide](https://docs.cline.bot/exploring-clines-tools/cline-tools-guide) | Official Docs | `list_files`, `search_files`, `list_code_definition_names` |
| [Cline all tools reference](https://docs.cline.bot/tools-reference/all-cline-tools) | Official Docs | Complete tool surface including XML parameter shapes |
| [OpenCode docs](https://opencode.ai/docs/) | Official Docs | Open-source harness inspired by Claude Code |
| [OpenCode grep tool source](https://github.com/sst/opencode/blob/dev/packages/opencode/src/tool/grep.ts) | Source Code | Concrete implementation: rg-backed, 100-match cap, 2000-char line cap |
| [OpenCode glob tool source](https://github.com/sst/opencode/blob/dev/packages/opencode/src/tool/glob.ts) | Source Code | mtime-desc sort, 100-file cap |
| [Codex CLI repo](https://github.com/openai/codex) | Source Code | Shell-based approach, no dedicated search tools |
| [Codex CLI sandbox](https://developers.openai.com/codex/sandbox) | Official Docs | Pre-approved commands: `rg`, `ls`, `find`, `grep` |
| [Codex CLI config](https://github.com/openai/codex/blob/main/docs/config.md) | Official Docs | Tool approvals and MCP integration |
| [Anthropic: Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents) | Engineering Blog | Tool design principles — "treat tool definitions like docstrings" |
| [Anthropic: Multi-agent Research System](https://www.anthropic.com/engineering/multi-agent-research-system) | Engineering Blog | Delegation, fresh-context handoffs, memory for long searches |

---

*This guide was synthesized from 22 sources. See `resources/agent-search-tools-sources.json` for full source list with quality scores.*
