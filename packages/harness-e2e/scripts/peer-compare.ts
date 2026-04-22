#!/usr/bin/env node
/**
 * Peer comparator: replays W1-W8 fixtures against an external agent CLI
 * (opencode, via src/peerRunner.ts) and produces a pass/fail matrix in the
 * same JSON shape as `baselines/write-hard.json`.
 *
 * Purpose: isolate "our tools vs. someone else's tools" holding the model,
 * fixtures, and prompts constant. If opencode's `edit` passes a case ours
 * fails, the gap is our tool surface (description/error text/schema).
 *
 * Usage:
 *   tsx scripts/peer-compare.ts \
 *     --models ollama/qwen3:8b,ollama/qwen3.5:27b-q4_K_M \
 *     --out baselines/write-hard-opencode.json \
 *     [--only W3,W8]
 *
 * Note: opencode prefixes Ollama models with `ollama/` (its provider namespace)
 * whereas our native tests use the raw ollama tag. Accept either here.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { runPeer, type PeerRunResult } from "../src/index.js";

interface CliArgs {
  models: string[];
  out: string;
  only?: string[];
  timeoutMs: number;
  rounds: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = { timeoutMs: 10 * 60 * 1000, rounds: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--models") {
      const v = argv[++i];
      if (v)
        args.models = v
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
    } else if (a === "--out") {
      const v = argv[++i];
      if (v) args.out = v;
    } else if (a === "--only") {
      const v = argv[++i];
      if (v)
        args.only = v
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
    } else if (a === "--timeout-ms") {
      const v = argv[++i];
      if (v) args.timeoutMs = Number.parseInt(v, 10);
    } else if (a === "--rounds") {
      const v = argv[++i];
      if (v) args.rounds = Math.max(1, Number.parseInt(v, 10));
    } else if (a === "-h" || a === "--help") {
      // eslint-disable-next-line no-console
      console.log(usage());
      process.exit(0);
    }
  }
  if (!args.models || args.models.length === 0) die("missing --models");
  if (!args.out) die("missing --out");
  return args as CliArgs;
}

function die(msg: string): never {
  // eslint-disable-next-line no-console
  console.error(`peer-compare: ${msg}\n\n${usage()}`);
  process.exit(2);
}

function usage(): string {
  return [
    "Usage: tsx scripts/peer-compare.ts",
    "  --models <csv>    e.g. ollama/qwen3:8b,ollama/gemma4:26b-a4b-it-q4_K_M",
    "  --out <json>      output path",
    "  [--only <csv>]    restrict to a subset e.g. W3,W8",
    "  [--timeout-ms N]  per-case timeout (default 600000)",
    "  [--rounds N]      run the full matrix N times; report per-cell pass rate (default 1)",
  ].join("\n");
}

interface Fixture {
  readonly id: string; // W1..W8
  readonly title: string;
  readonly prepare: (root: string) => { target: string; before: string };
  /** The prompt given to the peer agent. */
  readonly prompt: (target: string) => string;
  /** Returns ok=true if the final file state matches success criteria. */
  readonly verify: (target: string, res: PeerRunResult) => { ok: boolean; note: string };
}

function writeFile(dir: string, name: string, content: string): string {
  const p = path.join(dir, name);
  writeFileSync(p, content);
  return p;
}

function readUtf8(p: string): string {
  return readFileSync(p, "utf8");
}

function mkRoot(prefix: string): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

const FIXTURES: readonly Fixture[] = [
  {
    id: "W1",
    title: "W1 golden-edit: reads then edits a unique line",
    prepare: (root) => {
      const target = writeFile(
        root,
        "greet.js",
        "function greet(name) {\n  return 'hello, ' + name;\n}\n",
      );
      return { target, before: readUtf8(target) };
    },
    prompt: (target) =>
      `In ${target}, change the greeting from 'hello, ' to 'Hi there, '. Read the file first, then edit it.`,
    verify: (target) => {
      const txt = readUtf8(target);
      const ok = txt.includes("Hi there, ") && !txt.includes("hello, ");
      return { ok, note: ok ? "" : `file still reads: ${txt.slice(0, 80)}` };
    },
  },
  {
    id: "W2",
    title:
      "W2 read-gate: edit without read gets NOT_READ_THIS_SESSION, model recovers",
    prepare: (root) => {
      const target = writeFile(root, "a.txt", "hello world\n");
      return { target, before: readUtf8(target) };
    },
    prompt: (target) => `Change 'world' to 'there' in ${target}.`,
    verify: (target) => {
      const txt = readUtf8(target);
      const ok = txt.includes("there");
      return { ok, note: ok ? "" : `file: ${txt.slice(0, 80)}` };
    },
  },
  {
    id: "W3",
    title: "W3 not-unique: recovers from OLD_STRING_NOT_UNIQUE",
    prepare: (root) => {
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
      return { target, before: readUtf8(target) };
    },
    prompt: (target) =>
      `In ${target}, change the line 'x = 1' INSIDE the function bar() to 'x = 42'. Do not change the one in foo().`,
    verify: (target) => {
      const txt = readUtf8(target);
      const ok =
        txt.includes("def foo():\n    x = 1") &&
        txt.includes("def bar():\n    x = 42");
      return { ok, note: ok ? "" : `file:\n${txt}` };
    },
  },
  {
    id: "W4",
    title: "W4 not-found-fuzzy: recovers via returned candidates",
    prepare: (root) => {
      const target = writeFile(
        root,
        "calc.ts",
        "export function calculateTotal(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0);\n}\n",
      );
      return { target, before: readUtf8(target) };
    },
    prompt: (target) =>
      `In ${target}, rename the function that sums the items list to 'sum'. Leave the rest of the file as-is.`,
    verify: (target) => {
      const txt = readUtf8(target);
      const ok = txt.includes("function sum") && !txt.includes("calculateTotal");
      return { ok, note: ok ? "" : `file:\n${txt}` };
    },
  },
  {
    id: "W5",
    title: "W5 multiedit: applies coordinated rename + signature change in one call",
    prepare: (root) => {
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
      return { target, before: readUtf8(target) };
    },
    prompt: (target) =>
      `In ${target}: rename every occurrence of 'handleRequest' to 'serve' AND change the body 'return process(req)' to 'return process(req, {})'. Do it in a single step if your tools support multi-edit.`,
    verify: (target) => {
      const txt = readUtf8(target);
      const ok =
        txt.includes("function serve(req)") &&
        txt.includes("module.exports = { serve }") &&
        txt.includes("process(req, {})") &&
        !txt.includes("handleRequest");
      return { ok, note: ok ? "" : `file:\n${txt}` };
    },
  },
  {
    id: "W6",
    title: "W6 write-overwrite: reads then overwrites an existing file",
    prepare: (root) => {
      const target = writeFile(root, "notes.md", "old notes\n");
      return { target, before: readUtf8(target) };
    },
    prompt: (target) =>
      `Replace the entire contents of ${target} with a single line that reads exactly: NEW CONTENT`,
    verify: (target) => {
      const txt = readUtf8(target);
      const ok = txt.includes("NEW CONTENT");
      return { ok, note: ok ? "" : `file: ${txt.slice(0, 80)}` };
    },
  },
  {
    id: "W7",
    title: "W7 write-create: creates a new file without reading first",
    prepare: (root) => {
      const target = path.join(root, "hello.txt");
      return { target, before: "" };
    },
    prompt: (target) =>
      `Create a new file at ${target} containing the single line 'Hello, world.'`,
    verify: (target) => {
      if (!existsSync(target)) return { ok: false, note: "file not created" };
      const txt = readUtf8(target);
      const ok = txt.includes("Hello, world.");
      return { ok, note: ok ? "" : `file: ${txt.slice(0, 80)}` };
    },
  },
  {
    id: "W8",
    title: "W8 bash-decoy-write: model prefers edit over shell sed",
    prepare: (root) => {
      const target = writeFile(root, "cfg.ini", "level=info\ntimeout=30\n");
      return { target, before: readUtf8(target) };
    },
    prompt: (target) => `In ${target}, change 'level=info' to 'level=debug'.`,
    verify: (target, res) => {
      const txt = readUtf8(target);
      const ok = txt.includes("level=debug");
      const shellCalls = res.toolSeq.filter(
        (n) => n === "bash" || n === "shell",
      ).length;
      const editCalls = res.toolSeq.filter(
        (n) => n === "edit" || n === "patch" || n === "write",
      ).length;
      const note = ok
        ? `edit=${editCalls} shell=${shellCalls}`
        : `file: ${txt.slice(0, 80)}`;
      return { ok, note };
    },
  },
];

interface CaseResult {
  readonly model: string;
  readonly fixtureId: string;
  readonly fixtureTitle: string;
  readonly status: "passed" | "failed" | "error";
  readonly note: string;
  readonly toolSeq: readonly string[];
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly finalTextPreview: string;
  readonly exitCode: number;
  readonly stderrTail: string;
  readonly round: number;
}

interface BackendRunResult {
  readonly backend: string;
  readonly tests: readonly {
    readonly name: string;
    readonly status: "passed" | "failed" | "skipped";
    readonly durationMs: number | null;
    readonly trace?: unknown;
  }[];
  readonly totals: { readonly passed: number; readonly failed: number; readonly skipped: number };
  readonly exitCode: number;
}

interface AggregateReport {
  readonly suite: string;
  readonly createdAt: string;
  readonly runs: readonly BackendRunResult[];
}

async function runOneCase(
  model: string,
  fx: Fixture,
  timeoutMs: number,
  round: number,
): Promise<CaseResult> {
  const root = mkRoot("peer-write-");
  const { target } = fx.prepare(root);
  const prompt = fx.prompt(target);
  // eslint-disable-next-line no-console
  console.error(`[${model}] ${fx.id} (round ${round}): running...`);
  let res: PeerRunResult;
  try {
    res = await runPeer({
      peer: "opencode",
      model,
      cwd: root,
      prompt,
      timeoutMs,
    });
  } catch (e) {
    return {
      model,
      fixtureId: fx.id,
      fixtureTitle: fx.title,
      status: "error",
      note: `runPeer threw: ${(e as Error).message}`,
      toolSeq: [],
      durationMs: 0,
      timedOut: false,
      finalTextPreview: "",
      exitCode: -1,
      stderrTail: "",
      round,
    };
  }
  const { ok, note } = fx.verify(target, res);
  return {
    model,
    fixtureId: fx.id,
    fixtureTitle: fx.title,
    status: ok ? "passed" : "failed",
    note,
    toolSeq: res.toolSeq,
    durationMs: res.durationMs,
    timedOut: res.timedOut,
    finalTextPreview: res.finalText.slice(0, 240),
    exitCode: res.exitCode,
    stderrTail: res.stderr.slice(-400),
    round,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const fixtures = args.only
    ? FIXTURES.filter((f) => args.only!.includes(f.id))
    : FIXTURES;
  if (fixtures.length === 0) die("no fixtures matched --only");

  // key = `${model}||${fixtureId}`, value = attempts across rounds
  const cellAttempts = new Map<string, CaseResult[]>();
  const cellKey = (model: string, fxId: string): string => `${model}||${fxId}`;

  for (let round = 1; round <= args.rounds; round++) {
    // eslint-disable-next-line no-console
    console.error(`\n########## round ${round}/${args.rounds} ##########`);
    for (const model of args.models) {
      // eslint-disable-next-line no-console
      console.error(`\n=== peer=opencode model=${model} round=${round} ===`);
      for (const fx of fixtures) {
        const c = await runOneCase(model, fx, args.timeoutMs, round);
        const key = cellKey(model, fx.id);
        const arr = cellAttempts.get(key) ?? [];
        arr.push(c);
        cellAttempts.set(key, arr);
        // eslint-disable-next-line no-console
        console.error(
          `  ${c.fixtureId} r${round} ${c.status}  seq=[${c.toolSeq.join(", ")}]  t=${c.durationMs}ms  note=${c.note.slice(0, 120).replace(/\n/g, " ")}`,
        );
      }
    }
  }

  const runs: BackendRunResult[] = args.models.map((model) => {
    let passed = 0;
    let failed = 0;
    const tests: BackendRunResult["tests"] = fixtures.map((fx) => {
      const attempts = cellAttempts.get(cellKey(model, fx.id)) ?? [];
      const passes = attempts.filter((a) => a.status === "passed").length;
      const total = attempts.length;
      // cell is "passed" iff it passed at least once (pass@k style);
      // rounds[] trace preserves per-attempt detail for post-hoc analysis.
      const anyPass = passes > 0;
      if (anyPass) passed++;
      else failed++;
      return {
        name: `peer opencode ${fx.title}`,
        status: anyPass ? "passed" : "failed",
        durationMs: attempts.reduce((s, a) => s + a.durationMs, 0),
        trace: {
          fixtureId: fx.id,
          rounds: attempts.map((a) => ({
            round: a.round,
            status: a.status,
            note: a.note,
            toolSeq: a.toolSeq,
            durationMs: a.durationMs,
            timedOut: a.timedOut,
            finalTextPreview: a.finalTextPreview,
            exitCode: a.exitCode,
            stderrTail: a.stderrTail,
          })),
          passRate: total > 0 ? passes / total : 0,
          passes,
          total,
        },
      };
    });
    return {
      backend: `opencode:${model}`,
      tests,
      totals: { passed, failed, skipped: 0 },
      exitCode: failed > 0 ? 1 : 0,
    };
  });

  const report: AggregateReport = {
    suite: "peer-opencode/write",
    createdAt: new Date().toISOString(),
    runs,
  };

  const outPath = path.resolve(args.out);
  const outDir = path.dirname(outPath);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2));

  // Build a compact matrix for the console showing pass-rate per cell.
  const header = ["test", ...runs.map((r) => r.backend)];
  const rows: string[][] = [header];
  const testNames = [...new Set(runs.flatMap((r) => r.tests.map((t) => t.name)))].sort();
  for (const name of testNames) {
    const row: string[] = [name];
    for (const r of runs) {
      const t = r.tests.find((x) => x.name === name);
      if (!t) { row.push("—"); continue; }
      const tr = t.trace as { passes?: number; total?: number } | undefined;
      const passes = tr?.passes ?? (t.status === "passed" ? 1 : 0);
      const total = tr?.total ?? 1;
      row.push(`${passes}/${total}`);
    }
    rows.push(row);
  }
  const widths: number[] = [];
  for (const row of rows) row.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, c.length)));
  // eslint-disable-next-line no-console
  console.log(`\n=== peer matrix (rounds=${args.rounds}, passes/total) ===`);
  for (const row of rows) {
    // eslint-disable-next-line no-console
    console.log(row.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  "));
  }
  // eslint-disable-next-line no-console
  console.log(`\npeer-compare: wrote ${outPath}`);
  const h = createHash("sha1").update(JSON.stringify(runs)).digest("hex").slice(0, 12);
  // eslint-disable-next-line no-console
  console.log(`peer-compare: runs sha1=${h}`);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(`peer-compare: fatal: ${(e as Error).message}`);
  process.exit(2);
});
