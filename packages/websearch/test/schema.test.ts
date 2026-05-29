import { describe, expect, it } from "vitest";
import { safeParseWebSearchParams } from "../src/schema.js";

describe("websearch schema", () => {
  it("accepts a minimal query", () => {
    const r = safeParseWebSearchParams({ query: "hello" });
    expect(r.ok).toBe(true);
  });

  it("rejects empty query", () => {
    const r = safeParseWebSearchParams({ query: "" });
    expect(r.ok).toBe(false);
  });

  it("rejects missing query", () => {
    const r = safeParseWebSearchParams({});
    expect(r.ok).toBe(false);
  });

  it("rejects a query over 512 chars", () => {
    const r = safeParseWebSearchParams({ query: "x".repeat(513) });
    expect(r.ok).toBe(false);
  });

  it("rejects non-string query", () => {
    const r = safeParseWebSearchParams({ query: 42 } as unknown);
    expect(r.ok).toBe(false);
  });

  it("accepts all optional fields", () => {
    const r = safeParseWebSearchParams({
      query: "rust async",
      count: 10,
      time_range: "week",
      language: "en",
      safe_search: "strict",
      categories: ["general", "it"],
    });
    expect(r.ok).toBe(true);
  });

  it("accepts count outside bounds at the schema level (clamped later)", () => {
    // The schema only enforces integer-ness; clamping is the orchestrator's job.
    const lo = safeParseWebSearchParams({ query: "x", count: 0 });
    const hi = safeParseWebSearchParams({ query: "x", count: 99 });
    expect(lo.ok).toBe(true);
    expect(hi.ok).toBe(true);
  });

  it("rejects non-integer count", () => {
    const r = safeParseWebSearchParams({ query: "x", count: 1.5 });
    expect(r.ok).toBe(false);
  });

  it("rejects unknown time_range enum", () => {
    const r = safeParseWebSearchParams({ query: "x", time_range: "decade" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const msg = r.issues.map((i) => i.message).join(" ");
      expect(msg).toMatch(/day\|week\|month\|year\|all/);
    }
  });

  it("rejects unknown safe_search enum", () => {
    const r = safeParseWebSearchParams({ query: "x", safe_search: "maybe" });
    expect(r.ok).toBe(false);
  });

  it("rejects categories with empty strings", () => {
    const r = safeParseWebSearchParams({ query: "x", categories: [""] });
    expect(r.ok).toBe(false);
  });

  it("rejects unknown fields via strictObject", () => {
    const r = safeParseWebSearchParams({
      query: "x",
      bogus: true,
    } as unknown);
    expect(r.ok).toBe(false);
  });

  it("redirects 'q' alias to 'query'", () => {
    const r = safeParseWebSearchParams({ q: "hello" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const msg = r.issues.map((i) => i.message).join(" ");
      expect(msg).toMatch(/Use 'query' instead/);
    }
  });

  it("redirects common alias typos with the right hint", () => {
    const cases: Array<[string, unknown, RegExp]> = [
      ["search", "hi", /Use 'query'/],
      ["search_query", "hi", /Use 'query'/],
      ["text", "hi", /Use 'query'/],
      ["term", "hi", /Use 'query'/],
      ["keywords", "hi", /Use 'query'/],
      ["num", 5, /Use 'count'/],
      ["num_results", 5, /Use 'count'/],
      ["n", 5, /Use 'count'/],
      ["limit", 5, /Use 'count'/],
      ["max_results", 5, /Use 'count'/],
      ["top_k", 5, /Use 'count'/],
      ["recency", "week", /Use 'time_range'/],
      ["freshness", "week", /Use 'time_range'/],
      ["date_range", "week", /Use 'time_range'/],
      ["time", "week", /Use 'time_range'/],
      ["since", "week", /Use 'time_range'/],
      ["lang", "en", /Use 'language'/],
      ["locale", "en", /Use 'language'/],
      ["hl", "en", /Use 'language'/],
      ["safesearch", 1, /Use 'safe_search'/],
      ["safe", true, /Use 'safe_search'/],
      ["filter", "x", /Use 'safe_search'/],
      ["adult", false, /Use 'safe_search'/],
      ["category", "it", /Use 'categories'/],
      ["vertical", "it", /Use 'categories'/],
      ["engine", "ddg", /Use 'categories'/],
      ["engines", "ddg", /Use 'categories'/],
      ["page", 2, /pagination not supported|Pagination is not supported/i],
      ["offset", 10, /Pagination is not supported/i],
      ["start", 10, /Pagination is not supported/i],
      ["site", "x.com", /No site filter/],
      ["domain", "x.com", /No site filter/],
      ["url", "x.com", /No site filter/],
      ["api_key", "abc", /configured on the session/],
      ["key", "abc", /configured on the session/],
      ["token", "abc", /configured on the session/],
    ];
    for (const [key, val, expected] of cases) {
      const r = safeParseWebSearchParams({
        query: "hello",
        [key]: val,
      });
      expect(r.ok, `expected ${key} to be rejected`).toBe(false);
      if (!r.ok) {
        const msg = r.issues.map((i) => i.message).join(" ");
        expect(msg, `hint for ${key}`).toMatch(expected);
      }
    }
  });
});
