# @agent-sh/harness-websearch

Web search for AI agent harnesses, backed by a self-hosted SearXNG instance — tool-layer SSRF defense, declarative provider-neutral query controls, a result-count cap, and a discriminated result surface.

Part of the [`@agent-sh/harness-*`](https://github.com/avifenesh/tools) monorepo — see the top-level README for architectural context and the full tool surface. WebSearch finds URLs; [`webfetch`](../webfetch) reads them. They compose.

## Install

```sh
npm install @agent-sh/harness-websearch
```

Requires Node ≥ 20.

## Usage

```ts
import { websearch } from "@agent-sh/harness-websearch";

const session = {
  permissions: { roots: [], sensitivePatterns: [], unsafeAllowSearchWithoutHook: true },
  searxngUrl: "http://127.0.0.1:8888",
  allowLoopback: true, // self-hosted SearXNG is usually on localhost
};

const r = await websearch({ query: "rust async runtime benchmarks", count: 5 }, session);
```

## Contract

The full contract — input shape, output discriminated-union, error codes, permission model, and acceptance tests — lives in [`agent-knowledge/design/websearch.md`](https://github.com/avifenesh/tools/blob/main/agent-knowledge/design/websearch.md). Changes to this package must stay in sync with that spec.

## License

MIT © Avi Fenesh
