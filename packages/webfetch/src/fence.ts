import { toolError, type ToolError } from "@agent-sh/harness-core";
import type {
  WebFetchMethod,
  WebFetchSessionConfig,
} from "./types.js";

/**
 * Permission hook call for webfetch. Mirrors the shape used by read /
 * grep / glob / bash but with WebFetch-specific metadata. Returns a
 * decision string; "ask" is treated as "deny" in autonomous mode.
 */
export async function askPermission(
  session: WebFetchSessionConfig,
  args: {
    method: WebFetchMethod;
    url: string;
    host: string;
    bodyBytes: number;
    headerKeys: readonly string[];
    extract: string;
    timeoutMs: number;
    maxRedirects: number;
  },
): Promise<
  | { decision: "allow" | "allow_once" }
  | { decision: "deny"; reason: string }
> {
  const { permissions } = session;
  const pattern = `WebFetch(domain:${args.host})`;

  if (permissions.hook === undefined) {
    if (permissions.unsafeAllowFetchWithoutHook === true) {
      return { decision: "allow" };
    }
    return {
      decision: "deny",
      reason:
        "webfetch tool has no permission hook configured; refusing to fetch untrusted URLs. Wire a hook or set session.permissions.unsafeAllowFetchWithoutHook for test fixtures.",
    };
  }

  const decision = await permissions.hook({
    tool: "webfetch",
    path: args.url,
    action: "read",
    always_patterns: [pattern],
    metadata: {
      method: args.method,
      url: args.url,
      host: args.host,
      body_bytes: args.bodyBytes,
      headers_sent: args.headerKeys,
      extract: args.extract,
      timeout_ms: args.timeoutMs,
      redirect_limit: args.maxRedirects,
    },
  });
  if (decision === "deny") {
    return {
      decision: "deny",
      reason: `URL blocked by permission policy. Pattern hint: ${pattern}`,
    };
  }
  if (decision === "allow" || decision === "allow_once") {
    return { decision };
  }
  return {
    decision: "deny",
    reason:
      "Permission hook returned 'ask' but webfetch runs in autonomous mode. Configure the hook to return allow or deny.",
  };
}

export function permissionDeniedError(
  url: string,
  reason: string,
): ToolError {
  const echoUrl = url.length > 300 ? url.slice(0, 300) + "..." : url;
  return toolError(
    "PERMISSION_DENIED",
    `${reason}\nURL: ${echoUrl}`,
    { meta: { url } },
  );
}
