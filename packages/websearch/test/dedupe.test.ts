import { describe, expect, it } from "vitest";
import { normalizeUrlForDedup } from "../src/engines/dedupe.js";

describe("normalizeUrlForDedup", () => {
  it("collapses www, trailing slash, default port, fragment", () => {
    const a = normalizeUrlForDedup("https://www.tokio.rs/");
    const b = normalizeUrlForDedup("https://tokio.rs");
    const c = normalizeUrlForDedup("https://tokio.rs:443/#section");
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("strips tracking params but keeps meaningful ones", () => {
    const tracked = normalizeUrlForDedup(
      "https://x.com/p?utm_source=nl&gclid=123&id=42",
    );
    const clean = normalizeUrlForDedup("https://x.com/p?id=42");
    expect(tracked).toBe(clean);
  });

  it("sorts query params so order doesn't matter", () => {
    const a = normalizeUrlForDedup("https://x.com/p?b=2&a=1");
    const b = normalizeUrlForDedup("https://x.com/p?a=1&b=2");
    expect(a).toBe(b);
  });

  it("does NOT collapse genuinely different pages", () => {
    expect(normalizeUrlForDedup("https://x.com/a")).not.toBe(
      normalizeUrlForDedup("https://x.com/b"),
    );
    // different query value = different page
    expect(normalizeUrlForDedup("https://w.org/?curid=1")).not.toBe(
      normalizeUrlForDedup("https://w.org/?curid=2"),
    );
  });

  it("is case-insensitive on scheme/host but not path", () => {
    expect(normalizeUrlForDedup("HTTPS://X.COM/Path")).toBe(
      normalizeUrlForDedup("https://x.com/Path"),
    );
    expect(normalizeUrlForDedup("https://x.com/Path")).not.toBe(
      normalizeUrlForDedup("https://x.com/path"),
    );
  });

  it("falls back to a trimmed lowercase key for unparseable input", () => {
    expect(normalizeUrlForDedup("  Not A URL  ")).toBe("not a url");
  });
});
