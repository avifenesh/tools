import { describe, expect, it } from "vitest";
import { passAtK } from "../src/index.js";

describe("passAtK", () => {
  it("passes when >=K successes occur", async () => {
    let i = 0;
    const r = await passAtK({
      n: 5,
      k: 3,
      label: "test-pass",
      run: async () => {
        i++;
        return { ok: i >= 3 };
      },
    });
    expect(r.passed).toBe(true);
    expect(r.successes).toBeGreaterThanOrEqual(3);
  });

  it("stops early after hitting K successes", async () => {
    let i = 0;
    const r = await passAtK({
      n: 5,
      k: 2,
      label: "early",
      run: async () => {
        i++;
        return { ok: true };
      },
    });
    expect(r.attempts).toBe(2);
    expect(r.successes).toBe(2);
  });

  it("fails when successes never reach K (no early stop)", async () => {
    const r = await passAtK({
      n: 4,
      k: 3,
      label: "fail",
      stopEarly: false,
      run: async () => ({ ok: false }),
    });
    expect(r.passed).toBe(false);
    expect(r.failures).toBe(4);
    expect(r.attempts).toBe(4);
  });

  it("stops early when remaining attempts can't reach K", async () => {
    // n=4, k=3. If first two fail, even 2 more wins only gets us to 2 < 3.
    let i = 0;
    const r = await passAtK({
      n: 4,
      k: 3,
      label: "unreachable",
      run: async () => {
        i++;
        return { ok: false };
      },
    });
    expect(r.passed).toBe(false);
    expect(r.attempts).toBeLessThanOrEqual(2);
  });

  it("captures details per attempt", async () => {
    const r = await passAtK({
      n: 2,
      k: 2,
      label: "detail",
      run: async (n) => ({ ok: true, detail: { attemptNo: n } }),
    });
    expect(r.details).toHaveLength(2);
    expect(r.details[0]?.detail).toEqual({ attemptNo: 1 });
  });
});
