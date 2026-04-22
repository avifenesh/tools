import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_SENSITIVE_PATTERNS,
  InMemoryLedger,
} from "@agent-sh/harness-core";
import type { WriteSessionConfig } from "@agent-sh/harness-write";
import {
  bedrockAvailable,
  expectSequence,
  loadDotEnv,
  makeEditExecutor,
  makeMultiEditExecutor,
  makeReadExecutor,
  makeShellExecutor,
  makeWriteExecutor,
  makeWriteExecutorsRust,
  modelLabel,
  ollamaModelAvailable,
  passAtK,
  resolveBackend,
  resolveModel,
  runE2E,
  warmupOllama,
  type AgentTraceEvent,
} from "../src/index.js";
import type { ReadSessionConfig } from "@agent-sh/harness-read";

/**
 * Engine-swap for parity testing. HARNESS_WRITE_ENGINE=rust routes every
 * write/edit/multiedit call through `harness-write-cli`. The TS `read`
 * tool continues to serve reads but every read event is forwarded into
 * the Rust ledger via `registerRead` so read-before-edit gates pass.
 * A single per-session shared Rust runner is held in a WeakMap keyed on
 * the session object so the three picker functions and the read wrapper
 * talk to the same CLI process.
 */
const WRITE_ENGINE = (process.env.HARNESS_WRITE_ENGINE ?? "ts").toLowerCase();

const rustRunners = new WeakMap<
  object,
  ReturnType<typeof makeWriteExecutorsRust>
>();

function getRustRunner(
  session: WriteSessionConfig,
): ReturnType<typeof makeWriteExecutorsRust> {
  const key = session as unknown as object;
  let r = rustRunners.get(key);
  if (!r) {
    r = makeWriteExecutorsRust(session);
    rustRunners.set(key, r);
  }
  return r;
}

const pickWriteExecutor: typeof makeWriteExecutor =
  WRITE_ENGINE === "rust"
    ? ((session) => getRustRunner(session).write)
    : makeWriteExecutor;

const pickEditExecutor: typeof makeEditExecutor =
  WRITE_ENGINE === "rust"
    ? ((session) => getRustRunner(session).edit)
    : makeEditExecutor;

const pickMultiEditExecutor: typeof makeMultiEditExecutor =
  WRITE_ENGINE === "rust"
    ? ((session) => getRustRunner(session).multiEdit)
    : makeMultiEditExecutor;

function pickReadExecutor(
  readSession: ReadSessionConfig,
  writeSession: WriteSessionConfig,
): ReturnType<typeof makeReadExecutor> {
  const tsRead = makeReadExecutor(readSession);
  if (WRITE_ENGINE !== "rust") return tsRead;
  const runner = getRustRunner(writeSession);
  return {
    tool: tsRead.tool,
    async execute(args: Record<string, unknown>) {
      const result = await tsRead.execute(args);
      if (typeof args.path === "string") {
        try {
          const content = readFileSync(args.path);
          await runner.registerRead(args.path, content);
        } catch {
          // Non-fatal — the read itself probably failed too.
        }
      }
      return result;
    },
  };
}

loadDotEnv();

const BACKEND = resolveBackend();
const MODEL = resolveModel("qwen3.5:27b-q4_K_M");
const LABEL = modelLabel(MODEL);
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

const SYSTEM_PROMPT = [
  "You are a coding agent with four tools: `read`, `write`, `edit`, `multiedit`.",
  "You MUST call `read` on any existing file before you `write`, `edit`, or `multiedit` it.",
  "Prefer `edit` (single targeted change) or `multiedit` (several changes to one file in one shot) over `write` for existing files.",
  "Use `write` only when creating a new file, or when you genuinely need to replace the whole file.",
  "If `edit` returns OLD_STRING_NOT_UNIQUE, widen old_string with surrounding context. If it returns OLD_STRING_NOT_FOUND, read the returned candidates and correct the string, then retry.",
  "If a `write`/`edit` returns NOT_READ_THIS_SESSION, call `read` on the path first and retry.",
  "When the task is done, reply with a short plain-text answer describing what you changed.",
].join(" ");

const SYSTEM_PROMPT_WITH_SHELL =
  SYSTEM_PROMPT +
  " A `shell` tool is also available but you should prefer dedicated tools.";

function mkRoot(): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), "e2e-write-hard-")));
}

function writeFile(dir: string, name: string, content: string): string {
  const p = path.join(dir, name);
  writeFileSync(p, content);
  return p;
}

function readUtf8(p: string): string {
  return readFileSync(p, "utf8");
}

function sha(p: string): string {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

function makeSession(
  root: string,
  overrides: Partial<WriteSessionConfig> = {},
): WriteSessionConfig & { ledger: InMemoryLedger } {
  const ledger = overrides.ledger ?? new InMemoryLedger();
  return {
    cwd: root,
    permissions: {
      roots: [root],
      sensitivePatterns: DEFAULT_SENSITIVE_PATTERNS,
    },
    ledger,
    ...overrides,
  } as WriteSessionConfig & { ledger: InMemoryLedger };
}

interface TraceSummary {
  turns: number;
  toolsByName: Record<string, number>;
  toolSeq: string[];
  finalContent: string;
  events: AgentTraceEvent[];
}

function collectTrace(): {
  trace: TraceSummary;
  onTrace: (e: AgentTraceEvent) => void;
} {
  const trace: TraceSummary = {
    turns: 0,
    toolsByName: {},
    toolSeq: [],
    finalContent: "",
    events: [],
  };
  currentTrace = trace;
  const onTrace = (e: AgentTraceEvent) => {
    trace.events.push(e);
    if (e.kind === "tool_call") {
      trace.toolsByName[e.name] = (trace.toolsByName[e.name] ?? 0) + 1;
      trace.toolSeq.push(e.name);
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

const TRACE_DIR = process.env.E2E_TRACE_DIR;
let currentTrace: TraceSummary | null = null;

describe(`write e2e hard [${LABEL}]`, () => {
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
      // trace dump is best-effort
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
        `[warmup ${LABEL}] latencyMs=${w.latencyMs} skipped=${w.skipped}${w.reason ? ` reason=${w.reason}` : ""}`,
      );
    }
  });

  // W1: Golden edit — read, then edit a single unique occurrence.
  it.runIf(() => available)(
    "W1 golden-edit: reads then edits a unique line",
    async () => {
      const root = mkRoot();
      const target = writeFile(
        root,
        "greet.js",
        "function greet(name) {\n  return 'hello, ' + name;\n}\n",
      );
      const session = makeSession(root);
      const tools = [
        pickReadExecutor({ cwd: root, permissions: session.permissions, ledger: session.ledger }, session),
        pickEditExecutor(session),
      ];
      const { trace, onTrace } = collectTrace();

      const res = await runE2E(
        runOpts(
          SYSTEM_PROMPT,
          `In ${target}, change the greeting from 'hello, ' to 'Hi there, '. Read the file first, then edit it.`,
          tools,
          tools.length + 4,
          onTrace,
        ),
      );

      console.log(
        `[W1 ${LABEL}]`,
        JSON.stringify({
          turns: trace.turns,
          tools: trace.toolsByName,
          seq: trace.toolSeq,
          final: res.finalContent.slice(0, 200),
        }),
      );

      expectSequence(trace.toolSeq, ["read", "edit"]);
      expect(readUtf8(target)).toContain("Hi there, ");
      expect(readUtf8(target)).not.toContain("hello, ");
    },
    300_000,
  );

  // W2: Read-before-edit gate — if model skips read, Edit fails; model must recover.
  it.runIf(() => available)(
    "W2 read-gate: edit without read gets NOT_READ_THIS_SESSION, model recovers",
    async () => {
      const root = mkRoot();
      const target = writeFile(root, "a.txt", "hello world\n");
      const session = makeSession(root);
      const tools = [
        pickReadExecutor({ cwd: root, permissions: session.permissions, ledger: session.ledger }, session),
        pickEditExecutor(session),
      ];
      const { trace, onTrace } = collectTrace();

      const res = await runE2E(
        runOpts(
          // Deliberately nudge the model toward skipping the read.
          "You have tools `read` and `edit`. The read-before-edit gate is enforced by the tool. If an edit fails because of the gate, read first and retry.",
          `Change 'world' to 'there' in ${target}.`,
          tools,
          6,
          onTrace,
        ),
      );

      console.log(
        `[W2 ${LABEL}]`,
        JSON.stringify({
          turns: trace.turns,
          tools: trace.toolsByName,
          seq: trace.toolSeq,
          final: res.finalContent.slice(0, 200),
        }),
      );

      expect(readUtf8(target)).toContain("there");
    },
    300_000,
  );

  // W3: NOT_UNIQUE recovery — two identical lines; Edit fails, model widens
  // old_string with context, or switches to replace_all. Either is acceptable.
  // Wrapped in passAtK because small models (gemma4:e2b) and baseline qwen3:8b
  // are stochastic on this recovery path. We tolerate 1 miss in 3.
  it.runIf(() => available)(
    "W3 not-unique: recovers from OLD_STRING_NOT_UNIQUE",
    async () => {
      const summary = await passAtK({
        n: 3,
        k: 2,
        label: `W3 ${LABEL}`,
        run: async (attempt) => {
          const root = mkRoot();
          const target = writeFile(
            root,
            "dup.py",
            [
              "def foo():",
              "    x = 1",
              "    return x",
              "",
              "def bar():",
              "    x = 1",
              "    return x * 2",
              "",
            ].join("\n"),
          );
          const session = makeSession(root);
          const tools = [
            pickReadExecutor({ cwd: root, permissions: session.permissions, ledger: session.ledger }, session),
            pickEditExecutor(session),
          ];
          const { trace, onTrace } = collectTrace();
          try {
            const res = await runE2E(
              runOpts(
                SYSTEM_PROMPT,
                `In ${target}, change the line 'x = 1' INSIDE the function bar() to 'x = 42'. Do not change the one in foo().`,
                tools,
                8,
                onTrace,
              ),
            );
            const txt = readUtf8(target);
            const ok =
              txt.includes("def foo():\n    x = 1") &&
              txt.includes("def bar():\n    x = 42");
            console.log(
              `[W3 ${LABEL} attempt=${attempt}]`,
              JSON.stringify({
                ok,
                turns: trace.turns,
                seq: trace.toolSeq,
                final: res.finalContent.slice(0, 160),
              }),
            );
            return {
              ok,
              detail: { turns: trace.turns, seq: trace.toolSeq },
            };
          } catch (e) {
            const msg = (e as Error).message;
            console.warn(
              `[W3 ${LABEL} attempt=${attempt}] transport error: ${msg}`,
            );
            return { ok: false, detail: { error: msg } };
          }
        },
      });
      expect(summary.passed).toBe(true);
    },
    900_000,
  );

  // W4: NOT_FOUND with candidates — model mistypes a name; fuzzy candidates
  // should let it self-correct.
  it.runIf(() => available)(
    "W4 not-found-fuzzy: recovers via returned candidates",
    async () => {
      const root = mkRoot();
      const target = writeFile(
        root,
        "calc.ts",
        "export function calculateTotal(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0);\n}\n",
      );
      const session = makeSession(root);
      const tools = [
        pickReadExecutor({ cwd: root, permissions: session.permissions, ledger: session.ledger }, session),
        pickEditExecutor(session),
      ];
      const { trace, onTrace } = collectTrace();

      // The function in the file is `calculateTotal` (singular). The prompt
      // asks the model to rename the function that sums the items list — the
      // model should read the file, identify the real name, and edit.
      const res = await runE2E(
        runOpts(
          SYSTEM_PROMPT,
          `In ${target}, rename the function that sums the items list to 'sum'. Leave the rest of the file as-is.`,
          tools,
          8,
          onTrace,
        ),
      );

      console.log(
        `[W4 ${LABEL}]`,
        JSON.stringify({
          turns: trace.turns,
          tools: trace.toolsByName,
          seq: trace.toolSeq,
          final: res.finalContent.slice(0, 200),
        }),
      );

      expect(readUtf8(target)).toContain("function sum");
      expect(readUtf8(target)).not.toContain("calculateTotal");
    },
    300_000,
  );

  // W5: MultiEdit atomicity — ask for a rename + body change in one multiedit.
  it.runIf(() => available)(
    "W5 multiedit: applies coordinated rename + signature change in one call",
    async () => {
      const root = mkRoot();
      const target = writeFile(
        root,
        "svc.js",
        [
          "function handleRequest(req) {",
          "  return process(req);",
          "}",
          "",
          "module.exports = { handleRequest };",
          "",
        ].join("\n"),
      );
      const session = makeSession(root);
      const tools = [
        pickReadExecutor({ cwd: root, permissions: session.permissions, ledger: session.ledger }, session),
        pickMultiEditExecutor(session),
      ];
      const { trace, onTrace } = collectTrace();

      const res = await runE2E(
        runOpts(
          SYSTEM_PROMPT,
          `In ${target}: rename every occurrence of 'handleRequest' to 'serve' AND change the body 'return process(req)' to 'return process(req, {})'. Use multiedit in a single call.`,
          tools,
          6,
          onTrace,
        ),
      );

      console.log(
        `[W5 ${LABEL}]`,
        JSON.stringify({
          turns: trace.turns,
          tools: trace.toolsByName,
          seq: trace.toolSeq,
          final: res.finalContent.slice(0, 200),
        }),
      );

      const txt = readUtf8(target);
      expect(txt).toContain("function serve(req)");
      expect(txt).toContain("module.exports = { serve }");
      expect(txt).toContain("process(req, {})");
      expect(txt).not.toContain("handleRequest");
    },
    600_000,
  );

  // W6: Write overwrite — existing file, model must read first.
  it.runIf(() => available)(
    "W6 write-overwrite: reads then overwrites an existing file",
    async () => {
      const root = mkRoot();
      const target = writeFile(root, "notes.md", "old notes\n");
      const before = sha(target);
      const session = makeSession(root);
      const tools = [
        pickReadExecutor({ cwd: root, permissions: session.permissions, ledger: session.ledger }, session),
        pickWriteExecutor(session),
      ];
      const { trace, onTrace } = collectTrace();

      const res = await runE2E(
        runOpts(
          SYSTEM_PROMPT,
          `Replace the entire contents of ${target} with a single line that reads exactly: NEW CONTENT`,
          tools,
          6,
          onTrace,
        ),
      );

      console.log(
        `[W6 ${LABEL}]`,
        JSON.stringify({
          turns: trace.turns,
          tools: trace.toolsByName,
          seq: trace.toolSeq,
          final: res.finalContent.slice(0, 200),
        }),
      );

      expect(sha(target)).not.toBe(before);
      expect(readUtf8(target)).toContain("NEW CONTENT");
    },
    300_000,
  );

  // W7: Write create — path doesn't exist yet; no read required.
  it.runIf(() => available)(
    "W7 write-create: creates a new file without reading first",
    async () => {
      const root = mkRoot();
      const target = path.join(root, "hello.txt");
      const session = makeSession(root);
      const tools = [
        pickReadExecutor({ cwd: root, permissions: session.permissions, ledger: session.ledger }, session),
        pickWriteExecutor(session),
      ];
      const { trace, onTrace } = collectTrace();

      const res = await runE2E(
        runOpts(
          SYSTEM_PROMPT,
          `Create a new file at ${target} containing the single line 'Hello, world.'`,
          tools,
          5,
          onTrace,
        ),
      );

      console.log(
        `[W7 ${LABEL}]`,
        JSON.stringify({
          turns: trace.turns,
          tools: trace.toolsByName,
          seq: trace.toolSeq,
          final: res.finalContent.slice(0, 200),
        }),
      );

      expect(trace.toolsByName["write"] ?? 0).toBeGreaterThanOrEqual(1);
      expect(readUtf8(target)).toContain("Hello, world.");
    },
    300_000,
  );

  // W8: Bash decoy — shell is available, but the model should still pick
  // edit/write for file mutations. If it routes around, that's a description
  // problem we want to see surfaced in logs. Wrapped in passAtK because tool
  // routing is probabilistic at the small-model end of the matrix.
  it.runIf(() => available)(
    "W8 bash-decoy-write: model prefers edit over shell sed",
    async () => {
      const summary = await passAtK({
        n: 3,
        k: 2,
        label: `W8 ${LABEL}`,
        run: async (attempt) => {
          const root = mkRoot();
          const target = writeFile(
            root,
            "cfg.ini",
            "level=info\ntimeout=30\n",
          );
          const session = makeSession(root);
          const readExec = pickReadExecutor({ cwd: root, permissions: session.permissions, ledger: session.ledger }, session);
          const editExec = pickEditExecutor(session);
          const shellExec = makeShellExecutor({ cwd: root });
          const tools = [readExec, editExec, shellExec];
          const { trace, onTrace } = collectTrace();
          try {
            const res = await runE2E(
              runOpts(
                SYSTEM_PROMPT_WITH_SHELL,
                `In ${target}, change 'level=info' to 'level=debug'.`,
                tools,
                6,
                onTrace,
              ),
            );
            const editCalls = trace.toolsByName["edit"] ?? 0;
            const shellCalls = trace.toolsByName["shell"] ?? 0;
            const ok = readUtf8(target).includes("level=debug");
            console.log(
              `[W8 ${LABEL} attempt=${attempt}]`,
              JSON.stringify({
                ok,
                turns: trace.turns,
                edit: editCalls,
                shell: shellCalls,
                seq: trace.toolSeq,
                final: res.finalContent.slice(0, 160),
              }),
            );
            if (editCalls === 0 && shellCalls > 0) {
              console.warn(
                `[W8 ${LABEL} attempt=${attempt}] WARNING: model bypassed \`edit\` and used \`shell\` — tool-description problem.`,
              );
            }
            return {
              ok,
              detail: {
                edit: editCalls,
                shell: shellCalls,
                seq: trace.toolSeq,
              },
            };
          } catch (e) {
            const msg = (e as Error).message;
            console.warn(
              `[W8 ${LABEL} attempt=${attempt}] transport error: ${msg}`,
            );
            return { ok: false, detail: { error: msg } };
          }
        },
      });
      expect(summary.passed).toBe(true);
    },
    900_000,
  );
});
