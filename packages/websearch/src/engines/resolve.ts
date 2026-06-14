import type {
  NamedWebSearchEngine,
  WebSearchEngine,
  WebSearchSessionConfig,
} from "../types.js";
import { createBraveEngine } from "./brave.js";
import { createFallbackEngine } from "./fallback.js";
import { createMarginaliaEngine } from "./marginalia.js";
import { createMojeekEngine } from "./mojeek.js";
import { createSearxngEngine } from "./searxng.js";
import { createTavilyEngine } from "./tavily.js";
import { createWikipediaEngine } from "./wikipedia.js";

export interface ResolvedEngine {
  readonly engine: WebSearchEngine;
  /** Engine names in priority order, for diagnostics / error hints. */
  readonly chain: readonly string[];
  /** True when no key and no searxngUrl — the bare keyless default. */
  readonly keylessDefault: boolean;
}

/**
 * Build the engine to run for this session, mirroring `ddgs backend="auto"`:
 * an ordered chain, best-first, first non-empty wins.
 *
 * Two regimes:
 * - **Explicit backend** (any of Brave / Tavily / SearXNG configured): use
 *   those, in that priority order, EXCLUSIVELY by default. A self-hosted
 *   SearXNG hiccup must not silently leak the query to public scrape engines.
 *   Set `fallbackToKeyless: true` to append the keyless chain as a backstop.
 * - **Zero-config**: nobody set a key or a SearXNG URL → use the bundled
 *   keyless chain (Mojeek → Marginalia → Wikipedia) so search **just works**.
 *
 * Keyless chain order: Mojeek (full-web scrape; opt-out via disableMojeek) →
 * Marginalia (niche JSON API) → Wikipedia (encyclopedic backstop, ~never
 * fails).
 */
export function resolveEngine(session: WebSearchSessionConfig): ResolvedEngine {
  if (session.engine !== undefined) {
    return {
      engine: session.engine,
      chain: ["custom"],
      keylessDefault: false,
    };
  }

  const baseUrls = session.engineBaseUrls ?? {};

  const hasBrave =
    session.braveApiKey !== undefined && session.braveApiKey.length > 0;
  const hasTavily =
    session.tavilyApiKey !== undefined && session.tavilyApiKey.length > 0;
  const hasSearxng =
    session.searxngUrl !== undefined && session.searxngUrl.length > 0;
  const hasExplicit = hasBrave || hasTavily || hasSearxng;

  const explicit: NamedWebSearchEngine[] = [];
  if (hasBrave && session.braveApiKey !== undefined) {
    explicit.push(
      createBraveEngine(
        session.braveApiKey,
        baseUrls.brave !== undefined ? { baseUrl: baseUrls.brave } : {},
      ),
    );
  }
  if (hasTavily && session.tavilyApiKey !== undefined) {
    explicit.push(
      createTavilyEngine(
        session.tavilyApiKey,
        baseUrls.tavily !== undefined ? { baseUrl: baseUrls.tavily } : {},
      ),
    );
  }
  if (hasSearxng && session.searxngUrl !== undefined) {
    explicit.push(createSearxngEngine(session.searxngUrl));
  }

  const keyless = buildKeylessChain(session, baseUrls);

  let engines: NamedWebSearchEngine[];
  if (hasExplicit) {
    engines =
      session.fallbackToKeyless === true ? [...explicit, ...keyless] : explicit;
  } else {
    engines = keyless;
  }

  return {
    engine:
      engines.length === 1 && engines[0] !== undefined
        ? engines[0]
        : createFallbackEngine(engines),
    chain: engines.map((e) => e.name),
    keylessDefault: !hasExplicit,
  };
}

function buildKeylessChain(
  session: WebSearchSessionConfig,
  baseUrls: NonNullable<WebSearchSessionConfig["engineBaseUrls"]>,
): NamedWebSearchEngine[] {
  const chain: NamedWebSearchEngine[] = [];
  if (session.disableMojeek !== true) {
    chain.push(
      createMojeekEngine(
        baseUrls.mojeek !== undefined ? { baseUrl: baseUrls.mojeek } : {},
      ),
    );
  }
  chain.push(
    createMarginaliaEngine(
      baseUrls.marginalia !== undefined
        ? { baseUrl: baseUrls.marginalia }
        : {},
    ),
  );
  chain.push(
    createWikipediaEngine(
      baseUrls.wikipedia !== undefined ? { baseUrl: baseUrls.wikipedia } : {},
    ),
  );
  return chain;
}
