import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  MAX_RESOURCES_PER_FOLDER,
  RESOURCE_FOLDERS,
  SKILL_FILENAME,
} from "./constants.js";
import { splitFrontmatter, validateFrontmatter } from "./frontmatter.js";
import type {
  LoadedSkill,
  SkillEntry,
  SkillRegistry,
} from "./types.js";

/**
 * Filesystem-backed SkillRegistry. Walks each configured root looking
 * for `<name>/SKILL.md`, parses frontmatter, and builds a catalog.
 * Precedence: lower-index roots shadow higher-index ones when two
 * subdirectories share the same name.
 */
export class FilesystemSkillRegistry implements SkillRegistry {
  constructor(private readonly roots: readonly string[]) {}

  async discover(): Promise<readonly SkillEntry[]> {
    const byName = new Map<string, SkillEntry>();
    const shadows = new Map<string, string[]>();
    for (let rootIndex = 0; rootIndex < this.roots.length; rootIndex++) {
      const root = this.roots[rootIndex]!;
      let children: string[];
      try {
        children = await readdir(root);
      } catch {
        continue;
      }
      for (const child of children) {
        const dir = path.join(root, child);
        let st;
        try {
          st = await stat(dir);
        } catch {
          continue;
        }
        if (!st.isDirectory()) continue;
        const skillPath = path.join(dir, SKILL_FILENAME);
        let text: string;
        try {
          text = await readFile(skillPath, "utf8");
        } catch {
          continue;
        }
        const split = splitFrontmatter(text);
        if (split === null) {
          // No frontmatter — skip silently; not a skill.
          continue;
        }
        if ("kind" in split) {
          // Invalid frontmatter — still surface the entry so the
          // orchestrator can emit a structured error when the model
          // tries to activate it. Synthetic entry marked by a sentinel
          // in frontmatter.
          byName.set(child, {
            name: child,
            description: "",
            dir,
            rootIndex,
            frontmatter: {
              __skill_error: split.reason,
              ...(split.line !== undefined ? { __skill_error_line: split.line } : {}),
            },
          });
          continue;
        }
        const validated = validateFrontmatter({
          fmText: split.fmText,
          body: split.body,
          expectedName: child,
        });
        if (validated.kind === "error") {
          byName.set(child, {
            name: child,
            description: "",
            dir,
            rootIndex,
            frontmatter: {
              __skill_error: validated.reason,
              __skill_error_code: validated.code,
              ...(validated.line !== undefined
                ? { __skill_error_line: validated.line }
                : {}),
            },
          });
          continue;
        }
        // Handle shadowing — the current entry wins only if its root is
        // lower-index than an existing one's.
        const existing = byName.get(child);
        if (existing !== undefined) {
          if (existing.rootIndex <= rootIndex) {
            const list = shadows.get(child) ?? [];
            list.push(dir);
            shadows.set(child, list);
            continue;
          }
          const list = shadows.get(child) ?? [];
          list.push(existing.dir);
          shadows.set(child, list);
        }
        byName.set(child, {
          name: child,
          description:
            typeof validated.frontmatter.description === "string"
              ? (validated.frontmatter.description as string)
              : "",
          dir,
          rootIndex,
          frontmatter: validated.frontmatter,
        });
      }
    }
    const entries = Array.from(byName.values()).map((e) => {
      const shadowed = shadows.get(e.name);
      return shadowed && shadowed.length > 0 ? { ...e, shadowed } : e;
    });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return entries;
  }

  async load(name: string): Promise<LoadedSkill | null> {
    const entries = await this.discover();
    const entry = entries.find((e) => e.name === name);
    if (!entry) return null;
    const skillPath = path.join(entry.dir, SKILL_FILENAME);
    const text = await readFile(skillPath, "utf8");
    const split = splitFrontmatter(text);
    if (split === null || "kind" in split) {
      // Frontmatter broke since discovery — caller handles.
      return null;
    }
    const validated = validateFrontmatter({
      fmText: split.fmText,
      body: split.body,
      expectedName: name,
    });
    if (validated.kind === "error") {
      return null;
    }
    const resources = await enumerateResources(entry.dir);
    const loaded: LoadedSkill = {
      name: entry.name,
      description: entry.description,
      dir: entry.dir,
      rootIndex: entry.rootIndex,
      frontmatter: validated.frontmatter,
      body: validated.body,
      resources,
    };
    if (entry.shadowed) {
      return { ...loaded, shadowed: entry.shadowed };
    }
    return loaded;
  }
}

async function enumerateResources(dir: string): Promise<readonly string[]> {
  const out: string[] = [];
  for (const folder of RESOURCE_FOLDERS) {
    const p = path.join(dir, folder);
    let children: string[];
    try {
      children = await readdir(p);
    } catch {
      continue;
    }
    children.sort();
    const capped = children.slice(0, MAX_RESOURCES_PER_FOLDER);
    for (const c of capped) {
      out.push(path.join(folder, c));
    }
    if (children.length > MAX_RESOURCES_PER_FOLDER) {
      out.push(
        path.join(folder, `(... ${children.length - MAX_RESOURCES_PER_FOLDER} more)`),
      );
    }
  }
  return out;
}
