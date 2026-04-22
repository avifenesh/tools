/**
 * Placeholder substitution for skill bodies. Matches Claude Code's
 * conventions:
 *
 * - `$ARGUMENTS` → the full string (string-form args) or a
 *   space-separated `key=value` rendering (object-form args).
 * - `$1`, `$2`, ... → positional tokens (whitespace-split, string-form only).
 * - `$ARGUMENTS[N]` → same as `$N` but 0-indexed.
 * - `${name}` → keyed substitution from object-form args.
 *
 * Unsubstituted placeholders are left as literal text.
 */
export function substituteArguments(
  body: string,
  args: string | Readonly<Record<string, string>> | undefined,
): string {
  if (args === undefined) return body;
  if (typeof args === "string") {
    return substituteString(body, args);
  }
  return substituteObject(body, args);
}

function substituteString(body: string, s: string): string {
  const tokens = s.trim().length === 0 ? [] : s.trim().split(/\s+/);
  let out = body;
  // $ARGUMENTS[N]
  out = out.replace(/\$ARGUMENTS\[(\d+)\]/g, (_, idx) => {
    const i = Number.parseInt(idx, 10);
    return tokens[i] ?? `$ARGUMENTS[${idx}]`;
  });
  // $ARGUMENTS
  out = out.replace(/\$ARGUMENTS\b/g, s);
  // $N (1-indexed)
  out = out.replace(/\$(\d+)\b/g, (_, n) => {
    const i = Number.parseInt(n, 10);
    return tokens[i - 1] ?? `$${n}`;
  });
  return out;
}

function substituteObject(
  body: string,
  obj: Readonly<Record<string, string>>,
): string {
  // $ARGUMENTS → space-separated key=value pairs (stable order: sorted).
  const rendered = Object.entries(obj)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  let out = body;
  out = out.replace(/\$ARGUMENTS\b/g, rendered);
  // ${name} → obj[name]
  out = out.replace(/\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_, name) => {
    const v = obj[name];
    return v !== undefined ? v : `\${${name}}`;
  });
  return out;
}
