# Learning Guide: Write/Edit Tools Across AI Agent Ecosystems — Autonomous Coders, Frameworks, and Tool-Use Methodologies

**Generated**: 2026-04-20
**Sources**: 22 resources analyzed
**Depth**: medium
**Scope**: Complements `agent-write-edit-tools.md` (human-in-the-loop dev harnesses). This guide covers autonomous coders (OpenHands, SWE-agent, Devin, Agentless), agent frameworks (AutoGPT, BabyAGI, CrewAI, LangGraph / deepagents, Microsoft Autogen), and tool-use methodology lineage (Hermes function calling, OpenAI Agents SDK `ApplyPatchTool`, official MCP filesystem servers) — with a cross-ecosystem comparison focused on Write-tool design axes.

---

## Prerequisites

- You have read `agent-write-edit-tools.md` (covers Write/Edit/MultiEdit, `apply_patch` V4A, Aider SEARCH/REPLACE, Cline, OpenCode, Continue).
- Familiarity with the agentic loop (`tool_use` -> harness executes -> `tool_result`).
- Basic Python + TypeScript fluency — examples across ecosystems are shown in both.
- Mental model distinguishing two very different operating modes:
  - **Human-in-the-loop (HITL)**: a user approves each tool call, catches bad edits, and can rewind. Safety leans on humans.
  - **Autonomous**: the agent loops without gates, often in a sandbox / cloud VM, and must enforce its own invariants. Safety leans on tool design.

---

## TL;DR

- **Autonomous systems converge on three editor shapes** regardless of framework: (1) an **`str_replace_editor`** clone of Anthropic's text editor tool (OpenHands, SWE-agent `edit_anthropic` bundle, Agentless Anthropic mode), (2) a **line-range `edit N:M`** command with lint-on-save (SWE-agent original ACI), and (3) **`apply_patch` V4A** (OpenAI Agents SDK's `ApplyPatchTool`, Codex Cloud). Whole-file writers (AutoGPT, CrewAI `FileWriterTool`, LangChain `WriteFileTool`) are largely legacy and do not compete on SWE-bench.
- **SWE-agent's ACI thesis is the load-bearing insight**: "LM agents are a new category of end-user; their interface must be purpose-built." The concrete payoff in the paper is a **lint-on-save edit gate** — a syntactically invalid replacement is rejected before it touches disk, and the agent sees a structured error. This is the canonical example of a harness-enforced invariant that only matters in autonomous mode (no human to notice the red squiggle).
- **Multi-file atomicity is *not* solved in any major autonomous system**. Every editor reviewed applies edits per-file (and even within a file, MCP `edit_file` is fail-fast-in-memory but not rollback-on-disk-across-files). Real cross-file atomicity currently requires either (a) harness-level git transactions (Aider auto-commit, Codex sandbox git reset) or (b) LLM-level re-planning on partial failure. No framework ships a "transaction" primitive for multi-file edits.
- **Read-before-edit is enforceable by the tool in autonomous mode and usually is**. OpenHands' `str_replace_editor` inherits the same "old_str must match EXACTLY" contract as Anthropic's. MCP filesystem `edit_file` enforces it implicitly by throwing on non-match. LangChain's `WriteFileTool` and CrewAI's `FileWriterTool` do NOT — they will clobber files the agent never read, which is a large class of silent bugs.
- **The OpenAI Agents SDK has shipped a first-class `ApplyPatchTool`** with an `ApplyPatchEditor` protocol (create/update/delete/move operations) and a built-in approval callback. This is the cleanest "V4A as library primitive" implementation in any major framework and is the right reference point for a TypeScript Write tool spec.
- **MCP's official filesystem server is the de facto `write_file` + `edit_file` interop contract**. `edit_file` takes `{edits: [{oldText, newText}], dryRun}`, applies edits sequentially in memory, fails the whole operation if any match fails, and writes via atomic rename. Any harness that exposes file writes as MCP tools will be compared to this baseline.
- **"Claw" is not a publicly documented Nous Research framework.** Nous's shipping tool-use stack is `Hermes-Function-Calling` (ChatML + `<tool_call>` XML wrapping a JSON function call) and `hermes-agent` (a provider-agnostic agent harness with a ~40-tool set). Treat "Claw" as a label for Hermes-style XML-wrapped function calling unless the user provides a specific artifact link.
- **For our `@agent-sh/harness-*` Write spec, the load-bearing design choices** are: inherit V4A via `ApplyPatchTool`-style protocol, add an explicit read-ledger (sha + mtime) for stale-read detection, make repair-loop structured (the tool returns the closest fuzzy match on failure), and make multi-file atomicity opt-in through a `begin_edit` / `commit_edit` transactional wrapper — because no upstream system solves it and autonomous agents have no human to recover from half-applied refactors.

---

## Core Concepts

### 1. Where autonomous agents differ from dev harnesses on Write

The existing guide covers how harnesses *expose* file-mutation tools. Autonomous systems face a different problem: the loop does not stop on a bad edit. That changes the cost function in three specific ways.

| Axis | HITL harness (Claude Code, Aider, Cline) | Autonomous agent (OpenHands, SWE-agent, Devin, Codex Cloud) |
|------|-------------------------------------------|-----|
| Bad edit | User sees diff, rejects, model retries. | Edit commits; error surfaces only when tests fail or a later edit misses its anchor. |
| Multi-file refactor | User gates each file, pauses on smell. | Loop applies N files, may fail on file K of N. Recovery depends on test signal. |
| Staleness | User notices when they modify in another tab. | Background modification is invisible; only tool-enforced staleness guards catch it. |
| Verification | User runs tests when they feel like it. | Must be invoked explicitly (SWE-agent `submit`, OpenHands `bash pytest`, Devin internal CI). |
| Tool descriptions | Can assume some model-side common sense. | Must encode invariants that the model would otherwise skip. |

The implication for tool design: **autonomous-mode Write tools are load-bearing for correctness in a way HITL Write tools are not**. A Claude Code `Write` bug is a user annoyance. An OpenHands `str_replace_editor` bug is a benchmark regression.

### 2. OpenHands — `str_replace_editor` as lingua franca

OpenHands (formerly OpenDevin) is the dominant open-source autonomous coder and the top open-source entry on SWE-bench. Its `CodeActAgent` historically exposed three tools: `Bash`, `IPython`, and the editor. The editor went through three generations:

- **`LLMBasedFileEditTool`** — V0, deprecated. LLM generates a replacement region by line range; brittle, high token cost. Slated for removal April 2026.
- **`str_replace_editor`** — V1, current. A direct port of Anthropic's `text_editor_20250124`/`20250728` schema. Five commands: `view`, `create`, `str_replace`, `insert`, `undo_edit`. Parameters include `command`, `path` (absolute), and one or more of `file_text`, `old_str`, `new_str`, `insert_line`, `view_range`, plus OpenHands-specific `security_risk` for the permission layer.
- **V2 agentic architecture** — in progress per repo comments; migrates the tool surface into the new SDK layer.

Key implementation details from `openhands/agenthub/codeact_agent/tools/str_replace_editor.py`:

- **Exact-match contract** on `old_str`: "must match EXACTLY one or more consecutive lines from the file, including all whitespace and indentation."
- **Uniqueness enforced**: `old_str` must uniquely identify a single instance, or the call fails with a diagnostic. Prompt recommends 3-5 lines of context.
- **`create` refuses to overwrite**: "The `create` command cannot be used if the specified `path` already exists as a file."
- **Persistent state across calls**: the editor maintains a history so `undo_edit` works — a feature Anthropic later removed in the Claude 4 tool revision but OpenHands kept.
- **Absolute paths required** ("starting with /"). Relative paths are rejected.
- **Binary-aware**: the same tool can preview Excel, PowerPoint, PDF, and Word alongside plain text, returning rendered text for preview rather than raw bytes.

This design makes OpenHands' Write surface effectively a superset of Claude Code's Edit/Write — the same semantics, plus `undo_edit` and binary rendering.

### 3. SWE-agent — the ACI paper and `edit N:M` lint-on-save

SWE-agent (Princeton NLP, NeurIPS 2024) introduced the term **Agent-Computer Interface (ACI)** and the thesis that LM agents need purpose-built tools, not ports of human CLIs. Its original file editor is instructive because it encodes almost every "autonomous-mode Write invariant" in one command:

```
edit <start_line>:<end_line>
<replacement_text>
end_of_edit
```

Behaviorally, per `tools/windowed_edit_linting/config.yaml`:

- **Line-range, no patch format**. The agent specifies the inclusive range and the full replacement. This is *the* thing V4A and SEARCH/REPLACE exist to avoid, but SWE-agent's line numbers are anchored to the windowed viewer the agent was just looking at (100 lines max), not to the model's memory.
- **Lint-on-save is hard gated**: "a linter that runs when an edit command is issued, and do not let the edit command go through if the code isn't syntactically correct." Flake8 by default. A failed edit returns the lint error + the original code intact.
- **Windowed file viewer** (default 100 lines) — the only way the model sees file content. Every agent message includes the current file, current line, and total lines. This turns "edit 120:135" into a tractable local operation.
- **SWE-bench impact**: the paper reports **12.5% pass@1 on SWE-bench**, state-of-the-art for 2024. More recent runs with Claude/Anthropic mode (`edit_anthropic` bundle — which is a `str_replace_editor`) are much higher.

SWE-agent's repo exposes multiple tool bundles — `edit_linting`, `edit_anthropic` (str_replace), `windowed`, `windowed_edit_linting`, `windowed_edit_replace`, `windowed_edit_rewrite`. These are configuration-level swaps: the same agent shell, different edit tools, for comparing formats per-model.

### 4. Agentless — rejection sampling beats agentic loops

Agentless (Xia et al., 2024) is an explicit counter-argument to agentic editing: a three-phase pipeline (fault localization -> repair sampling -> patch validation). Its repair phase is a masterclass in edit-format engineering:

- **Three edit formats supported**, selectable per run: `edit_file(filename, start, end, content)` line-range (default), `SEARCH/REPLACE` blocks (`--diff_format`), and `str_replace` (`--str_replace_format`, Anthropic-only).
- **Sampling strategy**: one greedy T=0 sample plus up to `max_samples` T=0.8 samples. Patches that fail to parse or apply are logged and the loop continues.
- **Prompt caching** across samples — critical because each sample shares the same localization context.
- **Validation phase** runs regression + reproduction tests; final answer is chosen by majority vote (or test-pass vote).

Benchmark: **32% on SWE-bench Lite at ~$0.70/task** with no agentic loop. The takeaway for a Write tool spec: *if your tool's failure mode is structured enough to resample against, you don't need a loop*. This is why repair-loop diagnostics matter — they turn one failed edit into N+1 candidate recoveries rather than an error message.

### 5. Devin (Cognition) — opaque, but principled

Devin is closed-source. What's known from Cognition's SWE-bench technical report and demo materials:

- The agent operates in a sandboxed VM with **shell, editor, and browser** — i.e., it's fundamentally an IDE/user analog, not an API-tool agent.
- Edits are extracted post-run as "all other diffs in the file system as a patch" — i.e., Devin's final output is a plain git diff of the workspace, not a sequence of tool calls.
- The internal editor is unspecified, but demos show line-by-line editing in a VS Code-style UI; public discussion suggests a str_replace-style interface behind it.
- Devin is explicitly a benchmark case for "full autonomy": long-horizon tasks, no human gate, internal repair loops driven by CI signals from the sandbox.

The relevant takeaway is architectural, not technical: Devin treats Write as "whatever happens to the filesystem across the run," with evaluation done on the resulting diff. A harness that emits structured tool calls has strictly more information than a harness that emits arbitrary shell commands into a VM — which is why API-native approaches (OpenHands, SWE-agent) have closed the gap.

### 6. Agent frameworks: mostly no Write tool at all

This is the most useful load-bearing finding for the Write spec.

**AutoGPT** — the 2023 autonomous-agent poster child — ships a `WriteFileCommand` in its abilities layer that is a pure whole-file overwrite. No read-before-write, no atomicity, no diff. It predates SEARCH/REPLACE and `apply_patch` in the industry; its write-tool design is a lower bound, not a reference.

**BabyAGI** — task queue + LLM, no filesystem tools at all by default. The newer `functionz` version is a function registry; file I/O is user-supplied code.

**CrewAI** — ships `FileReadTool`, `FileWriterTool`, `DirectoryReadTool`, `DirectorySearchTool`. From `crewai-tools/.../file_writer_tool.py`:

```python
class FileWriterToolInput(BaseModel):
    filename: str
    directory: Optional[str] = "./"
    overwrite: bool = False   # default refuses to clobber
    content: str
```

No diff primitive. No read-before-write. No atomicity. The tool explicitly refuses to overwrite unless `overwrite=True` — which is a safety feature, but it's no substitute for a real edit path.

**LangChain `FileManagementToolkit`** — seven tools: `WriteFileTool`, `ReadFileTool`, `ListDirectoryTool`, `CopyFileTool`, `DeleteFileTool`, `MoveFileTool`, `FileSearchTool`. All whole-file. The single mitigating feature is `root_dir` sandboxing: "without one, it's easy for the LLM to pollute the working directory" per LangChain docs. There is no edit/patch tool.

**LangGraph** — no Write tools of its own. Users compose `WriteFileTool` from LangChain or wrap custom functions. The interesting LangGraph-adjacent project is `deepagents` (below).

**Microsoft Autogen** — explicitly delegates file edits to code executors. `LocalCommandLineCodeExecutor` and `DockerCommandLineCodeExecutor` extract markdown code blocks from agent messages, write them to temp files, and run them. There is a `FileSurfer` agent for reading — `open_path`, `page_up`, `page_down`, `find_on_page_ctrl_f`, `find_next` — but no `FileEditor` equivalent. In `Magentic-One`, the `Coder` agent issues shell commands that ultimately write files via the executor. This means **Autogen's "Write" is a Bash call**, with all the safety implications that entails (no read-before-write, no diff, no atomicity, no sandboxing except what the executor provides).

**LangChain `deepagents`** — the interesting exception. Explicitly Claude-Code-inspired, ships `read_file`, `write_file`, `edit_file`, `ls`, `glob`, `grep`, plus a `write_todos` planner. `edit_file` is string-replacement (same shape as Claude Code `Edit`). Whether the filesystem is virtual (LangGraph state) or real disk depends on middleware configuration — both modes are supported. This is the closest "open-source port of Claude Code's Edit/Write" in the framework tier.

### 7. Tool-use methodology lineage: Hermes, Agents SDK, MCP

Three bodies of work define how file-write tools are *transported* between model and harness.

**Hermes Function Calling (Nous Research).** ChatML plus three XML tags:
- `<tools>` in the system prompt carries OpenAI-shaped JSON function signatures.
- `<tool_call>{...}</tool_call>` wraps a JSON object `{"name": fn, "arguments": {...}}` emitted by the model.
- `<tool_response>` wraps the result fed back.

This is format only — not an editor. Nous ships no file-edit tool in the core `Hermes-Function-Calling` repo. In `hermes-agent` (the agent harness) there are "40+ tools" including file ops, but these are generic Python functions the harness exposes as tools, not an editor primitive. There is no publicly documented Nous "Claw" framework as of this guide's generation date; treat any prompt mentioning Claw as shorthand for Hermes-style XML-wrapped function calling.

**OpenAI Agents SDK (`openai-agents-python`).** Hosted tools (`FileSearchTool`, `CodeInterpreterTool`, `HostedMCPTool`, `ImageGenerationTool`, `WebSearchTool`, `ToolSearchTool`) plus local tools (`ComputerTool`, `ShellTool`, `ApplyPatchTool`). `ApplyPatchTool` is the canonical library primitive for V4A:

- Dataclass-shaped, with `needs_approval` (bool or predicate) and `on_approval` (callback) fields.
- Accepts an `ApplyPatchEditor` implementation — a protocol the user provides that performs the actual file mutations. Operations are `ApplyPatchOperation` variants (create/update/delete/move, matching V4A's `*** Add File`, `*** Update File`, `*** Delete File`, `*** Move to`).
- The SDK parses and validates V4A; the editor only handles the semantic ops.
- Approval is first-class: `ApplyPatchApprovalFunction = (ctx, op, patch_str) -> {approve: bool, reason?: str}`.

For a TypeScript Write spec, this is the cleanest reference model in the ecosystem: *the tool is the format validator + approval gate; the editor is the filesystem backend*. You can plug in a virtual FS, a git-backed FS, or a real disk FS without changing the tool.

**MCP filesystem server (`@modelcontextprotocol/servers/filesystem`).** The reference interoperability contract.

- `write_file(path, content)` — whole-file overwrite, no atomicity beyond fs.writeFile semantics, flagged in docs as dangerous.
- `edit_file(path, edits, dryRun?)` — the interesting one. `edits` is `Array<{oldText, newText}>`. Internals (from `src/filesystem/lib.ts`):
  - Sequential application in memory: `for (const edit of edits) { modifiedContent = apply(edit) }`.
  - Exact match first, then line-by-line with whitespace flexibility (trim-compare across potential ranges).
  - **Fail-fast before disk**: throws `"Could not find exact match for edit:..."` on miss; since mutation is in memory, nothing has been written yet.
  - Line-ending normalization on both inputs and file content.
  - Returns a **git-style unified diff** via `createTwoFilesPatch` from the `diff` npm library, with dynamic backtick-fencing to avoid markdown collisions.
  - `dryRun: true` returns the diff without writing.
  - Atomic write via temp file + rename to defeat symlink races.
- `create_directory`, `move_file`, `list_directory`, `read_text_file(head?, tail?)`, `search_files(pattern, excludePatterns)`.
- **Directory sandboxing**: "All filesystem operations are restricted to allowed directories," enforced via CLI flags at server start and optionally refined via the MCP Roots protocol.

For a TypeScript Write library targeting MCP interop, this defines both the schema and the behavior contract. Any deviation needs a reason.

### 8. Cross-ecosystem comparison

This table is the load-bearing deliverable. Entries are empirical (read the source), not marketing.

| System | Edit format | Read-before-edit | Multi-file atomicity | Stale-read detection | Repair loop | Good-model signal |
|--------|-------------|------------------|----------------------|----------------------|-------------|-------------------|
| **OpenHands `str_replace_editor`** | str_replace (Anthropic text editor schema) + create + insert + undo_edit | Enforced by exact-match + uniqueness | Per-file (`str_replace` uniqueness gate within file) | None beyond in-memory read cache | On miss returns "closest match" context; agent resamples | Claude family, GPT-4+ |
| **OpenHands `LLMBasedFileEditTool` (V0)** | LLM-regenerates line range | None | Per-file | None | None; high-variance | Any, but high cost |
| **SWE-agent `edit N:M` + lint** | Line-range replacement | Windowed viewer (model just read range) | Per-file | None — but windowed view freshness reduces risk | **Lint gate**: syntax-invalid edit rejected, original preserved, linter error returned | Generic; original benchmark used GPT-4 |
| **SWE-agent `edit_anthropic`** | str_replace (as OpenHands) | Exact-match | Per-file | None | Fuzzy miss message | Claude family |
| **Agentless** (no loop) | Three formats selectable: line-range, SEARCH/REPLACE, str_replace | Localization phase feeds exact file regions | N/A (single-patch output) | N/A | **Rejection sampling** (greedy + T=0.8 samples, up to `max_samples`); validation by tests | Strong models via diff; str_replace for Claude |
| **Devin (closed)** | Extracted as final git diff | Unknown | Unknown (probably shell-level) | Unknown | CI-driven self-repair | Proprietary |
| **AutoGPT `WriteFile`** | Whole-file overwrite | None | Per-file | None | None | Any |
| **BabyAGI** | No built-in | — | — | — | — | — |
| **CrewAI `FileWriterTool`** | Whole-file, `overwrite=False` default | None | None | None | None | Any |
| **LangChain `WriteFileTool`** | Whole-file | None | None | None (`root_dir` sandbox only) | None | Any |
| **LangGraph / deepagents `edit_file`** | String replacement (Claude Code-shaped) | Expected (Claude Code heritage) | Per-file | Virtual FS state bypasses disk staleness | Error-message driven | Claude, Claude-tuned |
| **Microsoft Autogen** | Shell via code executor | None | None | None | Loop-level (code executor returns stderr) | Any |
| **Hermes function calling (transport)** | N/A (format, not editor) | — | — | — | — | Hermes 3, Llama, Mistral |
| **OpenAI Agents SDK `ApplyPatchTool`** | V4A (via `ApplyPatchEditor` protocol) | Implicit (V4A context lines) | **Patch-level: all ops or none** via editor impl | Context-line match acts as staleness check | V4A returns structured parse errors | GPT-4.1+, GPT-5 |
| **MCP `edit_file`** | `{oldText, newText}[]` + dryRun | Implicit (exact-match or fuzzy line match) | **File-level: fail-fast in memory, atomic rename** | Line-ending normalization | Throws with `"Could not find exact match"` | Any; diff-capable models |
| **MCP `write_file`** | Whole-file overwrite | None | File-level (atomic rename) | None | None | Any |

Observations from this table:

- **Multi-file atomicity is unsolved upstream.** The best you get is MCP `edit_file`'s fail-fast-in-memory per file, or `ApplyPatchTool`'s all-ops-in-one-patch (but even that depends on the editor impl to be transactional across files, which none of the reference impls guarantee).
- **Read-before-edit is implicitly enforced by exact-string matching in every capable editor**, not by a protocol-level "you must have called Read first" gate (that's a Claude Code / OpenCode HITL feature). In autonomous mode, you get the same effect by making `old_str` uniqueness strict.
- **Repair loops are not uniform.** The two good examples are (a) Agentless's explicit resampling strategy and (b) SWE-agent's lint-gate-with-preserved-original. Everyone else returns an error and hopes the model re-plans.
- **`apply_patch` V4A is the cleanest cross-file primitive.** It's the only format that carries multiple files in a single payload with rename semantics built in. It's why OpenAI Agents SDK shipping `ApplyPatchTool` matters beyond Codex.

### 9. Design implications for the `@agent-sh/harness-*` Write spec

The following are load-bearing recommendations synthesized from the comparison:

1. **Ship V4A as the primary edit format.** Adopt the `ApplyPatchTool` / `ApplyPatchEditor` protocol split from OpenAI Agents SDK. The tool parses/validates; the editor is swappable (in-memory, git-backed, real disk). This is the only format that naturally expresses multi-file + rename + delete in one payload.
2. **Also expose a `str_replace` secondary tool.** Anthropic models are trained to emit this; forcing them through V4A is possible but regresses well-formedness. Match the OpenHands schema (view/create/str_replace/insert/undo_edit).
3. **Add an explicit read-ledger with sha + mtime**, queryable via a `ReadLedger` API. The default Write/Edit path checks `sha(file_on_disk) == sha(last_read_sha)` before applying, and returns a structured stale-read error with the new sha on mismatch. This is what prior art *does not ship*; it's a genuine improvement over "exact string match implies freshness."
4. **Make multi-file atomicity opt-in via `begin_edit` / `commit_edit` wrapper.** Inside the transaction, edits are staged in a write-through in-memory FS; commit is an atomic batch that either lands all files or none. Upstream systems don't do this; it's differentiating.
5. **Structure the repair loop.** On `old_str` miss, return the top-K fuzzy matches (~80% Levenshtein, Aider's threshold) with line numbers and a unified-diff preview of each candidate. The model will almost always pick the right one. SWE-agent does this loosely; no framework does it rigorously.
6. **Enforce lint-on-write like SWE-agent, but *configurable and off by default***. A user-provided `validate` hook that can reject the edit (preserving the original) before commit. TypeScript-first means `tsc --noEmit` is the obvious default for `.ts` files.
7. **Mirror MCP's `edit_file` semantics for the `edit` tool variant.** `{path, edits: [{oldText, newText}], dryRun}`, fail-fast in memory, atomic rename on write, git-style diff on return. This makes our Write library trivially wrappable as an MCP server.
8. **Ship approval callbacks as a first-class primitive**, matching `ApplyPatchOnApprovalFunction`'s shape: `(context, operation, patch) -> {approve, reason?}`. This is how HITL and autonomous modes share a codebase.

---

## Code Examples

### OpenAI Agents SDK — `ApplyPatchTool` with a custom editor

```python
from agents import ApplyPatchTool, Agent, Runner
from agents.apply_patch import ApplyPatchEditor, ApplyPatchOperation
from pathlib import Path

class DiskPatchEditor(ApplyPatchEditor):
    """Minimal editor: write operations to real disk."""

    def create_file(self, op: ApplyPatchOperation) -> None:
        Path(op.path).write_text(op.new_content)

    def update_file(self, op: ApplyPatchOperation) -> None:
        Path(op.path).write_text(op.new_content)

    def delete_file(self, op: ApplyPatchOperation) -> None:
        Path(op.path).unlink()

    # move_file, etc.

def on_approval(ctx, op, patch_str):
    # Auto-approve read-only dirs, gate everything else.
    if op.path.startswith("/workspace/safe/"):
        return {"approve": True}
    return {"approve": False, "reason": "path outside safe dir"}

agent = Agent(
    name="coder",
    tools=[ApplyPatchTool(
        editor=DiskPatchEditor(),
        needs_approval=True,
        on_approval=on_approval,
    )],
)
```

The model emits a V4A patch (`*** Begin Patch ... *** End Patch`). The SDK parses and calls `editor.update_file` / `create_file` / `delete_file` for each op, with an approval hook per operation.

### MCP filesystem — `edit_file` from a client

```typescript
// Client-side: request multiple edits atomically in-memory, fail-fast.
await mcp.callTool({
  name: "edit_file",
  arguments: {
    path: "/workspace/app.ts",
    edits: [
      { oldText: "const VERSION = \"1.0.0\"", newText: "const VERSION = \"1.1.0\"" },
      { oldText: "function legacyFormat(",    newText: "function formatV1_1("    },
    ],
    dryRun: true,   // preview first
  },
});
// Returns a git-style unified diff. If any edit fails to match, the whole call throws,
// no on-disk state changes. Drop `dryRun` to commit.
```

If `oldText` is not found exactly, MCP falls back to a whitespace-tolerant line-by-line comparison inside a plausible window. On any unresolved miss the entire call throws with a diagnostic naming the offending edit.

### OpenHands `str_replace_editor` — autonomous Edit call

```json
{
  "type": "function",
  "name": "str_replace_editor",
  "arguments": {
    "command": "str_replace",
    "path": "/workspace/src/auth.ts",
    "old_str": "    for (let i = 0; i <= tokens.length; i++) {",
    "new_str": "    for (let i = 0; i < tokens.length; i++) {",
    "security_risk": "low"
  }
}
```

On a unique match, the tool writes and returns success. On a multi-match or no-match, it returns a structured error the agent loop consumes and retries — typically by first issuing a `view` with `view_range` to narrow down the right occurrence.

### SWE-agent `edit N:M` with lint gate

```
edit 42:45
def charge(self, amount):
    if amount <= 0:
        raise ValueError("non-positive")
    return self._gateway.charge(amount)
end_of_edit
```

The tool replaces lines 42-45 inclusive. Before committing, it runs flake8 on the result. If syntax errors exist, the edit is rolled back and the agent sees `Your proposed edit has introduced new syntax error(s)...` — original file untouched. The agent typically reissues with the fix.

### Agentless — resampling against failed patches

```python
# Paraphrased from agentless/repair/repair.py
patches = []
if not args.skip_greedy:
    patches.append(sample(prompt, temperature=0))
for _ in range(args.max_samples - 1):
    patches.append(sample(prompt, temperature=0.8))

valid = [p for p in patches if can_parse(p) and applies_clean(p, repo)]
# Vote by test results; fall through to next candidate if none pass.
winner = vote_by_tests(valid)
```

The combination of a diff-format requirement + validation phase + voting dispenses with the agentic loop entirely for this class of bug-fix tasks.

### Microsoft Autogen — file write via code executor (the anti-pattern)

```python
# Agent emits a Python code block in chat:
# ```python
# with open("/workspace/app.py", "w") as f:
#     f.write("print('hello')\n")
# ```
from autogen_ext.code_executors.local import LocalCommandLineCodeExecutor
executor = LocalCommandLineCodeExecutor(work_dir="/workspace")
await executor.execute_code_blocks(code_blocks)
# The executor extracts the block, writes it to a temp .py, runs it.
# The side effect is the file write. No atomicity, no diff, no staleness check.
```

This works but defeats most of the safety features we care about. A V4A or `edit_file` equivalent on top of the executor is what a production autonomous coder on Autogen actually needs.

---

## Common Pitfalls

| Pitfall | Why It Happens | How to Avoid |
|---------|---------------|--------------|
| Using `LangChain WriteFileTool` / `CrewAI FileWriterTool` in an autonomous loop | Ships whole-file only, no read-before-write. Model invents content and clobbers files it never read. | Wrap with a read-before-write gate; prefer `edit_file` semantics (MCP filesystem or a V4A backend). |
| Autogen agent writing files via `os.remove` + `open("w")` in a code block | No atomicity; crash mid-write leaves partial files. | Execute writes through a structured tool (custom `@function_tool`), not raw Python in the executor. |
| SWE-agent `edit N:M` line numbers drift when model edits above the cursor | Line numbers are stale after the edit commits. | Always re-open/scroll to the new line range; use `goto` before `edit`. Modern SWE-agent configs prefer `edit_anthropic` (str_replace) for this reason. |
| Multi-file refactor half-applies because framework commits per file | No framework ships cross-file atomicity. One file's edit fails, previous ones already landed. | Use git-as-transaction: branch + auto-commit per successful file, revert to branch-point on failure. Or: collect all V4A ops into one `apply_patch` call. |
| `str_replace_editor` `str_replace` fails repeatedly on a file with CRLF line endings | Model's `old_str` comes from a Linux-normalized transcript; file has `\r\n`. | Prefer `edit_file` (MCP) or a harness that normalizes. OpenHands does not normalize EOL. |
| Agentless-style rejection sampling without validation | Many candidate patches parse but are wrong; voting without tests picks noise. | Always validate patches against a test suite (reproduction + regression). Voting is weak; tests are strong. |
| OpenHands `create` silently fails (refuses existing file) | `create` cannot overwrite by design. | Use `str_replace` for edits; `create` only for genuinely new paths. |
| Devin-style "diff-at-end-of-run" extraction loses intent | You see the final state but not the edit sequence, so repair on benchmark failure is lossy. | Prefer structured tool-call logs. `ApplyPatchTool` with logging per op is the reference. |
| `ApplyPatchTool` approval gate becomes a bottleneck in HITL mode | Every op prompts the user; long refactors become unusable. | Batch approvals at the patch level (single user decision for the whole `*** Begin Patch`), not per op. Use path-prefix auto-approval for safe directories. |
| Relying on exact-match as the only staleness guard | A file edited by a sibling process in between reads will produce a stale-but-matching `old_str` if the region you're editing happens to be unchanged — a silent correctness bug elsewhere. | Add a read-ledger (sha/mtime) layer on top of exact-match. Mismatch triggers "re-read before edit." |
| Claiming "Claw" as a distinct Nous Research framework | Not publicly documented. The name likely refers to Hermes-style XML-wrapped function calling or `hermes-agent`. | Ask for a specific artifact/URL. Default to "Hermes function calling" unless provided. |

---

## Best Practices

Synthesized from the 22 sources analyzed:

1. **Pick V4A as the canonical edit payload across files; pick `str_replace` as the per-file primitive.** These are the two formats every capable frontier model emits well, and the two protocols the major framework libraries already implement.
2. **Always split tool from editor.** The tool validates the format, gates approval, and drives the agent loop. The editor backend mutates state. This is the Agents SDK's `ApplyPatchTool` / `ApplyPatchEditor` split, and it's the right axis of variation.
3. **Enforce read-before-edit at *two* layers**. The exact-string match catches most cases; a sha-based read-ledger catches the residual "region happened to be unchanged" class. Neither alone is sufficient for autonomous mode.
4. **Make multi-file atomicity a harness primitive, not a model concern.** The model should emit N V4A ops; the harness should land them transactionally. No autonomous framework does this today; it's an obvious harness win.
5. **Return *structured* fuzzy diagnostics on miss.** Include top-K candidate matches with line numbers and context windows. The model's recovery rate on the second attempt is dramatically higher than on the first — but only if the error gives it enough signal.
6. **Lint-gate the write, configurably.** SWE-agent's flake8-on-save is the canonical pattern; for TypeScript, `tsc --noEmit` on the changed file is the analog. Keep it off by default for performance; on by default for benchmark-grade reliability.
7. **Build MCP compatibility in from day one.** The reference filesystem server's `write_file` / `edit_file` schemas are the portability layer. Any deviation should be conscious.
8. **Log per-operation, not per-call.** V4A patches can be 10+ ops; the log needs the same granularity for rollback and debugging. Mirror `ApplyPatchOnApprovalFunction`'s op-level shape.
9. **In autonomous mode, disable `undo_edit`.** It encourages the model to revert rather than diagnose. OpenHands keeps it largely for HITL/debug workflows.
10. **Expose `dryRun: true` on every mutation tool.** MCP's design is correct: the model should be able to cheaply preview a diff before committing. This is token-cheap insurance against a bad edit.
11. **Sandbox at the path level.** LangChain's `root_dir`, MCP's "allowed directories," Claude Code's permission globs — all converge on path-prefix allowlisting. It's the minimum bar.
12. **Treat autonomous Write differently from HITL Write in the docs and in the tool description.** The LLM sees the same tool; the invariants it needs to encode into its own prompts differ. OpenCode's "read before edit or this will fail" prompt is a good autonomous-mode template.

---

## Further Reading

| Resource | Type | Why Recommended |
|----------|------|-----------------|
| [OpenHands str_replace_editor source](https://github.com/All-Hands-AI/OpenHands/blob/main/openhands/agenthub/codeact_agent/tools/str_replace_editor.py) | Source code | The reference open-source implementation of the Anthropic text-editor schema for autonomous agents |
| [OpenHands function_calling.py](https://github.com/All-Hands-AI/OpenHands/blob/main/openhands/agenthub/codeact_agent/function_calling.py) | Source code | Shows both the deprecated `LLMBasedFileEditTool` and the current `str_replace_editor_tool` registration |
| [OpenHands / OpenDevin paper (ICLR 2025)](https://arxiv.org/abs/2407.16741) | Paper | Canonical writeup of CodeActAgent and the executable-code-action design |
| [SWE-agent paper](https://arxiv.org/abs/2405.15793) | Paper | The Agent-Computer Interface thesis; `edit N:M` + lint gate; 12.5% on SWE-bench |
| [SWE-agent docs: ACI](https://swe-agent.com/latest/background/aci/) | Docs | Windowed viewer, lint-on-save, search tool, `submit` command |
| [SWE-agent windowed_edit_linting config](https://github.com/SWE-agent/SWE-agent/blob/main/tools/windowed_edit_linting/config.yaml) | Source | The exact `edit <start>:<end>` command spec |
| [CodeAct paper](https://arxiv.org/abs/2402.01030) | Paper | Argues Python code actions beat JSON tool calls; OpenHands CodeActAgent's conceptual basis |
| [Agentless paper](https://arxiv.org/abs/2407.01489) | Paper | No-loop SWE-bench approach: localization + repair sampling + validation, 32% on Lite at $0.70 |
| [Agentless repair source](https://github.com/OpenAutoCoder/Agentless/blob/main/agentless/repair/repair.py) | Source | Three edit formats (line-range / SEARCH-REPLACE / str_replace) and rejection sampling loop |
| [Devin SWE-bench technical report](https://www.cognition.ai/blog/swe-bench-technical-report) | Blog | Public details of Devin's sandbox + diff-extraction evaluation model |
| [OpenAI Agents SDK tools overview](https://openai.github.io/openai-agents-python/tools/) | Docs | Canonical list: WebSearchTool, FileSearchTool, CodeInterpreterTool, HostedMCPTool, ApplyPatchTool, ShellTool |
| [OpenAI Agents SDK tool.py](https://github.com/openai/openai-agents-python/blob/main/src/agents/tool.py) | Source | `ApplyPatchTool` dataclass + `ApplyPatchApprovalFunction` / `ApplyPatchOnApprovalFunction` types |
| [OpenAI apply_patch V4A guide](https://developers.openai.com/api/docs/guides/tools-apply-patch) | Docs | V4A format specification (referenced; covered in more depth in the prior guide) |
| [GPT-5 freeform function calling cookbook](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_new_params_and_tools) | Cookbook | Freeform tool type context — relevant because a V4A payload can be modeled as a freeform custom tool |
| [MCP filesystem server README](https://github.com/modelcontextprotocol/servers/blob/main/src/filesystem/README.md) | Docs | `write_file`, `edit_file`, `read_text_file`, sandboxing via allowed directories |
| [MCP filesystem server index.ts](https://github.com/modelcontextprotocol/servers/blob/main/src/filesystem/index.ts) | Source | Tool registration and entry points |
| [MCP filesystem lib.ts `applyFileEdits`](https://github.com/modelcontextprotocol/servers/blob/main/src/filesystem/lib.ts) | Source | The sequential-in-memory-apply + atomic-rename + unified-diff pattern that's the de facto contract |
| [Hermes Function Calling repo](https://github.com/NousResearch/Hermes-Function-Calling) | Source | ChatML + `<tool_call>` / `<tool_response>` / `<tools>` XML wrapping a JSON function call |
| [Nous Research hermes-agent](https://github.com/NousResearch/hermes-agent) | Source | Provider-agnostic agent harness with ~40 tools built on Hermes function calling |
| [LangChain FileManagementToolkit](https://docs.langchain.com/oss/python/integrations/providers/overview) | Docs | WriteFileTool / ReadFileTool / etc. — whole-file only, `root_dir` sandbox |
| [LangChain deepagents](https://github.com/langchain-ai/deepagents) | Source | Claude-Code-inspired open-source agent with `edit_file` string-replacement tool |
| [CrewAI FileWriterTool source](https://github.com/crewAIInc/crewAI-tools/blob/main/crewai_tools/tools/file_writer_tool/file_writer_tool.py) | Source | Whole-file writer with `overwrite=False` default; no edit tool |
| [Microsoft Autogen FileSurfer](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/magentic-one.html) | Docs | Read-only file navigation agent; file writes delegated to code executors |

---

*This guide was synthesized from 22 sources. See `resources/agent-write-across-ecosystems-sources.json` for full source metadata and per-source confidence scores. It intentionally does not re-cover material in `agent-write-edit-tools.md` (Claude Code, Codex CLI, Aider, Cline, OpenCode, Continue).*
