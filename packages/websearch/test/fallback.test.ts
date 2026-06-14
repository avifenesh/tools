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

describe("FallbackEngine — order & first-non-empty-wins", () => {
  it("returns the first engine that has results, skipping earlier empties", async () => {
    const spy = { calls: [] as string[] };
    const engine = createFallbackEngine([
      fakeEngine("a", { kind: "empty" }, spy),
      fakeEngine("b", { kind: "results", items: [item("b1")] }, spy),
      fakeEngine("c", { kind: "results", items: [item("c1")] }, spy),
    ]);
    const r = (await engine.search(engineInput())) as FallbackEngineResult;
    expect(r.results.map((x) => x.url)).toEqual(["https://b1"]);
    expect(r.engine).toBe("b");
    expect(spy.calls).toEqual(["a", "b"]); // c never tried
    expect(r.attempts).toEqual([
      { engine: "a", outcome: "empty" },
      { engine: "b", outcome: "results" },
    ]);
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
    const r = await engine.search(engineInput());
    expect(r.results).toEqual([]); // trusted empty from the general engine
    expect(r.engine).toBe("mojeek");
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
