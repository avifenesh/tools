---
"@agent-sh/harness-read": minor
"@agent-sh/harness-write": minor
"@agent-sh/harness-grep": minor
"@agent-sh/harness-bash": minor
"@agent-sh/harness-tools": minor
---

Harness tool hardening — fixes for failure modes surfaced by real-model use.

- **tools**: wire a shared per-process `InMemoryLedger` into the read and
  write/edit sessions. Previously neither session carried a ledger, so Read
  recorded nothing and every Edit/Write hit `NOT_READ_THIS_SESSION` and
  hard-denied — pushing models to fall back to `cat`/`sed` via Bash. The
  read-before-edit gate now works as designed.
- **write**: preserve the file's original line endings (and BOM) on edit. Edits
  matched on CRLF→LF-normalized content but wrote the normalized (LF) bytes back,
  silently converting CRLF files to LF. Matching stays normalized; output keeps
  the file's convention.
- **write**: the read-gate now fails open per Read spec D11 — a missing ledger
  entry asks the permission hook (deny only on explicit deny) or proceeds with a
  warning when no hook is wired, instead of a hard deny. `STALE_READ` stays hard.
- **read**: read the file once for both content and sha256 (was reading twice);
  remove env-gated debug `console.error` from shipped source.
- **grep**: add `fixed_strings` for literal search (ripgrep `-F`), skipping the
  regex compile-probe; `INVALID_REGEX` now points to it as the escape-free path.
- **bash**: tool description steers stalling network calls (curl/wget) to
  `background: true` or an explicit client timeout, alongside servers/watchers.
