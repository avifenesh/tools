import { request } from "undici";
import type {
  WebSearchEngine,
  WebSearchEngineInput,
  WebSearchEngineResult,
  WebSearchResultItem,
  WebSearchSafeSearch,
} from "./types.js";

/**
 * Default WebSearch engine built on undici.
 *
 * Design choices:
 * - Build the SearXNG JSON request from the declarative params; the model
 *   never sees the backend DSL.
 * - Re-run the SSRF check on the resolved backend host before dialing.
 * - Map the backend's non-2xx status onto engine-local error codes the
 *   orchestrator translates to a ToolError.
 * - Truncation to `count` is the orchestrator's job; the engine returns
 *   the full parsed result list in backend order.
 */
export function createDefaultEngine(): WebSearchEngine {
  return {
    async search(
      input: WebSearchEngineInput,
    ): Promise<WebSearchEngineResult> {
      const base = safeParseUrl(input.backendUrl);
      if (!base) {
        throw new SearchError(
          "IO_ERROR",
          `Invalid backend URL: ${input.backendUrl}`,
        );
      }
      await input.checkHost(base.hostname);

      const url = buildSearchUrl(base, input);
      const started = Date.now();

      const res = await request(url.toString(), {
        method: "GET",
        headers: input.headers,
        signal: input.signal,
        bodyTimeout: input.timeoutMs,
        headersTimeout: input.timeoutMs,
      });

      const status = res.statusCode;
      if (status >= 400) {
        // Drain so the connection can recycle.
        await res.body.dump();
        if (status >= 500) {
          throw new SearchError(
            "SERVER_NOT_AVAILABLE",
            `Search backend returned HTTP ${status}`,
            { status },
          );
        }
        throw new SearchError(
          "INVALID_PARAM",
          `Search backend rejected the query with HTTP ${status}`,
          { status },
        );
      }

      let parsed: unknown;
      try {
        parsed = await res.body.json();
      } catch (e) {
        throw new SearchError(
          "IO_ERROR",
          `Could not parse the search backend response as JSON: ${(e as Error).message}`,
        );
      }

      const results = mapResults(parsed);
      return {
        results,
        backendHost: base.hostname,
        elapsedMs: Date.now() - started,
      };
    },
  };
}

// ---- helpers ----

function buildSearchUrl(base: URL, input: WebSearchEngineInput): URL {
  // Append /search to the configured base, preserving any base path.
  const url = new URL(base.toString());
  url.pathname = joinPath(url.pathname, "search");
  const p = url.searchParams;
  p.set("q", input.query);
  p.set("format", "json");
  p.set("safesearch", String(safeSearchToNumeric(input.safeSearch)));
  // "all" omits the time_range param (SearXNG treats absent as all-time).
  if (input.timeRange !== "all") {
    p.set("time_range", input.timeRange);
  }
  p.set("language", input.language);
  p.set("categories", input.categories.join(","));
  p.set("pageno", "1");
  return url;
}

function joinPath(basePath: string, segment: string): string {
  const trimmed = basePath.replace(/\/+$/, "");
  return `${trimmed}/${segment}`;
}

function safeSearchToNumeric(s: WebSearchSafeSearch): 0 | 1 | 2 {
  switch (s) {
    case "off":
      return 0;
    case "moderate":
      return 1;
    case "strict":
      return 2;
  }
}

function mapResults(parsed: unknown): WebSearchResultItem[] {
  if (parsed === null || typeof parsed !== "object") return [];
  const raw = (parsed as { results?: unknown }).results;
  if (!Array.isArray(raw)) return [];
  const out: WebSearchResultItem[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as { title?: unknown; url?: unknown; content?: unknown };
    const title = typeof e.title === "string" ? e.title : "";
    const url = typeof e.url === "string" ? e.url : "";
    // Missing title/url → skip (per spec §7.2).
    if (title.length === 0 || url.length === 0) continue;
    const snippet = typeof e.content === "string" ? e.content : "";
    out.push({ title, url, snippet });
  }
  return out;
}

function safeParseUrl(u: string): URL | null {
  try {
    return new URL(u);
  } catch {
    return null;
  }
}

/**
 * Engine-internal error class. The orchestrator catches and translates
 * these into tool errors; keeping them inside the engine means the
 * engine interface returns a plain Promise<WebSearchEngineResult> without
 * a union return shape.
 */
export class SearchError extends Error {
  constructor(
    public readonly code:
      | "INVALID_PARAM"
      | "SERVER_NOT_AVAILABLE"
      | "DNS_ERROR"
      | "TLS_ERROR"
      | "TIMEOUT"
      | "CONNECTION_RESET"
      | "IO_ERROR",
    message: string,
    public readonly meta?: Record<string, unknown>,
  ) {
    super(message);
  }
}
