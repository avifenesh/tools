import { describe, expect, it } from "vitest";
import {
  createFallbackEngine,
  type FallbackEngineResult,
} from "../src/engines/fallback.js";
import { resolveEngine } from "../src/engines/resolve.js";
import { SearchError } from "../src/engines/searchError.js";
import type {
  NamedWebSearchEngine,
  WebSearchEngineResult,
  WebSearchResultItem,
} from "../src/types.js";
import { engineInput } from "./helpers.js";

function fakeEngine(
  name: string,
  behavior:
    | { kind: "results"; items: WebSearchResultItem[] }
    | { kind: "empty" }
    | { kind: "error"; error: SearchError },
  spy?: { calls: string[] },
  engineClass: "general" | "niche" | "vertical" = "general",
): NamedWebSearchEngine {
  return {
    name,
    engineClass,
    async search(): Promise<WebSearchEngineResult> {
      spy?.calls.push(name);
      if (behavior.kind === "error") throw behavior.error;
      return {
        results: behavior.kind === "results" ? behavior.items : [],
        backendHost: `${name}.example`,
        elapsedMs: 1,
      };
    },
  };
}

const item = (u: string): WebSearchResultItem => ({
  title: `t-${u}`,
  url: `https://${u}`,
  snippet: "s",
});

describe("FallbackEngine — gather, merge & dedupe", () => {
  it("fast path: a first engine that meets count returns alone (no mixing)", async () => {
    const spy = { calls: [] as string[] };
    const five = Array.from({ length: 5 }, (_, i) => item(`a${i}`));
    const engine = createFallbackEngine([
      fakeEngine("a", { kind: "results", items: five }, spy),
      fakeEngine("b", { kind: "results", items: [item("b1")] }, spy),
    ]);
    const r = (await engine.search(engineInput())) as FallbackEngineResult;
    expect(r.results.length).toBe(5);
    expect(r.engine).toBe("a");
    expect(r.engines).toBeUndefined(); // single-engine, not mixed
    expect(spy.calls).toEqual(["a"]); // b never tried (sufficiency)
    expect(r.results.every((x) => x.source === undefined)).toBe(true);
  });

  it("merges across engines when the leader is short of count, skipping empties", async () => {
    const spy = { calls: [] as string[] };
    const engine = createFallbackEngine([
      fakeEngine("a", { kind: "empty" }, spy),
      fakeEngine("b", { kind: "results", items: [item("b1")] }, spy),
      fakeEngine("c", { kind: "results", items: [item("c1")] }, spy),
    ]);
    const r = (await engine.search(engineInput())) as FallbackEngineResult;
    // count=5, b and c each give 1 → merged to fill the quota.
    expect(r.results.map((x) => x.url)).toEqual(["https://b1", "https://c1"]);
    expect(r.engine).toBe("b"); // first contributor leads
    expect(r.engines).toEqual(["b", "c"]); // merged provenance
    expect(spy.calls).toEqual(["a", "b", "c"]);
    // per-result source surfaced because the set is mixed
    expect(r.results[0]?.source).toBe("b");
    expect(r.results[1]?.source).toBe("c");
  });

  it("stops gathering once count is met (sufficiency)", async () => {
    const spy = { calls: [] as string[] };
    const engine = createFallbackEngine([
      fakeEngine("a", { kind: "results", items: [item("a1"), item("a2")] }, spy),
      fakeEngine("b", { kind: "results", items: [item("b1")] }, spy),
      fakeEngine("c", { kind: "results", items: [item("c1")] }, spy),
    ]);
    const r = (await engine.search(engineInput({ count: 3 }))) as FallbackEngineResult;
    // RRF interleaves by rank across engines (same weight): a1 and b1 are each
    // their engine's #1 (tie → insertion order a1<b1), a2 is a's #2. So the
    // 3 gathered candidates fuse to [a1, b1, a2] — not a-exhausted-first.
    expect(r.results.map((x) => x.url)).toEqual([
      "https://a1",
      "https://b1",
      "https://a2",
    ]);
    expect(spy.calls).toEqual(["a", "b"]); // c not needed (3 candidates pooled)
  });

  it("RRF: a page two engines AGREE on is boosted above a single-engine #1 (consensus)", async () => {
    // mojeek: [seo, shared, junk]; marginalia: [shared, boats].
    // 'shared' appears at mojeek#2 (1.0/12=.083) + marginalia#1 (.8/10=.080)
    // = .163, beating mojeek#1 'seo' (.100). Consensus floats it to the top.
    const engine = createFallbackEngine([
      fakeEngine(
        "mojeek",
        {
          kind: "results",
          items: [item("seo.example/x"), item("shared.example/p"), item("junk.example/y")],
        },
        undefined,
        "general",
      ),
      fakeEngine(
        "marginalia",
        {
          kind: "results",
          items: [item("shared.example/p"), item("boats.example/b")],
        },
        undefined,
        "niche",
      ),
    ]);
    const r = (await engine.search(engineInput({ count: 5 }))) as FallbackEngineResult;
    expect(r.results[0]?.url).toBe("https://shared.example/p");
    // consensus row names both contributing engines, best-rank-first
    // (marginalia had it at #1, mojeek at #2).
    expect(r.results[0]?.source).toBe("marginalia+mojeek");
    expect(r.engines).toContain("mojeek");
    expect(r.engines).toContain("marginalia");
  });

  it("RRF weighting: a vertical (encyclopedic) hit does not outrank broad web when the leader is short", async () => {
    // mojeek(general) #1 weight 1.0/(10)=.100; wikipedia(vertical) #1
    // weight 0.6/(10)=.060 → general stays on top even though the chain only
    // had 1 general hit. (A/B scenario 4.)
    const engine = createFallbackEngine([
      fakeEngine("mojeek", { kind: "results", items: [item("k8s.io/docs")] }, undefined, "general"),
      fakeEngine(
        "wikipedia",
        { kind: "results", items: [item("en.wikipedia.org/?curid=1"), item("en.wikipedia.org/?curid=2")] },
        undefined,
        "vertical",
      ),
    ]);
    const r = (await engine.search(engineInput({ count: 5 }))) as FallbackEngineResult;
    expect(r.results[0]?.url).toBe("https://k8s.io/docs");
  });

  it("RRF is deterministic for the same engine lists", async () => {
    const build = () =>
      createFallbackEngine([
        fakeEngine("a", { kind: "results", items: [item("x/1"), item("x/2")] }, undefined, "general"),
        fakeEngine("b", { kind: "results", items: [item("x/2"), item("x/3")] }, undefined, "niche"),
      ]);
    const r1 = (await build().search(engineInput({ count: 5 }))) as FallbackEngineResult;
    const r2 = (await build().search(engineInput({ count: 5 }))) as FallbackEngineResult;
    expect(r1.results.map((x) => x.url)).toEqual(r2.results.map((x) => x.url));
  });

  it("de-duplicates the same URL surfaced by multiple engines", async () => {
    const engine = createFallbackEngine([
      fakeEngine("a", { kind: "empty" }),
      fakeEngine("b", {
        kind: "results",
        items: [
          { title: "Tokio", url: "https://tokio.rs/", snippet: "s" },
        ],
      }),
      fakeEngine("c", {
        kind: "results",
        items: [
          // same page, www + trailing slash + tracking param → dedup key match
          { title: "Tokio dup", url: "https://www.tokio.rs?utm_source=x", snippet: "s2" },
          { title: "Other", url: "https://other.example/p", snippet: "s3" },
        ],
      }),
    ]);
    const r = (await engine.search(engineInput())) as FallbackEngineResult;
    const urls = r.results.map((x) => x.url);
    expect(urls).toEqual(["https://tokio.rs/", "https://other.example/p"]);
  });

  it("skips an erroring engine and continues to the next", async () => {
    const spy = { calls: [] as string[] };
    const engine = createFallbackEngine([
      fakeEngine(
        "a",
        { kind: "error", error: new SearchError("TIMEOUT", "slow") },
        spy,
      ),
      fakeEngine("b", { kind: "results", items: [item("b1")] }, spy),
    ]);
    const r = (await engine.search(engineInput())) as FallbackEngineResult;
    expect(r.engine).toBe("b");
    expect(r.attempts[0]).toMatchObject({ engine: "a", outcome: "error", code: "TIMEOUT" });
  });

  it("an SSRF block on one engine does not sink the chain", async () => {
    const engine = createFallbackEngine([
      fakeEngine("a", {
        kind: "error",
        error: new SearchError("SSRF_BLOCKED", "blocked host"),
      }),
      fakeEngine("b", { kind: "results", items: [item("b1")] }),
    ]);
    const r = await engine.search(engineInput());
    expect(r.results.length).toBe(1);
  });
});

describe("FallbackEngine — empty vs error semantics", () => {
  it("all engines empty → returns empty (not an error)", async () => {
    const engine = createFallbackEngine([
      fakeEngine("a", { kind: "empty" }),
      fakeEngine("b", { kind: "empty" }),
    ]);
    const r = await engine.search(engineInput());
    expect(r.results).toEqual([]);
  });

  it("a clean empty beats later errors", async () => {
    const engine = createFallbackEngine([
      fakeEngine("a", { kind: "empty" }),
      fakeEngine("b", {
        kind: "error",
        error: new SearchError("IO_ERROR", "boom"),
      }),
    ]);
    const r = await engine.search(engineInput());
    expect(r.results).toEqual([]); // empty, not a throw
  });

  it("all engines error → throws a chain-summary SearchError", async () => {
    const engine = createFallbackEngine([
      fakeEngine("a", {
        kind: "error",
        error: new SearchError("TIMEOUT", "t"),
      }),
      fakeEngine("b", {
        kind: "error",
        error: new SearchError("TIMEOUT", "t"),
      }),
    ]);
    await expect(engine.search(engineInput())).rejects.toMatchObject({
      code: "TIMEOUT", // unified code when all share it
    });
  });

  it("mixed error codes → SERVER_NOT_AVAILABLE summary", async () => {
    const engine = createFallbackEngine([
      fakeEngine("a", {
        kind: "error",
        error: new SearchError("TIMEOUT", "t"),
      }),
      fakeEngine("b", {
        kind: "error",
        error: new SearchError("DNS_ERROR", "d"),
      }),
    ]);
    await expect(engine.search(engineInput())).rejects.toMatchObject({
      code: "SERVER_NOT_AVAILABLE",
    });
  });

  it("a general engine's empty is authoritative even if a niche engine errored after", async () => {
    const engine = createFallbackEngine([
      fakeEngine("mojeek", { kind: "empty" }, undefined, "general"),
      fakeEngine(
        "marginalia",
        { kind: "error", error: new SearchError("SERVER_NOT_AVAILABLE", "429") },
        undefined,
        "niche",
      ),
    ]);
    const r = (await engine.search(engineInput())) as FallbackEngineResult;
    expect(r.results).toEqual([]); // trusted empty from the general engine
    // The empty is attributed via the attempts trace (no per-result engine).
    expect(r.attempts.find((a) => a.engine === "mojeek")?.outcome).toBe("empty");
  });

  it("degraded: general engine ERRORED and only a vertical engine returned empty → throws (not a misleading empty)", async () => {
    // The reviewer's scenario: Mojeek challenged, Marginalia 429, Wikipedia
    // (vertical) legitimately empty. Returning empty would tell the model
    // "no web results exist" — wrong. It must surface as an error so it retries.
    const engine = createFallbackEngine([
      fakeEngine(
        "mojeek",
        { kind: "error", error: new SearchError("SERVER_NOT_AVAILABLE", "challenge") },
        undefined,
        "general",
      ),
      fakeEngine(
        "marginalia",
        { kind: "error", error: new SearchError("SERVER_NOT_AVAILABLE", "429") },
        undefined,
        "niche",
      ),
      fakeEngine("wikipedia", { kind: "empty" }, undefined, "vertical"),
    ]);
    await expect(engine.search(engineInput())).rejects.toBeInstanceOf(
      SearchError,
    );
  });

  it("niche/vertical empty is returned when NO general engine errored (e.g. mojeek disabled)", async () => {
    const engine = createFallbackEngine([
      fakeEngine("marginalia", { kind: "empty" }, undefined, "niche"),
      fakeEngine("wikipedia", { kind: "empty" }, undefined, "vertical"),
    ]);
    const r = await engine.search(engineInput());
    expect(r.results).toEqual([]); // best signal we have; not a failure
  });

  it("stops trying engines once the signal aborts", async () => {
    const spy = { calls: [] as string[] };
    const ac = new AbortController();
    const engine = createFallbackEngine([
      {
        name: "a",
        engineClass: "general",
        async search() {
          spy.calls.push("a");
          ac.abort();
          throw new SearchError("TIMEOUT", "aborted-ish");
        },
      },
      fakeEngine("b", { kind: "results", items: [item("b1")] }, spy),
    ]);
    await expect(
      engine.search(engineInput({ signal: ac.signal })),
    ).rejects.toBeInstanceOf(SearchError);
    expect(spy.calls).toEqual(["a"]); // b skipped due to abort
  });

  it("a slow engine that times out on its slice does not starve the next", async () => {
    const spy = { calls: [] as string[] };
    const engine = createFallbackEngine([
      {
        name: "slow",
        engineClass: "general",
        async search({ signal }) {
          spy.calls.push("slow");
          // Hang until this engine's per-engine slice aborts the signal.
          await new Promise<void>((resolve, reject) => {
            if (signal.aborted) return reject(new SearchError("TIMEOUT", "x"));
            signal.addEventListener(
              "abort",
              () => reject(new SearchError("TIMEOUT", "per-engine slice")),
              { once: true },
            );
          });
          return { results: [], backendHost: "slow", elapsedMs: 0 };
        },
      },
      fakeEngine("fast", { kind: "results", items: [item("f1")] }, spy),
    ]);
    // Overall budget small; per-engine floor (3s) is capped to remaining,
    // so "slow" is cut off and "fast" still runs.
    const r = await engine.search(engineInput({ timeoutMs: 4000 }));
    expect(r.results.map((x) => x.url)).toEqual(["https://f1"]);
    expect(spy.calls).toEqual(["slow", "fast"]);
  }, 10000);
});

describe("resolveEngine — chain construction", () => {
  const perms = { roots: [], sensitivePatterns: [], unsafeAllowSearchWithoutHook: true };

  it("zero-config → keyless chain mojeek→marginalia→wikipedia", () => {
    const r = resolveEngine({ permissions: perms });
    expect(r.chain).toEqual(["mojeek", "marginalia", "wikipedia"]);
    expect(r.keylessDefault).toBe(true);
  });

  it("disableMojeek drops mojeek", () => {
    const r = resolveEngine({ permissions: perms, disableMojeek: true });
    expect(r.chain).toEqual(["marginalia", "wikipedia"]);
  });

  it("braveApiKey → brave exclusively (no keyless leak by default)", () => {
    const r = resolveEngine({ permissions: perms, braveApiKey: "k" });
    expect(r.chain).toEqual(["brave"]);
    expect(r.keylessDefault).toBe(false);
  });

  it("explicit backend + fallbackToKeyless appends the keyless chain", () => {
    const r = resolveEngine({
      permissions: perms,
      braveApiKey: "k",
      fallbackToKeyless: true,
    });
    expect(r.chain).toEqual(["brave", "mojeek", "marginalia", "wikipedia"]);
  });

  it("searxngUrl → searxng exclusively", () => {
    const r = resolveEngine({
      permissions: perms,
      searxngUrl: "http://127.0.0.1:8888",
    });
    expect(r.chain).toEqual(["searxng"]);
  });

  it("brave + tavily + searxng order is brave, tavily, searxng", () => {
    const r = resolveEngine({
      permissions: perms,
      braveApiKey: "b",
      tavilyApiKey: "t",
      searxngUrl: "http://127.0.0.1:8888",
    });
    expect(r.chain).toEqual(["brave", "tavily", "searxng"]);
  });

  it("explicit session.engine override bypasses the chain", () => {
    const custom = {
      name: "custom",
      async search() {
        return { results: [], backendHost: "x", elapsedMs: 0 };
      },
    };
    const r = resolveEngine({ permissions: perms, engine: custom });
    expect(r.chain).toEqual(["custom"]);
    expect(r.engine).toBe(custom);
  });
});
