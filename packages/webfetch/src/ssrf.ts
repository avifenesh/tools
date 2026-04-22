import dns from "node:dns/promises";
import net from "node:net";
import type { WebFetchSessionConfig } from "./types.js";

/**
 * IP-range SSRF defense. Runs before each request fires AND after each
 * redirect resolves to a new host. Returns a reason string to reject on,
 * or null to allow.
 *
 * The classifier is intentionally coarse-grained and only whitelists the
 * safe common internet. Anything else is assumed hostile unless the
 * session explicitly opts in.
 */

export type SsrfDecision =
  | { allowed: true }
  | { allowed: false; reason: string; hint: string };

export async function classifyHost(
  host: string,
  session: WebFetchSessionConfig,
): Promise<SsrfDecision> {
  // Resolve, then apply session opt-ins to each resolved IP. Reject if
  // any resolved address falls into a blocked range that wasn't opted
  // into — belt-and-suspenders vs DNS round-robin / split-horizon.
  let addresses: string[];
  try {
    addresses = await resolveHost(host);
  } catch (e) {
    return {
      allowed: false,
      reason: `DNS resolution failed: ${(e as Error).message}`,
      hint: "Check that the hostname is reachable and correct.",
    };
  }
  if (addresses.length === 0) {
    return {
      allowed: false,
      reason: "Hostname did not resolve to any address.",
      hint: "Check DNS or try a different host.",
    };
  }
  for (const addr of addresses) {
    const block = classifyIp(addr);
    if (block === null) continue;
    const opted = isOptedIn(block, session);
    if (!opted) {
      return {
        allowed: false,
        reason: `Host resolved to blocked IP range: ${addr} (${block})`,
        hint: hintFor(block),
      };
    }
  }
  return { allowed: true };
}

export async function resolveHost(host: string): Promise<string[]> {
  // If the host is already an IP literal, return it directly. net.isIP
  // returns 4 or 6 for a valid IP, 0 otherwise.
  if (net.isIP(host) !== 0) return [host];
  const out: string[] = [];
  try {
    const v4 = await dns.resolve4(host);
    out.push(...v4);
  } catch {
    // ignore; might be v6-only
  }
  try {
    const v6 = await dns.resolve6(host);
    out.push(...v6);
  } catch {
    // ignore
  }
  if (out.length === 0) {
    // Last resort: lookup() which consults /etc/hosts and other resolvers.
    const fallback = await dns.lookup(host, { all: true });
    return fallback.map((a) => a.address);
  }
  return out;
}

type BlockClass =
  | "loopback"
  | "private"
  | "link-local"
  | "metadata"
  | "reserved";

export function classifyIp(addr: string): BlockClass | null {
  const family = net.isIP(addr);
  if (family === 4) return classifyV4(addr);
  if (family === 6) return classifyV6(addr);
  return "reserved"; // unparseable — treat as blocked
}

function classifyV4(addr: string): BlockClass | null {
  const parts = addr.split(".").map((n) => Number.parseInt(n, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) {
    return "reserved";
  }
  const a = parts[0] ?? 0;
  const b = parts[1] ?? 0;
  // Loopback 127.0.0.0/8
  if (a === 127) return "loopback";
  // Link-local / metadata 169.254.0.0/16
  if (a === 169 && b === 254) return "metadata";
  // RFC 1918 private
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  // 0.0.0.0/8 "this network"
  if (a === 0) return "reserved";
  // 255.255.255.255 broadcast
  if (addr === "255.255.255.255") return "reserved";
  // 100.64.0.0/10 CGNAT
  if (a === 100 && b >= 64 && b <= 127) return "private";
  return null;
}

function classifyV6(addr: string): BlockClass | null {
  const lower = addr.toLowerCase();
  if (lower === "::1") return "loopback";
  if (lower === "::" || lower === "::0") return "reserved";
  if (lower.startsWith("fe80:") || lower.startsWith("fe80::")) {
    return "link-local";
  }
  // fc00::/7 unique local
  const firstHextet = parseInt(lower.split(":")[0] ?? "0", 16);
  if ((firstHextet & 0xfe00) === 0xfc00) return "private";
  // ::ffff:0:0/96 IPv4-mapped — classify the inner v4
  if (lower.startsWith("::ffff:")) {
    const inner = lower.slice("::ffff:".length);
    if (net.isIP(inner) === 4) return classifyV4(inner);
  }
  return null;
}

function isOptedIn(
  block: BlockClass,
  session: WebFetchSessionConfig,
): boolean {
  switch (block) {
    case "loopback":
      return session.allowLoopback === true;
    case "private":
      return session.allowPrivateNetworks === true;
    case "link-local":
      return (
        session.allowPrivateNetworks === true ||
        session.allowMetadata === true
      );
    case "metadata":
      return session.allowMetadata === true;
    case "reserved":
      return false;
  }
}

function hintFor(block: BlockClass): string {
  switch (block) {
    case "loopback":
      return "Loopback is blocked by default. If you need localhost for a developer workload, the session must set allowLoopback: true.";
    case "private":
      return "Private IP ranges (RFC 1918) are blocked by default. Set session.allowPrivateNetworks: true to enable.";
    case "link-local":
      return "Link-local addresses are blocked by default. Set session.allowPrivateNetworks or session.allowMetadata as appropriate.";
    case "metadata":
      return "Cloud metadata endpoints (169.254.169.254) are blocked by default to prevent credential exfiltration. If this is intentional, set session.allowMetadata: true — but be aware of the security implications.";
    case "reserved":
      return "Reserved / special-purpose IP range (0.0.0.0/8, broadcast, etc.) — not a useful target.";
  }
}
