import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { grep } from "../src/grep.js";
import type { GrepEngine, GrepEngineInput, RgCount, RgMatch } from "../src/types.js";
import { makeSession, makeTempDir, write } from "./helpers.js";

function assertKind<T extends { kind: string }>(
  r: T,
  kind: T["kind"],
): asserts r is Extract<T, { kind: typeof kind }> {
  if (r.kind !== kind) {
    throw new Error(
      `Expected kind=${kind}, got kind=${r.kind} with output:\n${
        "output" in r ? (r as unknown as { output: string }).output : JSON.stringify(r)
      }`,
    );
  }
}

describe("grep — files_with_matches mode (default)", () => {
  it("lists files containing the pattern", async () => {
    const dir = makeTempDir();
    write(dir, "a.ts", "hello world\n");
    write(dir, "b.ts", "nothing here\n");
    write(dir, "c.ts", "hello again\n");

    const r = await grep({ pattern: "hello" }, makeSession(dir));
    assertKind(r, "files_with_matches");
    expect(r.paths.map((p) => p.replace(dir, ""))).toEqual(
      expect.arrayContaining(["/a.ts", "/c.ts"]),
    );
    expect(r.paths.some((p) => p.endsWith("/b.ts"))).toBe(false);
    expect(r.output).toContain("<pattern>hello</pattern>");
    expect(r.output).toContain("Found 2 file(s)");
  });

  it("returns empty result block with actionable hint when no file matches", async () => {
    const dir = makeTempDir();
    write(dir, "a.ts", "nothing\n");
    const r = await grep({ pattern: "absent" }, makeSession(dir));
    assertKind(r, "files_with_matches");
    expect(r.paths).toEqual([]);
    expect(r.output).toMatch(/No files matched\. Try:/);
    expect(r.output).toContain("case_insensitive: true");
    expect(r.output).toContain("broaden the pattern");
  });

  it("zero-match hint flags glob/type removal and omits case_insensitive suggestion if already on", async () => {
    const dir = makeTempDir();
    write(dir, "a.ts", "hello\n");
    const r = await grep(
      {
        pattern: "absent",
        case_insensitive: true,
        glob: "*.zzz",
        type: "ts",
      },
      makeSession(dir),
    );
    assertKind(r, "files_with_matches");
    expect(r.output).toContain("remove glob='*.zzz'");
    expect(r.output).toContain("remove type='ts'");
    expect(r.output).not.toContain("case_insensitive: true");
  });

  it("applies a glob filter", async () => {
    const dir = makeTempDir();
    write(dir, "a.ts", "hit\n");
    write(dir, "b.js", "hit\n");
    const r = await grep(
      { pattern: "hit", glob: "*.ts" },
      makeSession(dir),
    );
    assertKind(r, "files_with_matches");
    expect(r.paths.every((p) => p.endsWith(".ts"))).toBe(true);
  });

  it("applies a type filter", async () => {
    const dir = makeTempDir();
    write(dir, "a.ts", "hit\n");
    write(dir, "b.js", "hit\n");
    const r = await grep(
      { pattern: "hit", type: "js" },
      makeSession(dir),
    );
    assertKind(r, "files_with_matches");
    expect(r.paths.every((p) => p.endsWith(".js"))).toBe(true);
  });

  it("paginates with head_limit + offset + Next offset hint", async () => {
    const dir = makeTempDir();
    for (let i = 0; i < 10; i++) write(dir, `f${i}.txt`, "needle\n");
    const r = await grep(
      { pattern: "needle", head_limit: 3, offset: 0 },
      makeSession(dir),
    );
    assertKind(r, "files_with_matches");
    expect(r.paths).toHaveLength(3);
    expect(r.meta.total).toBe(10);
    expect(r.meta.more).toBe(true);
    expect(r.output).toContain("Next offset: 3");
  });
});

describe("grep — content mode", () => {
  it("returns matching lines indented with line numbers", async () => {
    const dir = makeTempDir();
    write(dir, "a.ts", "alpha\nbeta\nalpha again\n");
    const r = await grep(
      { pattern: "alpha", output_mode: "content" },
      makeSession(dir),
    );
    assertKind(r, "content");
    expect(r.output).toMatch(/ {2}1: alpha/);
    expect(r.output).toMatch(/ {2}3: alpha again/);
    expect(r.meta.totalMatches).toBe(2);
    expect(r.meta.totalFiles).toBe(1);
  });

  it("supports context_before and context_after", async () => {
    const dir = makeTempDir();
    write(dir, "a.ts", "one\ntwo\ntarget\nfour\nfive\n");
    const r = await grep(
      {
        pattern: "target",
        output_mode: "content",
        context_before: 1,
        context_after: 1,
      },
      makeSession(dir),
    );
    assertKind(r, "content");
    expect(r.output).toContain("2: two");
    expect(r.output).toContain("3: target");
    expect(r.output).toContain("4: four");
  });

  it("rejects context with non-content mode", async () => {
    const dir = makeTempDir();
    write(dir, "a.ts", "x\n");
    const r = await grep(
      { pattern: "x", context: 2 },
      makeSession(dir),
    );
    assertKind(r, "error");
    expect(r.error.code).toBe("INVALID_PARAM");
    expect(r.error.message).toMatch(/context.*only valid/);
  });

  it("honors case_insensitive", async () => {
    const dir = makeTempDir();
    write(dir, "a.ts", "HELLO world\n");
    const r = await grep(
      { pattern: "hello", output_mode: "content", case_insensitive: true },
      makeSession(dir),
    );
    assertKind(r, "content");
    expect(r.output).toContain("HELLO world");
  });

  it("supports multiline patterns", async () => {
    const dir = makeTempDir();
    write(dir, "a.ts", "foo\nbar\nbaz\n");
    const r = await grep(
      {
        pattern: "foo[\\s\\S]*?bar",
        output_mode: "content",
        multiline: true,
      },
      makeSession(dir),
    );
    assertKind(r, "content");
    expect(r.meta.totalMatches).toBeGreaterThan(0);
  });
});

describe("grep — count mode", () => {
  it("reports per-file match counts", async () => {
    const dir = makeTempDir();
    write(dir, "a.ts", "x\nx\nx\n");
    write(dir, "b.ts", "x\n");
    const r = await grep(
      { pattern: "x", output_mode: "count" },
      makeSession(dir),
    );
    assertKind(r, "count");
    const map = new Map(r.counts.map((c) => [c.path.replace(dir, ""), c.count]));
    expect(map.get("/a.ts")).toBe(3);
    expect(map.get("/b.ts")).toBe(1);
    expect(r.output).toContain("<counts>");
  });
});

describe("grep — regex + error surfaces", () => {
  it("raises INVALID_REGEX for a malformed pattern", async () => {
    const dir = makeTempDir();
    write(dir, "a.ts", "x\n");
    const r = await grep(
      { pattern: "interface{}" },
      makeSession(dir),
    );
    assertKind(r, "error");
    expect(r.error.code).toBe("INVALID_REGEX");
    expect(r.error.message).toMatch(/escape literal regex|regex parse/i);
  });

  it("returns NOT_FOUND for a missing path", async () => {
    const dir = makeTempDir();
    const r = await grep(
      { pattern: "x", path: `${dir}/does-not-exist` },
      makeSession(dir),
    );
    assertKind(r, "error");
    expect(r.error.code).toBe("NOT_FOUND");
  });

  it("suggests fuzzy siblings when the missing path has near-matches", async () => {
    const dir = makeTempDir();
    write(dir, "server.ts", "x\n");
    write(dir, "client.ts", "x\n");
    write(dir, "util.ts", "x\n");
    const r = await grep(
      { pattern: "x", path: `${dir}/serv.ts` },
      makeSession(dir),
    );
    assertKind(r, "error");
    expect(r.error.code).toBe("NOT_FOUND");
    expect(r.error.message).toContain("Did you mean one of these?");
    expect(r.error.message).toContain("server.ts");
    const suggestions = (r.error.meta as { suggestions?: readonly string[] })
      ?.suggestions;
    expect(suggestions?.length).toBeGreaterThan(0);
    expect(suggestions?.some((s) => s.endsWith("/server.ts"))).toBe(true);
  });

  it("NOT_FOUND without siblings omits the 'Did you mean' block", async () => {
    const dir = makeTempDir();
    const r = await grep(
      { pattern: "x", path: `${dir}/nowhere-like-this.xyz` },
      makeSession(dir),
    );
    assertKind(r, "error");
    expect(r.error.code).toBe("NOT_FOUND");
    expect(r.error.message).not.toContain("Did you mean");
    expect(r.error.message).toContain("Path does not exist");
  });

  it("rejects empty pattern via schema", async () => {
    const dir = makeTempDir();
    const r = await grep({ pattern: "" }, makeSession(dir));
    assertKind(r, "error");
    expect(r.error.code).toBe("INVALID_PARAM");
  });

  it("rejects unknown fields", async () => {
    const dir = makeTempDir();
    const r = await grep(
      { pattern: "x", bogus: true } as unknown,
      makeSession(dir),
    );
    assertKind(r, "error");
    expect(r.error.code).toBe("INVALID_PARAM");
  });
});

describe("grep — ignore rules", () => {
  it("respects .gitignore without requiring a git repo (--no-require-git)", async () => {
    const dir = makeTempDir();
    write(dir, ".gitignore", "ignored.txt\n");
    write(dir, "ignored.txt", "secret\n");
    write(dir, "kept.txt", "secret\n");
    const r = await grep({ pattern: "secret" }, makeSession(dir));
    assertKind(r, "files_with_matches");
    const names = r.paths.map((p) => p.split("/").pop());
    expect(names).toContain("kept.txt");
    expect(names).not.toContain("ignored.txt");
  });

  it("respects .gitignore inside a real git repo", async () => {
    const dir = makeTempDir();
    write(dir, ".gitignore", "ignored.txt\n");
    write(dir, "ignored.txt", "secret\n");
    write(dir, "kept.txt", "secret\n");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "a@b"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "a"], { cwd: dir });
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
    const r = await grep({ pattern: "secret" }, makeSession(dir));
    assertKind(r, "files_with_matches");
    const names = r.paths.map((p) => p.split("/").pop());
    expect(names).toContain("kept.txt");
    expect(names).not.toContain("ignored.txt");
  });

  it("excludes .git directory contents by default", async () => {
    const dir = makeTempDir();
    write(dir, ".git/HEAD", "secret\n");
    write(dir, "kept.txt", "secret\n");
    const r = await grep({ pattern: "secret" }, makeSession(dir));
    assertKind(r, "files_with_matches");
    expect(r.paths.some((p) => p.includes("/.git/"))).toBe(false);
    expect(r.paths.some((p) => p.endsWith("/kept.txt"))).toBe(true);
  });
});

describe("grep — fence / permissions", () => {
  it("blocks searches outside configured workspace roots", async () => {
    const inside = makeTempDir();
    const outside = makeTempDir();
    write(outside, "a.ts", "x\n");
    const r = await grep(
      { pattern: "x", path: outside },
      makeSession(inside),
    );
    assertKind(r, "error");
    expect(r.error.code).toBe("OUTSIDE_WORKSPACE");
  });

  it("blocks sensitive paths by default", async () => {
    const dir = makeTempDir();
    const env = write(dir, ".env", "SECRET=1\n");
    const r = await grep(
      { pattern: "SECRET", path: env },
      makeSession(dir),
    );
    assertKind(r, "error");
    expect(r.error.code).toBe("SENSITIVE");
  });

  it("routes sensitive paths through the permission hook when configured", async () => {
    const dir = makeTempDir();
    write(dir, ".env", "SECRET=42\n");
    let asked = false;
    const r = await grep(
      { pattern: "SECRET", path: `${dir}/.env` },
      makeSession(dir, {
        permissions: {
          roots: [dir],
          sensitivePatterns: ["**/.env"],
          hook: async () => {
            asked = true;
            return "allow_once";
          },
        },
      }),
    );
    assertKind(r, "files_with_matches");
    expect(asked).toBe(true);
    expect(r.paths.length).toBe(1);
  });
});

describe("grep — engine injection", () => {
  it("honors a custom engine (shape contract)", async () => {
    const dir = makeTempDir();
    write(dir, "a.ts", "real content\n");
    const fakeEngine: GrepEngine = {
      async *search(_input: GrepEngineInput): AsyncGenerator<RgMatch> {
        yield {
          path: `${dir}/synthetic.ts`,
          lineNumber: 7,
          text: "synthetic hit",
          isContext: false,
        };
      },
      async *count(_input: GrepEngineInput): AsyncGenerator<RgCount> {
        yield { path: `${dir}/synthetic.ts`, count: 1 };
      },
    };
    const r = await grep(
      { pattern: "real", output_mode: "content" },
      makeSession(dir, { engine: fakeEngine }),
    );
    assertKind(r, "content");
    expect(r.output).toContain("synthetic hit");
    expect(r.meta.totalMatches).toBe(1);
  });
});
