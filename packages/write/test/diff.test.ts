import { describe, expect, it } from "vitest";
import { unifiedDiff } from "../src/diff.js";

describe("diff — unifiedDiff", () => {
  it("produces a unified diff header", () => {
    const d = unifiedDiff({
      oldPath: "/a.txt",
      newPath: "/a.txt",
      oldContent: "a\nb\nc\n",
      newContent: "a\nB\nc\n",
    });
    expect(d).toContain("--- a//a.txt");
    expect(d).toContain("+++ b//a.txt");
    expect(d).toContain("-b");
    expect(d).toContain("+B");
  });

  it("handles pure additions", () => {
    const d = unifiedDiff({
      oldPath: "/a",
      newPath: "/a",
      oldContent: "",
      newContent: "line\n",
    });
    expect(d).toContain("+line");
  });

  it("handles pure deletions", () => {
    const d = unifiedDiff({
      oldPath: "/a",
      newPath: "/a",
      oldContent: "line\n",
      newContent: "",
    });
    expect(d).toContain("-line");
  });
});
