/**
 * Levenshtein distance between two strings. O(n*m) time, O(min(n,m)) space.
 * Used for fuzzy-match candidates on OLD_STRING_NOT_FOUND.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Ensure b is the shorter one so our DP row is the shorter dimension.
  let s1 = a;
  let s2 = b;
  if (s1.length < s2.length) {
    const t = s1;
    s1 = s2;
    s2 = t;
  }

  const m = s1.length;
  const n = s2.length;
  const prev = new Array<number>(n + 1);
  const curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    const si = s1.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = si === s2.charCodeAt(j - 1) ? 0 : 1;
      const del = (prev[j] as number) + 1;
      const ins = (curr[j - 1] as number) + 1;
      const sub = (prev[j - 1] as number) + cost;
      curr[j] = Math.min(del, ins, sub);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j] as number;
  }

  return prev[n] as number;
}

export function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}
