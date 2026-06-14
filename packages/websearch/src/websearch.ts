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
  MAX_SNIPPET_CAP,
  MIN_COUNT,
  MIN_SNIPPET_CAP,
  MIN_TIMEOUT_MS,
  SESSION_BACKSTOP_MS,
  SNIPPET_CAP,
} from "./constants.js";
import { resolveEngine } from "./engines/resolve.js";
import { SearchError } from "./engines/searchError.js";
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

  // Resolve the engine chain. With no key and no searxngUrl this yields the
  // bundled keyless default (Mojeek → Marginalia → Wikipedia), so search
  // works with zero config — there is no longer a hard "no backend" error.
  const resolved = resolveEngine(session);

  // When an explicit SearXNG backend is configured, validate its URL/scheme
  // and run the SSRF check up front so the model gets the SearXNG-specific
  // hint. The keyless/keyed engines self-check their (public) hosts per call.
  if (session.searxngUrl !== undefined && session.searxngUrl.length > 0) {
    const pre = await validateSearxngBackend(session);
    if (pre) return err(pre);
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

  const permissionHost = permissionBackendHost(session);

  // Permission hook (autonomous — allow or deny).
  const decision = await askPermission(session, {
    query: params.query,
    backendUrl: session.searxngUrl ?? `keyless:${resolved.chain.join("+")}`,
    backendHost: permissionHost,
    chain: resolved.chain,
    count,
    timeRange,
    safeSearch,
    categories,
  });
  if (decision.decision === "deny") {
    return err(permissionDeniedError(params.query, decision.reason));
  }

  const controller = new AbortController();
  const backstopTimer = setTimeout(() => controller.abort(), effectiveTimeout);
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
    engineResult = await resolved.engine.search({
      backendUrl: session.searxngUrl ?? "",
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
          throw new SearchError(
            "SSRF_BLOCKED",
            `${c.reason}. Hint: ${c.hint}`,
            { host },
          );
        }
      },
    });
  } catch (e) {
    clearTimeout(backstopTimer);
    return err(
      translateSearchError(e, params.query, {
        keylessDefault: resolved.keylessDefault,
        chain: resolved.chain,
        backendLabel: session.searxngUrl ?? `keyless (${resolved.chain.join(" → ")})`,
      }),
    );
  }
  clearTimeout(backstopTimer);

  const results = engineResult.results.slice(0, count);
  const servedBy = engineResult.engine ?? resolved.chain[0] ?? "unknown";
  const meta: SearchMetadata = {
    query: params.query,
    backendHost: engineResult.backendHost,
    count: results.length,
    timeRange,
    elapsedMs: engineResult.elapsedMs,
    engine: servedBy,
    // engineClass comes from the fallback layer; for a single resolved engine
    // fall back to the resolver's known class for that engine.
    ...(engineResult.engineClass !== undefined
      ? { engineClass: engineResult.engineClass }
      : resolved.soleEngineClass !== undefined
        ? { engineClass: resolved.soleEngineClass }
        : {}),
    ...(engineResult.engines !== undefined
      ? { engines: engineResult.engines }
      : {}),
    ...(engineResult.timeRangeApplied !== undefined
      ? { timeRangeApplied: engineResult.timeRangeApplied }
      : {}),
  };

  const snippetCap = clampSnippetCap(session.snippetCap);

  if (results.length === 0) {
    return { kind: "empty", output: formatEmptyText(meta), meta };
  }

  return {
    kind: "ok",
    output: formatOkText({ meta, results, requested: count, snippetCap }),
    meta,
    results,
    requested: count,
  };
}

function clampSnippetCap(n: number | undefined): number {
  if (n === undefined) return SNIPPET_CAP;
  if (n < MIN_SNIPPET_CAP) return MIN_SNIPPET_CAP;
  if (n > MAX_SNIPPET_CAP) return MAX_SNIPPET_CAP;
  return Math.trunc(n);
}

/** Pick the host label used for the permission pattern + audit metadata. */
function permissionBackendHost(session: WebSearchSessionConfig): string {
  if (session.searxngUrl !== undefined && session.searxngUrl.length > 0) {
    try {
      return new URL(session.searxngUrl).hostname;
    } catch {
      return session.searxngUrl;
    }
  }
  if (session.braveApiKey !== undefined && session.braveApiKey.length > 0) {
    return "brave";
  }
  if (session.tavilyApiKey !== undefined && session.tavilyApiKey.length > 0) {
    return "tavily";
  }
  return "keyless";
}

/** Up-front validation + SSRF for an explicitly configured SearXNG backend. */
async function validateSearxngBackend(
  session: WebSearchSessionConfig,
): Promise<ToolError | null> {
  const raw = session.searxngUrl ?? "";
  let backendUrl: URL;
  try {
    backendUrl = new URL(raw);
  } catch {
    return toolError("INVALID_PARAM", `invalid session.searxngUrl: ${raw}`);
  }
  if (backendUrl.protocol !== "http:" && backendUrl.protocol !== "https:") {
    return toolError(
      "INVALID_PARAM",
      `session.searxngUrl must be http(s); received '${backendUrl.protocol}'`,
      { meta: { backend: raw } },
    );
  }
  const ssrf = await classifyHost(backendUrl.hostname, session);
  if (!ssrf.allowed) {
    return toolError(
      "SSRF_BLOCKED",
      `${ssrf.reason}\nBackend: ${raw}\nHint: ${ssrf.hint}`,
      { meta: { backend: raw, host: backendUrl.hostname } },
    );
  }
  return null;
}

interface TranslateContext {
  readonly keylessDefault: boolean;
  readonly chain: readonly string[];
  readonly backendLabel: string;
}

function translateSearchError(
  e: unknown,
  query: string,
  ctx: TranslateContext,
): ToolError {
  const echo = `\nQuery: "${query}"\nBackend: ${ctx.backendLabel}`;
  // The keyless default nudge mirrors the existing error wording style.
  const keylessHint =
    "All search backends are rate-limited or returned nothing. For reliable results, set a free Brave Search API key (api-dashboard.search.brave.com) via session.braveApiKey, add a Tavily key, or run a local SearXNG and set session.searxngUrl.";

  if (e instanceof SearchError) {
    const meta = { query, backend: ctx.backendLabel, ...(e.meta ?? {}) };
    if (e.code === "SSRF_BLOCKED") {
      return toolError("SSRF_BLOCKED", `${e.message}${echo}`, { meta });
    }
    if (e.code === "SERVER_NOT_AVAILABLE") {
      const hasHttpStatus = typeof (e.meta as { status?: unknown })?.status === "number";
      let hint: string;
      if (ctx.keylessDefault) {
        hint = keylessHint;
      } else if (hasHttpStatus) {
        hint =
          "The backend is reachable but returned an error status. Check its logs, that JSON format is enabled (SearXNG), or that the API key is valid.";
      } else {
        hint =
          "The SearXNG instance does not appear to be running. Start it (docker run searxng/searxng) and ensure session.searxngUrl points at its address with JSON format enabled.";
      }
      return toolError(
        "SERVER_NOT_AVAILABLE",
        `The search backend returned an error.${echo}\nReason: ${e.message}\nHint: ${hint}`,
        { meta },
      );
    }
    if (e.code === "TIMEOUT") {
      return toolError(
        "TIMEOUT",
        `The search timed out.${echo}\nReason: ${e.message}\nHint: ${
          ctx.keylessDefault
            ? "Keyless backends can be slow; raise session.searchTimeoutMs (max 30000), simplify the query, or add a Brave/Tavily key."
            : "Raise session.searchTimeoutMs (max 30000) or simplify the query."
        }`,
        { meta },
      );
    }
    if (e.code === "CONNECTION_RESET") {
      return toolError("CONNECTION_RESET", `${e.message}${echo}\nHint: ${keylessOrSearxngHint(ctx)}`, {
        meta,
      });
    }
    if (e.code === "DNS_ERROR") {
      return toolError(
        "DNS_ERROR",
        `Could not resolve the search backend hostname.${echo}\nReason: ${e.message}\nHint: Check network connectivity${ctx.keylessDefault ? "" : " and session.searxngUrl"}.`,
        { meta },
      );
    }
    return toolError(e.code, `${e.message}${echo}`, { meta });
  }

  // Non-SearchError (shouldn't normally happen — engines wrap their errors).
  const errLike = e as Error & { code?: string };
  return toolError("IO_ERROR", `Search failed.${echo}\nReason: ${errLike.message}`, {
    meta: { query, backend: ctx.backendLabel },
  });
}

function keylessOrSearxngHint(ctx: TranslateContext): string {
  return ctx.keylessDefault
    ? "All keyless backends were unreachable. Check network connectivity, or set a Brave/Tavily key or local SearXNG for reliability."
    : "The SearXNG instance does not appear to be running. Start it (docker run searxng/searxng) and ensure session.searxngUrl points at its address with JSON format enabled.";
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
