import type {
  PermissionPolicy,
  ToolError,
} from "@agent-sh/harness-core";

export type WebFetchMethod = "GET" | "POST";
export type WebFetchExtract = "markdown" | "raw" | "both";

export interface WebFetchParams {
  readonly url: string;
  readonly method?: WebFetchMethod;
  readonly body?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly extract?: WebFetchExtract;
  readonly timeout_ms?: number;
  readonly max_redirects?: number;
}

/**
 * Pluggable engine: fetches a URL, follows redirects, returns the final
 * response. The engine is the place to swap to a browser-backed
 * implementation (adapter package) or a proxy-routed one.
 */
export interface WebFetchEngineInput {
  readonly url: string;
  readonly method: WebFetchMethod;
  readonly body?: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxRedirects: number;
  readonly signal: AbortSignal;
  /** Called after each redirect resolution (NEW host passed SSRF check). */
  readonly onRedirect?: (from: string, to: string) => void;
  /** Called before EACH hop with the resolved host; throws to abort. */
  readonly checkHost: (host: string) => Promise<void>;
  readonly maxBodyBytes: number;
}

export interface WebFetchEngineResult {
  readonly status: number;
  readonly finalUrl: string;
  readonly redirectChain: readonly string[];
  readonly contentType: string;
  readonly body: Uint8Array;
  readonly bodyTruncated: boolean;
}

export interface WebFetchEngine {
  fetch(input: WebFetchEngineInput): Promise<WebFetchEngineResult>;
}

/**
 * Session-bound policy. The SSRF knobs default to the safest values
 * (all false); per-harness callers flip as needed.
 */
export interface WebFetchPermissionPolicy extends PermissionPolicy {
  readonly unsafeAllowFetchWithoutHook?: boolean;
}

export interface WebFetchSessionConfig {
  readonly permissions: WebFetchPermissionPolicy;
  readonly engine?: WebFetchEngine;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  readonly allowLoopback?: boolean;
  readonly allowPrivateNetworks?: boolean;
  readonly allowMetadata?: boolean;
  readonly resolveOnce?: boolean; // default true; DNS-rebinding defense
  readonly defaultTimeoutMs?: number;
  readonly sessionBackstopMs?: number;
  readonly maxRedirects?: number;
  readonly inlineMarkdownCap?: number;
  readonly inlineRawCap?: number;
  readonly spillHardCap?: number;
  readonly cacheTtlMs?: number;
  readonly spillDir?: string;
  readonly sessionId?: string;
  readonly signal?: AbortSignal;
  /**
   * Mutable session cache — keyed on (method, url, body-hash, headers-hash,
   * extract). Callers pass a shared Map if they want cross-call cache.
   * Omit for no caching (every call misses).
   */
  cache?: Map<string, CachedResponse>;
}

export interface CachedResponse {
  readonly at: number; // ms epoch
  readonly status: number;
  readonly finalUrl: string;
  readonly redirectChain: readonly string[];
  readonly contentType: string;
  readonly body: Uint8Array;
  readonly extract: WebFetchExtract;
  readonly extractedMarkdown?: string;
}

// ----- Result union -----

export interface FetchMetadata {
  readonly url: string;
  readonly finalUrl: string;
  readonly method: WebFetchMethod;
  readonly status: number;
  readonly contentType: string;
  readonly redirectChain: readonly string[];
  readonly fetchedMs: number;
  readonly fromCache: boolean;
  readonly cacheAgeSec?: number;
}

export type WebFetchOk = {
  readonly kind: "ok";
  readonly output: string;
  readonly meta: FetchMetadata;
  readonly bodyMarkdown?: string;
  readonly bodyRaw?: string;
  readonly logPath?: string;
  readonly byteCap: boolean;
};

export type WebFetchRedirectLoop = {
  readonly kind: "redirect_loop";
  readonly output: string;
  readonly meta: FetchMetadata;
};

export type WebFetchHttpError = {
  readonly kind: "http_error";
  readonly output: string;
  readonly meta: FetchMetadata;
  readonly bodyRaw: string;
};

export type WebFetchErrorResult = {
  readonly kind: "error";
  readonly error: ToolError;
};

export type WebFetchResult =
  | WebFetchOk
  | WebFetchRedirectLoop
  | WebFetchHttpError
  | WebFetchErrorResult;
