#!/usr/bin/env node
/**
 * Peer comparator for the Glob tool: replays G1-G9 fixtures against opencode
 * and produces a pass/fail matrix parallel to `baselines/glob-hard.json`.
 *
 * Purpose (same as peer-compare.ts for Write): isolate "our tool vs. someone
 * else's" holding model + fixtures + prompts constant. Where opencode's glob
 * passes and ours fails, the gap is tool surface (description/schema/errors).
 * Where both fail on the same fixture, it's a model-capacity issue.
 *
 * opencode's glob tool is nearly verbatim Claude Code's (see the glob-impl
 * research guide); comparing against it isolates effects of our additions:
 * zero-match hint, alias pushback, narrowing-first truncation hint,
 * NOT_FOUND sibling suggestions.
 *
 * Usage:
 *   tsx scripts/peer-compare-glob.ts \
 *     --models ollama/qwen3:8b,ollama/qwen3.5:27b-q4_K_M \
 *     --out baselines/glob-hard-opencode.json \
 *     [--only G3,G7]
 *     [--rounds N]
 *
 * Verification is text-based: we check whether the final assistant reply
 * mentions the expected target filename. Glob is read-only, so there is no
 * filesystem-state assert like Write fixtures.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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
      if (v) args.models = v.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (a === "--out") {
      const v = argv[++i];
      if (v) args.out = v;
    } else if (a === "--only") {
      const v = argv[++i];
      if (v) args.only = v.split(",").map((s) => s.trim()).filter(Boolean);
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
  console.error(`peer-compare-glob: ${msg}\n\n${usage()}`);
  process.exit(2);
}

function usage(): string {
  return [
    "Usage: tsx scripts/peer-compare-glob.ts",
    "  --models <csv>    e.g. ollama/qwen3:8b,ollama/gemma4:26b-a4b-it-q4_K_M",
    "  --out <json>      output path",
    "  [--only <csv>]    restrict to a subset e.g. G3,G9",
    "  [--timeout-ms N]  per-case timeout (default 600000)",
    "  [--rounds N]      run the full matrix N times; report per-cell pass rate (default 1)",
  ].join("\n");
}

interface Fixture {
  readonly id: string; // G1..G9
  readonly title: string;
  readonly prepare: (root: string) => void;
  readonly prompt: (root: string) => string;
  readonly verify: (root: string, res: PeerRunResult) => { ok: boolean; note: string };
}

function writeFile(dir: string, name: string, content: string): string {
  const p = path.join(dir, name);
  const parent = path.dirname(p);
  if (parent !== dir) mkdirSync(parent, { recursive: true });
  writeFileSync(p, content);
  return p;
}

function mkRoot(prefix: string): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

function matches(text: string, re: RegExp): boolean {
  return re.test(text);
}

const FIXTURES: readonly Fixture[] = [
  {
    id: "G1",
    title: "G1 golden: locates a uniquely named file via recursive pattern",
    prepare: (root) => {
      writeFile(root, "src/UserService.ts", "export class UserService {}\n");
      writeFile(root, "src/AuthService.ts", "export class AuthService {}\n");
      writeFile(root, "src/util.ts", "export const x = 1;\n");
    },
    prompt: (root) =>
      `The project is at ${root}. Find the file containing the UserService class and tell me its path.`,
    verify: (_root, res) => {
      const ok = matches(res.finalText, /UserService\.ts/);
      return { ok, note: ok ? "" : `final: ${res.finalText.slice(0, 120)}` };
    },
  },
  {
    id: "G2",
    title: "G2 refine: narrows after a truncated result set",
    prepare: (root) => {
      for (let i = 0; i < 400; i++) writeFile(root, `pkg/f${i}.ts`, `export const x${i} = ${i};\n`);
      writeFile(
        root,
        "pkg/SpecialWidget.tsx",
        "export const SpecialWidget = () => null;\n",
      );
    },
    prompt: (root) =>
      `In ${root}, find the TSX file named 'SpecialWidget'. If your first search returns too many results, narrow the pattern.`,
    verify: (_root, res) => {
      const ok = matches(res.finalText, /SpecialWidget\.tsx/);
      return { ok, note: ok ? "" : `final: ${res.finalText.slice(0, 120)}` };
    },
  },
  {
    id: "G3",
    title: "G3 forgot-**: recovers from bare '*.ts' via zero-match hint",
    prepare: (root) => {
      writeFile(root, "src/deep/a.ts", "x");
      writeFile(root, "src/deep/b.ts", "x");
      writeFile(root, "pkg/nested/c.ts", "x");
      writeFile(root, "README.md", "# project\n");
    },
    prompt: (root) =>
      `In ${root}, list all TypeScript files in the project.`,
    verify: (_root, res) => {
      const ok = matches(res.finalText, /a\.ts|b\.ts|c\.ts/);
      return { ok, note: ok ? "" : `final: ${res.finalText.slice(0, 120)}` };
    },
  },
  {
    id: "G4",
    title: "G4 bash-decoy: prefers glob over bash for filename search",
    prepare: (root) => {
      writeFile(root, "src/UniqueWidget.tsx", "x");
      writeFile(root, "src/other.ts", "x");
    },
    prompt: (root) =>
      `In ${root}, find a file named UniqueWidget (any extension). Use the best available tool.`,
    verify: (_root, res) => {
      const foundFile = matches(res.finalText, /UniqueWidget/);
      const shellCalls = res.toolSeq.filter(
        (n) => n === "bash" || n === "shell",
      ).length;
      const globCalls = res.toolSeq.filter((n) => n === "glob").length;
      const ok = foundFile && globCalls >= 1 && shellCalls === 0;
      return {
        ok,
        note: ok
          ? `glob=${globCalls} shell=${shellCalls}`
          : `found=${foundFile} glob=${globCalls} shell=${shellCalls}`,
      };
    },
  },
  {
    id: "G5",
    title: "G5 gitignore: returns only source hits, not node_modules",
    prepare: (root) => {
      writeFile(root, ".gitignore", "node_modules\n");
      writeFile(root, "src/app.ts", "x");
      writeFile(root, "node_modules/lib/index.js", "x");
    },
    prompt: (root) =>
      `In ${root}, list all project source files. Exclude any vendored / dependency files.`,
    verify: (_root, res) => {
      const hasApp = matches(res.finalText, /app\.ts/);
      const hasNodeModules = matches(res.finalText, /node_modules/);
      const ok = hasApp && !hasNodeModules;
      return {
        ok,
        note: ok ? "" : `hasApp=${hasApp} hasNodeModules=${hasNodeModules}`,
      };
    },
  },
  {
    id: "G6",
    title: "G6 brace-expansion: handles multi-extension filter",
    prepare: (root) => {
      writeFile(root, "src/App.tsx", "x");
      writeFile(root, "src/util.ts", "x");
      writeFile(root, "src/index.js", "x");
      writeFile(root, "README.md", "x");
    },
    prompt: (root) =>
      `In ${root}, find all .ts and .tsx files (TypeScript source).`,
    verify: (_root, res) => {
      const hasTs =
        matches(res.finalText, /util\.ts(?!x)/) ||
        matches(res.finalText, /util\.ts\b/);
      const hasTsx = matches(res.finalText, /App\.tsx/);
      const ok = hasTs && hasTsx;
      return { ok, note: ok ? "" : `final: ${res.finalText.slice(0, 150)}` };
    },
  },
  {
    id: "G7",
    title: "G7 pagination: covers large result set via pagination or narrowing",
    prepare: (root) => {
      for (let i = 0; i < 600; i++) writeFile(root, `pkg/f${i}.ts`, "x");
      writeFile(
        root,
        "pkg/specialTarget_ZZZ.ts",
        "export const MARKER = 1;\n",
      );
    },
    prompt: (root) =>
      `In ${root}, find the file whose name contains 'specialTarget'. Many files are named f{0-599}.ts — do not list those.`,
    verify: (_root, res) => {
      const ok = matches(res.finalText, /specialTarget_ZZZ/);
      return { ok, note: ok ? "" : `final: ${res.finalText.slice(0, 120)}` };
    },
  },
  {
    id: "G8",
    title: "G8 typo-recovery: uses NOT_FOUND sibling suggestion to find typo'd path",
    prepare: (root) => {
      writeFile(root, "components/Button.tsx", "x");
      writeFile(root, "components/Input.tsx", "x");
    },
    prompt: (root) =>
      `Find all .tsx files under ${root}/componets (note: I may have typo'd the directory). Tell me the file paths.`,
    verify: (_root, res) => {
      const ok = matches(res.finalText, /Button\.tsx|Input\.tsx/);
      return { ok, note: ok ? "" : `final: ${res.finalText.slice(0, 120)}` };
    },
  },
  {
    id: "G9",
    title: "G9 oversize-steer: narrows instead of paging through a broad truncated result",
    prepare: (root) => {
      for (let i = 0; i < 300; i++) writeFile(root, `pkg/f${i}.ts`, "x");
      for (let i = 0; i < 300; i++) writeFile(root, `src/g${i}.ts`, "x");
      writeFile(
        root,
        "src/UniqueAuthHandler.ts",
        "export function handle() {}\n",
      );
    },
    prompt: (root) =>
      `In ${root}, find the file named 'UniqueAuthHandler'. Do not list unrelated files.`,
    verify: (_root, res) => {
      const globCalls = res.toolCalls.filter((c) => c.name === "glob");
      const patterns = globCalls.map((c) => {
        const input = c.input as { pattern?: string } | null;
        return input?.pattern ?? "";
      });
      // Paginated = same pattern re-called with offset, no narrowing.
      // opencode's glob may not have explicit offset param — treat as "same
      // pattern across all calls" + no narrowing.
      const narrowed = patterns.some(
        (p) => p.includes("UniqueAuth") || p.startsWith("src/"),
      );
      const foundTarget = matches(res.finalText, /UniqueAuthHandler/);
      const ok = foundTarget && narrowed;
      return {
        ok,
        note: ok
          ? `patterns=${JSON.stringify(patterns).slice(0, 140)}`
          : `found=${foundTarget} narrowed=${narrowed} patterns=${JSON.stringify(patterns).slice(0, 120)}`,
      };
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
  const root = mkRoot("peer-glob-");
  fx.prepare(root);
  const prompt = fx.prompt(root);
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
  const { ok, note } = fx.verify(root, res);
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
    suite: "peer-opencode/glob",
    createdAt: new Date().toISOString(),
    runs,
  };

  const outPath = path.resolve(args.out);
  const outDir = path.dirname(outPath);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2));

  // Console matrix.
  const header = ["test", ...runs.map((r) => r.backend)];
  const rows: string[][] = [header];
  const testNames = [
    ...new Set(runs.flatMap((r) => r.tests.map((t) => t.name))),
  ].sort();
  for (const name of testNames) {
    const row: string[] = [name];
    for (const r of runs) {
      const t = r.tests.find((x) => x.name === name);
      if (!t) {
        row.push("—");
        continue;
      }
      const tr = t.trace as { passes?: number; total?: number } | undefined;
      const passes = tr?.passes ?? (t.status === "passed" ? 1 : 0);
      const total = tr?.total ?? 1;
      row.push(`${passes}/${total}`);
    }
    rows.push(row);
  }
  const widths: number[] = [];
  for (const row of rows)
    row.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, c.length)));
  // eslint-disable-next-line no-console
  console.log(`\n=== peer-glob matrix (rounds=${args.rounds}, passes/total) ===`);
  for (const row of rows) {
    // eslint-disable-next-line no-console
    console.log(row.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  "));
  }
  // eslint-disable-next-line no-console
  console.log(`\npeer-compare-glob: wrote ${outPath}`);
  const h = createHash("sha1").update(JSON.stringify(runs)).digest("hex").slice(0, 12);
  // eslint-disable-next-line no-console
  console.log(`peer-compare-glob: runs sha1=${h}`);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(`peer-compare-glob: fatal: ${(e as Error).message}`);
  process.exit(2);
});
