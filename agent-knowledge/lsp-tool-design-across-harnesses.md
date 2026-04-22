# Learning Guide: LSP / Code-Intelligence Tool Design Across AI Agent Harnesses

**Generated**: 2026-04-20
**Sources**: 22 resources analyzed
**Depth**: medium
**Scope**: The design space of the LSP / code-intelligence tool across every major harness, library, and MCP server that has attempted one. Not a ship-list (see `harness-tool-surface-audit.md` §"LSP / code intelligence"). This guide is the **design-choice deep dive**: for each harness, what choice was made on each of twelve dimensions, what the trade-off was, and what it implies for a TypeScript tool library (`@agent-sh/harness-*`) targeting **autonomous** agents.

## What this guide is (and isn't)

- **Is**: a cross-harness matrix on **twelve design dimensions** (tool surface, operations, server management, language detection, readiness, position encoding, cross-file reads, sync model, workspace scope, error shape, performance/cold-start, output shape).
- **Is**: an architectural comparison of the three distinct schools — **LSP-native**, **tree-sitter-static**, and **index-and-rank** — each of which answers "give the model code intelligence" differently.
- **Is**: a synthesis of what the research and practitioner commentary says matters to an **autonomous LLM**, as opposed to an IDE-bound LSP consumer.
- **Isn't**: an LSP spec tutorial. The full spec lives at [microsoft.github.io/language-server-protocol](https://microsoft.github.io/language-server-protocol/). We cover the bits a tool-library implementer must care about.
- **Isn't**: a recommendation for a harness to own language-server processes. It's a recommendation for a **library** that exposes an LSP primitive that harnesses embed.

The consumer of the tool we're designing is a real LLM, running in **autonomous** mode — no human approval prompts, no IDE to fall back on, and the model must survive cold-start, indexing latency, and empty results without giving up.

## Prerequisites

- Familiarity with `agent-knowledge/harness-tool-surface-audit.md` §"LSP / code intelligence" (the "what ships" matrix — Claude Code `LSP`, OpenCode `lsp` experimental; nobody else).
- Familiarity with `agent-knowledge/exec-tool-design-across-harnesses.md` — the adapter-interface / hook-first / discriminated-result patterns we landed on for Bash. The same patterns apply here.
- Familiarity with `agent-knowledge/webfetch-tool-design-across-harnesses.md` — pluggable-engine pattern and the "fetch is a specialized case of 'run something in a subprocess'" argument.
- Conceptual grasp of LSP itself: JSON-RPC 2.0 over stdio, client-initiated `initialize` handshake, server pushes `textDocument/publishDiagnostics`, positions are **zero-based line + zero-based UTF-16 character offset** (by default, negotiable to UTF-8/UTF-32).
- Why this matters: code intelligence is the **single highest-leverage unshipped tool** across the ecosystem (per our own surface audit). Only Claude Code ships it as a first-class tool; only OpenCode ships an experimental clone. Everyone else either shells out to `grep` + tree-sitter-in-the-shell or gives up. For an autonomous agent doing refactoring, this is the gap that matters most.

## TL;DR — the twelve decisions, compressed

1. **Tool surface**: **one tool with an `operation` discriminator** wins. Claude Code `LSP`, OpenCode `lsp`, Serena (MCP), and mcp-language-server converge on this. Multilspy's per-operation methods work for a library, not a tool surface; the enum is better for a model. Nine operations max — fewer is better.
2. **Operations exposed**: the universally-shipped set is **{hover, definition, references, documentSymbol, workspaceSymbol, implementation, diagnostics}** plus optionally {rename, callHierarchy}. Diagnostics is the load-bearing one for autonomous agents — it's the only tool that *closes the feedback loop* on "did my edit break anything."
3. **Language-server management**: three postures exist — **plugin-delivered** (Claude Code: plugins ship `.lsp.json` manifests, user installs binaries separately), **bundled registry with auto-download** (OpenCode: per-language `spawn()` including `gem install` / `go install` fallback), and **user-wired** (mcp-language-server, lsp-mcp: user declares the LSP command in config). For a library, **declarative registry + user-wired binary + plugin-delivered defaults** is the Claude Code shape.
4. **Language detection**: **file-extension map, one per request** is universal. Claude Code's manifest has `extensionToLanguage`; OpenCode has `language.ts` with a 60+ entry `.ts → typescript` table. Nobody does shebang detection; nobody asks the model for a language hint at tool time.
5. **Server readiness**: **lazy-start on first operation + block up to a timeout** is the converged answer. Claude Code starts servers when the plugin is active and the file is opened; OpenCode's `lsp.touchFile` pattern primes the server per call. Rust-analyzer's 30s cold index is a real UX problem — the right move is a separate status/warmup affordance, not a tool-level block.
6. **Position encoding**: LSP spec is **0-indexed line + 0-indexed UTF-16 offset**. No local LLM reasons correctly in those units. Every tool library that has shipped this converts on the boundary — **1-indexed line + 1-indexed UTF-8/codepoint character** is what the model sees. OpenCode, Serena, and Claude Code all make this conversion invisible to the model.
7. **Cross-file reads**: LSP operations return URIs + ranges; the tool **resolves them to a flattened `path:line:text` format** for the model, **not raw LSP JSON**. References with 10K hits need pagination; the grep-like format makes this obvious. mcp-language-server inlines source snippets with the reference; OpenCode returns JSON (a miss — the model then has to Read each file).
8. **Incremental sync**: agents are **mostly read-only**. OpenCode's client does real `textDocument/didOpen` + `didChange` + version tracking, because edits are coming from the same process. For an autonomous tool library, **sync-on-read + no-edit-push** is the minimum; edits happen via Write/Edit and a `PostToolUse` hook re-syncs. Push-every-edit is a correctness win, but only if the tool library owns the Edit tool too.
9. **Workspace integration**: same fence as Read/Write/Grep — workspace root + additional directories. `workspace_folder` in the LSP init; `rootUri` in the tool's scope; respect the same permission hook.
10. **Error surface**: the ecosystem converges on four recoverable error classes — **server_not_available** (no plugin installed), **server_starting** (indexing), **position_out_of_range** (stale file), **no_results** (not an error, but needs a human-readable "no X found" message, per SWE-agent's "Your command ran successfully and did not produce any output"). Plus the `suggest` affordance — "try a different position," "this file isn't in the project's source roots."
11. **Performance / cold-start**: rust-analyzer needs ~30s to index a medium project; TypeScript's tsserver ~5s; Python pyright ~2s. Claude Code's answer: **start servers at session start, not on first tool call**. OpenCode's answer: lazy-start with `touchFile`. The autonomous-agent pattern is **pre-warm at session start, fall through to "server_starting" error with retry hint** on cold call. Never block indefinitely.
12. **Output shape**: **discriminated union** — `{kind: "ok" | "no_results" | "server_not_available" | "server_starting" | "position_invalid" | "timeout" | "error"}`. Inside `ok`, a per-operation shape (hover → markdown; references → flattened `path:line:text` list; symbols → a tree). Raw LSP JSON is a trap for the model: `Hover.contents` has three legal shapes (string, MarkupContent, or a MarkedString[] array), and models confuse them.

**Headline for the autonomous-agent case:** ship **one `LSP` tool** with `{operation, path, line, character}` schema, discriminated-union results, **hook-gated server startup**, per-language registry delivered via the adapter pattern (`LspClient` interface), **flattened grep-like output for references/symbols, markdown for hover**, **post-edit diagnostics piggy-backed via a hook** (not the tool), and explicit cold-start handling with `server_starting` + retry. This is the Claude Code + OpenCode + Serena overlap; depart from it only for typed-safety improvements.

## Core Concepts

### 1. The three schools of code intelligence

The ecosystem has converged on three distinct architectures. Picking the right one is the meta-decision before any of the twelve sub-decisions matter.

| School | Examples | What it gives the model | What it costs |
|---|---|---|---|
| **LSP-native** | Claude Code `LSP`, OpenCode `lsp` (exp), Serena, mcp-language-server, lsp-mcp, multilspy | Ground-truth type info, live diagnostics, rename with correctness guarantees, implementations of interfaces | Per-language server process (30s cold-start, 100MB-2GB RAM), PATH or plugin install of server binaries, complex lifecycle (initialize, didOpen, shutdown), version-sensitive behavior |
| **Tree-sitter-static** | Aider (repo-map), Cline (`list_code_definition_names`), SWE-agent (none ships; tree-sitter is a possible addition) | Instant symbol enumeration, zero runtime deps beyond grammar bundles, works on any file that parses | No types, no rename, no cross-file reference resolution — only what the AST encodes syntactically |
| **Index-and-rank** | Aider (PageRank on file-dependency graph), Cursor (Semantic Search on a proprietary index), OpenAI FileSearch (vector store), Continue (codebase indexing) | Probabilistic relevance — "which files matter" — plus embedding-based semantic recall | No guarantees of correctness; "semantic" is a proxy for "nearby in embedding space," not for "actually referenced"; requires an indexing pipeline the tool library doesn't own |

**These are not competitive; they are complementary.** The Claude Code + Aider combo is the common practice: LSP for precise questions ("where is this defined"), tree-sitter or a repo-map for broad orientation ("what's in this codebase"). Cursor picks index-and-rank instead of raw LSP because their IDE already has LSP built in — the agent sees the *distilled* result, not the raw operation.

**Design takeaway for a tool library**: LSP-native is the only school that gives the agent a **ground-truth** answer. Tree-sitter and index-and-rank are decorators, not replacements. Ship LSP-native first; make tree-sitter a fallback for languages with no server.

### 2. The Claude Code `LSP` tool — the closed-harness reference

Claude Code ships **one** tool named `LSP`. Its description, verbatim from `tools-reference.md`:

> Code intelligence via language servers: jump to definitions, find references, report type errors and warnings. See [LSP tool behavior](#lsp-tool-behavior)

The tool-behavior docs elaborate:

> The LSP tool gives Claude code intelligence from a running language server. After each file edit, it automatically reports type errors and warnings so Claude can fix issues without a separate build step. Claude can also call it directly to navigate code:
> - Jump to a symbol's definition
> - Find all references to a symbol
> - Get type information at a position
> - List symbols in a file or workspace
> - Find implementations of an interface
> - Trace call hierarchies
> The tool is inactive until you install a code intelligence plugin for your language.

**The plugin-delivered model**: the tool itself is a thin dispatcher. Each supported language is a *plugin* with a `.lsp.json` manifest. The manifest fields:

| Field | Required | Meaning |
|---|---|---|
| `command` | yes | The LSP binary (must be in PATH) |
| `extensionToLanguage` | yes | Map `.ext → languageId` |
| `args` | no | CLI args |
| `transport` | no | `stdio` (default) or `socket` |
| `env` | no | Env vars |
| `initializationOptions` | no | LSP init-time options |
| `settings` | no | `workspace/didChangeConfiguration` settings |
| `workspaceFolder` | no | Workspace folder path |
| `startupTimeout` | no | Max startup wait (ms) |
| `shutdownTimeout` | no | Max graceful-shutdown wait (ms) |
| `restartOnCrash` | no | Auto-restart flag |
| `maxRestarts` | no | Crash-restart cap |

A minimal example:

```json
{
  "go": {
    "command": "gopls",
    "args": ["serve"],
    "extensionToLanguage": { ".go": "go" }
  }
}
```

The official Anthropic marketplace ships 11 code-intelligence plugins (2026): `clangd-lsp`, `csharp-lsp`, `gopls-lsp`, `jdtls-lsp`, `kotlin-lsp`, `lua-lsp`, `php-lsp`, `pyright-lsp`, `rust-analyzer-lsp`, `swift-lsp`, `typescript-lsp`. Each is a thin manifest plus a pointer to the expected binary.

**What the model gains** (per the docs, two capabilities bundled):

1. **Automatic diagnostics after every edit** — the harness, not the model, calls the server; type errors come back as a tool-result addendum to the previous Edit. No extra tool call; no compiler invocation; no linter configuration. This is the *highest-value behavior* in the whole tool and it's not exposed as an operation — it's a hook.
2. **Code navigation operations** — the model calls `LSP` with an operation + position and gets structured navigation.

**Design takeaways**:
- The `LSP` *tool* has only a few operations; the **diagnostics loop is a behavior, not a tool call**. The autonomous equivalent for us is a `PostToolUse` hook on `Write`/`Edit` that calls the LSP engine for diagnostics and appends them to the next tool result.
- The plugin-delivered model solves server discovery: the plugin bundles the manifest; the user installs the binary. The manifest schema is a spec for how to describe an LSP server. We can adopt that schema almost wholesale.
- `restartOnCrash` + `maxRestarts` + `startupTimeout` + `shutdownTimeout` is the full lifecycle. Claude Code doesn't expose these to the model; they're server-config knobs the harness owner tunes once.

### 3. The OpenCode `lsp` tool — the open TypeScript reference

OpenCode's experimental `lsp` tool (gated by `OPENCODE_EXPERIMENTAL_LSP_TOOL=true`) is the cleanest open-source TypeScript-side reference. From `packages/opencode/src/tool/lsp.ts`, the schema:

```ts
parameters: z.object({
  operation: z.enum(operations).describe("The LSP operation to perform"),
  filePath: z.string().describe("The absolute or relative path to the file"),
  line: z.number().int().min(1).describe("The line number (1-based, as shown in editors)"),
  character: z.number().int().min(1).describe("The character offset (1-based, as shown in editors)"),
})
```

Where `operations` is:

```ts
const operations = [
  "goToDefinition",
  "findReferences",
  "hover",
  "documentSymbol",
  "workspaceSymbol",
  "goToImplementation",
  "prepareCallHierarchy",
  "incomingCalls",
  "outgoingCalls",
] as const
```

Nine operations; no rename, no diagnostics-on-demand (diagnostics come from the sync loop), no code actions.

**Execution shape** (from the same file):

```ts
// guards
yield* assertExternalDirectoryEffect(file)
yield* ctx.ask({ permission: "lsp", patterns: ["*"], always: ["*"] })

// lifecycle
if (!yield* lsp.hasClients(file)) throw new Error("No LSP server available for this file type.")
yield* lsp.touchFile(file, true)

// operation
const result = yield* lsp.operation(args)

// result shape
return {
  title: `${args.operation} ${relPath}:${args.line}:${args.character}`,
  metadata: { result },
  output: result.length === 0
    ? `No results found for ${args.operation}`
    : JSON.stringify(result, null, 2)
}
```

**Key design choices**:

- **1-indexed line and character** — the model sees editor-style positions, not LSP spec positions. The conversion to `{line: L-1, character: C-1}` is internal.
- **Two-layer guard** — `assertExternalDirectoryEffect` enforces the workspace fence (same as Read/Write), then `ctx.ask({permission: "lsp"})` through the permission subsystem. These are composed, not bypassed.
- **`hasClients` check before `touchFile`** — fail-fast with an explicit error message ("No LSP server available for this file type") instead of opaque JSON-RPC timeouts.
- **Empty-result message** — `"No results found for ${operation}"` rather than empty JSON. Models handle human-language better than empty arrays.
- **`JSON.stringify(result, null, 2)` output for non-empty** — this is **a miss**. Raw LSP JSON for references is an array of `{uri, range: {start: {line, character}, end: {line, character}}}` — the model has to parse nested ranges, re-resolve URIs to paths, and re-read files for context. The grep-like format is strictly better.

**Language-server registry** (from `packages/opencode/src/lsp/server.ts`):

Each supported language exports an `Info` interface with `id`, `extensions`, `root` (project-root finder), and `spawn()` (async launcher). Shipped registrations include TypeScript (via `typescript-language-server`), Vue (`@vue/language-server`), Svelte, Astro, ESLint (auto-downloads from GitHub), Pyright (detects venvs at `.venv` / `venv` / `VIRTUAL_ENV`), Ty (experimental Python), Rust (`rust-analyzer`), Go (`gopls`, auto-installs via `go install` if absent), C/C++ (`clangd`, auto-download), Java (JDTLS, Java 21+ required, auto-downloads Eclipse), Kotlin (JetBrains CDN), Clojure, Deno, Ruby, PHP Intelephense, Elixir, Zig, C#, F#, Swift, Bash, Terraform, LaTeX, Docker, Gleam, Nix, Typst, Haskell, Julia, YAML, Lua, Biome, Oxlint.

**The auto-download philosophy** is aggressive — if the binary isn't in PATH, try `go install`, `gem install`, `dotnet tool install`, GitHub releases. For a library, this is **too much**. The Claude Code plugin split (manifest + user-installed binary) is the cleaner boundary.

**LSP client internals** (from `packages/opencode/src/lsp/client.ts`):

- Sends `initialize` with `rootUri`, `processId`, `workspaceFolders`, capabilities; awaits `initialized`.
- Tracks open files in a `Map<path, version>`.
- Sends `textDocument/didOpen` on first touch; `textDocument/didChange` with version bump on subsequent modifications.
- Sends `workspace/didChangeConfiguration` to push settings; `workspace/didChangeWatchedFiles` for filesystem events.
- Receives `textDocument/publishDiagnostics`, debounced 150ms (to coalesce the syntax→semantic batches most servers emit).
- 45s initialization timeout, hard.
- `shutdown()` ends the connection, disposes resources, kills the server process.

**Design takeaways**:
- OpenCode ships a full LSP client in ~300 LOC of TypeScript. It's feasible for a library.
- The 150ms diagnostic debounce is a real insight — **most LSPs emit diagnostics in two waves** (syntax-only first, then semantic). Coalescing them avoids doubled tool-result pressure.
- Version tracking is load-bearing — LSP servers reject stale edits. If our tool library doesn't own Edit, the harness has to hook Edit completion and inform us of the new version. This is a library-harness contract we must spec.

### 4. Serena — the semantic-symbol abstraction layer

[Serena](https://github.com/oraios/serena) is an MCP server that wraps multiple LSPs (and optionally a JetBrains backend) with a *semantically-higher-level* tool surface:

| Category | Tool | LSP | JetBrains |
|---|---|---|---|
| Retrieval | `find_symbol` | ✓ | ✓ |
| Retrieval | `symbol_overview` | ✓ | ✓ |
| Retrieval | `find_referencing_symbols` | ✓ | ✓ |
| Retrieval | `type_hierarchy`, `find_declaration`, `find_implementations` | — | ✓ |
| Refactoring | `rename` (symbols only, or files+dirs) | ✓ | ✓ |
| Refactoring | `move`, `inline`, `propagate_deletions`, `safe_delete` | — | ✓ (some ✓ LSP) |
| Symbolic editing | `replace_symbol_body` | ✓ | ✓ |
| Symbolic editing | `insert_after_symbol`, `insert_before_symbol` | ✓ | ✓ |
| Utility | `search_for_pattern`, `replace_content`, `list_dir`, `read_file`, `execute_shell_command` | n/a | n/a |

**The semantic argument** (quoted from Serena's design docs):

> Symbolic editing tools are less error-prone and much more token-efficient than typical alternatives. A single "rename symbol" call replaces what would otherwise demand 8–12 careful, error-prone steps.

**Why this is a distinct school**:
- The tools are **symbol-level**, not position-level. `find_symbol("MyClass.myMethod")` is the input, not `{line: 42, character: 8}`.
- Symbols are names, which models generate well. Positions are integers, which models generate poorly.
- For edits, `replace_symbol_body("Foo.bar", "<new body>")` is atomic on a symbol boundary — the tool parses the boundary via LSP's `documentSymbol`, not via the model's string-matching.

**Design takeaways**:
- If we ship anything beyond vanilla LSP ops, **symbol-first tools** (`find_symbol(name)`, `replace_symbol_body(name, newBody)`) are the direction with the strongest prior art.
- These are implementable on top of a thin LSP client: `find_symbol` = `workspace/symbol` + best-match; `replace_symbol_body` = `documentSymbol` → find matching symbol → use its `selectionRange` → apply a `WorkspaceEdit`.
- This would also solve the position-encoding headache for the model entirely. The model never sees positions; it sees names.

### 5. mcp-language-server — the "thinnest possible MCP wrapper" reference

[isaacphi/mcp-language-server](https://github.com/isaacphi/mcp-language-server) exposes six tools:

- `definition` — full source code of a symbol by name
- `references` — all callers across codebase
- `diagnostics` — per-file
- `hover` — docs + type hints at a location
- `rename_symbol` — project-wide rename
- `edit_file` — multi-edit by line numbers

**Key choices**:
- **Configuration**: the user provides the LSP command in Claude Desktop's `claude_desktop_config.json`. Command-line args after `--` pass through.
- **Transport**: stdio only. "The language server must communicate over stdio."
- **One workspace per server instance**: `--workspace [path]` at launch.
- **Arguments after `--`**: pass directly to the LSP. This is the POSIX convention and it works — no config schema bloat.

**The `definition` tool returns source code, not a location**. This is a subtle but important call — the model gets the actual function body, not a `file:line` pair to Read. It trades tokens (full source) for round-trips (one tool call instead of two).

**Design takeaway**: user-wired binary + thin wrapper + source-inlining on definitions is the minimalist architecture. It's what a library should be able to *support*, but not what a library should be *limited to*.

### 6. lsp-mcp — the schema-generating approach

[jonrad/lsp-mcp](https://github.com/jonrad/lsp-mcp) is interesting because it **dynamically generates the MCP tool surface from the LSP JSON Schema**. Instead of hand-coding `definition` / `references` / `hover`, it reflects the LSP's advertised capabilities into MCP tools.

- Zod-validated config.
- Multiple LSPs can run simultaneously.
- Lazy initialization — servers start on-demand per query.
- Async-first, Node.js implementation.
- Dynamic capability generation from JSON schemas rather than static definitions.

**Design takeaway**: the fully-dynamic approach is elegant but **wrong for LLMs**. Models perform better on a small, stable, human-curated tool surface than on a reflected N-tool surface where every op's schema might drift. The hand-curated operation enum (Claude Code, OpenCode, Serena, mcp-language-server) is the better pattern.

### 7. Multilspy — the library-shape reference (not tool-shape)

[microsoft/multilspy](https://github.com/microsoft/multilspy) is the library prior art. It exposes **per-operation Python methods**, not a unified tool:

```python
from multilspy import SyncLanguageServer
lsp = SyncLanguageServer.create(config, logger, "/abs/path/to/project/root/")
with lsp.start_server():
    result = lsp.request_definition("relative/path/to/code_file.java", 163, 4)
```

Methods: `request_definition`, `request_references`, `request_completions`, `request_hover`, `request_document_symbols`.

**Supported languages** (11): Java (Eclipse JDTLS), Python (jedi-language-server), Rust (rust-analyzer), C# (OmniSharp/RazorSharp), TypeScript, JavaScript (typescript-language-server), Go (gopls), Dart, Ruby (Solargraph), Kotlin, PHP (Intelephense).

Multilspy powers the NeurIPS 2023 **Monitor-Guided Decoding** paper (monitors4codegen). Core finding:

> MGD can improve the compilation rate of code generated by LMs at all scales (350M-175B) by 19-25%, without any training/fine-tuning required.

The monitors implemented via LSP:
- Dereference validation
- Function argument count verification
- Typestate method sequencing
- Enum constant generation
- Class instantiation constraints

**Design takeaways**:
- Multilspy's **library** shape (per-operation methods) is correct for *programmatic* consumers.
- It's the **wrong shape** for a tool surface — the model needs one discoverable tool, not five tool names it has to learn. Convert to a discriminated-union surface at the tool layer.
- The 19-25% compilation-rate lift is the single strongest quantitative argument that this tool category actually moves the needle.

### 8. Aider — the tree-sitter / PageRank counter-example

Aider doesn't ship an LSP tool because **Aider doesn't ship tools at all** (it uses text-based edit formats instead of function calling; see `agent-knowledge/ai-agent-harness-tooling.md`). But its repo-map is the closest any harness comes to a "semantic index" and it's worth understanding what it does *instead of* LSP.

From Aider's repo-map docs:

> Aider solves this problem by sending just the most relevant portions of the repo map. It does this by analyzing the full repo map using a graph ranking algorithm, computed on a graph where each source file is a node and edges connect files which have dependencies.

Architecture:
- **Tree-sitter grammars** (via `py-tree-sitter-languages`) extract symbols (classes, functions, methods) from each source file.
- **Graph ranking** (PageRank) ranks files by how central they are in the dependency graph.
- **Token-budget controlled** via `--map-tokens` (default 1K tokens). Map is included in the LLM's context, not called as a tool.
- **Format**: file path + `⋮...` elisions + `│` prefix on kept lines:

```
aider/coders/base_coder.py:
│class Coder:
│    @classmethod
│    def create(self, main_model, edit_format, io, ...)
│    def run(self, with_message=None):
```

**Supported languages**: 17+ via tree-sitter grammar files. No runtime deps beyond a pip-installable binary wheel.

**Comparison to LSP**:

| Dimension | Aider's tree-sitter repo-map | LSP-native |
|---|---|---|
| Coverage | Symbol names + signatures | Symbols + types + refs + diagnostics + rename |
| Speed | Instant (sub-second on 1M LOC) | Cold-start 2-30s, warm ms |
| Cost | ~1K tokens always in context | 0 tokens context, tool call per operation |
| Cross-file | Dependency graph (approximate) | Authoritative reference index |
| Types | None | Full |
| Refactoring | None | Rename, code actions |
| Language support | 17 via tree-sitter | 100+ via LSP ecosystem |
| Indexer maintenance | Grammar updates (rare) | Per-language server process |

**Design takeaway**: tree-sitter is the *orientation* tool (where should I look); LSP is the *precision* tool (answer a specific question). They're complementary. Aider's insight — **the map is in context, not in a tool** — is relevant for *our* choice of what goes in the system prompt vs. what's a tool. Symbol-level grounding that the model needs often is probably context; symbol-level questions the model asks occasionally is definitely a tool.

### 9. Cline / Roo Code — `list_code_definition_names`

Cline ships `list_code_definition_names` (Roo inherits it), which is **tree-sitter, not LSP**. From `src/services/tree-sitter/index.ts`:

- Supported extensions: `js jsx ts tsx py rs go c h cpp hpp cs rb java php swift kt` (17 languages).
- Max 50 files per directory call.
- Three phases: parse → query (captures definitions only, filtering by `name.includes("name")`) → format.
- Output format:
  ```
  |----
  │[definition line 1]
  │[definition line 2]
  |----
  ```
- Per-language `tags.scm` query file modified from the canonical tree-sitter tag grammars.

**This is the same architecture Aider uses**, minus the PageRank. It's tree-sitter-static, single-directory scope.

**Design takeaway**: `list_code_definition_names` is a useful *navigation* primitive that's cheaper than LSP (no server, no init latency) but strictly weaker. If we ship LSP, we might *also* ship a tree-sitter `list_symbols_in_dir` for languages we have no LSP for — it's complementary.

### 10. Cursor — the proprietary semantic index

Cursor's agent has **no LSP tool** exposed. The IDE owns LSP internally; the agent gets a **semantic search** tool:

> Perform semantic searches within your indexed codebase. Finds code by meaning, not just exact matches.

Plus `Search Files and Folders`, `Read Files`, `Edit Files`. No `go_to_definition`; no `find_references`.

**Why**: Cursor is an editor; the IDE is always running, LSP is always attached, and the agent can lean on the surrounding editor context (open file, cursor position, recent diagnostics) implicitly. The agent layer is narrower than the IDE layer.

**Design takeaway**: if your harness is *embedded in* an IDE, you probably don't need an LSP tool — the IDE already has LSP. If your harness is *autonomous*, you need the LSP tool because there's no ambient IDE state. Our library targets autonomous agents; LSP-as-a-tool is the right call.

### 11. OpenAI Agents SDK — FileSearchTool is not LSP

The OpenAI Agents SDK's `FileSearchTool` is often misread as a code-nav primitive. It isn't:

- `FileSearchTool` retrieves from **OpenAI Vector Stores** using semantic search with optional filtering and ranking.
- It's a **retrieval** tool (finds documents), not an **analysis** tool (understands code structure).
- No LSP, no tree-sitter, no symbol resolution.

The SDK has no dedicated code-intelligence or LSP tool. The closest workaround is **HostedMCPTool** — "exposes a remote MCP server's tools to the model" — which lets users plug in mcp-language-server or Serena externally.

**Design takeaway**: the OpenAI Agents SDK delegates code intelligence to MCP. That's a strong signal that MCP-over-LSP is the industry's distribution channel for this capability. We should ship ours as a native tool *and* as an MCP server.

### 12. Codex / Gemini CLI / SWE-agent / OpenHands — no LSP tool

All four are notable for **not having** an LSP tool:

- **Codex CLI**: 6 tools total (`shell`, `apply_patch`, `update_plan`, `view_image`, `write_stdout`, `web_search`). Code nav routes through `shell` + `rg`.
- **Gemini CLI**: ~20 tools including three grep variants; no LSP. Primary TS codebase (98%) has no `lsp.ts`.
- **SWE-agent**: ACI consists of `open`/`goto`/`scroll_up`/`scroll_down`/`search_dir`/`search_file`/`find_file`/`edit`. No semantic nav. This is a deliberate ACI choice — the agent is *given* file excerpts in 100-line windows and expected to reason from text.
- **OpenHands CodeActAgent**: Python-as-action + shell; no LSP. The `jupyter` kernel makes runtime type introspection possible but not LSP queries.

**Design takeaway**: the ecosystem's gap here is real. Only Claude Code (closed, paid, Anthropic-hosted) and OpenCode (experimental flag) ship LSP. For an open TypeScript library, this is a **differentiation opportunity**, not a catch-up game.

### 13. LangChain / CrewAI / Pydantic-AI — no LSP in the toolkit catalogs

Checking each:
- **LangChain**: no `LspTool` in the community toolkit. `FileManagementToolkit` has 7 tools; none touches LSP. Users compose a custom tool if they want it.
- **CrewAI**: 40+ integration catalog; no code-intelligence or LSP entry.
- **Pydantic-AI**: web_fetch, duckduckgo, tavily, exa — no LSP.

**Design takeaway**: LSP hasn't been productized at the framework layer. Every framework assumes the user wires this themselves via MCP or a custom tool. This validates our "ship it as a library and expose via MCP" plan.

## The 12-dimension matrix across harnesses / LSP solutions

Compressed; cells are design choices, not capability-presence.

| # | Dimension | Claude Code `LSP` | OpenCode `lsp` (exp) | Serena (MCP) | mcp-language-server | Multilspy (lib) | Aider repo-map | Cline `list_code_definition_names` |
|---|---|---|---|---|---|---|---|---|
| 1 | Tool surface | one tool, 5-7 operation behaviors | one tool, 9-op enum | many symbol-level tools | 6 per-op tools | 5 per-op methods | (in context, not a tool) | one tool, tree-sitter-backed |
| 2 | Ops exposed | def, ref, hover, symbols, impl, callHierarchy, + diagnostics-via-hook | goToDefinition, findReferences, hover, documentSymbol, workspaceSymbol, goToImplementation, prepareCallHierarchy, incomingCalls, outgoingCalls | find_symbol, symbol_overview, find_referencing_symbols, rename, replace_symbol_body, insert_*, safe_delete + (JetBrains: move/inline/typeHierarchy) | definition, references, diagnostics, hover, rename_symbol, edit_file | request_definition, request_references, request_completions, request_hover, request_document_symbols | symbol names + signatures, no ops | definition-name enumeration per dir |
| 3 | Server management | plugin manifest per language, user installs binary | bundled registry with auto-download fallback | user-wired LSP path (or JetBrains bridge) | user-wired LSP in config, stdio only | auto-downloads binaries per language | (none — tree-sitter, no runtime server) | (none — tree-sitter grammars bundled) |
| 4 | Language detection | `.ext → languageId` in manifest | `.ext → id` table + spawn function | LSP-dependent | one workspace per server | 11 hard-coded language configs | 17 tree-sitter grammars | 17 extensions hard-coded |
| 5 | Readiness | auto-start at session, `startupTimeout` + `restartOnCrash` | lazy `touchFile` per call, 45s init timeout | per-server startup | per-server startup | `start_server()` context manager | instant | instant |
| 6 | Position encoding | opaque to model (harness handles) | 1-indexed line+char in schema, converted internally | symbol-named (no positions) | line-number based | 0-indexed (LSP-native) | n/a (names only) | n/a (names + line ranges) |
| 7 | Cross-file reads | URIs resolved inline | raw JSON Location[] returned | symbol-based → hides URIs | inlines source code into `definition` response | Location[] Python objects | inlined in map | inlined in result |
| 8 | Incremental sync | harness sync (closed-source) | real `didOpen/didChange` + 150ms diagnostic debounce | LSP-backed, edit via `WorkspaceEdit` | stdio; likely didOpen/didChange | via `start_server` context | n/a | n/a |
| 9 | Workspace scope | same `additionalDirectories` as Read/Write | `assertExternalDirectoryEffect` + `ask({permission: "lsp"})` | MCP roots | `--workspace [path]` | project root in `create` | project dir | directory arg |
| 10 | Error surface | "inactive until plugin installed" user-facing; tool-level unknown | `"No LSP server available for this file type"` + `"No results found for ${op}"` | per-tool error classes | per-tool error classes | Python exceptions | n/a | "no files parsed" message |
| 11 | Cold-start | pre-warm at session start via plugin | lazy, 45s timeout | LSP-dependent | LSP-dependent | per-call context | ms (tree-sitter) | ms (tree-sitter) |
| 12 | Output shape | harness-flattened; diagnostics as tool-result addendum | `JSON.stringify(result, null, 2)` — raw LSP JSON (a miss) | symbol-oriented structured output | inlines source code | Python object graphs | code-like `│` prefix text | `│` prefix text with gap separators |

### Observations from the matrix

1. **The `operation` enum has converged across all serious tools** at ~6-9 operations. Claude Code, OpenCode, and mcp-language-server share the same core set: hover, definition, references, symbols (doc + workspace), implementation, + diagnostics (push) + optionally rename, call hierarchy.
2. **Position encoding is the most-papered-over detail.** LSP says 0-indexed UTF-16. OpenCode correctly converts to 1-indexed at the tool boundary. Claude Code hides it entirely. Multilspy and mcp-language-server pass it through unchanged (pain on multi-byte languages). Get this wrong and models silently generate off-by-one errors that look like tool bugs.
3. **The split between server lifecycle and tool lifecycle is universal.** Nobody starts a server *per tool call*. It's "start per session / workspace; tool call touches-or-queries." This is good news for a library: we own the tool layer; the server layer is the adapter.
4. **Raw LSP JSON output is a trap.** OpenCode returns it — and the model has to re-resolve URIs, re-read files, parse Hover.contents (which has three legal shapes), and reconstruct context. mcp-language-server's inline-the-source approach is better. Flattened `path:line:text` is best for references.
5. **Diagnostics-as-a-tool is a category error.** The Claude Code pattern — diagnostics flow out-of-band after every Edit, not in response to a model request — is the right autonomous pattern. Models that call a `diagnostics` tool themselves under-invoke it; models that get diagnostics appended after every Edit always see them.
6. **Nobody has shipped a `rename` tool that the autonomous community uses.** Rename is on every "nice-to-have" list; rare in actual shipped autonomous tools. Our gap-audit explicitly calls this out as an ecosystem gap (`harness-tool-surface-audit.md`). The ledger interaction is the blocker.
7. **Two schools of server discovery**: "user installs binary + plugin manifest" (Claude Code) and "library auto-installs" (OpenCode). Claude Code's boundary is cleaner for a library consumer; OpenCode's is better for end-user DX at the cost of carrying a lot of installer logic. For `@agent-sh/harness-*`, the boundary-first approach wins.

## Answers to the eight design questions

### A. One tool or many?

**One tool with an `operation` discriminator.** The converged answer across Claude Code, OpenCode, Serena, mcp-language-server, and lsp-mcp is:

```ts
{
  operation: "hover" | "definition" | "references" | "symbols" | "implementation" | "diagnostics" | ...,
  path: string,
  line: number,   // 1-indexed
  character: number, // 1-indexed
  // optionally, symbol: string — see D below on symbol-first tools
}
```

Multilspy's per-method shape is correct for a *library* (programmatic callers care about type safety per op); wrong for a *tool* (models care about a small stable surface).

**Counter-evidence**: Serena's per-symbol-operation tools work because they are *semantically different* (find_symbol vs rename vs replace_symbol_body have incompatible inputs/outputs). If we ship symbol-first primitives, they can be their own tools. But for positional LSP ops, one tool wins.

### B. Which operations are essential?

**Ship** (v1): hover, definition, references, documentSymbol, workspaceSymbol, implementation, diagnostics.

**Don't ship** (v1): rename, codeAction, completion, signatureHelp, prepareCallHierarchy/incomingCalls/outgoingCalls.

Reasoning:
- **hover, definition, references, symbols, implementation** — these are the six operations every serious tool surfaces.
- **diagnostics** — not as an operation the model calls, but as a **hook behavior**. After every `Write`/`Edit`, the LSP engine emits diagnostics; the harness tool-result for the Edit gets them appended. The model never needs to ask for them; they always arrive.
- **rename** — high-value but complicates the read-before-edit ledger (a `WorkspaceEdit` can touch 10+ files the model never Read'd; do we require all of those to be ledger-tracked, or do we trust LSP?). Defer to v2 after the ledger semantics for multi-file edits are settled.
- **completion, signatureHelp** — these are **interactive-IDE** operations. The model isn't typing; it's generating whole functions. If it needed a signature, it can `hover`. Ship if you find a real use case; otherwise skip.
- **callHierarchy** — niche. The `references` operation plus the model's reasoning covers 90% of call-graph questions.

### C. How should server lifecycle be managed?

**Adapter pattern** — same as Bash (`SandboxAdapter`) and WebFetch (pluggable engine). Concretely:

```ts
// The tool library ships this interface.
interface LspClient {
  hasClient(filePath: string): Promise<boolean>
  openFile(filePath: string): Promise<void>  // emits didOpen/didChange
  hover(path: string, pos: Position): Promise<HoverResult | null>
  definition(path: string, pos: Position): Promise<Location[]>
  references(path: string, pos: Position): Promise<Location[]>
  documentSymbol(path: string): Promise<DocumentSymbol[]>
  workspaceSymbol(query: string): Promise<SymbolInformation[]>
  implementation(path: string, pos: Position): Promise<Location[]>
  getDiagnostics(filePath: string): Promise<Diagnostic[]>  // pull, not push
  // Optional v2:
  rename?(path: string, pos: Position, newName: string): Promise<WorkspaceEdit>
  shutdown(): Promise<void>
}

// Adapters ship as separate packages:
// @agent-sh/harness-lsp-spawn — spawns LSP binaries, a la OpenCode
// @agent-sh/harness-lsp-mcp   — proxies to an MCP LSP server (Serena, mcp-language-server)
// @agent-sh/harness-lsp-multilspy — wraps multilspy (Python subprocess)
```

Core ships the interface + a bundled Claude-Code-manifest-compatible default (`@agent-sh/harness-lsp-spawn`), parsing `.lsp.json` manifests to spawn user-installed binaries. Harnesses that want different server management swap the adapter.

### D. Read-only vs mutating operations

**Read-only in v1.** Mutations (`rename`, `codeAction`) interact with the read-before-edit ledger in ways that we haven't specced for multi-file edits (see `agent-knowledge/agent-write-across-ecosystems.md` §"transactional multi-file edit"). Specifically:

- LSP rename returns a `WorkspaceEdit` that can touch N files the model has never Read.
- Our Write/Edit tools require read-before-edit.
- Making the rename tool bypass this would contradict the whole invariant.
- Making the rename tool *force* pre-Read would turn a 1-tool-call operation into a 10+ tool-call operation — defeating the token-efficiency argument Serena makes for symbol-first editing.

Correct path: v1 is read-only; v2 ships `rename` with a ledger exemption that the harness documents ("LSP-rename implicitly Reads all touched files before writing"). Explicitly defer.

### E. Return shape

**Discriminated union, per-operation payload, flattened for models.**

```ts
type LspResult =
  | { kind: "ok"; operation: "hover"; markdown: string; range?: Range }
  | { kind: "ok"; operation: "definition"; locations: FlatLocation[] }
  | { kind: "ok"; operation: "references"; locations: FlatLocation[]; truncated?: number }
  | { kind: "ok"; operation: "symbols"; symbols: FlatSymbol[] }
  | { kind: "ok"; operation: "implementation"; locations: FlatLocation[] }
  | { kind: "ok"; operation: "diagnostics"; diagnostics: FlatDiagnostic[] }
  | { kind: "no_results"; operation: string; message: string }
  | { kind: "server_not_available"; language: string; suggest: string }
  | { kind: "server_starting"; estimatedSecondsRemaining?: number; suggest: string }
  | { kind: "position_invalid"; path: string; line: number; character: number; reason: string }
  | { kind: "timeout"; operation: string; elapsedMs: number }
  | { kind: "error"; message: string }

// Flattened = path + 1-indexed line + 1-indexed char + context line of text
type FlatLocation = {
  path: string
  line: number        // 1-indexed
  character: number   // 1-indexed
  text: string        // the line of source, for model grounding
  endLine?: number    // multi-line match
}

type FlatSymbol = {
  name: string
  kind: string         // "class" | "function" | "method" | ...
  path: string
  line: number
  character: number
  containerName?: string
}

type FlatDiagnostic = {
  path: string
  line: number
  character: number
  severity: "error" | "warning" | "info" | "hint"
  code?: string
  message: string
}
```

Why this shape beats raw LSP JSON:
- **`FlatLocation` includes the source line** — the model gets grounding without a follow-up Read.
- **1-indexed positions** everywhere, matching the Read tool's `cat -n` convention.
- **`kind: "no_results"` with a message** beats an empty array — per SWE-agent's ACI finding that human-language empty-output messages reduce loops.
- **`server_not_available` + `suggest`** — the model reads the suggestion and can recover (e.g., "install typescript-language-server: `npm i -g typescript-language-server`" or "fall back to Grep").
- **`server_starting`** — the model knows to retry rather than give up.

### F. Adapter boundary

Same pattern as Bash (`SandboxAdapter`) and WebFetch (pluggable engine):

```ts
// The tool package
package: @agent-sh/harness-lsp
exports:
  - the `LSP` tool with valibot schema and result discriminated union
  - the `LspClient` interface
  - `createLspPermissionPolicy({...})` — same shape as other tools
  - a small `parsePluginManifest(json)` helper that turns a Claude-compatible `.lsp.json` into a server config
```

The adapter packages (separate packages, same org):

- `@agent-sh/harness-lsp-spawn` — the default. Takes a manifest → spawns `typescript-language-server`, `gopls`, etc. Uses `vscode-jsonrpc` (the non-editor-coupled part of `vscode-languageserver-node`) as the JSON-RPC transport.
- `@agent-sh/harness-lsp-mcp` — proxies to an external MCP LSP server (Serena, mcp-language-server). Users who already run an MCP client pick this.
- `@agent-sh/harness-lsp-stub` — for tests; in-memory fake returning canned responses.

The harness picks an adapter; the tool doesn't care. This is the same philosophy as "our Bash doesn't own the sandbox."

### G. Cold-start latency policy

Rust-analyzer takes ~30s to index a medium project; tsserver ~5s; pyright ~2s. Policy:

1. **Pre-warm at session start**. Servers for languages detected in the workspace start when the session starts, not when the first tool call lands. A `SessionStart` hook or equivalent.
2. **First tool call may still race the server.** If `hasClient(file)` returns true but the server hasn't finished indexing, we return `{kind: "server_starting", estimatedSecondsRemaining?, suggest: "retry in N seconds or use Grep for now"}`.
3. **Never block indefinitely.** 10s call-level timeout; after that, return `{kind: "timeout"}`. Let the model decide whether to retry or fall back.
4. **Don't expose a `warm_server` tool to the model.** The model shouldn't have to manage server lifecycle. The harness owns warming; the tool call is just "query."

### H. Language-server discovery

Plugin-delivered manifests are the cleanest boundary:

```
@agent-sh/harness-lsp-spawn reads:
  - Workspace-local: <workspace>/.claude-plugin/*/.lsp.json  (if any)
  - User-global:     ~/.config/agent-sh-harness/lsp/*.json
  - Package-bundled defaults: typescript, python, go, rust (but only as templates)
```

The library **does not auto-install LSP binaries**. The manifest says "run `typescript-language-server --stdio`"; if the binary isn't in PATH, we return `{kind: "server_not_available", language: "typescript", suggest: "install via `npm i -g typescript-language-server typescript`"}`. This matches Claude Code's split (plugin manifest + user-installed binary).

**Why not auto-install like OpenCode?** Two reasons:
- We don't want to carry the matrix of per-platform installers (gem, go install, dotnet tool, GitHub releases, jar downloads). Each is an attack surface and an ongoing maintenance burden.
- Users running in CI or sandboxed environments need deterministic builds; auto-download-on-demand is a build-reproducibility anti-pattern.

Adapters that *want* auto-install (a future `@agent-sh/harness-lsp-autoinstall`) can add it as a separate package. Core stays thin.

## Autonomous-agent specifics — what changes from HITL / IDE context

This library targets autonomous agents. The matrix above is heavily weighted toward IDE-adjacent tools (Claude Code, OpenCode, Cursor) and MCP servers (Serena, mcp-language-server). The differences for autonomous:

- **No "please wait while indexing" dialog.** The tool must tell the model directly: `server_starting` + estimated time + fallback suggestion. The model must be able to keep working with Grep while the server warms up.
- **Diagnostics flow in, not out.** In an IDE, the user sees squigglies; in an autonomous agent, diagnostics arrive as tool-result addenda *after every Edit*. The model's context must show them automatically. This is a harness-layer concern — we ship the engine; we spec the hook.
- **Position-encoding mismatches are invisible bugs.** No IDE to visualize them. If we give the model 0-indexed positions, it will generate off-by-one errors that look like tool bugs. **Always convert at the tool boundary to 1-indexed.**
- **Empty results need human-language messages.** SWE-agent's ACI research (`"Your command ran successfully and did not produce any output"`) applies verbatim: the model should see `"No references found for 'foo' at path/file.ts:10:5"`, not `[]`.
- **Raw LSP JSON is a model-parser footgun.** Hover returns a `MarkupContent | MarkedString | MarkedString[]` union; the model gets confused across examples. Flatten to `{kind: "ok"; operation: "hover"; markdown: string}` always.
- **Cold-start latency is a UX problem, not just a perf problem.** If the first `definition` call takes 30s, the model's context has 30s of dead time. Pre-warm at session start; return `server_starting` on miss; never block.
- **Size caps matter.** A `findReferences` on a common symbol can return 10K hits. Cap the tool output (say, 200 references) with a `truncated: 9800` hint and a `suggest: "pass a scope parameter or use a more specific position"`.
- **Workspace-symbol queries can be abused.** A model might search for `"e"` and pull 50K symbols. Cap similarly; require a minimum query length (e.g., ≥3 chars).

## Pattern library — what each choice buys you

### Pattern 1: Discriminated-union results (Claude Code, OpenCode, converged)

```ts
{ kind: "ok" | "no_results" | "server_not_available" | "server_starting" | "position_invalid" | "timeout" | "error", ... }
```

**Buys**: model parses `kind` reliably; each variant has a typed payload; recovery paths (`suggest` field) flow naturally.

**Costs**: schema is slightly larger than "just return JSON."

**Adopt**: yes, universally.

### Pattern 2: 1-indexed positions at the model boundary (OpenCode)

```ts
{ line: number /* 1-based */, character: number /* 1-based */ }
```

**Buys**: matches Read/Edit/Grep `cat -n` convention; matches what the model sees in file contents; zero off-by-one errors from the model.

**Costs**: `+1/-1` conversion at the LSP boundary. Trivial.

**Adopt**: yes.

### Pattern 3: Flatten LSP output to grep-shape (mcp-language-server)

```ts
// Instead of raw Location[]:
[{ uri: "file:///...", range: {start: {line, character}, end: {line, character}} }]

// Emit:
[{ path: "relative/path.ts", line: 42, character: 8, text: "  foo.bar(x, y)" }]
```

**Buys**: the model already knows how to reason about grep-style lines. No re-resolving URIs, no re-reading files for context.

**Costs**: an extra file read per location at tool-call time. Trivial for a bounded cap (e.g., 200 refs max).

**Adopt**: yes.

### Pattern 4: Diagnostics-via-hook, not via tool (Claude Code)

```ts
// Not this:
tool_call: { name: "LSP", args: { operation: "diagnostics", path: "foo.ts" } }

// This:
PostToolUse: on("Write" | "Edit") => {
  const diags = await lsp.getDiagnostics(edit.path)
  if (diags.length) appendToToolResult(stringifyDiagnostics(diags))
}
```

**Buys**: model sees diagnostics on every edit, automatically; no missed check; closes the "did my edit break anything" loop.

**Costs**: hook infrastructure in the harness.

**Adopt**: yes — ship diagnostics as a `PostToolUse` hook recipe the harness can wire.

### Pattern 5: `server_starting` with retry hint (novel — matrix suggests)

```ts
{ kind: "server_starting", estimatedSecondsRemaining: 20, suggest: "retry in 20s, or use Grep for now" }
```

**Buys**: model keeps working (via Grep fallback) during cold-start; has a timer to retry.

**Costs**: requires the adapter to know its own readiness state (every real LSP client tracks this).

**Adopt**: yes.

### Pattern 6: Plugin-manifest server discovery (Claude Code)

```json
// .lsp.json
{
  "typescript": {
    "command": "typescript-language-server",
    "args": ["--stdio"],
    "extensionToLanguage": { ".ts": "typescript", ".tsx": "typescriptreact", ".js": "javascript", ".jsx": "javascriptreact" }
  }
}
```

**Buys**: declarative configuration; user installs binary once; no auto-install logic in the library; symmetry with Claude Code plugins.

**Costs**: user has to install binaries. This is table-stakes UX for LSP, not friction.

**Adopt**: yes — adopt the Claude Code manifest schema wholesale.

### Pattern 7: 150ms diagnostic debounce (OpenCode)

```ts
onPublishDiagnostics(() => {
  debounce(150, () => flushDiagnostics())
})
```

**Buys**: coalesces the two-wave diagnostic pattern (syntax pass → semantic pass) that most LSPs emit, so the model sees one message, not two.

**Costs**: 150ms latency on diagnostic delivery. Acceptable.

**Adopt**: yes.

### Pattern 8: Fail-fast `hasClient` check (OpenCode)

```ts
if (!await lsp.hasClient(filePath)) {
  return { kind: "server_not_available", language: inferLanguage(filePath), suggest: "install X" }
}
```

**Buys**: explicit error; no opaque JSON-RPC timeout; model sees a recoverable state.

**Costs**: one extra check per call. Trivial.

**Adopt**: yes.

### Pattern 9: Symbol-first operations as a layer on top (Serena)

```ts
find_symbol("Foo.bar") → workspace/symbol → best match → Location[]
replace_symbol_body("Foo.bar", "<body>") → documentSymbol → selectionRange → WorkspaceEdit
```

**Buys**: model operates on names, not positions; atomic symbol-boundary edits; fewer round-trips.

**Costs**: more complex to implement; requires stable `documentSymbol` support per language.

**Adopt**: as v2. Core LSP first; symbol-first on top.

## Open design questions — where the ecosystem hasn't converged

1. **Rename + ledger interaction**. No autonomous agent has solved this. Proposals: (a) treat LSP rename's `WorkspaceEdit` as a ledger exemption with audit logging; (b) require pre-Read of all files in the edit (high token cost); (c) two-step: preview + confirm. This is a genuine open research question and a reason to skip rename in v1.
2. **Workspace-symbol caps**. Every real tool has to cap output but none has a principled policy. 200? 500? Language-dependent? Tied to context-window size?
3. **Multi-workspace projects**. Monorepo with TypeScript + Python + Rust. How do we handle `LSP` tool calls across language boundaries? The file-extension dispatcher works, but workspace-symbol queries don't have a "file" to dispatch on.
4. **LSP server sharing across sessions**. A long-running TypeScript server has warm caches; dropping it at session-end wastes re-indexing cost. Claude Code's session-scoped lifetime is the obvious choice; a process-pool approach (one server per workspace, shared across sessions) would be cheaper but conflicts with isolation goals.
5. **Completion vs. hover for signature info**. Models do sometimes want to know "what are the valid call shapes for `foo`". `signatureHelp` gives this directly; `hover` gives it indirectly. No tool has shipped `signatureHelp` in the autonomous-agent literature; worth a real experiment.
6. **Diagnostic severity filtering**. After an Edit, should the LSP hook surface all `severity: "hint"` warnings? pyright's hint-noise is enormous. The right filter is probably `error + warning` by default; configurable. No prior art.

## Code Examples

### Basic Example — the single `LSP` tool schema

```ts
import * as v from 'valibot'

const LspToolSchema = v.object({
  operation: v.picklist([
    'hover',
    'definition',
    'references',
    'documentSymbol',
    'workspaceSymbol',
    'implementation',
    // v2: 'rename', 'callHierarchy', 'diagnostics'
  ]),
  path: v.optional(v.string()),  // required for most ops, absent for workspaceSymbol
  line: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  character: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  query: v.optional(v.string()),  // required for workspaceSymbol
})

type LspResult =
  | { kind: 'ok'; operation: 'hover'; markdown: string; range?: Range }
  | { kind: 'ok'; operation: 'definition'; locations: FlatLocation[] }
  | { kind: 'ok'; operation: 'references'; locations: FlatLocation[]; truncated?: number }
  | { kind: 'ok'; operation: 'symbols'; symbols: FlatSymbol[] }
  | { kind: 'ok'; operation: 'implementation'; locations: FlatLocation[] }
  | { kind: 'no_results'; operation: string; message: string }
  | { kind: 'server_not_available'; language: string; suggest: string }
  | { kind: 'server_starting'; estimatedSecondsRemaining?: number; suggest: string }
  | { kind: 'position_invalid'; path: string; line: number; character: number; reason: string }
  | { kind: 'timeout'; operation: string; elapsedMs: number }
  | { kind: 'error'; message: string }
```

### Advanced Pattern — the `LspClient` adapter interface

```ts
// Shipped in @agent-sh/harness-lsp (the tool package)
export interface LspClient {
  hasClient(filePath: string): Promise<boolean>
  openFile(filePath: string): Promise<void>
  hover(path: string, pos: Position): Promise<HoverResult | null>
  definition(path: string, pos: Position): Promise<Location[]>
  references(path: string, pos: Position, includeDeclaration?: boolean): Promise<Location[]>
  documentSymbol(path: string): Promise<DocumentSymbol[]>
  workspaceSymbol(query: string): Promise<SymbolInformation[]>
  implementation(path: string, pos: Position): Promise<Location[]>
  getDiagnostics(filePath: string): Promise<Diagnostic[]>
  readinessStatus(): Promise<{ ready: boolean; indexingPct?: number; languages: string[] }>
  shutdown(): Promise<void>
}

// Default adapter: spawn LSP binaries per manifest
// In @agent-sh/harness-lsp-spawn
export function createSpawnAdapter(config: {
  manifests: Record<string /* language */, LspManifest>
  workspaceRoot: string
}): LspClient { /* uses vscode-jsonrpc for transport */ }

// MCP adapter: proxy to an external MCP LSP server
// In @agent-sh/harness-lsp-mcp
export function createMcpAdapter(config: {
  serverUrl: string  // or command
}): LspClient { /* talks to Serena, mcp-language-server, etc. */ }
```

### Advanced Pattern — diagnostics as a `PostToolUse` hook

```ts
// A harness wires this alongside the LSP tool.
// It runs after every Write/Edit and appends diagnostics to the tool result.
export const diagnosticsHook: PostToolUseHook = async (ctx, result) => {
  if (ctx.tool !== 'Write' && ctx.tool !== 'Edit') return result
  if (!ctx.filePath) return result

  const diags = await ctx.lsp.getDiagnostics(ctx.filePath)
  if (diags.length === 0) return result

  const formatted = diags
    .filter(d => d.severity === 'error' || d.severity === 'warning')
    .map(d => `${d.path}:${d.line}:${d.character}: ${d.severity}: ${d.message}`)
    .join('\n')

  return {
    ...result,
    appendix: `\n\n--- diagnostics ---\n${formatted}`,
  }
}
```

## Common Pitfalls

| Pitfall | Why It Happens | How to Avoid |
|---|---|---|
| Model passes 0-indexed positions | LSP spec is 0-indexed; some tools pass through | Always convert at the tool boundary; schema says 1-indexed; document in tool description |
| References returns 10K hits, context overflows | Popular symbols have many refs | Cap at ~200, return `truncated: N` + `suggest: narrow scope` |
| `Hover.contents` parsing fails | LSP spec allows 3 shapes: string, MarkupContent, or MarkedString[] | Normalize to `markdown: string` in the tool result |
| Model asks for hover on whitespace | Happens when line/char guessed from an unrelated line | Return `position_invalid` with a helpful message; don't fail silently |
| Cold-start blocks the agent for 30s | Rust-analyzer indexing on a large project | Pre-warm at session start; return `server_starting` on miss; never block indefinitely |
| Diagnostics arrive twice in a row | LSP emits syntax-pass + semantic-pass | 150ms debounce on `publishDiagnostics` |
| LSP server crashes silently | Language server hits OOM or a parser bug | `restartOnCrash: true` + `maxRestarts: 3`; after cap, return `server_not_available` with a clear message |
| Workspace-symbol query `"e"` returns 50K results | No min length enforced | Require `query.length >= 3`; cap results at 200 |
| Tool is called but server isn't installed | User hasn't run `npm i -g typescript-language-server` | Return `server_not_available` with the exact install command in `suggest` |
| Raw `Location[]` output confuses the model | Nested `range.start.line` / `range.end.character` JSON | Flatten to `{path, line, character, text}` |
| Rename changes files the model never Read | LSP `WorkspaceEdit` touches arbitrary files | Skip rename in v1; when shipped, treat as a ledger exemption with audit |
| Monorepo has TS + Python + Rust — only TS has LSP active | First-matching language dispatcher | Check per-extension before dispatch; emit `server_not_available` with language hint for misses |
| Model uses `LSP` when Grep would be faster | `LSP` has a 30s cold-start | Tool description explicitly notes "for precise semantic queries after files are open; for text search use Grep" |
| Model asks for `definition` on a keyword like `if` | Common for off-by-one position errors | Return `no_results`; keyword positions yield empty refs/defs naturally |

## Best Practices

1. **One tool, `operation` enum** (Source: Claude Code LSP, OpenCode lsp, mcp-language-server — all converge).
2. **1-indexed positions at the model boundary** (Source: OpenCode lsp schema; SWE-agent's ACI research on matching editor conventions).
3. **Discriminated-union results with `kind`** (Source: exec-tool-design-across-harnesses.md Pattern 9; Claude Code Bash result shape).
4. **Flattened grep-style output for references and symbols** (Source: mcp-language-server's inline-source; OpenCode's `JSON.stringify` is the counter-example to avoid).
5. **Diagnostics as a `PostToolUse` hook, not a tool the model calls** (Source: Claude Code LSP tool behavior docs, "After each file edit, it automatically reports type errors and warnings").
6. **Adapter pattern for server management** (Source: our own Bash/WebFetch adapter landings; Serena's dual LSP+JetBrains backend).
7. **Plugin-manifest schema for server config, no auto-install** (Source: Claude Code `.lsp.json` manifest; contrast with OpenCode's aggressive auto-install that a library should avoid).
8. **Pre-warm servers at session start** (Source: Claude Code plugin activation; converged across serious tools).
9. **`server_starting` + retry hint** instead of blocking (Source: gap in prior art; implied by the cold-start problem).
10. **Cap references at ~200 and workspace-symbols at ~200, with `truncated` hint** (Source: converged across tools; exact number is an educated guess).
11. **Fail-fast `hasClient` check before dispatch** (Source: OpenCode `lsp.hasClients(file)`).
12. **1-second tool timeout for fast ops, 10s for slow ones, never infinite** (Source: OpenCode 45s init timeout; our exec-tool inactivity pattern).

## Further Reading

| Resource | Type | Why Recommended |
|---|---|---|
| [Claude Code Tools Reference](https://code.claude.com/docs/en/tools-reference) | Official docs | The `LSP` tool's description and behavior section; the reference implementation for a closed harness. |
| [Claude Code Plugins Reference — LSP servers](https://code.claude.com/docs/en/plugins-reference) | Official docs | The `.lsp.json` manifest schema, verbatim. Adopt wholesale. |
| [Claude Code Discover Plugins — Code intelligence](https://code.claude.com/docs/en/discover-plugins) | Official docs | Full list of 11 officially-shipped LSP plugins + binary requirements. |
| [OpenCode `lsp.ts` tool source](https://github.com/sst/opencode/blob/dev/packages/opencode/src/tool/lsp.ts) | Source code | Open TypeScript reference — 1-indexed schema, guards, `touchFile` pattern, `JSON.stringify` output (the "what not to do" on shape). |
| [OpenCode `lsp/server.ts` server registry](https://github.com/sst/opencode/blob/dev/packages/opencode/src/lsp/server.ts) | Source code | 40+ language registrations with `spawn()` functions; auto-download logic (aggressive — library should not copy). |
| [OpenCode `lsp/client.ts` LSP client](https://github.com/sst/opencode/blob/dev/packages/opencode/src/lsp/client.ts) | Source code | Real `initialize`, `didOpen`, `didChange`, `publishDiagnostics` handling with 150ms debounce; ~300 LOC TypeScript reference. |
| [LSP 3.17 Specification](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/) | Spec | The canonical protocol. Position encoding, operation shapes, initialization sequence. Required reading before shipping any LSP client. |
| [Serena (oraios/serena)](https://github.com/oraios/serena) | OSS project | Symbol-first tool surface built on LSP; the best example of "abstracting above raw LSP for LLM consumers." |
| [mcp-language-server (isaacphi)](https://github.com/isaacphi/mcp-language-server) | OSS project | 6-tool MCP wrapper for LSPs; user-wired binary; minimalist reference. |
| [lsp-mcp (jonrad/lsp-mcp)](https://github.com/jonrad/lsp-mcp) | OSS project | Dynamic schema-generated MCP tools from LSP capabilities — an architectural dead-end for LLMs but instructive. |
| [Multilspy + monitors4codegen](https://github.com/microsoft/multilspy) | Research project | NeurIPS 2023 Monitor-Guided Decoding; 19-25% compilation-rate lift is the strongest quantitative argument for LSP-for-LLM. |
| [vscode-languageserver-node](https://github.com/microsoft/vscode-languageserver-node) | Library | `vscode-jsonrpc` (reusable) and `vscode-languageserver-protocol` (reusable) for transport + types. Don't use `vscode-languageclient` — VSCode-coupled. |
| [Aider repo-map documentation](https://aider.chat/docs/repomap.html) | Official docs | The tree-sitter + PageRank alternative; argues for "map in context, not tool." |
| [Aider tree-sitter-based repo-map](https://aider.chat/2023/10/22/repomap.html) | Blog post | Architectural rationale for tree-sitter over ctags; 17-language support via `py-tree-sitter-languages`; sample output format. |
| [Cline tree-sitter service](https://github.com/cline/cline/blob/main/src/services/tree-sitter/index.ts) | Source code | `list_code_definition_names` implementation; 17-language grammar-based extraction; `│` prefix output format. |
| [Cursor agent tools](https://cursor.com/docs/agent/tools) | Official docs | Semantic Search instead of LSP — the IDE-embedded harness design choice. |
| [OpenAI Agents SDK tools](https://openai.github.io/openai-agents-python/tools/) | Official docs | No LSP tool ships; HostedMCPTool is the escape hatch. Validates the "ship as MCP too" plan. |
| [Armin Ronacher on agentic coding tools](https://lucumr.pocoo.org/2025/6/12/agentic-coding/) | Blog post | Practitioner commentary on verification tools and agent-tool design; does not specifically discuss LSP but informs our permission/error philosophy. |
| [MCP Reference Servers list](https://modelcontextprotocol.io/examples) | Official docs | Confirms: no official MCP LSP / code-intelligence reference server. This is our distribution opportunity. |
| [@agent-sh/harness-tools CLAUDE.md](./CLAUDE.md) | Internal spec | The prime-directive doc on treating LLM tools as a distributed system. Applies doubly to LSP because of cold-start and position-encoding surprises. |
| [agent-knowledge/harness-tool-surface-audit.md — §LSP / code intelligence](./harness-tool-surface-audit.md) | Internal guide | Ship-list view: who has it, who doesn't. LSP tool is called out as the highest-leverage unshipped capability. |
| [agent-knowledge/exec-tool-design-across-harnesses.md](./exec-tool-design-across-harnesses.md) | Internal guide | Same "design across harnesses" shape; adapter-interface pattern; hook-first default. Apply the same patterns here. |

---

*This guide was synthesized from 22 sources analyzed across Claude Code, OpenCode, Serena, mcp-language-server, lsp-mcp, Multilspy, Aider, Cline, Cursor, the OpenAI Agents SDK, the LSP 3.17 spec, and internal design references. See `resources/lsp-tool-design-across-harnesses-sources.json` for full source list with quality scores.*

*Self-evaluation — gaps noted: (a) Codex Cloud and Codex CLI LSP roadmap not covered (no public signal); (b) Gemini CLI LSP roadmap unknown; (c) rename-with-ledger interaction is open research — we skip v1; (d) no quantitative comparison of LSP-tool invocation rates across model families (prior art would require our own e2e tests); (e) `signatureHelp` and `completion` operations intentionally deferred — no strong prior art for autonomous use.*
