import { request } from "undici";
import type {
  WebFetchEngine,
  WebFetchEngineInput,
  WebFetchEngineResult,
  WebFetchMethod,
} from "./types.js";

/**
 * Default WebFetch engine built on undici.
 *
 * Design choices:
 * - Follow redirects manually so we can (a) report the full chain, (b)
 *   re-run the SSRF check on each hop's resolved host, (c) block
 *   https→http downgrades. undici's built-in redirect follower does none
 *   of this.
 * - Buffer the body up to maxBodyBytes, then mark bodyTruncated: true
 *   and stop reading. The orchestrator decides how to format the
 *   overflow (spill-to-file).
 * - Abort on the caller's signal — but also have our own internal timeout
 *   that the orchestrator is responsible for composing.
 */
export function createDefaultEngine(): WebFetchEngine {
  return {
    async fetch(input: WebFetchEngineInput): Promise<WebFetchEngineResult> {
      let currentUrl = input.url;
      const chain: string[] = [];
      let hops = 0;

      while (true) {
        // Check host (SSRF) before each hop — including the first.
        const parsed = safeParseUrl(currentUrl);
        if (!parsed) {
          throw new FetchError("INVALID_URL", `Invalid URL: ${currentUrl}`);
        }
        await input.checkHost(parsed.hostname);

        const reqOpts: Parameters<typeof request>[1] = {
          method: input.method,
          headers: input.headers,
          signal: input.signal,
          bodyTimeout: input.timeoutMs,
          headersTimeout: input.timeoutMs,
          // No maxRedirections; undici.request doesn't auto-follow by
          // default (that's the higher-level fetch). We loop manually so
          // we can re-check SSRF on each hop and report the chain.
        };
        if (input.body !== undefined) {
          (reqOpts as { body: string }).body = input.body;
        }
        const res = await request(currentUrl, reqOpts);

        const status = res.statusCode;

        // Redirect statuses
        if (
          status === 301 ||
          status === 302 ||
          status === 303 ||
          status === 307 ||
          status === 308
        ) {
          const loc = asString(res.headers.location);
          if (loc === undefined) {
            // No Location header — treat as final response.
            return await finalize(
              res,
              input.method,
              input.url,
              currentUrl,
              chain,
              input.maxBodyBytes,
            );
          }
          // Drain the redirect body — undici requires consumption.
          await res.body.dump();

          const next = resolveLocation(currentUrl, loc);
          // Block https→http downgrade
          if (
            currentUrl.startsWith("https://") &&
            next.startsWith("http://")
          ) {
            throw new FetchError(
              "TLS_ERROR",
              `Refusing HTTPS→HTTP downgrade redirect: ${currentUrl} -> ${next}`,
            );
          }
          chain.push(currentUrl);
          hops++;
          if (hops > input.maxRedirects) {
            throw new FetchError(
              "REDIRECT_LOOP",
              `Redirect limit (${input.maxRedirects}) exceeded`,
              { chain: [...chain, next] },
            );
          }
          input.onRedirect?.(currentUrl, next);
          currentUrl = next;
          continue;
        }

        // Terminal response
        return await finalize(
          res,
          input.method,
          input.url,
          currentUrl,
          chain,
          input.maxBodyBytes,
        );
      }
    },
  };
}

// ---- helpers ----

type UndiciResponse = Awaited<ReturnType<typeof request>>;

async function finalize(
  res: UndiciResponse,
  _method: WebFetchMethod,
  _originalUrl: string,
  finalUrl: string,
  chain: readonly string[],
  maxBodyBytes: number,
): Promise<WebFetchEngineResult> {
  const contentType = asString(res.headers["content-type"]) ?? "";
  const body = await collectBody(res, maxBodyBytes);
  return {
    status: res.statusCode,
    finalUrl,
    redirectChain: [...chain, finalUrl],
    contentType,
    body: body.bytes,
    bodyTruncated: body.truncated,
  };
}

async function collectBody(
  res: UndiciResponse,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  for await (const chunk of res.body) {
    const buf = chunk instanceof Buffer ? chunk : Buffer.from(chunk);
    if (total + buf.length > maxBytes) {
      // Take the remaining budget, mark truncated.
      const need = maxBytes - total;
      if (need > 0) {
        chunks.push(buf.subarray(0, need));
        total += need;
      }
      truncated = true;
      break;
    }
    chunks.push(buf);
    total += buf.length;
  }
  // If we stopped early, drain the rest so the connection can recycle.
  if (truncated) {
    try {
      await res.body.dump();
    } catch {
      // ignore
    }
  }
  return { bytes: Buffer.concat(chunks), truncated };
}

function asString(h: string | string[] | undefined): string | undefined {
  if (h === undefined) return undefined;
  if (Array.isArray(h)) return h[0];
  return h;
}

function safeParseUrl(u: string): URL | null {
  try {
    return new URL(u);
  } catch {
    return null;
  }
}

function resolveLocation(base: string, loc: string): string {
  try {
    return new URL(loc, base).toString();
  } catch {
    return loc;
  }
}

/**
 * Engine-internal error class. The orchestrator catches and translates
 * these into tool errors; keeping them inside the engine means the
 * engine interface returns plain Promise<WebFetchEngineResult> without
 * a union return shape.
 */
export class FetchError extends Error {
  constructor(
    public readonly code:
      | "INVALID_URL"
      | "TLS_ERROR"
      | "REDIRECT_LOOP"
      | "DNS_ERROR"
      | "TIMEOUT"
      | "CONNECTION_RESET"
      | "IO_ERROR",
    message: string,
    public readonly meta?: Record<string, unknown>,
  ) {
    super(message);
  }
}
