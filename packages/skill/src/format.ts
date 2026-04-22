/**
 * Render the `<skill>` XML wrap that carries an activated skill body into
 * conversation. The wrapper is load-bearing for auto-compaction: harness
 * summarizers can recognize the marker and preserve the full body.
 */
export interface FormatSkillArgs {
  readonly name: string;
  readonly dir: string;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly body: string;
  readonly resources: readonly string[];
  readonly bytes: number;
}

export function formatSkill(args: FormatSkillArgs): string {
  const fmSerialized = serializeFrontmatter(args.frontmatter);
  const instructions = args.body;
  const resourcesBlock =
    args.resources.length === 0
      ? ""
      : `<resources>\n${args.resources.join("\n")}\n</resources>\n`;
  const scriptsDir = `${args.dir}/scripts`;
  const referencesDir = `${args.dir}/references`;
  const hint = `(Skill "${args.name}" activated. Body is ${args.bytes} bytes. Scripts available via bash(${scriptsDir}/<name>). References via read(${referencesDir}/<name>).)`;

  return [
    `<skill name="${args.name}" dir="${args.dir}">`,
    `<frontmatter>`,
    fmSerialized,
    `</frontmatter>`,
    `<instructions>`,
    instructions,
    `</instructions>`,
    resourcesBlock.trimEnd(),
    `</skill>`,
    hint,
  ]
    .filter((s) => s.length > 0)
    .join("\n");
}

export function formatAlreadyLoaded(name: string): string {
  return `(Skill "${name}" is already active in this session. No new content was added.)`;
}

export interface FormatNotFoundArgs {
  readonly name: string;
  readonly siblings: readonly string[];
}

export function formatNotFound(args: FormatNotFoundArgs): string {
  if (args.siblings.length === 0) {
    return `(No skill matches "${args.name}". Check the catalog for installed skill names.)`;
  }
  return `(No skill matches "${args.name}". Did you mean: ${args.siblings.join(", ")}? Run with a listed name from the catalog.)`;
}

/**
 * Re-serialize the parsed frontmatter back to YAML-ish. We don't need
 * round-trip fidelity — the point is so the model sees the skill's
 * declared metadata alongside the body. Compact form, single-line per
 * key where possible.
 */
function serializeFrontmatter(
  fm: Readonly<Record<string, unknown>>,
): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(fm)) {
    lines.push(renderKeyValue(key, value, 0));
  }
  return lines.join("\n");
}

function renderKeyValue(key: string, value: unknown, indent: number): string {
  const pad = "  ".repeat(indent);
  if (value === null || value === undefined) return `${pad}${key}:`;
  if (typeof value === "boolean" || typeof value === "number") {
    return `${pad}${key}: ${String(value)}`;
  }
  if (typeof value === "string") {
    if (value.includes("\n")) {
      const body = value
        .split("\n")
        .map((l) => `${pad}  ${l}`)
        .join("\n");
      return `${pad}${key}: |\n${body}`;
    }
    return `${pad}${key}: ${quoteIfNeeded(value)}`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}${key}: []`;
    const items = value.map((v) => quoteIfNeeded(String(v))).join(", ");
    return `${pad}${key}: [${items}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return `${pad}${key}: {}`;
    const nested = entries
      .map(([k, v]) => renderKeyValue(k, v, indent + 1))
      .join("\n");
    return `${pad}${key}:\n${nested}`;
  }
  return `${pad}${key}: ${String(value)}`;
}

function quoteIfNeeded(s: string): string {
  if (/^[A-Za-z0-9_\-\.\/]+$/.test(s)) return s;
  return JSON.stringify(s);
}
