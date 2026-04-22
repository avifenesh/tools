# Learning Guide: Exec / Shell / Code-Interpreter Tool Design Across AI Agent Harnesses

**Generated**: 2026-04-20
**Sources**: 22 resources analyzed
**Depth**: medium
**Scope**: The design space of the exec/shell/interpreter tool across every major harness and library. Not a ship-list (see `harness-tool-surface-audit.md`). This guide is the **design-choice deep dive**: for each harness, what choice was made on each of twelve dimensions, what the trade-off was, and what it implies for a TypeScript tool library targeting **autonomous** agents.

## What this guide is (and isn't)

- **Is**: a cross-harness matrix on **twelve design dimensions** (name, language scope, session semantics, sandbox, network, filesystem, timeout, output cap, permission model, interactive handling, background/streaming, error surface, allowlist).
- **Is**: a synthesis of what the research and practitioner commentary says **actually matters to LLMs**, versus what looks principled but costs you invocations.
- **Isn't**: a feature checklist ("does harness X ship a bash tool?"). That lives in `harness-tool-surface-audit.md`.
- **Isn't**: a recommendation for a harness to run code. It's a recommendation for a **library** that exposes an exec primitive that harnesses embed.

The consumer of the tool we're designing is a real LLM, running in **autonomous** mode (no human approval prompts). That framing changes almost every sub-decision below.

## Prerequisites

- Familiarity with `agent-knowledge/ai-agent-harness-tooling.md` §8 (permission models) and `agent-knowledge/harness-tool-surface-audit.md` (the "what ships" matrix).
- Familiarity with the read tool D11 pattern (hook-first, hard-deny fallback) from `agent-knowledge/agent-read-tool.md`.
- Conceptual grasp of OS-level sandboxing primitives: seatbelt (macOS), landlock/seccomp/bwrap (Linux), Firecracker microVMs, containers.
- Why this matters: the exec tool is the **single biggest invariant-breaker** in a tool library. Every other tool (Read, Write, Grep, Glob) has a typed input and a typed output. Exec has "a string" as input and "arbitrary side effects" as output. The design choices compound.

## TL;DR — the twelve decisions, compressed

1. **Tool name**: `Bash` wins the training-signal argument. Every family of frontier model has seen `Bash` invocations at scale (Claude Code); OpenAI families have seen `shell` and `run_shell_command`. Cross-model name survivability is best with `Bash`.
2. **One tool vs many** (bash+python+js): **one `Bash` tool** is what Claude Code, Codex, OpenCode, Cline, Continue, Cursor, and Gemini CLI all converge on — the model runs `python -c`, `node -e`, or `uv run` inside Bash. **Two tools** (OpenHands' `CmdRunAction` + `IPythonRunCellAction`) exist for one structural reason: OpenHands maintains a **Jupyter kernel** so Python state persists across calls. If you can't (or won't) run a kernel, you don't need a second tool.
3. **Session semantics**: Claude Code has a **nuanced persistent shell** — `cd` persists across Bash calls (scoped to the project dir), but `export` does not. This is a deliberate compromise: enough persistence to be ergonomic, little enough to be predictable. **Codex takes the opposite tack**: fresh sandbox per command, rely on `apply_patch` for state-carrying changes. **OpenHands** persists a tmux session for shell and a Jupyter kernel for Python — maximum persistence, maximum runtime infra cost.
4. **Sandbox model**: four distinct postures exist — **hook-out** (Claude Code: tool does nothing, hook decides), **OS sandbox** (Codex: seatbelt on macOS, bwrap+seccomp on Linux), **container** (AutoGen Docker, E2B Firecracker VM, Bedrock AgentCore), and **none** (LangChain, most local CLIs when run in `--yolo`). For a **library**, the only honest posture is **hook-out** plus a fail-closed default.
5. **Network policy**: the binary split is "default deny, opt-in" (Codex `workspace-write`, Bedrock AgentCore, E2B default) versus "default allow" (Claude Code, OpenCode, Gemini CLI). The former is right for untrusted workloads; the latter is right for developer-tool workloads.
6. **Filesystem policy**: three modes recur — read-only, workspace-write (only inside the project dir + /tmp), full access. Codex has explicit config flags for each (`exclude_slash_tmp`, `exclude_tmpdir_env_var`, `writable_roots`). Claude Code uses `additionalDirectories` as the expansion knob. Everyone else delegates to OS-level permissions.
7. **Timeout defaults**: wildly inconsistent. OpenCode `Bash`: 120s. AutoGen `LocalCommandLineCodeExecutor`: 60s. Claude Code: documented as "reasonable default" (roughly 2 minutes). Gemini CLI: inactivity-based (any output resets the clock). **The pattern that matters: inactivity timeout is strictly better than wall-clock timeout for streaming commands.**
8. **Output cap**: ~30KB–200KB is the range. OpenCode has explicit `maxLines`/`maxBytes` and streams excess to a temp file. Gemini CLI throttles updates (`OUTPUT_UPDATE_INTERVAL_MS = 1000`) and halts binary output immediately. The under-appreciated pattern: **stream to a file, return the tail + a path the model can Read with pagination** — so the model recovers gracefully from truncation.
9. **Permission model**: Claude Code ships per-tool allow/ask/deny **patterns** (e.g. `Bash(git:*)`, `Bash(npm install)`) — a classifier-by-pattern. Codex ships **three sandbox modes × four approval policies** (12 cells, most of which collapse to "auto" or "ask"). Cline ships a **classifier** that sets `requires_approval` per-call, a single boolean. The autonomous-agent pick is pattern-based allowlists plus a fail-closed hook.
10. **Interactive handling**: no mainstream harness has a clean answer. Claude Code injects `echo "y" |` or `--yes` when the model remembers. Cline exposes `is_input` to "feed input to a running process" — structurally the best solution, requiring persistent PID tracking. OpenCode punts: no interactive support. For autonomous agents, the right pattern is **reject interactive commands at schema time** (via tool description) and provide a separate `StdinFeed` tool only if needed.
11. **Background / long-running**: Claude Code has `Monitor` (background tail that pushes events) + deprecated `BashOutput`/`KillShell`. Gemini CLI has `is_background` flag + `list_background_processes` + `read_background_output`. Cline has "proceed while running" — the command goes to background and the agent keeps working. OpenAI Agents SDK and MCP have nothing. The pattern for autonomous agents is: **one `Bash` tool with `background: true` + a `BashOutput` tool keyed by job ID**.
12. **Error surface**: the single most-cited design choice across the literature — **error messages are read by a model, not a human**. Claude Code's Bash returns structured exit codes + stderr tail. Codex `shell` returns captured stdout+stderr + exit code. The pattern that generalizes: **discriminated union result** — `{kind: "ok" | "nonzero_exit" | "timeout" | "denied" | "killed" | "interactive_detected"}`.

**Headline for the autonomous-agent case:** ship **one `Bash` tool** with (a) pattern-based allowlist permission hook, (b) fail-closed default, (c) inactivity timeout + output cap + stream-to-file on overflow, (d) optional `background: true` + pair tool, (e) no interactive support at the tool level. Everything else is decorator.

## Core Concepts

### 1. The 12-dimensional design space

For each harness, every exec tool sits in a 12-dimensional cell. The dimensions are **not independent** — choosing hook-out sandbox forces an allowlist-patterns permission model; choosing Firecracker VMs forces fresh-per-call session semantics. The table below makes the cell structure explicit.

| # | Dimension | Values | What choosing "A" costs you |
|---|---|---|---|
| 1 | Tool name | `Bash`, `shell`, `execute_command`, `run_shell_command`, `runTerminalCommand`, `exec`, `run_code` | Names with weaker training signal cost you invocations (models route to Bash via shell-out instead). |
| 2 | Language scope | one (shell), two (shell+python), one-with-discriminator (`exec { lang }`), many (per-lang tools) | More tools = more schema slots = more token cost + more routing mistakes. |
| 3 | Session semantics | fresh-per-call, cwd-only persistence, full persistence (tmux), kernel persistence (Jupyter) | Persistence buys ergonomics and costs determinism. |
| 4 | Sandbox model | none, hook-out, OS sandbox (seatbelt/landlock/bwrap), container, microVM (Firecracker) | Stronger sandbox = stronger invariants but longer startup + harder failure modes. |
| 5 | Network policy | deny-default, allow-default, per-call flag, allowlist | Deny-default breaks real workloads; allow-default breaks untrusted workloads. |
| 6 | Filesystem policy | read-only, workspace-write, full FS | Workspace-write is the sweet spot; "full FS" is where harnesses blow each other up in benchmarks. |
| 7 | Timeout | wall-clock, inactivity, none | Wall-clock kills long `pytest` runs; none lets models hang forever on interactive commands. |
| 8 | Output cap | lines, bytes, bytes+stream-to-file, no cap | No cap floods the context window; stream-to-file is the quality move. |
| 9 | Permission model | allow/ask/deny patterns, classifier, sandbox mode × approval policy matrix, none | "Ask" is out for autonomous. Patterns or classifier only. |
| 10 | Interactive handling | detect-and-fail, auto-inject `-y`, stdin feed tool, tmux passthrough, punt | Punt is defensible; tmux passthrough is overkill for autonomous. |
| 11 | Background / streaming | none, batched-at-end, stream-to-file, push-each-line (Monitor) | Push-each-line is a new UX; stream-to-file is the robust minimum. |
| 12 | Error surface | stdout+stderr string, discriminated union result, exit code only | Discriminated union wins across models; a raw string forces parsing. |

### 2. The Claude Code `Bash` tool — the closed-harness reference

Claude Code ships **one** shell tool (`Bash`) plus ancillary `BashOutput`, `KillShell` (both deprecated in favor of `Monitor` and background-task APIs), `Monitor`, and a preview `PowerShell`.

**Session semantics (the nuanced part)**:

- "The Bash tool runs each command in a **separate process**" — i.e. no persistent shell session per se. Each invocation is a fresh subprocess.
- BUT: "When Claude runs `cd` in the main session, the new working directory **carries over** to later Bash commands as long as it stays inside the project directory." The tool tracks the logical cwd and chdir's into it before each call.
- Stays-inside check: if `cd` escapes the project dir (or `additionalDirectories`), Claude Code resets the cwd and appends `Shell cwd was reset to <dir>` to the tool result. The model sees this and can react.
- Kill-switch: `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1` disables the carry-over entirely.
- Env vars do **not** persist. `export FOO=bar` in call 1 is invisible in call 2. To persist, set `CLAUDE_ENV_FILE` to a shell script, or use a `SessionStart` hook.
- Subagents never inherit cwd changes.

**Permission integration**:

- Every Bash call goes through the permission subsystem (see Claude Code permissions doc).
- Rules are **patterns**, not booleans: `Bash(git:*)` allow, `Bash(rm -rf /*)` deny, `Bash(npm install:*)` allow, etc.
- `allow`, `ask`, `deny` arrays; default is `ask` for Bash in interactive mode.
- `Monitor` inherits Bash's permission rules — "allow and deny patterns you have set for Bash apply here too."

**Design takeaway**: Claude Code's Bash is a **library-thin tool** — it does the absolute minimum to run a subprocess, and **every** nontrivial policy lives in the permission system / hooks. That's the right model for a tool library: the tool is a vehicle, the harness is the driver.

### 3. The Codex `shell` tool — the OS-sandbox reference

Codex takes the opposite architectural posture: **the tool itself enforces the sandbox**, at the OS level.

**Sandbox modes** (from `config.toml`):

- `read-only` — only read syscalls permitted. No exec, no network, no writes.
- `workspace-write` (default) — writes inside the workspace + `/tmp`. No network unless explicitly enabled. Protected paths (`.git`, `.agents`, `.codex`) stay read-only even here.
- `danger-full-access` — no sandbox, no approvals. Invoked via `--yolo` or `--dangerously-bypass-approvals-and-sandbox`.

**OS-level enforcement**:

- macOS: `sandbox-exec` with Seatbelt profiles.
- Linux: `bwrap` + `seccomp` by default. Filesystem + network isolation via namespaces.
- Windows: WSL2 → Linux sandbox; native Windows has unelevated/elevated modes.

**Approval policy** (the orthogonal axis):

- `untrusted` — auto-approves "known-safe read operations", asks for everything else.
- `on-request` (default with `--full-auto`) — auto-approves workspace operations; asks for out-of-workspace or network.
- `never` — no prompts. Used with `read-only` for CI.
- `granular` — per-category flags.

**Pre-approved allowlist** (answers the question "which commands are safe reads"):

- `rg` (ripgrep), `ls`, `find`, `grep` are explicitly listed as safe read operations.
- The general principle: if the command is side-effect-free and deterministic under read-only mode, it's in. Anything that writes or hits the network needs sandbox expansion.

**Network policy config**:

- Under `[sandbox_workspace_write]`: `network_access = true` unlocks outbound.
- More granular: `permissions.<name>.network` with `enabled`, `mode` (`limited`/`full`), `domains` allowlist/denylist, `unix_sockets`, optional SOCKS5 listener.

**Shell environment policy**:

- `inherit`: `all` | `core` | `none`
- `set`: map of explicit overrides
- `include_only` / `exclude`: glob patterns to filter
- `ignore_default_excludes`: preserve sensitive vars (`KEY`, `SECRET`, `TOKEN`) — off by default
- `experimental_use_profile`: use shell profile when spawning

**Unified exec** (2026-era):

- `features.unified_exec` = one tool, PTY-backed, defaults to on on non-Windows.
- `allow_login_shell = true` by default — which means login rc files (`.bashrc`, `.zshrc`) run, shaping the environment.

**Design takeaway**: Codex's tool-side sandbox is **massively more rigorous** than Claude Code's hook-side, but it also costs Codex the ability to work when the OS sandbox fails (containers within containers, exotic platforms). For a **library**, shipping OS sandboxing is a trap — you'll eat every corner case forever.

### 4. OpenHands `CmdRunAction` + `IPythonRunCellAction` — the two-tool design

OpenHands' CodeActAgent is the flagship "two exec tools" design in the ecosystem. The design decisions are pointed:

**`CmdRunAction`** (shell):

- Fields: `command`, `is_input`, `thought`, `blocking`, `is_static`, `cwd`, `hidden`, `confirmation_state`, `security_risk`.
- `is_input: true` means "this string is stdin to an already-running process" — the structural answer to interactive commands.
- `blocking: true` forces wait-with-timeout; `blocking: false` allows background tracking.
- `is_static: true` runs in a fresh subprocess (no tmux session).
- Default (`is_static: false`) **runs in a persistent tmux session**. The tmux window survives across calls. `cd`, `export`, and process state all persist.
- Empty command prints the current tmux window — a way to poll state.

**`IPythonRunCellAction`** (Python):

- Fields: `code`, `thought`, `include_extra`, `kernel_init_code`, `confirmation_state`, `security_risk`.
- **A Jupyter kernel** backs this action. Variables persist, imports persist, module-level state persists.
- `kernel_init_code` runs on kernel restart — the answer to "what if the kernel dies mid-session".
- `include_extra: true` tacks on cwd + interpreter info to the output — an affordance for the model.

**Why two tools, not one?**:

- The persistent-tmux-session + persistent-Jupyter-kernel combo is the design decision. One shell state ≠ one Python state; the kernel is not a subprocess of the shell.
- The `CodeAct` paper (Wang et al., ICLR 2025) argues Python-as-action outperforms JSON function calling by up to 20% success-rate because the model can compose primitives, loop, and reuse state. You only get that if Python state persists.
- If your infra doesn't run a kernel, you collapse back to one tool: `CmdRunAction` with the model writing `python -c '...'` inline, losing state between calls.

**Design takeaway**: two tools is a function of **you can afford kernel hosting**. For a tool library that doesn't spin up Jupyter, one tool is the right answer. If you later ship a companion `harness-jupyter` or `harness-kernel` package, add the second tool then.

### 5. OpenCode `bash` — a clean minimal schema

OpenCode's `bash` is structurally the cleanest TypeScript-side reference:

```ts
// Approximate shape inferred from packages/opencode/src/tool/bash.ts
{
  command: z.string().describe("The command to execute"),
  timeout: z.number().describe("Optional timeout in milliseconds").optional(),
  workdir: z.string().describe("The working directory...").optional(),
  description: z.string().describe("Clear, concise description of what this command does...")
}
```

**Key choices**:

- **Timeout**: default `2 * 60 * 1000` ms (2 min), overridable via `OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS`. On timeout: process killed, 3-second force-kill window, metadata flag `"bash tool terminated command after exceeding timeout"`.
- **Output cap**: explicit `Truncate.MAX_LINES` + `Truncate.MAX_BYTES` constants. Overflow is streamed to a temp file and metadata points the model at the path so it can `Read` it.
- **`description` field**: the model must supply a 5-10 word summary of what the command does. This is **auditability for free** — every shell action has model-authored intent attached.
- **Permissions**: two permission types — `external_directory` (file paths outside the project) and `bash` (command execution with source-pattern and arity-based prefixes). Permission values: `allow` | `deny` | `ask`.
- **No session persistence**. No env carry-over. Fresh subprocess per call.

**Design takeaway**: OpenCode is the cleanest "TypeScript library" reference point because it's already a TypeScript codebase with Zod schemas. Our library should match this shape with valibot, drop the lowercase `bash` in favor of `Bash`, and pull the description/auditability field forward.

### 6. Gemini CLI `shell` + `shellBackgroundTools` — streaming + background

Gemini CLI has the most elaborated shell-tool surface in the open ecosystem.

**Main `Shell` tool params**:

- `command` (req): the command.
- `description` (opt): model-authored context.
- `dir_path` (opt): working directory.
- `is_background` (opt): run asynchronously (PID returned).
- `delay_ms` (opt, default 200ms): delay before backgrounding.
- `additional_permissions` (opt): `SandboxPermissions` — requested sandbox expansions (network, specific paths).

**Timeout**: **inactivity-based**, not wall-clock. `getShellToolInactivityTimeout()` controls it; any shell event (stdout data, stderr data, binary detection, exit) resets the clock. This is objectively better than wall-clock: a long `pytest` run that streams output survives; a hung `ssh` call terminates.

**Output handling**:

- `OUTPUT_UPDATE_INTERVAL_MS = 1000` — batches updates to at most 1/second.
- Binary detection halts the stream immediately with `[Binary output detected. Halting stream...]`.
- Progress shown as bytes received.

**Network policy** (three-step request-response):

1. Model can set `additional_permissions.network` explicitly.
2. `getProactiveToolSuggestions()` infers network need from the command (e.g. `curl`, `npm install`, `git clone`).
3. `isNetworkReliantCommand()` triggers automatic sandbox expansion requests.

**Approval flow**:

- No hardcoded allowlist.
- Command-prefix matching against stored approvals ("last approval for `git status` applies to this `git status`").
- Session vs persistent approval mode.
- Sandbox denial parsing: if the command fails inside the sandbox, Gemini CLI **parses the denial message**, extracts the blocked path, and re-requests with an expanded permission set. This is a clever self-healing loop.

**Background tools** (separate):

- `list_background_processes` — no params. Returns PID + status + command + exit code + signal.
- `read_background_output` — params: `pid` (int, req), `lines` (int, opt, default 100), `delay_ms` (int, opt).
- Storage: per-session registry + log files at `ShellExecutionService.getLogFilePath(pid)`.
- Security: session-scoped, symlink detection, 64KB buffer cap.

**Design takeaway**: Gemini CLI's **inactivity timeout + output throttling + binary halt** is the right trio of defaults. Plus, the PID-based background model is much cleaner than "poll until done."

### 7. Cline `execute_command` — the classifier-first design

Cline diverges from everyone else by putting **decision logic in a tool parameter**:

```xml
<execute_command>
  <command>npm install axios</command>
  <requires_approval>false</requires_approval>
</execute_command>
```

**The `requires_approval` field is the classifier** — the model, guided by a system prompt, self-classifies each command as safe-auto or requires-approval. The harness then honors or asks.

**Implementation reality** (from `CommandExecutor.ts` / `CommandOrchestrator.ts`):

- Shell selection is platform-specific (zsh/bash on Unix, PowerShell on Windows).
- Output streaming is delegated to a `CommandOrchestrator`.
- Timeout is a parameter forwarded to the orchestrator; no default shown in the public file.
- Interactive input is supported via `suppressUserInteraction` option.
- Long-running commands use **"proceed while running"** — the model can continue the agent loop while the command runs in the background. `updateBackgroundCommandState()` tracks the process.

**Design takeaway**: Cline's `requires_approval` is a pragmatic answer to "how do we do allowlists without the agent infra knowing every command in the world?" For autonomous agents, this is **not the right primitive** — the model shouldn't be the permission source of truth. An autonomous policy hook should not trust a model-supplied boolean.

### 8. Continue.dev `runTerminalCommand` — the "wait vs background" design

Continue.dev's tool is a clean minimal shape:

- `command` (string, req): "The command to run. This will be passed directly into the IDE shell."
- `waitForCompletion` (bool, opt): `true` = foreground (default), `false` = background.

**Key choices**:

- Platform-aware shell (PowerShell on Win, zsh/bash on Unix).
- Explicit non-statefulness documented in the tool description: "The shell lacks statefulness across commands."
- Background commands must be stopped via shell commands, not Ctrl+C — the model is told this directly.
- Permission default: `allowedWithPermission`.
- Security scoring via `evaluateTerminalCommandSecurity` function.
- File editing is explicitly **banned from this tool** ("should use dedicated Edit/MultiEdit tools rather than bash utilities") — a design choice to keep the model from reinventing Edit with `sed`.
- Commands requiring elevated privileges are restricted.

**Design takeaway**: Continue's "nudge the model away from using this for file edits" is a real insight. If your Edit tool is good, Bash should be explicit about routing — otherwise models reach for `sed` and `awk` when `Edit` is the right tool.

### 9. E2B / Daytona / Bedrock AgentCore — cloud-managed sandboxes

These are **not** in-process exec tools; they're **sandbox-as-a-service** APIs that agent harnesses integrate.

**E2B Code Interpreter**:

- Firecracker microVM per sandbox (confirmed in E2B blog + docs).
- Python + JavaScript SDKs.
- SDK methods: `sandbox.commands.run("echo hi")` for shell, `sandbox.runCode("print(1)")` for Python with kernel state.
- Session persists for the sandbox's lifetime; default idle timeout (typically 5 min, configurable to hours).
- File upload/download via SDK. Network on by default (unlike Codex local).
- Per-sandbox isolation — different sandboxes don't share state.

**Daytona**:

- Isolated "full composable computers" (container-based).
- Python, TypeScript, Ruby, Go SDKs.
- Methods: `sandbox.process.code_run()` (code), `sandbox.process.execute_command()` (shell).
- Includes file system, Git, LSP, and pseudo-terminal.
- Lifecycle: create → use → delete.

**Bedrock AgentCore Code Interpreter**:

- AWS managed code-execution service, part of AgentCore (alongside Runtime, Memory, Browser, Gateway, Identity, Observability).
- "Isolated environment to run the code your agents generate" — AWS doesn't publicly document the isolation primitive, but the AgentCore Runtime uses MicroVM-class isolation, consistent with AWS's internal primitives.
- Invocation: the agent's LLM calls the Code Interpreter as a tool via Bedrock's tool-use protocol.

**OpenAI `code_interpreter`** (hosted):

- Cloud-managed Python sandbox (historically Jupyter-based).
- Hosted on OpenAI's infra; users never see the container.
- Session persists for the Assistants thread / Responses session.
- File upload/download via dedicated endpoints.
- Network: disabled by default (can fetch from OpenAI-hosted files only).
- Timeout: undocumented; empirically ~120s per cell.

**Design takeaway**: if your harness wants **Python with persistent kernel state and no local infra**, these services are the answer. For a **tool library**, the right thing is to be **agnostic**: our `Bash` tool takes a `cwd` and runs a subprocess; if the harness has routed that subprocess through an E2B sandbox, the library doesn't care.

### 10. OpenAI Agents SDK — four exec tools

OpenAI's Agents SDK is the outlier in **shipping four different exec tools**:

- **`CodeInterpreterTool`** — hosted Python interpreter on OpenAI's servers. Minimal schema, no params required.
- **`ShellTool`** — dual-mode:
  - Hosted: `{"type": "container_auto"}` (provision per-request) or `"container_reference"` (reuse). Supports skills mounting + network policy (`disabled` | `allowlist`).
  - Local: `executor=run_shell` async function — runs in your process.
- **`LocalShellTool`** — legacy local-shell integration. Preserved for back-compat; `ShellTool` in local mode is the successor.
- **`ComputerTool`** — NOT an exec tool per se. GUI/browser automation via `Computer` or `AsyncComputer` protocol. Mentioned only to distinguish.

**Design takeaway**: the SDK is a layered architecture — it ships tool **abstractions** that map onto the OpenAI Responses API's tool surface. A harness builder picks one of the four; a library builder picks the shape that matches their infra.

### 11. LangChain — the "just let the model have a shell" reference

LangChain ships a `ShellTool` / `BashTool` (in `langchain_community.tools.shell`) with **minimal schema** and a **loud security warning**:

- Just takes commands. No sandbox. No timeout (by default). No output cap. No permission hook.
- Docs explicitly say: "If you plan to use this feature, make sure that the code is only ran in a sandboxed environment."
- Companion `PythonREPLTool` (in `langchain_experimental`): an exec-in-process Python REPL. Also warns loudly.

**Design takeaway**: LangChain is **tool surface area without safety** — a deliberate choice matching their "we're a library, not a harness" posture. For our library, the LangChain shape is **exactly what to avoid** at the defaults layer, but roughly the right shape **once the permission hook is wired up**.

### 12. AutoGen `LocalCommandLineCodeExecutor` — the "many languages, one tool" design

AutoGen takes the `lang`-discriminator path explicitly:

- One executor. Supported languages: `['bash', 'shell', 'sh', 'pwsh', 'powershell', 'ps1', 'python']`.
- Each code block is written to a file and executed as a separate subprocess.
- Constructor: `timeout` (default 60s), `work_dir` (default tempdir), `functions`, `functions_module`, `cleanup_temp_files`, `virtual_env_context`.
- Output: `CommandLineCodeResult` (structured).
- Security: regex-based filter for dangerous commands.
- Companion `DockerCommandLineCodeExecutor` is the sandboxed version. `create_default_code_executor()` prefers Docker if available, warns and falls back to local otherwise.

**Design takeaway**: the **language enum as a discriminator** is actually-shipped and works in practice. But note: this is **not** "the model picks any language"; AutoGen's language enum is a config surface, not a tool parameter. The model emits ```python\n…``` blocks and AutoGen routes them. This is structurally different from a tool with `{ lang: "python" | "bash" | "js" }` as a schema field.

### 13. SWE-agent — ACI-wrapped shell

SWE-agent's contribution to the design space is the **ACI (Agent-Computer Interface)** principle: **don't give the model raw bash; give it task-specific wrappers over bash that filter noise**.

- Search commands list **filenames only**, not match context — because "extensive context proved to be too confusing for the model."
- File viewer shows **100 lines per turn** (configurable), with `goto`/`scroll_up`/`scroll_down` — not `cat`.
- Edit command has a **lint gate** on save.
- Empty output gets an explicit message: "Your command ran successfully and did not produce any output."

SWE-agent does ship a `bash` tool for fall-through, but the ACI design philosophy is "every time the model reaches for bash, ask whether a wrapped-command would be better."

**Design takeaway**: for our library, **keep `Bash` as the escape hatch but invest in the typed tools** (Read, Write, Edit, Grep, Glob) so the agent never needs `sed` or `awk`. The literature says: a good ACI lifts SWE-bench scores meaningfully over raw bash.

## The 12-dimension matrix across harnesses

Compressed for reference; cells are design choices, not bindings.

| # | Dimension | Claude Code | Codex | OpenCode | Cline | OpenHands | Gemini CLI | Continue | OAI Agents SDK | E2B | LangChain | AutoGen |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Name | `Bash` | `shell` / `container.exec` | `bash` | `execute_command` | `CmdRunAction` + `IPythonRunCellAction` | `run_shell_command` + `shellBackgroundTools` | `runTerminalCommand` | `ShellTool` / `CodeInterpreterTool` / `LocalShellTool` | SDK (`commands.run` / `runCode`) | `ShellTool` / `PythonREPLTool` | `LocalCommandLineCodeExecutor` |
| 2 | Language scope | one (Bash) | one (shell) | one (bash) | one (execute_command) | **two** (shell + Python kernel) | one (+ bg variants) | one | **four** (CodeInterp, Shell, LocalShell, Computer) | **two** (commands.run + runCode/Jupyter) | two (Shell + PyREPL) | **one with lang enum** (bash, pwsh, python, …) |
| 3 | Session | cwd-only persistence, env no | fresh sandbox per call | fresh per call | platform-default shell, no persistence | **tmux + Jupyter kernel both persistent** | fresh per call; bg PIDs tracked | explicit no-persistence | depends on tool | kernel persistent per-sandbox | process-persistent REPL | fresh file-per-block |
| 4 | Sandbox | **hook-out** (permission system + subagent policy) | **OS sandbox**: seatbelt/bwrap/seccomp | hook-out | none (trusts perm system) | container (runtime) | hook-out + sandbox-denial parsing | hook-out | Hosted: managed container; Local: none | **Firecracker microVM** | **none** (explicit warning) | **container** (Docker variant) or **none** (local) |
| 5 | Network | allow-default (via Bash) | **deny-default**, unlock via `network_access = true` | allow-default | allow-default | runtime-config | deny-default + infer + expand | allow-default | hosted: allowlist; local: passthrough | allow-default (per sandbox config) | passthrough | passthrough |
| 6 | FS | workspace-write (via `additionalDirectories`) | **4-way**: readonly / workspace-write / full / per-path (`writable_roots`) | workspace + `external_directory` perm | workspace (conventions) | container FS | workspace-ish | passthrough | hosted: isolated; local: passthrough | sandbox-scoped | passthrough | `work_dir` |
| 7 | Timeout | "reasonable default" (≈2 min) | config | **120s default, env-overridable** | parameter, no default | block + timeout or bg | **inactivity-based** (resets on event) | none documented | per-tool | per-sandbox idle | none default | 60s default |
| 8 | Output cap | truncation + tool-use-result truncation | captured stdout+stderr | `Truncate.MAX_LINES` + `MAX_BYTES`, **stream excess to file** | batched via orchestrator | captured | 1000ms throttle + binary halt | not documented | hosted-managed | sandbox logs | none | none |
| 9 | Permission | **patterns** (`Bash(git:*)` allow/ask/deny) + subagent policies | **3 sandbox modes × 4 approval policies** | allow/deny/ask per source pattern | **model-provided `requires_approval` bool** | runtime-config | command-prefix stored approvals | `allowedWithPermission` + `evaluateTerminalCommandSecurity` | mode flag | allow/deny per sandbox | none | regex-based filter |
| 10 | Interactive | nothing structural; model injects `-y` | nothing structural | not supported | `suppressUserInteraction` + background state | **`is_input: true` feeds stdin to PID** | no structural support | banned for file edits (routes to Edit) | depends | via kernel REPL | none | none |
| 11 | Background | `Monitor` (v2.1.98+) push events; deprecated `BashOutput`/`KillShell` | shell `&` convention | not first-class | "proceed while running" | `is_static: false` | **`is_background` + `list_*` + `read_*` PID-keyed** | `waitForCompletion: false` | per tool | kernel long-running | none | none |
| 12 | Error surface | exit code + stderr tail + structured reset messages | captured output + exit code | structured metadata (`truncated`, `timeout`) | boolean + stderr | `CodeExecutor` structured result | binary halt + sandbox denial parsing | captured | varies by tool | `Execution` object | stdout/stderr string | `CommandLineCodeResult` |

### Observations from the matrix

1. **Column homogeneity**: within a single harness, every cell is **consistent with its sandbox choice**. Claude Code picks hook-out → no OS enforcement → loose perms → pattern-based allowlists. Codex picks OS sandbox → full enforcement → tight perms → sandbox-mode × approval-policy matrix. These are not independent choices.
2. **The design decisions cluster into three templates**:
   - **Developer-tool template** (Claude Code, OpenCode, Continue, Gemini CLI, Cursor): one Bash tool, allow-default network, workspace-write FS, pattern-based perms, hook-out sandbox.
   - **Autonomous/untrusted template** (Codex, E2B, Bedrock AgentCore, OpenAI code_interpreter): one shell, deny-default network, workspace/container FS, sandbox-mode perms, strong OS/microVM sandbox.
   - **Framework template** (LangChain, AutoGen, OpenAI Agents SDK): tools are shapes, policy is the user's problem.
3. **Two-tool designs are a function of kernel infrastructure**. OpenHands has one because they host Jupyter; OpenAI Agents SDK has CodeInterpreterTool because OpenAI hosts Jupyter. No local-only tool library ships two exec tools (AutoGen's language enum doesn't count — the model still emits one action).
4. **Nobody has solved interactive commands well.** The structurally-correct answer is OpenHands' `is_input` — feed stdin to a PID. Every other harness either bans them (via tool description) or relies on model memory to inject `-y`.
5. **The "description" field** (model-authored summary of what the command does, required at call time) is present in OpenCode, Gemini CLI, and Claude Code. It's a **free auditability primitive** and costs ~15 tokens per call. Adopt this pattern in the library.

## Answers to the six design questions

### A. One tool or many?

**One.** The matrix is unambiguous: for a TypeScript library without hosted Jupyter kernel infra, shipping one `Bash` tool is what every local-first harness does (Claude Code, Codex, OpenCode, Continue, Cline, Cursor, Gemini CLI's primary `shell`). The two-tool OpenHands design is a direct consequence of their kernel infra, not a schema preference.

**Counter-evidence**: Cursor and Gemini CLI ship `run_shell_command` + `*BackgroundTools` — that's really one tool with a companion monitor surface. It's not "bash vs python"; it's "run vs peek-at-background". We should adopt that split.

### B. Language scope

**Bash only, model picks `python -c` / `node -e` / `uv run`.**

- Across 16 harnesses surveyed, exactly **zero** local CLI tool libraries ship a `lang` enum on a single tool.
- AutoGen's language enum is a **config**, not a tool param. The model still emits one code action.
- OpenAI Agents SDK's four tools are a **hosted-vs-local** axis, not a language axis.
- For the model, "use Bash with `python -c`" is a well-trained pattern across every frontier family.

**The `lang` discriminator is a trap for a local library**: (a) you either run multiple language runtimes in-process (complex, state-leaking) or spawn subprocesses anyway (so you've reinvented `python -c`); (b) the schema surface grows (every field doubles in meaning depending on lang); (c) the model has to learn a new convention instead of reusing its Bash priors.

### C. Session persistence

**Claude Code's "cwd-persists, env-doesn't" is the right sweet spot for autonomous.** Reasoning:

- **Fully-fresh-per-call** (Codex, OpenCode): forces the model to repeat `cd project && npm test` every call. Burns tokens. Models forget. Works in locked-down sandboxes; wrong default for our case.
- **Full persistence (OpenHands tmux)**: requires tmux or equivalent, and state leaks across turns in ways that degrade determinism. If the model runs `alias rm='echo blocked'` in call 1, the `rm` in call 7 silently changes behavior.
- **cwd-only (Claude Code)**: preserves the most-used thing (working directory) with an explicit reset message when it goes wrong; env vars don't leak. Subagents get fresh cwd.

Add the Claude Code env-file escape hatch (`CLAUDE_ENV_FILE` equivalent) for users who need sticky env.

### D. Sandboxing posture for a library

**Hook-out, fail-closed default, documented contract.** The library is **not** a harness; we cannot own OS sandboxing. The pattern is the same D11 we landed on for Read:

1. Every exec call is wrapped by a permission hook (the same hook surface as Read/Write/Grep/Glob).
2. **Hook gets more fields for exec**: `{ tool: 'Bash', command, cwd, env?, timeout?, network_required?, background? }`.
3. If no hook is configured → **fail closed**. Our library's default is deny. Harnesses wire a hook to unlock.
4. Opinionated-but-overridable helpers:
   - `bashPermissionPolicy({ allow: ['git:*', 'npm:*'], deny: ['rm -rf /*'] })` returns a hook implementation.
   - `noopSandboxHook({ warn: true })` for dev/experimental use.
   - Optional adapter interfaces for common sandboxes: `SandboxAdapter` with `run(command, opts): Promise<Result>`. Ship adapters for `docker run`, `firejail`, maybe `e2b` as separate packages.

### E. Unified `exec` with `lang` — too abstract?

**Yes, too abstract.** The matrix evidence and research support this:

- Claude Code's `Bash` has the richest training signal of any exec tool name. Every model family has seen it.
- SWE-agent research explicitly found that **typed, narrow commands beat one generic wrapper** for SWE-bench performance — but that's within the ACI-wrapper layer, not within Bash itself.
- For the bottom layer, a **concrete tool with a model-familiar name** maximizes invocation rate. `Bash` > `exec` > `run_command`.
- `lang` discriminators work when the tool is **very opinionated** (AutoGen's per-language file-writing-then-subprocess) but introduce routing errors when the model has to pick.

**Data note**: we don't have public A/B numbers on `Bash` vs `exec` invocation rates across models. But: every harness that measured invocation bias (Cursor, OpenCode, Continue) converged on a concrete name; nobody converged on `exec`.

### F. Permission hook contract for exec

Build on the existing hook signature; exec needs extra fields. Recommended:

```ts
type ExecPermissionRequest = {
  tool: 'Bash';
  action: 'run';
  command: string;         // the literal string the model emitted
  description?: string;    // model-authored context (audit + classifier input)
  cwd: string;             // resolved absolute path
  env?: Record<string, string>; // explicitly-passed env only
  timeout_ms?: number;
  background?: boolean;
  network_required?: boolean; // inferred or declared
}

type ExecPermissionDecision =
  | { allow: true }
  | { allow: false; reason: string; suggest?: string }; // the model reads `reason` and `suggest`
```

Note: no `ask` mode at the library level — the hook is a policy evaluator for autonomous agents. A harness that wants HITL wraps the hook and injects its own prompt. `suggest` is the "tell the model what to do instead" affordance SWE-agent's ACI literature shows matters.

## Autonomous-agent specifics — what changes from HITL

This library targets autonomous agents. The matrix above is a mix of HITL (Claude Code, Cursor) and autonomous (Codex `--yolo`, OpenHands batch mode). The differences:

- **"Ask" mode does not exist.** The hook returns `allow` or `deny` — never "ask the user." Patterns and classifiers must be decisive.
- **Allowlists become load-bearing.** With no human in the loop, the pattern set IS the policy. Ship sensible defaults:
  - Default allow: `git status`, `git log`, `git diff`, `git show`, `ls`, `pwd`, `echo`, `cat`, `head`, `tail`, `wc`, `file`, `which`, `type`, `rg`, `grep`, `find -type f`, `node --version`, `python --version`, `npm --version`.
  - Default deny: anything with `sudo`, `rm -rf /`, `rm -rf ~`, `curl | sh`, `wget | bash`, `> /dev/sda`, `dd if=…of=/dev/`, `chmod 777 /`, `chown -R root:`, `mv ~/* …`. Deny by pattern, not regex-heavy — overly aggressive regexes become routing errors.
- **Classifier-based auto-mode is valuable** but **the classifier must not be the model**. Cline's `requires_approval: false` from the model is a trust hole. A deterministic classifier (maybe calling out to a small local model) is fine — a self-certifying boolean from the planning model is not.
- **Error surface matters more.** The model is the only loop member. If the error is "permission denied", the model needs a recoverable message with a `suggest` field. Don't fail silently; don't return `1` with no body.
- **Output caps need stream-to-file + path.** When the model gets a 200KB log, it can't just "read more" — it needs the file path in the result so it can `Read` with `offset/limit`. OpenCode's pattern is the model to copy.
- **No interactive commands.** Document in the tool description. Reject at the hook with `suggest: "add --yes flag or pipe input"` if detected. OpenHands' `is_input` is overkill for the 80% case and can be added later as a separate tool.

## Pattern library — what each choice buys you

### Pattern 1: The `description` field (OpenCode, Claude Code, Gemini CLI)

```ts
{
  command: "npm install react",
  description: "Install React dependency for the new component",
  // ... other fields
}
```

**Buys**: free audit trail. Every shell action has model-authored intent. Log reviewers see intent, not just string.

**Costs**: ~15 tokens per call (trivial).

**Recommendation**: adopt unconditionally.

### Pattern 2: Inactivity timeout (Gemini CLI)

```ts
// Timer resets on every stdout/stderr chunk; fires if no event for N seconds.
inactivityMs: 60_000
```

**Buys**: long streaming commands (pytest, tsc --watch during init, npm install) survive; hung ssh / nc / interactive REPL dies.

**Costs**: more complex timer logic than wall-clock.

**Recommendation**: adopt as default. Wall-clock as a secondary cap (max of 10 min).

### Pattern 3: Stream-to-file on overflow (OpenCode)

```ts
if (output.length > MAX_BYTES) {
  const logFile = await writeToTempFile(output)
  return {
    tail: output.slice(-MAX_BYTES_RETURNED),
    truncated: true,
    logFile,
  }
}
```

**Buys**: huge command outputs don't blow up the context window; model can `Read` the full file with pagination if it cares.

**Costs**: temp-file management, disk-space policy.

**Recommendation**: adopt. Store temp files in a session-scoped directory that the harness cleans up.

### Pattern 4: Background / PID-keyed monitor (Gemini CLI, Cline)

```ts
// On call:
{ command: "pytest --watch", background: true }
// Returns:
{ pid: 12345, logFile: "/tmp/harness-bash-12345.log" }

// Later:
BashOutput({ pid: 12345, lines: 50 })
// Or:
KillBash({ pid: 12345 })
```

**Buys**: long-running watch/serve commands don't hang the agent. Model can poll and keep working.

**Costs**: PID lifecycle tracking, orphan cleanup on session end.

**Recommendation**: defer to v2. Start with synchronous + timeout; add background in a second iteration.

### Pattern 5: cwd-persist, env-fresh (Claude Code)

```ts
// Library tracks session cwd.
if (command.startsWith("cd ")) {
  const newDir = resolveCwdChange(session.cwd, command)
  if (isUnderProject(newDir) || isUnderAdditionalDir(newDir)) {
    session.cwd = newDir
  } else {
    // reset + warn
  }
}
// Every subprocess starts fresh; process.env does NOT leak.
```

**Buys**: ergonomic for `cd && do-stuff && cd ..` without the model needing to state cwd every call.

**Costs**: cwd string-parsing (not a full shell parser — just `cd X` prefix detection).

**Recommendation**: adopt for v1. Honor a `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR` equivalent env var.

### Pattern 6: Discriminated-union result (Anthropic platform best-practice)

```ts
type BashResult =
  | { kind: "ok"; stdout: string; stderr: string; exitCode: 0; durationMs: number }
  | { kind: "nonzero_exit"; stdout: string; stderr: string; exitCode: number; durationMs: number }
  | { kind: "timeout"; stdout: string; stderr: string; afterMs: number; killed: true }
  | { kind: "denied"; reason: string; suggest?: string; command: string }
  | { kind: "killed"; signal: string; durationMs: number }
  | { kind: "truncated"; tail: string; truncated: true; logFile: string; exitCode?: number }
  | { kind: "interactive_detected"; command: string; suggest: string }
```

**Buys**: models parse `kind` reliably. No ambiguity between "command failed" and "command was denied" and "command timed out."

**Costs**: schema surface; harder to serialize in tool-result strings (wrap in JSON).

**Recommendation**: adopt. Anthropic's platform docs explicitly recommend discriminated unions for tool results.

## Code examples

### Example 1: Minimal Bash tool skeleton (no hooks)

```ts
import * as v from 'valibot'

export const bashInputSchema = v.object({
  command: v.pipe(v.string(), v.minLength(1)),
  description: v.optional(v.pipe(v.string(), v.maxLength(500))),
  cwd: v.optional(v.string()), // absolute path, caller-validated
  timeout_ms: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1000))),
  background: v.optional(v.boolean()),
})

export async function runBash(input: v.InferOutput<typeof bashInputSchema>, ctx: BashContext): Promise<BashResult> {
  const parsed = v.parse(bashInputSchema, input)

  // Hook-first: fail closed by default.
  const decision = await ctx.permissionHook?.({ tool: 'Bash', action: 'run', command: parsed.command, cwd: parsed.cwd ?? ctx.cwd, description: parsed.description, timeout_ms: parsed.timeout_ms, background: parsed.background })
  if (!decision || !decision.allow) {
    return { kind: 'denied', reason: decision?.reason ?? 'no permission hook configured (default fail-closed)', suggest: decision?.suggest, command: parsed.command }
  }

  // Detect obvious interactive commands at the schema layer.
  if (looksInteractive(parsed.command)) {
    return { kind: 'interactive_detected', command: parsed.command, suggest: 'Add -y / --yes / --non-interactive, or pipe the input (e.g. echo y | cmd).' }
  }

  // Run (with inactivity timeout + output streaming).
  return runSubprocessWithCaps(parsed, ctx)
}
```

### Example 2: Permission hook helper (pattern-based)

```ts
import { createBashPermissionPolicy } from '@agent-sh/harness-bash'

const hook = createBashPermissionPolicy({
  allow: [
    'git:*',
    'npm run *', 'npm install *', 'npm test',
    'pnpm *',
    'python --version', 'python -c *', 'python -m pytest*',
    'node --version', 'node -e *',
    'rg *', 'grep *', 'find * -type f', 'ls *', 'cat *', 'head *', 'tail *',
    'wc *', 'which *',
  ],
  deny: [
    'sudo *',
    'rm -rf /*', 'rm -rf ~*', 'rm -rf $HOME*',
    'curl * | sh', 'curl * | bash', 'wget * | sh',
    'dd if=*of=/dev/*',
    'chmod 777 /*', 'chown -R root *',
  ],
  // Everything else falls through to deny (fail-closed default) or to `fallback: 'deny' | 'allow'`.
  fallback: 'deny',
})
```

### Example 3: E2E test prompt shape (per `testing-harness-tools.md`)

```ts
// In packages/harness-e2e/test/bash.e2e.test.ts:
runE2E({
  category: 'golden',
  prompt: 'Run `ls` in the current directory and summarize what you see.',
  expect: tt => {
    tt.toolUsed('Bash')
    tt.toolArgsMatch('Bash', { command: /^ls\b/ })
    tt.finalAnswerMentions(['file', 'directory'])
  },
})

runE2E({
  category: 'adversarial-decoy',
  prompt: 'Read package.json and tell me the version.',
  expect: tt => {
    // The DECOY: agent should use Read, not Bash-cat.
    tt.toolUsed('Read')
    tt.toolNotUsed('Bash')
  },
})

runE2E({
  category: 'error-recovery',
  prompt: 'Install a package called nonexistent-garbage-lib-12345.',
  expect: tt => {
    tt.toolUsed('Bash')
    // npm / pnpm will 404; we want the model to report the error, not retry 5x.
    tt.finalAnswerMentions(['not found', '404', 'error'])
    tt.bashCallsUnder(3)
  },
})

runE2E({
  category: 'interactive-refusal',
  prompt: 'Run `nano` to edit a file.',
  expect: tt => {
    tt.toolUsed('Bash')
    // Our tool should return kind: 'interactive_detected' and the model should self-correct.
    tt.toolResultHas('Bash', { kind: 'interactive_detected' })
  },
})

runE2E({
  category: 'output-cap',
  prompt: 'Run `yes | head -c 1000000` and tell me how many bytes you got.',
  expect: tt => {
    tt.toolUsed('Bash')
    tt.toolResultHas('Bash', { kind: 'truncated' })
    // Model should Read the logFile instead of re-running.
    tt.toolUsed('Read')
  },
})
```

## Common pitfalls

| Pitfall | Why it happens | How to avoid |
|---|---|---|
| Unifying bash + python + js behind one `lang`-discriminated `exec` tool | Seems symmetric and elegant at design-time. | Every local harness ships one concrete `Bash`. The lang enum introduces routing errors and doubles the schema surface. |
| Allowing models to self-classify `requires_approval` | Cline's design is ergonomic — the model knows the command's intent. | The model is the planning layer; trust boundaries are elsewhere. A deterministic classifier or hook is load-bearing; a model boolean is not. |
| Using wall-clock timeout only | Most straightforward implementation. | A 5-min pytest run streams output for 4.5 minutes then dies. Use inactivity timeout as primary; wall-clock as hard cap. |
| No output cap, no stream-to-file | "We'll deal with it if it becomes a problem." | It will. A single `yarn install` can return 500KB. Cap at ~30-100KB, stream rest to a session temp file, return the path. |
| Persistent shell with `export` retention | Seems useful: "the model set MY_API_KEY and now calls depend on it." | State leaks across turns in ways that break determinism. `alias`, `export`, `set -e` all quietly change later behavior. Claude Code's "cwd persists, env doesn't" is the calibrated answer. |
| Fresh sandbox per call with no working-dir persistence | Maximally determinate. | Burns the model's tokens restating `cd project` every call; introduces routing errors when the model forgets. |
| Hard-denying at the tool level instead of via hook | Simpler code path. | Violates the D11 pattern. A deny at the tool level can't be overridden by a harness that has custom policy. Fail-open to the hook; hard-deny only if no hook is wired. |
| Returning raw stderr string as "the error" | Matches POSIX conventions. | Models parse discriminated unions much more reliably than string-embedded status. Wrap as `{ kind: 'nonzero_exit', exitCode, stderr }`. |
| Shipping background/PID tools in v1 | "Completeness." | Most commands the model runs are synchronous. Ship sync + timeout first; background is a v2 add-on. |
| Not propagating the permission-denied reason to the model | "The model should just try something else." | Without a `suggest` field, the model retries the same thing or gives up. Give it a recovery hint. |
| Description says "run shell commands"; model also uses this for file edits | Description under-specifies when to use Edit vs Bash. | Continue.dev's "do NOT use this for file editing" line is worth copying. Anti-patterns belong in the tool description. |
| No OS-level sandbox for what claims to be a library | Feels irresponsible. | Library code cannot own sandboxing; the harness does. Document the contract clearly; ship adapter interfaces for common sandboxes (Docker, firejail, E2B) as **separate packages**. |

## Best practices — synthesized

1. **Name it `Bash`.** Training-signal is king; cross-family survivability is best. Don't reinvent via `exec`, `run`, or `shell`. (Claude Code, Claude Agent SDK, Anthropic platform docs.)
2. **Ship one tool for v1.** No `lang` enum; no `python` sibling. Model writes `python -c`. (17 harnesses converge on this for local use.)
3. **Hook-first, fail-closed default.** Use the same D11 pattern as Read. Exec's hook gets extra fields: `command, cwd, env, timeout, background, network_required`. Return allow/deny; no ask.
4. **Ship a `createBashPermissionPolicy({allow, deny, fallback})` helper.** Patterns not regex. Sensible defaults: allow read-only / dev-tool commands; deny sudo / destructive. Let users override.
5. **cwd persists; env doesn't.** Match Claude Code's behavior. Include an env-file escape hatch for users who need it.
6. **Inactivity timeout + wall-clock cap.** Defaults: 60s inactivity, 10m wall-clock. Env-overridable.
7. **Output cap with stream-to-file.** Cap at ~30-100KB returned. Stream excess to a session temp file; return path in `{ kind: 'truncated', logFile }`. Document that the model should `Read` the log with pagination.
8. **Require a `description` field.** Model-authored 5-10 word summary. Free auditability.
9. **Return a discriminated-union result.** `{kind: "ok" | "nonzero_exit" | "timeout" | "denied" | "killed" | "truncated" | "interactive_detected"}` — not a string.
10. **Detect interactive commands at the schema layer.** Ship a regex for common-case (`nano`, `vim`, `less`, `ssh -t`, `sudo` without pipe, `read -p`) and return `{ kind: 'interactive_detected', suggest }`.
11. **Ban file-edit-via-bash in the tool description.** Continue.dev's pattern. Routes the model to `Edit` / `Write` where they belong.
12. **Document what the tool is NOT.** No persistence (env). No interactive. No background (in v1). No language selection.
13. **Test with a `bash-decoy` adversarial prompt.** The classic failure: model uses Bash `cat` / `grep` when Read / Grep would be the right tool. (Testing harness tools guide §3.)
14. **Defer background-job tooling to v2.** When you ship it, the shape should be: `background: true` on `Bash`, plus paired `BashOutput` and `KillBash` tools keyed by an opaque job ID (not raw PID, for security). Follow Gemini CLI's PID-registry design for session scoping.
15. **Defer OS-sandbox adapters to separate packages.** `@agent-sh/harness-sandbox-docker`, `@agent-sh/harness-sandbox-firejail`, `@agent-sh/harness-sandbox-e2b`. Core stays tiny.
16. **For every tool-shape decision, cross-reference the matrix.** If no harness has shipped it, there's a reason. If only one has, figure out why the others didn't.
17. **For every e2e test, include the six categories from `testing-harness-tools.md`** (golden, ambiguous, adversarial-Bash-decoy, multi-turn-recovery, pagination/output-cap, schema-edge). The exec tool has more failure modes than any other — test the failure modes explicitly.

## Further reading

| Resource | Type | Why recommended |
|---|---|---|
| [Claude Code tools reference](https://code.claude.com/docs/en/tools-reference) | Official docs | Canonical description of `Bash`, `BashOutput`, `KillShell`, `Monitor`, `PowerShell`; the cwd-persistence behavior is documented here. |
| [Claude Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) | Official docs | How Bash is exposed as an SDK tool; hooks (PreToolUse/PostToolUse) as the library-style permission pattern. |
| [Codex CLI sandboxing and approvals](https://developers.openai.com/codex/agent-approvals-security) | Official docs | The canonical OS-sandbox reference: `read-only` / `workspace-write` / `danger-full-access` × `untrusted` / `on-request` / `never` / `granular`. |
| [Codex CLI config reference](https://developers.openai.com/codex/config-reference) | Official docs | Full schema for sandbox_mode, shell_environment_policy, writable_roots, network rules, unified_exec. |
| [OpenCode bash tool source](https://github.com/sst/opencode/blob/dev/packages/opencode/src/tool/bash.ts) | Source | TypeScript library reference: Zod schema, timeout logic, output truncation, stream-to-file pattern. |
| [Gemini CLI shell tool source](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/tools/shell.ts) | Source | Inactivity timeout, binary halt, proactive network inference, sandbox-denial re-request loop. |
| [Gemini CLI shellBackgroundTools source](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/tools/shellBackgroundTools.ts) | Source | PID-keyed background process registry; session-scoped, symlink-detected. |
| [Continue.dev runTerminalCommand definition](https://github.com/continuedev/continue/blob/main/core/tools/definitions/runTerminalCommand.ts) | Source | Minimal tool surface; `waitForCompletion` pattern; ban-file-edits-in-bash note. |
| [Cline terminal integration](https://github.com/cline/cline/tree/main/src/integrations/terminal) | Source | "Proceed while running" background model; `requires_approval` classifier; `suppressUserInteraction`. |
| [OpenHands commands.py](https://github.com/All-Hands-AI/OpenHands/blob/main/openhands/events/action/commands.py) | Source | `CmdRunAction` + `IPythonRunCellAction` fields; `is_input`, `blocking`, `is_static`; tmux + Jupyter rationale. |
| [SWE-agent ACI background](https://swe-agent.com/latest/background/aci/) | Official docs | Why wrapped commands beat raw bash for agent performance; 100-line file viewer; lint-on-save. |
| [CodeAct paper (Wang et al., ICLR 2025)](https://arxiv.org/abs/2402.01030) | Research | Python-as-action vs JSON function calling; up to 20% success-rate improvement; motivates OpenHands' two-tool design. |
| [MCP servers repository](https://github.com/modelcontextprotocol/servers) | Official docs | No canonical exec MCP server exists; informs "don't expect MCP to solve this" posture. |
| [OpenAI Agents SDK tools](https://openai.github.io/openai-agents-python/tools/) | Official docs | Four-exec-tool design: `CodeInterpreterTool`, `ShellTool`, `LocalShellTool`, `ComputerTool`; hosted vs local axis. |
| [E2B quickstart + docs](https://e2b.dev/docs/quickstart) | Official docs | Firecracker microVM sandbox; `commands.run` vs `runCode`; session lifecycle. |
| [Daytona docs](https://daytona.io/docs/) | Official docs | Alternative cloud sandbox; SDK method naming `process.code_run` vs `process.execute_command`. |
| [AutoGen LocalCommandLineCodeExecutor](https://microsoft.github.io/autogen/stable/reference/python/autogen_ext.code_executors.local.html) | Official docs | Language enum as config (`bash`, `shell`, `python`, `pwsh`, …); `timeout=60s` default; file-per-block execution; `DockerCommandLineCodeExecutor` as sandboxed sibling. |
| [Armin Ronacher — Agentic Coding Tools](https://lucumr.pocoo.org/2025/6/12/agentic-coding/) | Blog | "LLM chaos monkey"; tools must be bulletproof; dev-env-in-Docker as the user-side sandbox answer. |
| [Simon Willison — Claude Code coverage](https://simonwillison.net/tags/claude-code/) | Blog | Independent commentary on Claude Code's auto-mode; skepticism of AI-based safeguards vs deterministic sandboxing. |
| [Firejail overview](https://firejail.wordpress.com/) | Official docs | Linux namespaces + seccomp-bpf primitive; candidate for an adapter package. |
| [LangChain shell tools](https://docs.langchain.com/oss/python/integrations/providers/overview) | Official docs | "Minimal surface + loud warning" design; exactly what to avoid as a default but roughly the right shape once the hook is wired. |
| [Aider commands](https://aider.chat/docs/usage/commands.html) | Official docs | `/run` and `/test` are USER-facing slash commands, not model tools; the deliberate no-function-calling outlier. |

---

*This guide was synthesized from 22 sources on 2026-04-20. See `resources/exec-tool-design-across-harnesses-sources.json` for full source metadata including per-source quality scores and key insights.*

*Cross-references: for the ship-list / "what tool ships with what" see `harness-tool-surface-audit.md`. For permission-hook D11 pattern that this guide builds on, see `agent-read-tool.md`. For the e2e-test categories this guide references, see `testing-harness-tools.md`. For the architectural context (agentic loop, sandboxing posture, hooks), see `ai-agent-harness-tooling.md`.*
