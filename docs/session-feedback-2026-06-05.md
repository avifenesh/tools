# Session Feedback — 2026-06-05

## Context
Large-scale cleanup session: synced 42 Git repos, resolved merge conflicts, rebuilt all Rust projects with optimized release profiles + mimalloc, cleaned 150+ GB of stale artifacts.

---

## Issues Encountered

### 1. Background job polling is broken

`bash_output(job_id)` returned `NOT_FOUND` for every cargo build. I had to poll repeatedly with errors, making it impossible to track progress on long-running builds. This was the most frustrating limitation — I essentially ran blind on 10+ background jobs.

**Root cause**: `executor.rs:317-324` — jobs stored in an in-process `HashMap` inside `LocalBashExecutor`. If the executor is recreated between tool calls (new session, process restart, or executor swap), all job IDs are lost. No persistent job store.

**Desired fix**: Disk-backed job registry so background jobs survive executor recreation. At minimum, completed jobs should remain queryable until explicitly cleaned up.

### 2. edit tool is fragile with whitespace

When resolving merge conflicts, the conflict markers had subtle whitespace differences that made exact string matching fail repeatedly. I had to fall back to `sed` for most of it.

**Root cause**: `matching.rs:56-86` — byte-level exact matching after LF normalization. No tolerance for trailing whitespace, tab/space differences, or indentation shifts.

**Desired fix**:
- `ignore_whitespace: true` option on edit specs
- Fuzzy-match mode that tolerates whitespace-only diffs
- Line-range edits (`startLine`/`endLine` replacement) to bypass exact string matching

### 3. No batch operations (FIXED)

Having to loop through 42+ repos for fetch, prune, push, branch cleanup, etc. was verbose.

**Fix**: Implemented `@agent-sh/harness-batch` — a generic batch tool that runs commands across multiple directories. Supports:
- `subdirs` target mode (run in each subdirectory of a path)
- `glob` target mode (run in each path matching a glob)
- `explicit` target mode (run in each explicitly listed path)
- Sequential and parallel execution modes
- Fail-fast, timeout control, summary-only output
- Both Rust (`harness-batch`) and Node.js (`@agent-sh/harness-batch`) implementations

### 4. No file system state tracking

I had to manually verify every change (did the build succeed? did the conflict resolve?). A tool that could diff working tree state before/after operations, or track "did this build produce new binaries?" would reduce verification noise.

**Desired fix**:
- Post-operation status summary (e.g., after bash: "3 files changed, 2 new binaries produced")
- Ability to track file state snapshots and diff between them
- Build artifact detection ("new release binary is 12% smaller than previous")

### 5. grep -r across repos is slow

Finding all `Cargo.toml` files, all `main.rs` files, etc. across nested workspace structures required multiple `find` commands. A workspace-aware tool that understood Rust/Cargo structure would be useful.

**Desired fix**:
- `--workspace` flag that detects Cargo workspaces and only searches source directories (not `target/`, `node_modules/`, etc.)
- Language-aware file discovery (`find-binary-crate`, `find-library-crate`)

---

## What Worked Well

- **bash** for bulk operations (cleaning, loops, git) — reliable and fast
- **read/grep** for inspecting files — accurate and well-behaved
- **github tool** for the initial conflict resolution in `codex-desktop-linux` — handled the complex 3-way merge cleanly

---

## Priority Ranking

| Priority | Issue | Status | Impact |
|----------|-------|--------|--------|
| **P0** | Background job polling | ✅ Fixed | Directly breaks long-running workflows |
| **P1** | Edit whitespace fragility | ✅ Fixed | Forces workarounds, wastes rounds |
| **P2** | No batch operations | ✅ Fixed | Verbose but functional with bash loops |
| **P3** | No state tracking | Open | Quality-of-life, reduces verification |
| **P3** | Workspace-aware grep | Open | Quality-of-life for monorepos |

---

## Forward-Looking Wishlist

1. ~~**Persistent background job store** with TTL and explicit cleanup~~ ✅ Implemented
2. **Edit by line range** as first-class operation (not just string replacement)
3. ~~**Batch/multirepo actions** for git, file ops, and builds~~ ✅ Implemented
4. **Post-operation summaries** that auto-detect meaningful changes
5. **Workspace-aware discovery** for Cargo, npm, Go modules, etc.
6. **Streaming output for background jobs** instead of file-based polling
7. **Idempotent edit mode** — "ensure this block exists" rather than "replace exact string"
8. **Structured error recovery** — suggest fixes instead of just erroring (e.g., "whitespace mismatch at column 4, retry with tabs→spaces?")
9. **Batch operation hooks** — pre/post callbacks for batch operations
10. **Batch retry with exponential backoff** for transient failures
