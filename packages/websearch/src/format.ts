import { SNIPPET_CAP } from "./constants.js";
import type {
  SearchMetadata,
  WebSearchResultItem,
} from "./types.js";

/**
 * Render the <search>...</search> block that opens the ok / empty results.
 * Uniform shape so the model parses the same surface regardless of kind.
 */
export function renderSearchBlock(meta: SearchMetadata): string {
  const lines = [
    `<search>`,
    `  <query>${meta.query}</query>`,
    `  <backend>${meta.backendHost}</backend>`,
  ];
  if (meta.engine !== undefined && meta.engine.length > 0) {
    lines.push(`  <engine>${meta.engine}</engine>`);
  }
  lines.push(
    `  <count>${meta.count}</count>`,
    `  <time_range>${meta.timeRange}</time_range>`,
    `</search>`,
  );
  return lines.join("\n");
}

export function formatOkText(args: {
  meta: SearchMetadata;
  results: readonly WebSearchResultItem[];
  requested: number;
}): string {
  const header = renderSearchBlock(args.meta);
  const numbered = args.results
    .map((r, i) => {
      const snippet = trimSnippet(r.snippet);
      const snippetLine = snippet.length > 0 ? `\n   ${snippet}` : "";
      return `${i + 1}. ${r.title}\n   ${r.url}${snippetLine}`;
    })
    .join("\n");
  const resultsBlock = `<results>\n${numbered}\n</results>`;
  const n = args.results.length;
  const via =
    args.meta.engine !== undefined && args.meta.engine.length > 0
      ? `${args.meta.engine} (${args.meta.backendHost})`
      : args.meta.backendHost;
  let hint: string;
  if (n < args.requested) {
    hint = `(Only ${n} results — fewer than the ${args.requested} requested. Try broader terms or a wider time_range.)`;
  } else {
    hint = `(Found ${n} results for "${args.meta.query}" via ${via} in ${args.meta.elapsedMs}ms. Fetch a URL with webfetch to read it.)`;
  }
  return [header, resultsBlock, hint].join("\n");
}

export function formatEmptyText(meta: SearchMetadata): string {
  const header = `<search><query>${meta.query}</query><backend>${meta.backendHost}</backend><count>0</count></search>`;
  const hint = `(No results for "${meta.query}". Try different/broader keywords, a wider time_range, or check that the search backend has engines enabled.)`;
  return [header, hint].join("\n");
}

function trimSnippet(snippet: string): string {
  const collapsed = snippet.replace(/\s+/g, " ").trim();
  if (collapsed.length <= SNIPPET_CAP) return collapsed;
  return collapsed.slice(0, SNIPPET_CAP) + "…";
}
