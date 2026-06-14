import { describe, expect, it } from "vitest";
import {
  ENGINE_WEIGHTS,
  engineWeight,
  fuseRrf,
  fusedScore,
  KEYED_ENGINE_WEIGHT,
  RRF_K,
  type FusionCandidate,
} from "../src/engines/rank.js";
import type { WebSearchResultItem } from "../src/types.js";

const item = (u: string): WebSearchResultItem => ({
  title: `t-${u}`,
  url: `https://${u}`,
  snippet: "s",
});

describe("engineWeight", () => {
  it("weights general > niche > vertical", () => {
    expect(ENGINE_WEIGHTS.general).toBeGreaterThan(ENGINE_WEIGHTS.niche);
    expect(ENGINE_WEIGHTS.niche).toBeGreaterThan(ENGINE_WEIGHTS.vertical);
  });
  it("gives keyed engines (brave/tavily) a premium over keyless general", () => {
    expect(engineWeight("brave", "general")).toBe(KEYED_ENGINE_WEIGHT);
    expect(engineWeight("tavily", "general")).toBe(KEYED_ENGINE_WEIGHT);
    expect(KEYED_ENGINE_WEIGHT).toBeGreaterThan(ENGINE_WEIGHTS.general);
    expect(engineWeight("mojeek", "general")).toBe(ENGINE_WEIGHTS.general);
  });
});

describe("fusedScore", () => {
  it("is weight/(K+rank) for a single occurrence", () => {
    expect(fusedScore([{ engine: "mojeek", engineClass: "general", rank: 0 }])).toBeCloseTo(
      1.0 / (RRF_K + 0),
    );
    expect(fusedScore([{ engine: "wikipedia", engineClass: "vertical", rank: 0 }])).toBeCloseTo(
      0.6 / (RRF_K + 0),
    );
  });
  it("sums contributions for consensus (same URL, two engines)", () => {
    const s = fusedScore([
      { engine: "mojeek", engineClass: "general", rank: 1 },
      { engine: "marginalia", engineClass: "niche", rank: 0 },
    ]);
    expect(s).toBeCloseTo(1.0 / 11 + 0.8 / 10);
  });
});

describe("fuseRrf", () => {
  const cand = (
    u: string,
    occ: FusionCandidate["occurrences"],
    order: number,
  ): FusionCandidate => ({ item: item(u), occurrences: occ, order });

  it("ranks a consensus URL above a higher single-engine #1", () => {
    const out = fuseRrf([
      cand("seo", [{ engine: "mojeek", engineClass: "general", rank: 0 }], 0),
      cand(
        "shared",
        [
          { engine: "mojeek", engineClass: "general", rank: 1 },
          { engine: "marginalia", engineClass: "niche", rank: 0 },
        ],
        1,
      ),
    ]);
    expect(out[0]?.item.url).toBe("https://shared");
    expect(out[0]?.sources).toEqual(["marginalia", "mojeek"]); // best-rank first
  });

  it("keeps general above vertical at equal rank (weighting)", () => {
    const out = fuseRrf([
      cand("wiki", [{ engine: "wikipedia", engineClass: "vertical", rank: 0 }], 0),
      cand("web", [{ engine: "mojeek", engineClass: "general", rank: 0 }], 1),
    ]);
    expect(out[0]?.item.url).toBe("https://web");
  });

  it("is a stable no-op reorder for a single engine's already-ranked list", () => {
    const out = fuseRrf([
      cand("a", [{ engine: "mojeek", engineClass: "general", rank: 0 }], 0),
      cand("b", [{ engine: "mojeek", engineClass: "general", rank: 1 }], 1),
      cand("c", [{ engine: "mojeek", engineClass: "general", rank: 2 }], 2),
    ]);
    expect(out.map((r) => r.item.url)).toEqual([
      "https://a",
      "https://b",
      "https://c",
    ]);
  });
});
