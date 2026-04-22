import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_SENSITIVE_PATTERNS } from "@agent-sh/harness-core";
import type { GrepSessionConfig } from "@agent-sh/harness-grep";
import {
  bedrockAvailable,
  expectSequence,
  loadDotEnv,
  makeGrepExecutor,
  makeGrepExecutorRust,
  makeShellExecutor,
  modelLabel,
  ollamaModelAvailable,
  passAtK,
  resolveBackend,
  resolveModel,
  runE2E,
  warmupOllama,
  type AgentTraceEvent,
} from "../src/index.js";

/**
 * Engine-swap for parity testing. When HARNESS_GREP_ENGINE=rust, all
 * `makeGrepExecutor` calls route through the Rust CLI bridge instead of
 * the TS orchestrator. Default (unset) uses TS so the existing
 * `aggregate:grep:update` baseline doesn't shift.
 *
 * The `RustGrepRunner` returned by `makeGrepExecutorRust` also carries a
 * `close()` method. Tests don't reach into it directly; the runner's
 * child process is reaped when Node exits, which is fine for vitest
 * single-process runs.
 */
const ENGINE = (process.env.HARNESS_GREP_ENGINE ?? "ts").toLowerCase();
const pickGrepExecutor: typeof makeGrepExecutor =
  ENGINE === "rust"
    ? ((session) => {
        const r = makeGrepExecutorRust(session);
        return { tool: r.tool, execute: r.execute };
      })
    : makeGrepExecutor;

loadDotEnv();

const BACKEND = resolveBackend();
const MODEL = resolveModel("qwen3.5:27b-q4_K_M");
const LABEL = modelLabel(MODEL);
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

const SYSTEM_PROMPT = [
  "You are a coding agent with a single tool: `grep`, which searches file contents with a ripgrep-compatible regex.",
  "Prefer `grep` over anything else for finding matches in files.",
  "Default output_mode is 'files_with_matches' — use it first to see WHERE matches live before paying for 'content'.",
  "Use 'content' only when you need matching lines (usually with context_before / context_after).",
  "Use 'count' for summary questions like 'how many TODOs are there'.",
  "If the tool returns INVALID_REGEX, re-read the hint and escape literal regex metacharacters (e.g. use 'interface\\\\{\\\\}' to match 'interface{}').",
  "If results are truncated at head_limit, narrow the pattern, add a glob/type filter, or page with the Next offset hint.",
  "When the task is done, answer in a short plain-text sentence.",
].join(" ");

const SYSTEM_PROMPT_WITH_SHELL =
  SYSTEM_PROMPT +
  " A `shell` tool is also available, but you MUST prefer the dedicated `grep` tool for searching file contents. Only use `shell` for tasks grep cannot do.";

function mkRoot(): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), "e2e-grep-hard-")));
}

function writeFile(dir: string, name: string, content: string): string {
  const p = path.join(dir, name);
  const parent = path.dirname(p);
  if (parent !== dir) mkdirSync(parent, { recursive: true });
  writeFileSync(p, content);
  return p;
}

function makeSession(
  root: string,
  overrides: Partial<GrepSessionConfig> = {},
): GrepSessionConfig {
  return {
    cwd: root,
    permissions: {
      roots: [root],
      sensitivePatterns: DEFAULT_SENSITIVE_PATTERNS,
    },
    ...overrides,
  };
}

interface TraceSummary {
  turns: number;
  toolsByName: Record<string, number>;
  toolSeq: string[];
  toolArgs: Array<{ name: string; args: Record<string, unknown> }>;
  finalContent: string;
  events: AgentTraceEvent[];
}

let currentTrace: TraceSummary | null = null;

function collectTrace(): {
  trace: TraceSummary;
  onTrace: (e: AgentTraceEvent) => void;
} {
  const trace: TraceSummary = {
    turns: 0,
    toolsByName: {},
    toolSeq: [],
    toolArgs: [],
    finalContent: "",
    events: [],
  };
  currentTrace = trace;
  const onTrace = (e: AgentTraceEvent) => {
    trace.events.push(e);
    if (e.kind === "tool_call") {
      trace.toolsByName[e.name] = (trace.toolsByName[e.name] ?? 0) + 1;
      trace.toolSeq.push(e.name);
      trace.toolArgs.push({ name: e.name, args: e.args ?? {} });
    }
    if (e.kind === "final") {
      trace.turns = e.turns;
      trace.finalContent = e.content;
    }
  };
  return { trace, onTrace };
}

function runOpts(
  systemPrompt: string,
  userPrompt: string,
  tools: Parameters<typeof runE2E>[0]["tools"],
  maxTurns: number,
  onTrace: (e: AgentTraceEvent) => void,
): Parameters<typeof runE2E>[0] {
  const opts: Parameters<typeof runE2E>[0] = {
    backend: BACKEND,
    model: MODEL,
    tools,
    systemPrompt,
    userPrompt,
    maxTurns,
    onTrace,
  };
  if (BACKEND === "ollama") {
    (opts as { baseUrl: string }).baseUrl = OLLAMA_BASE_URL;
  }
  return opts;
}

function grepCallsIn(trace: TraceSummary): Array<Record<string, unknown>> {
  return trace.toolArgs.filter((c) => c.name === "grep").map((c) => c.args);
}

function someCall(
  trace: TraceSummary,
  predicate: (args: Record<string, unknown>) => boolean,
): boolean {
  return grepCallsIn(trace).some(predicate);
}

const TRACE_DIR = process.env.E2E_TRACE_DIR;

describe(`grep e2e hard [${LABEL}]`, () => {
  let available = false;

  afterEach((ctx) => {
    if (!TRACE_DIR || !currentTrace) {
      currentTrace = null;
      return;
    }
    try {
      mkdirSync(TRACE_DIR, { recursive: true });
      const testName = ctx.task?.name ?? "unknown";
      const safeName = testName.replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 120);
      const file = path.join(
        TRACE_DIR,
        `${LABEL.replace(/[^a-zA-Z0-9]+/g, "_")}__${safeName}.json`,
      );
      writeFileSync(
        file,
        JSON.stringify(
          {
            label: LABEL,
            testName,
            state: ctx.task?.result?.state ?? "unknown",
            trace: currentTrace,
          },
          null,
          2,
        ),
      );
    } catch {
      // best-effort trace dump
    }
    currentTrace = null;
  });

  beforeAll(async () => {
    if (BACKEND === "bedrock") {
      available = await bedrockAvailable(process.env.AWS_REGION);
      if (!available) {
        console.warn(
          `[skip] Bedrock not reachable (region=${process.env.AWS_REGION ?? "us-east-1"}) or AWS_BEARER_TOKEN_BEDROCK missing`,
        );
      }
    } else {
      available = await ollamaModelAvailable(MODEL, OLLAMA_BASE_URL);
      if (!available) {
        console.warn(
          `[skip] Ollama model "${MODEL}" not available at ${OLLAMA_BASE_URL}`,
        );
        return;
      }
      const w = await warmupOllama({ model: MODEL, baseUrl: OLLAMA_BASE_URL });
      console.log(
        `[warmup ${LABEL}] latencyMs=${w.latencyMs} skipped=${w.skipped}${
          w.reason ? ` reason=${w.reason}` : ""
        }`,
      );
    }
  });

  // G1: Golden — find where a symbol is defined.
  it.runIf(() => available)(
    "G1 golden: locates a symbol definition with files_with_matches first",
    async () => {
      const root = mkRoot();
      writeFile(root, "src/server.ts", "export function handleRequest(req) {\n  return null;\n}\n");
      writeFile(root, "src/util.ts", "export function helper() {}\n");
      writeFile(root, "src/client.ts", "handleRequest(req);\n");

      const tools = [pickGrepExecutor(makeSession(root))];
      const { trace, onTrace } = collectTrace();

      const res = await runE2E(
        runOpts(
          SYSTEM_PROMPT,
          `The project is at ${root}. Find the file where the function 'handleRequest' is defined (not just called) and tell me the path.`,
          tools,
          6,
          onTrace,
        ),
      );

      console.log(
        `[G1 ${LABEL}]`,
        JSON.stringify({
          turns: trace.turns,
          tools: trace.toolsByName,
          seq: trace.toolSeq,
          final: res.finalContent.slice(0, 200),
        }),
      );

      expect(trace.toolsByName.grep ?? 0).toBeGreaterThanOrEqual(1);
      expect(res.finalContent).toMatch(/server\.ts/);
      // Spec §13.2 G1 expects the first call to be cheap-mode, not a content
      // dump. If a weak model goes straight to content mode we still may get
      // the right answer but the tool description isn't landing.
      const firstCall = grepCallsIn(trace)[0];
      expect(firstCall).toBeDefined();
      const mode = firstCall?.output_mode;
      expect(
        mode === undefined ||
          mode === "files_with_matches" ||
          mode === "count",
      ).toBe(true);
    },
    300_000,
  );

  // G2: Refine — a too-broad pattern produces truncated results, model narrows.
  it.runIf(() => available)(
    "G2 refine: narrows after a truncated result set",
    async () => {
      const root = mkRoot();
      // 400 files each containing the word "log" — blows past head_limit=250.
      for (let i = 0; i < 400; i++) {
        writeFile(root, `pkg/f${i}.ts`, `export const log${i} = () => null;\n`);
      }
      // One file with a specific, narrow pattern the model should pivot to.
      writeFile(
        root,
        "pkg/authLogger.ts",
        "export function authLogger(evt) { return evt; }\n",
      );

      const tools = [pickGrepExecutor(makeSession(root))];
      const { trace, onTrace } = collectTrace();

      const res = await runE2E(
        runOpts(
          SYSTEM_PROMPT,
          `In ${root}, I need to find the file that defines a function named 'authLogger'. If your first search returns too many results, narrow the pattern.`,
          tools,
          8,
          onTrace,
        ),
      );

      console.log(
        `[G2 ${LABEL}]`,
        JSON.stringify({
          turns: trace.turns,
          tools: trace.toolsByName,
          seq: trace.toolSeq,
          final: res.finalContent.slice(0, 200),
        }),
      );

      expect(trace.toolsByName.grep ?? 0).toBeGreaterThanOrEqual(1);
      expect(res.finalContent).toMatch(/authLogger\.ts/);
    },
    300_000,
  );

  // G3: Escape — regex metacharacters. Model should escape OR recover after INVALID_REGEX.
  // Stochastic across small models, so wrapped in pass@k.
  it.runIf(() => available)(
    "G3 escape: finds 'interface{}' via escaped pattern or post-error recovery",
    async () => {
      const r = await passAtK({
        n: 3,
        k: 2,
        label: "G3",
        run: async () => {
          const root = mkRoot();
          writeFile(
            root,
            "pkg/types.go",
            "package pkg\n\ntype Foo interface{}\ntype Bar interface {\n  Do()\n}\n",
          );
          writeFile(root, "pkg/other.go", "package pkg\n\nfunc nothing() {}\n");

          const tools = [pickGrepExecutor(makeSession(root))];
          const { trace, onTrace } = collectTrace();

          const res = await runE2E(
            runOpts(
              SYSTEM_PROMPT,
              `In ${root}, find every Go empty-interface declaration. That is the literal three-character sequence: 'interface{}'. Tell me which file(s) contain it.`,
              tools,
              8,
              onTrace,
            ),
          );

          const mentionsTypes = /types\.go/.test(res.finalContent);
          const skipsOther = !/other\.go/.test(res.finalContent);
          return {
            ok: mentionsTypes && skipsOther,
            detail: {
              turns: trace.turns,
              seq: trace.toolSeq,
              grepArgs: grepCallsIn(trace).map((a) => ({ pattern: a.pattern })),
              final: res.finalContent.slice(0, 200),
            },
          };
        },
      });
      expect(r.successes).toBeGreaterThanOrEqual(2);
    },
    600_000,
  );

  // G4: Bash-decoy — shell is available but grep is the correct tool.
  it.runIf(() => available)(
    "G4 bash-decoy: prefers grep over shell for content search",
    async () => {
      const root = mkRoot();
      writeFile(root, "src/a.ts", "const TODO_MARK = 'needleX42';\n");
      writeFile(root, "src/b.ts", "const OTHER = 'hay';\n");

      const tools = [
        pickGrepExecutor(makeSession(root)),
        makeShellExecutor({ cwd: root }),
      ];
      const { trace, onTrace } = collectTrace();

      const res = await runE2E(
        runOpts(
          SYSTEM_PROMPT_WITH_SHELL,
          `Search ${root} for the literal token 'needleX42' and tell me which file it is in. Use the best available tool.`,
          tools,
          6,
          onTrace,
        ),
      );

      console.log(
        `[G4 ${LABEL}]`,
        JSON.stringify({
          turns: trace.turns,
          tools: trace.toolsByName,
          seq: trace.toolSeq,
          final: res.finalContent.slice(0, 200),
        }),
      );

      expect(trace.toolsByName.grep ?? 0).toBeGreaterThanOrEqual(1);
      expect(trace.toolsByName.shell ?? 0).toBe(0);
      expect(res.finalContent).toMatch(/a\.ts/);
    },
    300_000,
  );

  // G5: gitignore respect — node_modules has matches but must not appear in output.
  it.runIf(() => available)(
    "G5 gitignore: returns only source hits, not node_modules",
    async () => {
      const root = mkRoot();
      writeFile(root, ".gitignore", "node_modules\n");
      writeFile(root, "src/app.ts", "export const VERSION = '1.2.3';\n");
      writeFile(root, "node_modules/lib/index.js", "exports.VERSION = 'hidden';\n");

      const tools = [pickGrepExecutor(makeSession(root))];
      const { trace, onTrace } = collectTrace();

      const res = await runE2E(
        runOpts(
          SYSTEM_PROMPT,
          `In ${root}, find where 'VERSION' is defined in the project source. Tell me the file path.`,
          tools,
          6,
          onTrace,
        ),
      );

      console.log(
        `[G5 ${LABEL}]`,
        JSON.stringify({
          turns: trace.turns,
          tools: trace.toolsByName,
          final: res.finalContent.slice(0, 200),
        }),
      );

      expect(res.finalContent).toMatch(/app\.ts/);
      expect(res.finalContent).not.toMatch(/node_modules/);
    },
    300_000,
  );

  // G6: Mode selection — summary question should pick a cheap mode.
  // Accept files_with_matches OR count; reject content for a pure "are there any?" question.
  it.runIf(() => available)(
    "G6 mode-selection: cheap mode for 'are there any' style question",
    async () => {
      const root = mkRoot();
      writeFile(root, "src/a.ts", "// TODO: refactor\nconst x = 1;\n");
      writeFile(root, "src/b.ts", "const y = 2; // TODO later\n");
      writeFile(root, "src/c.ts", "const z = 3;\n");

      const tools = [pickGrepExecutor(makeSession(root))];
      const { trace, onTrace } = collectTrace();

      const res = await runE2E(
        runOpts(
          SYSTEM_PROMPT,
          `In ${root}, are there any TODO comments? How many files contain one?`,
          tools,
          6,
          onTrace,
        ),
      );

      console.log(
        `[G6 ${LABEL}]`,
        JSON.stringify({
          turns: trace.turns,
          tools: trace.toolsByName,
          modes: grepCallsIn(trace).map((a) => a.output_mode ?? "(default)"),
          final: res.finalContent.slice(0, 200),
        }),
      );

      expect(trace.toolsByName.grep ?? 0).toBeGreaterThanOrEqual(1);
      // Every grep call must pick a cheap mode; a single content-mode call
      // on a summary question means the model over-paid and we want to know.
      const allCheap = grepCallsIn(trace).every(
        (a) =>
          a.output_mode === undefined ||
          a.output_mode === "files_with_matches" ||
          a.output_mode === "count",
      );
      expect(allCheap).toBe(true);
      // Accept the count either as a digit ("2") or as an English word
      // ("two"). Word form is common across gemma/qwen; don't hide a real
      // pass behind regex pedantry.
      expect(res.finalContent).toMatch(/\b(2|two)\b/i);
    },
    300_000,
  );

  // G7: Context-aware — "show me the body" should use content mode with context.
  // Stochastic: gemma4:e2b sometimes picks content without context and still returns the right lines;
  // that's a weaker-but-acceptable outcome. pass@k with k=2/3 protects against jitter.
  it.runIf(() => available)(
    "G7 context-aware: uses content mode (ideally with context) to show a function body",
    async () => {
      const r = await passAtK({
        n: 3,
        k: 2,
        label: "G7",
        run: async () => {
          const root = mkRoot();
          writeFile(
            root,
            "src/auth.ts",
            [
              "import { hash } from 'node:crypto';",
              "",
              "export function handleAuth(req) {",
              "  const token = req.headers['x-token'];",
              "  if (!token) return 401;",
              "  return verify(token);",
              "}",
              "",
              "function verify(t) { return t.length > 10 ? 200 : 403; }",
              "",
            ].join("\n"),
          );
          writeFile(root, "src/index.ts", "export { handleAuth } from './auth.js';\n");

          const tools = [pickGrepExecutor(makeSession(root))];
          const { trace, onTrace } = collectTrace();

          const res = await runE2E(
            runOpts(
              SYSTEM_PROMPT,
              `In ${root}, show me the body of the function that handles auth. Include the function signature and the lines of its body.`,
              tools,
              8,
              onTrace,
            ),
          );

          const usedContent = someCall(trace, (a) => a.output_mode === "content");
          const bodyMentioned =
            /x-token/i.test(res.finalContent) &&
            /verify/.test(res.finalContent);
          return {
            ok: usedContent && bodyMentioned,
            detail: {
              turns: trace.turns,
              seq: trace.toolSeq,
              grepArgs: grepCallsIn(trace).map((a) => ({
                pattern: a.pattern,
                output_mode: a.output_mode,
                context_before: a.context_before,
                context_after: a.context_after,
                context: a.context,
              })),
              final: res.finalContent.slice(0, 300),
            },
          };
        },
      });
      expect(r.successes).toBeGreaterThanOrEqual(2);
    },
    600_000,
  );

  // G8: Pagination — 600 matching files; model must page or narrow, not give up.
  it.runIf(() => available)(
    "G8 pagination: covers a large result set via pagination or narrowing",
    async () => {
      const root = mkRoot();
      for (let i = 0; i < 600; i++) {
        writeFile(root, `pkg/f${i}.ts`, `export const MARK = ${i};\n`);
      }
      // Planted file only reachable by paging past 250 or by filtering.
      writeFile(
        root,
        "pkg/specialMarkerFile_ZZZ.ts",
        "export const SPECIAL = 'MARK-UNIQUE-ABC123';\n",
      );

      const tools = [pickGrepExecutor(makeSession(root))];
      const { trace, onTrace } = collectTrace();

      const res = await runE2E(
        runOpts(
          SYSTEM_PROMPT,
          `In ${root}, find the file that contains the literal token 'MARK-UNIQUE-ABC123'. Many files contain just 'MARK' — don't match those. Narrow the pattern if the first search is too broad.`,
          tools,
          8,
          onTrace,
        ),
      );

      console.log(
        `[G8 ${LABEL}]`,
        JSON.stringify({
          turns: trace.turns,
          tools: trace.toolsByName,
          grepCalls: grepCallsIn(trace).length,
          final: res.finalContent.slice(0, 200),
        }),
      );

      expect(trace.toolsByName.grep ?? 0).toBeGreaterThanOrEqual(1);
      expect(trace.toolsByName.grep ?? 0).toBeLessThanOrEqual(6);
      expect(res.finalContent).toMatch(/specialMarkerFile_ZZZ/);
    },
    360_000,
  );
});
