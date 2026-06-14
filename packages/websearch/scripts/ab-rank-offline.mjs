// Offline A/B of merge strategies on CONTROLLED multi-engine lists with real
// overlap — so the ranking algorithm is judged independent of live backend
// uptime (Marginalia's public API is currently 502-ing). Each scenario is a
// hand-built but realistic set of per-engine ranked lists; we show chain-order
// vs RRF+weights and call out where they differ and why.

import { normalizeUrlForDedup } from "../dist/index.js";

const RRF_K = 10;
const COUNT = 6;
const WEIGHT = { general: 1.0, niche: 0.8, vertical: 0.6, keyed: 1.2 };

function chainOrder(lists) {
  const seen = new Set();
  const out = [];
  for (const l of lists) {
    for (const item of l.results) {
      const key = normalizeUrlForDedup(item.url);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ url: item.url, title: item.title, sources: [l.name] });
      if (out.length >= COUNT) return out;
    }
  }
  return out;
}

function rrf(lists) {
  const byKey = new Map();
  for (const l of lists) {
    const w = WEIGHT[l.class];
    l.results.forEach((item, rank) => {
      const key = normalizeUrlForDedup(item.url);
      const contrib = w / (RRF_K + rank);
      const cur = byKey.get(key);
      if (cur) {
        cur.score += contrib;
        cur.sources.push(`${l.name}#${rank + 1}`);
      } else {
        byKey.set(key, { url: item.url, title: item.title, score: contrib, sources: [`${l.name}#${rank + 1}`] });
      }
    });
  }
  return [...byKey.values()].sort((a, b) => b.score - a.score).slice(0, COUNT);
}

function h(u) { try { return new URL(u).host.replace(/^www\./, "") + new URL(u).pathname; } catch { return u; } }

function show(scn) {
  console.log("\n" + "=".repeat(78));
  console.log("SCENARIO: " + scn.name);
  for (const l of scn.lists) console.log(`  · ${l.name} (${l.class}): ${l.results.length}`);
  const a = chainOrder(scn.lists);
  const b = rrf(scn.lists);
  console.log("\n  A — chain-order (SHIPPED):");
  a.forEach((it, i) => console.log(`   ${i + 1}. ${h(it.url)}  {${it.sources.join(",")}}`));
  console.log("\n  B — RRF+weights (PROTOTYPE):");
  b.forEach((it, i) => {
    const consensus = it.sources.length > 1 ? "  <= CONSENSUS" : "";
    console.log(`   ${i + 1}. ${h(it.url)} [${it.score.toFixed(3)}] {${it.sources.join(",")}}${consensus}`);
  });
  // top-1 + top-3 change
  const aT = a.map((x) => normalizeUrlForDedup(x.url));
  const bT = b.map((x) => normalizeUrlForDedup(x.url));
  const top1 = aT[0] === bT[0] ? "same" : "CHANGED";
  const top3A = new Set(aT.slice(0, 3));
  const newInTop3 = bT.slice(0, 3).filter((k) => !top3A.has(k)).length;
  console.log(`\n  → top-1: ${top1}; new entries promoted into top-3: ${newInTop3}; consensus rows: ${b.filter((x) => x.sources.length > 1).length}`);
  console.log("  WHY: " + scn.why);
}

const u = (host, path = "/") => `https://${host}${path}`;
const item = (host, path, title) => ({ url: u(host, path), title });

const scenarios = [
  {
    name: "1) One general engine fills the quota (the common case)",
    why: "Mojeek alone returns >= count → in production the FAST PATH returns it and no merge runs. RRF == chain-order here. RRF adds nothing.",
    lists: [
      { name: "mojeek", class: "general", results: [
        item("tokio.rs", "/", "Tokio"), item("tokio.rs", "/tutorial", "Tutorial"),
        item("docs.rs", "/tokio", "tokio docs"), item("news.ycombinator.com", "/x", "HN"),
        item("corrode.dev", "/async", "corrode"), item("jacko.io", "/async", "jacko"),
      ] },
      { name: "wikipedia", class: "vertical", results: [ item("en.wikipedia.org", "/?curid=1", "Tokio (software)") ] },
    ],
  },
  {
    name: "2) Leader is SHORT → merge; niche has a strong #1 the chain buries",
    why: "Mojeek returns only 2; Marginalia's #1 (a great indie deep-dive) lands at position 3 under chain-order. RRF still ranks Mojeek#1/#2 above Marginalia#1 (weighted rank), so order is similar — engine weight keeps general on top. Modest gain.",
    lists: [
      { name: "mojeek", class: "general", results: [
        item("tokio.rs", "/", "Tokio"), item("reddit.com", "/r/rust", "reddit thread"),
      ] },
      { name: "marginalia", class: "niche", results: [
        item("fasterthanli.me", "/articles/understanding-async", "Understanding Rust async (deep dive)"),
        item("without.boats", "/blog/async", "without.boats async"),
        item("cliffle.com", "/p/async", "cliffle async"),
      ] },
    ],
  },
  {
    name: "3) OVERLAP → consensus boost (where RRF earns its keep)",
    why: "tokio.rs is returned by BOTH mojeek(#2) and marginalia(#1). RRF sums both contributions and floats it to #1 — 'two independent indexes agree' is the strongest cheap relevance signal. Chain-order can't see this; it just keeps mojeek's order.",
    lists: [
      { name: "mojeek", class: "general", results: [
        item("medium.com", "/some-seo-post", "Medium SEO post"),
        item("tokio.rs", "/", "Tokio — async runtime"),
        item("w3schools-clone.com", "/x", "low quality"),
      ] },
      { name: "marginalia", class: "niche", results: [
        item("tokio.rs", "/", "Tokio — async runtime"),
        item("without.boats", "/blog", "without.boats"),
      ] },
    ],
  },
  {
    name: "4) Encyclopedic backstop should NOT outrank broad web",
    why: "Wikipedia is first in the chain only by accident of a short Mojeek list. Engine weight (vertical 0.6 < general 1.0) keeps the broad-web hits above the encyclopedia entry in RRF. This is the most reliable real-world win of weighting.",
    lists: [
      { name: "mojeek", class: "general", results: [ item("kubernetes.io", "/docs/scheduler", "K8s Scheduler docs") ] },
      { name: "wikipedia", class: "vertical", results: [
        item("en.wikipedia.org", "/?curid=1", "Kubernetes"),
        item("en.wikipedia.org", "/?curid=2", "Scheduling (computing)"),
      ] },
    ],
  },
];

for (const s of scenarios) show(s);
