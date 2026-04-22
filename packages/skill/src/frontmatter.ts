import {
  MAX_ARGUMENT_HINT_LENGTH,
  MAX_COMPATIBILITY_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH,
  SKILL_NAME_RE,
} from "./constants.js";

/**
 * Parse result for a SKILL.md file.
 */
export interface ParsedSkill {
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly body: string;
}

export interface FrontmatterError {
  readonly kind: "frontmatter_error";
  readonly reason: string;
  readonly line?: number;
}

function isFrontmatterError(x: unknown): x is FrontmatterError {
  return (
    typeof x === "object" &&
    x !== null &&
    (x as { kind?: unknown }).kind === "frontmatter_error"
  );
}

/**
 * Split a SKILL.md into frontmatter text + body. Returns null when there
 * is no frontmatter (no leading `---` line); the whole file is treated
 * as body per agentskills.io.
 *
 * Missing closing `---` after an opening one is an error — we don't
 * silently swallow a malformed header.
 */
export function splitFrontmatter(
  text: string,
): { fmText: string; body: string } | null | FrontmatterError {
  // Normalize CRLF to LF for parsing; preserve original body if no frontmatter.
  const normalized = text.replace(/\r\n/g, "\n");

  // Must start with --- on its own line. Leading BOM is tolerated.
  const stripped = normalized.startsWith("\uFEFF")
    ? normalized.slice(1)
    : normalized;

  if (!stripped.startsWith("---\n") && stripped !== "---") {
    // No frontmatter — whole file is body.
    return null;
  }

  // Find the closing ---. Must be on its own line.
  const lines = stripped.split("\n");
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      close = i;
      break;
    }
  }
  if (close === -1) {
    return {
      kind: "frontmatter_error",
      reason:
        "frontmatter has an opening `---` but no closing `---`; the file must have YAML between two `---` lines at the top",
    };
  }

  const fmText = lines.slice(1, close).join("\n");
  const body = lines.slice(close + 1).join("\n");
  return { fmText, body };
}

/**
 * Minimal YAML parser scoped to SKILL.md frontmatter. Supports:
 *
 * - `key: value` (scalar)
 * - `key: "value"` / `key: 'value'` (quoted scalar)
 * - `key: true|false` (boolean)
 * - `key: 42` (integer)
 * - `key: |` followed by indented block lines (literal block scalar)
 * - `key:` followed by a nested one-level map (indented key: value)
 * - `key: [a, b, c]` (flow-style array of strings)
 * - `key:` followed by `- a`, `- b` lines (block-style array of strings)
 *
 * Anything else is preserved as a raw string via best-effort, and
 * unexpected YAML constructs (anchors, aliases, complex types, nested
 * flows) are rejected with a structured error. We keep it small
 * intentionally — skills converge on the same ~10 fields.
 */
export function parseYamlFrontmatter(
  fmText: string,
): Record<string, unknown> | FrontmatterError {
  const out: Record<string, unknown> = {};
  const lines = fmText.split("\n");
  let i = 0;
  while (i < lines.length) {
    const rawLine = lines[i];
    if (rawLine === undefined) {
      i++;
      continue;
    }
    if (isBlankOrComment(rawLine)) {
      i++;
      continue;
    }
    // Top-level key must not be indented.
    if (startsWithWhitespace(rawLine)) {
      return {
        kind: "frontmatter_error",
        reason: `unexpected indentation at top-level line ${i + 1}`,
        line: i + 1,
      };
    }
    const colonIdx = rawLine.indexOf(":");
    if (colonIdx === -1) {
      return {
        kind: "frontmatter_error",
        reason: `expected 'key: value' on line ${i + 1}`,
        line: i + 1,
      };
    }
    const key = rawLine.slice(0, colonIdx).trim();
    if (!key) {
      return {
        kind: "frontmatter_error",
        reason: `empty key on line ${i + 1}`,
        line: i + 1,
      };
    }
    const rest = rawLine.slice(colonIdx + 1);
    const inline = rest.trim();

    // Case 1: literal block scalar — `key: |`
    if (inline === "|" || inline === "|-" || inline === "|+") {
      const [value, consumed] = readLiteralBlock(lines, i + 1);
      out[key] = value;
      i = consumed;
      continue;
    }

    // Case 2: value present on same line.
    if (inline.length > 0) {
      // Flow-style array: `[a, b, c]`
      if (inline.startsWith("[") && inline.endsWith("]")) {
        out[key] = parseFlowArray(inline);
        i++;
        continue;
      }
      out[key] = parseScalar(inline);
      i++;
      continue;
    }

    // Case 3: value is nested on following indented lines.
    // Look at the next non-blank line to decide: map vs array.
    const nextNonBlank = findNextNonBlank(lines, i + 1);
    if (nextNonBlank === -1) {
      // Nothing follows — empty value.
      out[key] = "";
      i++;
      continue;
    }
    const nextLine = lines[nextNonBlank]!;
    if (!startsWithWhitespace(nextLine)) {
      // The next top-level key — current key has empty value.
      out[key] = "";
      i++;
      continue;
    }
    if (nextLine.trimStart().startsWith("- ")) {
      // Block array of strings.
      const [arr, consumed] = readBlockArray(lines, i + 1);
      out[key] = arr;
      i = consumed;
      continue;
    }
    // Nested map (one level). We only support string → scalar keys.
    const nested = readNestedMap(lines, i + 1);
    if (!Array.isArray(nested)) {
      return nested;
    }
    const [map, consumed] = nested;
    out[key] = map;
    i = consumed;
  }
  return out;
}

function isBlankOrComment(line: string): boolean {
  const t = line.trim();
  return t.length === 0 || t.startsWith("#");
}

function startsWithWhitespace(line: string): boolean {
  return /^[ \t]/.test(line);
}

function findNextNonBlank(lines: readonly string[], from: number): number {
  for (let i = from; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (!isBlankOrComment(line)) return i;
  }
  return -1;
}

function parseScalar(s: string): unknown {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  if (/^-?\d+$/.test(s)) return Number.parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return Number.parseFloat(s);
  return s;
}

function parseFlowArray(s: string): string[] {
  const inner = s.slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(",").map((item) => {
    const t = item.trim();
    if (
      (t.startsWith('"') && t.endsWith('"')) ||
      (t.startsWith("'") && t.endsWith("'"))
    ) {
      return t.slice(1, -1);
    }
    return t;
  });
}

function readLiteralBlock(
  lines: readonly string[],
  from: number,
): [string, number] {
  // Find indentation of first non-blank block line.
  let first = from;
  while (first < lines.length) {
    const line = lines[first];
    if (line === undefined) break;
    if (line.trim().length === 0) {
      first++;
      continue;
    }
    break;
  }
  if (first >= lines.length) return ["", from];
  const firstLine = lines[first]!;
  const indent = firstLine.match(/^[ \t]+/)?.[0] ?? "";
  if (!indent) return ["", from];
  const collected: string[] = [];
  let i = from;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break;
    if (line.trim().length === 0) {
      collected.push("");
      i++;
      continue;
    }
    if (!line.startsWith(indent)) break;
    collected.push(line.slice(indent.length));
    i++;
  }
  // Trim trailing blanks conservatively (spec equivalent of `|-`).
  while (collected.length > 0 && collected[collected.length - 1] === "") {
    collected.pop();
  }
  return [collected.join("\n"), i];
}

function readBlockArray(
  lines: readonly string[],
  from: number,
): [string[], number] {
  const arr: string[] = [];
  let i = from;
  let indent: string | null = null;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break;
    if (isBlankOrComment(line)) {
      i++;
      continue;
    }
    const leading = line.match(/^[ \t]+/)?.[0] ?? "";
    if (!leading) break;
    if (indent === null) indent = leading;
    if (leading !== indent) break;
    const after = line.slice(leading.length);
    if (!after.startsWith("- ") && after !== "-") break;
    const value = after === "-" ? "" : after.slice(2).trim();
    arr.push(typeof parseScalar(value) === "string" ? (parseScalar(value) as string) : String(parseScalar(value)));
    i++;
  }
  return [arr, i];
}

function readNestedMap(
  lines: readonly string[],
  from: number,
): [Record<string, unknown>, number] | FrontmatterError {
  const map: Record<string, unknown> = {};
  let i = from;
  let indent: string | null = null;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break;
    if (isBlankOrComment(line)) {
      i++;
      continue;
    }
    const leading = line.match(/^[ \t]+/)?.[0] ?? "";
    if (!leading) break;
    if (indent === null) indent = leading;
    if (!line.startsWith(indent)) break;
    if (leading.length < indent.length) break;
    const content = line.slice(indent.length);
    const colonIdx = content.indexOf(":");
    if (colonIdx === -1) {
      return {
        kind: "frontmatter_error",
        reason: `expected 'key: value' in nested map on line ${i + 1}`,
        line: i + 1,
      };
    }
    const key = content.slice(0, colonIdx).trim();
    const rest = content.slice(colonIdx + 1).trim();
    if (rest.startsWith("[") && rest.endsWith("]")) {
      map[key] = parseFlowArray(rest);
    } else {
      map[key] = parseScalar(rest);
    }
    i++;
  }
  return [map, i];
}

/**
 * Full validation: parse + required fields + constraints + name match.
 */
export interface ValidateArgs {
  readonly fmText: string;
  readonly body: string;
  /** Basename of the containing skill dir; must equal frontmatter.name. */
  readonly expectedName: string;
}

export interface ValidatedSkill {
  readonly kind: "ok";
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly body: string;
}

export interface ValidationError {
  readonly kind: "error";
  readonly reason: string;
  readonly code: "INVALID_FRONTMATTER" | "NAME_MISMATCH";
  readonly line?: number;
}

export function validateFrontmatter(
  args: ValidateArgs,
): ValidatedSkill | ValidationError {
  const parsed = parseYamlFrontmatter(args.fmText);
  if (isFrontmatterError(parsed)) {
    return {
      kind: "error",
      code: "INVALID_FRONTMATTER",
      reason: parsed.reason,
      ...(parsed.line !== undefined ? { line: parsed.line } : {}),
    };
  }
  const fm: Record<string, unknown> = parsed;

  // Required: name
  const name = fm.name;
  if (typeof name !== "string" || name.length === 0) {
    return {
      kind: "error",
      code: "INVALID_FRONTMATTER",
      reason: "frontmatter missing required field 'name'",
    };
  }
  if (name.length > MAX_NAME_LENGTH) {
    return {
      kind: "error",
      code: "INVALID_FRONTMATTER",
      reason: `frontmatter 'name' exceeds ${MAX_NAME_LENGTH} chars`,
    };
  }
  if (!SKILL_NAME_RE.test(name)) {
    return {
      kind: "error",
      code: "INVALID_FRONTMATTER",
      reason: `frontmatter 'name' must match lowercase-kebab-case regex ${SKILL_NAME_RE.source}; got "${name}"`,
    };
  }

  // Required: description
  const description = fm.description;
  if (typeof description !== "string" || description.length === 0) {
    return {
      kind: "error",
      code: "INVALID_FRONTMATTER",
      reason: "frontmatter missing required field 'description'",
    };
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return {
      kind: "error",
      code: "INVALID_FRONTMATTER",
      reason: `frontmatter 'description' exceeds ${MAX_DESCRIPTION_LENGTH} chars`,
    };
  }

  // Optional constraints
  const compat = fm.compatibility;
  if (compat !== undefined) {
    if (typeof compat !== "string") {
      return {
        kind: "error",
        code: "INVALID_FRONTMATTER",
        reason: "'compatibility' must be a string",
      };
    }
    if (compat.length > MAX_COMPATIBILITY_LENGTH) {
      return {
        kind: "error",
        code: "INVALID_FRONTMATTER",
        reason: `'compatibility' exceeds ${MAX_COMPATIBILITY_LENGTH} chars`,
      };
    }
  }

  const hint = fm["argument-hint"];
  if (hint !== undefined) {
    if (typeof hint !== "string") {
      return {
        kind: "error",
        code: "INVALID_FRONTMATTER",
        reason: "'argument-hint' must be a string",
      };
    }
    if (hint.length > MAX_ARGUMENT_HINT_LENGTH) {
      return {
        kind: "error",
        code: "INVALID_FRONTMATTER",
        reason: `'argument-hint' exceeds ${MAX_ARGUMENT_HINT_LENGTH} chars`,
      };
    }
  }

  // allowed-tools can be a string or a string[].
  if (fm["allowed-tools"] !== undefined) {
    const at = fm["allowed-tools"];
    if (typeof at === "string") {
      // Normalize to array.
      const items = at
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      fm["allowed-tools"] = items;
    } else if (!Array.isArray(at)) {
      return {
        kind: "error",
        code: "INVALID_FRONTMATTER",
        reason: "'allowed-tools' must be a string or string[]",
      };
    }
  }

  // Name must match containing directory.
  if (name !== args.expectedName) {
    return {
      kind: "error",
      code: "NAME_MISMATCH",
      reason: `frontmatter 'name' ("${name}") does not match the skill directory ("${args.expectedName}")`,
    };
  }

  return {
    kind: "ok",
    frontmatter: fm,
    body: args.body,
  };
}
