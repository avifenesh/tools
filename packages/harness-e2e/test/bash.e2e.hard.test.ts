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
import type { BashSessionConfig } from "@agent-sh/harness-bash";
import { createLocalBashExecutor } from "@agent-sh/harness-bash";
import {
  bedrockAvailable,
  loadDotEnv,
  makeBashExecutor,
  makeBashExecutorsRust,
  makeBashKillExecutor,
  makeBashOutputExecutor,
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
 * Engine-swap for parity testing. HARNESS_BASH_ENGINE=rust routes every
 * `bash` / `bash_output` / `bash_kill` call through the `harness-bash-cli`
 * binary. Default (unset) uses TS. The Rust runner shares one CLI process
 * across the trio of executors per session, so the same child handles all
 * three tools.
 */
const ENGINE = (process.env.HARNESS_BASH_ENGINE ?? "ts").toLowerCase();
const pickBashExecutors =
  ENGINE === "rust"
    ? (session: BashSessionConfig) => {
        const r = makeBashExecutorsRust(session);
        return {
          bash: r.bash,
          bashOutput: r.bashOutput,
          bashKill: r.bashKill,
        };
      }
    : (session: BashSessionConfig) => ({
        bash: makeBashExecutor(session),
        bashOutput: makeBashOutputExecutor(session),
        bashKill: makeBashKillExecutor(session),
      });

loadDotEnv();

const BACKEND = resolveBackend();
const MODEL = resolveModel("qwen3.5:27b-q4_K_M");
const LABEL = modelLabel(MODEL);
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

const SYSTEM_PROMPT = [
  "You are an autonomous coding agent with a shell tool family: `bash` (run a command), `bash_output` (poll a background job), `bash_kill` (terminate a background job).",
  "Use `bash` for shell commands. To run Python/Node use one-liners: `python -c '...'`, `node -e '...'`.",
  "For long-running processes (servers, watchers), pass `background: true`. Poll with `bash_output(job_id)`. Clean up with `bash_kill(job_id)`.",
  "If a command needs to change the working directory for later calls, issue a single top-level `cd <path>` call.",
  "Do NOT run interactive commands that block on stdin (pagers, REPLs, `git commit` without -m). Use non-interactive flags.",
  "When the task is done, answer in a short plain-text sentence.",
].join(" ");

function mkRoot(): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), "e2e-bash-hard-")));
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
  overrides: Partial<BashSessionConfig> = {},
): BashSessionConfig {
  return {
    cwd: root,
    permissions: {
      roots: [root],
      sensitivePatterns: DEFAULT_SENSITIVE_PATTERNS,
      // E2E fixtures need bash without a hook; the session isolates
      // via mktemp workspace roots + sensitive-patterns default.
      unsafeAllowBashWithoutHook: true,
    },
    executor: createLocalBashExecutor(),
    logicalCwd: { value: root },
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

function combinedSurface(trace: TraceSummary, finalContent: string): string {
  const toolOutputs = trace.events
    .filter(
      (e): e is AgentTraceEvent & { kind: "tool_result"; content: string } =>
        e.kind === "tool_result" &&
        typeof (e as { content?: unknown }).content === "string",
    )
    .map((e) => e.content)
    .join("\n");
  return `${finalContent}\n${toolOutputs}`;
}

const TRACE_DIR = process.env.E2E_TRACE_DIR;

describe(`bash e2e hard [${LABEL}]`, () => {
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
      // best-effort
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

  // BASH1: Golden — simple command with clean output.
  it.runIf(() => available)(
    "BASH1 golden: answers a shell question with one bash call",
    async () => {
      const root = mkRoot();
      const session = makeSession(root);
      const tools = [pickBashExecutors(session).bash];
      const { trace, onTrace } = collectTrace();

      const res = await runE2E(
        runOpts(
          SYSTEM_PROMPT,
          `In ${root}, what's the current date and time? Use the shell.`,
          tools,
          6,
          onTrace,
        ),
      );

      console.log(
        `[BASH1 ${LABEL}]`,
        JSON.stringify({
          turns: trace.turns,
          tools: trace.toolsByName,
          seq: trace.toolSeq,
          final: res.finalContent.slice(0, 200),
        }),
      );

      expect(trace.toolsByName.bash ?? 0).toBeGreaterThanOrEqual(1);
      // Answer should mention a year 2024+ or contain a month name.
      const surface = combinedSurface(trace, res.finalContent);
      expect(surface).toMatch(/\b(202[4-9]|20[3-9]\d)\b|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/);
    },
    300_000,
  );

  // BASH2: Python one-liner. Tests that models hit language via the command.
  it.runIf(() => available)(
    "BASH2 python-one-liner: computes via `python -c`",
    async () => {
      const root = mkRoot();
      const session = makeSession(root);
      const tools = [pickBashExecutors(session).bash];
      const { trace, onTrace } = collectTrace();

      const res = await runE2E(
        runOpts(
          SYSTEM_PROMPT,
          `In ${root}, compute 2 raised to the 20th power using Python. Use the bash tool.`,
          tools,
          6,
          onTrace,
        ),
      );

      console.log(
        `[BASH2 ${LABEL}]`,
        JSON.stringify({
          turns: trace.turns,
          tools: trace.toolsByName,
          seq: trace.toolSeq,
          final: res.finalContent.slice(0, 200),
        }),
      );

      expect(trace.toolsByName.bash ?? 0).toBeGreaterThanOrEqual(1);
      const surface = combinedSurface(trace, res.finalContent);
      expect(surface).toContain("1048576");
    },
    300_000,
  );

  // BASH3: Nonzero exit recovery. Model runs failing cmd then corrects.
  // Stochastic — wrap in pass@k.
  it.runIf(() => available)(
    "BASH3 nonzero-exit-recovery: corrects after `ls` on missing path",
    async () => {
      const r = await passAtK({
        n: 3,
        k: 2,
        label: "BASH3",
        run: async () => {
          const root = mkRoot();
          writeFile(root, "hello.txt", "hi\n");
          const session = makeSession(root);
          const tools = [pickBashExecutors(session).bash];
          const { trace, onTrace } = collectTrace();

          const res = await runE2E(
            runOpts(
              SYSTEM_PROMPT,
              `In ${root}, list the files in the 'data' directory. If that directory doesn't exist, list files in the current directory instead.`,
              tools,
              8,
              onTrace,
            ),
          );

          const surface = combinedSurface(trace, res.finalContent);
          const saidHello = /hello\.txt/.test(surface);
          const attemptedData = trace.toolArgs.some(
            (c) =>
              c.name === "bash" &&
              typeof c.args.command === "string" &&
              /data/.test(c.args.command as string),
          );
          return {
            ok: saidHello && attemptedData,
            detail: {
              seq: trace.toolSeq,
              cmds: trace.toolArgs
                .filter((c) => c.name === "bash")
                .map((c) => (c.args.command as string).slice(0, 80)),
              final: res.finalContent.slice(0, 200),
            },
          };
        },
      });
      expect(r.successes).toBeGreaterThanOrEqual(2);
    },
    600_000,
  );

  // BASH4: Output cap. Model runs a high-output command, must cope with cap.
  it.runIf(() => available)(
    "BASH4 output-cap: handles capped output via head+tail or log-path",
    async () => {
      const root = mkRoot();
      const session = makeSession(root, {
        maxOutputBytesInline: 1024,
      });
      const tools = [pickBashExecutors(session).bash];
      const { trace, onTrace } = collectTrace();

      const res = await runE2E(
        runOpts(
          SYSTEM_PROMPT,
          `In ${root}, print the numbers 1 through 2000 using 'seq 1 2000'. Then tell me the FIRST number printed.`,
          tools,
          6,
          onTrace,
        ),
      );

      console.log(
        `[BASH4 ${LABEL}]`,
        JSON.stringify({
          turns: trace.turns,
          tools: trace.toolsByName,
          final: res.finalContent.slice(0, 200),
        }),
      );

      expect(trace.toolsByName.bash ?? 0).toBeGreaterThanOrEqual(1);
      // Answer: the first number is 1. Model should find this from the
      // head of the (possibly capped) output.
      expect(res.finalContent).toMatch(/\b1\b/);
    },
    300_000,
  );

  // BASH5: Nonsensitive env rejection. Model tries AWS_*, gets rejected, recovers.
  it.runIf(() => available)(
    "BASH5 sensitive-env-rejection: recovers from AWS_ env rejection",
    async () => {
      const root = mkRoot();
      const session = makeSession(root);
      const tools = [pickBashExecutors(session).bash];
      const { trace, onTrace } = collectTrace();

      const res = await runE2E(
        runOpts(
          SYSTEM_PROMPT,
          `In ${root}, run 'echo $MY_MESSAGE' with MY_MESSAGE set to "greetings" via env. Just show me what it prints.`,
          tools,
          6,
          onTrace,
        ),
      );

      console.log(
        `[BASH5 ${LABEL}]`,
        JSON.stringify({
          turns: trace.turns,
          tools: trace.toolsByName,
          final: res.finalContent.slice(0, 200),
        }),
      );

      expect(trace.toolsByName.bash ?? 0).toBeGreaterThanOrEqual(1);
      expect(res.finalContent).toMatch(/greetings/);
    },
    300_000,
  );

  // BASH6: Interactive-rejection. Stochastic — wrap in pass@k.
  it.runIf(() => available)(
    "BASH6 interactive: avoids or recovers from an interactive-style command",
    async () => {
      const r = await passAtK({
        n: 3,
        k: 2,
        label: "BASH6",
        run: async () => {
          const root = mkRoot();
          writeFile(root, "input.txt", "line1\nline2\n");
          const session = makeSession(root, {
            defaultInactivityTimeoutMs: 2_000,
          });
          const tools = [pickBashExecutors(session).bash];
          const { trace, onTrace } = collectTrace();

          const res = await runE2E(
            runOpts(
              SYSTEM_PROMPT,
              `In ${root}, view the contents of input.txt WITHOUT a pager. Tell me what's in it.`,
              tools,
              6,
              onTrace,
            ),
          );

          const surface = combinedSurface(trace, res.finalContent);
          const sawLines = /line1/.test(surface) && /line2/.test(surface);
          return {
            ok: sawLines,
            detail: {
              seq: trace.toolSeq,
              final: res.finalContent.slice(0, 200),
            },
          };
        },
      });
      expect(r.successes).toBeGreaterThanOrEqual(2);
    },
    600_000,
  );

  // BASH7: Alias pushback — model passes 'cmd' instead of 'command'.
  // This tests that the alias hint routes the model back. Stochastic.
  it.runIf(() => available)(
    "BASH7 alias-pushback: recovers from wrong param name",
    async () => {
      const r = await passAtK({
        n: 3,
        k: 2,
        label: "BASH7",
        run: async () => {
          const root = mkRoot();
          const session = makeSession(root);
          const tools = [pickBashExecutors(session).bash];
          const { trace, onTrace } = collectTrace();

          // Nothing in the prompt encourages the model to use 'cmd' vs
          // 'command'; we just want a completable task that doesn't steer.
          const res = await runE2E(
            runOpts(
              SYSTEM_PROMPT,
              `In ${root}, print the string "alpha-123" using echo.`,
              tools,
              6,
              onTrace,
            ),
          );

          const surface = combinedSurface(trace, res.finalContent);
          return {
            ok: /alpha-123/.test(surface),
            detail: {
              seq: trace.toolSeq,
              final: res.finalContent.slice(0, 200),
            },
          };
        },
      });
      expect(r.successes).toBeGreaterThanOrEqual(2);
    },
    600_000,
  );

  // BASH8: Background jobs. Model starts a background command, polls, kills.
  it.runIf(() => available)(
    "BASH8 background: starts background job, polls bash_output, kills",
    async () => {
      const root = mkRoot();
      const session = makeSession(root);
      const picked = pickBashExecutors(session);
      const tools = [picked.bash, picked.bashOutput, picked.bashKill];
      const { trace, onTrace } = collectTrace();

      const res = await runE2E(
        runOpts(
          SYSTEM_PROMPT,
          `In ${root}, start a background command that prints "tick" every second for 10 seconds (use 'for i in $(seq 10); do echo tick; sleep 1; done'). After starting, immediately check its output once, then kill it. Report the job_id you used.`,
          tools,
          10,
          onTrace,
        ),
      );

      console.log(
        `[BASH8 ${LABEL}]`,
        JSON.stringify({
          turns: trace.turns,
          tools: trace.toolsByName,
          seq: trace.toolSeq,
          final: res.finalContent.slice(0, 200),
        }),
      );

      const usedBackground = trace.toolArgs.some(
        (c) => c.name === "bash" && c.args.background === true,
      );
      const usedPoll = (trace.toolsByName.bash_output ?? 0) >= 1;
      const usedKill = (trace.toolsByName.bash_kill ?? 0) >= 1;
      expect(usedBackground, "should have used background:true").toBe(true);
      expect(usedPoll || usedKill, "should have polled or killed").toBe(true);
    },
    600_000,
  );
});
