import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Minimal .env loader. Walks up from cwd looking for a .env, parses KEY=VALUE
 * pairs, and populates process.env for any key that isn't already set. No
 * third-party dependency so the harness stays light.
 */
export function loadDotEnv(startDir: string = process.cwd()): string | null {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, ".env");
    if (existsSync(candidate)) {
      const raw = readFileSync(candidate, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq < 0) continue;
        const key = trimmed.slice(0, eq).trim();
        let val = trimmed.slice(eq + 1).trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        if (key && process.env[key] === undefined) {
          process.env[key] = val;
        }
      }
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
