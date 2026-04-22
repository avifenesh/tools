import { describe, expect, it } from "vitest";
import { lsp } from "../src/lsp.js";
import { StubLspClient } from "../src/stubClient.js";
import type { LspLocation, LspResult, LspSymbolInfo } from "../src/types.js";
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

describe("lsp — hover", () => {
  it("returns hover markdown", async () => {
    const dir = makeTempDir();
    const filePath = write(dir, "a.ts", "export const x = 1;\n");
    const client = new StubLspClient({
      responses: {
        typescript: {
          hover: async () => ({
            contents: "`const x: number`",
            isMarkdown: true,
          }),
        },
      },
    });
    const r = await lsp(
      {
        operation: "hover",
        path: filePath,
        line: 1,
        character: 14,
      },
      makeSession(dir, client),
    );
    assertKind(r, "hover");
    expect(r.contents).toContain("const x: number");
    expect(r.output).toContain("<operation>hover</operation>");
  });

  it("returns no_results when hover is empty", async () => {
    const dir = makeTempDir();
    const filePath = write(dir, "a.ts", "\n");
    const client = new StubLspClient({
      responses: {
        typescript: { hover: async () => null },
      },
    });
    const r = await lsp(
      { operation: "hover", path: filePath, line: 1, character: 1 },
      makeSession(dir, client),
    );
    assertKind(r, "no_results");
    expect(r.output).toMatch(/whitespace or inside a comment/);
  });
});

describe("lsp — definition / references / implementation", () => {
  it("returns sorted locations with preview for definition", async () => {
    const dir = makeTempDir();
    const src = write(dir, "a.ts", "export const x = 1;\n");
    const target = write(dir, "b.ts", "// here\nexport const x = 1;\n");
    const client = new StubLspClient({
      responses: {
        typescript: {
          definition: async () => [
            {
              path: target,
              line: 2,
              character: 14,
              preview: "export const x = 1;",
            },
          ],
        },
      },
    });
    const r = await lsp(
      { operation: "definition", path: src, line: 1, character: 14 },
      makeSession(dir, client),
    );
    assertKind(r, "definition");
    expect(r.locations).toHaveLength(1);
    expect(r.output).toContain(`${target}:2:14`);
  });

  it("caps references at head_limit with truncated hint", async () => {
    const dir = makeTempDir();
    const src = write(dir, "a.ts", "x\n");
    const refs: LspLocation[] = Array.from({ length: 250 }, (_, i) => ({
      path: `${dir}/r${i}.ts`,
      line: i + 1,
      character: 1,
      preview: `ref ${i}`,
    }));
    const client = new StubLspClient({
      responses: {
        typescript: { references: async () => refs },
      },
    });
    const r = await lsp(
      { operation: "references", path: src, line: 1, character: 1 },
      makeSession(dir, client, { defaultHeadLimit: 200 }),
    );
    assertKind(r, "references");
    expect(r.total).toBe(250);
    expect(r.truncated).toBe(true);
    expect(r.locations).toHaveLength(200);
    expect(r.output).toMatch(/Showing 200 of 250 references/);
  });

  it("returns no_results when definition is empty", async () => {
    const dir = makeTempDir();
    const src = write(dir, "a.ts", "x\n");
    const client = new StubLspClient({
      responses: {
        typescript: { definition: async () => [] },
      },
    });
    const r = await lsp(
      { operation: "definition", path: src, line: 1, character: 1 },
      makeSession(dir, client),
    );
    assertKind(r, "no_results");
    expect(r.output).toMatch(/primitive type/);
  });

  it("implementation routes through client.implementation", async () => {
    const dir = makeTempDir();
    const src = write(dir, "a.ts", "x\n");
    let implCalled = false;
    const client = new StubLspClient({
      responses: {
        typescript: {
          implementation: async () => {
            implCalled = true;
            return [{ path: src, line: 1, character: 1, preview: "x" }];
          },
        },
      },
    });
    const r = await lsp(
      { operation: "implementation", path: src, line: 1, character: 1 },
      makeSession(dir, client),
    );
    assertKind(r, "implementation");
    expect(implCalled).toBe(true);
  });
});

describe("lsp — documentSymbol / workspaceSymbol", () => {
  it("renders nested documentSymbol tree with indentation", async () => {
    const dir = makeTempDir();
    const src = write(dir, "a.ts", "x\n");
    const symbols: LspSymbolInfo[] = [
      {
        name: "UserService",
        kind: "class",
        path: src,
        line: 1,
        character: 1,
        children: [
          { name: "constructor", kind: "constructor", path: src, line: 2, character: 3 },
          { name: "greet", kind: "method", path: src, line: 5, character: 3 },
        ],
      },
    ];
    const client = new StubLspClient({
      responses: {
        typescript: { documentSymbol: async () => symbols },
      },
    });
    const r = await lsp(
      { operation: "documentSymbol", path: src },
      makeSession(dir, client),
    );
    assertKind(r, "documentSymbol");
    expect(r.output).toContain("class UserService");
    expect(r.output).toContain("  2: constructor constructor");
    expect(r.output).toContain("  5: method greet");
  });

  it("workspaceSymbol caps at head_limit", async () => {
    const dir = makeTempDir();
    const syms: LspSymbolInfo[] = Array.from({ length: 20 }, (_, i) => ({
      name: `Sym${i}`,
      kind: "class",
      path: `${dir}/f${i}.ts`,
      line: 1,
      character: 1,
    }));
    const client = new StubLspClient({
      responses: {
        typescript: { workspaceSymbol: async () => syms },
      },
    });
    const r = await lsp(
      { operation: "workspaceSymbol", query: "Sym", head_limit: 5 },
      makeSession(dir, client),
    );
    assertKind(r, "workspaceSymbol");
    expect(r.total).toBe(20);
    expect(r.truncated).toBe(true);
    expect(r.symbols).toHaveLength(5);
  });
});

describe("lsp — server lifecycle states", () => {
  it("returns server_starting while the server is still indexing", async () => {
    const dir = makeTempDir();
    const src = write(dir, "a.ts", "x\n");
    const client = new StubLspClient({ startingCalls: 2 });
    const r = await lsp(
      { operation: "hover", path: src, line: 1, character: 1 },
      makeSession(dir, client),
    );
    assertKind(r, "server_starting");
    expect(r.output).toMatch(/still indexing/);
    expect(r.retryMs).toBeGreaterThanOrEqual(3000);
  });

  it("retry_ms grows across repeated server_starting for same language", async () => {
    const dir = makeTempDir();
    const src = write(dir, "a.ts", "x\n");
    const client = new StubLspClient({ startingCalls: 10 });
    const retryCounter = new Map<string, number>();
    const session = makeSession(dir, client, { retryCounter });
    const r1 = (await lsp(
      { operation: "hover", path: src, line: 1, character: 1 },
      session,
    )) as LspResult;
    const r2 = (await lsp(
      { operation: "hover", path: src, line: 1, character: 1 },
      session,
    )) as LspResult;
    assertKind(r1, "server_starting");
    assertKind(r2, "server_starting");
    expect(r2.retryMs).toBeGreaterThan(r1.retryMs);
  });
});

describe("lsp — fence + permission", () => {
  it("refuses without hook and no unsafe flag", async () => {
    const dir = makeTempDir();
    const src = write(dir, "a.ts", "x\n");
    const client = new StubLspClient();
    const session = makeSession(dir, client, {
      permissions: {
        roots: [dir],
        sensitivePatterns: [],
      },
    });
    const r = await lsp(
      { operation: "hover", path: src, line: 1, character: 1 },
      session,
    );
    assertKind(r, "error");
    expect(r.error.code).toBe("PERMISSION_DENIED");
  });

  it("rejects path outside workspace", async () => {
    const inside = makeTempDir();
    const outside = makeTempDir();
    const src = write(outside, "a.ts", "x\n");
    const client = new StubLspClient();
    const r = await lsp(
      { operation: "hover", path: src, line: 1, character: 1 },
      makeSession(inside, client),
    );
    assertKind(r, "error");
    expect(r.error.code).toBe("OUTSIDE_WORKSPACE");
  });

  it("NOT_FOUND for missing path", async () => {
    const dir = makeTempDir();
    const client = new StubLspClient();
    const r = await lsp(
      { operation: "hover", path: `${dir}/nope.ts`, line: 1, character: 1 },
      makeSession(dir, client),
    );
    assertKind(r, "error");
    expect(r.error.code).toBe("NOT_FOUND");
  });

  it("SERVER_NOT_AVAILABLE for unknown extension", async () => {
    const dir = makeTempDir();
    const src = write(dir, "a.rs", "fn main() {}\n");
    const client = new StubLspClient();
    const r = await lsp(
      { operation: "hover", path: src, line: 1, character: 1 },
      makeSession(dir, client),
    );
    assertKind(r, "error");
    expect(r.error.code).toBe("SERVER_NOT_AVAILABLE");
    expect(r.error.message).toContain(".rs");
  });
});

describe("lsp — hover markdown cap", () => {
  it("truncates overly large hover markdown", async () => {
    const dir = makeTempDir();
    const src = write(dir, "a.ts", "x\n");
    const huge = "a".repeat(20_000);
    const client = new StubLspClient({
      responses: {
        typescript: {
          hover: async () => ({ contents: huge, isMarkdown: true }),
        },
      },
    });
    const r = await lsp(
      { operation: "hover", path: src, line: 1, character: 1 },
      makeSession(dir, client, { maxHoverMarkdownBytes: 1024 }),
    );
    assertKind(r, "hover");
    expect(r.contents.length).toBeLessThan(huge.length);
    expect(r.contents).toMatch(/hover truncated/);
  });
});

describe("lsp — engine error propagation", () => {
  it("translates server crash (thrown error) into IO_ERROR", async () => {
    const dir = makeTempDir();
    const src = write(dir, "a.ts", "x\n");
    const client = new StubLspClient({
      throwOn: [{ op: "definition", error: new Error("rpc failed") }],
    });
    const r = await lsp(
      { operation: "definition", path: src, line: 1, character: 1 },
      makeSession(dir, client),
    );
    assertKind(r, "error");
    expect(r.error.code).toBe("IO_ERROR");
  });

  it("translates position-out-of-range errors to POSITION_INVALID", async () => {
    const dir = makeTempDir();
    const src = write(dir, "a.ts", "x\n");
    const client = new StubLspClient({
      throwOn: [
        {
          op: "hover",
          error: new Error("Position invalid: line out of range"),
        },
      ],
    });
    const r = await lsp(
      { operation: "hover", path: src, line: 99, character: 1 },
      makeSession(dir, client),
    );
    assertKind(r, "error");
    expect(r.error.code).toBe("POSITION_INVALID");
  });
});
