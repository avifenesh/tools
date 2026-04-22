export { webfetch, makeSessionCache, newSessionId } from "./webfetch.js";
export {
  webfetchToolDefinition,
  WEBFETCH_TOOL_NAME,
  WEBFETCH_TOOL_DESCRIPTION,
  WebFetchParamsSchema,
  safeParseWebFetchParams,
} from "./schema.js";
export { createDefaultEngine, FetchError } from "./engine.js";
export {
  extractMarkdown,
  isHtmlLike,
  parseContentTypeBase,
} from "./extractor.js";
export { classifyHost, classifyIp, resolveHost } from "./ssrf.js";
export {
  formatOkText,
  formatRedirectLoopText,
  formatHttpErrorText,
  renderRequestBlock,
  spillToFile,
  headAndTail,
  hostOf,
} from "./format.js";
export {
  // DEFAULT_TIMEOUT_MS is intentionally NOT re-exported — it collides
  // with the same-name constant in @agent-sh/harness-grep / -bash. All
  // packages use the same 30 s default so the value doesn't matter;
  // callers that need the webfetch-scoped value should import directly
  // from the sub-module. Same treatment as @agent-sh/harness-glob.
  MIN_TIMEOUT_MS,
  SESSION_BACKSTOP_MS,
  DEFAULT_MAX_REDIRECTS,
  MAX_MAX_REDIRECTS,
  INLINE_MARKDOWN_CAP,
  INLINE_RAW_CAP,
  SPILL_HARD_CAP,
  SPILL_HEAD_BYTES,
  SPILL_TAIL_BYTES,
  CACHE_TTL_MS,
  MAX_URL_LENGTH,
  TEXT_PASSTHROUGH_TYPES,
  DEFAULT_USER_AGENT,
} from "./constants.js";
export type {
  WebFetchParams,
  WebFetchMethod,
  WebFetchExtract,
  WebFetchSessionConfig,
  WebFetchEngine,
  WebFetchEngineInput,
  WebFetchEngineResult,
  WebFetchPermissionPolicy,
  WebFetchResult,
  WebFetchOk,
  WebFetchRedirectLoop,
  WebFetchHttpError,
  WebFetchErrorResult,
  FetchMetadata,
  CachedResponse,
} from "./types.js";
