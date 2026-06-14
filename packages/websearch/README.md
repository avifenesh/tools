# @agent-sh/harness-websearch

Web search for AI agent harnesses — **works with no API key and no setup**. With nothing configured it queries a bundled keyless fallback chain (Mojeek → Marginalia → Wikipedia) and returns the first backend that has results. Optionally upgrade to Brave/Tavily (API key) or a self-hosted SearXNG for higher coverage — same tool, same output. Tool-layer SSRF defense, declarative provider-neutral query controls, a result-count cap, engine provenance, and a discriminated result surface.

Part of the [`@agent-sh/harness-*`](https://github.com/avifenesh/tools) monorepo — see the top-level README for architectural context and the full tool surface. WebSearch finds URLs; [`webfetch`](../webfetch) reads them. They compose.

## Install

```sh
npm install @agent-sh/harness-websearch
```

Requires Node ≥ 20.

## Usage

Zero-config — keyless, just works:

```ts
import { websearch } from "@agent-sh/harness-websearch";

const session = {
  permissions: { roots: [], sensitivePatterns: [], unsafeAllowSearchWithoutHook: true },
};

const r = await websearch({ query: "rust async runtime benchmarks", count: 5 }, session);
// r.meta.engine tells you which backend served the results (e.g. "mojeek").
```

Upgrade to a reliable keyed provider, or a self-hosted SearXNG:

```ts
// Brave (recommended; free tier at api-dashboard.search.brave.com):
const braveSession = { ...session, braveApiKey: process.env.BRAVE_API_KEY };

// Self-hosted SearXNG (loopback opt-in since it's usually on localhost):
const searxngSession = { ...session, searxngUrl: "http://127.0.0.1:8888", allowLoopback: true };

// An explicit backend is exclusive by default; opt into the keyless tail as a backstop:
const withFallback = { ...braveSession, fallbackToKeyless: true };
```

Notes:
- `disableMojeek: true` drops the Mojeek scrape engine (its robots.txt disallows `/search`; the documented Marginalia/Wikipedia APIs remain).
- Zero hits is a normal `kind: "empty"` result, not an error.

## Contract

The full contract — input shape, output discriminated-union, error codes, permission model, and acceptance tests — lives in [`agent-knowledge/design/websearch.md`](https://github.com/avifenesh/tools/blob/main/agent-knowledge/design/websearch.md). Changes to this package must stay in sync with that spec.

## License

MIT © Avi Fenesh
