import type {
  PermissionPolicy,
  ToolError,
} from "@agent-sh/harness-core";

export type WebSearchTimeRange = "day" | "week" | "month" | "year" | "all";
export type WebSearchSafeSearch = "off" | "moderate" | "strict";

export interface WebSearchParams {
  readonly query: string;
  readonly count?: number | undefined;
  readonly time_range?: WebSearchTimeRange | undefined;
  readonly language?: string | undefined;
  readonly safe_search?: WebSearchSafeSearch | undefined;
  readonly categories?: readonly string[] | undefined;
}

export interface WebSearchResultItem {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

/**
 * Pluggable engine: issues one search against the configured backend and
 * returns a ranked result list. The engine is the place to swap to a
 * keyed provider (Brave/Tavily adapter) behind the same interface.
 */
export interface WebSearchEngineInput {
  readonly backendUrl: string;
  readonly query: string;
  readonly count: number;
  readonly timeRange: WebSearchTimeRange;
  readonly language: string;
  readonly safeSearch: WebSearchSafeSearch;
  readonly categories: readonly string[];
  readonly timeoutMs: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  /** Called before the request with the resolved backend host; throws to abort (SSRF). */
  readonly checkHost: (host: string) => Promise<void>;
}

export interface WebSearchEngineResult {
  readonly results: readonly WebSearchResultItem[];
  readonly backendHost: string;
  readonly elapsedMs: number;
  /** Which engine served this result (provenance), e.g. "mojeek". */
  readonly engine?: string;
}

export interface WebSearchEngine {
  search(input: WebSearchEngineInput): Promise<WebSearchEngineResult>;
}

/**
 * Engine coverage class, used by the fallback chain to decide whether an
 * `empty` result is authoritative:
 * - "general": broad web index (Mojeek, Brave, Tavily, SearXNG). An empty
 *   from one of these is a trustworthy "the web had nothing" signal.
 * - "niche": small/indie index (Marginalia) — an empty here says little.
 * - "vertical": single-domain index (Wikipedia) — empty says even less.
 * A niche/vertical-only empty while a general engine ERRORED is treated as a
 * degraded failure (search broke), not a clean empty, so the model retries
 * instead of concluding nothing exists.
 */
export type EngineClass = "general" | "niche" | "vertical";

/** An engine that knows its own name + class, for the fallback chain. */
export interface NamedWebSearchEngine extends WebSearchEngine {
  readonly name: string;
  readonly engineClass: EngineClass;
}

/**
 * Session-bound policy. The SSRF knobs default to the safest values
 * (all false); per-harness callers flip as needed — for WebSearch,
 * allowLoopback is the routine opt-in (self-hosted SearXNG on localhost).
 */
export interface WebSearchPermissionPolicy extends PermissionPolicy {
  readonly unsafeAllowSearchWithoutHook?: boolean;
}

export interface WebSearchSessionConfig {
  readonly permissions: WebSearchPermissionPolicy;
  /**
   * Base URL of a self-hosted SearXNG instance, e.g. http://127.0.0.1:8888.
   * Optional: when set, SearXNG is preferred at the head of the fallback
   * chain. When unset, the tool falls back to the bundled keyless engines
   * (Mojeek → Marginalia → Wikipedia) so search works with no config.
   */
  readonly searxngUrl?: string;
  /**
   * Brave Search API key (X-Subscription-Token). When set, the Brave engine
   * leads the chain — the recommended reliable upgrade for production.
   * api-dashboard.search.brave.com (free tier, no card).
   */
  readonly braveApiKey?: string;
  /** Tavily API key. When set, the Tavily engine joins the head of the chain. */
  readonly tavilyApiKey?: string;
  /**
   * Drop the Mojeek scrape engine from the default chain. Mojeek's robots.txt
   * disallows /search (ToS gray area); set true to use only the documented
   * APIs (Marginalia/Wikipedia + any keyed engine).
   */
  readonly disableMojeek?: boolean;
  /**
   * When an explicit backend (SearXNG / Brave / Tavily) is configured, also
   * fall back to the bundled keyless engines if it returns nothing or errors.
   * Default false: an explicit backend is exclusive (a self-hosted SearXNG
   * hiccup should not silently leak the query to public scrape engines).
   * Has no effect on the zero-config case, which always uses the keyless chain.
   */
  readonly fallbackToKeyless?: boolean;
  /**
   * Fully override engine selection. When provided, this engine is used
   * verbatim and the built-in chain/resolver is bypassed (advanced / tests).
   */
  readonly engine?: WebSearchEngine;
  /**
   * Override the per-engine base URLs (tests point these at local fixture
   * servers). Production leaves these unset and uses the real public hosts.
   */
  readonly engineBaseUrls?: {
    readonly mojeek?: string;
    readonly marginalia?: string;
    readonly wikipedia?: string;
    readonly brave?: string;
    readonly tavily?: string;
  };
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  readonly allowLoopback?: boolean;
  readonly allowPrivateNetworks?: boolean;
  readonly allowMetadata?: boolean;
  readonly resolveOnce?: boolean; // default true; DNS-rebinding defense
  readonly searchTimeoutMs?: number;
  readonly sessionBackstopMs?: number;
  /** Log only the query length in the permission hook, not the query text. */
  readonly redactQueryInHook?: boolean;
  readonly sessionId?: string;
  readonly signal?: AbortSignal;
}

// ----- Result union -----

export interface SearchMetadata {
  readonly query: string;
  readonly backendHost: string;
  readonly count: number;
  readonly timeRange: WebSearchTimeRange;
  readonly elapsedMs: number;
  /** Which engine actually served the results (provenance), e.g. "mojeek". */
  readonly engine?: string;
}

export type WebSearchOk = {
  readonly kind: "ok";
  readonly output: string;
  readonly meta: SearchMetadata;
  readonly results: readonly WebSearchResultItem[];
  readonly requested: number;
};

export type WebSearchEmpty = {
  readonly kind: "empty";
  readonly output: string;
  readonly meta: SearchMetadata;
};

export type WebSearchErrorResult = {
  readonly kind: "error";
  readonly error: ToolError;
};

export type WebSearchResult =
  | WebSearchOk
  | WebSearchEmpty
  | WebSearchErrorResult;
