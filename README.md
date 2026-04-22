# `@agent-sh/harness-*`

TypeScript-first agent tools, designed for real LLMs.

Each tool in this repo (`read`, `write`, `grep`, `glob`, `bash`, `webfetch`, `lsp`, `skill`) ships as its own `@agent-sh/harness-*` npm package, plus an umbrella `@agent-sh/harness-tools` that re-exports them. Matching Rust ports live under `crates/` and maintain TS parity.

The tools are meant to be consumed by autonomous agents (Claude, GPT, Qwen, Gemini, ...), not by deterministic callers. That framing shapes every design call — see [`CLAUDE.md`](./CLAUDE.md) and the per-tool specs under [`agent-knowledge/design/`](./agent-knowledge/design/).

## Packages

| Package | What it does |
|---|---|
| [`@agent-sh/harness-core`](./packages/core) | Shared types: discriminated results, `ToolError`, `PermissionPolicy`, ledger, operation adapters. Every tool builds on this. |
| [`@agent-sh/harness-read`](./packages/read) | File read with pagination, binary refusal, directory listing, image/PDF attachment shape, fuzzy-sibling `NOT_FOUND`. |
| [`@agent-sh/harness-write`](./packages/write) | Atomic file write + targeted `edit` + `multiedit` pipeline with read-before-edit ledger, `OLD_STRING_NOT_UNIQUE` match locations, fuzzy candidate suggestions. |
| [`@agent-sh/harness-grep`](./packages/grep) | ripgrep-backed search with discriminated `output_mode`, regex hints on `INVALID_REGEX`, pagination. |
| [`@agent-sh/harness-glob`](./packages/glob) | File discovery by pattern with ignore-awareness, mtime-sorted results, workspace fence. |
| [`@agent-sh/harness-bash`](./packages/bash) | Shell with tokio-style cwd-carry, inactivity + wall-clock timeouts, head+tail spill-to-file on overflow, background jobs (`bash_output` / `bash_kill`). |
| [`@agent-sh/harness-webfetch`](./packages/webfetch) | HTTP `GET`/`POST` with tool-layer SSRF defense, readability+markdown extraction, redirect-chain reporting, size caps, per-session cache. |
| [`@agent-sh/harness-lsp`](./packages/lsp) | Language-server operations (hover, definition, references, documentSymbol, workspaceSymbol, implementation) with 1-indexed positions, lazy-spawn, `server_starting` retry hints. |
| [`@agent-sh/harness-skill`](./packages/skill) | [Agent Skills](https://agentskills.io) `SKILL.md` activation with progressive disclosure, permission-gated activation, trust-gated project skills. |
| [`@agent-sh/harness-tools`](./packages/tools) | Umbrella re-export for the whole surface. Install this one for everything. |

## Install

```sh
npm install @agent-sh/harness-tools
# or the individual tools:
npm install @agent-sh/harness-read @agent-sh/harness-grep @agent-sh/harness-glob
```

Requires Node ≥ 20.

## Quick start

```ts
import { read } from "@agent-sh/harness-read";

const result = await read(
  { path: "src/index.ts", offset: 1, limit: 50 },
  {
    cwd: process.cwd(),
    permissions: { roots: [process.cwd()], sensitivePatterns: ["**/.env"] },
  },
);

if (result.kind === "text") {
  console.log(result.output);
}
```

Every tool returns a discriminated union by `kind`. See the design docs under [`agent-knowledge/design/`](./agent-knowledge/design/) for each tool's full contract.

## Design philosophy

LLMs are probabilistic, and the textual surface of a tool (name, description, schema field names, error messages, output shape, pagination hints) is its real contract. We design for that:

- **Discriminated unions instead of throwing errors.** The model parses `kind: "not_found"` reliably; it does not parse embedded error markers in a string.
- **Fail-closed permission hooks.** No hook = refuse. No silent fallback.
- **Alias pushback tables.** When the model passes `file_path` instead of `path`, we return a targeted hint, not a generic schema error.
- **Fuzzy recovery hints.** `NOT_FOUND` with candidate siblings. `OLD_STRING_NOT_UNIQUE` with all match locations. The model is expected to correct and retry.
- **Cross-language parity.** Every tool has a Rust port (`crates/<tool>/`) and a parity baseline proving they behave identically to real LLMs across four Ollama models.

More in [`CLAUDE.md`](./CLAUDE.md).

## Repository layout

```
tools/
├─ packages/                # TypeScript packages (npm-publishable)
│  ├─ core/                 # @agent-sh/harness-core
│  ├─ read/                 # @agent-sh/harness-read
│  ├─ ...                   # one dir per tool
│  ├─ tools/                # @agent-sh/harness-tools (umbrella)
│  └─ harness-e2e/          # private — real-LLM test harness
├─ crates/                  # Rust ports
│  ├─ harness-core/
│  ├─ read/
│  └─ ...                   # one crate per tool
└─ agent-knowledge/         # design specs + cross-harness research
   ├─ design/*.md           # per-tool canonical specs
   └─ *.md                  # research guides (LSP, skill, exec, webfetch, ...)
```

## Development

```sh
pnpm install

# TypeScript
pnpm build
pnpm test
pnpm typecheck

# Rust (requires cargo + a stable toolchain)
cargo build --workspace
cargo test --workspace
```

### End-to-end harness

`packages/harness-e2e/` runs real-LLM tool-call loops against every tool for each of four Ollama models (`gemma4:e2b`, `gemma4:26b`, `qwen3:8b`, `qwen3.5:27b-q4_K_M`) plus Bedrock Opus 4.7. Baselines live in `packages/harness-e2e/baselines/` — they encode what "good" looks like for each tool under each model. Running `pnpm --filter @agent-sh/harness-e2e aggregate:<tool>:check` compares a fresh run against its baseline.

### Releases

The repo uses [Changesets](https://github.com/changesets/changesets). To propose a release:

```sh
pnpm changeset         # describe what changed per package
```

On merge to `main`, the release workflow opens a "Version Packages" PR that bumps affected packages per semver and updates CHANGELOGs. Merging that PR publishes to npm.

Required repo secret: `NPM_TOKEN` (an automation token for the `@agent-sh` scope).

## Contributing

The design docs at [`agent-knowledge/design/`](./agent-knowledge/design/) are the canonical specs for each tool. Implementation changes must be reflected in the spec, and vice versa. See [`CLAUDE.md`](./CLAUDE.md) for the contributor agreement.

## License

MIT © Avi Fenesh
