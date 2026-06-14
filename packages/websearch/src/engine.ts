/**
 * Back-compat shim. v1 shipped a single SearXNG engine as `createDefaultEngine`
 * and a `SearchError` class from this module. Both now live under `engines/`.
 * The orchestrator no longer calls `createDefaultEngine` (it uses
 * `resolveEngine` to build a fallback chain), but this export is kept so any
 * external caller importing `createDefaultEngine` from the package root keeps
 * working — it returns the SearXNG engine bound to the given backend URL.
 *
 * Note: the v1 signature took the backendUrl per-call via the engine input;
 * the new SearXNG engine is constructed with its URL. This wrapper adapts the
 * old zero-arg shape by reading `input.backendUrl` on each call.
 */
import { createSearxngEngine } from "./engines/searxng.js";
import type {
  WebSearchEngine,
  WebSearchEngineInput,
  WebSearchEngineResult,
} from "./types.js";

export { SearchError } from "./engines/searchError.js";

export function createDefaultEngine(): WebSearchEngine {
  return {
    async search(
      input: WebSearchEngineInput,
    ): Promise<WebSearchEngineResult> {
      return createSearxngEngine(input.backendUrl).search(input);
    },
  };
}
