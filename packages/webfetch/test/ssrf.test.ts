import { describe, expect, it } from "vitest";
import { classifyIp, classifyHost } from "../src/ssrf.js";
import { makeSession } from "./helpers.js";

describe("classifyIp — IP-range classifier", () => {
  it("flags loopback IPv4", () => {
    expect(classifyIp("127.0.0.1")).toBe("loopback");
    expect(classifyIp("127.1.2.3")).toBe("loopback");
  });

  it("flags loopback IPv6", () => {
    expect(classifyIp("::1")).toBe("loopback");
  });

  it("flags RFC 1918 private ranges", () => {
    expect(classifyIp("10.0.0.1")).toBe("private");
    expect(classifyIp("172.16.5.4")).toBe("private");
    expect(classifyIp("172.31.255.254")).toBe("private");
    expect(classifyIp("192.168.0.1")).toBe("private");
  });

  it("does NOT flag 172.15 or 172.32 (outside RFC 1918)", () => {
    expect(classifyIp("172.15.0.1")).toBeNull();
    expect(classifyIp("172.32.0.1")).toBeNull();
  });

  it("flags cloud metadata endpoint", () => {
    expect(classifyIp("169.254.169.254")).toBe("metadata");
  });

  it("flags CGNAT range", () => {
    expect(classifyIp("100.64.0.1")).toBe("private");
    expect(classifyIp("100.127.255.254")).toBe("private");
  });

  it("flags IPv6 link-local", () => {
    expect(classifyIp("fe80::1")).toBe("link-local");
  });

  it("flags IPv6 ULA (fc00::/7)", () => {
    expect(classifyIp("fc00::1")).toBe("private");
    expect(classifyIp("fd12:3456:789a::1")).toBe("private");
  });

  it("allows public IPs", () => {
    expect(classifyIp("8.8.8.8")).toBeNull();
    expect(classifyIp("1.1.1.1")).toBeNull();
    expect(classifyIp("2600:1f18:1::1")).toBeNull();
  });

  it("flags unparseable addresses as reserved", () => {
    expect(classifyIp("not an ip")).toBe("reserved");
  });
});

describe("classifyHost — full defense with session opt-ins", () => {
  it("blocks 127.0.0.1 without allowLoopback", async () => {
    const r = await classifyHost("127.0.0.1", makeSession({ allowLoopback: false }));
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.reason).toMatch(/loopback/);
    }
  });

  it("allows 127.0.0.1 with allowLoopback", async () => {
    const r = await classifyHost(
      "127.0.0.1",
      makeSession({ allowLoopback: true }),
    );
    expect(r.allowed).toBe(true);
  });

  it("blocks 10.x without allowPrivateNetworks", async () => {
    const r = await classifyHost(
      "10.0.0.1",
      makeSession({ allowPrivateNetworks: false }),
    );
    expect(r.allowed).toBe(false);
  });

  it("blocks metadata endpoint unless allowMetadata is set", async () => {
    const r = await classifyHost(
      "169.254.169.254",
      makeSession({ allowMetadata: false }),
    );
    expect(r.allowed).toBe(false);
  });

  it("allows metadata endpoint when allowMetadata is set", async () => {
    const r = await classifyHost(
      "169.254.169.254",
      makeSession({ allowMetadata: true }),
    );
    expect(r.allowed).toBe(true);
  });
});
