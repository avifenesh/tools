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
}

export interface WebSearchEngine {
  search(input: WebSearchEngineInput): Promise<WebSearchEngineResult>;
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
  /** Base URL of the self-hosted SearXNG instance, e.g. http://127.0.0.1:8888 */
  readonly searxngUrl?: string;
  readonly engine?: WebSearchEngine;
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
