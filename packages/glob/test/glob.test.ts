import { execFileSync } from "node:child_process";
import { utimesSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { glob } from "../src/glob.js";
import type {
  GlobEngine,
  GlobEngineInput,
} from "../src/types.js";
import { makeSession, makeTempDir, write } from "./helpers.js";

function assertKind<T extends { kind: string }>(
  r: T,
  kind: T["kind"],
): asserts r is Extract<T, { kind: typeof kind }> {
  if (r.kind !== kind) {
    throw new Error(
      `Expected kind=${kind}, got kind=${r.kind}: ${
        "output" in r
          ? (r as unknown as { output: string }).output
          : JSON.stringify(r)
      }`,
    );
  }
}

describe("glob — basic pattern matching", () => {
  it("returns top-level matches for a non-recursive pattern", async () => {
    const dir = makeTempDir();
    write(dir, "a.ts", "x");
    write(dir, "b.ts", "x");
    write(dir, "nested/c.ts", "x");
    const r = await glob({ pattern: "*.ts" }, makeSession(dir));
    assertKind(r, "paths");
    const names = r.paths.map((p) => p.split("/").pop());
    expect(names).toEqual(expect.arrayContaining(["a.ts", "b.ts"]));
    expect(names).not.toContain("c.ts");
  });

  it("returns recursive matches for **/*.ts", async () => {
    const dir = makeTempDir();
    write(dir, "a.ts", "x");
    write(dir, "nested/deep/b.ts", "x");
    const r = await glob({ pattern: "**/*.ts" }, makeSession(dir));
    assertKind(r, "paths");
    const names = r.paths.map((p) => p.split("/").pop()).sort();
    expect(names).toEqual(["a.ts", "b.ts"]);
  });

  it("supports brace expansion *.{ts,tsx}", async () => {
    const dir = makeTempDir();
    write(dir, "a.ts", "x");
    write(dir, "b.tsx", "x");
    write(dir, "c.js", "x");
    const r = await glob({ pattern: "*.{ts,tsx}" }, makeSession(dir));
    assertKind(r, "paths");
    const names = r.paths.map((p) => p.split("/").pop()).sort();
    expect(names).toEqual(["a.ts", "b.tsx"]);
  });

  it("returns absolute paths", async () => {
    const dir = makeTempDir();
    write(dir, "a.ts", "x");
    const r = await glob({ pattern: "*.ts" }, makeSession(dir));
    assertKind(r, "paths");
    expect(r.paths.every((p) => p.startsWith("/"))).toBe(true);
  });

  it("output wraps with <pattern>/<paths> and final hint", async () => {
    const dir = makeTempDir();
    write(dir, "a.ts", "x");
    const r = await glob({ pattern: "*.ts" }, makeSession(dir));
    assertKind(r, "paths");
    expect(r.output).toContain("<pattern>*.ts</pattern>");
    expect(r.output).toContain("<paths>");
    expect(r.output).toContain("Found 1 file(s) matching the pattern");
  });
});

describe("glob — sort (mtime DESC, path ASC tiebreak)", () => {
  it("sorts by mtime descending", async () => {
    const dir = makeTempDir();
    const older = write(dir, "older.ts", "x");
    const newer = write(dir, "newer.ts", "x");
    utimesSync(older, new Date(2020, 0, 1), new Date(2020, 0, 1));
    utimesSync(newer, new Date(2024, 0, 1), new Date(2024, 0, 1));
    const r = await glob({ pattern: "*.ts" }, makeSession(dir));
    assertKind(r, "paths");
    expect(r.paths[0]).toContain("newer.ts");
    expect(r.paths[1]).toContain("older.ts");
  });

  it("tiebreaks equal mtimes by path ascending for determinism", async () => {
    const dir = makeTempDir();
    const a = write(dir, "aaa.ts", "x");
    const b = write(dir, "bbb.ts", "x");
    const c = write(dir, "ccc.ts", "x");
    const t = new Date(2024, 0, 1);
    utimesSync(a, t, t);
    utimesSync(b, t, t);
    utimesSync(c, t, t);
    const r = await glob({ pattern: "*.ts" }, makeSession(dir));
    assertKind(r, "paths");
    const names = r.paths.map((p) => p.split("/").pop());
    expect(names).toEqual(["aaa.ts", "bbb.ts", "ccc.ts"]);
  });
});

describe("glob — zero-match hint", () => {
  it("echoes pattern and suggests **/' when recursive marker is absent", async () => {
    const dir = makeTempDir();
    write(dir, "nested/a.ts", "x");
    const r = await glob({ pattern: "*.xyz" }, makeSession(dir));
    assertKind(r, "paths");
    expect(r.paths).toEqual([]);
    expect(r.output).toMatch(/No files matched '\*\.xyz'/);
    expect(r.output).toMatch(/add '\*\*\/'/);
    expect(r.output).toContain("broaden the pattern");
  });

  it("omits '**/' suggestion when pattern already contains **", async () => {
    const dir = makeTempDir();
    const r = await glob({ pattern: "**/*.xyz" }, makeSession(dir));
    assertKind(r, "paths");
    expect(r.output).toMatch(/No files matched/);
    expect(r.output).not.toMatch(/add '\*\*\/'/);
  });

  it("mentions path escape hatch when path is explicit", async () => {
    const dir = makeTempDir();
    write(dir, "sub/a.ts", "x");
    const r = await glob(
      { pattern: "*.xyz", path: `${dir}/sub` },
      makeSession(dir),
    );
    assertKind(r, "paths");
    expect(r.output).toMatch(/omit 'path'/);
  });
});

describe("glob — pagination", () => {
  it("paginates with head_limit + offset", async () => {
    const dir = makeTempDir();
    for (let i = 0; i < 10; i++) write(dir, `f${i}.txt`, "x");
    const page1 = await glob(
      { pattern: "*.txt", head_limit: 3, offset: 0 },
      makeSession(dir),
    );
    assertKind(page1, "paths");
    expect(page1.paths).toHaveLength(3);
    expect(page1.meta.total).toBe(10);
    expect(page1.meta.more).toBe(true);
    expect(page1.output).toMatch(/re-call with offset: 3/);

    const page2 = await glob(
      { pattern: "*.txt", head_limit: 3, offset: 3 },
      makeSession(dir),
    );
    assertKind(page2, "paths");
    expect(page2.paths).toHaveLength(3);
    expect(page2.meta.offset).toBe(3);
  });

  it("truncation hint echoes the pattern and leads with narrowing", async () => {
    const dir = makeTempDir();
    for (let i = 0; i < 20; i++) write(dir, `f${i}.txt`, "x");
    const r = await glob(
      { pattern: "*.txt", head_limit: 3 },
      makeSession(dir),
    );
    assertKind(r, "paths");
    expect(r.output).toContain("matching '*.txt'");
    expect(r.output).toMatch(/To narrow: /);
    expect(r.output).toMatch(/re-call with offset:/);
    const narrowIdx = r.output.indexOf("To narrow:");
    const pageIdx = r.output.indexOf("To page through");
    expect(narrowIdx).toBeGreaterThan(-1);
    expect(pageIdx).toBeGreaterThan(narrowIdx);
  });

  it("truncation hint flags 'broader than intended' on very broad patterns", async () => {
    const dir = makeTempDir();
    // head_limit=3 with total=20 => ratio 6.67 → broad
    for (let i = 0; i < 20; i++) write(dir, `f${i}.ts`, "x");
    const r = await glob(
      { pattern: "**/*", head_limit: 3 },
      makeSession(dir),
    );
    assertKind(r, "paths");
    expect(r.output).toContain("likely broader than intended");
  });

  it("truncation hint does NOT flag 'broader' on mild truncation", async () => {
    const dir = makeTempDir();
    // head_limit=15 with total=20 => ratio 1.33 → mild
    for (let i = 0; i < 20; i++) write(dir, `f${i}.ts`, "x");
    const r = await glob(
      { pattern: "**/*.ts", head_limit: 15 },
      makeSession(dir),
    );
    assertKind(r, "paths");
    expect(r.output).not.toContain("broader than intended");
    expect(r.output).toMatch(/To narrow: /);
  });

  it("IO_ERROR echoes the pattern and offers concrete narrowing strategies", async () => {
    const dir = makeTempDir();
    for (let i = 0; i < 30; i++) write(dir, `f${i}.ts`, "x");
    // Session with tiny scan cap forces the IO_ERROR path.
    const r = await glob(
      { pattern: "**/*" },
      makeSession(dir, { maxPathsScanned: 5 }),
    );
    assertKind(r, "error");
    expect(r.error.code).toBe("IO_ERROR");
    expect(r.error.message).toContain("'**/*'");
    expect(r.error.message).toMatch(/Try:/);
    expect(r.error.message).toMatch(/scope with a directory prefix/);
    expect(r.error.message).toMatch(/filter by extension/);
  });

  it("offset >= total returns empty paths with zero-match hint, not an error", async () => {
    const dir = makeTempDir();
    write(dir, "a.ts", "x");
    const r = await glob(
      { pattern: "*.ts", head_limit: 10, offset: 100 },
      makeSession(dir),
    );
    assertKind(r, "paths");
    expect(r.paths).toEqual([]);
    expect(r.output).toMatch(/No files matched/);
  });
});

describe("glob — errors & fence", () => {
  it("NOT_FOUND with fuzzy siblings on typo'd path", async () => {
    const dir = makeTempDir();
    write(dir, "components/a.ts", "x");
    write(dir, "component-utils.ts", "x");
    const r = await glob(
      { pattern: "*.ts", path: `${dir}/componets` },
      makeSession(dir),
    );
    assertKind(r, "error");
    expect(r.error.code).toBe("NOT_FOUND");
    expect(r.error.message).toContain("Did you mean");
    expect(r.error.message).toContain("components");
  });

  it("NOT_FOUND without siblings omits 'Did you mean' block", async () => {
    const dir = makeTempDir();
    const r = await glob(
      { pattern: "*.ts", path: `${dir}/nowhere-like-this-xyz` },
      makeSession(dir),
    );
    assertKind(r, "error");
    expect(r.error.code).toBe("NOT_FOUND");
    expect(r.error.message).not.toContain("Did you mean");
  });

  it("blocks searches outside configured workspace roots", async () => {
    const inside = makeTempDir();
    const outside = makeTempDir();
    write(outside, "a.ts", "x");
    const r = await glob(
      { pattern: "*.ts", path: outside },
      makeSession(inside),
    );
    assertKind(r, "error");
    expect(r.error.code).toBe("OUTSIDE_WORKSPACE");
  });

  it("blocks sensitive paths by default", async () => {
    const dir = makeTempDir();
    write(dir, ".env", "SECRET=1");
    const r = await glob(
      { pattern: "*", path: `${dir}/.env` },
      makeSession(dir),
    );
    assertKind(r, "error");
    expect(r.error.code).toBe("SENSITIVE");
  });

  it("rejects empty pattern via schema", async () => {
    const dir = makeTempDir();
    const r = await glob({ pattern: "" }, makeSession(dir));
    assertKind(r, "error");
    expect(r.error.code).toBe("INVALID_PARAM");
  });

  it("rejects unknown fields via strictObject", async () => {
    const dir = makeTempDir();
    const r = await glob(
      { pattern: "*", bogus: true } as unknown,
      makeSession(dir),
    );
    assertKind(r, "error");
    expect(r.error.code).toBe("INVALID_PARAM");
  });

  it("alias pushback surfaces via glob() call, not just schema", async () => {
    const dir = makeTempDir();
    const r = await glob(
      { regex: "foo" } as unknown,
      makeSession(dir),
    );
    assertKind(r, "error");
    expect(r.error.code).toBe("INVALID_PARAM");
    expect(r.error.message).toMatch(/Glob uses glob syntax, not regex/);
  });
});

describe("glob — ignore rules", () => {
  it("respects .gitignore without requiring a git repo", async () => {
    const dir = makeTempDir();
    write(dir, ".gitignore", "ignored.ts\n");
    write(dir, "ignored.ts", "x");
    write(dir, "kept.ts", "x");
    const r = await glob({ pattern: "*.ts" }, makeSession(dir));
    assertKind(r, "paths");
    const names = r.paths.map((p) => p.split("/").pop());
    expect(names).toContain("kept.ts");
    expect(names).not.toContain("ignored.ts");
  });

  it("respects .gitignore inside a real git repo", async () => {
    const dir = makeTempDir();
    write(dir, ".gitignore", "ignored.ts\n");
    write(dir, "ignored.ts", "x");
    write(dir, "kept.ts", "x");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "a@b"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "a"], { cwd: dir });
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
    const r = await glob({ pattern: "*.ts" }, makeSession(dir));
    assertKind(r, "paths");
    const names = r.paths.map((p) => p.split("/").pop());
    expect(names).toContain("kept.ts");
    expect(names).not.toContain("ignored.ts");
  });

  it("excludes .git directory contents", async () => {
    const dir = makeTempDir();
    write(dir, ".git/HEAD", "ref");
    write(dir, "kept.ts", "x");
    const r = await glob({ pattern: "**/*" }, makeSession(dir));
    assertKind(r, "paths");
    expect(r.paths.some((p) => p.includes("/.git/"))).toBe(false);
  });

  it("excludes hidden files by default", async () => {
    const dir = makeTempDir();
    write(dir, ".secret", "x");
    write(dir, "visible.ts", "x");
    const r = await glob({ pattern: "*" }, makeSession(dir));
    assertKind(r, "paths");
    const names = r.paths.map((p) => p.split("/").pop());
    expect(names).toContain("visible.ts");
    expect(names).not.toContain(".secret");
  });
});

describe("glob — absolute-path pattern auto-split", () => {
  it("recovers when model puts the absolute path inside pattern", async () => {
    const dir = makeTempDir();
    write(dir, "src/Target.tsx", "x");
    write(dir, "other.ts", "x");
    // Model mistake: absolute path embedded in pattern, no path supplied.
    const r = await glob(
      { pattern: `${dir}/**/*.tsx` },
      makeSession(dir),
    );
    assertKind(r, "paths");
    expect(r.paths.map((p) => p.split("/").pop())).toEqual(["Target.tsx"]);
  });

  it("auto-split preserves single-file targeting", async () => {
    const dir = makeTempDir();
    write(dir, "UserService.ts", "x");
    write(dir, "src/Other.ts", "x");
    const r = await glob(
      { pattern: `${dir}/*.ts` },
      makeSession(dir),
    );
    assertKind(r, "paths");
    const names = r.paths.map((p) => p.split("/").pop());
    expect(names).toContain("UserService.ts");
    expect(names).not.toContain("Other.ts");
  });

  it("auto-split deeper: absolute path + trailing recursive pattern", async () => {
    const dir = makeTempDir();
    write(dir, "pkg/deep/match.ts", "x");
    write(dir, "pkg/deep/other.js", "x");
    const r = await glob(
      { pattern: `${dir}/pkg/**/*.ts` },
      makeSession(dir),
    );
    assertKind(r, "paths");
    const names = r.paths.map((p) => p.split("/").pop());
    expect(names).toContain("match.ts");
    expect(names).not.toContain("other.js");
  });

  it("does NOT split when path is explicitly supplied (trust the call)", async () => {
    const dir = makeTempDir();
    write(dir, "sub/a.ts", "x");
    // Model gave both fields but the pattern is still absolute. We trust
    // the explicit path — no silent rewrite — so this pattern is evaluated
    // relative to path and returns zero matches.
    const r = await glob(
      { pattern: `${dir}/**/*.ts`, path: dir },
      makeSession(dir),
    );
    assertKind(r, "paths");
    // Pattern `/tmp/.../**/*.ts` against relative path `sub/a.ts` is
    // mismatched; we expect zero matches (not a silent rewrite).
    expect(r.paths).toEqual([]);
  });

  it("leaves non-absolute patterns untouched", async () => {
    const dir = makeTempDir();
    write(dir, "a.ts", "x");
    write(dir, "b.ts", "x");
    const r = await glob(
      { pattern: "*.ts" },
      makeSession(dir),
    );
    assertKind(r, "paths");
    expect(r.paths).toHaveLength(2);
  });
});

describe("glob — engine injection", () => {
  it("honors a custom engine (shape contract)", async () => {
    const dir = makeTempDir();
    write(dir, "real.ts", "x");
    const fakeEngine: GlobEngine = {
      async *list(_input: GlobEngineInput) {
        yield { path: `${dir}/synthetic.ts` };
      },
    };
    const r = await glob(
      { pattern: "*.ts" },
      makeSession(dir, { engine: fakeEngine }),
    );
    assertKind(r, "paths");
    expect(r.paths).toEqual([`${dir}/synthetic.ts`]);
  });
});
