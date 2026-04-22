# Learning Guide: Harness Tool-Surface Audit — the "what ships with what" matrix

**Generated**: 2026-04-20
**Sources**: 22 resources analyzed
**Depth**: medium
**Scope**: For every major agent harness and tool library, what tools are exposed to the model. Used to decide the next tool for the `@agent-sh/harness-*` library.

## What this guide is (and isn't)

This guide is a **cross-harness inventory**, not a deep dive on any single tool. It answers:

- What tools does harness X actually ship?
- Which capabilities are table stakes (shipped by everyone)?
- Which are harness-specific innovations?
- Where are the gaps in the ecosystem?

For deep dives on individual tools, see:

- `agent-read-tool.md` — Read across harnesses
- `agent-search-tools.md` — Glob + Grep overview
- `glob-impl-and-prompts-in-major-tools.md` — Glob specifically, schema-level
- `agent-write-edit-tools.md` — Write/Edit in closed-ecosystem harnesses
- `agent-write-across-ecosystems.md` — Write across the full ecosystem
- `ai-agent-harness-tooling.md` — harness architecture, not the tool list

**Ground rule**: tool names are verified from 2026 source-of-truth docs (linked in `resources/harness-tool-surface-audit-sources.json`). Where a harness has evolved recently, the 2026 tool list is what you read here, not older blog posts.

## TL;DR — headline findings

- **Table-stakes core (everyone):** read file, write file, edit-in-place, list dir or glob-files, grep-file-contents, run-shell, web-fetch, ask-user, finish/complete. If a harness doesn't ship all nine, you can almost certainly name the one(s) it skips on purpose (Aider skips most because it doesn't use function calling at all).
- **Claude Code is a dramatic outlier** in *breadth* — 30+ built-in tools in 2026 (Agent, Monitor, LSP, PowerShell, CronCreate/List/Delete, TaskCreate/Get/List/Update/Stop, TeamCreate, EnterWorktree, SendMessage, AskUserQuestion, ExitPlanMode, Skill, ToolSearch, ListMcpResourcesTool, ReadMcpResourceTool, ExitPlanMode, TodoWrite, NotebookEdit, plus Read/Write/Edit/Glob/Grep/Bash/BashOutput/WebFetch/WebSearch). No other single harness comes close.
- **Codex CLI is the opposite outlier** in *minimalism* — ~6 tools total (`shell`, `apply_patch`, `update_plan`, `view_image`, `write_stdout`, `web_search`). Everything else routes through `shell`. This is intentional; see the Codex column.
- **MCP is where the ecosystem gets interesting.** MCP filesystem alone exposes 13+ tools (`read_text_file`, `read_media_file`, `read_multiple_files`, `write_file`, `edit_file`, `create_directory`, `list_directory`, `list_directory_with_sizes`, `directory_tree`, `move_file`, `search_files`, `get_file_info`, `list_allowed_directories`). MCP git has 12. MCP GitHub (archived) had 26. Bedrock AgentCore Gateway turns any OpenAPI/Lambda into MCP tools.
- **Capability-level universality** (rough order, high to low):
  1. **Read file** — *every* harness ships this (even Codex via `shell cat`).
  2. **Shell/bash** — every harness ships it (Claude Code, Codex, OpenCode, Cline, Cursor, Gemini CLI, OpenHands, Continue, MCP via separate server). Aider exposes it as `/run` (user-facing).
  3. **Edit file** — universal, but the *shape* fragments wildly: `str_replace`, `apply_patch`, search-replace blocks, unified diff, `MultiEdit`, `replace_in_file`, `applyToolOverrides`/`editFile`, etc.
  4. **Glob / find-files** — shipped by Claude Code, OpenCode, Gemini CLI, Continue, Cline (`list_files`), MCP filesystem (`search_files`), LangChain (`FileSearchTool`). Codex deliberately doesn't ship it (routes through `rg --files -g`).
  5. **Grep / content search** — Claude Code, OpenCode, Gemini CLI, Continue, Cline (`search_files`), Cursor (`semantic_search` + `search_files_and_folders`). MCP doesn't have a first-class grep tool; you're expected to run one via shell MCP or filesystem `search_files` (glob-style).
  6. **Web fetch** — Claude Code, OpenCode, Cursor, Cline, Gemini CLI, Continue, MCP `fetch` server, LangChain, Pydantic-AI.
  7. **Web search** — Claude Code, OpenCode (Exa), Cursor, Gemini CLI (`google_web_search`), Codex (cached by default, live with `--search`), Pydantic-AI (`duckduckgo_search_tool`, `tavily_search_tool`, `exa_*`).
  8. **Ask user / human-in-loop** — Claude Code (`AskUserQuestion`), Cline (`ask_followup_question`), Cursor (`Ask Questions`), OpenCode (`question`), Gemini CLI (`ask-user`), Roo (`ask_followup_question`), OpenHands (CodeAct `Converse`).
  9. **Finish / complete** — Cline (`attempt_completion`), Roo (`attempt_completion`), OpenHands (`finish`), Gemini CLI (`complete-task`), SWE-agent (`submit`). Claude Code uses `stop_reason: "end_turn"` instead of a tool.
- **Non-universal but important capabilities:**
  - **Subagent / Task delegation** — Claude Code (`Agent`), OpenAI Agents SDK (`Agent.as_tool()`), Cline (`new_task`), Roo (`new_task`, `switch_mode`), OpenCode (`task` tool in older versions), Codex (experimental `codex_tool` for spawning workspace-scoped Codex sessions).
  - **Plan mode** — Claude Code (`EnterPlanMode`, `ExitPlanMode`), Cline (Plan/Act modes as operational modes not tools, `plan_mode_respond`), Gemini CLI (`enter-plan-mode`, `exit-plan-mode`), Roo (Architect mode), Aider (`/architect` command).
  - **Todo list / focus chain** — Claude Code (`TaskCreate/Get/List/Update` plus deprecated `TodoWrite`), OpenCode (`todowrite`), Roo (`update_todo_list`), Gemini CLI (`write-todos`), Cline (focus chain).
  - **Browser control** — Cline (`browser_action`), Cursor (`Browser`), Bedrock AgentCore (Browser service), MCP Playwright server (tool pack not included here).
  - **Image generation** — Claude Code (not native; via MCP), Cursor (`Image Generation`), Codex (via image gen tool), Roo (`generate_image`), OpenAI Agents SDK (`ImageGenerationTool`).
  - **Memory / knowledge graph** — Claude Code via `Skill`/filesystem conventions, Gemini CLI (`save_memory`), OpenAI Agents SDK (via sessions), MCP memory server (knowledge-graph API), Bedrock AgentCore Memory.
  - **LSP / code intelligence** — Claude Code (`LSP`), OpenCode (`lsp`, experimental). Nobody else ships this as a first-class tool, even though it's arguably the highest-leverage tool an agent can have.
  - **Worktree / isolation** — Claude Code (`EnterWorktree`, `ExitWorktree`). Nobody else.
  - **Notebook edit** — Claude Code (`NotebookEdit`). Nobody else.
  - **Cron / scheduled task** — Claude Code (`CronCreate`, `CronList`, `CronDelete`). Nobody else.
  - **Agent teams / peer messaging** — Claude Code (`SendMessage`, `TeamCreate`, `TeamDelete` — experimental).
- **Aider is a deliberate outlier**: it exposes ~0 model-facing tools in the JSON-schema sense. All "tools" are user-facing slash commands (`/add`, `/drop`, `/read-only`, `/run`, `/test`, `/lint`, `/commit`, `/web`, `/architect`, `/code`, `/ask`, `/undo`, `/diff`, `/git`, `/tokens`, `/clear`, `/reset`). The model emits diff/search-replace blocks in free text; the harness parses them. This is the canonical "no-function-calling" harness.
- **AutoGPT is a legacy outlier**. Classic AutoGPT had file read/write/append/list/delete, web search, browse website, Python exec, shell exec, image gen, write_tests, improve_code. The *new* AutoGPT Platform is a block-based integration catalog (Firecrawl, Jina, Exa, GitHub, Google Docs, Notion, Discord, …) rather than a local agent harness. If "AutoGPT" is the reference in 2026, it's the platform.
- **SWE-agent / OpenHands / Gemini CLI fill different niches.** SWE-agent's ACI is narrow and benchmark-tuned (open/goto/edit/scroll/search_dir/search_file/find_file/create/submit). OpenHands' CodeActAgent uses Python/bash as the action space plus `str_replace_editor`, `browse`, `web_read`, `finish`, `think`. Gemini CLI is the tool-rich Google-side equivalent of Claude Code.

## The big matrix

Rows are **capability**. Columns are **harness**. Cells are the tool name if shipped, **—** if absent, **(MCP)** if delegated to MCP, and **(shell)** if the harness expects the model to route through shell for that capability.

### Harness columns (short codes)

| Code | Harness |
|------|---------|
| **CC** | Claude Code (anthropics/claude-code, 2026 tool-reference) |
| **CASDK** | Claude Agent SDK (TS + Python, ships same tools as CC; subset is default) |
| **CXCLI** | Codex CLI (openai/codex) |
| **OAISDK** | OpenAI Agents SDK (Python/TS) |
| **OC** | OpenCode (sst/opencode) |
| **CLN** | Cline |
| **ROO** | Roo Code |
| **CUR** | Cursor agent mode |
| **AID** | Aider (user-facing only; not model tools) |
| **CNT** | Continue.dev agent mode |
| **OH** | OpenHands (CodeActAgent) |
| **SWE** | SWE-agent |
| **GEM** | Gemini CLI |
| **MCP-FS** | MCP filesystem reference server |
| **MCP-G** | MCP git reference server |
| **MCP-GH** | MCP GitHub server (archived — listed for reference) |
| **LC** | LangChain FileManagementToolkit + common tools |
| **CREW** | CrewAI tools |
| **AGP** | AutoGPT (classic + platform blocks) |
| **AGC** | Amazon Bedrock AgentCore |
| **PAI** | Pydantic-AI common tools |

### Filesystem capabilities

| Capability | CC | CASDK | CXCLI | OAISDK | OC | CLN | ROO | CUR | CNT | OH | SWE | GEM | MCP-FS | LC | CREW | AGC |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Read file (text) | `Read` | `Read` | (shell) | — (user-defined) | `read` | `read_file` | `read_file` | `Read Files` | `readFile` / `readFileRange` / `readCurrentlyOpenFile` | (CodeAct: `str_replace_editor view`) | `open` + `goto` + `scroll_*` | `read_file` / `read_many_files` | `read_text_file`, `read_multiple_files` | `ReadFileTool` | `FileReadTool` | (Code Interpreter FS) |
| Read image/binary | `Read` | `Read` | `view_image` | (user) | `read` | `read_file` | `read_file` | `Read Files` (vision) | `readFile` | (browse) | — | `read_file` | `read_media_file` | — | — | (Code Interpreter) |
| Read notebook | `NotebookEdit`/legacy `NotebookRead` | same | (shell) | — | — | `read_file` | `read_file` | `Read Files` | `readFile` | — | — | — | — | — | — | — |
| Write file (create/overwrite) | `Write` | `Write` | `apply_patch` *(add file via patch)* | (user) | `write` | `write_to_file` | `write_to_file` | `Edit Files` | `createNewFile` | `str_replace_editor create` | `create` | `write_file` | `write_file` | `WriteFileTool` | `FileWriterTool` | (Code Interp) |
| Edit file (targeted) | `Edit` | `Edit` | `apply_patch` | (user) + `ApplyPatchTool` | `edit`, `apply_patch` | `replace_in_file` | `apply_diff`, `edit_file`, `search_replace`, `apply_patch` | `Edit Files` | `editFile`, `singleFindAndReplace`, `multiEdit` | `str_replace_editor str_replace` | `edit` (N:M line syntax) | `edit` | `edit_file` | — | — | — |
| Multi-file edit | *(legacy `MultiEdit`; now use `Edit` loop)* | same | `apply_patch` (multi) | `ApplyPatchTool` | `multiedit` (compat) | (loop) | `apply_patch` | `Edit Files` | `multiEdit` | (loop) | (loop) | `edit` (multi) | `edit_file` (array of edits) | — | — | — |
| List directory | `Glob` / (shell) | `Glob` | (shell) | — | (shell) / `glob` | `list_files` | `list_files` | `Search Files and Folders` | `ls` | (shell) | (shell) | `list_directory` / `ls` | `list_directory`, `list_directory_with_sizes`, `directory_tree` | `ListDirectoryTool` | `DirectoryReadTool` | — |
| Glob / find files by pattern | `Glob` | `Glob` | (shell: `rg --files -g`) | — | `glob` | `list_files`+`search_files` (combo) | `list_files` | `Search Files and Folders` | `globSearch` | `find_file` (legacy) | `find_file` | `glob` | `search_files` (glob-style) | `FileSearchTool` | — | — |
| Grep / content search | `Grep` | `Grep` | (shell: `rg`) | — | `grep` | `search_files` | `search_files` | `Search Files and Folders` | `grepSearch` | (shell) | `search_dir` / `search_file` | `grep` / `ripGrep` / `search_file_content` | — | — | — | — |
| Semantic / embedding search | (via MCP) | (via MCP) | — | `FileSearchTool` (vector store) | — | — | `codebase_search` | `Semantic Search` | `codebaseTool` | — | — | — | — | — | (RAG Tool) | (Bedrock Knowledge Bases) |
| Copy / move / delete file | (shell) | (shell) | (shell/apply_patch) | — | (shell) | (shell) | (shell) | — | — | (shell) | — | (shell) | `move_file` | `CopyFileTool`, `MoveFileTool`, `DeleteFileTool` | — | — |
| Create directory | (shell) | (shell) | (shell) | — | (shell) | (shell) | (shell) | — | — | (shell) | — | (shell) | `create_directory` | — | — | — |
| File metadata (stat) | (shell) | (shell) | (shell) | — | (shell) | (shell) | (shell) | — | — | (shell) | — | (shell) | `get_file_info` | — | — | — |
| LSP / code intelligence | `LSP` | `LSP` | — | — | `lsp` (experimental) | — | — | (indexer) | — | — | — | — | — | — | — | — |

### Execution capabilities

| Capability | CC | CASDK | CXCLI | OAISDK | OC | CLN | ROO | CUR | CNT | OH | SWE | GEM | MCP-FS | LC | CREW | AGC |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Run shell / bash | `Bash` | `Bash` | `shell` / `container.exec` | `ShellTool`, `LocalShellTool` | `bash` | `execute_command` | `execute_command` | `Run Shell Commands` | `runTerminalCommand` | (CodeAct `execute_bash`) | `bash` (impl) | `run_shell_command` / `shell` | — (separate server) | (Shell in langchain.community.tools) | (Code Interpreter Tool) | (Code Interpreter) |
| Run PowerShell | `PowerShell` (preview) | same | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| Background/monitor proc | `Monitor` (Claude Code v2.1.98+), `BashOutput`, `KillShell` (deprecated `KillBash`) | `Monitor` | (shell `&`) | — | `shellBackgroundTools` (Gemini) | (shell `&`) | `read_command_output` | (terminal monitor) | — | (shell) | — | `shellBackgroundTools` | — | — | — | (Runtime) |
| Python code exec | (via `Bash`) | (via `Bash`) | (shell) | `CodeInterpreterTool` | (shell) | (shell) | (shell) | (shell) | (shell) | (CodeAct `IPythonRunCellAction`) | (bash) | (shell) | — | — | `Code Interpreter Tool` | `Code Interpreter` |
| Browser automation | (via MCP Playwright) | (via MCP) | — | `ComputerTool` | — | `browser_action` | (via MCP) | `Browser` | — | `BrowseURLAction`, `BrowseInteractiveAction` | — | — | — | — | (Scrape Website) | `Browser` |
| GUI / computer use | — | — | — | `ComputerTool` | — | — | — | — | — | — | — | — | — | — | — | — |

### Web / network capabilities

| Capability | CC | CASDK | CXCLI | OAISDK | OC | CLN | ROO | CUR | CNT | OH | SWE | GEM | MCP-FS | LC | CREW | PAI | AGC |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Fetch URL | `WebFetch` | `WebFetch` | — (shell) | — (user-defined) | `webfetch` | (via MCP) | (via MCP) | — | `fetchUrlContent` | `web_read` | — | `web_fetch` | (MCP fetch server) | — | `Scrape Website` | `web_fetch_tool` | — |
| Search the web | `WebSearch` | `WebSearch` | `web_search` | `WebSearchTool` | `websearch` (Exa) | (via MCP) | (via MCP) | `Web` | `searchWeb` | (shell) | — | `google_web_search` / `web-search` | — | — | `SerperDevTool`, `WebsiteSearchTool` | `duckduckgo_search`, `tavily_search`, `exa_*` | — |

### Coordination / orchestration capabilities

| Capability | CC | CASDK | CXCLI | OAISDK | OC | CLN | ROO | CUR | CNT | OH | SWE | GEM | MCP-FS | LC | CREW | AGC |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Spawn subagent | `Agent` | `Agent` | `codex_tool` (exp.) | `Agent.as_tool()` | (legacy `task`) | `new_task` | `new_task` | — | — | `AgentDelegateAction` | — | — | — | — | — | — |
| Peer-to-peer agent msg | `SendMessage` (exp.) | `SendMessage` | — | (handoffs) | — | — | — | — | — | — | — | — | — | — | — | — |
| Create agent team | `TeamCreate` (exp.) | same | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| Plan mode / planning tool | `EnterPlanMode`, `ExitPlanMode` | same | `update_plan` | — | — | `plan_mode_respond` | (via mode switch) | — | — | (think) | — | `enter-plan-mode`, `exit-plan-mode` | — | — | — | — |
| Mode switch | — | — | — | — | — | (operational) | `switch_mode` | — | — | — | — | — | — | — | — | — |
| Todo / task list | `TaskCreate`, `TaskGet`, `TaskList`, `TaskUpdate`, `TaskStop` (+ deprecated `TodoWrite`) | same | (`update_plan` is partial) | — | `todowrite` | (focus chain) | `update_todo_list` | — | — | — | — | `write-todos` | — | — | — | — |
| Cron / scheduled task | `CronCreate`, `CronList`, `CronDelete` | same | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| Worktree / isolation | `EnterWorktree`, `ExitWorktree` | — (CLI-only) | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| Ask user clarification | `AskUserQuestion` | `AskUserQuestion` | (via stop) | — | `question` | `ask_followup_question` | `ask_followup_question` | `Ask Questions` | — | (Converse) | — | `ask-user` | — | — | — | — |
| Finish / complete | (end_turn) | (end_turn) | (end_turn) | (end_turn) | (end_turn) | `attempt_completion` | `attempt_completion` | (end_turn) | (end_turn) | `finish` | `submit` | `complete-task` | — | — | — | — |
| Think / reasoning scratch | (native thinking) | (native) | (native) | (native) | — | — | — | — | — | `AgentThinkAction` | — | — | — | — | — | — |

### Extension / discovery capabilities

| Capability | CC | CASDK | CXCLI | OAISDK | OC | CLN | ROO | CUR | CNT | OH | SWE | GEM | MCP-FS | LC | CREW | AGC |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Skill execution | `Skill` | `Skill` | — | — | `skill` | — | `skill` | — | `readSkill` | — | — | `activate-skill` | — | — | — | — |
| Memory / persistence | (`Skill`/files) | same | — | — | — | — | — | — | — | — | — | `save_memory` | — | — | — | `Memory` service |
| Create rule block | — | — | — | — | — | — | — | `Fetch Rules` | `createRuleBlock`, `requestRule` | — | — | — | — | — | — | — |
| View diff | (via `Bash git diff`) | same | — | — | (via bash) | (UI) | (UI) | (UI) | `viewDiff` | — | — | — | — | — | — | — |
| View repo map | (via `Bash` or subagent) | same | — | — | — | (UI) | (UI) | (UI) | `viewRepoMap`, `viewSubdirectory` | — | — | — | — | — | — | — |
| Discover MCP resources | `ListMcpResourcesTool`, `ReadMcpResourceTool` | same | (via `mcp-client`) | `HostedMCPTool` | (via config) | `use_mcp_tool`, `access_mcp_resource`, `load_mcp_documentation` | `use_mcp_tool`, `access_mcp_resource` | (via config) | (via config) | (via config) | — | `list-mcp-resources`, `read-mcp-resource`, `mcp-tool`, `mcp-client` | — | — | — | `Gateway` |
| Dynamic tool loading | `ToolSearch` | `ToolSearch` | — | `ToolSearchTool`, `defer_loading` flags | — | — | — | — | — | — | — | — | — | — | — | — |
| Image generation | (via MCP) | same | (image gen) | `ImageGenerationTool` | — | — | `generate_image` | `Image Generation` | — | — | — | — | — | — | (DALL-E) | — |
| Code exec sandbox | (via `Bash`, `/sandbox`) | same | (WorkspaceWrite sandbox) | `CodeInterpreterTool` | (bash) | (exec_command) | (exec_command) | (shell) | (terminal) | (CodeAct) | (bash) | (shell) | — | — | `Code Interpreter Tool` | `Code Interpreter` |
| Knowledge base / RAG | (via MCP) | same | — | `FileSearchTool` | — | — | — | (indexer) | `codebaseTool` | — | — | — | — | — | `RAG Tool` | `Knowledge Bases` |

### "Bundled services" capabilities — only in platform-style offerings

These are capabilities a **platform** provides alongside tools, not really tools per se. Included for completeness.

| Capability | Claude Code | OpenAI Agents SDK | Bedrock AgentCore | Others |
|---|---|---|---|---|
| Managed runtime | — | (managed via Responses API state) | **Runtime** | — |
| Managed memory | (filesystem/Skill) | (Sessions) | **Memory** | — |
| Managed browser | (via MCP Playwright) | `ComputerTool` | **Browser** | — |
| Managed identity / OAuth | — | — | **Identity** | — |
| Managed observability | (`/tracing` + external) | (Tracing) | **Observability** | — |
| Gateway (any API → tool) | (via MCP) | (via MCP) | **Gateway** | — |

## Secondary analysis

### Which capabilities are universally shipped?

These capabilities appear as a first-class tool (or an intentional non-tool primitive, noted) in **nearly every** harness:

1. **Read file** — universal. Codex is the only mainstream harness that doesn't have a dedicated `Read` tool and intentionally routes through `shell cat`; it's still "universal" in that the capability is available, the interface is just different.
2. **Write file** — universal. Codex gets it via `apply_patch` (a `*** Add File:` directive creates the file). Everyone else has a dedicated `write`.
3. **Edit file** — universal. The shape diverges more than any other capability (see next section).
4. **Run shell** — universal except Aider (where `/run` is a user-facing slash command, not a model tool). Even the frameworks that nominally only give you "abstractions" (CrewAI, LangChain) expose a shell via `langchain_community.tools.shell`.
5. **Finish / stop turn** — universal, but split roughly 50/50 between "tool-based finish" (Cline `attempt_completion`, OpenHands `finish`, SWE-agent `submit`, Gemini CLI `complete-task`) and "stop_reason finish" (Claude Code, OpenAI Agents SDK, Codex, OpenCode, Cursor).

The four "almost-universal" capabilities:

6. **Grep / content search** — shipped by Claude Code, OpenCode, Gemini CLI, Continue, Cline, Roo. Not shipped as a first-class tool by Codex (shell routes), MCP filesystem (glob only), Aider (user-facing `/add` imports), OpenHands (shell routes), SWE-agent (`search_dir`/`search_file` do this).
7. **Glob / find files** — shipped by Claude Code, OpenCode, Gemini CLI, Continue, MCP filesystem, Cline (`list_files` with recursion covers this). Not shipped by Codex (shell `rg --files -g`), Cursor (merged with semantic search), Aider.
8. **Web fetch** — shipped by Claude Code, OpenCode, Cursor, Gemini CLI, Continue, MCP fetch, OpenHands, LangChain, Pydantic-AI. Not shipped by Codex (shell `curl`), Cline (MCP only), Roo (MCP only), SWE-agent.
9. **Ask user** — shipped by Claude Code, OpenCode, Cline, Roo, Cursor, Gemini CLI, OpenHands. Not shipped by Codex (structural — the model just stops), OpenAI Agents SDK (handled at runner level), Aider (whole UX is chat).

### Which capabilities are Claude Code-only?

As of the 2026 tool reference, Claude Code uniquely ships:

- **`Monitor`** — watch a background command and feed each output line back to the model (v2.1.98+). Nobody else has this shape; Continue has a "background process" surface but not as a model tool.
- **`CronCreate`, `CronList`, `CronDelete`** — session-scoped recurring prompts. No other harness has this.
- **`EnterWorktree` / `ExitWorktree`** — first-class git worktree tool. Every other harness treats worktrees as a shell operation.
- **`LSP`** — language-server integration as a native tool. OpenCode has an experimental `lsp` tool; nobody else treats LSP as a tool.
- **`TeamCreate` / `TeamDelete` / `SendMessage`** — agent-teams (experimental). Nobody else has peer-to-peer agent messaging as a tool.
- **`PowerShell`** — preview on non-Windows; Windows-native. Nobody else has a non-Bash shell tool.
- **`Skill`** — a tool that invokes a Markdown-defined "skill." OpenCode and Gemini CLI ship something similar; the in-tool shape differs.
- **`NotebookEdit`** — the cell-level Jupyter editor. Nobody else has a native cell-granularity notebook tool (OpenHands can do it via `str_replace_editor` on the `.ipynb` JSON, which is brittle).
- **`EnterPlanMode` / `ExitPlanMode`** — Gemini CLI has the same pair; nobody else.
- **`ListMcpResourcesTool` / `ReadMcpResourceTool`** — dedicated MCP resource-read tools. Gemini CLI has `list-mcp-resources`/`read-mcp-resource`; nobody else.
- **`ToolSearch`** — deferred-tool loading as a tool. OpenAI Agents SDK has `ToolSearchTool`; nobody else.

### Which capabilities are only in MCP?

These are capabilities that, if you want them, the recommended path is "install an MCP server":

- **git operations** (`git status/diff/log/commit/…`) — MCP git server. None of the harnesses ship these as first-class tools; they all expect you to either use `Bash` with `git` or install the git MCP server.
- **Structured knowledge graph memory** — MCP memory server (entities/relations/observations). Gemini CLI has `save_memory` which is structurally different (key/value).
- **Time / timezone** — MCP time server. No harness ships this.
- **SQL / database** — MCP postgres/sqlite (archived but still widely used). No harness ships SQL as a first-class tool.
- **GitHub API operations** (26 tools including PR/issue/branch/file/search operations) — MCP GitHub server. The harness alternative is `Bash` + `gh` CLI, which is what Claude Code, OpenCode, and Gemini CLI effectively recommend.

### Which tools have the same shape but different names?

These are "rename-only" divergences — the schema is the same across harnesses, just the tool name differs.

| Capability | Names across harnesses |
|---|---|
| Read a file | `Read` (CC), `read_file` (Cline, Roo, Gemini CLI, Continue), `read` (OpenCode), `read_text_file` (MCP-FS), `ReadFileTool` (LangChain), `FileReadTool` (CrewAI), `Read Files` (Cursor), `open` (SWE-agent), `readCurrentlyOpenFile` (Continue variant) |
| Write a file | `Write` (CC), `write_to_file` (Cline, Roo), `write` (OpenCode), `write_file` (Gemini CLI, MCP-FS), `createNewFile` (Continue), `create` (SWE-agent), `WriteFileTool` (LC), `FileWriterTool` (Crew) |
| List directory | `Glob` or `ls` (CC via shell), `list_directory` (MCP-FS, Gemini CLI), `list_files` (Cline, Roo), `ls` (Continue, Gemini CLI), `DirectoryReadTool` (Crew), `ListDirectoryTool` (LC) |
| Grep content | `Grep` (CC), `grep` (OC, Gemini CLI), `search_files` (Cline, Roo), `grepSearch` (Continue), `search_file_content` / `ripGrep` (Gemini CLI), `search_dir`/`search_file` (SWE-agent) |
| Find files by pattern | `Glob` (CC), `glob` (OC, Gemini CLI), `globSearch` (Continue), `search_files` (MCP-FS — semantically glob), `FileSearchTool` (LC), `find_file` (SWE-agent, OpenHands) |
| Ask user | `AskUserQuestion` (CC, CASDK), `ask_followup_question` (Cline, Roo), `question` (OC), `ask-user` (Gemini CLI), `Ask Questions` (Cursor), `Converse` (OpenHands CodeAct) |
| Finish task | (end_turn) vs. `attempt_completion` (Cline, Roo), `finish` (OpenHands), `submit` (SWE-agent), `complete-task` (Gemini CLI) |
| Spawn subagent | `Agent` (CC), `new_task` (Cline, Roo), `Agent.as_tool()` (OAISDK), `AgentDelegateAction` (OpenHands), `codex_tool` (Codex) |

**Takeaway for `@agent-sh/harness-*` naming**: the conservative choice is **Claude Code naming** (`Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`). The model has the richest training signal on these names. The second-tier choice is MCP-filesystem naming (`read_text_file`, `write_file`, `edit_file`, `search_files`, `list_directory`), which is what OpenAI-family models likely see more of at training time but has weaker per-harness exposure.

### Which tools exist but with very different shapes?

The *shape* of the tool — its input schema and expected output — fragments much more than the *name*. The highest-fragmentation capabilities:

#### Read file

- **Claude Code `Read`** — `file_path` (abs), optional `offset` (line), `limit` (line count), `pages` (PDFs). Returns cat -n formatted.
- **MCP-FS `read_text_file`** — `path`, optional `head` (number) OR `tail` (number) but not both. Returns raw text.
- **Gemini CLI `read_file`** — `absolute_path`, optional `offset`, `limit`. Returns raw text.
- **SWE-agent `open`** — `path`, optional `line_number`. Returns a 100-line window (config-controlled) around the line with `(XXX lines above / below)` markers; state persists across calls (`goto`, `scroll_up`, `scroll_down`).
- **LangChain `ReadFileTool`** — `file_path` (relative to `root_dir`). Returns raw.
- **OpenAI `FileSearchTool`** — takes a query, returns vector-store hits. Semantically different.

#### Edit file

- **Claude Code `Edit`** — `file_path`, `old_string`, `new_string`, optional `replace_all`. Requires prior `Read`.
- **MCP-FS `edit_file`** — `path`, `edits: Array<{oldText, newText}>`, optional `dryRun`. Returns diff output.
- **Codex `apply_patch`** — V4A patch format with `*** Begin Patch` / `*** Update File:` / `@@ context @@` / `+`/`-` lines. Works across multiple files in one call.
- **Cline `replace_in_file`** — XML shape with `<path>`, `<old_text>`, `<new_text>` tags. Full-file fallback via `write_to_file`.
- **Roo** — ships 5 separate edit tools (`apply_diff`, `edit_file`, `search_replace`, `edit`, `apply_patch`) for different shapes. This is probably too many.
- **SWE-agent `edit`** — `N:M<<<EOF ... EOF` (line range + heredoc body), with an optional lint gate on save.
- **Continue `editFile`** — natural-language description; the tool itself does the matching.
- **OpenAI Agents SDK `ApplyPatchTool`** — pluggable `ApplyPatchEditor` protocol; the default accepts V4A.
- **Aider (non-tool)** — search/replace blocks (default), unified diff (`udiff`), whole-file, diff-fenced, or architect-plus-editor split.

#### Grep / content search

- **Claude Code `Grep`** — `pattern`, `path`, `glob`, `type`, `output_mode: files_with_matches | content | count`, `head_limit`, `-A`/`-B`/`-C` for context, `multiline`, `-i`, `-n`. Wraps ripgrep.
- **MCP-FS `search_files`** — `path`, `pattern` (glob-style), `excludePatterns`. Returns full paths matching the *name* pattern — **not** a grep; this is a find-files tool misleadingly named `search_files`.
- **Cline `search_files`** — `path`, `regex`, optional `file_pattern`. Returns matches with context.
- **Gemini CLI** — **three** tools: `grep`, `ripGrep`, `search_file_content`. Redundant.
- **Continue `grepSearch`** — `pattern`, `path`. Smaller schema.
- **Cursor `Search Files and Folders`** — merged name-search + content-search + keyword-search. The schema is opaque from outside.

The recurring theme: **the more sophisticated harnesses (Claude Code, Codex-via-rg) return ripgrep directly and let the model pass flag-shaped parameters. The more abstracted ones (Cline, Continue) simplify the schema at the cost of expressiveness.**

### Gaps — capabilities users want but no harness ships well

1. **Atomic multi-file edit with rollback as a tool** — everyone either iterates `Edit` / `replace_in_file` (no atomicity) or uses `apply_patch` (atomic parse, not atomic semantic rollback). The `@agent-sh/harness-*` memory explicitly flags this as out-of-scope for Write and deferred to "git-as-transaction at the harness layer." No harness has solved this cleanly; OpenCode's `multiedit` is the closest.
2. **Stale-read detection at tool level** — Claude Code, MCP-FS, and Cline all rely on soft contracts ("Edit requires a prior Read") without providing a `STALE_READ` / `NOT_READ_THIS_SESSION` error shape for the model to recover from. Our existing guides (`agent-write-across-ecosystems.md`) cover this in detail; no mainstream harness has shipped a production-quality version yet.
3. **Read-only LSP tool that surfaces types/refs without a running server per-workspace** — Claude Code's `LSP` is the only serious attempt, and it needs a plugin per language. For a TypeScript-first harness, a light-weight LSP-querying tool (even just "find the definition of symbol X in file Y") is a genuine gap.
4. **Glob that respects ignore files AND returns richness (mtime, size)** — most `Glob` implementations (Claude Code, OpenCode, Gemini) return only paths. MCP-FS has `list_directory_with_sizes` which is adjacent but not quite the same. An ignore-aware-plus-mtime Glob would be a real step forward.
5. **"Fetch and summarize webpage" as a tool that handles SSRF correctly** — Pydantic-AI's `web_fetch_tool` has SSRF protection built in; most other harness `WebFetch` implementations don't. Claude Code's `WebFetch` delegates the summarization to a sub-model which is expensive.
6. **Structured-output edit tool with "why this edit" justification field** — every existing Edit tool accepts anchor text + replacement. None has an explicit `rationale: string` field that the harness logs for auditability. This is a low-hanging quality-and-observability gap.
7. **"Find-and-rename symbol" as a rename-refactor tool** — universally absent. Today the agent does it via Grep + loop of Edits, which is slow and error-prone. A single `Rename { symbol, scope }` tool (backed by LSP or by tree-sitter) would be a big ergonomic win.
8. **Permission-aware tool registry exposed to the model** — the model can't ask "what tools am I actually allowed to use right now?" in most harnesses (CC exposes it via asking the model to introspect, but there's no dedicated tool). A `ListMyTools` tool would be trivial and high-leverage.
9. **Per-tool token-budget hints** — no tool self-describes its cost in tokens. Agents waste context calling cheap tools 100 times or calling expensive tools once when a cheaper alternative exists. This is arguably a system-level fix, not a tool-level one.

## Prioritized recommendation for `@agent-sh/harness-*`

We ship Read, Write, Edit, MultiEdit (debatable per `feedback_write_atomicity.md`), Grep, Glob. Recommendation order, highest priority first:

### 1. **Bash** (or `Shell`) — the biggest hole by a mile.

**Why:** Every harness in the matrix ships shell execution as a first-class tool (except Aider, which is a deliberate outlier). It is the **single most universal capability after Read**. Without it, our 4-tool library is expressing an opinion — "we're a read/search library" — that is not the opinion we actually hold.

- **Universality**: 100% (17/17 relevant harnesses).
- **Spec availability**: huge. Claude Code's `Bash` doc page, Codex's `shell`/`container.exec`, OpenCode's `bash.ts`, OpenAI Agents SDK's `ShellTool` + `LocalShellTool`, MCP has no shell server but every harness bundles one. We can write a spec in a day.
- **Complexity**: medium. The design space has known hard points — shell injection, sandboxing, timeout, streaming, cwd persistence (Claude Code has an explicit `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR` env var), env-var persistence (Claude Code's `CLAUDE_ENV_FILE`), output truncation. All well-studied.
- **Risk**: permission model is load-bearing. We need the hook/permission design from `CLAUDE.md`'s Decision D11 to extend cleanly here.
- **Value to the base**: multiplicative. With `Bash`, an agent can fall back to `grep` / `find` / `git diff` / `git log` / `ls -la` / `cat -n` / `head` / `tail` / `jq` / `curl` for everything we don't cover. Without it, any capability we haven't shipped is literally unreachable.

### 2. **WebFetch** — second-biggest hole, also huge universality.

**Why:** Every closed-ecosystem harness ships this. Our users writing production agents will be blocked without it for any task that touches online docs, package registries, or API references.

- **Universality**: ~70% (12/17 relevant harnesses).
- **Spec availability**: medium-high. Claude Code's `WebFetch`, Gemini CLI's `web_fetch`, Pydantic-AI's `web_fetch_tool` with SSRF protection, and OpenCode's `webfetch` all give us templates. Claude Code delegates summarization to Haiku, which we can lean away from.
- **Complexity**: low-medium. SSRF, redirect handling, content-type negotiation, HTML → markdown conversion, size limits. All well-studied.
- **Value**: adds a whole category (web grounding) on top of the filesystem category we already cover.

### 3. **Ask / HITL tool (`AskUserQuestion`-shape)** — third priority.

**Why:** Our memory notes explicitly require us to use AskUserQuestion for all decision prompts. Claude Code's `AskUserQuestion` tool is designed for exactly this pattern — multiple-choice, structured, preserves the model's in-progress turn. OpenCode's `question`, Cline's `ask_followup_question`, Gemini's `ask-user`, Cursor's `Ask Questions` all confirm this is a universally-needed capability.

- **Universality**: ~70%.
- **Spec availability**: good. Claude Code has a dedicated doc for `AskUserQuestion`. OpenCode's `question` is simpler.
- **Complexity**: low. The tool returns a structured answer; the harness handles the I/O.
- **Value**: converts our library from "code-reading and code-writing" into "agent-grade" by giving it the structured-clarification primitive.

### 4. (Further-out but clear next-next) **LSP** — a real differentiator.

**Why:** Claude Code's `LSP` (2026) and OpenCode's experimental `lsp` are the only shippable prior art, but both prove the shape works. A TypeScript-first library with a typed, VS-Code-style LSP client can get "jump to def," "find refs," "hover type," "diagnostics" to the model with almost no extra schema surface. This is the single highest-leverage *differentiator* available — a capability gap with almost no competition.

- **Universality**: ~10% (2/17), but trending up.
- **Spec availability**: medium — Claude Code's LSP doc covers the shape; tsserver and vscode-languageserver-node give us a TS-native implementation path.
- **Complexity**: high — lifecycle management of language-server processes, per-project init, position mapping between our line-based addresses and LSP's offset-based. A larger project than the top-3.
- **Value**: high. Agents struggle with "where is this defined" today; solving it as a tool (not as shell + grep + the agent's line-number math) is a quality step change.

### 5. (Deferred / explicitly not recommended now)

- **Subagent / Agent tool** — we are a tool library, not a harness. Subagent spawning is a harness responsibility.
- **Plan mode** — per our design docs, this is a harness/flow concern, not a tool.
- **Todo / task list** — same; session/memory-file concern.
- **Notebook editor** — too niche for our users; defer.
- **Monitor / Cron** — Claude-Code-specific ergonomic niceties; not universal enough to justify design cost.
- **Browser** — cover via MCP Playwright; not in scope for our library.

## Code "example": how the matrix informs the next spec

There is no code example for this guide — it's a landscape audit, not a how-to. The concrete output is the matrix above, plus the recommendation order in the previous section, plus the source-quality rankings in `resources/harness-tool-surface-audit-sources.json`.

## Common pitfalls when reading a matrix like this

| Pitfall | Why it happens | How to avoid |
|---|---|---|
| "Everyone ships X, so we must ship X" | Universality is a necessary signal, not a sufficient one. Tools that everyone ships in slightly different shapes can be indistinguishable from "nobody has solved this yet." | Always look at the *shape* before the *name*. Our Grep tool is "everyone's grep," but our Grep tool's `output_mode` discriminator is only shared with Claude Code. |
| Confusing "tool exists" with "tool is used well" | A harness can ship a Glob tool but the model never calls it because the description is bad. The matrix can't capture this. | Cross-reference with `testing-harness-tools.md` and the per-harness e2e signals noted there (non-invocation rate, Bash-decoy outcomes). |
| Treating MCP as a bridge not a market | "We can just ship an MCP server" sounds cheap but loses the *training-signal advantage* of trained-in tool schemas (Claude's `bash`/`Read`/`Edit`). | For our TypeScript library, ship as a first-class typed tool first, then consider MCP as a secondary distribution. |
| Assuming the Codex list is "small because Codex is young" | Codex's list is small because its architectural thesis is "one shell + one patcher is enough." It's a deliberate design choice. | Read the short-list harnesses as intentional, and understand what they give up to earn it. |
| Double-counting capabilities that live in different columns | `Read` in Claude Code, `read_file` in Cline, and `read_text_file` in MCP-FS are the same capability but three rows in a naive matrix. | Use "capability" as the row key, as we do here, and list the per-harness name as the cell value. |
| Forgetting that Aider doesn't ship tools at all | Aider's whole thesis is "don't use function calling." It's in the matrix for completeness but it's not a source-of-truth for tool design. | When citing Aider, say "Aider's edit format is the pattern to learn from, not Aider's tool surface." |

## Best practices for the `@agent-sh/harness-*` build order

Synthesized from the 22 sources plus our internal design decisions in `CLAUDE.md` and `agent-knowledge/design/*.md`:

1. **Name by Claude Code convention** (`Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`, `WebFetch`, `AskUserQuestion`). Highest training signal; lowest non-invocation risk. OpenCode's lowercase convention (`read`, `write`) is the closest second-best but has smaller training presence.
2. **Schema-match Claude Code where reasonable, diverge only for typed safety.** Our library's Valibot schemas give us type safety without drifting the model-facing surface.
3. **Treat the matrix as a coverage map, not a to-do list.** Ship tools the matrix says are universal, in order of leverage (Bash > WebFetch > Ask > LSP > …). Skip tools the matrix says are Claude-specific ergonomic niceties (Monitor, Cron, Worktree) unless our users ask.
4. **For every tool we add, ship an e2e test covering the six categories in `testing-harness-tools.md`** (golden, ambiguous, adversarial-Bash-decoy, multi-turn, pagination, schema-edge). Don't declare "shipped" on a tool without cross-model coverage.
5. **Watch the Monitor / Cron / LSP / Worktree quadrant for 2026-2027 expansion.** Claude Code is expanding faster than anyone else; new universal tools in the next 12 months will almost certainly appear there first.
6. **Ignore Aider as a tool-surface reference and cite it only for edit-format inspiration.** It is structurally not a function-calling harness.
7. **Treat the SWE-agent ACI design as the prior art for state-carrying tools** (file viewer pagination, line-range edit). If we ever need a stateful file navigator, SWE-agent's `open`/`goto`/`scroll_up`/`scroll_down` is the reference.
8. **Use MCP as a distribution channel, not a design substitute.** If we want our Bash tool reachable from Claude Code users who run our MCP server, that's fine — but don't design the tool *as* MCP; design it as a native `@agent-sh/harness-*` tool first.

## Further reading

| Resource | Type | Why recommended |
|---|---|---|
| [Claude Code tools reference](https://code.claude.com/docs/en/tools-reference) | Official docs | The canonical, versioned tool list for the richest-shipped harness. Check quarterly. |
| [Claude Agent SDK — Overview](https://code.claude.com/docs/en/agent-sdk/overview) | Official docs | Default allowed-tools list; which of Claude Code's tools ship in the SDK. |
| [OpenAI Agents SDK Tools](https://openai.github.io/openai-agents-python/tools/) | Official docs | Hosted vs local vs function tools; the OpenAI-side shape. |
| [Codex CLI features](https://developers.openai.com/codex/cli/features) | Official docs | The minimalist 6-tool surface — `shell`, `apply_patch`, `update_plan`, `view_image`, `write_stdout`, `web_search`. |
| [OpenCode tools](https://opencode.ai/docs/tools/) | Official docs | Lower-case tool naming convention; `lsp`/`skill`/`question` as innovations. |
| [Cline tools guide](https://docs.cline.bot/exploring-clines-tools/cline-tools-guide) | Official docs | XML-tag schema convention; `replace_in_file` vs `write_to_file` split. |
| [Roo Code how-tools-work](https://docs.roocode.com/basic-usage/how-tools-work) | Official docs | The "5 edit tools" problem — how Roo fragmented Cline's edit surface. |
| [Cursor agent tools](https://cursor.com/docs/agent/tools) | Official docs | The 8-tool Cursor surface; `Semantic Search` as a first-class capability. |
| [Gemini CLI tools directory](https://github.com/google-gemini/gemini-cli/tree/main/packages/core/src/tools) | Source | The Google-side closed-ecosystem equivalent of Claude Code; similar breadth, different names. |
| [MCP filesystem tools](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem) | Official docs | Reference 13-tool filesystem surface; `edit_file` schema with `dryRun`. |
| [MCP git server](https://github.com/modelcontextprotocol/servers/tree/main/src/git) | Official docs | 12-tool git surface; the alternative to shell-`git`. |
| [MCP reference servers](https://github.com/modelcontextprotocol/servers) | Official docs | Fetch, filesystem, git, memory, sequential-thinking, time — the seven active reference servers. |
| [LangChain FileManagementToolkit](https://python.langchain.com/docs/integrations/tools/filesystem/) | Official docs | 7-tool filesystem toolkit; `root_dir`-scoped design. |
| [CrewAI tools](https://docs.crewai.com/tools/overview) | Official docs | 40+ integration-heavy tools; FileReadTool / FileWriterTool as the minimal core. |
| [Continue tools definitions](https://github.com/continuedev/continue/tree/main/core/tools/definitions) | Source | 21 tool definitions; a moderate-breadth open-source harness. |
| [Pydantic-AI common tools](https://pydantic.dev/docs/ai/tools-toolsets/common-tools/) | Official docs | DuckDuckGo / Tavily / Exa / web_fetch — the Python framework-side web toolkit. |
| [Amazon Bedrock AgentCore](https://aws.amazon.com/blogs/aws/introducing-amazon-bedrock-agentcore-securely-deploy-and-operate-ai-agents-at-any-scale/) | Blog | Runtime / Memory / Browser / Gateway / Identity / Observability / Code Interpreter as platform services. |
| [SWE-agent ACI](https://swe-agent.com/latest/) | Official docs | The benchmark-tuned narrow tool surface; file-viewer state machine. |
| [OpenHands (All-Hands)](https://docs.openhands.dev) | Official docs | CodeActAgent's action space — Python/bash + str_replace_editor + browse. |
| [Simon Willison's Claude Code tag](https://simonwillison.net/tags/claude-code/) | Blog | Independent running commentary on Claude Code's evolving tool surface. |
| [Armin Ronacher — Agentic Coding Tools](https://lucumr.pocoo.org/2025/6/12/agentic-coding/) | Blog | Harness-builder perspective on what tools actually need; "LLM chaos monkey." |
| [Aider commands](https://aider.chat/docs/usage/commands.html) | Official docs | The deliberate "no-function-calling" harness; slash commands vs model tools. |
| [AutoGPT classic abilities](https://github.com/Significant-Gravitas/AutoGPT/tree/master/classic) | Source | Historical reference for the original 2023-era autonomous agent tool set. |

---

*This guide was synthesized from 22 sources on 2026-04-20. See `resources/harness-tool-surface-audit-sources.json` for full source metadata including per-source quality scores and key insights.*

*Cross-references: for Read specifics see `agent-read-tool.md`, for Glob/Grep specifics see `agent-search-tools.md` and `glob-impl-and-prompts-in-major-tools.md`, for Write/Edit specifics see `agent-write-edit-tools.md` and `agent-write-across-ecosystems.md`, for architectural context see `ai-agent-harness-tooling.md`, for testing see `testing-harness-tools.md`.*
