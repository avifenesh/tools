/**
 * Minimal, dependency-free HTML text utilities for the scrape-based engines
 * (Mojeek) and tagged-snippet APIs (Wikipedia's `<span class=searchmatch>`).
 *
 * We deliberately do NOT pull in jsdom/readability here (unlike webfetch):
 * websearch parses a small, known result-list structure, not arbitrary
 * article bodies, so a targeted entity-decode + tag-strip keeps the package
 * light and the parse fast. The Mojeek block parser lives in its engine.
 */

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsaquo: "\u203a",
  lsaquo: "\u2039",
  raquo: "\u00bb",
  laquo: "\u00ab",
  hellip: "\u2026",
  mdash: "\u2014",
  ndash: "\u2013",
  rsquo: "\u2019",
  lsquo: "\u2018",
  ldquo: "\u201c",
  rdquo: "\u201d",
  middot: "\u00b7",
  deg: "\u00b0",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
  eacute: "\u00e9",
  egrave: "\u00e8",
  agrave: "\u00e0",
  ccedil: "\u00e7",
  uuml: "\u00fc",
  ouml: "\u00f6",
  auml: "\u00e4",
};

/** Decode the HTML entities that actually occur in SERP markup. */
export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body) => {
    const b = body as string;
    if (b.charAt(0) === "#") {
      const isHex = b.charAt(1) === "x" || b.charAt(1) === "X";
      const code = Number.parseInt(b.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return m;
        }
      }
      return m;
    }
    const named = NAMED_ENTITIES[b.toLowerCase()];
    return named ?? m;
  });
}

/** Strip HTML tags, decode entities, and collapse whitespace. */
export function stripTags(html: string): string {
  const noTags = html.replace(/<[^>]*>/g, " ");
  return decodeEntities(noTags).replace(/\s+/g, " ").trim();
}
