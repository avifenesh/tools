import { toolError, type ToolError } from "@agent-sh/harness-core";
import type {
  WebSearchSafeSearch,
  WebSearchSessionConfig,
  WebSearchTimeRange,
} from "./types.js";

/**
 * Permission hook call for websearch. Mirrors the shape used by webfetch /
 * read / grep / bash but with WebSearch-specific metadata. Permission is
 * keyed on the backend, not the query (you trust a backend, not individual
 * searches). Returns a decision string; "ask" is treated as "deny" in
 * autonomous mode.
 */
export async function askPermission(
  session: WebSearchSessionConfig,
  args: {
    query: string;
    backendUrl: string;
    backendHost: string;
    count: number;
    timeRange: WebSearchTimeRange;
    safeSearch: WebSearchSafeSearch;
    categories: readonly string[];
  },
): Promise<
  | { decision: "allow" | "allow_once" }
  | { decision: "deny"; reason: string }
> {
  const { permissions } = session;
  const pattern = `WebSearch(backend:${args.backendHost})`;

  if (permissions.hook === undefined) {
    if (permissions.unsafeAllowSearchWithoutHook === true) {
      return { decision: "allow" };
    }
    return {
      decision: "deny",
      reason:
        "websearch tool has no permission hook configured; refusing to query the search backend. Wire a hook or set session.permissions.unsafeAllowSearchWithoutHook for test fixtures.",
    };
  }

  // A search query is low-sensitivity and audit-useful, so it's logged —
  // unless the session opts to log only its length.
  const queryField = session.redactQueryInHook === true
    ? { query_length: args.query.length }
    : { query: args.query };

  const decision = await permissions.hook({
    tool: "websearch",
    path: args.backendUrl,
    action: "read",
    always_patterns: [pattern],
    metadata: {
      ...queryField,
      count: args.count,
      time_range: args.timeRange,
      safe_search: args.safeSearch,
      categories: args.categories,
      backend_host: args.backendHost,
    },
  });
  if (decision === "deny") {
    return {
      decision: "deny",
      reason: `Search blocked by permission policy. Pattern hint: ${pattern}`,
    };
  }
  if (decision === "allow" || decision === "allow_once") {
    return { decision };
  }
  return {
    decision: "deny",
    reason:
      "Permission hook returned 'ask' but websearch runs in autonomous mode. Configure the hook to return allow or deny.",
  };
}

export function permissionDeniedError(
  query: string,
  reason: string,
): ToolError {
  const echoQuery = query.length > 300 ? query.slice(0, 300) + "..." : query;
  return toolError(
    "PERMISSION_DENIED",
    `${reason}\nQuery: "${echoQuery}"`,
    { meta: { query } },
  );
}
