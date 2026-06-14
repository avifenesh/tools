import { describe, expect, it } from "vitest";
import { createMojeekEngine, parseMojeek } from "../src/engines/mojeek.js";
import { createMarginaliaEngine } from "../src/engines/marginalia.js";
import { createWikipediaEngine } from "../src/engines/wikipedia.js";
import { createBraveEngine } from "../src/engines/brave.js";
import { createTavilyEngine } from "../src/engines/tavily.js";
import { createSearxngEngine } from "../src/engines/searxng.js";
import { SearchError } from "../src/engines/searchError.js";
import { stripTags, decodeEntities } from "../src/engines/html.js";
import { engineInput, fixture, startServer } from "./helpers.js";

describe("html helpers", () => {
  it("decodes named + numeric entities", () => {
    expect(decodeEntities("a &amp; b &lt;c&gt; &#65; &#x42;")).toBe(
      "a & b <c> A B",
    );
    expect(decodeEntities("caf&eacute; &rsaquo;")).toBe("café \u203a");
  });
  it("strips tags and collapses whitespace", () => {
    expect(stripTags("<p>hello   <strong>world</strong></p>\n  x")).toBe(
      "hello world x",
    );
  });
  it("leaves unknown entities intact", () => {
    expect(decodeEntities("&notreal; &amp;")).toBe("&notreal; &");
  });
});

describe("parseMojeek (against the real saved SERP fixture)", () => {
  const html = fixture("mojeek.html");
  it("parses every result block with title/url/snippet", () => {
    const results = parseMojeek(html);
    expect(results.length).toBeGreaterThanOrEqual(8);
    for (const r of results) {
      expect(r.title.length).toBeGreaterThan(0);
      expect(r.url).toMatch(/^https?:\/\//);
    }
    // The first real result from the fixture.
    expect(results[0]?.url).toContain("michaelhelvey.dev");
    expect(results[0]?.title).toMatch(/Async Runtime/i);
    expect(results[0]?.snippet.length).toBeGreaterThan(0);
  });
  it("returns [] on a challenge/empty body", () => {
    expect(parseMojeek("<html><body>nope</body></html>")).toEqual([]);
  });
});

describe("Mojeek empty-vs-challenge distinction (regression)", () => {
  // A genuine no-hits SERP carries the scaffold + "No pages found" → empty.
  const emptySerp =
    '<div class="serp-results"><div class="results-count-container"><p>Results 0 to 0 from 0 in 0.07s</p></div><div class="results"></div><p>No pages found matching: <strong>zzz</strong></p></div>';
  it("a real zero-results SERP → empty (not an error)", async () => {
    const srv = await startServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(emptySerp);
    });
    try {
      const r = await createMojeekEngine({ baseUrl: srv.url }).search(
        engineInput(),
      );
      expect(r.results).toEqual([]);
    } finally {
      await srv.close();
    }
  });
  it("an interstitial with no scaffold → SERVER_NOT_AVAILABLE", async () => {
    const srv = await startServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end("<html><body><h1>Verify you are human</h1></body></html>");
    });
    try {
      await expect(
        createMojeekEngine({ baseUrl: srv.url }).search(engineInput()),
      ).rejects.toMatchObject({ code: "SERVER_NOT_AVAILABLE" });
    } finally {
      await srv.close();
    }
  });
});

describe("MojeekEngine", () => {
  it("serves parsed results from a fixture server", async () => {
    const srv = await startServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(fixture("mojeek.html"));
    });
    try {
      const engine = createMojeekEngine({ baseUrl: srv.url });
      const r = await engine.search(engineInput({ count: 3 }));
      expect(r.engine).toBeUndefined(); // name is added by the fallback layer
      expect(r.results.length).toBe(3);
      expect(r.backendHost).toBe("127.0.0.1");
    } finally {
      await srv.close();
    }
  });

  it("maps an anti-bot 200 (no results container) to SERVER_NOT_AVAILABLE", async () => {
    const srv = await startServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end("<html><body>Please verify you are human</body></html>");
    });
    try {
      const engine = createMojeekEngine({ baseUrl: srv.url });
      await expect(engine.search(engineInput())).rejects.toMatchObject({
        code: "SERVER_NOT_AVAILABLE",
      });
    } finally {
      await srv.close();
    }
  });

  it("propagates SSRF from checkHost", async () => {
    const engine = createMojeekEngine({ baseUrl: "http://127.0.0.1:9/search" });
    await expect(
      engine.search(
        engineInput({
          checkHost: async () => {
            throw new SearchError("SSRF_BLOCKED", "blocked");
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "SSRF_BLOCKED" });
  });

  it("sends the query as ?q=", async () => {
    let seen = "";
    const srv = await startServer((req, res) => {
      seen = req.url ?? "";
      res.setHeader("content-type", "text/html");
      res.end(fixture("mojeek.html"));
    });
    try {
      await createMojeekEngine({ baseUrl: srv.url }).search(
        engineInput({ query: "tokio runtime" }),
      );
      expect(seen).toContain("/search?q=tokio");
    } finally {
      await srv.close();
    }
  });
});

describe("MarginaliaEngine (against the real saved JSON fixture)", () => {
  it("maps title/url/description→snippet", async () => {
    const srv = await startServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(fixture("marginalia.json"));
    });
    try {
      const r = await createMarginaliaEngine({ baseUrl: srv.url }).search(
        engineInput(),
      );
      expect(r.results.length).toBeGreaterThan(0);
      expect(r.results[0]?.url).toMatch(/^https?:\/\//);
      expect(r.results[0]?.title.length).toBeGreaterThan(0);
    } finally {
      await srv.close();
    }
  });

  it("builds /public/search/{query}?count=N", async () => {
    let seen = "";
    const srv = await startServer((req, res) => {
      seen = req.url ?? "";
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ results: [] }));
    });
    try {
      await createMarginaliaEngine({ baseUrl: srv.url }).search(
        engineInput({ query: "a b", count: 7 }),
      );
      expect(seen).toContain("/public/search/a%20b");
      expect(seen).toContain("count=7");
    } finally {
      await srv.close();
    }
  });

  it("non-JSON body → IO_ERROR", async () => {
    const srv = await startServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end("<html>not json</html>");
    });
    try {
      await expect(
        createMarginaliaEngine({ baseUrl: srv.url }).search(engineInput()),
      ).rejects.toMatchObject({ code: "IO_ERROR" });
    } finally {
      await srv.close();
    }
  });
});

describe("WikipediaEngine (against the real saved JSON fixture)", () => {
  it("maps title + pageid→curid url + strips snippet html", async () => {
    const srv = await startServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(fixture("wikipedia.json"));
    });
    try {
      const r = await createWikipediaEngine({ baseUrl: srv.url }).search(
        engineInput(),
      );
      expect(r.results.length).toBeGreaterThan(0);
      expect(r.results[0]?.url).toMatch(/\/\?curid=\d+/);
      // The fixture snippet contains <span class="searchmatch"> tags.
      expect(r.results[0]?.snippet).not.toContain("<span");
    } finally {
      await srv.close();
    }
  });

  it("builds the api.php query with srsearch + srlimit", async () => {
    let seen = "";
    const srv = await startServer((req, res) => {
      seen = req.url ?? "";
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ query: { search: [] } }));
    });
    try {
      await createWikipediaEngine({ baseUrl: srv.url }).search(
        engineInput({ query: "linux kernel", count: 4 }),
      );
      expect(seen).toContain("/w/api.php");
      expect(seen).toContain("srsearch=linux");
      expect(seen).toContain("srlimit=4");
      expect(seen).toContain("format=json");
    } finally {
      await srv.close();
    }
  });
});

describe("BraveEngine (keyed)", () => {
  it("sends the subscription token header and maps web.results", async () => {
    let token = "";
    const srv = await startServer((req, res) => {
      token = String(req.headers["x-subscription-token"] ?? "");
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          web: {
            results: [
              { title: "T1", url: "https://a.com", description: "d1" },
              { title: "T2", url: "https://b.com", description: "d2" },
            ],
          },
        }),
      );
    });
    try {
      const r = await createBraveEngine("secret-key", {
        baseUrl: srv.url,
      }).search(engineInput());
      expect(token).toBe("secret-key");
      expect(r.results.length).toBe(2);
      expect(r.results[0]?.url).toBe("https://a.com");
    } finally {
      await srv.close();
    }
  });

  it("maps freshness from time_range", async () => {
    let seen = "";
    const srv = await startServer((req, res) => {
      seen = req.url ?? "";
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ web: { results: [] } }));
    });
    try {
      await createBraveEngine("k", { baseUrl: srv.url }).search(
        engineInput({ timeRange: "week" }),
      );
      expect(seen).toContain("freshness=pw");
    } finally {
      await srv.close();
    }
  });
});

describe("TavilyEngine (keyed, POST)", () => {
  it("POSTs the query with bearer auth and maps results", async () => {
    let method = "";
    let auth = "";
    let body = "";
    const srv = await startServer((req, res) => {
      method = req.method ?? "";
      auth = String(req.headers["authorization"] ?? "");
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        body = Buffer.concat(chunks).toString("utf8");
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            results: [
              { title: "T", url: "https://x.com", content: "snippet" },
            ],
          }),
        );
      });
    });
    try {
      const r = await createTavilyEngine("tav-key", {
        baseUrl: srv.url,
      }).search(engineInput({ query: "qq", count: 2 }));
      expect(method).toBe("POST");
      expect(auth).toBe("Bearer tav-key");
      expect(body).toContain('"query":"qq"');
      expect(body).toContain('"max_results":2');
      expect(r.results[0]?.url).toBe("https://x.com");
    } finally {
      await srv.close();
    }
  });
});

describe("SearxngEngine", () => {
  it("builds the JSON search URL and maps content→snippet", async () => {
    let seen = "";
    const srv = await startServer((req, res) => {
      seen = req.url ?? "";
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          results: [{ title: "S", url: "https://s.com", content: "c" }],
        }),
      );
    });
    try {
      const r = await createSearxngEngine(srv.url).search(
        engineInput({ safeSearch: "strict", timeRange: "month" }),
      );
      expect(seen).toContain("/search");
      expect(seen).toContain("format=json");
      expect(seen).toContain("safesearch=2");
      expect(seen).toContain("time_range=month");
      expect(r.results[0]?.snippet).toBe("c");
    } finally {
      await srv.close();
    }
  });
});
