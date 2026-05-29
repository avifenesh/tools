# harness-websearch

Declarative web search via a session-configured SearXNG backend, with tool-layer SSRF defense, a permission hook, a result-count cap, and a discriminated `ok`/`empty`/`error` result surface.

Rust port of [`@agent-sh/harness-websearch`](https://www.npmjs.com/package/@agent-sh/harness-websearch). Part of the [`harness-*`](https://github.com/avifenesh/tools) monorepo — see the top-level README for architectural context. WebSearch finds; [`webfetch`](https://github.com/avifenesh/tools/tree/main/crates/webfetch) reads — they compose.

## Install

```toml
[dependencies]
harness-websearch = "0.1"
```

## Usage

```rust
use harness_websearch::{websearch, WebSearchSessionConfig, WebSearchPermissionPolicy, default_engine};
use harness_core::PermissionPolicy;
use serde_json::json;

let perms = WebSearchPermissionPolicy::new(PermissionPolicy::new(vec![]))
    .with_unsafe_bypass(true);
let mut session = WebSearchSessionConfig::new(perms, default_engine())
    .with_searxng_url("http://127.0.0.1:8888");
session.allow_loopback = true; // a self-hosted SearXNG usually runs on localhost
let r = websearch(json!({ "query": "rust async runtime benchmarks" }), &session).await;
```

## Contract

The full contract lives in [`agent-knowledge/design/websearch.md`](https://github.com/avifenesh/tools/blob/main/agent-knowledge/design/websearch.md). Changes to this crate must stay in sync with that spec, and with the TypeScript sibling at [`@agent-sh/harness-websearch`](https://www.npmjs.com/package/@agent-sh/harness-websearch).
