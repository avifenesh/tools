---
"@agent-sh/harness-websearch": minor
---

Exa and Parallel lead the keyless chain.

With nothing configured, `websearch` now tries Exa, then Parallel, before Mojeek, Marginalia and Wikipedia. Both run their own web indexes and are reached through their official keyless MCP endpoints, so the default no longer leads with a scrape that bot-blocks.

- New engines `exa` and `parallel`. They take optional `exaApiKey` / `parallelApiKey` to raise their rate limits and can be opted out with `disableExa` / `disableParallel`.
- Their long page excerpts are reduced to the passage that matches the query, skipping page chrome, before the snippet cap applies. TS and Rust pick the same passage.
- New harness-only `engineOrder` session option sets the exact engine chain (for example, AI indexes ahead of a self-hosted SearXNG). Invalid names or missing keys fail with `INVALID_PARAM`.
- Any MCP-level failure (HTTP error, JSON-RPC error, `isError` result) is `SERVER_NOT_AVAILABLE`, never `INVALID_PARAM`.
- Behavior change: the zero-config chain sends the query to Exa and Parallel first. Set `disableExa` / `disableParallel` to keep the previous order.

The Rust crate (`harness-websearch`) is updated at parity.
