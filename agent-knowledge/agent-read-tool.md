# Learning Guide: Read Tool — Examples and Best Practices in AI Agent Harnesses

**Generated**: 2026-04-19
**Sources**: 20 resources analyzed
**Depth**: medium
**Scope**: How agent harnesses (Claude Code, Agent SDK, OpenAI Codex/Responses, Aider, OpenCode, Cline, Continue) expose file reading to LLMs, and the best practices, anti-patterns, and token budget implications.

## Prerequisites

- Basic familiarity with LLM tool / function calling (tool_use blocks, tool_result, JSON schemas)
- Understanding of the context window as a finite, auction-priced resource
- At least one agent harness installed (e.g. Claude Code, Aider, Cline, OpenCode, or Continue)
- Comfort with POSIX paths (absolute vs relative) and `.gitignore` semantics

## TL;DR

- Every agentic coding harness ships some form of "read a file" primitive, but the shapes differ: **Claude Code exposes a first-class `Read` tool with offset/limit**; **Codex CLI leans on a `shell`/bash tool** and lets the model run `sed`/`cat -n`; **Aider preloads files** via `/add` and `/read-only`; **Cline, OpenCode, and Continue each ship a dedicated `read_file` / `read` tool**.
- The single highest-leverage design decision Anthropic reports is **requiring absolute file paths**, after seeing relative paths produce tool-use mistakes (poka-yoke tool design).
- Context is the fundamental constraint. Every file you read is permanently billed against your window and degrades model performance as the window fills — use **Grep/Glob to locate, Read to inspect, and subagents to offload large reads**.
- For large files, always prefer **partial reads (offset/limit / line ranges)** over full-file reads. Re-reading the same file is an anti-pattern — it wastes tokens and signals a planning failure.
- For binary / PDF / notebook files, Claude Code's `Read` handles them natively (PDFs up to 20 pages per call, notebooks return cells with outputs, images render visually). Other harnesses typically require shelling out.

## Core Concepts

### 1. The Read Primitive Is a Tool, Not a File System Call

In every modern agent harness, "read a file" is exposed to the model as a **function-calling tool** (OpenAI) or **tool_use block** (Anthropic). The model emits a structured request, the harness executes the read, and the contents flow back in a `tool_result` block. The model never has direct filesystem access — this is the "tool-use contract" Anthropic's platform docs describe.

**Why this matters:** you can swap, augment, or restrict the Read tool (permissions, sandboxing, audit logging) without retraining the model. Anthropic specifically notes that its schema-trained tools (`bash`, `text_editor`) outperform custom equivalents because Claude has seen thousands of trajectories using those exact signatures.

### 2. Claude Code's `Read` Tool (Reference Implementation)

Claude Code exposes a dedicated `Read` tool with a tight, opinionated schema:

| Parameter | Required | Purpose |
|-----------|----------|---------|
| `file_path` | yes | **Absolute** path — not relative, not `~`-expanded |
| `offset` | no | 1-indexed line to start reading from (for large files) |
| `limit` | no | Number of lines to read; default reads up to ~2000 lines from start |
| `pages` | no (PDF only) | e.g. `"1-5"` or `"3"`; mandatory for PDFs > 10 pages; max 20 pages per call |

**Output format** is `cat -n` style: each line prefixed with its line number, starting at 1. This makes subsequent `Edit` calls (which require exact string matches plus context) dramatically more reliable — the model can anchor edits to line numbers it just saw.

**Special-file handling built in**:
- **Images** (PNG/JPG/...): rendered visually to the model (multimodal)
- **PDFs**: extracted text + images; must provide `pages` for large docs
- **Jupyter notebooks (.ipynb)**: returns all cells with their outputs, combining code, text, and visualizations
- **Empty files**: returns a system-reminder warning instead of empty content, so the model knows the file exists and is empty
- **Directories**: rejected — use a listing tool / `Glob` instead

### 3. OpenAI Codex / Responses API: Shell-First and Vector-First

The Responses API and Codex CLI take a different philosophical route:

- **`file_search` (server-executed)**: OpenAI indexes your files into a Vector Store (chunked + embedded). At query time, the model issues a semantic search and gets ranked chunks back with citations. Parameters include `vector_store_ids`, `max_num_results`, `filters`, and `ranking_options`. This is NOT a general-purpose "read this exact file" tool — it's retrieval-over-a-corpus.
- **`shell` / bash tool (Codex CLI)**: for direct file reads Codex relies on shelling out (`cat`, `sed -n '100,200p'`, `head`, `rg`). There is no dedicated `read_file` tool in the open-source Codex CLI; file I/O is orchestrated through a sandboxed shell.
- **`code_interpreter` file access**: files attached to a run can be read by executing Python inside the sandbox.

**Practical consequence:** Codex CLI behavior depends heavily on the model's bash fluency. Claude Code's first-class `Read` tool reduces this variance by giving one canonical path.

### 4. Aider: Preload, Don't Read-On-Demand

Aider does not expose a "Read this file mid-turn" tool at all. Instead, files enter the prompt via **user commands**:

| Command | Effect |
|---------|--------|
| `/add <file>` | Add a file to the chat so Aider can edit it |
| `/read-only <file>` | Add a file for reference only (no edits) |
| `/drop <file>` | Remove a file from context to free tokens |
| `/ls` | List currently included files |

File contents are wrapped in **fence markers** (triple backticks) with the relative path as a header — **no line numbers by default**. The `base_coder.py` logic shows that numbered-line formatting exists in the code but is commented out.

Aider compensates with a **repo map**: a compressed index of classes, function signatures, and references across the whole repo, defaulting to `--map-tokens=1k`. The LLM uses the map to *request* that the user `/add` a specific file when it needs the body.

**Trade-off**: Aider's model gets cleaner context (only user-blessed files) but can't autonomously pull a new file mid-edit. It's a human-in-the-loop curation model.

### 5. Cline: `read_file` with Multi-Layer Context Awareness

Cline ships a `read_file` tool taking a single file path, similar to Continue's. What's unique is the **multi-layer context evaluator** Cline uses to decide when to read:

- Paths explicitly mentioned in the user message (e.g. `src/services/user.ts`)
- Currently open editor tabs / visible files in active panes
- Files Cline has previously created or modified in the session
- Pending file operations

Cline also separates **Plan Mode** (read + search only, no writes) from **Act Mode** (full tool access), which is a structural way to force "read first, edit second." The docs explicitly recommend starting in Plan mode for unfamiliar code.

### 6. OpenCode: Permission-Gated `read` Tool

OpenCode's `read` tool supports line-range partial reads and is gated via `opencode.json` permissions:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "read": "allow"
  }
}
```

Permission values are `"allow"`, `"deny"`, or `"ask"`. OpenCode applies ripgrep-style `.gitignore` filtering by default, and ships role-specific agents — e.g. the read-only `Explore` subagent — for scoping. The built-in `Plan` mode restricts writes/bash but leaves read enabled.

### 7. Continue: `readFile` (Workspace-Scoped)

Continue's built-in `readFile` tool is a function-based tool with one parameter:

| Parameter | Type | Description |
|-----------|------|-------------|
| `filepath` | string | Relative path (from workspace root), absolute path, tilde (`~/...`), or `file://` URI |

Key properties: **readOnly**, **instant execution**, **allowed without permission by default**. Continue evaluates an `evaluateFileAccessPolicy` that normalizes the path and verifies it's within the workspace boundary — a concrete example of tool-level sandboxing.

### 8. Read vs Grep vs Glob: A Decision Framework

| Tool | Purpose | Token Cost | When to use |
|------|---------|-----------|-------------|
| **Glob** | Match file paths by pattern (`**/*.ts`) | Low (just paths) | You need a list of files, not their content |
| **Grep** | Search content with regex, return matches or file lists | Low–Medium | You need to find which files contain a symbol/string |
| **Read** | Fetch exact file contents (optionally partial) | Medium–High (entire file or slice) | You're ready to inspect or edit a specific file |

The Claude Code best-practices doc frames this as: *"infinite exploration"* (Read-first, no scope) is a named failure pattern. The disciplined loop is **Glob → Grep → Read (partial) → Edit**.

### 9. Partial Reads for Large Files

Reading a 10,000-line file when you need lines 400–500 wastes ~95% of the tokens you spent. Every harness with a dedicated read tool supports some form of partial read:

- **Claude Code `Read`**: `offset` + `limit` parameters
- **OpenCode `read`**: line-range parameters
- **Cline / Continue**: primarily full-file; use `search_files` / Grep first to locate, then read a narrower slice via shell
- **Codex/shell-based**: `sed -n '400,500p' file` or `awk 'NR>=400 && NR<=500'`
- **Aider**: no partial reads; excerpt manually into chat instead

Rule of thumb (from multiple sources): if a file is larger than ~1000 lines and you don't need all of it, **always** pass an offset/limit or Grep first.

### 10. Token Budget & Context Rot

Anthropic's Claude Code best-practices doc is blunt: *"Most best practices are based on one constraint: Claude's context window fills up fast, and performance degrades as it fills."* Their mental model:

- System prompt + auto memory + env info + tool schemas ~ **5–7k tokens** baseline
- Each file read is permanently billed against the window (no eviction short of compaction or `/clear`)
- Performance degrades well before the hard limit — rules start getting ignored when context is noisy
- Subagents are the primary escape valve: they explore in a separate context and return a **summary**, not raw file contents

Cline's docs describe the same constraint for a 200k budget: load only relevant rules/files, use conditional (glob-activated) rules rather than loading everything.

## Code Examples

### Example 1: Claude Code — Read with offset/limit on a large file

```python
# The model emits this tool_use block (shown in JSON form):
{
  "type": "tool_use",
  "name": "Read",
  "input": {
    "file_path": "/Users/jane/repo/src/server.py",
    "offset": 1200,
    "limit": 200
  }
}
```

The harness returns ~200 numbered lines starting at 1200, not the full 5k-line file.

### Example 2: Claude Code — Reading a PDF in chunks

```python
{
  "type": "tool_use",
  "name": "Read",
  "input": {
    "file_path": "/abs/path/to/spec.pdf",
    "pages": "1-5"
  }
}
# Next turn, read pages 6-10, etc. NEVER try to read a 200-page PDF in one call.
```

### Example 3: Continue — `readFile` tool schema

```json
{
  "name": "readFile",
  "description": "Use this tool if you need to view the contents of an existing file.",
  "parameters": {
    "type": "object",
    "properties": {
      "filepath": {
        "type": "string",
        "description": "Relative (workspace), absolute, tilde, or file:// URI"
      }
    },
    "required": ["filepath"]
  }
}
```

### Example 4: Codex CLI — Reading a slice via shell

```bash
# The model emits a shell tool_call; the harness runs:
sed -n '400,500p' src/auth/session.ts
# or with line numbers:
awk 'NR>=400 && NR<=500 {printf "%5d\t%s\n", NR, $0}' src/auth/session.ts
```

### Example 5: Aider — Preloading files via user commands

```bash
# User (not the model) curates context:
/add src/auth/session.ts
/read-only docs/auth-spec.md
/drop src/legacy/old_auth.ts  # free up tokens when done
```

### Example 6: Claude Code — Delegate a large read to a subagent

```markdown
Use subagents to investigate how our authentication system handles
token refresh, and whether we have any existing OAuth utilities I
should reuse.
```

The subagent reads 15 files in its own context window and returns a ~500-token summary. Your main context stays clean for implementation.

### Example 7: OpenCode — Scoping the Read permission

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "read": "allow",
    "edit": "ask",
    "bash": { "git *": "ask", "rm *": "deny" }
  }
}
```

## Common Pitfalls

| Pitfall | Why It Happens | How to Avoid |
|---------|---------------|--------------|
| **Reading the whole repo** | Model has no scoping; treats "explore" as "dump everything" | Scope the task, use Glob/Grep first, delegate to a subagent |
| **Reading the same file twice in a session** | Model forgot earlier content, or context was polluted | `/clear` + smaller focused prompt; don't re-read, re-prompt |
| **Using bash `cat` instead of the Read tool (Claude Code)** | Training bias toward POSIX commands | Prefer the first-class Read tool — it gives line numbers that Edit needs |
| **Full read on a 10k-line file** | Lazy: no offset/limit | Always Grep first for the relevant line range |
| **Passing relative paths** | Model's default instinct | Enforce absolute paths in the tool schema (Anthropic's own engineering lesson) |
| **Reading PDFs > 10 pages at once** | Model tries to bulk-ingest | Require `pages` parameter; chunk into 5–10 page ranges |
| **Letting context "accumulate" across unrelated tasks** | No `/clear` discipline | Clear between tasks; treat sessions like branches |
| **Aider: editing a new file before `/add`** | Aider won't know the file exists | Pre-create + `/add` before asking for edits |
| **Trying to read a directory with Read** | Confused with `ls` | Use Glob/`list_directory`/shell instead |
| **Fetching file content to answer a question Grep can answer** | Over-eager reading | Ask "do I need the full contents or just the matches?" |
| **OpenAI `file_search` for exact-file reads** | Wrong tool: semantic retrieval, not precise I/O | Use shell/code_interpreter for precise reads; file_search for "find relevant passages" |

## Best Practices

Synthesized from 20 sources:

1. **Require absolute paths in your tool schema.** Anthropic reports measurable accuracy wins. Poka-yoke: make wrong inputs impossible. (Source: *Building Effective Agents*)
2. **Emit `cat -n` style line-numbered output.** Downstream Edit/Patch tools need exact anchors; line numbers make them robust. (Source: Claude Code `Read` implementation)
3. **Treat every file read as permanent context cost.** It never evicts short of compaction. (Source: Claude Code best-practices)
4. **Funnel: Glob → Grep → Read (partial) → Edit.** Don't Read-first. (Source: Claude Code common-workflows)
5. **Always offer `offset`/`limit` (or equivalent) on your read tool.** For any file over ~1000 lines, partial reads are a 10–100x token win. (Source: OpenCode, Claude Code)
6. **Delegate large explorations to subagents.** The subagent reads, summarizes, returns; main context stays clean. (Source: Claude Code subagents)
7. **Handle images, PDFs, and notebooks natively if you can.** Otherwise the model will pipe them through clumsy shell tools. (Source: Claude Code `Read`)
8. **Use Plan Mode (or equivalent read-only mode) for unfamiliar codebases.** Prevents destructive edits before understanding. (Source: Cline, Claude Code, OpenCode)
9. **Gate Read with permissions, not just trust.** `allow`/`ask`/`deny` per-tool, plus workspace-boundary enforcement. (Source: OpenCode, Continue)
10. **`.gitignore`-aware by default.** Avoid leaking `node_modules`, `.env`, build artifacts into context. (Source: OpenCode uses ripgrep filtering)
11. **Clear the context between unrelated tasks.** A clean session with a sharp prompt beats a long one. (Source: Claude Code best-practices)
12. **Return a system-reminder for empty files.** Otherwise the model assumes a tool failure and retries. (Source: Claude Code `Read` behavior)
13. **Reject directory paths at tool level.** Force the caller to use a listing tool — clearer intent, cleaner context. (Source: Claude Code `Read`)
14. **Prefer purpose-built tools over shell for common ops.** Anthropic-schema tools outperform custom equivalents because the model is trained on their exact shapes. (Source: Tool Use docs)
15. **For RAG-style reads, use `file_search` / vector stores; for precise reads, use a file tool.** Don't conflate retrieval with I/O. (Source: OpenAI file_search docs)

## Quick Reference: Harness-by-Harness

| Harness | Read tool | Partial read | Special files | Path policy |
|---------|-----------|--------------|---------------|-------------|
| Claude Code | `Read` | `offset`/`limit`, `pages` for PDF | Image, PDF (20pg max), .ipynb, empty-file reminder | **Absolute only** |
| Claude Agent SDK | Same `Read` tool (client-executed, Anthropic-schema) | Same | Same | Absolute |
| OpenAI Codex CLI | Shell/bash (no dedicated read) | `sed -n 'A,Bp'` | Manual (shell tools) | Relative or absolute |
| OpenAI Responses API | `file_search` (retrieval) + `code_interpreter` (sandboxed read) | Chunk-based | Via code_interpreter | N/A (vector store IDs) |
| Aider | `/add`, `/read-only`, `/drop` (user-driven) | No (manual excerpt) | Images base64-encoded | Relative, git-tracked |
| Cline | `read_file` | Full file; use `search_files` to scope | Limited | Relative workspace |
| OpenCode | `read` | Line ranges | ripgrep filtering; AGENTS.md preloaded | Workspace-scoped |
| Continue | `readFile` | Full file (as of main) | Workspace-boundary check | Relative/abs/tilde/URI |

## Further Reading

| Resource | Type | Why Recommended |
|----------|------|-----------------|
| [Claude Code best practices](https://code.claude.com/docs/en/best-practices) | Official Docs | Definitive guide on context management and when to Read vs Grep/Glob |
| [Claude Code context-window walkthrough](https://code.claude.com/docs/en/context-window) | Interactive | See exactly what each Read costs against the 200k window |
| [Tool use with Claude](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview) | Official Docs | The tool-use contract: tool_use / tool_result loop |
| [How tool use works](https://platform.claude.com/docs/en/agents-and-tools/tool-use/how-tool-use-works) | Conceptual | User-defined vs Anthropic-schema vs server tools |
| [Building Effective Agents (Anthropic)](https://www.anthropic.com/engineering/building-effective-agents) | Research Post | Origin of the absolute-path rule; poka-yoke tool design |
| [Create custom subagents](https://code.claude.com/docs/en/sub-agents) | Official Docs | Delegating reads to keep main context clean |
| [Aider repo map](https://aider.chat/docs/repomap.html) | Official Docs | How Aider compresses whole-repo awareness without reading everything |
| [Aider tips](https://aider.chat/docs/usage/tips.html) | Official Docs | Context curation discipline |
| [OpenCode tools](https://opencode.ai/docs/tools) | Official Docs | `read`/`grep`/`glob` trio with permission gating |
| [OpenCode agents](https://opencode.ai/docs/agents/) | Official Docs | Role-scoped permissions (Plan vs Build vs Explore) |
| [Continue built-in tools source](https://github.com/continuedev/continue/blob/main/core/tools/definitions/readFile.ts) | Source Code | Concrete `readFile` tool definition |
| [Cline tools guide](https://docs.cline.bot/exploring-clines-tools/cline-tools-guide) | Official Docs | `read_file` + `search_files` partnership |
| [Cline Plan vs Act](https://docs.cline.bot/features/plan-and-act) | Official Docs | Read-only mode pattern for safe exploration |
| [Cline prompt engineering](https://docs.cline.bot/prompting/prompt-engineering-guide) | Official Docs | Multi-layer context evaluator |
| [OpenAI Agents SDK tools](https://openai.github.io/openai-agents-python/tools/) | Official Docs | `FileSearchTool` vs custom function tools |
| [Claude Code overview](https://code.claude.com/docs/en/overview) | Official Docs | How Read fits into Claude Code's overall agent loop |
| [Claude Code settings](https://code.claude.com/docs/en/settings) | Official Docs | Permission scopes for Read and other tools |

---

*This guide was synthesized from 20 sources. See `resources/agent-read-tool-sources.json` for full source metadata with quality scores.*
