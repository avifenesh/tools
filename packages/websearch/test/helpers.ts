import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { AddressInfo } from "node:net";
import type {
  WebSearchEngineInput,
  WebSearchSessionConfig,
} from "../src/types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Read a saved real-response fixture from test/fixtures/. */
export function fixture(name: string): string {
  return readFileSync(path.join(HERE, "fixtures", name), "utf8");
}

/**
 * Build a WebSearchEngineInput for direct engine unit tests. checkHost
 * defaults to a no-op (engines are tested against loopback fixture servers);
 * pass a throwing checkHost to exercise the SSRF path.
 */
export function engineInput(
  overrides: Partial<WebSearchEngineInput> = {},
): WebSearchEngineInput {
  return {
    backendUrl: "",
    query: "rust async runtime",
    count: 5,
    timeRange: "all",
    language: "auto",
    safeSearch: "moderate",
    categories: ["general"],
    timeoutMs: 5000,
    headers: { "user-agent": "test" },
    signal: new AbortController().signal,
    checkHost: async () => {},
    ...overrides,
  };
}

export type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
) => void | Promise<void>;

/**
 * Local fake SearXNG server for deterministic tests. Bound to 127.0.0.1 —
 * tests that use it must set session.allowLoopback: true. The real
 * SSRF-block semantics are still exercised separately.
 */
export function startServer(handler: Handler): Promise<{
  url: string;
  host: string;
  port: number;
  close: () => Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      Promise.resolve(handler(req, res)).catch((e) => {
        res.statusCode = 500;
        res.end((e as Error).message);
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        host: "127.0.0.1",
        port: addr.port,
        close: () =>
          new Promise((resolve) => {
            server.close(() => resolve());
          }),
      });
    });
  });
}

/**
 * Build a canned SearXNG JSON response with N synthetic results.
 */
export function cannedResults(
  n: number,
  opts: { snippet?: string } = {},
): string {
  const results = Array.from({ length: n }, (_, i) => ({
    title: `Result ${i + 1}`,
    url: `https://example.com/${i + 1}`,
    content: opts.snippet ?? `Snippet for result ${i + 1}.`,
    engine: "duckduckgo",
  }));
  return JSON.stringify({ query: "test", number_of_results: n, results });
}

export function makeSession(
  overrides: Partial<WebSearchSessionConfig> = {},
): WebSearchSessionConfig {
  return {
    permissions: {
      roots: [],
      sensitivePatterns: [],
      unsafeAllowSearchWithoutHook: true,
    },
    searxngUrl: "http://127.0.0.1:8888",
    allowLoopback: true,
    ...overrides,
  };
}
