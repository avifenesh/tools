import { SNIPPET_CAP } from "./constants.js";
import type {
  EngineClass,
  SearchMetadata,
  WebSearchResultItem,
} from "./types.js";

/**
 * Output format (v0.5) — compact ranked plain text, the shape LLM-facing
 * search APIs (Tavily/Brave/Anthropic/Exa) converge on. Design goals:
 * - One short header line, not a multi-line XML block (saves ~30 tokens/call).
 * - Rank order IS the relevance signal; per-result metadata (age) appears only
 *   when the backend actually provides it — we never fabricate freshness.
 * - Honest recency: if a time_range was requested but the serving engine
 *   ignored it, the header says so instead of mislabeling all-time results.
 * - An engine-class label tells the model whether it got broad web results or
 *   a niche/encyclopedic fallback, so it can judge sufficiency.
 *
 * The discriminated `kind` (ok/empty/error) is unchanged — only the text the
 * model reads is redesigned.
 */

/** Human/model-readable label for an engine's coverage class. */
export function engineClassLabel(c: EngineClass | undefined): string {
  switch (c) {
    case "general":
      return "general web";
    case "niche":
      return "indie/small-web index";
    case "vertical":
      return "encyclopedic";
    default:
      return "web";
  }
}

/**
 * The single compact header line, shared by ok/empty. Example:
 *   WEB "rust async" · mojeek (general web) · 5 results
 * Merged across engines:
 *   WEB "rust async" · mojeek+marginalia (general web) · 5 results
 * With an ignored time filter:
 *   WEB "ai news" · marginalia (indie/small-web index) · 3 results · time:week NOT applied (this engine ignores it)
 */
function headerLine(meta: SearchMetadata, n: number): string {
  const parts: string[] = [`WEB "${meta.query}"`];
  const engineName =
    meta.engines !== undefined && meta.engines.length > 1
      ? meta.engines.join("+")
      : meta.engine;
  const via =
    engineName !== undefined && engineName.length > 0
      ? `${engineName} (${engineClassLabel(meta.engineClass)})`
      : meta.backendHost;
  parts.push(via);
  parts.push(`${n} result${n === 1 ? "" : "s"}`);
  // Honest recency: only mention time filtering when one was requested.
  if (meta.timeRange !== "all") {
    if (meta.timeRangeApplied === true) {
      parts.push(`time:${meta.timeRange}`);
    } else if (meta.timeRangeApplied === false) {
      parts.push(
        `time:${meta.timeRange} NOT applied (this engine ignores it; results are all-time)`,
      );
    }
  }
  return parts.join(" · ");
}

export function formatOkText(args: {
  meta: SearchMetadata;
  results: readonly WebSearchResultItem[];
  requested: number;
  snippetCap?: number;
}): string {
  const cap = args.snippetCap ?? SNIPPET_CAP;
  const header = headerLine(args.meta, args.results.length);
  const numbered = args.results
    .map((r, i) => {
      // Line 2: url, then optional source (when results were merged across
      // engines) and age (when the backend provided it).
      const tags: string[] = [];
      if (r.source !== undefined && r.source.length > 0) tags.push(r.source);
      if (r.age !== undefined && r.age.length > 0) tags.push(r.age);
      const meta = tags.length > 0 ? ` · ${tags.join(" · ")}` : "";
      const snippet = trimSnippet(r.snippet, cap);
      const snippetLine = snippet.length > 0 ? `\n   ${snippet}` : "";
      return `${i + 1}. ${r.title}\n   ${r.url}${meta}${snippetLine}`;
    })
    .join("\n");
  const n = args.results.length;
  let hint: string;
  if (n < args.requested) {
    hint = `(Only ${n} of ${args.requested} requested. Broaden the query or widen time_range; or fetch a URL with webfetch to read it.)`;
  } else {
    hint = `(Fetch a URL with webfetch to read the page.)`;
  }
  return `${header}\n${numbered}\n${hint}`;
}

export function formatEmptyText(meta: SearchMetadata): string {
  const header = headerLine(meta, 0);
  const hint = `(No results. Try different/broader keywords${
    meta.timeRange !== "all" ? ", a wider time_range," : ""
  } or fetch a known URL with webfetch.)`;
  return `${header}\n${hint}`;
}

/**
 * Back-compat: the old `<search>…</search>` block renderer. Kept exported (it
 * was a public export) but no longer used by the default format. Returns the
 * compact header line now.
 */
export function renderSearchBlock(meta: SearchMetadata): string {
  return headerLine(meta, meta.count);
}

function trimSnippet(snippet: string, cap: number): string {
  const collapsed = snippet.replace(/\s+/g, " ").trim();
  if (collapsed.length <= cap) return collapsed;
  return collapsed.slice(0, cap) + "…";
}
