#!/usr/bin/env node
/**
 * Layer 5 aggregator: runs a chosen e2e suite against each configured
 * backend, collects per-test pass/fail, and diffs against a checked-in
 * baseline. This is the release gate — a single script that tells you
 * which tests are regressing on which backend without eyeballing three
 * separate vitest runs.
 *
 * Usage:
 *   tsx scripts/aggregate.ts \
 *     --suite test/write.e2e.hard.test.ts \
 *     --backends ollama:qwen3.5:27b-q4_K_M,ollama:qwen3:8b,bedrock \
 *     --out baselines/write-hard.json \
 *     [--check]        # compare against existing baseline; exit 1 on regression
 *     [--update]       # overwrite baseline (use on green runs)
 *
 * On each backend we invoke `vitest run --reporter=json <suite>`, parse
 * the JSON, pick out the test names + pass/fail + duration, and store
 * one row per (backend, test) in the aggregate JSON.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

interface CliArgs {
  suite: string;
  backends: string[];
  out: string;
  check: boolean;
  update: boolean;
  rounds: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = { check: false, update: false, rounds: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--suite") {
      const v = argv[++i];
      if (v) args.suite = v;
    } else if (a === "--backends") {
      const v = argv[++i];
      if (v) args.backends = v.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (a === "--out") {
      const v = argv[++i];
      if (v) args.out = v;
    } else if (a === "--check") {
      args.check = true;
    } else if (a === "--update") {
      args.update = true;
    } else if (a === "--rounds") {
      const v = argv[++i];
      if (v) args.rounds = Math.max(1, Number.parseInt(v, 10));
    } else if (a === "-h" || a === "--help") {
      // eslint-disable-next-line no-console
      console.log(readmeUsage());
      process.exit(0);
    }
  }
  if (!args.suite) die("missing --suite");
  if (!args.backends || args.backends.length === 0) die("missing --backends");
  if (!args.out) die("missing --out");
  return args as CliArgs;
}

function die(msg: string): never {
  // eslint-disable-next-line no-console
  console.error(`aggregate: ${msg}\n\n${readmeUsage()}`);
  process.exit(2);
}

function readmeUsage(): string {
  return [
    "Usage: tsx scripts/aggregate.ts",
    "  --suite <path>           e.g. test/write.e2e.hard.test.ts",
    "  --backends <csv>         e.g. ollama:qwen3.5:27b-q4_K_M,bedrock",
    "  --out <json-path>        aggregate output file",
    "  [--check]                compare vs existing --out; exit 1 on regression",
    "  [--update]               write --out unconditionally",
    "  [--rounds N]             run the suite N times per backend; any-pass wins (default 1)",
  ].join("\n");
}

interface BackendSpec {
  readonly id: string;
  readonly env: Record<string, string>;
}

function specForBackend(raw: string): BackendSpec {
  if (raw === "bedrock") {
    return { id: "bedrock", env: { E2E_BACKEND: "bedrock" } };
  }
  if (raw.startsWith("ollama:")) {
    const model = raw.slice("ollama:".length);
    return {
      id: raw,
      env: { E2E_BACKEND: "ollama", E2E_MODEL: model },
    };
  }
  throw new Error(`Unknown backend spec: ${raw}`);
}

interface VitestAssertionResult {
  title: string;
  fullName: string;
  status: "passed" | "failed" | "pending" | "skipped" | "todo";
  duration?: number;
}

interface VitestTestResult {
  name: string;
  status: "passed" | "failed";
  assertionResults: VitestAssertionResult[];
}

interface VitestJsonReport {
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  testResults: VitestTestResult[];
}

interface TestTrace {
  readonly turns: number;
  readonly toolsByName: Record<string, number>;
  readonly toolSeq: readonly string[];
  readonly finalContent: string;
  readonly events: readonly unknown[];
}

interface BackendRunResult {
  readonly backend: string;
  readonly tests: readonly {
    readonly name: string;
    readonly status: "passed" | "failed" | "skipped";
    readonly durationMs: number | null;
    readonly trace?: TestTrace;
    readonly passes?: number;
    readonly total?: number;
    readonly rounds?: readonly {
      readonly round: number;
      readonly status: "passed" | "failed" | "skipped";
      readonly durationMs: number | null;
      readonly trace?: TestTrace;
    }[];
  }[];
  readonly totals: {
    readonly passed: number;
    readonly failed: number;
    readonly skipped: number;
  };
  readonly exitCode: number;
}

/**
 * Strip the "[backend-label] " prefix tests embed in their describe() names.
 * Tests use `describe(\`write e2e hard [${LABEL}]\`, ...)` so the fullName
 * comes out as "write e2e hard [ollama:model] W1 ...". We want to group by
 * the logical test id ("write e2e hard W1 ...") across backends.
 */
function normalizeTestName(raw: string): string {
  return raw.replace(/\s*\[[^\]]+\]\s*/, " ").replace(/\s+/g, " ").trim();
}

function loadTraces(traceDir: string): Map<string, TestTrace> {
  const byName = new Map<string, TestTrace>();
  if (!existsSync(traceDir)) return byName;
  for (const f of readdirSync(traceDir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(readFileSync(path.join(traceDir, f), "utf8")) as {
        testName?: string;
        trace?: TestTrace;
      };
      if (raw.testName && raw.trace) {
        byName.set(raw.testName, raw.trace);
      }
    } catch {
      // ignore malformed trace files
    }
  }
  return byName;
}

/**
 * Stop any loaded Ollama models + clear the "currently loaded" set. We saw
 * runs where the 2nd/3rd backend suffered stalls and spurious errors that
 * we could only explain by GPU memory pressure or stale model state after
 * rapid model cycling. This is a belt-and-suspenders reset.
 */
function resetOllamaState(): void {
  try {
    const list = spawnSync("ollama", ["ps"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const lines = (list.stdout ?? "").split("\n").slice(1);
    const names = lines
      .map((l) => l.split(/\s+/)[0])
      .filter((n): n is string => !!n && n.length > 0);
    for (const n of names) {
      spawnSync("ollama", ["stop", n], { stdio: "ignore" });
    }
    if (names.length > 0) {
      // eslint-disable-next-line no-console
      console.error(`[ollama] stopped: ${names.join(", ")}`);
    }
  } catch {
    // ollama not installed or not running — nothing to reset.
  }
}

function runBackend(spec: BackendSpec, suite: string): BackendRunResult {
  // eslint-disable-next-line no-console
  console.error(`\n=== running suite=${suite} on backend=${spec.id} ===`);
  if (spec.id.startsWith("ollama:")) resetOllamaState();
  const traceDir = mkdtempSync(path.join(tmpdir(), "e2e-trace-"));
  const result = spawnSync(
    "pnpm",
    ["exec", "vitest", "run", suite, "--reporter=json"],
    {
      env: { ...process.env, ...spec.env, E2E_TRACE_DIR: traceDir },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
      timeout: 30 * 60 * 1000,
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  const stdout = result.stdout ?? "";
  const traces = loadTraces(traceDir);
  try {
    rmSync(traceDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
  // vitest json reporter prints the JSON to stdout as the last block.
  // Some pipelines prepend log lines; find the first `{`.
  const firstBrace = stdout.indexOf("{");
  if (firstBrace < 0) {
    return {
      backend: spec.id,
      tests: [],
      totals: { passed: 0, failed: 0, skipped: 0 },
      exitCode: result.status ?? 1,
    };
  }
  let report: VitestJsonReport;
  try {
    report = JSON.parse(stdout.slice(firstBrace)) as VitestJsonReport;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`aggregate: could not parse vitest JSON for ${spec.id}: ${(e as Error).message}`);
    return {
      backend: spec.id,
      tests: [],
      totals: { passed: 0, failed: 0, skipped: 0 },
      exitCode: result.status ?? 1,
    };
  }
  const tests: {
    name: string;
    status: "passed" | "failed" | "skipped";
    durationMs: number | null;
    trace?: TestTrace;
  }[] = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const file of report.testResults) {
    for (const a of file.assertionResults) {
      const status: "passed" | "failed" | "skipped" =
        a.status === "passed"
          ? "passed"
          : a.status === "failed"
            ? "failed"
            : "skipped";
      const rawName = a.fullName;
      const normalized = normalizeTestName(rawName);
      // Traces are dumped keyed by the leaf `it()` name (ctx.task.name in
      // vitest), while vitest fullName is "<describe> <it>". Try the full
      // name first, then fall back to the leaf title.
      const trace =
        traces.get(rawName) ??
        traces.get(a.title) ??
        traces.get(normalized);
      tests.push({
        name: normalized,
        status,
        durationMs: a.duration ?? null,
        ...(trace ? { trace } : {}),
      });
      if (status === "passed") passed++;
      else if (status === "failed") failed++;
      else skipped++;
    }
  }
  return {
    backend: spec.id,
    tests,
    totals: { passed, failed, skipped },
    exitCode: result.status ?? 0,
  };
}

interface AggregateReport {
  readonly suite: string;
  readonly createdAt: string;
  readonly runs: readonly BackendRunResult[];
}

/**
 * Run the suite N times on a single backend and fold into any-pass cells.
 * Mirrors peer-compare's --rounds semantics so the two baselines are
 * directly comparable: a cell is "passed" iff at least one attempt passed.
 * Each test record carries passes/total and per-round detail for post-hoc
 * analysis.
 */
function runBackendRounds(
  spec: BackendSpec,
  suite: string,
  rounds: number,
): BackendRunResult {
  if (rounds <= 1) return runBackend(spec, suite);
  // eslint-disable-next-line no-console
  console.error(`\n### ${spec.id}: running ${rounds} rounds ###`);
  const attempts: BackendRunResult[] = [];
  for (let r = 1; r <= rounds; r++) {
    // eslint-disable-next-line no-console
    console.error(`\n--- ${spec.id} round ${r}/${rounds} ---`);
    attempts.push(runBackend(spec, suite));
  }
  const testNames = new Set<string>();
  for (const a of attempts) for (const t of a.tests) testNames.add(t.name);
  const merged: Array<BackendRunResult["tests"][number]> = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const name of [...testNames].sort()) {
    const perRound = attempts.map((a, i) => {
      const t = a.tests.find((x) => x.name === name);
      return {
        round: i + 1,
        status: (t?.status ?? "skipped") as "passed" | "failed" | "skipped",
        durationMs: t?.durationMs ?? null,
        ...(t?.trace ? { trace: t.trace } : {}),
      };
    });
    const passes = perRound.filter((p) => p.status === "passed").length;
    const total = perRound.length;
    const anyPass = passes > 0;
    const anyFail = perRound.some((p) => p.status === "failed");
    const status: "passed" | "failed" | "skipped" = anyPass
      ? "passed"
      : anyFail
        ? "failed"
        : "skipped";
    if (status === "passed") passed++;
    else if (status === "failed") failed++;
    else skipped++;
    const firstPass = perRound.find((p) => p.status === "passed");
    const trace = firstPass?.trace ?? perRound.find((p) => p.trace)?.trace;
    merged.push({
      name,
      status,
      durationMs: perRound.reduce((s, p) => s + (p.durationMs ?? 0), 0),
      ...(trace ? { trace } : {}),
      passes,
      total,
      rounds: perRound,
    });
  }
  const exitCode = failed > 0 ? 1 : 0;
  return {
    backend: spec.id,
    tests: merged,
    totals: { passed, failed, skipped },
    exitCode,
  };
}

function buildMatrix(
  runs: readonly BackendRunResult[],
): readonly (readonly (string | undefined)[])[] {
  const testNames = new Set<string>();
  for (const r of runs) for (const t of r.tests) testNames.add(t.name);
  const sortedNames = [...testNames].sort();
  const header = ["test", ...runs.map((r) => r.backend)];
  const rows: (string | undefined)[][] = [header];
  for (const name of sortedNames) {
    const row: (string | undefined)[] = [name];
    for (const r of runs) {
      const t = r.tests.find((x) => x.name === name);
      if (!t) { row.push("—"); continue; }
      if (typeof t.passes === "number" && typeof t.total === "number" && t.total > 1) {
        row.push(`${t.passes}/${t.total}`);
      } else {
        row.push(t.status);
      }
    }
    rows.push(row);
  }
  return rows;
}

function printMatrix(matrix: readonly (readonly (string | undefined)[])[]): void {
  // Simple fixed-width table.
  const colWidths: number[] = [];
  for (const row of matrix) {
    row.forEach((cell, i) => {
      const len = (cell ?? "").length;
      colWidths[i] = Math.max(colWidths[i] ?? 0, len);
    });
  }
  for (const row of matrix) {
    const line = row
      .map((cell, i) => (cell ?? "").padEnd(colWidths[i] ?? 0))
      .join("  ");
    // eslint-disable-next-line no-console
    console.log(line);
  }
}

interface DiffRow {
  readonly test: string;
  readonly backend: string;
  readonly baseline: string;
  readonly current: string;
}

function diffReports(
  baseline: AggregateReport,
  current: AggregateReport,
): readonly DiffRow[] {
  const rows: DiffRow[] = [];
  for (const cur of current.runs) {
    const base = baseline.runs.find((r) => r.backend === cur.backend);
    if (!base) {
      for (const t of cur.tests) {
        rows.push({
          test: t.name,
          backend: cur.backend,
          baseline: "(new backend)",
          current: t.status,
        });
      }
      continue;
    }
    const baseMap = new Map(base.tests.map((t) => [t.name, t.status]));
    for (const t of cur.tests) {
      const b = baseMap.get(t.name) ?? "(new test)";
      if (b !== t.status) {
        rows.push({
          test: t.name,
          backend: cur.backend,
          baseline: b,
          current: t.status,
        });
      }
    }
  }
  return rows;
}

function isRegression(d: DiffRow): boolean {
  // passed -> failed is a regression. passed -> skipped might be (CI lost
  // the credential), we flag it but don't fail.
  return d.baseline === "passed" && d.current === "failed";
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const runs: BackendRunResult[] = [];
  for (const raw of args.backends) {
    const spec = specForBackend(raw);
    runs.push(runBackendRounds(spec, args.suite, args.rounds));
  }
  const current: AggregateReport = {
    suite: args.suite,
    createdAt: new Date().toISOString(),
    runs,
  };

  // eslint-disable-next-line no-console
  console.log("\n=== aggregate matrix ===");
  printMatrix(buildMatrix(runs));

  const outPath = path.resolve(args.out);
  const outDir = path.dirname(outPath);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  if (args.check) {
    if (!existsSync(outPath)) {
      // eslint-disable-next-line no-console
      console.error(`aggregate: --check: no baseline at ${outPath}; run with --update to create one`);
      process.exit(2);
    }
    const baseline = JSON.parse(readFileSync(outPath, "utf8")) as AggregateReport;
    const diffs = diffReports(baseline, current);
    if (diffs.length === 0) {
      // eslint-disable-next-line no-console
      console.log("\naggregate: no changes vs baseline.");
      process.exit(0);
    }
    // eslint-disable-next-line no-console
    console.log("\n=== diff vs baseline ===");
    for (const d of diffs) {
      const mark = isRegression(d) ? "✗" : "•";
      // eslint-disable-next-line no-console
      console.log(
        `${mark} [${d.backend}] ${d.test}: ${d.baseline} → ${d.current}`,
      );
    }
    const regressions = diffs.filter(isRegression);
    if (regressions.length > 0) {
      // eslint-disable-next-line no-console
      console.error(
        `\naggregate: ${regressions.length} regression(s). Exiting 1.`,
      );
      process.exit(1);
    }
    process.exit(0);
  }

  if (args.update || !existsSync(outPath)) {
    writeFileSync(outPath, JSON.stringify(current, null, 2));
    // eslint-disable-next-line no-console
    console.log(`\naggregate: wrote ${outPath}`);
  } else {
    // eslint-disable-next-line no-console
    console.log(
      `\naggregate: baseline exists at ${outPath}. Pass --check to compare or --update to overwrite.`,
    );
  }
}

main();
