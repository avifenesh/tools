---
"@agent-sh/harness-write": minor
"@agent-sh/harness-tools": minor
---

Rename the MultiEdit tool's canonical name from `multiedit` to `multi_edit`, matching the `multiEdit` entry point and the snake_case convention of the other multi-word tool names (`bash_output`, `bash_kill`).

**Deprecation, not removal** — the old spelling keeps working during a migration window:

- `MULTIEDIT_TOOL_NAME` is now `"multi_edit"`; `multieditToolDefinition.name` follows it, so registries pick up the new name on upgrade.
- The old spelling is still exported as `MULTIEDIT_TOOL_NAME_LEGACY` (`"multiedit"`, marked `@deprecated`).
- New `isMultiEditToolName(name)` pure matcher accepts both spellings; new `normalizeMultiEditToolName(name)` maps both to the canonical name and emits a one-time `DeprecationWarning` per process when it sees the legacy one — use it at dispatch points (`warnLegacyMultiEditToolName()` is also exported directly).
- The pi extension in `@agent-sh/harness-tools` now registers the tool as `multi_edit`.
- Permission hooks now receive `tool: "multi_edit"` on **every** query a MultiEdit call makes — both the path fence and the fail-open read-before-mutate (`action: "write_unread"`) query. **This label changes as soon as you upgrade**: if your hook matches `tool === "multiedit"`, update it to `multi_edit` (or match via `isMultiEditToolName`) when upgrading.

The `multiedit` spelling will be removed in a future major release. If you hardcode the tool name anywhere (registries, allowlists, permission hooks, log filters), migrate to `multi_edit` or match via `isMultiEditToolName`.
