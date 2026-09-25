import type {
  EngineClass,
  NamedWebSearchEngine,
  WebSearchEngine,
  WebSearchSessionConfig,
} from "../types.js";
import { createBraveEngine } from "./brave.js";
import { createExaEngine } from "./exa.js";
import { createFallbackEngine } from "./fallback.js";
import { createMarginaliaEngine } from "./marginalia.js";
import { createMojeekEngine } from "./mojeek.js";
import { createParallelEngine } from "./parallel.js";
import { createSearxngEngine } from "./searxng.js";
import { createTavilyEngine } from "./tavily.js";
import { createWikipediaEngine } from "./wikipedia.js";

export interface ResolvedEngine {
  readonly engine: WebSearchEngine;
  /** Engine names in priority order, for diagnostics / error hints. */
  readonly chain: readonly string[];
  /** True when no key and no searxngUrl — the bare keyless default. */
  readonly keylessDefault: boolean;
  /**
   * When exactly one engine was resolved (no fallback wrapper), its coverage
   * class — so the orchestrator can label results even though a lone engine
   * doesn't carry engineClass in its result. Undefined for a fallback chain
   * (the FallbackEngine sets engineClass on the result it returns).
   */
  readonly soleEngineClass?: EngineClass;
}

/** Every name `engineOrder` accepts, in the default best-first order. */
export const ENGINE_NAMES: readonly string[] = [
  "brave",
  "tavily",
  "searxng",
  "exa",
  "parallel",
  "mojeek",
  "marginalia",
  "wikipedia",
];

function nonEmpty(v: string | undefined): v is string {
  return v !== undefined && v.length > 0;
}

/**
 * Validate `session.engineOrder`. Returns a model- and operator-readable
 * message for the first problem (an empty list, an unknown or repeated name,
 * or an engine whose key / URL the session does not carry), else undefined.
 */
export function validateEngineOrder(
  session: WebSearchSessionConfig,
): string | undefined {
  const order = session.engineOrder;
  if (order === undefined) return undefined;
  if (order.length === 0) {
    return "session.engineOrder is empty; list at least one engine or leave it unset";
  }
  const seen = new Set<string>();
  for (const n of order) {
    if (!ENGINE_NAMES.includes(n)) {
      return `session.engineOrder has unknown engine '${n}'; valid names: ${ENGINE_NAMES.join(", ")}`;
    }
    if (seen.has(n)) return `session.engineOrder lists '${n}' twice`;
    seen.add(n);
    const missing =
      n === "brave" && !nonEmpty(session.braveApiKey)
        ? "session.braveApiKey"
        : n === "tavily" && !nonEmpty(session.tavilyApiKey)
          ? "session.tavilyApiKey"
          : n === "searxng" && !nonEmpty(session.searxngUrl)
            ? "session.searxngUrl"
            : undefined;
    if (missing !== undefined) {
      return `session.engineOrder lists '${n}' but ${missing} is not set`;
    }
  }
  return undefined;
}

/**
 * Build one engine by name. Undefined for a name that is unknown or lacks its
 * key / URL (validateEngineOrder reports those before the resolver runs).
 */
function buildNamed(
  name: string,
  session: WebSearchSessionConfig,
): NamedWebSearchEngine | undefined {
  const b = session.engineBaseUrls ?? {};
  const at = (u: string | undefined): { baseUrl?: string } =>
    u !== undefined ? { baseUrl: u } : {};
  switch (name) {
    case "brave":
      return nonEmpty(session.braveApiKey)
        ? createBraveEngine(session.braveApiKey, at(b.brave))
        : undefined;
    case "tavily":
      return nonEmpty(session.tavilyApiKey)
        ? createTavilyEngine(session.tavilyApiKey, at(b.tavily))
        : undefined;
    case "searxng":
      return nonEmpty(session.searxngUrl)
        ? createSearxngEngine(session.searxngUrl)
        : undefined;
    case "exa":
      return createExaEngine({
        ...at(b.exa),
        ...(session.exaApiKey !== undefined ? { apiKey: session.exaApiKey } : {}),
      });
    case "parallel":
      return createParallelEngine({
        ...at(b.parallel),
        ...(session.parallelApiKey !== undefined
          ? { apiKey: session.parallelApiKey }
          : {}),
      });
    case "mojeek":
      return createMojeekEngine(at(b.mojeek));
    case "marginalia":
      return createMarginaliaEngine(at(b.marginalia));
    case "wikipedia":
      return createWikipediaEngine(at(b.wikipedia));
    default:
      return undefined;
  }
}

function buildAll(
  names: readonly string[],
  session: WebSearchSessionConfig,
): NamedWebSearchEngine[] {
  const out: NamedWebSearchEngine[] = [];
  for (const n of names) {
    const e = buildNamed(n, session);
    if (e !== undefined) out.push(e);
  }
  return out;
}

/**
 * Build the engine to run for this session, mirroring `ddgs backend="auto"`:
 * an ordered chain, best-first, gathered until `count` is met.
 *
 * Three regimes:
 * - **Harness order** (`engineOrder` set): exactly those engines, in that
 *   order. Validated by validateEngineOrder before the resolver runs.
 * - **Explicit backend** (any of Brave / Tavily / SearXNG configured): use
 *   those, in that priority order, EXCLUSIVELY by default. A self-hosted
 *   SearXNG hiccup must not silently leak the query to public engines. Set
 *   `fallbackToKeyless: true` to append the keyless chain as a backstop.
 * - **Zero-config**: nobody set a key or a SearXNG URL → use the bundled
 *   keyless chain so search **just works**.
 *
 * Keyless chain order: Exa (own index, hosted MCP; opt-out via disableExa) →
 * Parallel (own index, hosted MCP; opt-out via disableParallel) → Mojeek
 * (full-web scrape; opt-out via disableMojeek) → Marginalia (niche JSON API)
 * → Wikipedia (encyclopedic backstop, ~never fails).
 */
export function resolveEngine(session: WebSearchSessionConfig): ResolvedEngine {
  if (session.engine !== undefined) {
    return {
      engine: session.engine,
      chain: ["custom"],
      keylessDefault: false,
    };
  }

  if (session.engineOrder !== undefined) {
    const keylessDefault = !session.engineOrder.some(
      (n) => n === "brave" || n === "tavily" || n === "searxng",
    );
    return finish(buildAll(session.engineOrder, session), keylessDefault);
  }

  const explicit = buildAll(["brave", "tavily", "searxng"], session);
  const hasExplicit = explicit.length > 0;
  const keyless = buildAll(keylessNames(session), session);

  let engines: NamedWebSearchEngine[];
  if (hasExplicit) {
    engines =
      session.fallbackToKeyless === true ? [...explicit, ...keyless] : explicit;
  } else {
    engines = keyless;
  }
  return finish(engines, !hasExplicit);
}

function keylessNames(session: WebSearchSessionConfig): string[] {
  const names: string[] = [];
  if (session.disableExa !== true) names.push("exa");
  if (session.disableParallel !== true) names.push("parallel");
  if (session.disableMojeek !== true) names.push("mojeek");
  names.push("marginalia", "wikipedia");
  return names;
}

function finish(
  engines: NamedWebSearchEngine[],
  keylessDefault: boolean,
): ResolvedEngine {
  const sole = engines.length === 1 ? engines[0] : undefined;
  return {
    engine: sole !== undefined ? sole : createFallbackEngine(engines),
    chain: engines.map((e) => e.name),
    keylessDefault,
    ...(sole !== undefined ? { soleEngineClass: sole.engineClass } : {}),
  };
}
