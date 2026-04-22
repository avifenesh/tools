import { describe, expect, it } from "vitest";
import { safeParseWebFetchParams } from "../src/schema.js";

describe("webfetch schema", () => {
  it("accepts a minimal url", () => {
    const r = safeParseWebFetchParams({ url: "https://example.com" });
    expect(r.ok).toBe(true);
  });

  it("rejects empty url", () => {
    const r = safeParseWebFetchParams({ url: "" });
    expect(r.ok).toBe(false);
  });

  it("rejects missing url", () => {
    const r = safeParseWebFetchParams({});
    expect(r.ok).toBe(false);
  });

  it("accepts all optional fields", () => {
    const r = safeParseWebFetchParams({
      url: "https://example.com",
      method: "POST",
      body: "{}",
      headers: { "Content-Type": "application/json" },
      extract: "markdown",
      timeout_ms: 5000,
      max_redirects: 3,
    });
    expect(r.ok).toBe(true);
  });

  it("rejects unknown method", () => {
    const r = safeParseWebFetchParams({
      url: "https://x.com",
      method: "DELETE",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects timeout_ms < 1000", () => {
    const r = safeParseWebFetchParams({
      url: "https://x.com",
      timeout_ms: 500,
    });
    expect(r.ok).toBe(false);
  });

  it("rejects max_redirects > 10", () => {
    const r = safeParseWebFetchParams({
      url: "https://x.com",
      max_redirects: 20,
    });
    expect(r.ok).toBe(false);
  });

  it("rejects unknown fields via strictObject", () => {
    const r = safeParseWebFetchParams({
      url: "https://x.com",
      bogus: true,
    } as unknown);
    expect(r.ok).toBe(false);
  });

  it("redirects 'uri' alias to 'url'", () => {
    const r = safeParseWebFetchParams({ uri: "https://x.com" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const msg = r.issues.map((i) => i.message).join(" ");
      expect(msg).toMatch(/Use 'url' instead/);
    }
  });

  it("redirects 'timeout' with unit-conversion hint", () => {
    const r = safeParseWebFetchParams({
      url: "https://x.com",
      timeout: 30,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const msg = r.issues.map((i) => i.message).join(" ");
      expect(msg).toMatch(/milliseconds/);
    }
  });

  it("redirects common alias typos", () => {
    const cases: Array<[string, unknown, RegExp]> = [
      ["link", "https://x.com", /Use 'url'/],
      ["URL", "https://x.com", /Use 'url' \(lowercase\)/],
      ["verb", "GET", /Use 'method'/],
      ["http_method", "GET", /Use 'method'/],
      ["data", "payload", /Use 'body'/],
      ["payload", "p", /Use 'body'/],
      ["request_headers", {}, /Use 'headers'/],
      ["format", "markdown", /Use 'extract'/],
      ["output_format", "raw", /Use 'extract'/],
      ["timeout_seconds", 30, /multiply by 1000/],
      ["follow", true, /Use 'max_redirects'/],
      ["follow_redirects", true, /Use 'max_redirects'/],
      ["redirect", true, /Use 'max_redirects'/],
      ["cache", false, /automatic per-session/],
      ["cookie", "x=y", /not supported in v1/],
      ["auth", "bearer", /Pass authentication via 'headers'/],
      ["username", "x", /Basic scheme/],
      ["proxy", "http://p", /session, not per-call/],
    ];
    for (const [key, val, expected] of cases) {
      const r = safeParseWebFetchParams({
        url: "https://x.com",
        [key]: val,
      });
      expect(r.ok, `expected ${key} to be rejected`).toBe(false);
      if (!r.ok) {
        const msg = r.issues.map((i) => i.message).join(" ");
        expect(msg, `hint for ${key}`).toMatch(expected);
      }
    }
  });
});
