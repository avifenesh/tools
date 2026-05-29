import { randomUUID } from "node:crypto";
import { toolError, type ToolError } from "@agent-sh/harness-core";
import {
  DEFAULT_CATEGORIES,
  DEFAULT_COUNT,
  DEFAULT_LANGUAGE,
  DEFAULT_SAFE_SEARCH,
  DEFAULT_TIME_RANGE,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_USER_AGENT,
  MAX_COUNT,
  MIN_COUNT,
  MIN_TIMEOUT_MS,
  SESSION_BACKSTOP_MS,
} from "./constants.js";
import { createDefaultEngine, SearchError } from "./engine.js";
import { askPermission, permissionDeniedError } from "./fence.js";
import { formatEmptyText, formatOkText } from "./format.js";
import { safeParseWebSearchParams } from "./schema.js";
import { classifyHost } from "./ssrf.js";
import type {
  SearchMetadata,
  WebSearchEngine,
  WebSearchResult,
  WebSearchSafeSearch,
  WebSearchSessionConfig,
  WebSearchTimeRange,
} from "./types.js";

function err(error: ToolError): { kind: "error"; error: ToolError } {
  return { kind: "error", error };
}

function clampCount(n: number | undefined): number {
  if (n === undefined) return DEFAULT_COUNT;
  if (n < MIN_COUNT) return MIN_COUNT;
  if (n > MAX_COUNT) return MAX_COUNT;
  return Math.trunc(n);
}

function normalizeHeaders(
  session: WebSearchSessionConfig,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(session.defaultHeaders ?? {})) {
    out[k.toLowerCase()] = v;
  }
  if (!("user-agent" in out)) {
    out["user-agent"] = DEFAULT_USER_AGENT;
  }
  if (!("accept" in out)) {
    out["accept"] = "application/json";
  }
  return out;
}

export async function websearch(
  input: unknown,
  session: WebSearchSessionConfig,
): Promise<WebSearchResult> {
  const parsed = safeParseWebSearchParams(input);
  if (!parsed.ok) {
    const messages = parsed.issues.map((i) => i.message).join("; ");
    return err(toolError("INVALID_PARAM", messages, { cause: parsed.issues }));
  }
  const params = parsed.value;

  // Backend must be configured on the session — never a model param.
  if (session.searxngUrl === undefined || session.searxngUrl.length === 0) {
    return err(
      toolError(
        "INVALID_PARAM",
        "no search backend configured; set session.searxngUrl",
      ),
    );
  }

  let backendUrl: URL;
  try {
    backendUrl = new URL(session.searxngUrl);
  } catch {
    return err(
      toolError(
        "INVALID_PARAM",
        `invalid session.searxngUrl: ${session.searxngUrl}`,
      ),
    );
  }
  if (backendUrl.protocol !== "http:" && backendUrl.protocol !== "https:") {
    return err(
      toolError(
        "INVALID_PARAM",
        `session.searxngUrl must be http(s); received '${backendUrl.protocol}'`,
        { meta: { backend: session.searxngUrl } },
      ),
    );
  }

  const count = clampCount(params.count);
  const timeRange: WebSearchTimeRange = params.time_range ?? DEFAULT_TIME_RANGE;
  const language = params.language ?? DEFAULT_LANGUAGE;
  const safeSearch: WebSearchSafeSearch =
    params.safe_search ?? DEFAULT_SAFE_SEARCH;
  const categories =
    params.categories !== undefined && params.categories.length > 0
      ? params.categories
      : DEFAULT_CATEGORIES;

  const timeoutMs = Math.max(
    session.searchTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    MIN_TIMEOUT_MS,
  );
  const sessionBackstop = session.sessionBackstopMs ?? SESSION_BACKSTOP_MS;
  const effectiveTimeout = Math.min(timeoutMs, sessionBackstop);
  const headers = normalizeHeaders(session);

  // SSRF check on the backend host before anything fires.
  const ssrf = await classifyHost(backendUrl.hostname, session);
  if (!ssrf.allowed) {
    return err(
      toolError(
        "SSRF_BLOCKED",
        `${ssrf.reason}\nBackend: ${session.searxngUrl}\nHint: ${ssrf.hint}`,
        { meta: { backend: session.searxngUrl, host: backendUrl.hostname } },
      ),
    );
  }

  // Permission hook (autonomous — allow or deny).
  const decision = await askPermission(session, {
    query: params.query,
    backendUrl: session.searxngUrl,
    backendHost: backendUrl.hostname,
    count,
    timeRange,
    safeSearch,
    categories,
  });
  if (decision.decision === "deny") {
    return err(permissionDeniedError(params.query, decision.reason));
  }

  const engine = session.engine ?? createDefaultEngine();

  const controller = new AbortController();
  const backstopTimer = setTimeout(
    () => controller.abort(),
    effectiveTimeout,
  );
  if (session.signal) {
    if (session.signal.aborted) controller.abort();
    else {
      session.signal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
    }
  }

  let engineResult: Awaited<ReturnType<WebSearchEngine["search"]>>;
  try {
    engineResult = await engine.search({
      backendUrl: session.searxngUrl,
      query: params.query,
      count,
      timeRange,
      language,
      safeSearch,
      categories,
      timeoutMs: effectiveTimeout,
      headers,
      signal: controller.signal,
      checkHost: async (host: string) => {
        const c = await classifyHost(host, session);
        if (!c.allowed) {
          throw new SearchError("IO_ERROR", `${c.reason}. Hint: ${c.hint}`);
        }
      },
    });
  } catch (e) {
    clearTimeout(backstopTimer);
    return err(translateSearchError(e, params.query, session.searxngUrl));
  }
  clearTimeout(backstopTimer);

  const results = engineResult.results.slice(0, count);
  const meta: SearchMetadata = {
    query: params.query,
    backendHost: engineResult.backendHost,
    count: results.length,
    timeRange,
    elapsedMs: engineResult.elapsedMs,
  };

  if (results.length === 0) {
    return {
      kind: "empty",
      output: formatEmptyText(meta),
      meta,
    };
  }

  return {
    kind: "ok",
    output: formatOkText({ meta, results, requested: count }),
    meta,
    results,
    requested: count,
  };
}

function translateSearchError(
  e: unknown,
  query: string,
  backend: string,
): ToolError {
  const echo = `\nQuery: "${query}"\nBackend: ${backend}`;
  if (e instanceof SearchError) {
    if (e.code === "SERVER_NOT_AVAILABLE") {
      return toolError(
        "SERVER_NOT_AVAILABLE",
        `The search backend returned an error.${echo}\nReason: ${e.message}\nHint: The SearXNG instance is reachable but failing. Check its logs and that JSON format is enabled.`,
        { meta: { query, backend, ...(e.meta ?? {}) } },
      );
    }
    return toolError(e.code, `${e.message}${echo}`, {
      meta: { query, backend, ...(e.meta ?? {}) },
    });
  }
  const errLike = e as Error & {
    code?: string;
    cause?: Error & { code?: string };
  };
  const code = errLike.code ?? errLike.cause?.code ?? "";
  if (
    errLike.name === "AbortError" ||
    code === "UND_ERR_ABORTED" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT" ||
    code === "ECONNABORTED"
  ) {
    return toolError(
      "TIMEOUT",
      `The search timed out.${echo}\nReason: ${errLike.message}\nHint: The metasearch may be slow; raise session.searchTimeoutMs (max 30000) or simplify the query.`,
      { meta: { query, backend } },
    );
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return toolError(
      "DNS_ERROR",
      `Could not resolve the search backend hostname.${echo}\nReason: ${errLike.message}\nHint: Check session.searxngUrl points at a reachable host.`,
      { meta: { query, backend } },
    );
  }
  if (
    code.startsWith("ERR_TLS_") ||
    code === "CERT_HAS_EXPIRED" ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    errLike.message.toLowerCase().includes("tls")
  ) {
    return toolError(
      "TLS_ERROR",
      `TLS / certificate error talking to the search backend.${echo}\nReason: ${errLike.message}\nHint: Check the backend's certificate or use http:// for a local instance.`,
      { meta: { query, backend } },
    );
  }
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "UND_ERR_SOCKET") {
    const refused = code === "ECONNREFUSED";
    return toolError(
      refused ? "SERVER_NOT_AVAILABLE" : "CONNECTION_RESET",
      `Could not reach the search backend.${echo}\nReason: ${refused ? "connection refused" : "connection reset"}\nHint: The SearXNG instance does not appear to be running. Start it (docker run searxng/searxng) and ensure session.searxngUrl points at its address with JSON format enabled.`,
      { meta: { query, backend } },
    );
  }
  return toolError(
    "IO_ERROR",
    `Search failed.${echo}\nReason: ${errLike.message}`,
    { meta: { query, backend } },
  );
}

/**
 * Session-id generator; harnesses can pass their own. Kept for parity with
 * webfetch's newSessionId / makeSessionCache helper surface.
 */
export function makeSessionId(): string {
  return randomUUID();
}

export function newSessionId(): string {
  return randomUUID();
}
