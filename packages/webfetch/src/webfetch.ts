import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { toolError, type ToolError } from "@agent-sh/harness-core";
import {
  CACHE_TTL_MS,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_USER_AGENT,
  INLINE_MARKDOWN_CAP,
  INLINE_RAW_CAP,
  MANAGED_HEADERS,
  SESSION_BACKSTOP_MS,
  SPILL_HARD_CAP,
  SPILL_HEAD_BYTES,
  SPILL_TAIL_BYTES,
  TEXT_PASSTHROUGH_TYPES,
} from "./constants.js";
import { createDefaultEngine, FetchError } from "./engine.js";
import { extractMarkdown, isHtmlLike, parseContentTypeBase } from "./extractor.js";
import { askPermission, permissionDeniedError } from "./fence.js";
import {
  formatHttpErrorText,
  formatOkText,
  formatRedirectLoopText,
  headAndTail,
  hostOf,
  spillToFile,
} from "./format.js";
import { safeParseWebFetchParams } from "./schema.js";
import { classifyHost, resolveHost } from "./ssrf.js";
import type {
  CachedResponse,
  WebFetchEngine,
  WebFetchExtract,
  WebFetchMethod,
  WebFetchParams,
  WebFetchResult,
  WebFetchSessionConfig,
} from "./types.js";

function err(error: ToolError): { kind: "error"; error: ToolError } {
  return { kind: "error", error };
}

function cacheKey(
  method: WebFetchMethod,
  url: string,
  body: string | undefined,
  headers: Readonly<Record<string, string>>,
  extract: WebFetchExtract,
): string {
  const h = createHash("sha256");
  h.update(method);
  h.update("\0");
  h.update(url);
  h.update("\0");
  h.update(body ?? "");
  h.update("\0");
  const sortedHeaders = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase(), v])
    .sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""));
  h.update(JSON.stringify(sortedHeaders));
  h.update("\0");
  h.update(extract);
  return h.digest("hex");
}

function normalizeHeaders(
  session: WebFetchSessionConfig,
  user: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  // Session defaults first (so user overrides them).
  for (const [k, v] of Object.entries(session.defaultHeaders ?? {})) {
    out[k.toLowerCase()] = v;
  }
  // Default User-Agent if nothing in session default.
  if (!("user-agent" in out)) {
    out["user-agent"] = DEFAULT_USER_AGENT;
  }
  // User headers — drop managed ones silently.
  for (const [k, v] of Object.entries(user ?? {})) {
    const lower = k.toLowerCase();
    if (MANAGED_HEADERS.includes(lower)) continue;
    out[lower] = v;
  }
  return out;
}

export async function webfetch(
  input: unknown,
  session: WebFetchSessionConfig,
): Promise<WebFetchResult> {
  const parsed = safeParseWebFetchParams(input);
  if (!parsed.ok) {
    const messages = parsed.issues.map((i) => i.message).join("; ");
    return err(toolError("INVALID_PARAM", messages, { cause: parsed.issues }));
  }
  const params = parsed.value;

  // Method/body consistency
  const method: WebFetchMethod = params.method ?? "GET";
  if (method === "POST" && params.body === undefined) {
    return err(toolError("INVALID_PARAM", "POST requires 'body'."));
  }
  if (method === "GET" && params.body !== undefined) {
    return err(
      toolError(
        "INVALID_PARAM",
        "GET does not accept 'body'; use POST or move the payload into the query string.",
      ),
    );
  }

  // Parse URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(params.url);
  } catch {
    return err(toolError("INVALID_URL", `Invalid URL: ${params.url}`));
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return err(
      toolError(
        "INVALID_URL",
        `only http(s) schemes are supported; received '${parsedUrl.protocol}'`,
        { meta: { url: params.url } },
      ),
    );
  }

  const extract: WebFetchExtract = params.extract ?? "markdown";
  const timeoutMs =
    params.timeout_ms ??
    session.defaultTimeoutMs ??
    DEFAULT_TIMEOUT_MS;
  const sessionBackstop =
    session.sessionBackstopMs ?? SESSION_BACKSTOP_MS;
  const effectiveTimeout = Math.min(timeoutMs, sessionBackstop);
  const maxRedirects =
    params.max_redirects ??
    session.maxRedirects ??
    DEFAULT_MAX_REDIRECTS;
  const headers = normalizeHeaders(session, params.headers);

  // Initial SSRF check (the engine re-checks on every redirect hop).
  const initialClass = await classifyHost(parsedUrl.hostname, session);
  if (!initialClass.allowed) {
    return err(
      toolError(
        "SSRF_BLOCKED",
        `${initialClass.reason}\nURL: ${params.url}\nHint: ${initialClass.hint}`,
        { meta: { url: params.url, host: parsedUrl.hostname } },
      ),
    );
  }

  // Permission hook (autonomous — allow or deny).
  const decision = await askPermission(session, {
    method,
    url: params.url,
    host: parsedUrl.hostname,
    bodyBytes: params.body ? Buffer.byteLength(params.body, "utf8") : 0,
    headerKeys: Object.keys(headers),
    extract,
    timeoutMs: effectiveTimeout,
    maxRedirects,
  });
  if (decision.decision === "deny") {
    return err(permissionDeniedError(params.url, decision.reason));
  }

  // Session cache
  const key = cacheKey(method, params.url, params.body, headers, extract);
  const cacheTtl = session.cacheTtlMs ?? CACHE_TTL_MS;
  if (session.cache) {
    const hit = session.cache.get(key);
    if (hit && Date.now() - hit.at <= cacheTtl) {
      return formatCachedHit(hit, extract, params, session);
    }
  }

  // Fetch
  const engine = session.engine ?? createDefaultEngine();
  const spillHardCap = session.spillHardCap ?? SPILL_HARD_CAP;
  const inlineMarkdownCap =
    session.inlineMarkdownCap ?? INLINE_MARKDOWN_CAP;
  const inlineRawCap = session.inlineRawCap ?? INLINE_RAW_CAP;
  const spillDir =
    session.spillDir ?? path.join(tmpdir(), "agent-sh-webfetch-cache");
  const sessionId = session.sessionId ?? "default";

  const started = Date.now();
  let controller = new AbortController();
  const backstopTimer = setTimeout(() => controller.abort(), sessionBackstop);
  if (session.signal) {
    if (session.signal.aborted) controller.abort();
    else {
      session.signal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
    }
  }

  let result: Awaited<ReturnType<WebFetchEngine["fetch"]>>;
  try {
    const engineOpts: Parameters<WebFetchEngine["fetch"]>[0] = {
      url: params.url,
      method,
      headers,
      timeoutMs: effectiveTimeout,
      maxRedirects,
      signal: controller.signal,
      maxBodyBytes: spillHardCap,
      checkHost: async (host: string) => {
        const c = await classifyHost(host, session);
        if (!c.allowed) {
          throw new FetchError("INVALID_URL", `${c.reason}. Hint: ${c.hint}`);
        }
      },
    };
    if (params.body !== undefined) {
      (engineOpts as unknown as { body: string }).body = params.body;
    }
    result = await engine.fetch(engineOpts);
  } catch (e) {
    clearTimeout(backstopTimer);
    return err(translateFetchError(e, params.url));
  }
  clearTimeout(backstopTimer);

  // Size over hard cap
  if (result.bodyTruncated && result.body.length >= spillHardCap) {
    return err(
      toolError(
        "OVERSIZE",
        `Response exceeded the ${spillHardCap / 1024 / 1024} MB hard cap. Use bash(curl -o file.bin <url>) for bulk downloads.`,
        { meta: { url: params.url, bytes: result.body.length } },
      ),
    );
  }

  const fetchedMs = Date.now() - started;
  const contentTypeBase = parseContentTypeBase(result.contentType);

  // 4xx/5xx — still return the body so the model can read an error page.
  if (result.status >= 400) {
    const mustSpillRaw = result.body.length > inlineRawCap;
    const logPath = mustSpillRaw
      ? spillToFile({
          bytes: result.body,
          dir: spillDir,
          sessionId,
          contentType: contentTypeBase,
        })
      : undefined;
    const bodyText =
      mustSpillRaw && logPath !== undefined
        ? headAndTail(
            result.body,
            SPILL_HEAD_BYTES,
            SPILL_TAIL_BYTES,
            logPath,
          )
        : decodeBody(result.body);
    const meta = {
      url: params.url,
      finalUrl: result.finalUrl,
      method,
      status: result.status,
      contentType: result.contentType,
      redirectChain: result.redirectChain,
      fetchedMs,
      fromCache: false,
    };
    return {
      kind: "http_error",
      output: formatHttpErrorText({
        meta,
        body: bodyText,
        ...(logPath !== undefined ? { logPath } : {}),
        byteCap: mustSpillRaw,
        totalBytes: result.body.length,
      }),
      meta,
      bodyRaw: bodyText,
      ...(logPath !== undefined ? { logPath } : {}),
      byteCap: mustSpillRaw,
    };
  }

  // Non-supported content-type — reject
  if (
    contentTypeBase.length > 0 &&
    !TEXT_PASSTHROUGH_TYPES.includes(contentTypeBase)
  ) {
    return err(
      toolError(
        "UNSUPPORTED_CONTENT_TYPE",
        `Content-type '${contentTypeBase}' is not supported. Use bash(curl -o file <url>) to download binary content.`,
        {
          meta: {
            url: params.url,
            contentType: result.contentType,
            bytes: result.body.length,
          },
        },
      ),
    );
  }

  // Decide whether to extract
  const rawText = decodeBody(result.body);
  let markdown: string | undefined;
  let markdownBytes = 0;
  if (
    (extract === "markdown" || extract === "both") &&
    isHtmlLike(contentTypeBase)
  ) {
    const { markdown: md } = extractMarkdown(rawText, result.finalUrl);
    markdown = md;
    markdownBytes = Buffer.byteLength(md, "utf8");
  } else if (extract === "markdown" || extract === "both") {
    // Non-HTML text — passthrough as the "markdown" field.
    markdown = rawText;
    markdownBytes = Buffer.byteLength(rawText, "utf8");
  }
  const fullMarkdown = markdown;

  // Check inline caps; spill on overflow.
  const rawBytes = result.body.length;
  const mustSpillMarkdown =
    markdown !== undefined && markdownBytes > inlineMarkdownCap;
  const rawRequested = extract !== "markdown";
  const mustSpillRaw = rawRequested && rawBytes > inlineRawCap;
  const mustSpillSource = rawBytes > inlineRawCap || mustSpillMarkdown;
  let logPath: string | undefined;
  if (mustSpillSource) {
    logPath = spillToFile({
      bytes: result.body,
      dir: spillDir,
      sessionId,
      contentType: contentTypeBase,
    });
    if (markdown !== undefined && mustSpillMarkdown) {
      markdown = headAndTail(
        Buffer.from(markdown, "utf8"),
        SPILL_HEAD_BYTES,
        SPILL_TAIL_BYTES,
        logPath,
      );
    }
  }
  const rawForOutput =
    rawRequested && mustSpillRaw && logPath !== undefined
      ? headAndTail(result.body, SPILL_HEAD_BYTES, SPILL_TAIL_BYTES, logPath)
      : rawRequested
        ? rawText
        : undefined;
  const bodyClipped = mustSpillMarkdown || mustSpillRaw;
  const byteCap = mustSpillSource;

  const meta = {
    url: params.url,
    finalUrl: result.finalUrl,
    method,
    status: result.status,
    contentType: result.contentType,
    redirectChain: result.redirectChain,
    fetchedMs,
    fromCache: false,
  };

  // Persist to session cache
  if (session.cache) {
    const entry: CachedResponse = {
      at: Date.now(),
      status: result.status,
      finalUrl: result.finalUrl,
      redirectChain: result.redirectChain,
      contentType: result.contentType,
      body: result.body,
      extract,
      ...(fullMarkdown !== undefined ? { extractedMarkdown: fullMarkdown } : {}),
    };
    session.cache.set(key, entry);
  }

  return {
    kind: "ok",
    output: formatOkText({
      meta,
      extractHint: extract,
      ...(markdown !== undefined ? { markdown } : {}),
      ...(rawForOutput !== undefined ? { raw: rawForOutput } : {}),
      ...(logPath !== undefined ? { logPath } : {}),
      byteCap,
      bodyClipped,
      totalBytes: rawBytes,
    }),
    meta,
    ...(markdown !== undefined ? { bodyMarkdown: markdown } : {}),
    ...(rawForOutput !== undefined ? { bodyRaw: rawForOutput } : {}),
    ...(logPath !== undefined ? { logPath } : {}),
    byteCap,
  };
}

function decodeBody(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8");
}

function formatCachedHit(
  hit: CachedResponse,
  extract: WebFetchExtract,
  params: WebFetchParams,
  session: WebFetchSessionConfig,
): WebFetchResult {
  const ageSec = Math.floor((Date.now() - hit.at) / 1000);
  const inlineMarkdownCap =
    session.inlineMarkdownCap ?? INLINE_MARKDOWN_CAP;
  const inlineRawCap = session.inlineRawCap ?? INLINE_RAW_CAP;
  const spillDir =
    session.spillDir ?? path.join(tmpdir(), "agent-sh-webfetch-cache");
  const sessionId = session.sessionId ?? "default";
  const contentTypeBase = parseContentTypeBase(hit.contentType);
  const meta = {
    url: params.url,
    finalUrl: hit.finalUrl,
    method: (params.method ?? "GET") as WebFetchMethod,
    status: hit.status,
    contentType: hit.contentType,
    redirectChain: hit.redirectChain,
    fetchedMs: 0,
    fromCache: true,
    cacheAgeSec: ageSec,
  };

  if (hit.status >= 400) {
    const mustSpillRaw = hit.body.length > inlineRawCap;
    const logPath = mustSpillRaw
      ? spillToFile({
          bytes: hit.body,
          dir: spillDir,
          sessionId,
          contentType: contentTypeBase,
        })
      : undefined;
    const body =
      mustSpillRaw && logPath !== undefined
        ? headAndTail(hit.body, SPILL_HEAD_BYTES, SPILL_TAIL_BYTES, logPath)
        : decodeBody(hit.body);
    return {
      kind: "http_error",
      output: formatHttpErrorText({
        meta,
        body,
        ...(logPath !== undefined ? { logPath } : {}),
        byteCap: mustSpillRaw,
        totalBytes: hit.body.length,
      }),
      meta,
      bodyRaw: body,
      ...(logPath !== undefined ? { logPath } : {}),
      byteCap: mustSpillRaw,
    };
  }

  const rawText = decodeBody(hit.body);
  const markdown =
    hit.extractedMarkdown ??
    (extract === "markdown" || extract === "both" ? rawText : undefined);
  const markdownBytes =
    markdown !== undefined ? Buffer.byteLength(markdown, "utf8") : 0;
  const rawRequested = extract !== "markdown";
  const mustSpillMarkdown =
    markdown !== undefined && markdownBytes > inlineMarkdownCap;
  const mustSpillRaw = rawRequested && hit.body.length > inlineRawCap;
  const mustSpillSource = hit.body.length > inlineRawCap || mustSpillMarkdown;
  const logPath = mustSpillSource
    ? spillToFile({
        bytes: hit.body,
        dir: spillDir,
        sessionId,
        contentType: contentTypeBase,
      })
    : undefined;
  const markdownForOutput =
    markdown !== undefined && mustSpillMarkdown && logPath !== undefined
      ? headAndTail(
          Buffer.from(markdown, "utf8"),
          SPILL_HEAD_BYTES,
          SPILL_TAIL_BYTES,
          logPath,
        )
      : markdown;
  const rawForOutput =
    rawRequested && mustSpillRaw && logPath !== undefined
      ? headAndTail(hit.body, SPILL_HEAD_BYTES, SPILL_TAIL_BYTES, logPath)
      : rawRequested
        ? rawText
        : undefined;
  const bodyClipped = mustSpillMarkdown || mustSpillRaw;
  return {
    kind: "ok",
    output: formatOkText({
      meta,
      extractHint: extract,
      ...(markdownForOutput !== undefined ? { markdown: markdownForOutput } : {}),
      ...(rawForOutput !== undefined ? { raw: rawForOutput } : {}),
      ...(logPath !== undefined ? { logPath } : {}),
      byteCap: mustSpillSource,
      bodyClipped,
      totalBytes: hit.body.length,
    }),
    meta,
    ...(markdownForOutput !== undefined ? { bodyMarkdown: markdownForOutput } : {}),
    ...(rawForOutput !== undefined ? { bodyRaw: rawForOutput } : {}),
    ...(logPath !== undefined ? { logPath } : {}),
    byteCap: mustSpillSource,
  };
}

function translateFetchError(e: unknown, url: string): ToolError {
  if (e instanceof FetchError) {
    if (e.code === "REDIRECT_LOOP") {
      return toolError("REDIRECT_LOOP", e.message, {
        meta: { url, ...(e.meta ?? {}) },
      });
    }
    return toolError(e.code, e.message, {
      meta: { url, ...(e.meta ?? {}) },
    });
  }
  const err = e as Error & { code?: string; cause?: Error & { code?: string } };
  const code = err.code ?? err.cause?.code ?? "";
  if (
    err.name === "AbortError" ||
    code === "UND_ERR_ABORTED" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT" ||
    code === "ECONNABORTED"
  ) {
    return toolError("TIMEOUT", `Request timed out: ${url}`, { meta: { url } });
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return toolError(
      "DNS_ERROR",
      `DNS resolution failed for ${url}: ${err.message}`,
      { meta: { url } },
    );
  }
  if (
    code.startsWith("ERR_TLS_") ||
    code === "CERT_HAS_EXPIRED" ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    err.message.toLowerCase().includes("tls")
  ) {
    return toolError(
      "TLS_ERROR",
      `TLS / certificate error for ${url}: ${err.message}`,
      { meta: { url } },
    );
  }
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET") {
    return toolError(
      "CONNECTION_RESET",
      `Connection reset: ${url}`,
      { meta: { url } },
    );
  }
  return toolError(
    "IO_ERROR",
    `Fetch failed for ${url}: ${err.message}`,
    { meta: { url } },
  );
}

/**
 * Helper for tests and callers — build a session with a fresh cache map.
 * Avoids sharing caches accidentally across test runs.
 */
export function makeSessionCache(): Map<string, CachedResponse> {
  return new Map();
}

/**
 * Session-id generator; harnesses can pass their own.
 */
export function newSessionId(): string {
  return randomUUID();
}
