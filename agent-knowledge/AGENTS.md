# Agent Knowledge Base

> Learning guides created by `/learn`. Reference these when answering questions about listed topics — they contain synthesized, source-cited knowledge that may be more current or specific than training data alone.

## Available Topics

| Topic | File | Sources | Depth | Created |
|-------|------|---------|-------|---------|
| Read tool — examples and best practices in AI agent harnesses | [agent-read-tool.md](./agent-read-tool.md) | 20 | medium | 2026-04-19 |
| Tool use methods — function calling, schemas, and execution patterns | [agent-tool-use-methods.md](./agent-tool-use-methods.md) | 20 | medium | 2026-04-19 |
| Glob, Grep, and file-discovery tools in AI agent harnesses | [agent-search-tools.md](./agent-search-tools.md) | 22 | medium | 2026-04-19 |
| AI agent harness tooling — architecture and design | [ai-agent-harness-tooling.md](./ai-agent-harness-tooling.md) | 20 | medium | 2026-04-19 |
| Write and Edit tools — examples and best practices in AI agent harnesses (HITL) | [agent-write-edit-tools.md](./agent-write-edit-tools.md) | 22 | medium | 2026-04-19 |
| Write/Edit tools across agent ecosystems — autonomous coders, frameworks, methodology | [agent-write-across-ecosystems.md](./agent-write-across-ecosystems.md) | 22 | medium | 2026-04-20 |
| Testing harness tools — multi-layer testing of LLM-facing agent tools | [testing-harness-tools.md](./testing-harness-tools.md) | 20 | medium | 2026-04-20 |
| Glob tool implementation and prompts across major AI coding agent tools | [glob-impl-and-prompts-in-major-tools.md](./glob-impl-and-prompts-in-major-tools.md) | 22 | medium | 2026-04-20 |
| Harness tool-surface audit — the 'what ships with what' matrix across 17 harnesses | [harness-tool-surface-audit.md](./harness-tool-surface-audit.md) | 22 | medium | 2026-04-20 |
| Exec/shell/code-interpreter tool design across major AI agent harnesses and libraries | [exec-tool-design-across-harnesses.md](./exec-tool-design-across-harnesses.md) | 22 | medium | 2026-04-20 |
| WebFetch / URL-fetch tool design across major AI agent harnesses and libraries | [webfetch-tool-design-across-harnesses.md](./webfetch-tool-design-across-harnesses.md) | 22 | medium | 2026-04-20 |
| LSP / code-intelligence tool design across major AI agent harnesses and libraries | [lsp-tool-design-across-harnesses.md](./lsp-tool-design-across-harnesses.md) | 22 | medium | 2026-04-20 |
| Skill tool design across AI agent harnesses — the Agent Skills standard and the autonomous-agent design question | [skill-tool-design-across-harnesses.md](./skill-tool-design-across-harnesses.md) | 40 | deep | 2026-04-22 |
| Skill / reusable-capability pattern in autonomous agent frameworks — OpenHands, Hermes, Codex, SWE-agent, AutoGen, LangChain, CrewAI, Voyager/JARVIS-1, Letta, Bedrock AgentCore | [skill-tool-in-autonomous-agents.md](./skill-tool-in-autonomous-agents.md) | 40 | deep | 2026-04-22 |

## Trigger Phrases

Use this knowledge when the user asks about any of the following. Match liberally — pick the guide even for adjacent phrasings.

### agent-read-tool.md
- "How does Claude Code's Read tool work?"
- "Read vs Grep vs Glob — when to use each"
- "What are the parameters of the Read tool? (offset, limit, pages)"
- "How do I read a large file in an agent?"
- "Does Codex CLI have a read_file tool?"
- "How does Aider load files into context?" / "What is `/add` vs `/read-only`?"
- "Cline read_file best practices"
- "OpenCode read tool permissions"
- "Continue readFile / file tools"
- "How does OpenAI file_search compare to a read tool?"
- "Agent SDK file reading best practices"
- "Anti-patterns for reading files in an agent"
- "Token budget implications of file reads"
- "When should I delegate file reading to a subagent?"
- "Why does Claude Code require absolute paths?"
- "How should I handle PDFs / notebooks / images in an agent?"
- "ACI design for file reading" / "poka-yoke tool design"

### agent-tool-use-methods.md
- "How does function calling work?" / "How do LLMs call tools?"
- "Anthropic tool_use vs OpenAI tool_calls — what's the difference?"
- "How do I enable strict tool use on Claude?" / "OpenAI strict mode"
- "Should I use `tool_choice: auto` or `any` or `tool`?"
- "How do parallel tool calls work?" / "When does Claude batch tool calls?"
- "Why did my model stop making parallel tool calls?"
- "What is fine-grained tool streaming?" / "`eager_input_streaming`"
- "How do I design a JSON schema for a tool?"
- "Should I use enums or free text for tool parameters?"
- "How do I handle hundreds of tools?" / "lazy schema loading"
- "What is `defer_loading` / tool search?" / "Claude Code ToolSearch pattern"
- "What is MCP?" / "How does Model Context Protocol work?"
- "MCP tools vs resources vs prompts"
- "MCP stdio vs Streamable HTTP transport"
- "How does ChatGPT / Claude / VS Code use MCP?"
- "JSON mode vs structured outputs vs function calling"
- "How do repair loops work for tool outputs?"
- "What is BFCL?" / "Berkeley Function Calling Leaderboard"
- "ToolBench / ToolLLM / Gorilla benchmark"
- "Why do LLMs hallucinate tool names / arguments?"
- "Parallel vs sequential tool execution — when to batch"
- "How should I write a tool description?"
- "How do open-source models (Hermes / Llama / Mistral) handle tool calls?"
- "OpenAI Responses API tool calling"
- "How do I reduce token cost of tool definitions?"
- "Why is my agent failing at multi-turn tool use?"

### agent-search-tools.md
- "How does Claude Code's Glob tool work?" / "Glob pattern syntax"
- "When should I use Grep vs Glob vs Bash?"
- "What are the Grep tool's output_mode options?" / "files_with_matches vs content vs count"
- "How do I paginate grep results?" / "head_limit / offset"
- "Ripgrep gotchas: literal braces, multiline, type vs glob"
- "How do I search across multiple lines in ripgrep?" / "multiline mode"
- "Why is my pattern `interface{}` not matching?" / "escaping regex metacharacters"
- "`--type ts` vs `-g '*.ts'` — which is better?"
- "How does Codex CLI handle file search?" / "Codex sandbox pre-approved commands"
- "What commands does Codex run without approval?" (rg, ls, find, grep)
- "How is OpenAI `file_search` different from filesystem grep?"
- "How does Aider's repo-map work?" / "tree-sitter + PageRank"
- "Why doesn't Aider auto-search files?" / "/add vs autonomous search"
- "Cline `search_files` / `list_files` / `list_code_definition_names` parameters"
- "OpenCode grep/glob tool implementation" / "100-match cap"
- "Should I run `grep -r` or use the Grep tool?" / "bare Bash anti-patterns"
- "Why is `ls -R` a bad idea in agents?" / "directory listing strategy"
- "When should I delegate search to a sub-agent?" / "Task delegation for exploration"
- "How much context does a grep vs a file read cost?"
- "How does Continue.dev handle file search?"
- "Tool design: Glob / Grep / Bash trade-offs"

### ai-agent-harness-tooling.md
- "What is an agent harness?" / "Harness vs SDK — what's the difference?"
- "Compare Claude Code vs Codex CLI vs Cursor vs Aider vs Cline vs OpenCode vs Continue"
- "How does the agentic loop work under the hood?"
- "Closed vs open agent ecosystems — tradeoffs?"
- "Why does Aider use unified diffs instead of function calling?"
- "How do permission models work in agent CLIs?" / "auto mode / sandboxing"
- "What are hooks in Claude Code / Claude Agent SDK?"
- "How does context compaction work?" / "Why did my agent forget its safety rules?"
- "Explain subagents / handoffs / Task delegation at the harness level"
- "What is the OpenAI Responses API and how is it different from Chat Completions?"
- "Claude Agent SDK vs Client SDK"
- "OpenAI Agents SDK loop / max_turns / handoffs"
- "How does Aider's repo map work at an architectural level?"
- "Lethal trifecta / prompt injection in agent tools"
- "How do harnesses handle streaming and interruption?"
- "Why do agents hang? Why do agents infinite-loop?"
- "How should I design tools to be reliable across models?"
- "Reinforcement in agent contexts (Ronacher)"

### agent-write-edit-tools.md
- "How does Claude Code's Write tool work?" / "Edit tool" / "MultiEdit" / "NotebookEdit"
- "Write vs Edit — when should I use each?"
- "What's the `str_replace_based_edit_tool`?" / "`text_editor_20250728`"
- "Why does Edit require me to Read the file first?" / "read-before-edit invariant"
- "What is OpenAI's `apply_patch`?" / "V4A diff format" / "how does Codex edit files?"
- "Aider edit formats — whole vs diff vs udiff vs diff-fenced"
- "Aider SEARCH/REPLACE block rules"
- "Aider unified diff format — why no line numbers?"
- "Cline `write_to_file` vs `replace_in_file`"
- "OpenCode `edit` / `write` / `multiedit` / `apply_patch` tools"
- "Which edit format works best with GPT-5 / Claude / Gemini?"
- "Aider leaderboard / polyglot benchmark numbers"
- "Why does my agent keep rewriting the whole file?"
- "How do I avoid lazy coding placeholders (`# ... existing code ...`)?"
- "`replace_all` accidentally replaced substrings — how to fix?"
- "How do I make a multi-file refactor atomic?" (HITL harness side)
- "How should I handle Jupyter notebook edits?"
- "Editing reliability / edit failure modes / 'no match found' errors"
- "Architect mode in Aider — planner + editor pattern"
- "Patch formats that tolerate stale files" / "context-anchored diffs"
- "How does Continue apply code changes?"

### agent-write-across-ecosystems.md
- "OpenHands edit tool" / "OpenHands str_replace_editor" / "OpenDevin file editor"
- "CodeActAgent file editing" / "LLMBasedFileEditTool"
- "SWE-agent file editor" / "SWE-agent edit command" / "edit N:M syntax" / "lint-on-save in SWE-agent"
- "Agent-Computer Interface / ACI for editing" / "SWE-agent ACI paper"
- "Devin file editor" / "Cognition AI Devin write"
- "Agentless edit format" / "Agentless repair sampling" / "SWE-bench without agents"
- "AutoGPT file write" / "AutoGPT WriteFile"
- "BabyAGI file tools"
- "CrewAI FileWriterTool" / "CrewAI FileReadTool" / "CrewAI file system"
- "LangChain FileManagementToolkit" / "LangChain WriteFileTool / ReadFileTool"
- "LangGraph file editing" / "deepagents edit_file" / "LangChain deepagents"
- "Microsoft Autogen file write" / "Autogen LocalCommandLineCodeExecutor" / "Magentic-One file editor" / "FileSurfer"
- "Hermes function calling write" / "NousResearch Hermes tool format"
- "Claw tool-use framework" / "Nous Research Claw" (guide flags this as not publicly documented)
- "OpenAI Agents SDK ApplyPatchTool" / "ApplyPatchEditor protocol" / "ApplyPatchOperation"
- "OpenAI Agents SDK file write" / "Agents SDK apply_patch"
- "MCP filesystem write_file" / "MCP filesystem edit_file" / "MCP server-filesystem"
- "Autonomous agent Write tool atomicity" / "transactional multi-file edit"
- "Cross-ecosystem comparison of Write tools" / "autonomous vs HITL Write tool"
- "Read-before-edit invariant in autonomous agents"
- "Stale-read detection in Write tools"
- "Repair loop for failed patches" / "structured fuzzy match on edit failure"
- "Lint-gate on edit / validate hook on file write"
- "Virtual filesystem agent state vs real disk edits"
- "Write tool spec for TypeScript agent library" / "@agent-sh/harness Write tool"

### testing-harness-tools.md
- "How should I test an LLM tool?" / "How do I test a harness tool?"
- "Unit tests don't count for LLM tools — what does?"
- "Five-layer testing pyramid for agent tools" / "pure logic / schema / integration / real-model / multi-model"
- "How do I test a tool with real Claude / real GPT / real Qwen?"
- "How do I test a tool against both Ollama and Bedrock?"
- "e2e tests for Claude Code / agent SDK tools"
- "How do I assert on a trace / tool_seq / tool_calls?"
- "Non-invocation failure mode — how do I detect the model bypassing my tool?"
- "Bash-decoy test / shell-routing detection"
- "How do I measure turn count / tool-call arg correctness / error-recovery?"
- "Output-faithfulness test / hallucination guard"
- "How do I test tool-description quality?"
- "How do I iterate on tool descriptions based on eval data?"
- "Cross-model matrix without combinatorial blow-up"
- "How do I gate Bedrock tests on credentials?" / "AWS_BEARER_TOKEN_BEDROCK"
- "How do I conditionally skip tests in Vitest?" / "it.runIf / test.skipIf"
- "Per-test timeouts in Vitest for long-running e2e"
- "test.each / test.for parametric fixtures"
- "How do I manage Ollama VRAM pressure in CI?"
- "One model per process / warmup"
- "BFCL / TAU-bench / SWE-bench — how do they evaluate tools?"
- "Promptfoo / DeepEval / Inspect AI / LangSmith / Braintrust for tool evals"
- "OpenAI evals / MCP Inspector / Anthropic eval docs"
- "VCR / anthropic-vcr / record-replay for LLM tests"
- "LLM-as-judge / G-Eval / pairwise evaluator patterns"
- "Trajectory evaluation — tool_seq assertions"
- "Pass@k for flaky LLM tests"
- "Adversarial test scenarios for file tools" / "CRLF / BOM / symlink / encoding traps"
- "Binary-file trap / sensitive-path trap / attachment trap"
- "Read-before-mutate gate testing" / "STALE_READ / NOT_READ_THIS_SESSION tests"
- "NOT_UNIQUE / NOT_FOUND / fuzzy recovery testing"
- "Atomic-write verification — no temp files left behind"
- "Validate hook testing patterns"
- "InMemoryLedger tests" / "makeSession / recordRead helpers"
- "Rate-limit / timeout injection / schema drift testing"
- "Multi-file edit atomicity test"
- "Distractor-tool test for tool-description quality"
- "Why does my agent fail silently without calling my tool?"
- "How do I avoid mocking the model?" / "when to record-replay vs live inference"
- "CI/CD for LLM tool tests" / "smoke vs full matrix vs release gate"
- "Flakiness in LLM tests — strategies"

### glob-impl-and-prompts-in-major-tools.md
- "What exactly does Claude Code's Glob tool prompt say to the model?" / "Glob tool description verbatim"
- "What is OpenCode's Glob tool schema?" / "glob.ts source"
- "What is Gemini CLI's glob tool description?" / "FindFiles tool"
- "What is Continue.dev's FileGlobSearch?" / "globSearch.ts"
- "What is the MCP filesystem `search_files` tool?"
- "Does Codex CLI have a Glob tool?" (short answer: no — routes through shell with rg --files -g)
- "Does SWE-agent / OpenHands have a Glob tool?" / "find_file agent-skill"
- "How does Cursor handle file search?"
- "Why does the Glob tool sort by modification time?" / "mtime-sorted return shape"
- "Why is there a 100-result cap on Glob?" / "truncation marker design"
- "Why does the schema say `DO NOT enter \"undefined\" or \"null\"`?" / "optional-path footgun"
- "Should my Glob tool accept relative or absolute paths?"
- "Should Glob respect .gitignore by default?"
- "Should Glob be case-sensitive by default?"
- "Why are dotfiles and node_modules auto-excluded?"
- "What's the difference between ripgrep `-g` glob and bash glob?"
- "What's the difference between minimatch and fast-glob and node-glob?"
- "When does a model confuse rg's `--glob` flag with the Glob tool's pattern arg?"
- "Why do models pass comma-lists where brace-lists are needed?"
- "Why does a model write `*.ts` when it should write `**/*.ts`?"
- "Should Glob return absolute or relative paths?"
- "Should Grep and Glob be the same tool or separate tools?"
- "Cross-harness comparison of Glob tool schemas" / "Claude Code vs Gemini vs OpenCode vs Continue"
- "LangChain FileSearchTool — how does it differ from Claude's Glob?"
- "Why does the Glob tool description include `use the Agent tool instead`?"
- "How should we design the Glob tool for @agent-sh/harness-*?" / "harness-glob design"
- "What error messages should Glob emit when no matches are found?"
- "What error type enum should Glob expose?" / "PATH_NOT_IN_WORKSPACE / GLOB_EXECUTION_ERROR"
- "How do I prevent Bash(find) bypass when I have a Glob tool?"
- "Should my Glob follow symlinks?"

### harness-tool-surface-audit.md
- "What tools does Claude Code ship?" / "full Claude Code tool list (2026)"
- "What tools does Codex CLI ship?" / "shell, apply_patch, update_plan, view_image, write_stdout, web_search"
- "What tools does OpenCode ship?" / "bash, edit, write, read, grep, glob, lsp, apply_patch, skill, todowrite, webfetch, websearch, question"
- "What tools does Cline ship?" / "read_file, write_to_file, replace_in_file, search_files, list_files, execute_command, ..."
- "What tools does Roo Code ship?" / "apply_diff, edit_file, search_replace, edit, apply_patch — 5 edit tools problem"
- "What tools does Cursor agent ship?" / "8 tools: Semantic Search, Search Files and Folders, Read Files, Edit Files, Run Shell Commands, Web, Browser, Image Generation"
- "What tools does Gemini CLI ship?" / "~20 tools including three grep-style tools"
- "What tools does Continue.dev ship?" / "21 tool definitions in core/tools/definitions"
- "What tools does the OpenAI Agents SDK ship?" / "hosted tools list (FileSearchTool, WebSearchTool, CodeInterpreterTool, ...)"
- "What tools does the Claude Agent SDK ship by default?"
- "What tools does the MCP filesystem server expose?" / "13 tools including read_text_file, edit_file, directory_tree"
- "What tools does the MCP git server expose?" / "12 git_* tools"
- "What tools did the MCP GitHub server expose?" (archived, 26 tools)
- "What tools does LangChain FileManagementToolkit have?" / "7 tools"
- "What tools does CrewAI ship?" / "40+ integration catalog"
- "What tools does SWE-agent ship?" / "ACI surface: open, goto, edit, scroll_*, search_dir, search_file, find_file, create, submit"
- "What tools does OpenHands CodeActAgent ship?" / "IPythonRunCellAction, CmdRunAction, str_replace_editor, browse, finish"
- "What tools does Pydantic-AI ship?" / "duckduckgo/tavily/exa search + web_fetch_tool with SSRF"
- "What built-in services does Amazon Bedrock AgentCore have?" / "Runtime, Memory, Code Interpreter, Browser, Gateway, Identity, Observability"
- "What tools does AutoGPT ship?" / "classic vs platform — historical reference"
- "Cross-harness tool matrix" / "what ships with what"
- "Which tools are table-stakes / universal across all harnesses?"
- "Which tools are Claude Code-only?" / "Monitor, LSP, EnterWorktree, CronCreate, TeamCreate, SendMessage"
- "Which capabilities live only in MCP?" / "git, SQL, time, knowledge-graph memory"
- "Same tool different names" / "Read vs read_file vs read_text_file vs open"
- "Same name different shapes" / "Read / Edit / Grep schema fragmentation"
- "What tool should @agent-sh/harness-* build next?" / "Bash > WebFetch > AskUserQuestion > LSP"
- "Why is Bash the highest-priority next tool for @agent-sh/harness-*?"
- "Why is Aider's tool surface empty?" / "Aider as no-function-calling outlier"
- "How many tools does Claude Code have?" (30+ as of 2026)
- "Is there a harness with an LSP tool?" (Claude Code `LSP`, OpenCode `lsp` experimental)
- "Does any harness have a Monitor-style background-watch tool?" (Claude Code only)
- "Does any harness ship a find-and-rename-symbol tool?" (gap — nobody does)
- "Claude Code Monitor tool" / "v2.1.98+ background watch"
- "Claude Code CronCreate / CronList / CronDelete" / "scheduled tasks"
- "Claude Code EnterWorktree / ExitWorktree"
- "Claude Code PowerShell tool"
- "Claude Code LSP tool"
- "Claude Code AskUserQuestion tool"
- "Claude Code SendMessage / TeamCreate / TeamDelete" (agent teams, experimental)
- "Claude Code TaskCreate / TaskGet / TaskList / TaskUpdate / TaskStop" (the expanded task surface)
- "Claude Code ListMcpResourcesTool / ReadMcpResourceTool"
- "Codex codex_tool" / "OpenAI Agents SDK experimental codex_tool"
- "Gemini CLI save_memory / memoryTool"
- "Roo Code generate_image / codebase_search / apply_patch"
- "Cline browser_action"
- "Continue codebaseTool / viewRepoMap / viewSubdirectory / viewDiff"
- "Pydantic-AI web_fetch_tool SSRF"
- "Bedrock AgentCore Gateway / OpenAPI → MCP"

### exec-tool-design-across-harnesses.md
- "How does Claude Code's Bash tool work?" / "Bash tool persistent shell / cwd semantics"
- "How does Codex shell sandbox work?" / "seatbelt / landlock / bwrap / seccomp"
- "Codex sandbox modes — read-only vs workspace-write vs danger-full-access"
- "Codex approval policies — untrusted / on-request / never / granular"
- "Codex network_access config / writable_roots / exclude_slash_tmp"
- "Codex unified_exec / PTY-backed shell / allow_login_shell"
- "Codex shell_environment_policy / inherit / include_only / exclude / ignore_default_excludes"
- "OpenCode bash.ts schema / timeout / stream-to-file truncation"
- "OpenCode OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS"
- "Gemini CLI shell tool inactivity timeout / binary halt / OUTPUT_UPDATE_INTERVAL_MS"
- "Gemini CLI shellBackgroundTools / list_background_processes / read_background_output"
- "Gemini CLI sandbox-denial parsing / self-healing permission loop"
- "Continue.dev runTerminalCommand / waitForCompletion / evaluateTerminalCommandSecurity"
- "Cline execute_command / requires_approval classifier / proceed-while-running"
- "Cline suppressUserInteraction / background command state"
- "OpenHands CmdRunAction vs IPythonRunCellAction — why two tools?"
- "OpenHands tmux-backed persistent shell / is_input stdin feed"
- "OpenHands Jupyter kernel / kernel_init_code / IPython action"
- "CodeAct paper / Python code as action space / Wang et al. ICLR 2025"
- "Python-as-action vs JSON function calling — 20% success-rate improvement"
- "SWE-agent ACI design / wrapped commands vs raw bash"
- "SWE-agent why 100-line file viewer / empty-output message"
- "E2B Code Interpreter / Firecracker microVM / commands.run vs runCode"
- "Daytona sandbox / process.code_run / process.execute_command"
- "Bedrock AgentCore Code Interpreter isolation"
- "OpenAI Agents SDK — CodeInterpreterTool vs ShellTool vs LocalShellTool vs ComputerTool"
- "OpenAI Agents SDK ShellTool container_auto / container_reference"
- "AutoGen LocalCommandLineCodeExecutor / DockerCommandLineCodeExecutor"
- "AutoGen supported languages: bash, shell, sh, pwsh, python"
- "create_default_code_executor() Docker fallback"
- "LangChain ShellTool / BashTool / PythonREPLTool security warning"
- "MCP — is there a shell / exec / code-interpreter reference server?" (answer: no)
- "Aider /run and /test — user-facing vs model-facing"
- "Firejail / bubblewrap / nsjail for wrapping agent subprocesses"
- "Should our exec tool be Bash vs exec vs shell vs run_command?"
- "One exec tool vs separate Bash + Python tools — what does the research say?"
- "Do I need a `lang` discriminator on my exec tool?"
- "Should my shell session persist across calls? cwd persistence / env persistence"
- "Sandboxing posture for a tool library (not a harness)"
- "Hook-first fail-closed default for exec tools"
- "Permission hook contract for exec — extra fields beyond read/write/grep"
- "Pattern-based allowlist vs classifier-based auto-approve"
- "Autonomous agents — allow/ask/deny — why no ask mode"
- "Inactivity timeout vs wall-clock timeout for shell"
- "Output cap + stream-to-file pattern for Bash tools"
- "Discriminated-union result for Bash — timeout/denied/killed/truncated"
- "Interactive command detection / reject nano vim less ssh -t"
- "Background / PID-keyed BashOutput / KillBash tool design"
- "Why Anthropic ships Bash (not exec) — training signal on tool name"
- "CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR / CLAUDE_ENV_FILE"
- "Ronacher LLM chaos monkey / tools need to be bulletproof"
- "Simon Willison on Claude Code auto mode / deterministic sandbox argument"
- "Hook signature for exec — command, cwd, env, timeout, background, network_required"
- "Why Cline's model-supplied requires_approval is a trust hole"
- "description field as audit affordance (OpenCode / Gemini / Claude Code)"
- "banning file-edit-via-bash in tool description (Continue.dev pattern)"
- "E2B default timeout / sandbox idle"
- "PTY-backed shell tools — when and why"
- "@agent-sh/harness Bash spec" / "@agent-sh/harness exec design"
- "createBashPermissionPolicy({allow, deny, fallback})"
- "SandboxAdapter interface — docker / firejail / e2b as separate packages"

### webfetch-tool-design-across-harnesses.md
- "How does Claude Code's WebFetch tool work?" / "WebFetch schema and parameters"
- "What's the exact WebFetch tool description?" / "WebFetch in-prompt wording"
- "What does Claude Code's WebFetch do about prompt injection?" / "treat content as information not instructions"
- "Does Claude Code's WebFetch have a 15-minute cache?" (short answer: 5-minute hostname preflight cache; content cache is implementation-defined)
- "WebFetch domain safety check" / "skipWebFetchPreflight" / "api.anthropic.com blocklist preflight"
- "WebFetch(domain:example.com) permission rule syntax"
- "sandbox.network.allowedDomains / deniedDomains"
- "Why does Claude Code's WebFetch silently upgrade HTTP to HTTPS?"
- "How does Claude Code handle cross-host redirects?" / "REDIRECT DETECTED message"
- "Anthropic API `web_fetch` server-tool" / "web_fetch_20250910 / web_fetch_20260209"
- "Anthropic API URL-provenance rule" / "Claude can only fetch URLs previously in context"
- "Anthropic API web_fetch error codes" / "url_not_allowed / url_too_long / unsupported_content_type"
- "Anthropic API web_fetch max_content_tokens / max_uses / allowed_domains / blocked_domains"
- "Anthropic API web_fetch citations"
- "Dynamic filtering in web_fetch_20260209" / "code execution for content filtering"
- "homograph attack on domain allowlist" / "Unicode domain normalization"
- "Does Codex CLI have a WebFetch tool?" (short answer: no — only web_search + shell+curl)
- "Codex Cloud internet access tiers" / "off / on with restrictions / unrestricted"
- "Codex Common dependencies preset ~80 domains"
- "Codex HTTP method restriction: GET / HEAD / OPTIONS only"
- "Codex cached web_search vs live mode" / "web_search = live"
- "Gemini CLI `web_fetch` / `web-fetch.ts` source"
- "Gemini CLI tool-layer SSRF defense" / "isPrivateIp / localhost rejection"
- "Gemini CLI URL_FETCH_TIMEOUT_MS 10s / MAX_CONTENT_LENGTH 250KB / MAX_EXPERIMENTAL_FETCH_SIZE 10MB"
- "Gemini CLI sanitizeXml() for prompt-injection defense"
- "Gemini CLI html-to-text library for HTML conversion"
- "OpenCode `webfetch` / `webfetch.ts` / `webfetch.txt`"
- "OpenCode Turndown HTML-to-markdown config"
- "OpenCode MAX_RESPONSE_SIZE 5MB hard-reject"
- "OpenCode DEFAULT_TIMEOUT 30s / MAX_TIMEOUT 120s"
- "OpenCode Cloudflare-challenge 403 retry with User-Agent"
- "OpenCode format parameter — text/markdown/html"
- "MCP Fetch reference server / `fetch` tool"
- "MCP Fetch readabilipy + markdownify extraction pipeline" / "readability-style main-content extraction"
- "MCP Fetch max_length / start_index continuation pattern"
- "MCP Fetch robots.txt honoring / --ignore-robots-txt"
- "MCP Fetch User-Agent autonomous vs user-initiated"
- "MCP Fetch --proxy-url / --user-agent CLI flags"
- "Continue.dev `fetchUrlContent` / URLContextProvider"
- "Continue.dev DEFAULT_FETCH_URL_CHAR_LIMIT 20000"
- "Cline has no WebFetch — only @url context and browser_action"
- "Pydantic-AI `web_fetch_tool` SSRF protection" / "OWASP SSRF reference"
- "Pydantic-AI `duckduckgo_search_tool` / `tavily_search_tool` / Exa toolkit"
- "OpenAI Agents SDK WebSearchTool vs HostedMCPTool fetch vs ComputerTool browser"
- "LangChain RequestsGetTool / RequestsPostTool / RequestsToolkit"
- "LangChain allow_dangerous_requests=True flag"
- "LangChain multi-verb HTTP tools — the dangerous-flag reference"
- "OpenHands has no HTTP WebFetch — browsing via BrowsingAgent"
- "OpenHands `web_read` / `browse` actions"
- "CrewAI ScrapeWebsiteTool / FirecrawlScrapeWebsiteTool / WebsiteSearchTool"
- "AutoGen WebSurfer / Magentic-One visit_page / page_up / find_on_page / answer_from_page"
- "Playwright MCP browser_navigate / browser_snapshot / browser_click"
- "Playwright MCP 'not a security boundary' disclaimer"
- "browser-use — Playwright-based agent browser automation"
- "Chrome DevTools MCP"
- "Headless browser vs HTTP fetch split" / "when to ship a Browser tool separately"
- "SSRF defense at tool layer vs sandbox layer vs hook layer"
- "Private IP blocklist: 127.0.0.1 / 10.0.0.0/8 / 172.16.0.0/12 / 192.168.0.0/16 / 169.254.169.254 metadata"
- "Prompt-injection defense in WebFetch — four postures"
- "URL-provenance restriction as prompt-injection defense" / "URL must have appeared in context"
- "Mozilla Readability + Turndown TypeScript stack" / "readability-style extraction for HTML"
- "Readability-style main-content extraction vs full-page HTML conversion"
- "Soft-truncate + nextStartIndex vs hard-reject on size overflow"
- "Cross-host redirect surfacing vs silent-follow"
- "Discriminated error codes for WebFetch — url_not_allowed / url_private_range / size_exceeded / unsupported_content_type"
- "Should WebFetch support POST/PUT/DELETE? — ecosystem says GET only"
- "Should WebFetch accept arbitrary headers? — ecosystem says no, route to Bash(curl)"
- "Caching WebFetch results — library or harness concern?"
- "Permission hook contract for WebFetch — url / host / format / conversationUrls fields"
- "createWebFetchPermissionPolicy({allow, deny, fallback}) — domain-pattern allowlist"
- "@agent-sh/harness WebFetch spec" / "@agent-sh/harness-webfetch package design"
- "Why WebFetch (not url_fetch or fetch or web_get) — training signal"
- "Simon Willison lethal trifecta" / "private data + untrusted content + exfiltration"
- "WebSearch vs WebFetch — discovery vs retrieval"

### lsp-tool-design-across-harnesses.md
- "How does Claude Code's LSP tool work?" / "LSP tool behavior" / "LSP tool description verbatim"
- "What operations does Claude Code's LSP tool support?" (jump-to-def, find-refs, hover, symbols, implementations, call hierarchies, diagnostics)
- "Claude Code LSP plugin manifest schema" / "`.lsp.json` format"
- "Claude Code LSP `extensionToLanguage` / `startupTimeout` / `restartOnCrash`"
- "Which LSP plugins ship in the Claude Code marketplace?" (11: clangd-lsp, csharp-lsp, gopls-lsp, jdtls-lsp, kotlin-lsp, lua-lsp, php-lsp, pyright-lsp, rust-analyzer-lsp, swift-lsp, typescript-lsp)
- "How does Claude Code handle LSP diagnostics after an edit?" (hook, not tool)
- "What is OpenCode's experimental `lsp` tool?" / "`OPENCODE_EXPERIMENTAL_LSP_TOOL=true`"
- "OpenCode LSP 9-operation enum" / "goToDefinition / findReferences / hover / documentSymbol / workspaceSymbol / goToImplementation / prepareCallHierarchy / incomingCalls / outgoingCalls"
- "OpenCode `lsp.ts` tool source / `hasClients` / `touchFile`"
- "OpenCode LSP server registry / `server.ts` / auto-install logic"
- "OpenCode LSP client / `didOpen` / `didChange` / `publishDiagnostics` 150ms debounce"
- "Serena semantic-symbol MCP server" / "find_symbol / replace_symbol_body / rename"
- "mcp-language-server by isaacphi" / "definition / references / diagnostics / hover / rename_symbol / edit_file"
- "lsp-mcp by jonrad / dynamic LSP schema generation"
- "Multilspy / monitors4codegen Microsoft research" / "Monitor-Guided Decoding NeurIPS 2023"
- "MGD 19-25% compilation-rate improvement" / "LSP-for-LLM quantitative argument"
- "How does Aider's tree-sitter repo-map compare to LSP?"
- "Aider `py-tree-sitter-languages` / 17-language static parsing / PageRank ranking"
- "Cline `list_code_definition_names` tree-sitter service" / "17 extensions / `tags.scm` queries"
- "Does Cursor expose LSP?" (no — Semantic Search instead; IDE owns LSP)
- "Does OpenAI Agents SDK have LSP?" (no — FileSearchTool is vector-store retrieval, not code-intel)
- "Does Codex / Gemini CLI / SWE-agent / OpenHands have LSP?" (no — all four are gaps)
- "Is there an MCP reference server for LSP?" (no — only third-party: Serena, mcp-language-server, lsp-mcp)
- "LSP 3.17 position encoding" / "0-indexed UTF-16 vs UTF-8 vs UTF-32"
- "Why convert to 1-indexed positions at the tool boundary?"
- "LSP initialize sequence / `InitializeResult` / `-32002` error code"
- "`textDocument/publishDiagnostics` is server-push, not a request"
- "`Hover.contents` union of MarkupContent / string / MarkedString[]"
- "`Location` vs `LocationLink` — three return shapes"
- "`WorkspaceEdit` and the rename-with-read-ledger problem"
- "`vscode-jsonrpc` + `vscode-languageserver-protocol` for a TS LSP client"
- "Why NOT use `vscode-languageclient`?" (editor-coupled)
- "Cold-start latency for rust-analyzer / tsserver / pyright"
- "Should I ship a `warm_server` tool?" (no — pre-warm at session start)
- "`server_starting` error with retry hint" / "autonomous cold-start handling"
- "`server_not_available` + install suggestion" / "fail-fast `hasClient` check"
- "Discriminated-union LSP result" / "`kind: 'ok' | 'no_results' | 'server_not_available' | 'server_starting' | 'position_invalid' | 'timeout' | 'error'`"
- "Flattened `path:line:text` output for references vs raw `Location[]`"
- "Diagnostics via `PostToolUse` hook pattern" / "edit → run LSP → append diagnostics"
- "150ms diagnostic debounce / syntax-pass + semantic-pass coalescing"
- "Symbol-first tools on top of LSP" / "Serena-style `find_symbol(name)` instead of positional"
- "Should LSP tool include `rename`?" (v1: no; ledger interaction unresolved)
- "Should LSP tool include `completion` / `signatureHelp`?" (no clear autonomous-agent use case)
- "`LspClient` adapter interface" / "pluggable LSP boundary for the library"
- "Why not auto-install LSP binaries?" (OpenCode does; library should NOT — build reproducibility)
- "Three schools of code intelligence" / "LSP-native vs tree-sitter-static vs index-and-rank"
- "@agent-sh/harness LSP spec" / "`@agent-sh/harness-lsp` package design"
- "Workspace-symbol query minimum length" / "result caps (200) on references/symbols"
- "Why is LSP the highest-leverage unshipped tool?" (ecosystem gap; only Claude Code + OpenCode experimental)
- "Find-and-rename symbol as a tool — ecosystem gap" / "why nobody has solved this"

### skill-tool-design-across-harnesses.md
- "What is a Skill in Claude Code?" / "How does the Skill tool work?"
- "What's the Agent Skills open standard?" / "agentskills.io"
- "Is Skill a tool or a file format?" (short answer: both — SKILL.md is the file, Skill is one of four activation patterns)
- "SKILL.md format" / "YAML frontmatter for skills" / "name description license compatibility metadata allowed-tools"
- "Progressive disclosure in skills — three tiers" / "metadata + body + resources"
- "Skill vs MCP — when to use which?"
- "Skill vs subagent — when to use which?"
- "Skill vs hook — when to use which?"
- "Skill vs system prompt vs CLAUDE.md — progressive disclosure argument"
- "Why does OpenCode ship a `skill` tool?" / "what does skill.ts return?"
- "Why does Gemini CLI ship `activate-skill` but not other harnesses?"
- "Why does Continue ship `readSkill`?"
- "Why does Codex NOT ship a Skill tool?" (system-prompt injection + $name mention + /skills command)
- "Why does Amp NOT ship a Skill tool?" (catalog-in-system-prompt only)
- "Does Cline support Agent Skills?" (short answer: no as of Q1 2026; uses .clinerules and @mentions instead)
- "Does Aider support Agent Skills?" (short answer: no — no function calling; slash commands only)
- "Cursor /migrate-to-skills" / "Cursor rules to skills migration"
- "Claude Code Skill frontmatter extensions" / "disable-model-invocation / user-invocable / context: fork / agent / paths / hooks"
- "`disable-model-invocation: true` — what does it do?" (prevents auto-invocation, only user /name can trigger)
- "`user-invocable: false` — what does it do?" (only model can invoke; hidden from slash menu)
- "`context: fork` — what does it do?" (run skill in a forked subagent)
- "Skill argument passing — $ARGUMENTS / $N / $ARGUMENTS[N] / $name" / "named positional args"
- "Skill dynamic context injection" / "!`<cmd>` blocks in SKILL.md"
- "Skill-subagent composition — preload vs fork"
- "Skill discovery paths" / ".agents/skills/ vs .claude/skills/ vs .<harness>/skills/"
- "Skill name collision handling" / "project > user precedence"
- "Skill trust considerations" / "should I auto-load project skills from untrusted repos?"
- "Skill lifecycle — discover / parse / disclose / activate / manage"
- "Why does Claude Code NOT re-read SKILL.md between turns?"
- "Skill content and /compact" / "auto-compaction carryforward for skills" / "5000-per-skill / 25000-total budget"
- "How many tokens does a skill cost when installed but not active?" (~50-100 metadata)
- "Simon Willison on Skills vs MCP" / "tens of thousands of tokens (MCP) vs few dozen (skills)"
- "Anthropic Agent Skills announcement" / "Oct 16 2025 blog post" / "engineering blog"
- "Who adopted Agent Skills?" (35+ harnesses including Claude Code, OpenCode, Gemini CLI, Codex, Cursor, Amp, Junie, OpenHands, GitHub Copilot, VS Code, Kiro, Letta, Goose, Roo Code, Spring AI, Laravel Boost, ...)
- "anthropics/skills repository" / "reference skills on GitHub" / "Apache 2.0 vs source-available"
- "skills-ref validation library"
- "Why are skills autonomous-aligned but ask is HITL?"
- "What problems do skills solve that a pre-baked system prompt doesn't?"
- "Concrete autonomous-skill examples" / "code-review / migrate-to-typescript / api-conventions / pre-commit-fixer"
- "Should @agent-sh/harness-* ship a skill tool?" / "harness-skill spec"
- "Skill tool input schema — `{ name, arguments? }`"
- "Skill tool output — discriminated union — ok/not_found/permission_denied/outside_workspace/disabled/invalid_frontmatter/error"
- "SkillRegistry interface — pluggable skill discovery"
- "FilesystemSkillRegistry / SkillRegistry adapter interface"
- "buildSkillCatalog helper function"
- "Permission hook contract for skill — extra fields (skill name, dir, frontmatter)"
- "createSkillPermissionPolicy"
- "Why ship Skill AFTER Bash?" (allowed-tools frontmatter composes with Bash permissions)
- "Skill activation catalog placement — system prompt vs tool description"
- "Dynamic skill name enum to prevent hallucination"
- "Structured wrapping of skill content for compaction survival" / "<activated_skill> / <skill_content>"
- "Dedupe per-session activations"
- "`allowed-tools` in skill frontmatter — how should it compose with hook permissions?"
- "Skill `paths` frontmatter — auto-activation gating"
- "Skill `model` frontmatter — model override for the turn"
- "Anti-pattern: unrestricted shell injection in skill body"
- "Anti-pattern: skill with `allowed-tools: Bash(*)` as deny bypass"
- "Anti-pattern: auto-loading project skills without trust gate"
- "Test strategy for a skill tool — golden / ambiguous / adversarial / multi-turn / pagination / schema-edge"
- "Cross-harness comparison of Skill tools — Claude Code / OpenCode / Gemini / Continue / Codex / Amp / OpenHands"
- "Agent Skills specification — required fields (name 1-64 chars [a-z0-9-], description 1-1024 chars)"
- "Agent Skills optional frontmatter — license / compatibility / metadata / allowed-tools experimental"
- "Third-party spec adopters (Spring AI, Laravel Boost, Databricks Genie, Snowflake Cortex Code)"

### skill-tool-in-autonomous-agents.md
- "Skill pattern in autonomous agents — how is it different from HITL?"
- "Does OpenHands have a skill concept?" / "what is agent-skill in OpenHands?"
- "OpenHands agent_skills plugin — what is it?" (Python helper library; IPython activation)
- "OpenHands microagents vs skills — what's the difference?" (microagents deprecated; skills current)
- "OpenHands skills triggers: YAML field" / "keyword-triggered skills"
- "OpenHands extensions registry" / "45 extensions (36 skills + 9 plugins)"
- "SWE-agent tool bundles — are they skills?" / "windowed / edit_anthropic / search / filemap bundles"
- "SWE-agent per-task bundle selection" / "declarative config.yaml per bundle"
- "SWE-agent /tools directory structure" / "bin/, install.sh, config.yaml"
- "Voyager skill library — what is it?" / "runtime-learned skill library concept (Wang et al. 2023)"
- "Voyager JavaScript skill functions" / "skill embedding retrieval top-5"
- "Voyager automatic curriculum + iterative prompting + self-verification"
- "JARVIS-1 vs Voyager" / "multimodal memory vs skill library"
- "ExpeL paper — experiential learners" / "natural-language insight extraction"
- "Agent Workflow Memory paper" / "web-agent runtime learning"
- "runtime-learned skills vs authored SKILL.md — disambiguation"
- "two meanings of skill — Voyager (runtime code) vs agentskills.io (authored file)"
- "who productionized Voyager's runtime skill library?" (Letta — skill-creator skill)
- "Letta skill-creator skill" / "runtime skill creation by the agent"
- "Letta stateful agents + skills + subagents"
- "Letta multi-scope skills (global, agent-scoped, project-scoped)"
- "OpenAI Agents SDK Agent.as_tool()" / "specialist-agent-as-skill"
- "OpenAI Agents SDK ToolSearchTool + defer_loading" / "lazy schema loading for long-running agents"
- "Codex Cloud container.skill_id / inline skill bundles"
- "Codex core-skills Rust crate modules (loader, manager, model, render, injection)"
- "Magentic-One specialist agents = skill domains" / "agent-as-skill without formalization"
- "Microsoft AutoGen SkillBuilder removed" / "BaseTool + FunctionTool + Workbench"
- "LangChain has no skill primitive above Tool" / "Tool-centric capability model"
- "LangChain deepagents tools" / "write_todos + filesystem + execute + task subagent"
- "Pydantic-AI Toolsets" / "CombinedToolset / FilteredToolset / PrefixedToolset / RenamedToolset / WrapperToolset"
- "CrewAI 2026 Agent Skills adoption" / "Skills are NOT tools — explicit distinction"
- "CrewAI three-axis model — skills + tools + backstory"
- "AutoGPT abilities vs blocks" / "classic vs platform — historical"
- "Firebender skills" / "runtime selection, Android-coding agent"
- "Factory CLI Droids + skills" / "skill-skill chaining in plans"
- "Databricks Genie skills" / "data-platform narrow skills"
- "GitHub Copilot agent skills autonomous use"
- "Bedrock AgentCore has no skill primitive" / "Gateway ≠ skill"
- "Bedrock Agents Action Groups vs Knowledge Bases"
- "CodeAct paper / Python-as-action (ICLR 2025)"
- "Hermes function calling + GOAP scratch_pad" / "no skill primitive"
- "Claude Platform Agent Skills (API-level)" / "container: skill_id / beta headers"
- "Does a tool library need to ship runtime skill learning?" (no — compose Write + Skill)
- "Autonomous-specific skill pitfalls" / "trust gating, compaction survival, already-loaded dedupe"
- "Autonomous Skill hook contract extensions" / "projectTrust, sessionId, projectScope"
- "Autonomous Skill output extensions" / "already_loaded, trust_required, wrappedBody"
- "SkillRegistry autonomous-mode extensions" / "recordActivation, isActivated, listResources, getProjectTrust"
- "Minimum viable autonomous-agent skill contract"
- "Three orthogonal autonomous skill features" / "authored SKILL.md + runtime creation + lazy schema loading"
- "Decision matrix — ship Skill for which kind of autonomous harness?"
- "Why Magentic-One uses specialist-agents instead of skills" / "agent-as-skill scales poorly"
- "Why Voyager doesn't scale to production code" / "hallucination + retrieval drift"
- "How OpenHands agent_skills Python library differs from SKILL.md standard"
- "Why OpenHands uses IPython-as-action instead of function calling" / "CodeAct ~20% lift"
- "Authoring vs learning skills — two different problems with the same word"

## Quick Lookup

| Keyword | Guide |
|---------|-------|
| Read tool | agent-read-tool.md |
| read_file | agent-read-tool.md |
| readFile | agent-read-tool.md |
| file_search (OpenAI) | agent-read-tool.md, agent-search-tools.md |
| offset / limit | agent-read-tool.md |
| cat -n format | agent-read-tool.md |
| absolute path (tool schema) | agent-read-tool.md |
| Aider /add /read-only /drop | agent-read-tool.md, agent-search-tools.md |
| Cline Plan mode | agent-read-tool.md |
| OpenCode read permission | agent-read-tool.md |
| Continue readFile | agent-read-tool.md |
| Codex shell tool | agent-read-tool.md, agent-search-tools.md, harness-tool-surface-audit.md, exec-tool-design-across-harnesses.md |
| subagent file exploration | agent-read-tool.md, agent-search-tools.md |
| repo map (Aider) | agent-read-tool.md, agent-search-tools.md, ai-agent-harness-tooling.md, lsp-tool-design-across-harnesses.md |
| PDF / notebook / image reading | agent-read-tool.md |
| token budget file reads | agent-read-tool.md, agent-search-tools.md |
| context rot | agent-read-tool.md, agent-search-tools.md, ai-agent-harness-tooling.md |
| tool_use / tool_result | agent-tool-use-methods.md, ai-agent-harness-tooling.md |
| function calling | agent-tool-use-methods.md, ai-agent-harness-tooling.md |
| tool_choice (auto/any/tool/none) | agent-tool-use-methods.md |
| strict mode / strict: true | agent-tool-use-methods.md, ai-agent-harness-tooling.md, testing-harness-tools.md |
| structured outputs | agent-tool-use-methods.md |
| parallel_tool_calls | agent-tool-use-methods.md, ai-agent-harness-tooling.md |
| disable_parallel_tool_use | agent-tool-use-methods.md |
| fine-grained tool streaming | agent-tool-use-methods.md |
| eager_input_streaming | agent-tool-use-methods.md |
| input_json_delta | agent-tool-use-methods.md |
| defer_loading | agent-tool-use-methods.md, harness-tool-surface-audit.md, skill-tool-in-autonomous-agents.md |
| tool_search_tool_regex / bm25 | agent-tool-use-methods.md |
| input_examples | agent-tool-use-methods.md, ai-agent-harness-tooling.md |
| MCP / Model Context Protocol | agent-tool-use-methods.md, ai-agent-harness-tooling.md, agent-write-across-ecosystems.md, testing-harness-tools.md, harness-tool-surface-audit.md, exec-tool-design-across-harnesses.md, lsp-tool-design-across-harnesses.md, skill-tool-design-across-harnesses.md |
| tools/list / tools/call | agent-tool-use-methods.md, ai-agent-harness-tooling.md |
| JSON-RPC 2.0 | agent-tool-use-methods.md, ai-agent-harness-tooling.md, lsp-tool-design-across-harnesses.md |
| stdio transport / Streamable HTTP | agent-tool-use-methods.md, ai-agent-harness-tooling.md |
| JSON mode | agent-tool-use-methods.md |
| repair loop | agent-tool-use-methods.md, agent-write-across-ecosystems.md, testing-harness-tools.md |
| grammar-constrained decoding | agent-tool-use-methods.md, ai-agent-harness-tooling.md |
| BFCL | agent-tool-use-methods.md, testing-harness-tools.md |
| Berkeley Function Calling Leaderboard | agent-tool-use-methods.md, testing-harness-tools.md |
| ToolBench / ToolLLM | agent-tool-use-methods.md |
| Gorilla / APIBench | agent-tool-use-methods.md |
| Toolformer | agent-tool-use-methods.md |
| Responses API (OpenAI) | agent-tool-use-methods.md, ai-agent-harness-tooling.md |
| tool description best practices | agent-tool-use-methods.md, ai-agent-harness-tooling.md, testing-harness-tools.md |
| schema design (enums / required) | agent-tool-use-methods.md |
| Glob tool / glob pattern | agent-search-tools.md, glob-impl-and-prompts-in-major-tools.md |
| Glob tool description (verbatim) | glob-impl-and-prompts-in-major-tools.md |
| Glob tool schema (pattern, path) | glob-impl-and-prompts-in-major-tools.md |
| Glob vs Grep (separate tools design) | glob-impl-and-prompts-in-major-tools.md, agent-search-tools.md |
| Grep tool | agent-search-tools.md |
| ripgrep / rg | agent-search-tools.md, glob-impl-and-prompts-in-major-tools.md |
| rg --files -g (file discovery) | glob-impl-and-prompts-in-major-tools.md, agent-search-tools.md |
| output_mode (files_with_matches / content / count) | agent-search-tools.md |
| head_limit / offset (pagination) | agent-search-tools.md |
| multiline regex / -U / --multiline-dotall | agent-search-tools.md |
| literal braces / -F / fixed-strings | agent-search-tools.md |
| --type vs --glob (ripgrep) | agent-search-tools.md |
| .gitignore / .rgignore | agent-search-tools.md, glob-impl-and-prompts-in-major-tools.md |
| Codex sandbox pre-approved commands | agent-search-tools.md, ai-agent-harness-tooling.md, exec-tool-design-across-harnesses.md |
| Aider repo-map (tree-sitter / PageRank) | agent-search-tools.md, ai-agent-harness-tooling.md, lsp-tool-design-across-harnesses.md |
| Cline search_files / list_files | agent-search-tools.md, glob-impl-and-prompts-in-major-tools.md, harness-tool-surface-audit.md |
| Cline list_code_definition_names | agent-search-tools.md, harness-tool-surface-audit.md, lsp-tool-design-across-harnesses.md |
| Cline file_pattern param | glob-impl-and-prompts-in-major-tools.md |
| OpenCode grep / glob tools | agent-search-tools.md, glob-impl-and-prompts-in-major-tools.md, harness-tool-surface-audit.md |
| OpenCode glob.ts / glob.txt | glob-impl-and-prompts-in-major-tools.md |
| Gemini CLI glob / FindFiles | glob-impl-and-prompts-in-major-tools.md, harness-tool-surface-audit.md |
| Continue FileGlobSearch / globSearch.ts | glob-impl-and-prompts-in-major-tools.md, harness-tool-surface-audit.md |
| MCP filesystem search_files | glob-impl-and-prompts-in-major-tools.md, agent-write-across-ecosystems.md, harness-tool-surface-audit.md |
| MCP filesystem list_directory / directory_tree | glob-impl-and-prompts-in-major-tools.md, harness-tool-surface-audit.md |
| SWE-agent find_file | glob-impl-and-prompts-in-major-tools.md, harness-tool-surface-audit.md |
| OpenHands find_file / file_ops | glob-impl-and-prompts-in-major-tools.md |
| LangChain FileSearchTool | glob-impl-and-prompts-in-major-tools.md, agent-write-across-ecosystems.md, harness-tool-surface-audit.md |
| LangChain FileManagementToolkit | glob-impl-and-prompts-in-major-tools.md, agent-write-across-ecosystems.md, harness-tool-surface-audit.md |
| Codex list_dir / ListDirHandler | glob-impl-and-prompts-in-major-tools.md |
| Codex rg --files guidance | glob-impl-and-prompts-in-major-tools.md |
| node-glob / isaacs/node-glob | glob-impl-and-prompts-in-major-tools.md |
| minimatch (glob engine) | glob-impl-and-prompts-in-major-tools.md |
| fast-glob | glob-impl-and-prompts-in-major-tools.md |
| globstar ** semantics | glob-impl-and-prompts-in-major-tools.md |
| brace expansion {ts,tsx} | glob-impl-and-prompts-in-major-tools.md |
| dotfile / hidden-file default exclusion | glob-impl-and-prompts-in-major-tools.md |
| node_modules / .git auto-exclusion | glob-impl-and-prompts-in-major-tools.md |
| case_sensitive glob param | glob-impl-and-prompts-in-major-tools.md |
| respect_git_ignore / respect_gemini_ignore | glob-impl-and-prompts-in-major-tools.md |
| mtime-sorted results | agent-search-tools.md, glob-impl-and-prompts-in-major-tools.md |
| 100-result cap (glob truncation) | glob-impl-and-prompts-in-major-tools.md |
| truncation marker design | glob-impl-and-prompts-in-major-tools.md |
| optional-path footgun / "undefined" string | glob-impl-and-prompts-in-major-tools.md |
| Bash(find) bypass / find anti-pattern | glob-impl-and-prompts-in-major-tools.md, agent-search-tools.md |
| Glob tool design for @agent-sh/harness | glob-impl-and-prompts-in-major-tools.md |
| PATH_NOT_IN_WORKSPACE error (Gemini) | glob-impl-and-prompts-in-major-tools.md |
| GLOB_EXECUTION_ERROR | glob-impl-and-prompts-in-major-tools.md |
| use Agent/Task tool for open-ended search | glob-impl-and-prompts-in-major-tools.md |
| sub-agent / Task delegation for search | agent-search-tools.md, ai-agent-harness-tooling.md, glob-impl-and-prompts-in-major-tools.md |
| ls -R anti-pattern | agent-search-tools.md |
| find . anti-pattern | agent-search-tools.md, glob-impl-and-prompts-in-major-tools.md |
| Bash(grep) vs Grep tool | agent-search-tools.md |
| OpenAI file_search (vector store) | agent-search-tools.md, harness-tool-surface-audit.md, lsp-tool-design-across-harnesses.md |
| harness, agent harness | ai-agent-harness-tooling.md |
| Claude Agent SDK | ai-agent-harness-tooling.md, agent-write-edit-tools.md, harness-tool-surface-audit.md, exec-tool-design-across-harnesses.md, skill-tool-design-across-harnesses.md |
| Claude Code (architecture) | ai-agent-harness-tooling.md |
| Codex CLI (architecture) | ai-agent-harness-tooling.md |
| Cursor agent | ai-agent-harness-tooling.md, glob-impl-and-prompts-in-major-tools.md, harness-tool-surface-audit.md, lsp-tool-design-across-harnesses.md |
| Aider unified diff / edit formats | ai-agent-harness-tooling.md, agent-write-edit-tools.md |
| Cline (architecture), OpenCode, Continue | ai-agent-harness-tooling.md |
| agentic loop, stop_reason, tool_use | ai-agent-harness-tooling.md |
| permission mode, auto mode, sandbox, /sandbox | ai-agent-harness-tooling.md, exec-tool-design-across-harnesses.md |
| hooks (PreToolUse/PostToolUse/Stop/SessionStart) | ai-agent-harness-tooling.md, agent-write-edit-tools.md, exec-tool-design-across-harnesses.md, lsp-tool-design-across-harnesses.md, skill-tool-design-across-harnesses.md |
| subagent, sub-agent, handoff, Agent tool | ai-agent-harness-tooling.md, harness-tool-surface-audit.md, skill-tool-design-across-harnesses.md, skill-tool-in-autonomous-agents.md |
| context compaction, /clear, /compact, /rewind | ai-agent-harness-tooling.md, skill-tool-design-across-harnesses.md, skill-tool-in-autonomous-agents.md |
| CLAUDE.md, AGENTS.md as memory files | ai-agent-harness-tooling.md, skill-tool-design-across-harnesses.md, skill-tool-in-autonomous-agents.md |
| server-executed tools (web_search, code_execution) | ai-agent-harness-tooling.md, webfetch-tool-design-across-harnesses.md |
| pause_turn, MaxTurnsExceeded | ai-agent-harness-tooling.md, webfetch-tool-design-across-harnesses.md |
| reasoning preservation (Responses API) | ai-agent-harness-tooling.md |
| lethal trifecta, prompt injection in agents | ai-agent-harness-tooling.md, webfetch-tool-design-across-harnesses.md |
| reinforcement (Ronacher) | ai-agent-harness-tooling.md, harness-tool-surface-audit.md, exec-tool-design-across-harnesses.md, lsp-tool-design-across-harnesses.md |
| closed vs open agent ecosystems | ai-agent-harness-tooling.md |
| checkpoints, /rewind, agent rollback | ai-agent-harness-tooling.md, agent-write-edit-tools.md |
| Write / Edit / MultiEdit / NotebookEdit | agent-write-edit-tools.md, harness-tool-surface-audit.md |
| str_replace_based_edit_tool | agent-write-edit-tools.md |
| text_editor_20250728 / text_editor_20250124 | agent-write-edit-tools.md |
| read-before-edit invariant | agent-write-edit-tools.md, agent-write-across-ecosystems.md, testing-harness-tools.md, lsp-tool-design-across-harnesses.md |
| apply_patch | agent-write-edit-tools.md, agent-write-across-ecosystems.md, harness-tool-surface-audit.md |
| V4A diff format | agent-write-edit-tools.md, agent-write-across-ecosystems.md |
| *** Begin Patch / *** End Patch | agent-write-edit-tools.md |
| SEARCH/REPLACE blocks | agent-write-edit-tools.md, agent-write-across-ecosystems.md |
| whole / diff / diff-fenced / udiff | agent-write-edit-tools.md |
| unified diff (LLM) | agent-write-edit-tools.md |
| Aider edit formats | agent-write-edit-tools.md |
| Aider architect mode | agent-write-edit-tools.md, harness-tool-surface-audit.md |
| Aider polyglot leaderboard | agent-write-edit-tools.md |
| write_to_file / replace_in_file (Cline) | agent-write-edit-tools.md, harness-tool-surface-audit.md |
| Cline background edit | agent-write-edit-tools.md |
| OpenCode edit / write / multiedit | agent-write-edit-tools.md, harness-tool-surface-audit.md |
| Codex CLI apply-patch | agent-write-edit-tools.md, harness-tool-surface-audit.md |
| lazy coding placeholders | agent-write-edit-tools.md |
| replace_all pitfalls | agent-write-edit-tools.md |
| atomic multi-file edit | agent-write-edit-tools.md, agent-write-across-ecosystems.md, testing-harness-tools.md, harness-tool-surface-audit.md |
| edit reliability / no match found | agent-write-edit-tools.md, agent-write-across-ecosystems.md, testing-harness-tools.md |
| OpenHands / OpenDevin | agent-write-across-ecosystems.md, glob-impl-and-prompts-in-major-tools.md, harness-tool-surface-audit.md, exec-tool-design-across-harnesses.md, webfetch-tool-design-across-harnesses.md, lsp-tool-design-across-harnesses.md, skill-tool-design-across-harnesses.md, skill-tool-in-autonomous-agents.md |
| CodeActAgent | agent-write-across-ecosystems.md, harness-tool-surface-audit.md, exec-tool-design-across-harnesses.md, skill-tool-in-autonomous-agents.md |
| str_replace_editor (OpenHands) | agent-write-across-ecosystems.md, harness-tool-surface-audit.md |
| LLMBasedFileEditTool | agent-write-across-ecosystems.md |
| SWE-agent | agent-write-across-ecosystems.md, testing-harness-tools.md, glob-impl-and-prompts-in-major-tools.md, harness-tool-surface-audit.md, exec-tool-design-across-harnesses.md, lsp-tool-design-across-harnesses.md, skill-tool-in-autonomous-agents.md |
| ACI / Agent-Computer Interface | agent-write-across-ecosystems.md, harness-tool-surface-audit.md, exec-tool-design-across-harnesses.md, lsp-tool-design-across-harnesses.md, skill-tool-in-autonomous-agents.md |
| edit N:M / edit_linting | agent-write-across-ecosystems.md, harness-tool-surface-audit.md |
| lint-on-save / flake8 gate | agent-write-across-ecosystems.md |
| Devin / Cognition AI | agent-write-across-ecosystems.md |
| Agentless | agent-write-across-ecosystems.md |
| rejection sampling for edits | agent-write-across-ecosystems.md |
| AutoGPT WriteFile | agent-write-across-ecosystems.md, harness-tool-surface-audit.md |
| AutoGPT classic vs platform | harness-tool-surface-audit.md, skill-tool-in-autonomous-agents.md |
| AutoGPT abilities / blocks | skill-tool-in-autonomous-agents.md |
| BabyAGI | agent-write-across-ecosystems.md |
| CrewAI FileWriterTool / FileReadTool | agent-write-across-ecosystems.md, harness-tool-surface-audit.md |
| CrewAI skills (2026 adoption) / Skills are NOT tools | skill-tool-in-autonomous-agents.md |
| CrewAI agent / role / goal / backstory / tools | skill-tool-in-autonomous-agents.md |
| LangChain FileManagementToolkit / WriteFileTool | agent-write-across-ecosystems.md, glob-impl-and-prompts-in-major-tools.md, harness-tool-surface-audit.md |
| LangChain deepagents / edit_file | agent-write-across-ecosystems.md, skill-tool-in-autonomous-agents.md |
| LangGraph file tools | agent-write-across-ecosystems.md |
| LangGraph subgraphs as subagents | skill-tool-in-autonomous-agents.md |
| Microsoft Autogen / Magentic-One / FileSurfer | agent-write-across-ecosystems.md, harness-tool-surface-audit.md, webfetch-tool-design-across-harnesses.md, skill-tool-in-autonomous-agents.md |
| Magentic-One specialist agents (WebSurfer / FileSurfer / Coder / ComputerTerminal) | skill-tool-in-autonomous-agents.md |
| AutoGen SkillBuilder (removed) | skill-tool-in-autonomous-agents.md |
| LocalCommandLineCodeExecutor | agent-write-across-ecosystems.md, exec-tool-design-across-harnesses.md |
| Hermes function calling / <tool_call> XML | agent-write-across-ecosystems.md, testing-harness-tools.md, skill-tool-in-autonomous-agents.md |
| hermes-agent (Nous Research) | agent-write-across-ecosystems.md, testing-harness-tools.md |
| Hermes-3 GOAP scratch_pad | skill-tool-in-autonomous-agents.md |
| Claw / Nous Claw | agent-write-across-ecosystems.md |
| OpenAI Agents SDK ApplyPatchTool | agent-write-across-ecosystems.md, harness-tool-surface-audit.md |
| ApplyPatchEditor protocol | agent-write-across-ecosystems.md |
| ApplyPatchOperation | agent-write-across-ecosystems.md |
| MCP filesystem server | agent-write-across-ecosystems.md, glob-impl-and-prompts-in-major-tools.md, harness-tool-surface-audit.md |
| MCP write_file / edit_file | agent-write-across-ecosystems.md, harness-tool-surface-audit.md |
| MCP git server (git_status, git_commit, …) | harness-tool-surface-audit.md |
| MCP GitHub server (archived, 26 tools) | harness-tool-surface-audit.md |
| MCP memory server / knowledge graph | harness-tool-surface-audit.md |
| MCP reference servers (Fetch, Filesystem, Git, Memory, Sequential Thinking, Time, Everything) | harness-tool-surface-audit.md, exec-tool-design-across-harnesses.md, webfetch-tool-design-across-harnesses.md, lsp-tool-design-across-harnesses.md |
| applyFileEdits (MCP) | agent-write-across-ecosystems.md |
| autonomous agent Write tool | agent-write-across-ecosystems.md |
| stale-read detection / read-ledger | agent-write-across-ecosystems.md, testing-harness-tools.md |
| transactional multi-file edit / begin_edit commit_edit | agent-write-across-ecosystems.md |
| @agent-sh/harness Write spec | agent-write-across-ecosystems.md, testing-harness-tools.md |
| @agent-sh/harness Glob spec | glob-impl-and-prompts-in-major-tools.md |
| @agent-sh/harness Bash spec / @agent-sh/harness exec design | exec-tool-design-across-harnesses.md |
| @agent-sh/harness WebFetch spec / @agent-sh/harness-webfetch package | webfetch-tool-design-across-harnesses.md |
| @agent-sh/harness LSP spec / @agent-sh/harness-lsp package | lsp-tool-design-across-harnesses.md |
| @agent-sh/harness Skill spec / @agent-sh/harness-skill package | skill-tool-design-across-harnesses.md, skill-tool-in-autonomous-agents.md |
| @agent-sh/harness Skill autonomous-mode extensions | skill-tool-in-autonomous-agents.md |
| @agent-sh/harness next-tool recommendation (Bash / WebFetch / Ask / LSP / Skill) | harness-tool-surface-audit.md, webfetch-tool-design-across-harnesses.md, lsp-tool-design-across-harnesses.md, skill-tool-design-across-harnesses.md |
| virtual filesystem (agent state) | agent-write-across-ecosystems.md |
| Claude Code tool list (2026) | harness-tool-surface-audit.md |
| Claude Code Monitor tool | harness-tool-surface-audit.md, exec-tool-design-across-harnesses.md |
| Claude Code LSP tool | harness-tool-surface-audit.md, lsp-tool-design-across-harnesses.md |
| Claude Code LSP tool behavior (diagnostics-after-edit) | lsp-tool-design-across-harnesses.md |
| Claude Code LSP plugin manifest (.lsp.json) | lsp-tool-design-across-harnesses.md |
| Claude Code code intelligence plugins (11: typescript-lsp, pyright-lsp, rust-analyzer-lsp, ...) | lsp-tool-design-across-harnesses.md |
| Claude Code PowerShell tool | harness-tool-surface-audit.md, exec-tool-design-across-harnesses.md |
| Claude Code EnterWorktree / ExitWorktree | harness-tool-surface-audit.md |
| Claude Code CronCreate / CronList / CronDelete | harness-tool-surface-audit.md |
| Claude Code TaskCreate / TaskGet / TaskList / TaskUpdate / TaskStop | harness-tool-surface-audit.md |
| Claude Code TeamCreate / TeamDelete / SendMessage | harness-tool-surface-audit.md |
| Claude Code AskUserQuestion tool | harness-tool-surface-audit.md |
| Claude Code ExitPlanMode / EnterPlanMode | harness-tool-surface-audit.md |
| Claude Code Skill tool | harness-tool-surface-audit.md, skill-tool-design-across-harnesses.md |
| Claude Code ToolSearch | harness-tool-surface-audit.md, agent-tool-use-methods.md |
| Claude Code ListMcpResourcesTool / ReadMcpResourceTool | harness-tool-surface-audit.md |
| Claude Code BashOutput / KillShell | harness-tool-surface-audit.md, exec-tool-design-across-harnesses.md |
| Claude Code Bash tool / persistent shell / cwd semantics | exec-tool-design-across-harnesses.md |
| CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR | exec-tool-design-across-harnesses.md |
| CLAUDE_ENV_FILE | exec-tool-design-across-harnesses.md |
| Codex shell / container.exec | harness-tool-surface-audit.md, exec-tool-design-across-harnesses.md |
| Codex sandbox_mode / read-only / workspace-write / danger-full-access | exec-tool-design-across-harnesses.md |
| Codex approval_policy / untrusted / on-request / never / granular | exec-tool-design-across-harnesses.md |
| Codex seatbelt / bwrap / seccomp / sandbox-exec | exec-tool-design-across-harnesses.md |
| Codex writable_roots / exclude_slash_tmp / exclude_tmpdir_env_var | exec-tool-design-across-harnesses.md |
| Codex network_access / per-permission network rules | exec-tool-design-across-harnesses.md, webfetch-tool-design-across-harnesses.md |
| Codex shell_environment_policy / include_only / ignore_default_excludes | exec-tool-design-across-harnesses.md |
| Codex unified_exec / PTY-backed / allow_login_shell | exec-tool-design-across-harnesses.md |
| Codex --yolo / dangerously-bypass-approvals-and-sandbox | exec-tool-design-across-harnesses.md |
| Codex update_plan | harness-tool-surface-audit.md |
| Codex view_image | harness-tool-surface-audit.md |
| Codex write_stdout | harness-tool-surface-audit.md |
| Codex web_search | harness-tool-surface-audit.md, webfetch-tool-design-across-harnesses.md |
| Codex codex_tool (experimental) | harness-tool-surface-audit.md |
| Codex Cloud internet access / on-with-restrictions / Common dependencies preset | webfetch-tool-design-across-harnesses.md |
| Codex Cloud container.skill_id / inline skill mounting | skill-tool-in-autonomous-agents.md |
| Codex core-skills crate / AvailableSkills / SkillMetadataBudget | skill-tool-design-across-harnesses.md, skill-tool-in-autonomous-agents.md |
| Codex core-skills crate modules (loader, manager, model, render, injection) | skill-tool-in-autonomous-agents.md |
| Codex $skill-name mention / /skills command | skill-tool-design-across-harnesses.md |
| OpenAI Agents SDK — FileSearchTool / WebSearchTool / CodeInterpreterTool / ComputerTool / ShellTool / LocalShellTool / ApplyPatchTool / ImageGenerationTool / HostedMCPTool / ToolSearchTool | harness-tool-surface-audit.md, exec-tool-design-across-harnesses.md, webfetch-tool-design-across-harnesses.md, lsp-tool-design-across-harnesses.md |
| OpenAI Agents SDK ShellTool / container_auto / container_reference | exec-tool-design-across-harnesses.md |
| OpenAI CodeInterpreterTool (hosted) | exec-tool-design-across-harnesses.md, harness-tool-surface-audit.md |
| OpenAI LocalShellTool vs ShellTool local mode | exec-tool-design-across-harnesses.md |
| Agent.as_tool() (OpenAI Agents SDK) | harness-tool-surface-audit.md, skill-tool-in-autonomous-agents.md |
| OpenAI Agents SDK ToolSearchTool / defer_loading | skill-tool-in-autonomous-agents.md |
| OpenCode bash / read / write / edit / grep / glob / lsp / question / skill / todowrite | harness-tool-surface-audit.md |
| OpenCode bash.ts / timeout / Truncate.MAX_LINES / MAX_BYTES | exec-tool-design-across-harnesses.md |
| OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS | exec-tool-design-across-harnesses.md |
| OpenCode lsp tool (experimental) / OPENCODE_EXPERIMENTAL_LSP_TOOL | lsp-tool-design-across-harnesses.md |
| OpenCode lsp 9-operation enum | lsp-tool-design-across-harnesses.md |
| OpenCode lsp client / didOpen / didChange / 150ms debounce | lsp-tool-design-across-harnesses.md |
| OpenCode LSP server registry / auto-install logic | lsp-tool-design-across-harnesses.md |
| OpenCode skill tool / skill.ts / skill.txt | skill-tool-design-across-harnesses.md |
| OpenCode skill permission (allow/deny/ask) | skill-tool-design-across-harnesses.md |
| Cline ask_followup_question / attempt_completion / new_task / use_mcp_tool / access_mcp_resource / browser_action | harness-tool-surface-audit.md, webfetch-tool-design-across-harnesses.md |
| Cline execute_command / requires_approval | exec-tool-design-across-harnesses.md, harness-tool-surface-audit.md |
| Cline proceed-while-running / suppressUserInteraction | exec-tool-design-across-harnesses.md |
| Cline @url context / browser_action (no WebFetch) | webfetch-tool-design-across-harnesses.md |
| Cline tree-sitter service / tags.scm | lsp-tool-design-across-harnesses.md |
| Cline has NO Skill tool / .clinerules alternative | skill-tool-design-across-harnesses.md |
| Roo Code apply_diff / edit_file / search_replace / edit / apply_patch (5 edit tools) | harness-tool-surface-audit.md |
| Roo Code generate_image / codebase_search / update_todo_list / switch_mode | harness-tool-surface-audit.md |
| Roo Code skills / mode-scoped skills-code/ skills-architect/ | skill-tool-design-across-harnesses.md |
| Cursor Semantic Search / Search Files and Folders / Read Files / Edit Files / Run Shell / Web / Browser / Image Generation | harness-tool-surface-audit.md, lsp-tool-design-across-harnesses.md |
| Cursor Run Shell Commands | harness-tool-surface-audit.md, exec-tool-design-across-harnesses.md |
| Cursor /migrate-to-skills | skill-tool-design-across-harnesses.md |
| Gemini CLI read_file / read_many_files / list_directory / ls / glob / grep / ripGrep / search_file_content / edit / write_file / shell / shellBackgroundTools / web_fetch / web_search / save_memory / ask-user / activate-skill / complete-task / enter-plan-mode / exit-plan-mode / write-todos | harness-tool-surface-audit.md |
| Gemini CLI shell.ts / inactivity timeout / binary halt | exec-tool-design-across-harnesses.md |
| Gemini CLI shellBackgroundTools / list_background_processes / read_background_output | exec-tool-design-across-harnesses.md |
| Gemini CLI sandbox-denial parsing | exec-tool-design-across-harnesses.md |
| Gemini CLI is_background / delay_ms / additional_permissions | exec-tool-design-across-harnesses.md |
| Gemini CLI web-fetch.ts / URL_FETCH_TIMEOUT_MS / MAX_CONTENT_LENGTH / isPrivateIp / sanitizeXml | webfetch-tool-design-across-harnesses.md |
| Gemini CLI activate-skill.ts / dynamic name enum | skill-tool-design-across-harnesses.md |
| Continue codebaseTool / createNewFile / editFile / multiEdit / singleFindAndReplace / readFile / readFileRange / readCurrentlyOpenFile / runTerminalCommand / globSearch / grepSearch / searchWeb / fetchUrlContent / viewDiff / viewRepoMap / viewSubdirectory / createRuleBlock / requestRule / readSkill / ls | harness-tool-surface-audit.md |
| Continue runTerminalCommand / waitForCompletion / evaluateTerminalCommandSecurity | exec-tool-design-across-harnesses.md |
| Continue fetchUrlContent / URLContextProvider / DEFAULT_FETCH_URL_CHAR_LIMIT | webfetch-tool-design-across-harnesses.md |
| Continue readSkill tool / loadMarkdownSkills | skill-tool-design-across-harnesses.md |
| SWE-agent open / goto / edit / scroll_up / scroll_down / search_dir / search_file / find_file / create / submit / filemap | harness-tool-surface-audit.md |
| SWE-agent tool bundles / windowed / edit_anthropic / search / filemap | skill-tool-in-autonomous-agents.md |
| SWE-agent ACI 100-line file viewer / empty-output message | exec-tool-design-across-harnesses.md, lsp-tool-design-across-harnesses.md |
| OpenHands str_replace_editor / execute_bash / browse / web_read / finish / think | harness-tool-surface-audit.md, webfetch-tool-design-across-harnesses.md |
| OpenHands CmdRunAction / IPythonRunCellAction | exec-tool-design-across-harnesses.md, harness-tool-surface-audit.md, skill-tool-in-autonomous-agents.md |
| OpenHands agent_skills plugin (Python library) | skill-tool-in-autonomous-agents.md |
| OpenHands microagents (deprecated) | skill-tool-in-autonomous-agents.md |
| OpenHands extensions registry (45 extensions) | skill-tool-in-autonomous-agents.md |
| OpenHands triggers: YAML field / keyword triggers | skill-tool-in-autonomous-agents.md |
| OpenHands tmux persistent shell / is_input / blocking / is_static | exec-tool-design-across-harnesses.md |
| OpenHands Jupyter kernel / kernel_init_code | exec-tool-design-across-harnesses.md |
| OpenHands BrowsingAgent / browser-backed web access | webfetch-tool-design-across-harnesses.md |
| OpenHands skills / always-on / keyword-triggered / agent-invoked | skill-tool-design-across-harnesses.md, skill-tool-in-autonomous-agents.md |
| CodeAct paper (Wang et al. ICLR 2025) / Python-as-action | exec-tool-design-across-harnesses.md, skill-tool-in-autonomous-agents.md |
| Pydantic-AI duckduckgo_search_tool / tavily_search_tool / exa_* / web_fetch_tool (SSRF) | harness-tool-surface-audit.md, webfetch-tool-design-across-harnesses.md |
| Pydantic-AI Toolsets / CombinedToolset / FilteredToolset / PrefixedToolset | skill-tool-in-autonomous-agents.md |
| Amazon Bedrock AgentCore Runtime / Memory / Code Interpreter / Browser / Gateway / Identity / Observability | harness-tool-surface-audit.md, exec-tool-design-across-harnesses.md |
| Bedrock AgentCore has no skill primitive / Gateway is tool not skill | skill-tool-in-autonomous-agents.md |
| Amazon Bedrock Agents Action Groups / Knowledge Bases / Code Interpreter / Return Control / User Input | harness-tool-surface-audit.md, skill-tool-in-autonomous-agents.md |
| E2B Code Interpreter / Firecracker microVM | exec-tool-design-across-harnesses.md |
| E2B commands.run vs runCode / run_code | exec-tool-design-across-harnesses.md |
| Daytona sandbox for agents / process.code_run / process.execute_command | exec-tool-design-across-harnesses.md |
| AutoGen LocalCommandLineCodeExecutor / DockerCommandLineCodeExecutor | exec-tool-design-across-harnesses.md, agent-write-across-ecosystems.md |
| AutoGen create_default_code_executor() | exec-tool-design-across-harnesses.md |
| AutoGen WebSurfer / Magentic-One / visit_page / page_up / find_on_page / answer_from_page | webfetch-tool-design-across-harnesses.md |
| LangChain ShellTool / BashTool / PythonREPLTool | exec-tool-design-across-harnesses.md |
| LangChain RequestsGetTool / RequestsPostTool / RequestsToolkit / allow_dangerous_requests | webfetch-tool-design-across-harnesses.md |
| Aider /run / /test commands | exec-tool-design-across-harnesses.md |
| firejail / bwrap / nsjail | exec-tool-design-across-harnesses.md |
| SandboxAdapter interface (pluggable sandbox) | exec-tool-design-across-harnesses.md |
| LspClient interface (pluggable LSP) | lsp-tool-design-across-harnesses.md |
| SkillRegistry / FilesystemSkillRegistry interface | skill-tool-design-across-harnesses.md, skill-tool-in-autonomous-agents.md |
| SkillRegistry autonomous extensions (projectTrust, recordActivation, listResources) | skill-tool-in-autonomous-agents.md |
| createBashPermissionPolicy / pattern-based allowlist | exec-tool-design-across-harnesses.md |
| createWebFetchPermissionPolicy / domain-pattern allowlist | webfetch-tool-design-across-harnesses.md |
| createLspPermissionPolicy | lsp-tool-design-across-harnesses.md |
| createSkillPermissionPolicy / skill allow-list | skill-tool-design-across-harnesses.md |
| inactivity timeout vs wall-clock timeout | exec-tool-design-across-harnesses.md |
| stream-to-file on output overflow | exec-tool-design-across-harnesses.md |
| description field (auditability) | exec-tool-design-across-harnesses.md |
| discriminated-union Bash result (timeout/denied/killed/truncated) | exec-tool-design-across-harnesses.md |
| discriminated-union WebFetch result (text/pdf/redirect_cross_host/error) | webfetch-tool-design-across-harnesses.md |
| discriminated-union LSP result (ok/no_results/server_not_available/server_starting/position_invalid/timeout/error) | lsp-tool-design-across-harnesses.md |
| discriminated-union Skill result (ok/not_found/permission_denied/outside_workspace/disabled/invalid_frontmatter/error) | skill-tool-design-across-harnesses.md |
| autonomous Skill result extensions (already_loaded / trust_required / wrappedBody) | skill-tool-in-autonomous-agents.md |
| interactive command detection | exec-tool-design-across-harnesses.md |
| background PID-keyed BashOutput/KillBash | exec-tool-design-across-harnesses.md |
| autonomous agent exec permission (no ask) | exec-tool-design-across-harnesses.md |
| Ronacher LLM chaos monkey | harness-tool-surface-audit.md, exec-tool-design-across-harnesses.md, lsp-tool-design-across-harnesses.md |
| Simon Willison Claude Code commentary | exec-tool-design-across-harnesses.md, harness-tool-surface-audit.md |
| Simon Willison lethal trifecta | ai-agent-harness-tooling.md, webfetch-tool-design-across-harnesses.md |
| Simon Willison: Claude Skills are awesome, maybe a bigger deal than MCP | skill-tool-design-across-harnesses.md, skill-tool-in-autonomous-agents.md |
| CrewAI tool catalog (40+ integrations) | harness-tool-surface-audit.md |
| CrewAI ScrapeWebsiteTool / FirecrawlScrapeWebsiteTool / WebsiteSearchTool | webfetch-tool-design-across-harnesses.md |
| LangChain CopyFileTool / DeleteFileTool / MoveFileTool / ReadFileTool / WriteFileTool / ListDirectoryTool / FileSearchTool | harness-tool-surface-audit.md |
| Claude Code vs Codex CLI tool-count (30+ vs 6) | harness-tool-surface-audit.md |
| find-and-rename-symbol as a tool (ecosystem gap) | harness-tool-surface-audit.md, lsp-tool-design-across-harnesses.md |
| ListMyTools / permission introspection (ecosystem gap) | harness-tool-surface-audit.md |
| same-name-different-shape tools (Read, Edit, Grep) | harness-tool-surface-audit.md |
| same-shape-different-name tools (read_file aliases) | harness-tool-surface-audit.md |
| table-stakes tools (Read / Write / Edit / Shell / Ask / Glob / Grep / Web / Finish) | harness-tool-surface-audit.md |
| WebFetch tool / URL fetch tool | webfetch-tool-design-across-harnesses.md |
| WebFetch(domain:example.com) permission rule | webfetch-tool-design-across-harnesses.md |
| WebFetch domain safety check / skipWebFetchPreflight | webfetch-tool-design-across-harnesses.md |
| WebFetch 15-minute cache (really 5-min hostname preflight) | webfetch-tool-design-across-harnesses.md |
| WebFetch HTTP to HTTPS upgrade | webfetch-tool-design-across-harnesses.md |
| WebFetch REDIRECT DETECTED cross-host message | webfetch-tool-design-across-harnesses.md |
| WebFetch sub-model summarization (Claude Code pattern) | webfetch-tool-design-across-harnesses.md |
| WebFetch "treat content as information, not instructions" wording | webfetch-tool-design-across-harnesses.md |
| Anthropic API web_fetch_20250910 / web_fetch_20260209 server tool | webfetch-tool-design-across-harnesses.md |
| Anthropic API URL-provenance rule / URLs in context | webfetch-tool-design-across-harnesses.md |
| Anthropic API web_fetch error codes (url_not_allowed, unsupported_content_type, ...) | webfetch-tool-design-across-harnesses.md |
| Anthropic API web_fetch max_uses / max_content_tokens / citations | webfetch-tool-design-across-harnesses.md |
| Anthropic API dynamic filtering (web_fetch_20260209) | webfetch-tool-design-across-harnesses.md |
| Anthropic API homograph attack warning / Unicode domain normalization | webfetch-tool-design-across-harnesses.md |
| Anthropic API allowed_callers / ZDR and web tools | webfetch-tool-design-across-harnesses.md |
| OpenCode webfetch / webfetch.ts / webfetch.txt | webfetch-tool-design-across-harnesses.md |
| OpenCode Turndown config / HTML-to-markdown | webfetch-tool-design-across-harnesses.md |
| OpenCode MAX_RESPONSE_SIZE 5MB / hard-reject on overflow | webfetch-tool-design-across-harnesses.md |
| OpenCode Cloudflare 403 challenge retry with User-Agent | webfetch-tool-design-across-harnesses.md |
| MCP Fetch reference server / fetch tool | webfetch-tool-design-across-harnesses.md |
| MCP Fetch readabilipy + markdownify (readability pipeline) | webfetch-tool-design-across-harnesses.md |
| MCP Fetch start_index / max_length continuation | webfetch-tool-design-across-harnesses.md |
| MCP Fetch robots.txt / Protego | webfetch-tool-design-across-harnesses.md |
| Mozilla Readability / @mozilla/readability (TS) | webfetch-tool-design-across-harnesses.md |
| Turndown (HTML to markdown library) | webfetch-tool-design-across-harnesses.md |
| html-to-text (Gemini CLI) | webfetch-tool-design-across-harnesses.md |
| SSRF / Server-Side Request Forgery | webfetch-tool-design-across-harnesses.md |
| SSRF defense at tool layer vs sandbox layer vs hook layer | webfetch-tool-design-across-harnesses.md |
| private IP blocklist / RFC1918 / 169.254.169.254 metadata | webfetch-tool-design-across-harnesses.md |
| IPv6 link-local / ::1 / fc00::/7 / fe80::/10 | webfetch-tool-design-across-harnesses.md |
| prompt injection defense in WebFetch | webfetch-tool-design-across-harnesses.md |
| URL-provenance restriction / URL must appear in context | webfetch-tool-design-across-harnesses.md |
| XML entity escaping / sanitizeXml (Gemini) | webfetch-tool-design-across-harnesses.md |
| HTML readability-style extraction vs full-page conversion | webfetch-tool-design-across-harnesses.md |
| soft-truncate + nextStartIndex continuation | webfetch-tool-design-across-harnesses.md |
| cross-host redirect surfacing | webfetch-tool-design-across-harnesses.md |
| discriminated WebFetch error codes | webfetch-tool-design-across-harnesses.md |
| GET-only verb scope for WebFetch | webfetch-tool-design-across-harnesses.md |
| arbitrary HTTP headers in WebFetch (route to Bash(curl)) | webfetch-tool-design-across-harnesses.md |
| headless browser vs HTTP fetch split | webfetch-tool-design-across-harnesses.md |
| Playwright MCP / browser_navigate / browser_snapshot | webfetch-tool-design-across-harnesses.md |
| browser-use (Playwright agent) | webfetch-tool-design-across-harnesses.md |
| Chrome DevTools MCP | webfetch-tool-design-across-harnesses.md |
| WebSearch vs WebFetch (discovery vs retrieval) | webfetch-tool-design-across-harnesses.md |
| WebFetch permission hook contract / conversationUrls | webfetch-tool-design-across-harnesses.md |
| LSP tool / language server tool | lsp-tool-design-across-harnesses.md |
| LSP 3.17 specification | lsp-tool-design-across-harnesses.md |
| LSP position encoding / UTF-16 / 0-indexed / 1-indexed | lsp-tool-design-across-harnesses.md |
| LSP initialize / initialized / InitializeResult / -32002 | lsp-tool-design-across-harnesses.md |
| textDocument/didOpen / didChange / publishDiagnostics | lsp-tool-design-across-harnesses.md |
| Hover.contents union / MarkupContent / MarkedString | lsp-tool-design-across-harnesses.md |
| Location / LocationLink | lsp-tool-design-across-harnesses.md |
| WorkspaceEdit / textDocument/rename | lsp-tool-design-across-harnesses.md |
| workspace/symbol / documentSymbol | lsp-tool-design-across-harnesses.md |
| textDocument/references / includeDeclaration | lsp-tool-design-across-harnesses.md |
| textDocument/implementation | lsp-tool-design-across-harnesses.md |
| callHierarchy / incomingCalls / outgoingCalls | lsp-tool-design-across-harnesses.md |
| textDocument/codeAction | lsp-tool-design-across-harnesses.md |
| textDocument/completion / signatureHelp | lsp-tool-design-across-harnesses.md |
| textDocument/pullDiagnostics (v3.17) | lsp-tool-design-across-harnesses.md |
| Serena MCP / semantic symbol tools | lsp-tool-design-across-harnesses.md |
| Serena find_symbol / replace_symbol_body / rename | lsp-tool-design-across-harnesses.md |
| mcp-language-server (isaacphi) | lsp-tool-design-across-harnesses.md |
| mcp-language-server definition/references/diagnostics/hover/rename_symbol/edit_file | lsp-tool-design-across-harnesses.md |
| lsp-mcp (jonrad) / dynamic capability generation | lsp-tool-design-across-harnesses.md |
| Multilspy library / SyncLanguageServer / LanguageServer | lsp-tool-design-across-harnesses.md |
| Multilspy request_definition / request_references / request_hover / request_document_symbols | lsp-tool-design-across-harnesses.md |
| monitors4codegen / Monitor-Guided Decoding | lsp-tool-design-across-harnesses.md |
| MGD NeurIPS 2023 / 19-25% compilation-rate lift | lsp-tool-design-across-harnesses.md |
| vscode-jsonrpc / vscode-languageserver-protocol / vscode-languageclient | lsp-tool-design-across-harnesses.md |
| typescript-language-server / tsserver | lsp-tool-design-across-harnesses.md |
| gopls / rust-analyzer / pyright / clangd | lsp-tool-design-across-harnesses.md |
| pyright-langserver / pyright venv detection | lsp-tool-design-across-harnesses.md |
| rust-analyzer cold-start / indexing latency | lsp-tool-design-across-harnesses.md |
| Eclipse JDTLS / jedi-language-server / OmniSharp / Intelephense / Solargraph | lsp-tool-design-across-harnesses.md |
| tree-sitter static parsing vs LSP | lsp-tool-design-across-harnesses.md |
| py-tree-sitter-languages (Aider) | lsp-tool-design-across-harnesses.md |
| semantic index / proprietary code index (Cursor) | lsp-tool-design-across-harnesses.md |
| three schools of code intelligence (LSP-native / tree-sitter-static / index-and-rank) | lsp-tool-design-across-harnesses.md |
| diagnostics-via-hook pattern (PostToolUse) | lsp-tool-design-across-harnesses.md |
| cold-start latency / server pre-warm / SessionStart | lsp-tool-design-across-harnesses.md |
| server_starting / server_not_available / position_invalid error kinds | lsp-tool-design-across-harnesses.md |
| flattened path:line:text output for references | lsp-tool-design-across-harnesses.md |
| 1-indexed position conversion at tool boundary | lsp-tool-design-across-harnesses.md |
| 150ms publishDiagnostics debounce | lsp-tool-design-across-harnesses.md |
| hasClient check (fail-fast) | lsp-tool-design-across-harnesses.md |
| LSP binary discovery / plugin manifest / user-installed | lsp-tool-design-across-harnesses.md |
| auto-install LSP binaries (OpenCode) / why library should NOT | lsp-tool-design-across-harnesses.md |
| rename-with-read-ledger problem | lsp-tool-design-across-harnesses.md |
| symbol-first operations / find_symbol(name) | lsp-tool-design-across-harnesses.md |
| workspaceSymbol query minimum length / result caps | lsp-tool-design-across-harnesses.md |
| Skill tool / skill primitive / agent skills | skill-tool-design-across-harnesses.md, skill-tool-in-autonomous-agents.md |
| SKILL.md / SKILL.md format | skill-tool-design-across-harnesses.md, skill-tool-in-autonomous-agents.md |
| Agent Skills open standard / agentskills.io | skill-tool-design-across-harnesses.md, skill-tool-in-autonomous-agents.md |
| Agent Skills specification / name / description / license / compatibility / metadata / allowed-tools | skill-tool-design-across-harnesses.md |
| progressive disclosure (skills) / three-tier loading | skill-tool-design-across-harnesses.md, skill-tool-in-autonomous-agents.md |
| skill catalog / skill disclosure / skill name enum | skill-tool-design-across-harnesses.md |
| skill activation patterns (A tool / B file-read / C system-prompt / D slash) | skill-tool-design-across-harnesses.md |
| `disable-model-invocation: true` / `user-invocable: false` | skill-tool-design-across-harnesses.md |
| skill `context: fork` / agent: Explore/Plan/general-purpose | skill-tool-design-across-harnesses.md |
| skill `paths` frontmatter / auto-activation globs | skill-tool-design-across-harnesses.md |
| skill `hooks` frontmatter / skill-scoped lifecycle hooks | skill-tool-design-across-harnesses.md |
| skill `model` / `effort` frontmatter | skill-tool-design-across-harnesses.md |
| skill `$ARGUMENTS` / `$N` / named arguments | skill-tool-design-across-harnesses.md |
| skill `${CLAUDE_SKILL_DIR}` / `${CLAUDE_SESSION_ID}` | skill-tool-design-across-harnesses.md |
| skill `` !`<cmd>` `` dynamic context injection | skill-tool-design-across-harnesses.md |
| skill `disableSkillShellExecution` policy | skill-tool-design-across-harnesses.md |
| skill-subagent composition / preload skills / context fork | skill-tool-design-across-harnesses.md |
| skills-ref validation library | skill-tool-design-across-harnesses.md |
| anthropics/skills repo / reference skills | skill-tool-design-across-harnesses.md |
| Anthropic Agent Skills announcement / Oct 16 2025 | skill-tool-design-across-harnesses.md, skill-tool-in-autonomous-agents.md |
| Claude Code Skill permission syntax (Skill / Skill(name) / Skill(name *)) | skill-tool-design-across-harnesses.md |
| skill lifecycle: discover / parse / disclose / activate / manage | skill-tool-design-across-harnesses.md |
| skill content lifecycle / no re-read between turns | skill-tool-design-across-harnesses.md |
| skill auto-compaction carryforward / 5000+25000 budgets | skill-tool-design-across-harnesses.md |
| skill collision handling / project > user precedence | skill-tool-design-across-harnesses.md |
| .agents/skills/ vs .claude/skills/ vs .<harness>/skills/ | skill-tool-design-across-harnesses.md |
| trust-gating project-level skills | skill-tool-design-across-harnesses.md, skill-tool-in-autonomous-agents.md |
| skill vs MCP / skill vs subagent / skill vs hook / skill vs system prompt | skill-tool-design-across-harnesses.md |
| Claude Code Skill tool (schema) | skill-tool-design-across-harnesses.md |
| OpenCode skill tool (schema + ripgrep-sampled resources) | skill-tool-design-across-harnesses.md |
| Gemini CLI activate-skill tool (dynamic enum + <activated_skill> XML) | skill-tool-design-across-harnesses.md |
| Continue readSkill tool (readonly + isInstant) | skill-tool-design-across-harnesses.md |
| Codex NO skill tool (system-prompt injection + $name mention) | skill-tool-design-across-harnesses.md |
| Amp NO skill tool (catalog-only) | skill-tool-design-across-harnesses.md, skill-tool-in-autonomous-agents.md |
| OpenHands skills (three activation modes) | skill-tool-design-across-harnesses.md, skill-tool-in-autonomous-agents.md |
| Junie agent skills / .junie/skills/ | skill-tool-design-across-harnesses.md |
| Roo Code skills / mode-scoped skills-{mode}/ | skill-tool-design-across-harnesses.md |
| Cursor skills / /migrate-to-skills | skill-tool-design-across-harnesses.md |
| Amp skills precedence order | skill-tool-design-across-harnesses.md |
| Letta skills / agent-scoped ~/.letta/agents/{id}/skills/ | skill-tool-design-across-harnesses.md, skill-tool-in-autonomous-agents.md |
| Letta skill-creator skill / runtime skill creation | skill-tool-in-autonomous-agents.md |
| Letta stateful agent / memory blocks / formerly MemGPT | skill-tool-in-autonomous-agents.md |
| Goose / Kiro / Firebender / Factory skills | skill-tool-design-across-harnesses.md |
| Firebender runtime skill selection | skill-tool-in-autonomous-agents.md |
| Factory CLI Droids / skill-skill chaining | skill-tool-in-autonomous-agents.md |
| Databricks Genie autonomous skills / Agent mode | skill-tool-in-autonomous-agents.md |
| GitHub Copilot agent skills / VS Code skills | skill-tool-design-across-harnesses.md |
| Spring AI / Laravel Boost / Databricks Genie / Snowflake Cortex Code skills | skill-tool-design-across-harnesses.md |
| Claude API skills / skill_id / container / skills-2025-10-02 beta headers | skill-tool-design-across-harnesses.md, skill-tool-in-autonomous-agents.md |
| Claude.ai custom skills / Settings > Features zip upload | skill-tool-design-across-harnesses.md |
| autonomous-aligned skill use cases (code-review / migrate-to-typescript / api-conventions) | skill-tool-design-across-harnesses.md |
| skill descriptions — third person, gerund form, front-load trigger | skill-tool-design-across-harnesses.md |
| @agent-sh/harness-skill package / SkillRegistry / FilesystemSkillRegistry | skill-tool-design-across-harnesses.md, skill-tool-in-autonomous-agents.md |
| Voyager skill library (Wang et al. 2023) | skill-tool-in-autonomous-agents.md |
| Voyager JavaScript skill functions / embedding retrieval | skill-tool-in-autonomous-agents.md |
| Voyager automatic curriculum / iterative prompting / self-verification | skill-tool-in-autonomous-agents.md |
| JARVIS-1 / multimodal memory / open-world Minecraft | skill-tool-in-autonomous-agents.md |
| ExpeL / Experiential Learners / natural-language insights | skill-tool-in-autonomous-agents.md |
| Agent Workflow Memory (web agents) | skill-tool-in-autonomous-agents.md |
| runtime-learned skill library vs authored SKILL.md | skill-tool-in-autonomous-agents.md |
| two meanings of "skill" in autonomous literature | skill-tool-in-autonomous-agents.md |
| Voyager to Letta reduction (runtime creation as a skill) | skill-tool-in-autonomous-agents.md |
| autonomous-mode skill hook contract (projectTrust / sessionId / projectScope) | skill-tool-in-autonomous-agents.md |
| Skill autonomous output extensions (already_loaded / trust_required / wrappedBody) | skill-tool-in-autonomous-agents.md |
| autonomous-agent minimum viable skill contract | skill-tool-in-autonomous-agents.md |
| five-layer testing pyramid (LLM tools) | testing-harness-tools.md |
| unit / schema / integration / e2e / regression layers | testing-harness-tools.md |
| real-model e2e testing | testing-harness-tools.md |
| trace-based assertions | testing-harness-tools.md |
| tool_seq / toolsByName / turns assertions | testing-harness-tools.md |
| non-invocation failure mode | testing-harness-tools.md |
| bash-decoy test | testing-harness-tools.md, exec-tool-design-across-harnesses.md |
| output-faithfulness / hallucination guard | testing-harness-tools.md |
| error-recovery depth testing | testing-harness-tools.md |
| cross-model matrix / tiered CI | testing-harness-tools.md |
| Ollama + Bedrock dual backend | testing-harness-tools.md |
| runE2E / resolveBackend / modelLabel | testing-harness-tools.md |
| it.runIf / test.skipIf / Vitest gating | testing-harness-tools.md |
| test.each / test.for / parametric fixtures | testing-harness-tools.md |
| test.concurrent / describe.sequential | testing-harness-tools.md |
| per-test timeout (Vitest) | testing-harness-tools.md |
| InMemoryLedger / recordRead / makeSession | testing-harness-tools.md |
| STALE_READ / NOT_READ_THIS_SESSION tests | testing-harness-tools.md |
| OLD_STRING_NOT_UNIQUE / NOT_FOUND recovery | testing-harness-tools.md |
| validate hook testing | testing-harness-tools.md |
| atomic-write verification (no temp files) | testing-harness-tools.md |
| CRLF / BOM / symlink / encoding fixtures | testing-harness-tools.md |
| binary-file trap / attachment trap | testing-harness-tools.md |
| sensitive-path trap / .env refusal | testing-harness-tools.md |
| pagination exhaustion test | testing-harness-tools.md |
| distractor tool / tool-description quality test | testing-harness-tools.md |
| rate-limit / timeout injection | testing-harness-tools.md |
| schema drift test | testing-harness-tools.md |
| Qwen thinking mode in tests | testing-harness-tools.md |
| Qwen temperature in tests (T != 0) | testing-harness-tools.md |
| VRAM pressure / one model per process | testing-harness-tools.md |
| warmup / beforeAll availability probe | testing-harness-tools.md |
| Bedrock Converse gating (AWS_BEARER_TOKEN_BEDROCK) | testing-harness-tools.md |
| loadDotEnv / zero-dep env loader | testing-harness-tools.md |
| turbo test orchestration / test:e2e / test:bedrock | testing-harness-tools.md |
| pnpm --filter test invocation | testing-harness-tools.md |
| Pass@k / flaky test management | testing-harness-tools.md |
| record-replay / VCR / cassettes for LLM tests | testing-harness-tools.md |
| LLM-as-judge / G-Eval / Likert | testing-harness-tools.md |
| pairwise evaluator | testing-harness-tools.md |
| trajectory evaluation | testing-harness-tools.md |
| TAU-bench / pass@k simulated users | testing-harness-tools.md |
| SWE-bench Verified / Lite / Multimodal | testing-harness-tools.md |
| Inspect AI (UK AISI) | testing-harness-tools.md |
| Promptfoo YAML / side-by-side eval | testing-harness-tools.md |
| OpenAI Evals registry / Completion Function Protocol | testing-harness-tools.md |
| DeepEval ToolCorrectness / TaskCompletion | testing-harness-tools.md |
| LangSmith evaluation concepts / pairwise | testing-harness-tools.md |
| MCP Inspector | testing-harness-tools.md |
| OpenAI Agents SDK tracing / function_span | testing-harness-tools.md |
| Project Vend / long-horizon agent observability | testing-harness-tools.md |
| Anthropic multi-agent research / tool-testing agent | testing-harness-tools.md |
| Anthropic SWE-bench scaffold / iterative tool-description refinement | testing-harness-tools.md |

## How to Use

1. When a user question matches a topic above (via trigger phrase or keyword), **read the relevant guide file before answering**.
2. Answer based on the synthesized knowledge in the guide, not general recollection.
3. If the user asks for sources, point at `resources/<slug>-sources.json` — each source has a quality score and the specific insights extracted from it.
4. If the user asks something adjacent but not covered, say so explicitly (the guide lists `gaps` in its self-evaluation).
5. If no topic matches, answer normally without loading guides.

## Meta

- Guides are created via `/learn <topic>`
- Each guide has a companion `resources/<slug>-sources.json` with full source metadata + quality scores (1-10 on authority/recency/depth/examples/uniqueness)
- This file (`CLAUDE.md`) is mirrored to `AGENTS.md` for OpenCode/Codex compatibility
