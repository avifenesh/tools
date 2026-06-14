import type {
  WebSearchEngine,
  WebSearchEngineInput,
  WebSearchEngineResult,
  WebSearchResultItem,
  WebSearchTimeRange,
} from "../types.js";
import { stripTags } from "./html.js";
import { httpGet } from "./http.js";
import { SearchError } from "./searchError.js";

const DEFAULT_BASE = "https://api.search.brave.com";
const ENGINE_NAME = "brave";

/**
 * Brave Search API — keyed, the best officially-sanctioned upgrade (free
 * tier ~2k queries/month, no credit card). Activated when the session
 * provides `braveApiKey`. No ToS/anti-bot fragility, unlike the keyless
 * scrape engines.
 *
 *   GET https://api.search.brave.com/res/v1/web/search?q=…&count=…
 *       header: X-Subscription-Token: <key>
 *   → { web: { results: [{ title, url, description }] } }
 *
 * @param apiKey the Brave subscription token (from session.braveApiKey).
 * @param opts.baseUrl override the API host for tests.
 */
export function createBraveEngine(
  apiKey: string,
  opts: { baseUrl?: string } = {},
): WebSearchEngine & { readonly name: string } {
  const base = opts.baseUrl ?? DEFAULT_BASE;
  return {
    name: ENGINE_NAME,
    async search(
      input: WebSearchEngineInput,
    ): Promise<WebSearchEngineResult> {
      const url = new URL(base);
      url.pathname = joinPath(url.pathname, ["res", "v1", "web", "search"]);
      const p = url.searchParams;
      p.set("q", input.query);
      p.set("count", String(input.count));
      if (input.safeSearch !== "moderate") {
        p.set("safesearch", input.safeSearch === "strict" ? "strict" : "off");
      }
      const freshness = toBraveFreshness(input.timeRange);
      if (freshness) p.set("freshness", freshness);

      // Brave's auth header is merged on top of the session headers.
      const headers = { ...input.headers, "x-subscription-token": apiKey };

      const res = await httpGet(
        url,
        { ...input, headers },
        { accept: "application/json", engine: ENGINE_NAME },
      );

      let parsed: unknown;
      try {
        parsed = JSON.parse(res.text);
      } catch (e) {
        throw new SearchError(
          "IO_ERROR",
          `brave: could not parse response as JSON: ${(e as Error).message}`,
          { engine: ENGINE_NAME },
        );
      }
      return {
        results: mapResults(parsed),
        backendHost: res.host,
        elapsedMs: res.elapsedMs,
      };
    },
  };
}

function toBraveFreshness(range: WebSearchTimeRange): string | null {
  switch (range) {
    case "day":
      return "pd";
    case "week":
      return "pw";
    case "month":
      return "pm";
    case "year":
      return "py";
    case "all":
      return null;
  }
}

function mapResults(parsed: unknown): WebSearchResultItem[] {
  if (parsed === null || typeof parsed !== "object") return [];
  const web = (parsed as { web?: unknown }).web;
  if (web === null || typeof web !== "object") return [];
  const raw = (web as { results?: unknown }).results;
  if (!Array.isArray(raw)) return [];
  const out: WebSearchResultItem[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as {
      title?: unknown;
      url?: unknown;
      description?: unknown;
    };
    const title = typeof e.title === "string" ? stripTags(e.title) : "";
    const url = typeof e.url === "string" ? e.url : "";
    if (title.length === 0 || url.length === 0) continue;
    const snippet =
      typeof e.description === "string" ? stripTags(e.description) : "";
    out.push({ title, url, snippet });
  }
  return out;
}

function joinPath(basePath: string, segments: string[]): string {
  const trimmed = basePath.replace(/\/+$/, "");
  return `${trimmed}/${segments.join("/")}`;
}
