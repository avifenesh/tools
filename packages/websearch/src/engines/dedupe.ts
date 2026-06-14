/**
 * URL normalization for cross-engine result de-duplication. When the fallback
 * chain merges results from several backends, the same page often appears in
 * more than one (e.g. Mojeek and Marginalia both surface tokio.rs). We key
 * dedup on a normalized form so those collapse to one entry — but we always
 * keep the ORIGINAL url in the output (normalization is for the key only).
 *
 * Normalization (key only): lowercase scheme+host, drop a leading "www.",
 * drop the default port, strip the fragment, strip common tracking query
 * params (utm_*, gclid, fbclid, ref, …), sort the remaining params, and trim a
 * trailing slash. Conservative: meaningful params (?id=, ?curid=, ?q=) are
 * kept, so distinct pages don't wrongly collapse.
 */

const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "gclid",
  "fbclid",
  "mc_cid",
  "mc_eid",
  "ref",
  "ref_src",
  "ref_url",
  "spm",
  "igshid",
]);

export function normalizeUrlForDedup(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    // Not a parseable absolute URL — fall back to a trimmed, lowercased key.
    return raw.trim().toLowerCase();
  }

  const scheme = u.protocol.toLowerCase(); // includes trailing ":"
  let host = u.hostname.toLowerCase();
  if (host.startsWith("www.")) host = host.slice(4);

  // Drop default ports.
  let port = u.port;
  if (
    (scheme === "http:" && port === "80") ||
    (scheme === "https:" && port === "443")
  ) {
    port = "";
  }

  // Strip tracking params, keep the rest, sort for stable comparison.
  const params: [string, string][] = [];
  for (const [k, v] of u.searchParams) {
    if (TRACKING_PARAMS.has(k.toLowerCase())) continue;
    params.push([k, v]);
  }
  params.sort((a, b) => (a[0] === b[0] ? cmp(a[1], b[1]) : cmp(a[0], b[0])));
  const query = params.map(([k, v]) => `${k}=${v}`).join("&");

  // Trim a trailing slash on the path (but keep root "/" as empty).
  let path = u.pathname;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  if (path === "/") path = "";

  const portPart = port.length > 0 ? `:${port}` : "";
  const queryPart = query.length > 0 ? `?${query}` : "";
  return `${scheme}//${host}${portPart}${path}${queryPart}`;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
