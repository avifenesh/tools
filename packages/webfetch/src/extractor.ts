import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";

/**
 * HTML → main-content-markdown pipeline.
 *
 * 1. JSDOM parse (lightweight; enough for Readability).
 * 2. Readability — Mozilla's main-content extractor. Returns null on
 *    too-short / non-article pages; we fall back to raw HTML→markdown in
 *    that case.
 * 3. turndown for HTML→markdown conversion.
 *
 * The pipeline is intentionally simple — no custom rules, no plugins.
 * If consumers want different extraction, they can subclass the engine
 * and bypass this entirely.
 */

let cachedTurndown: TurndownService | null = null;

function getTurndown(): TurndownService {
  if (cachedTurndown === null) {
    cachedTurndown = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
      bulletListMarker: "-",
      emDelimiter: "*",
    });
  }
  return cachedTurndown;
}

export function extractMarkdown(
  html: string,
  url: string,
): { markdown: string; fallback: boolean } {
  let dom: JSDOM;
  try {
    dom = new JSDOM(html, { url });
  } catch {
    // JSDOM blew up on malformed HTML — skip readability, try turndown raw.
    return fallbackTurndown(html);
  }

  // Readability mutates the DOM, so run it first.
  try {
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (article?.content && article.content.trim().length > 0) {
      const td = getTurndown();
      const md = td.turndown(article.content);
      const title = article.title ? `# ${article.title}\n\n` : "";
      return { markdown: `${title}${md}`.trim() + "\n", fallback: false };
    }
  } catch {
    // Fall through to turndown on the whole doc.
  }
  return fallbackTurndown(html);
}

function fallbackTurndown(html: string): {
  markdown: string;
  fallback: boolean;
} {
  try {
    const td = getTurndown();
    const md = td.turndown(html);
    return { markdown: md, fallback: true };
  } catch {
    return { markdown: html, fallback: true };
  }
}

/**
 * Light content-type check — returns true if the response should run
 * through the HTML extractor. JSON / plain text / CSV / XML pass through.
 */
export function isHtmlLike(contentType: string): boolean {
  const lower = contentType.toLowerCase();
  return (
    lower.includes("text/html") || lower.includes("application/xhtml+xml")
  );
}

/**
 * Returns the major content-type without charset / params.
 *   "text/html; charset=utf-8" -> "text/html"
 */
export function parseContentTypeBase(header: string): string {
  const semicolon = header.indexOf(";");
  return (semicolon < 0 ? header : header.slice(0, semicolon))
    .trim()
    .toLowerCase();
}
