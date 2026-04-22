import type { LspLocation, LspOperation, LspSymbolInfo } from "./types.js";

export function formatHover(args: {
  path: string;
  line: number;
  character: number;
  contents: string;
}): string {
  return [
    `<operation>hover</operation>`,
    `<path>${args.path}</path>`,
    `<position>${args.line}:${args.character}</position>`,
    `<contents>`,
    args.contents,
    `</contents>`,
  ].join("\n");
}

export function formatLocations(args: {
  operation: "definition" | "references" | "implementation";
  path: string;
  line: number;
  character: number;
  locations: readonly LspLocation[];
  total?: number;
  truncated?: boolean;
}): string {
  const header = [
    `<operation>${args.operation}</operation>`,
    `<path>${args.path}</path>`,
    `<position>${args.line}:${args.character}</position>`,
  ].join("\n");
  const body = args.locations.map(formatLocationLine).join("\n");
  const hintLine =
    args.truncated && args.total !== undefined
      ? `(Showing ${args.locations.length} of ${args.total} ${args.operation}. Narrow by directory via grep if you need more.)`
      : `(${args.locations.length} ${args.operation === "references" ? "reference" : args.operation === "implementation" ? "implementation" : "definition"}(s).)`;
  return [header, `<locations>`, body, `</locations>`, hintLine].join("\n");
}

function formatLocationLine(l: LspLocation): string {
  return `${l.path}:${l.line}:${l.character}  ${l.preview}`;
}

export function formatDocumentSymbols(args: {
  path: string;
  symbols: readonly LspSymbolInfo[];
}): string {
  const header = [
    `<operation>documentSymbol</operation>`,
    `<path>${args.path}</path>`,
  ].join("\n");
  const body = renderSymbolTree(args.symbols, 0);
  return [header, `<symbols>`, body, `</symbols>`].join("\n");
}

export function formatWorkspaceSymbols(args: {
  query: string;
  symbols: readonly LspSymbolInfo[];
  total: number;
  truncated: boolean;
}): string {
  const header = [
    `<operation>workspaceSymbol</operation>`,
    `<query>${args.query}</query>`,
  ].join("\n");
  const body = args.symbols
    .map((s) => `${s.path}:${s.line}: ${s.kind} ${s.name}`)
    .join("\n");
  const hintLine = args.truncated
    ? `(Showing ${args.symbols.length} of ${args.total} matches. Narrow the query.)`
    : `(${args.total} match(es).)`;
  return [header, `<matches>`, body, `</matches>`, hintLine].join("\n");
}

function renderSymbolTree(
  symbols: readonly LspSymbolInfo[],
  depth: number,
): string {
  const indent = "  ".repeat(depth);
  const lines: string[] = [];
  for (const s of symbols) {
    lines.push(`${indent}${s.line}: ${s.kind} ${s.name}`);
    if (s.children && s.children.length > 0) {
      lines.push(renderSymbolTree(s.children, depth + 1));
    }
  }
  return lines.join("\n");
}

export function formatNoResults(args: {
  operation: LspOperation;
  hint: string;
}): string {
  return `<operation>${args.operation}</operation>\n(No results. ${args.hint})`;
}

export function formatServerStarting(args: {
  operation: LspOperation;
  language: string;
  retryMs: number;
}): string {
  return `<operation>${args.operation}</operation>\n(Language server for ${args.language} is still indexing. Retry in ~${args.retryMs}ms.)`;
}

/**
 * Truncate a hover markdown payload if it exceeds maxBytes. TSDoc-heavy
 * hovers regularly exceed 10 KB; we cap + annotate so the model knows
 * to narrow or Read the source.
 */
export function capHoverMarkdown(
  contents: string,
  maxBytes: number,
): { contents: string; truncated: boolean } {
  const bytes = Buffer.byteLength(contents, "utf8");
  if (bytes <= maxBytes) return { contents, truncated: false };
  // Rough truncation; we don't try to preserve valid markdown at the
  // split point, just preserve most of the content.
  const sliced = Buffer.from(contents, "utf8").subarray(0, maxBytes).toString("utf8");
  return {
    contents: `${sliced}\n... (hover truncated at ${maxBytes} bytes of ${bytes})`,
    truncated: true,
  };
}

/**
 * Truncate a single preview line to MAX_PREVIEW_LINE_LENGTH. Long
 * single-line files (minified JS) would otherwise flood output.
 */
export function capPreview(line: string, maxLen: number): string {
  if (line.length <= maxLen) return line;
  return `${line.slice(0, maxLen)}... (truncated)`;
}

/**
 * Hint text for `no_results` per operation.
 */
export function noResultsHint(operation: LspOperation): string {
  switch (operation) {
    case "hover":
      return "The position might be on whitespace or inside a comment.";
    case "definition":
      return "Symbol may be a primitive type (no source definition) or outside the indexed workspace.";
    case "references":
      return "No references found. The symbol is either unused or only defined. You may also be 1 character off — check the exact column in the source.";
    case "implementation":
      return "The symbol may not be an interface or abstract method, or no concrete implementations exist in the workspace.";
    case "documentSymbol":
      return "The file has no recognizable symbols (empty file, markdown, or unsupported syntax).";
    case "workspaceSymbol":
      return "No symbols matched the query. Try a broader query or a substring.";
  }
}
