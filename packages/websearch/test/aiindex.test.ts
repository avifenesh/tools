import { describe, expect, it } from "vitest";
import { createExaEngine, parseExaText } from "../src/engines/exa.js";
import {
  createParallelEngine,
  mapParallelResults,
} from "../src/engines/parallel.js";
import { parseRpcMessage } from "../src/engines/mcp.js";
import { queryTerms, selectPassage } from "../src/engines/passage.js";
import { SearchError } from "../src/engines/searchError.js";
import { websearch } from "../src/websearch.js";
import type { WebSearchSessionConfig } from "../src/types.js";
import { engineInput, fixture, startServer } from "./helpers.js";

/** Exa's text block from the saved real SSE response. */
function exaFixtureText(): string {
  const line = fixture("exa.sse")
    .split("\n")
    .find((l) => l.startsWith("data:"));
  return JSON.parse(line!.slice(5)).result.content[0].text as string;
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

describe("passage selection (parity with Rust engines/passage.rs)", () => {
  it("terms drop stopwords, short tokens and duplicates", () => {
    expect(queryTerms("What is the Rust async runtime? rust")).toEqual([
      "rust",
      "async",
      "runtime",
    ]);
  });

  it("skips chrome and picks the matching line", () => {
    const text =
      "Keyboard shortcuts\nPress ← or → to navigate between chapters\nToggle sidebar\nSome unrelated intro paragraph about the book itself.\nTokio is an async runtime for Rust with a work-stealing scheduler.";
    expect(selectPassage(text, "rust async runtime", "The Book")).toMatch(
      /^Tokio is an async runtime/,
    );
  });

  it("extends with following lines and caps at 600 code points", () => {
    const s = selectPassage(
      `rust async runtime basics here\n${"x".repeat(700)}`,
      "rust async",
      "",
    );
    expect(s.startsWith("rust async runtime basics here x")).toBe(true);
    expect(Array.from(s).length).toBe(600);
  });

  it("the repeated title is not the snippet", () => {
    const text =
      "Tokio - An asynchronous Rust runtime\n...\nTokio is an asynchronous runtime for the Rust programming language.";
    expect(
      selectPassage(text, "rust runtime", "Tokio - An asynchronous Rust runtime"),
    ).toMatch(/^Tokio is an asynchronous runtime/);
  });

  it("a short chrome line loses a tie to content", () => {
    const text =
      "Skip to main content ## async\nReturns a Future instead of blocking the current thread when used with async.";
    expect(selectPassage(text, "rust async runtime", "async - Rust")).toMatch(
      /^Returns a Future/,
    );
  });

  it("no term hit falls back to the first substantial line", () => {
    const text =
      "Short nav line here\nThis is the first line that is long enough to be content.";
    expect(selectPassage(text, "zzzz", "")).toMatch(/^This is the first line/);
  });

  it("matches the Rust picker on the real fixtures (passage.expected.json)", () => {
    const expected = JSON.parse(fixture("passage.expected.json")) as {
      exa1: string;
      par1: string;
    };
    const exa = parseExaText(exaFixtureText(), "rust async runtime");
    const par = mapParallelResults(
      JSON.parse(fixture("parallel.json")).result.structuredContent,
      "rust async runtime",
    );
    expect(exa[1]?.snippet).toBe(expected.exa1);
    expect(par[1]?.snippet).toBe(expected.par1);
  });
});

describe("MCP response parsing", () => {
  it("reads the JSON-RPC message from an SSE data line", () => {
    const v = parseRpcMessage(
      'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[]}}\n\n',
      true,
    );
    expect(v?.["result"]).toBeDefined();
  });

  it("skips notifications before the response", () => {
    const v = parseRpcMessage(
      'data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\ndata: {"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"rate limit"}}\n\n',
      true,
    );
    expect((v?.["error"] as { message: string }).message).toBe("rate limit");
  });
});

describe("ExaEngine (keyless MCP)", () => {
  it("POSTs a stateless tools/call and parses the real SSE fixture", async () => {
    let method = "";
    let path = "";
    let key = "";
    let body = "";
    const srv = await startServer(async (req, res) => {
      method = req.method ?? "";
      path = req.url ?? "";
      key = String(req.headers["x-api-key"] ?? "");
      body = await readBody(req);
      res.setHeader("content-type", "text/event-stream");
      res.end(fixture("exa.sse"));
    });
    try {
      const r = await createExaEngine({ apiKey: "k-exa", baseUrl: srv.url }).search(
        engineInput(),
      );
      expect(method).toBe("POST");
      expect(path).toBe("/mcp");
      expect(key).toBe("k-exa");
      const rpc = JSON.parse(body);
      expect(rpc.method).toBe("tools/call");
      expect(rpc.params.name).toBe("web_search_exa");
      expect(rpc.params.arguments).toEqual({
        query: "rust async runtime",
        numResults: 5,
      });
      expect(r.results).toHaveLength(3);
      expect(r.results[0]?.url).toContain("async-book");
      expect(r.results[0]?.age).toBeUndefined();
      expect(r.results[1]?.age).toBe("2026-07-22");
      expect(r.results[1]?.snippet.startsWith("Tokio - An asynchronous Rust runtime")).toBe(false);
      expect(r.timeRangeApplied).toBeUndefined();
    } finally {
      await srv.close();
    }
  });

  it("reports time_range as not applied", async () => {
    const srv = await startServer((_req, res) => {
      res.setHeader("content-type", "text/event-stream");
      res.end(fixture("exa.sse"));
    });
    try {
      const r = await createExaEngine({ baseUrl: srv.url }).search(
        engineInput({ timeRange: "week" }),
      );
      expect(r.timeRangeApplied).toBe(false);
    } finally {
      await srv.close();
    }
  });

  it("records it cannot parse are IO_ERROR, not an empty search", async () => {
    const srv = await startServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: "Title: only a title line" }] },
        }),
      );
    });
    try {
      await expect(
        createExaEngine({ baseUrl: srv.url }).search(engineInput()),
      ).rejects.toMatchObject({ code: "IO_ERROR" });
    } finally {
      await srv.close();
    }
  });

  it("maps every failure to SERVER_NOT_AVAILABLE, never INVALID_PARAM", async () => {
    const cases: Array<{ status: number; body: unknown }> = [
      { status: 400, body: {} },
      { status: 429, body: {} },
      {
        status: 200,
        body: { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "rate limit exceeded" } },
      },
      {
        status: 200,
        body: {
          jsonrpc: "2.0",
          id: 1,
          result: { isError: true, content: [{ type: "text", text: "Free tier limit reached" }] },
        },
      },
    ];
    for (const c of cases) {
      const srv = await startServer((_req, res) => {
        res.statusCode = c.status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(c.body));
      });
      try {
        const e = await createExaEngine({ baseUrl: srv.url })
          .search(engineInput())
          .then(
            () => undefined,
            (err: unknown) => err,
          );
        expect(e).toBeInstanceOf(SearchError);
        expect((e as SearchError).code).toBe("SERVER_NOT_AVAILABLE");
      } finally {
        await srv.close();
      }
    }
  });
});

describe("ParallelEngine (keyless MCP)", () => {
  it("sends objective + search_queries, truncates to count, skips page chrome", async () => {
    let auth = "";
    let body = "";
    const srv = await startServer(async (req, res) => {
      auth = String(req.headers["authorization"] ?? "");
      body = await readBody(req);
      res.setHeader("content-type", "application/json");
      res.end(fixture("parallel.json"));
    });
    try {
      const r = await createParallelEngine({
        apiKey: "k-par",
        baseUrl: srv.url,
      }).search(engineInput({ count: 3 }));
      expect(auth).toBe("Bearer k-par");
      const rpc = JSON.parse(body);
      expect(rpc.params.name).toBe("web_search");
      expect(rpc.params.arguments).toEqual({
        objective: "rust async runtime",
        search_queries: ["rust async runtime"],
      });
      expect(r.results).toHaveLength(3);
      expect(r.results[0]?.url.startsWith("https://doc.rust-lang.org/")).toBe(true);
      for (const x of r.results) {
        expect(x.snippet.startsWith("Keyboard shortcuts")).toBe(false);
        expect(x.snippet.startsWith("Skip to main content")).toBe(false);
      }
    } finally {
      await srv.close();
    }
  });
});

describe("engineOrder (harness-chosen chain)", () => {
  const perms = {
    roots: [],
    sensitivePatterns: [],
    unsafeAllowSearchWithoutHook: true,
  };

  it("an invalid order is a config error the model cannot fix", async () => {
    const cases: Array<[string[], string]> = [
      [["exa", "bing"], "unknown engine 'bing'"],
      [["exa", "exa"], "lists 'exa' twice"],
      [["searxng"], "session.searxngUrl is not set"],
      [["brave"], "session.braveApiKey is not set"],
      [[], "is empty"],
    ];
    for (const [order, needle] of cases) {
      const r = await websearch(
        { query: "x" },
        { permissions: perms, engineOrder: order },
      );
      expect(r.kind).toBe("error");
      if (r.kind !== "error") continue;
      expect(r.error.code).toBe("INVALID_PARAM");
      expect(r.error.message).toContain(needle);
      expect(r.error.message).toContain("not a tool parameter");
    }
  });

  it("falls through a rate-limited Exa to Parallel and labels the chain", async () => {
    const exa = await startServer((_req, res) => {
      res.statusCode = 429;
      res.end("{}");
    });
    const par = await startServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(fixture("parallel.json"));
    });
    try {
      const session: WebSearchSessionConfig = {
        permissions: perms,
        allowLoopback: true,
        engineOrder: ["exa", "parallel"],
        engineBaseUrls: { exa: exa.url, parallel: par.url },
      };
      const r = await websearch({ query: "rust async runtime", count: 3 }, session);
      expect(r.kind).toBe("ok");
      if (r.kind !== "ok") return;
      expect(r.results).toHaveLength(3);
      expect(r.output).toContain("parallel (general web)");
    } finally {
      await exa.close();
      await par.close();
    }
  });
});
