# Learning Guide: AI Agent Harness Tooling — Architecture and Design

**Generated**: 2026-04-19
**Sources**: 20 resources analyzed
**Depth**: medium
**Scope**: How agent harnesses (Claude Code, Codex CLI, Cursor, Aider, OpenCode, Cline, Continue) expose tools to LLMs, and the cross-vendor theory of reliable tool use

## Prerequisites

Before diving in, you should be comfortable with:

- **LLM tool use fundamentals**: you have at least once called an LLM with a `tools` / `functions` parameter and received a structured tool call back
- **JSON Schema basics**: `type`, `properties`, `required`, `enum`, `additionalProperties`
- **A shell-based dev environment** and at least one agent CLI installed (Claude Code, Codex CLI, Aider, or similar)
- **Basic concurrency concepts**: loops, async/await, streaming
- Familiarity with one SDK (Anthropic Messages, OpenAI Chat Completions, or OpenAI Responses) is highly recommended

## TL;DR

- A **harness** is the glue between a raw LLM API and a useful agent: it owns the tool-call loop, tool registry, permission/approval flow, context/memory strategy, sub-agent spawning, and streaming/interruption — everything the SDK does *not* do for you
- All modern harnesses converge on the same core loop: `while stop_reason == "tool_use": execute → feed result back → re-request`. The differentiators are **what tools ship built-in**, **how permissions are granted**, and **how context is managed as it fills**
- **Closed ecosystems** (Claude Code + Agent SDK, Codex CLI + Responses API) tightly couple the harness to one provider, trading flexibility for reliability — Anthropic trains Claude on the exact `bash`/`text_editor`/`Read`/`Edit`/`Grep` schemas their harness ships
- **Open harnesses** (Aider, OpenCode, Cline, Continue) are provider-agnostic and often abandon function-calling entirely in favor of text-based edit formats (search-replace, unified diff) that bypass JSON-escape failure modes
- **Context management** is the single biggest architectural axis: `/clear`, auto-compaction, sub-agents with isolated context windows, repo maps, and memory files (CLAUDE.md / AGENTS.md) are all responses to the same problem — context rot as the window fills
- **MCP (Model Context Protocol)** is the emerging vendor-neutral standard for tool exposure: a JSON-RPC 2.0 protocol letting any client (host) connect to any tool server via stdio or Streamable HTTP
- Tool-use reliability hinges on: detailed descriptions (3-4+ sentences), consolidated rather than atomic tools, namespaced names, high-signal responses, and grammar-constrained decoding (`strict: true`) for type safety

## Core Concepts

### 1. What Is a "Harness" vs. Raw SDK Tool Use?

The raw Anthropic Messages API or OpenAI Chat Completions API gives you a primitive: "send a conversation plus tool schemas, get back either text or a structured `tool_use` / `tool_calls` block." You are responsible for *everything else* — parsing the tool call, dispatching to your implementation, formatting the result, re-sending the conversation, handling errors, enforcing limits, tracking state.

A **harness** wraps that primitive with:

1. **A tool registry and execution dispatcher** — tools are registered at startup (or discovered dynamically via MCP) and mapped to real implementations
2. **The agentic loop** — drives `stop_reason: "tool_use"` iterations until the model emits `end_turn`, with max-turn safeties and error recovery
3. **A permission / approval model** — decides which tool calls auto-run, which need user confirmation, and which are flat-out forbidden
4. **Context management** — compaction, memory files, sub-agents, repo maps, checkpoints to fight the "context fills up fast, performance degrades" problem that dominates harness design
5. **Streaming, interruption, and cancellation** — `Esc` to stop, `/rewind` to revert, live token streaming to the UI
6. **A configuration surface** — settings files, hooks, skills, slash commands, sandboxing, plugin systems

The Anthropic docs explicitly frame the split: the **Client SDK** gives raw API access ("you implement the tool loop"); the **Agent SDK** gives "Claude with built-in tool execution" — the harness bundled as a library.

**Key insight**: once you've written `while stop_reason == "tool_use"` three times by hand, you've rebuilt the core of a harness. The real product is everything *around* that loop.

### 2. Tool Registration and Schemas

Every harness boils down to handing the model a list of tools it can call. The dominant shape is JSON Schema plus a name and description:

```json
{
  "name": "get_weather",
  "description": "Get the current weather in a given location. Use this when the user asks about current conditions in a named city. Returns temperature, humidity, and a brief summary. Does NOT return forecasts.",
  "input_schema": {
    "type": "object",
    "properties": {
      "location": { "type": "string", "description": "City and state, e.g. San Francisco, CA" },
      "unit": { "type": "string", "enum": ["celsius", "fahrenheit"] }
    },
    "required": ["location"],
    "additionalProperties": false
  }
}
```

**Anthropic's guidance** (which generalizes across providers):

- Descriptions are the single highest-leverage lever on tool selection accuracy — aim for 3–4+ sentences per tool
- Consolidate related operations (`schedule_event` with an `action` parameter) rather than exposing atomic `create_pr` / `review_pr` / `merge_pr`
- Use meaningful namespacing (`github_list_prs`, `slack_send_message`) so the model disambiguates across a growing registry
- Return high-signal responses: stable identifiers, only the fields the model needs next, with pagination/truncation baked in (Claude Code defaults to 25,000-token limits on tool output)
- For complex schemas, attach `input_examples` — concrete valid payloads that ride alongside the schema in the prompt

**Trained-in vs. custom schemas**: Anthropic ships four "Anthropic-schema" client tools (`bash`, `text_editor`, `computer`, `memory`) whose shapes the model has been RL-trained on across thousands of successful trajectories. You still execute them, but Claude picks them more reliably than an equivalent custom tool. This is why Claude Code's `Bash`, `Read`, `Edit`, `Write`, `Glob`, `Grep` tools outperform a naïve redefinition — the schema *is* the interface the model expects.

### 3. The Execution Loop, Streaming, and Interruption

The canonical shape across every harness:

```python
response = client.messages.create(messages=[user_msg], tools=tools)
while response.stop_reason == "tool_use":
    tool_results = [execute(block) for block in response.content if block.type == "tool_use"]
    response = client.messages.create(
        messages=[*messages, response, {"role": "user", "content": tool_results}],
        tools=tools,
    )
# stop_reason is now one of: "end_turn", "max_tokens", "stop_sequence", "refusal", "pause_turn"
```

**Server vs. client tools**: Anthropic splits tools by where they execute. Client tools (user-defined + `bash`/`text_editor`/`computer`/`memory`) require your code in the loop. **Server-executed tools** (`web_search`, `web_fetch`, `code_execution`, `tool_search`) run inside Anthropic's infrastructure — the provider runs its own internal loop and returns when done. If Anthropic's internal loop hits its iteration cap, you get `stop_reason: "pause_turn"` and re-send the conversation to continue.

**OpenAI's Responses API** takes a slightly different tack: rather than the Chat Completions model of "each turn is a single message," Responses emits "a list of polymorphic Items" — text, tool calls, and reasoning steps — and preserves reasoning state across turns (reported ~+5% on τ-Bench vs. Chat Completions and better cache utilization).

**Parallel tool calls**: all three major providers support them. The model can emit multiple `tool_use` blocks in one response; harnesses either execute them concurrently (OpenAI Agents SDK) or serially with an opt-in (Codex CLI's `supports_parallel_tool_calls` per MCP server). Parallel execution is the single biggest latency win for multi-file reads.

**Streaming and interruption**: Claude Code's `Esc` cancels the current action while preserving context; `Esc+Esc` or `/rewind` opens a checkpoint menu to restore conversation and/or code state. OpenAI Agents SDK exposes `Runner.run_streamed()` yielding events as the model generates. Armin Ronacher's observation: "crashes are acceptable, hangs are problematic" — any tool that can block indefinitely wedges the loop and burns the user's attention budget.

### 4. Permission Models

This is where harnesses diverge the most. The spectrum:

| Model | Example | Behavior |
|-------|---------|----------|
| **Prompt-per-action** | Cline default | Every file write, command, or browser action shows a diff/output and waits for approval |
| **Allowlist / denylist** | Claude Code `/permissions` | Pre-approve specific patterns (`npm run lint`, `git commit *`) |
| **Classifier-based auto mode** | Claude Code `--permission-mode auto` | A separate Claude model reviews each command and blocks scope escalation, unknown infra, or hostile-content-driven actions |
| **Session-scoped** | OpenCode "Allow for session" | Single yes grants that tool for the rest of the conversation |
| **OS-level sandboxing** | Claude Code `/sandbox`, Codex CLI WorkspaceWrite | Filesystem and network confinement enforced by the kernel, not the harness |
| **YOLO / full-auto** | `claude-yolo` alias, Codex `--full-auto` | All permission checks off, typically mitigated by running inside Docker |

Claude Agent SDK exposes this programmatically via `permission_mode` options (`default`, `acceptEdits`, `plan`, `bypassPermissions`) plus per-tool `allowed_tools` lists. Cline's "Every action requires your explicit approval" is the opposite end — maximum human-in-the-loop, higher latency, higher safety.

**Hooks** are the deterministic backstop. Unlike CLAUDE.md instructions (advisory — the model may ignore them), hooks are scripts the harness executes around tool calls: `PreToolUse`, `PostToolUse`, `SessionStart`, `UserPromptSubmit`, `Stop`. "Write a hook that runs eslint after every file edit" or "block writes to the migrations folder" are guaranteed, not suggested.

### 5. Context Management — The Single Biggest Design Axis

Anthropic states the constraint bluntly: "Claude's context window fills up fast, and performance degrades as it fills. A single debugging session or codebase exploration might generate and consume tens of thousands of tokens." Every best practice in Claude Code's docs stems from this.

Harnesses deploy several distinct strategies:

**(a) Memory files (CLAUDE.md / AGENTS.md)** — loaded at session start, contain project-specific conventions Claude can't infer. Claude Code looks in `~/.claude/CLAUDE.md`, `./CLAUDE.md`, `./CLAUDE.local.md`, parent directories (monorepos), and child directories on demand. OpenCode and Codex CLI use `AGENTS.md` for the same role. The warning from Anthropic: "Bloated CLAUDE.md files cause Claude to ignore your actual instructions!"

**(b) Compaction** — when the context approaches the limit, summarize older turns. Claude Code's auto-compact preserves "code patterns, file states, and key decisions." `/compact <instructions>` lets you bias the summary ("Focus on the API changes"). Summer Yue's incident with a compaction event that dropped a "confirm before acting" directive — leading to autonomous deletion of thousands of emails — is the canonical warning: **compaction is a lossy operation that can drop safety-critical instructions**.

**(c) Sub-agents / sub-tasks** — spawn a new agent in an isolated context window, let it do the research or the file-hunting, get back a summary. Claude Code's `Agent` tool invokes subagents defined in `.claude/agents/*.md` with their own `tools` whitelist and model; Cline and OpenCode have analogous "task" agents. The payoff: a 50-file grep-and-read that would have burned your main context now returns as a 200-token summary.

**(d) Repo maps** — Aider's signature contribution. Rather than shipping file contents, Aider generates a concise map of the whole git repo (classes, functions, signatures) ranked by a graph algorithm over the dependency graph. Default budget is 1K tokens (configurable via `--map-tokens`), expanded when no files are explicitly in the chat. No RAG, no vector search — just static analysis + rank.

**(e) Checkpoints and rewind** — Claude Code and Cursor both snapshot code+conversation before every action. `/rewind` or `Esc+Esc` restores either, both, or summarizes from a chosen message. This isn't strictly context management, but it lets users take bigger risks without paying for them in context rot.

**(f) `/clear`** — the hammer. Between unrelated tasks, throw away everything. Anthropic: "A clean session with a better prompt almost always outperforms a long session with accumulated corrections."

### 6. MCP — The Vendor-Neutral Tool Protocol

MCP (Model Context Protocol) is the attempt at a USB-C port for AI tool use. Open-sourced by Anthropic in late 2024 and adopted by Claude Code, Claude Desktop, ChatGPT, VS Code, Cursor, Cline, Continue, OpenCode, Codex CLI, and many more.

**Architecture**:

- **Host** (the AI application) spawns one **Client** per **Server** it connects to
- Each client ↔ server pair speaks JSON-RPC 2.0 over one of two transports: **stdio** (local subprocess) or **Streamable HTTP** (remote, with OAuth / bearer tokens)
- Servers expose three primitives:
  - **Tools** — executable functions (like the `weather_current` example with name, title, description, and `inputSchema`)
  - **Resources** — readable data (file contents, database rows, API responses) addressed by URI
  - **Prompts** — reusable templates / few-shot examples
- Clients may expose primitives back to servers: **sampling** (server asks the host to run an LLM completion), **elicitation** (server asks the user a question), **logging**

**Lifecycle**: `initialize` → capability negotiation (`"tools": {"listChanged": true}`) → `notifications/initialized` → `tools/list` → `tools/call` → `notifications/tools/list_changed` when the server's tool set changes.

MCP matters for harness design because it **decouples tool implementation from the harness**. Any harness that speaks MCP can use the Playwright MCP server, the GitHub MCP server, the Sentry MCP server, the filesystem server, etc., without touching harness code. A tool registry becomes pluggable.

### 7. Closed vs. Open Ecosystems — The Tradeoff Matrix

| Dimension | Closed (Claude Code / Codex CLI) | Open (Aider / Cline / OpenCode / Continue) |
|-----------|----------------------------------|--------------------------------------------|
| **Model coupling** | Tied to one provider's best model | Multi-provider, often OpenAI-compatible |
| **Tool schema** | Trained-in Anthropic/OpenAI tool shapes (`bash`, `Edit`, etc.) | Custom schemas or text-format edits |
| **Reliability** | Higher out of the box — model has seen these exact schemas thousands of times | Lower-variance across models; often stronger with top model, degrades sharply on smaller |
| **Reasoning state** | Preserved (Responses API keeps encrypted reasoning; Claude has prompt caching optimized for the harness) | Usually discarded between turns |
| **Plugin surface** | Rich (skills, hooks, subagents, plugins, settings.json) | Typically simpler — config file + MCP |
| **Lock-in** | High — workflow transfers partially via MCP, but skills/hooks are harness-specific | Low — swap providers by config change |
| **Edit strategy** | Function-calling + Anthropic `text_editor` tool | Often text-based: search/replace blocks, unified diffs, whole-file |

**Aider's explicit architectural argument** (which the Anthropic ecosystem does *not* accept) is that **function-calling is the wrong interface for code editing**: "structured formats like JSON and function calls actually *worsen* performance because escaping source code within them is error-prone." Aider's benchmarks found unified diffs reduced GPT-4 Turbo's "lazy coding" (stubs like `// ... rest of logic ...`) by 3× versus search/replace, and that telling the model to produce machine-readable text frames the task as rigorous rather than conversational.

Cline, OpenCode, Continue, and Cursor generally hybrid: function-calling for the agentic loop (tool selection) plus custom edit formats for the file-writing tool itself.

### 8. Tool-Use Reliability: Research and Failure Modes

Armin Ronacher's field report from building harnesses: "the differences between models are significant enough that you will need to build your own agent abstraction." Cache control, tool prompting, and provider-specific capabilities fragment the API surface. His concept of **reinforcement** — injecting contextual reminders inside tool outputs to re-anchor the model on its goal — is a response to the observed drift of long-running loops.

**Documented failure modes** across the ecosystem:

| Failure Mode | Mechanism | Mitigation |
|-------------|-----------|------------|
| **JSON escape errors** in tool arguments containing source code | Model emits invalid JSON when string values contain quotes, newlines, backslashes | `strict: true` grammar-constrained decoding; or bypass JSON entirely with diff-based edits |
| **Missing required parameters** | Smaller models (Haiku, Sonnet) infer plausible defaults rather than asking | Use Opus / GPT-5 for ambiguous queries; explicit `AskUserQuestion` tool; strict mode + `required` |
| **Lazy coding / placeholder comments** | Model writes `# TODO: implement rest` instead of full code | Unified-diff edit format (Aider: 3× reduction); test-driven verification in the loop |
| **Line-number drift** | "GPT is terrible at working with source code line numbers" — diffs with line numbers fail more than context-based ones | Search/replace or context-anchored diffs, no numeric line references |
| **Context compaction dropping safety directives** | Auto-summary omits "confirm before acting" when it looks redundant | Customize compaction preservation rules in CLAUDE.md; pin critical instructions |
| **Infinite tool loops** | Model re-calls the same tool without making progress | `max_turns` caps (OpenAI Agents SDK raises `MaxTurnsExceeded`); observability on tool call counts |
| **Hanging tools** | A tool blocks forever, wedging the loop | Timeouts on every tool; Ronacher: "crashes are acceptable, hangs are problematic" |
| **Prompt injection via tool output** | Untrusted content (a fetched web page) contains instructions the model follows | Treat all tool output as untrusted; the "lethal trifecta" (data access + injection + exfiltration) — remove any one vertex |
| **Tool proliferation reducing selection accuracy** | 50+ tools in the registry, model picks wrong one | Consolidation, namespacing, `tool_search` server tool that filters before presentation |

Anthropic's evaluation-driven tool development loop is worth internalizing: "Measure beyond accuracy: track runtime, tool call counts, token consumption, and error rates to identify inefficiencies." You are not done until you have transcripts and metrics.

## Code Examples

### Minimal Agent Loop (Anthropic, client-side)

```python
# The raw loop every harness wraps. Run this once and you understand
# 80% of what Claude Code / Codex / OpenCode are doing.
import anthropic
client = anthropic.Anthropic()

tools = [{
    "name": "read_file",
    "description": "Read a file from disk. Use when you need to see file contents.",
    "strict": True,
    "input_schema": {
        "type": "object",
        "properties": {"path": {"type": "string"}},
        "required": ["path"],
        "additionalProperties": False,
    },
}]

def execute(block):
    if block.name == "read_file":
        return open(block.input["path"]).read()
    raise ValueError(f"unknown tool {block.name}")

messages = [{"role": "user", "content": "What's in README.md?"}]
while True:
    resp = client.messages.create(
        model="claude-opus-4-7", max_tokens=1024, tools=tools, messages=messages,
    )
    messages.append({"role": "assistant", "content": resp.content})
    if resp.stop_reason != "tool_use":
        break
    tool_results = [
        {"type": "tool_result", "tool_use_id": b.id, "content": execute(b)}
        for b in resp.content if b.type == "tool_use"
    ]
    messages.append({"role": "user", "content": tool_results})

print(resp.content[-1].text)
```

### Claude Agent SDK — the same thing with the harness

```python
# With the harness, the loop disappears. You declare intent; the SDK
# drives the agentic loop, handles streaming, applies hooks, and enforces
# permissions. This is the core "closed ecosystem" value proposition.
import asyncio
from claude_agent_sdk import query, ClaudeAgentOptions, HookMatcher

async def audit(input_data, tool_use_id, ctx):
    path = input_data.get("tool_input", {}).get("file_path", "unknown")
    print(f"[audit] modified {path}")
    return {}

async def main():
    async for msg in query(
        prompt="Find and fix the bug in auth.py",
        options=ClaudeAgentOptions(
            allowed_tools=["Read", "Edit", "Bash", "Grep"],
            permission_mode="acceptEdits",
            hooks={"PostToolUse": [HookMatcher(matcher="Edit|Write", hooks=[audit])]},
            agents={
                "reviewer": {
                    "description": "Reviews code changes for correctness",
                    "prompt": "Be thorough; flag edge cases.",
                    "tools": ["Read", "Grep"],
                },
            },
        ),
    ):
        print(msg)

asyncio.run(main())
```

### MCP Server (minimal stdio) — the vendor-neutral tool

```python
# This server can be plugged into Claude Code, ChatGPT, Cursor, Cline,
# Continue, VS Code, or any MCP-compatible host. Same code, any harness.
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("my-tools")

@mcp.tool()
def word_count(text: str) -> int:
    """Count words in a string. Use when the user asks how many words are in text."""
    return len(text.split())

if __name__ == "__main__":
    mcp.run()  # stdio transport by default
```

Host config (Claude Code `.mcp.json`, OpenCode `opencode.json`, Codex `~/.codex/config.toml` — the shape varies but the idea is identical):

```json
{
  "mcpServers": {
    "my-tools": { "command": "python", "args": ["server.py"] }
  }
}
```

### Aider-style Unified Diff — bypassing function calling entirely

```text
## What the LLM emits (no JSON, no tool call):

src/auth.py
```diff
@@ ... @@
-def check_token(tok):
-    return tok == "admin"
+def check_token(tok):
+    return tok and verify_signature(tok)
```

## What the harness does:
# 1. Parse the fenced diff blocks out of the text response
# 2. Apply with fuzzy matching (missing context lines OK; indentation tolerance)
# 3. If apply fails, feed the error back and let the model retry
```

The entire "function-calling interface" disappears. The LLM just writes text; the harness post-processes. Aider's laziness-benchmark data: 20% → 61% task success with this swap, on the same GPT-4 Turbo model.

## Common Pitfalls

| Pitfall | Why It Happens | How to Avoid |
|---------|---------------|--------------|
| **Bloated tool descriptions or system prompts** | Teams stuff every conceivable instruction into CLAUDE.md | Ruthlessly prune. Anthropic's rule: "For each line, ask: would removing this cause Claude to make mistakes? If not, cut it." |
| **Trusting `acceptEdits` / `--full-auto` on a shared machine** | "It worked in my dry-run" | Run `--full-auto` / `claude-yolo` only inside Docker or a sandboxed VM; the classifier in `permission-mode auto` is a second line of defense, not the first |
| **Skipping verification** | Model produces plausible-looking code that fails at runtime | Always supply a test command, linter, or screenshot diff. "If you can't verify it, don't ship it." |
| **Context kitchen-sink** | Starting one task, drifting to another, returning to the first | `/clear` between unrelated tasks; use subagents for investigation so research lives in a separate context |
| **Correction spiral** | Correcting the same mistake 3+ times in one session | After two failed corrections, `/clear` and re-prompt with what you learned. A clean session with a better prompt beats a long session with accumulated fixes |
| **Atomic, over-granular tools** | Wrapping every API endpoint as its own tool | Consolidate: prefer `schedule_event` over `list_users` + `list_events` + `create_event` |
| **Tool output bloat** | Returning full API payloads including UUIDs, timestamps, internal IDs | Shape responses for agent consumption: stable slugs, only the fields needed for the next step, pagination by default |
| **Ignoring the "lethal trifecta"** | Tool reads external content (web, email) → injection → another tool exfiltrates data | Audit every agent's tool set for the three legs (private-data read + untrusted-input read + exfiltration write). Remove any one |
| **Hanging tools wedging the loop** | A sub-process, a network call with no timeout | Mandatory timeouts on every tool; prefer crash-with-error over hang |
| **Trusting auto-compaction for safety-critical context** | "It'll keep the important stuff" — except when it doesn't | Pin critical instructions via CLAUDE.md compaction rules: "When compacting, always preserve the full list of modified files and any test commands" |

## Best Practices

Synthesized from the 20 sources:

1. **Start with the simplest loop that works** (Anthropic, "Building Effective Agents") — a predefined workflow beats an agent for tasks with fixed structure. Add agent autonomy only when the step sequence genuinely is unknown
2. **Verification is the single highest-leverage thing you can do** (Claude Code best practices) — include tests, screenshots, or expected outputs in the prompt itself so the model can self-check
3. **Explore → Plan → Implement → Commit** (Claude Code) — four phases, separated, because letting the model code first produces solutions to the wrong problem
4. **Invest in descriptions, not just schemas** (Anthropic tool-writing guide) — 3–4+ sentences per tool, covering what it does, when to use it, when *not* to, and what each parameter means
5. **Consolidate tools, namespace them, return only high-signal output** — the three levers that survive every model upgrade
6. **Use strict mode / grammar-constrained decoding wherever types matter** — `strict: true` in Claude, `strict: true` in OpenAI Responses. Cost: ~100ms for first-time schema compilation, cached 24h
7. **Give the model verification tools it can run** (Armin Ronacher) — tests, linters, LSP diagnostics, compilation. Agents improve dramatically when they can check their own work
8. **Prefer Go / typed languages / simple patterns over magical Python frameworks** for agent-heavy codebases (Ronacher) — agents struggle with pytest fixture injection, metaclasses, ORM magic; they excel at plain SQL and descriptive function names
9. **Use subagents for investigation, not implementation** — a subagent reading 50 files returns a 200-token summary instead of burning your main context
10. **Design tools assuming an "LLM chaos monkey"** (Ronacher) — every tool will be called with unexpected arguments, in unexpected order, with malformed input. Defensive validation and clear error messages pay for themselves
11. **Check CLAUDE.md / AGENTS.md into git; treat them like code** — review them when things go wrong, prune regularly, test changes by observing whether behavior actually shifts
12. **For code edits, consider text-based formats** (Aider) — unified diffs or search/replace blocks outperform function-call-wrapped source code on every model tested, because they avoid JSON-escape failures and frame the task as rigorous

## Further Reading

| Resource | Type | Why Recommended |
|----------|------|-----------------|
| [Claude Agent SDK — Overview](https://docs.claude.com/en/docs/agent-sdk/overview) | Official docs | Canonical reference for the closed-ecosystem harness-as-library model — hooks, subagents, MCP, sessions, permissions |
| [Anthropic: How Tool Use Works](https://platform.claude.com/docs/en/docs/agents-and-tools/tool-use/how-tool-use-works) | Official docs | The cleanest explanation of the agentic loop, client vs. server tools, and the tool-use contract |
| [Anthropic: Define Tools](https://platform.claude.com/docs/en/docs/agents-and-tools/tool-use/define-tools) | Official docs | Schema format, `tool_choice`, `input_examples`, and the system prompt Claude auto-generates when tools are provided |
| [Anthropic: Strict Tool Use](https://platform.claude.com/docs/en/docs/agents-and-tools/tool-use/strict-tool-use) | Official docs | Grammar-constrained decoding for guaranteed schema conformance — type-safe production agents |
| [Claude Code Best Practices](https://code.claude.com/docs/en/best-practices) | Official docs | The single best essay on practical agent-harness UX: context management, planning, CLAUDE.md, auto mode |
| [Anthropic: Writing Tools for Agents](https://www.anthropic.com/engineering/writing-tools-for-agents) | Engineering blog | Tool-design rigor: consolidation, naming, error handling, token efficiency |
| [Anthropic: Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents) | Engineering blog | Workflows vs. agents, the five agentic patterns (prompt chaining, routing, parallelization, orchestrator-workers, evaluator-optimizer) |
| [Model Context Protocol — Architecture](https://modelcontextprotocol.io/docs/learn/architecture) | Spec / official docs | The vendor-neutral tool protocol: hosts, clients, servers, stdio vs. Streamable HTTP, tools/resources/prompts |
| [MCP — Introduction](https://modelcontextprotocol.io/introduction) | Official docs | Why MCP exists, the USB-C-for-AI framing, the ecosystem of supporting clients |
| [OpenAI Agents SDK — Running Agents](https://openai.github.io/openai-agents-python/running_agents/) | Official docs | The OpenAI-side equivalent of the Claude Agent SDK: run loop, max turns, handoffs, streaming, guardrails |
| [OpenAI Agents SDK — Overview](https://openai.github.io/openai-agents-python/) | Official docs | Agents, function tools, handoffs, Responses API integration, tracing |
| [OpenAI Codex CLI (GitHub)](https://github.com/openai/codex) | Reference | The OpenAI-side closed ecosystem: Rust implementation, MCP support, WorkspaceWrite sandbox |
| [OpenAI Responses API](https://developers.openai.com/blog/responses-api) | Engineering blog | Stateful agent loop with preserved reasoning, built-in hosted tools (web search, code interpreter, MCP, file search) |
| [Aider: Edit Formats](https://aider.chat/docs/more/edit-formats.html) | Project docs | Why Aider doesn't use function calling — whole, diff, diff-fenced, udiff, editor-diff formats and when each works |
| [Aider: Unified Diffs Reduce Lazy Coding 3×](https://aider.chat/docs/unified-diffs.html) | Research post | The benchmark evidence that text-based diff formats outperform function calls for code editing |
| [Aider: Repo Map](https://aider.chat/docs/repomap.html) | Project docs | Static-analysis + graph-rank approach to codebase context — no RAG, no vectors |
| [Cursor: Agent](https://cursor.com/docs/agent/overview) | Official docs | Tools-instructions-model triad; semantic search, checkpoints, queued messages |
| [Cline (GitHub)](https://github.com/cline/cline) | Reference | Open-source, permission-heavy harness: Plan/Act modes, memory bank, checkpoint system, multi-provider |
| [Armin Ronacher: Agentic Coding Tools](https://lucumr.pocoo.org/2025/6/12/agentic-coding/) | Engineering blog | Real-world harness-user perspective: Go over Python, emergent tools, LLM chaos monkey, Docker sandboxing |
| [Simon Willison: AI Agents tag archive](https://simonwillison.net/tags/ai-agents/) | Curated archive | Independent ongoing analysis of harness evolution, failure modes, the lethal trifecta, and MCP adoption |

---

*This guide was synthesized from 20 sources on 2026-04-19. See `resources/ai-agent-harness-tooling-sources.json` for full source metadata including per-source quality scores and key insights.*
