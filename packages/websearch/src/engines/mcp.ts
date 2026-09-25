import { request } from "undici";
import type { WebSearchEngineInput } from "../types.js";
import { translateTransportError } from "./http.js";
import { SearchError } from "./searchError.js";

/**
 * Shared stateless MCP `tools/call` over Streamable HTTP, used by the Exa and
 * Parallel engines. Mirrors the Rust `engines/mcp.rs` helper.
 *
 * Both hosted search MCP servers accept a bare `tools/call` without the
 * `initialize` handshake (verified live 2026-09-26), which saves two round
 * trips per search. The reply is either `application/json` or a
 * `text/event-stream` carrying the JSON-RPC response in a `data:` line.
 *
 * Every failure is a per-engine SERVER_NOT_AVAILABLE (or a transport code),
 * never INVALID_PARAM: an MCP-level rejection says nothing about whether the
 * model's query was malformed (WS-D14), so the chain should just move on.
 */

export interface McpCallResult {
  /** The JSON-RPC `result` object (`content`, optional `structuredContent`). */
  readonly result: Record<string, unknown>;
  readonly host: string;
  readonly elapsedMs: number;
}

export async function mcpToolCall(
  url: URL,
  input: WebSearchEngineInput,
  opts: {
    readonly engine: string;
    readonly tool: string;
    readonly arguments: Record<string, unknown>;
    readonly headers?: Readonly<Record<string, string>>;
  },
): Promise<McpCallResult> {
  await input.checkHost(url.hostname);

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers)) {
    const lk = k.toLowerCase();
    if (lk === "accept" || lk === "content-type") continue;
    headers[k] = v;
  }
  headers["content-type"] = "application/json";
  headers["accept"] = "application/json, text/event-stream";
  Object.assign(headers, opts.headers ?? {});

  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: opts.tool, arguments: opts.arguments },
  });

  const started = Date.now();
  let res: Awaited<ReturnType<typeof request>>;
  try {
    res = await request(url.toString(), {
      method: "POST",
      headers,
      body,
      signal: input.signal,
      bodyTimeout: input.timeoutMs,
      headersTimeout: input.timeoutMs,
    });
  } catch (e) {
    if (e instanceof SearchError) throw e;
    throw translateTransportError(e, opts.engine);
  }

  const status = res.statusCode;
  if (status >= 400) {
    await res.body.dump();
    const suffix =
      status === 429 || status === 403 ? "; rate-limited or bot-blocked" : "";
    throw new SearchError(
      "SERVER_NOT_AVAILABLE",
      `${opts.engine} is unavailable (HTTP ${status}${suffix})`,
      { status, engine: opts.engine },
    );
  }
  const contentType = String(res.headers["content-type"] ?? "").toLowerCase();
  let text: string;
  try {
    text = await res.body.text();
  } catch (e) {
    throw translateTransportError(e, opts.engine);
  }

  const message = parseRpcMessage(text, contentType.includes("text/event-stream"));
  if (message === undefined) {
    throw new SearchError(
      "IO_ERROR",
      `${opts.engine}: could not parse the MCP response as JSON-RPC`,
      { engine: opts.engine },
    );
  }
  const err = message["error"];
  if (err !== undefined && err !== null) {
    const msg =
      typeof (err as { message?: unknown }).message === "string"
        ? (err as { message: string }).message
        : "unknown error";
    throw new SearchError(
      "SERVER_NOT_AVAILABLE",
      `${opts.engine} MCP error: ${msg}`,
      { engine: opts.engine },
    );
  }
  const result = message["result"];
  if (result === null || typeof result !== "object") {
    throw new SearchError(
      "IO_ERROR",
      `${opts.engine}: MCP response carried neither result nor error`,
      { engine: opts.engine },
    );
  }
  const r = result as Record<string, unknown>;
  if (r["isError"] === true) {
    throw new SearchError(
      "SERVER_NOT_AVAILABLE",
      `${opts.engine} tool error: ${firstLine(contentText(r))}`,
      { engine: opts.engine },
    );
  }
  return { result: r, host: url.hostname, elapsedMs: Date.now() - started };
}

/**
 * Pull the JSON-RPC message out of a plain JSON body or an SSE stream. For
 * SSE, each event's `data:` lines are joined; the first event that parses to
 * an object with `result` or `error` wins (servers may interleave
 * notifications before the response).
 */
export function parseRpcMessage(
  text: string,
  sseHint: boolean,
): Record<string, unknown> | undefined {
  const trimmed = text.trimStart();
  if (!sseHint && (trimmed.startsWith("{") || trimmed.startsWith("["))) {
    return pickResponse(tryJson(trimmed));
  }
  let data = "";
  const flush = (): Record<string, unknown> | undefined => {
    if (data.length === 0) return undefined;
    const v = pickResponse(tryJson(data));
    data = "";
    return v;
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      const rest = line.slice(5);
      data += (data.length > 0 ? "\n" : "") + (rest.startsWith(" ") ? rest.slice(1) : rest);
    } else if (line.trim().length === 0) {
      const v = flush();
      if (v !== undefined) return v;
    }
  }
  const tail = flush();
  if (tail !== undefined) return tail;
  // Some servers answer SSE-negotiated requests with plain JSON anyway.
  return pickResponse(tryJson(trimmed));
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function pickResponse(v: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(v)) {
    for (const item of v) {
      const picked = pickResponse(item);
      if (picked !== undefined) return picked;
    }
    return undefined;
  }
  if (v !== null && typeof v === "object" && ("result" in v || "error" in v)) {
    return v as Record<string, unknown>;
  }
  return undefined;
}

/** Concatenate the `text` parts of an MCP tool result's `content` array. */
export function contentText(result: Record<string, unknown>): string {
  const parts = result["content"];
  if (!Array.isArray(parts)) return "";
  const texts: string[] = [];
  for (const p of parts) {
    const t = (p as { text?: unknown } | null)?.text;
    if (typeof t === "string") texts.push(t);
  }
  return texts.join("\n");
}

function firstLine(s: string): string {
  const line = s.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  return Array.from(line.trim()).slice(0, 200).join("");
}

/**
 * Keep the date portion of an ISO timestamp ("2026-07-22T16:46:14.000Z" →
 * "2026-07-22"); anything else (null, "N/A") yields undefined. Never
 * fabricated.
 */
export function isoDate(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  return /^(\d{4}-\d{2}-\d{2})/.exec(raw.trim())?.[1];
}
