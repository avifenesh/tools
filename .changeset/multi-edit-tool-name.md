---
"@agent-sh/harness-write": minor
"@agent-sh/harness-tools": minor
---

Rename the MultiEdit tool's canonical name from `multiedit` to `multi_edit`, matching the `multiEdit` entry point and the snake_case convention of the other multi-word tool names (`bash_output`, `bash_kill`).

**Deprecation, not removal** — the old spelling keeps working during a migration window:

- `MULTIEDIT_TOOL_NAME` is now `"multi_edit"`; `multieditToolDefinition.name` follows it, so registries pick up the new name on upgrade.
- The old spelling is still exported as `MULTIEDIT_TOOL_NAME_LEGACY` (`"multiedit"`, marked `@deprecated`).
- New `isMultiEditToolName(name)` dispatch helper accepts both spellings and emits a one-time `DeprecationWarning` per process when it sees the legacy one (`warnLegacyMultiEditToolName()` is also exported directly).
- The pi extension in `@agent-sh/harness-tools` now registers the tool as `multi_edit`.
- Permission hooks now receive `tool: "multi_edit"` for MultiEdit calls.

The `multiedit` spelling will be removed in a future major release. If you hardcode the tool name anywhere (registries, allowlists, permission hooks, log filters), migrate to `multi_edit` or match via `isMultiEditToolName`.
