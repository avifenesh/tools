# Self-Contained Web Search Backends — Research & Recommendation

**Generated**: 2026-06-14
**Status**: Research input for a `websearch` v2 (self-contained default). Feeds `agent-knowledge/design/websearch.md`.
**Author note**: Findings below combine a live-web survey with **first-hand endpoint probes run from this machine** (a datacenter-class IP, no residential proxy, plain `GET`s). The probe results are the authoritative part — they show what actually happens *today*, not what blog posts claim.

---

## 0. The problem statement

The shipped `websearch` tool (TS `packages/websearch`, Rust `crates/websearch`) is **SearXNG-only**. It hard-fails unless the harness sets `session.searxngUrl`:

```
INVALID_PARAM: no search backend configured; set session.searxngUrl
```

That is the "depends on something external" gap: every user must stand up (or point at) a SearXNG instance before search works at all. We want a **self-contained** default: search that works out of the box, with **no API key and no self-hosted service**, while keeping the existing pluggable-engine architecture intact.

Good news: the architecture is already right. There is a `WebSearchEngine` interface (TS `types.ts`, Rust `engine.rs`) with one default impl that talks to SearXNG. "Self-contained" is therefore **a new default engine (or a fallback chain of bundled engines)**, not a rewrite.

---

## 1. Live probe results (the ground truth)

Each row is an actual request I made during this research. "Result" is the real HTTP status + what came back.

| Backend | Endpoint probed | Result | Verdict for a keyless default |
|---|---|---|---|
| **DuckDuckGo HTML** | `GET html.duckduckgo.com/html/?q=…` | **202** + anomaly CAPTCHA page ("Select all squares containing a duck") | ❌ Blocked from datacenter IPs |
| **DuckDuckGo Lite** | `GET lite.duckduckgo.com/lite/?q=…` | **202** + same CAPTCHA | ❌ Blocked (endpoint still exists; it just challenges) |
| **DuckDuckGo IA API** | `GET api.duckduckgo.com/?q=…&format=json` | **202** (also challenged); body is instant-answer JSON, `Results: []` | ❌ Not web search anyway (instant answers only), and now rate-challenged |
| **Mojeek** | `GET www.mojeek.com/search?q=…` | **200**, clean parseable HTML SERP, real full-web results | ✅ Works keyless; independent index. ToS caveat (see §3) |
| **Marginalia public API** | `GET api.marginalia.nu/public/search/<q>?count=5` | **200**, clean JSON (`results:[{url,title,description,quality,…}]`) | ✅ Works keyless; **documented public API**; niche index |
| **Marginalia frontend** | `GET search.marginalia.nu/search?query=…&format=json` | **200** but HTML (the `format=json` on the *frontend* is ignored) | ⚠️ Use the API host, not the frontend |
| **Wikipedia / MediaWiki** | `GET en.wikipedia.org/w/api.php?action=query&list=search&srsearch=…&format=json` | **200**, clean JSON | ✅ Works keyless; encyclopedic only |
| **Public SearXNG (searx.be)** | `GET searx.be/search?q=…&format=json` | **403 Forbidden** | ❌ Public instances block JSON/bots — confirms "don't rely on public SearXNG" |
| **Brave Search (web UI)** | `GET search.brave.com/search?q=…` | **200**, but a giant SvelteKit SPA with hashed classnames (`svelte-14r20fy`); results *are* in initial HTML | ⚠️ Scrapable but brittle. Brave has an official **API** with a free tier — use that instead of scraping |

### What this means
- **DuckDuckGo is effectively dead for a self-contained tool.** Every DDG surface (html, lite, even the IA API) returned `202` with a bot challenge from a normal server IP. The entire Python ecosystem (`ddgs`, LangChain, smolagents, …) leans on DDG, but it only works reliably from residential IPs with a full browser header dance and low rate — exactly the conditions an agent harness shipped to many users cannot guarantee. Building our default on DDG would reproduce the fragility we're trying to escape.
- **Two keyless backends actually work right now from a hostile IP: Mojeek (HTML) and Marginalia (JSON API).** Plus Wikipedia for factual queries.
- **Public SearXNG is not a fallback** — `searx.be` flatly 403s JSON. Self-hosted SearXNG stays a power-user option, not a default.

---

## 2. The candidate backends, characterized

### Tier 1 — keyless, no self-host, working today (ship these bundled)

**Marginalia public API** — `https://api.marginalia.nu/public/search/{query}?count={n}`
- Keyless JSON. Response: `{ query, results: [{ url, title, description, quality, ... }] }` → maps 1:1 to our `{title,url,snippet}`.
- It is an *actual public API* (not scraping a SERP), so it's the most ToS-clean keyless option. License on results: CC-BY-NC-SA 4.0 (non-commercial; fine for an agent reading them, relevant if results are redistributed).
- Index is niche: "small web", blogs, forums, docs, text-first content. Excellent for technical/indie queries; **weak on mainstream, commercial, and very-recent results**. There is also a key'd `api2.marginalia-search.com` for higher limits; the public host shares a rate budget and 503s when drained.

**Mojeek** — `https://www.mojeek.com/search?q={query}`
- Keyless HTML SERP, **independent full-web crawl** (not a Google/Bing reseller), clean simple markup (`<li class="r1">…<a class="title">…<p class="s">snippet`). Good mainstream coverage. Easy to parse and historically stable HTML.
- Caveat: `robots.txt` disallows `/search` (see §3). They sell an official API (keyed, contact-sales) — scraping the HTML SERP is a ToS gray area.

**Wikipedia / MediaWiki** — `https://{lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch={q}&format=json`
- Keyless, rock-solid JSON, ~200 req/min with a descriptive User-Agent. Encyclopedic only. Best as a *supplementary* engine for factual/entity queries and as a never-fails fallback, not the primary web index.

### Tier 2 — keyed but free tier, reliable & sanctioned (the "upgrade" path)

**Brave Search API** — `GET https://api.search.brave.com/res/v1/web/search?q=…` with `X-Subscription-Token`. Free tier ~2,000 queries/month, self-serve signup, no credit card. Has a `/res/v1/web/llm-context` endpoint purpose-built for agents. **Best official option.**

**Tavily** — `POST https://api.tavily.com/search`. ~1,000 free credits/month, results pre-cleaned for LLMs (what gpt-researcher defaults to).

Both are official APIs (no ToS risk, no anti-bot fragility). They need a key, so they can't be the zero-config default — but they're the obvious first upgrade and should be first-class bundled engines gated on an env var / session field.

### Tier 3 — power-user / niche
- **Self-hosted SearXNG** — keep the existing engine. Best quality+privacy if the user runs it. Not a default (requires Docker).
- **Mojeek / Bing / Google CSE keyed APIs** — adapters if demand shows. (Google CSE is closed to new customers, sunset Jan 2027 — skip.)
- **Jina Reader** (`r.jina.ai`) — not search; keyless URL→markdown. Complements `webfetch`, not `websearch`.

---

## 3. Legal / ToS caveats (must be in the design doc)

- **Scraping HTML SERPs (Mojeek, Brave web UI, DDG) is a ToS gray area.** Mojeek's `robots.txt` disallows `/search`; Brave/DDG oppose automated scraping. For a tool we *ship to many users*, leaning on scraping means (a) we may break their ToS at scale and (b) we inherit anti-bot fragility.
- **Marginalia's public API is explicitly public**, so it's the cleanest keyless choice — but NC-licensed and niche.
- **Official APIs (Brave/Tavily) are the only fully-sanctioned path.** This argues for: zero-config keyless default that is *good enough* (Marginalia + Wikipedia, optionally Mojeek), with a prominent, low-friction nudge to add a free Brave/Tavily key for production reliability — exactly mirroring how the existing error messages already nudge.
- Keep the existing **prompt-injection framing** (snippets are data, not instructions) and **SSRF posture** unchanged; a self-contained engine hits fixed public hosts, so SSRF is simpler (the hosts are known), but the per-redirect / DNS-rebinding checks from `webfetch` still apply if we ever follow result URLs.

---

## 4. What OSS harnesses actually default to (for context)

- **smolagents / LangChain / LlamaIndex / CrewAI / open-webui / Auto-GPT**: default to DuckDuckGo via the `duckduckgo-search` → now `ddgs` package. `ddgs` v9 quietly became a **multi-engine metasearch** (`backend="auto"` across Bing/Brave/Google/Mojeek/Startpage/Yandex/Wikipedia) precisely because single-engine DDG kept breaking. **The lesson: a fallback chain, not one engine.**
- **gpt-researcher**: defaults to Tavily (key required) — prioritizes quality over zero-config.
- **Khoj / Perplexica**: bundle SearXNG in Docker — reliable but requires self-host.

Nobody has a single keyless backend that is reliable + good + zero-config. The pragmatic state of the art is **a fallback chain of several backends**.

---

## 5. Recommendation for this repo

**Make `websearch` self-contained by shipping bundled engines + a fallback chain, behind the existing `WebSearchEngine` interface. No new mandatory config.**

### 5.1 New engines (all behind the existing interface)
1. `MarginaliaEngine` — keyless public JSON API. **The zero-config default.** Pure JSON, trivial to map, ToS-clean.
2. `WikipediaEngine` — keyless JSON. Factual fallback / supplement; effectively never fails.
3. `MojeekEngine` — keyless HTML SERP parse for full-web coverage. Reuses `webfetch`'s fetch + (light) HTML-extraction muscle. Flagged as scrape-based (ToS gray) and disable-able.
4. `BraveEngine`, `TavilyEngine` — official keyed APIs; activate when `session.braveApiKey` / `TAVILY_API_KEY` present. The reliable upgrade.
5. Keep `SearxngEngine` (current default) for power users.

### 5.2 A `FallbackEngine` (mirrors `ddgs backend="auto"`)
Ordered try-list, first non-empty wins, with per-engine cooldown on failure and an annotation in the result of which backend actually served it. Default order when nothing is configured:

```
Brave/Tavily (if key) → SearXNG (if searxngUrl) → Mojeek → Marginalia → Wikipedia → actionable error
```

If no key and no searxngUrl (the bare case), the chain is `Mojeek → Marginalia → Wikipedia`, so it **just works**.

### 5.3 The one breaking change
Drop the hard `no search backend configured` failure. With no config, default to the keyless chain instead of erroring. The error message stays as the *final* fallback and should nudge: *"All keyless backends are rate-limited or returned nothing. For reliable results, set a free Brave Search API key (api-dashboard.search.brave.com) or run a local SearXNG."*

### 5.4 Why this fits
- **Zero new dependencies in the common case** — Marginalia/Wikipedia are JSON over the same HTTP client already used (`undici` / `reqwest`); only Mojeek needs HTML parsing, and `webfetch` already pulls in readability/turndown we can borrow from.
- **Keeps every existing invariant**: discriminated `ok`/`empty`/`error`, count cap, prompt-injection wording, permission hook, SSRF defense. The output contract doesn't change; only *where results come from* changes.
- **Cross-language parity stays cheap**: each engine is the same small "build request → parse → map to `{title,url,snippet}`" shape already present in `engine.ts` / `engine.rs`.
- **It's the proven pattern** (ddgs `auto`) adapted to keyless-first backends that we *verified work today*.

### 5.5 Open design questions (for AskUserQuestion before coding)
1. Default chain ordering, and whether Mojeek (scrape, ToS-gray) is **on** by default or opt-in.
2. Whether to keep results' provenance visible to the model (`backend=marginalia`) — argues yes for transparency.
3. Whether `count`-mixing across engines (merge+dedupe) is worth it, or strictly first-engine-wins.
4. License surfacing for Marginalia (NC) results.
5. Snippet quality normalization across very different sources (Marginalia descriptions vs Mojeek snippets vs Wikipedia extracts).

---

## 6. Concrete request/response recipes (verified)

**Marginalia (keyless JSON):**
```
GET https://api.marginalia.nu/public/search/rust%20async%20runtime?count=5
→ 200 { "query":"…", "results":[ { "url":"…", "title":"…", "description":"…", "quality":3.31, … } ] }
map: title←title, url←url, snippet←description
```

**Wikipedia (keyless JSON):**
```
GET https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=rust%20async%20runtime&format=json&srlimit=5
  (header: User-Agent: agent-sh-harness-websearch/x.y (contact))
→ 200 { "query": { "search": [ { "title":"…", "snippet":"…<span class=searchmatch>…", "pageid":29414838 } ] } }
map: title←title, url←`https://en.wikipedia.org/?curid=${pageid}`, snippet←strip-tags(snippet)
```

**Mojeek (keyless HTML — parse, don't JSON):**
```
GET https://www.mojeek.com/search?q=rust+async+runtime+benchmarks
→ 200 HTML; results under  <ul class="results-standard"> :
   <li class="r1"><a class="title" href="URL">TITLE</a> … <p class="s">SNIPPET</p></li>
map: title←a.title text, url←a.title href, snippet←p.s text
ToS: robots.txt disallows /search — flag as scrape-based.
```

**Brave API (keyed — the upgrade):**
```
GET https://api.search.brave.com/res/v1/web/search?q=…&count=5
  header: X-Subscription-Token: <key>
→ 200 { "web": { "results": [ { "title", "url", "description" } ] } }
```

---

## 7. References
- `agent-knowledge/design/websearch.md` — current spec (SearXNG-only); §10 already anticipates pluggable engines + Brave/Tavily adapters as v2.
- `agent-knowledge/design/webfetch.md` — fetch + readability/markdown extraction we can reuse for the Mojeek HTML engine.
- `packages/websearch/src/engine.ts`, `crates/websearch/src/engine.rs` — the `WebSearchEngine` interface a self-contained engine plugs into.
- `ddgs` (github.com/deedy5/ddgs) — multi-engine `backend="auto"` fallback pattern.
- Brave Search API (api-dashboard.search.brave.com), Tavily (app.tavily.com), Marginalia (api.marginalia.nu/public/, github.com/MarginaliaSearch), MediaWiki API (mediawiki.org/wiki/API:Search), Mojeek API (mojeek.com/support/api).
