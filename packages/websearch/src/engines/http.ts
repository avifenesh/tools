import { request } from "undici";
import type { WebSearchEngineInput } from "../types.js";
import { SearchError } from "./searchError.js";

export interface HttpGetResult {
  readonly status: number;
  readonly contentType: string;
  readonly text: string;
  readonly host: string;
  readonly elapsedMs: number;
}

/**
 * Shared GET used by every default engine. Centralizes:
 * - SSRF check on the resolved host before the socket opens (engine.checkHost
 *   throws a SearchError("SSRF_BLOCKED") which we let propagate).
 * - undici request with the input's headers / abort signal / timeouts.
 * - draining + reading the body as text.
 * - non-2xx → SearchError mapping (5xx/429 → SERVER_NOT_AVAILABLE,
 *   other 4xx → INVALID_PARAM) shared across engines.
 *
 * Engines that need JSON call `.text` then JSON.parse (so a parse failure is
 * the engine's own IO_ERROR with engine context), engines that need HTML use
 * `.text` directly.
 */
export async function httpGet(
  url: URL,
  input: WebSearchEngineInput,
  opts: { accept: string; engine: string },
): Promise<HttpGetResult> {
  await input.checkHost(url.hostname);

  const headers: Record<string, string> = { ...input.headers };
  // Engine-specific Accept wins over the session default.
  headers["accept"] = opts.accept;

  const started = Date.now();
  let res: Awaited<ReturnType<typeof request>>;
  try {
    res = await request(url.toString(), {
      method: "GET",
      headers,
      signal: input.signal,
      bodyTimeout: input.timeoutMs,
      headersTimeout: input.timeoutMs,
    });
  } catch (e) {
    // Let SSRF (from a redirect-time checkHost, if any) propagate untouched.
    if (e instanceof SearchError) throw e;
    throw translateTransportError(e, opts.engine);
  }

  const status = res.statusCode;
  const contentType = String(
    res.headers["content-type"] ?? "",
  ).toLowerCase();

  if (status >= 400) {
    await res.body.dump();
    if (status >= 500 || status === 429) {
      throw new SearchError(
        "SERVER_NOT_AVAILABLE",
        `${opts.engine} returned HTTP ${status}`,
        { status, engine: opts.engine },
      );
    }
    throw new SearchError(
      "INVALID_PARAM",
      `${opts.engine} rejected the query with HTTP ${status}`,
      { status, engine: opts.engine },
    );
  }

  let text: string;
  try {
    text = await res.body.text();
  } catch (e) {
    throw translateTransportError(e, opts.engine);
  }

  return {
    status,
    contentType,
    text,
    host: url.hostname,
    elapsedMs: Date.now() - started,
  };
}

/**
 * Map an undici/Node transport error onto a SearchError with an
 * engine-tagged message. The orchestrator turns these into the public
 * tool-error codes; the FallbackEngine treats them as per-engine failures.
 */
export function translateTransportError(
  e: unknown,
  engine: string,
): SearchError {
  const errLike = e as Error & {
    code?: string;
    cause?: Error & { code?: string };
  };
  const code = errLike.code ?? errLike.cause?.code ?? "";
  const msg = errLike.message ?? String(e);

  if (
    errLike.name === "AbortError" ||
    code === "UND_ERR_ABORTED" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT" ||
    code === "ECONNABORTED"
  ) {
    return new SearchError("TIMEOUT", `${engine}: ${msg}`, { engine });
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return new SearchError("DNS_ERROR", `${engine}: ${msg}`, { engine });
  }
  if (
    code.startsWith("ERR_TLS_") ||
    code === "CERT_HAS_EXPIRED" ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    msg.toLowerCase().includes("tls")
  ) {
    return new SearchError("TLS_ERROR", `${engine}: ${msg}`, { engine });
  }
  if (code === "ECONNREFUSED") {
    return new SearchError("SERVER_NOT_AVAILABLE", `${engine}: ${msg}`, {
      engine,
    });
  }
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET") {
    return new SearchError("CONNECTION_RESET", `${engine}: ${msg}`, {
      engine,
    });
  }
  return new SearchError("IO_ERROR", `${engine}: ${msg}`, { engine });
}
