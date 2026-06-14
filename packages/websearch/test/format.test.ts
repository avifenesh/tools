import { describe, expect, it } from "vitest";
import {
  engineClassLabel,
  formatEmptyText,
  formatOkText,
} from "../src/format.js";
import type { SearchMetadata, WebSearchResultItem } from "../src/types.js";

const baseMeta = (over: Partial<SearchMetadata> = {}): SearchMetadata => ({
  query: "rust async runtime",
  backendHost: "www.mojeek.com",
  count: 2,
  timeRange: "all",
  elapsedMs: 100,
  engine: "mojeek",
  engineClass: "general",
  ...over,
});

const items: WebSearchResultItem[] = [
  { title: "Tokio", url: "https://tokio.rs", snippet: "An async runtime." },
  { title: "smol", url: "https://github.com/smol-rs/smol", snippet: "Small." },
];

describe("format — compact header (token efficiency)", () => {
  it("uses a single WEB header line, not an XML block", () => {
    const out = formatOkText({ meta: baseMeta(), results: items, requested: 2 });
    expect(out.startsWith('WEB "rust async runtime"')).toBe(true);
    expect(out).not.toContain("<search>");
    expect(out).not.toContain("<results>");
    // header carries engine + class label
    expect(out).toContain("mojeek (general web)");
    // no elapsedMs leaking into the body
    expect(out).not.toContain("100ms");
  });

  it("is materially smaller than the old XML format for 5 results", () => {
    const five = Array.from({ length: 5 }, (_, i) => ({
      title: `Result number ${i + 1} about async runtimes in rust`,
      url: `https://example.com/path/to/result-${i + 1}`,
      snippet:
        "A reasonably representative snippet that describes the page content in a sentence or two for the model to judge relevance.",
    }));
    const out = formatOkText({
      meta: baseMeta({ count: 5 }),
      results: five,
      requested: 5,
    });
    // header should be ~1 line; assert it's compact (< 90 chars before first result)
    const firstResultIdx = out.indexOf("1.");
    expect(firstResultIdx).toBeLessThan(90);
  });

  it("respects a custom snippet cap", () => {
    const long = [
      { title: "T", url: "https://x.com", snippet: "x".repeat(500) },
    ];
    const out = formatOkText({
      meta: baseMeta({ count: 1 }),
      results: long,
      requested: 1,
      snippetCap: 100,
    });
    // snippet trimmed to 100 + ellipsis
    expect(out).toContain("x".repeat(100) + "…");
    expect(out).not.toContain("x".repeat(101));
  });
});

describe("format — engine class label (quality signal)", () => {
  it("labels each class", () => {
    expect(engineClassLabel("general")).toBe("general web");
    expect(engineClassLabel("niche")).toBe("indie/small-web index");
    expect(engineClassLabel("vertical")).toBe("encyclopedic");
    expect(engineClassLabel(undefined)).toBe("web");
  });

  it("shows the encyclopedic label when Wikipedia served", () => {
    const out = formatOkText({
      meta: baseMeta({ engine: "wikipedia", engineClass: "vertical" }),
      results: items,
      requested: 2,
    });
    expect(out).toContain("wikipedia (encyclopedic)");
  });
});

describe("format — per-result age (only when backend provides it)", () => {
  it("renders age on the url line when present", () => {
    const withAge: WebSearchResultItem[] = [
      { title: "Doc", url: "https://x.com", snippet: "s", age: "2025-06-10" },
    ];
    const out = formatOkText({
      meta: baseMeta({ count: 1 }),
      results: withAge,
      requested: 1,
    });
    expect(out).toContain("https://x.com · 2025-06-10");
  });

  it("omits age entirely when absent (no 'unknown' noise)", () => {
    const out = formatOkText({ meta: baseMeta(), results: items, requested: 2 });
    expect(out).not.toContain("unknown");
    expect(out).not.toMatch(/·\s*$/m);
  });
});

describe("format — honest recency", () => {
  it("notes when the serving engine ignored the requested time_range", () => {
    const out = formatOkText({
      meta: baseMeta({ timeRange: "week", timeRangeApplied: false }),
      results: items,
      requested: 2,
    });
    expect(out).toContain("time:week NOT applied");
  });

  it("shows time:week as applied when the engine honored it", () => {
    const out = formatOkText({
      meta: baseMeta({
        engine: "brave",
        engineClass: "general",
        timeRange: "week",
        timeRangeApplied: true,
      }),
      results: items,
      requested: 2,
    });
    expect(out).toContain("time:week");
    expect(out).not.toContain("NOT applied");
  });

  it("says nothing about time when none was requested (timeRange=all)", () => {
    const out = formatOkText({ meta: baseMeta(), results: items, requested: 2 });
    expect(out).not.toContain("time:");
  });
});

describe("format — empty", () => {
  it("uses the compact header and a re-query hint", () => {
    const out = formatEmptyText(baseMeta({ count: 0 }));
    expect(out.startsWith('WEB "rust async runtime"')).toBe(true);
    expect(out).toMatch(/No results/);
  });
});
