import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import type { WebFetchSessionConfig } from "../src/types.js";

export type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
) => void | Promise<void>;

/**
 * Local HTTP server for deterministic tests. Bound to 127.0.0.1 —
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

export function makeSession(
  overrides: Partial<WebFetchSessionConfig> = {},
): WebFetchSessionConfig {
  return {
    permissions: {
      roots: [],
      sensitivePatterns: [],
      unsafeAllowFetchWithoutHook: true,
    },
    allowLoopback: true,
    cache: new Map(),
    ...overrides,
  };
}
