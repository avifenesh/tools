import {
  FUZZY_SIBLING_LIMIT,
  FUZZY_SIBLING_THRESHOLD,
} from "./constants.js";

/**
 * Pick the top-N installed skill names most similar to a missing name.
 * Simple char-level overlap + prefix bonus — matches the pattern used
 * by `read`'s sibling suggestion without pulling in Levenshtein.
 */
export function suggestSkillSiblings(
  missing: string,
  installed: readonly string[],
): readonly string[] {
  const scored = installed
    .filter((n) => n !== missing)
    .map((n) => ({ name: n, score: similarity(missing, n) }))
    .filter((s) => s.score >= FUZZY_SIBLING_THRESHOLD)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, FUZZY_SIBLING_LIMIT).map((s) => s.name);
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  if (a.includes(b) || b.includes(a)) return 0.9;
  // Prefix overlap.
  let p = 0;
  const min = Math.min(a.length, b.length);
  while (p < min && a[p] === b[p]) p++;
  if (p >= 3) return 0.7 + p / 100;
  // Bigram overlap.
  const aBigrams = bigrams(a);
  const bBigrams = bigrams(b);
  if (aBigrams.size === 0 || bBigrams.size === 0) return 0;
  let hits = 0;
  for (const bg of aBigrams) {
    if (bBigrams.has(bg)) hits++;
  }
  return (2 * hits) / (aBigrams.size + bBigrams.size);
}

function bigrams(s: string): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) {
    set.add(s.slice(i, i + 2));
  }
  return set;
}
