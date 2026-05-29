export { websearch, makeSessionId, newSessionId } from "./websearch.js";
export {
  websearchToolDefinition,
  WEBSEARCH_TOOL_NAME,
  WEBSEARCH_TOOL_DESCRIPTION,
  WebSearchParamsSchema,
  safeParseWebSearchParams,
} from "./schema.js";
export { createDefaultEngine, SearchError } from "./engine.js";
export { classifyHost, classifyIp, resolveHost } from "./ssrf.js";
export {
  formatOkText,
  formatEmptyText,
  renderSearchBlock,
} from "./format.js";
export {
  // DEFAULT_TIMEOUT_MS is intentionally NOT re-exported — it collides
  // with the same-name constant in the sibling harness packages. All
  // packages use their own scoped default; callers that need the
  // websearch-scoped value should import directly from the sub-module.
  MIN_TIMEOUT_MS,
  SESSION_BACKSTOP_MS,
  DEFAULT_COUNT,
  MIN_COUNT,
  MAX_COUNT,
  DEFAULT_TIME_RANGE,
  DEFAULT_LANGUAGE,
  DEFAULT_SAFE_SEARCH,
  DEFAULT_CATEGORIES,
  MAX_QUERY_LENGTH,
  SNIPPET_CAP,
  DEFAULT_USER_AGENT,
} from "./constants.js";
export type {
  WebSearchParams,
  WebSearchTimeRange,
  WebSearchSafeSearch,
  WebSearchSessionConfig,
  WebSearchEngine,
  WebSearchEngineInput,
  WebSearchEngineResult,
  WebSearchResultItem,
  WebSearchPermissionPolicy,
  WebSearchResult,
  WebSearchOk,
  WebSearchEmpty,
  WebSearchErrorResult,
  SearchMetadata,
} from "./types.js";
