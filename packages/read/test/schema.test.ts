import { describe, expect, it } from "vitest";
import { safeParseReadParams } from "../src/schema.js";

describe("ReadParamsSchema", () => {
  it("accepts a minimal input with only path", () => {
    const r = safeParseReadParams({ path: "/tmp/x" });
    expect(r.ok).toBe(true);
  });

  it("accepts offset and limit", () => {
    const r = safeParseReadParams({ path: "/tmp/x", offset: 10, limit: 50 });
    expect(r.ok).toBe(true);
  });

  it("rejects empty path", () => {
    const r = safeParseReadParams({ path: "" });
    expect(r.ok).toBe(false);
  });

  it("rejects offset < 1", () => {
    const r = safeParseReadParams({ path: "/tmp/x", offset: 0 });
    expect(r.ok).toBe(false);
  });

  it("rejects non-integer offset", () => {
    const r = safeParseReadParams({ path: "/tmp/x", offset: 1.5 });
    expect(r.ok).toBe(false);
  });

  it("rejects limit < 1", () => {
    const r = safeParseReadParams({ path: "/tmp/x", limit: 0 });
    expect(r.ok).toBe(false);
  });

  it("rejects missing path", () => {
    const r = safeParseReadParams({});
    expect(r.ok).toBe(false);
  });
});
