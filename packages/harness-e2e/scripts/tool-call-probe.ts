#!/usr/bin/env node
/**
 * Tool-call capability probe.
 *
 * Goal: before running the full e2e matrix against a new Ollama model,
 * prove the model actually emits `tool_calls` through Ollama's template.
 * Native function-calling support in the model card is not the same as
 * working Ollama tool-call wiring — the two drift per model family.
 *
 * For each configured model, we:
 *   1. Check ollamaModelAvailable.
 *   2. Run a trivial 2-tool prompt ("read /tmp/probe.txt").
 *   3. Report whether tool_calls were emitted AND whether `read` was picked.
 *
 * Usage:
 *   tsx scripts/tool-call-probe.ts \
 *     --models ollama:gemma4:e2b-it-q4_K_M,ollama:gemma4:26b-it-q4_K_M,ollama:qwen3:8b,ollama:qwen3.5:27b-q4_K_M
 *
 * Exit codes:
 *   0 — all configured models emit tool_calls
 *   1 — at least one model failed to emit tool_calls (details printed)
 *   2 — CLI / infra error
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_SENSITIVE_PATTERNS, InMemoryLedger } from "@agent-sh/harness-core";
import {
  loadDotEnv,
  makeReadExecutor,
  ollamaModelAvailable,
  runAgent,
  type AgentTraceEvent,
} from "../src/index.js";

loadDotEnv();

interface CliArgs {
  readonly models: readonly string[];
  readonly baseUrl: string;
}

function parseArgs(argv: string[]): CliArgs {
  let models: string[] = [];
  let baseUrl = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--models") {
      const v = argv[++i];
      if (v) models = v.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (a === "--base-url") {
      const v = argv[++i];
      if (v) baseUrl = v;
    } else if (a === "-h" || a === "--help") {
      // eslint-disable-next-line no-console
      console.log(
        "Usage: tsx scripts/tool-call-probe.ts --models <csv> [--base-url <url>]",
      );
      process.exit(0);
    }
  }
  if (models.length === 0) {
    // eslint-disable-next-line no-console
    console.error("probe: --models is required");
    process.exit(2);
  }
  return { models, baseUrl };
}

interface ProbeResult {
  readonly model: string;
  readonly available: boolean;
  readonly toolCallsEmitted: boolean;
  readonly pickedRead: boolean;
  readonly turns: number;
  readonly seq: readonly string[];
  readonly finalPreview: string;
  readonly note?: string;
}

async function probe(modelSpec: string, baseUrl: string): Promise<ProbeResult> {
  if (!modelSpec.startsWith("ollama:")) {
    return {
      model: modelSpec,
      available: false,
      toolCallsEmitted: false,
      pickedRead: false,
      turns: 0,
      seq: [],
      finalPreview: "",
      note: "probe only supports ollama: backends",
    };
  }
  const model = modelSpec.slice("ollama:".length);

  const available = await ollamaModelAvailable(model, baseUrl);
  if (!available) {
    return {
      model: modelSpec,
      available: false,
      toolCallsEmitted: false,
      pickedRead: false,
      turns: 0,
      seq: [],
      finalPreview: "",
      note: `not available at ${baseUrl}`,
    };
  }

  const root = mkdtempSync(path.join(tmpdir(), "probe-"));
  const target = path.join(root, "probe.txt");
  writeFileSync(target, "the magic word is 'xyzzy'\n");

  const ledger = new InMemoryLedger();
  const readExec = makeReadExecutor({
    cwd: root,
    permissions: {
      roots: [root],
      sensitivePatterns: DEFAULT_SENSITIVE_PATTERNS,
    },
    ledger,
  });

  const seq: string[] = [];
  const onTrace = (e: AgentTraceEvent) => {
    if (e.kind === "tool_call") seq.push(e.name);
  };

  try {
    const res = await runAgent({
      baseUrl,
      model,
      tools: [readExec],
      systemPrompt:
        "You are a coding agent. Use the `read` tool to read files the user asks about.",
      userPrompt: `Read the file at ${target} and tell me what's in it.`,
      maxTurns: 4,
      onTrace,
      // Keep thinking on — matches repo policy.
    });
    return {
      model: modelSpec,
      available: true,
      toolCallsEmitted: seq.length > 0,
      pickedRead: seq.includes("read"),
      turns: res.turns,
      seq,
      finalPreview: res.finalContent.slice(0, 160),
    };
  } catch (e) {
    return {
      model: modelSpec,
      available: true,
      toolCallsEmitted: false,
      pickedRead: false,
      turns: 0,
      seq,
      finalPreview: "",
      note: `probe threw: ${(e as Error).message}`,
    };
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const results: ProbeResult[] = [];
  for (const m of args.models) {
    // eslint-disable-next-line no-console
    console.error(`--- probing ${m} ---`);
    const r = await probe(m, args.baseUrl);
    results.push(r);
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        model: r.model,
        available: r.available,
        toolCallsEmitted: r.toolCallsEmitted,
        pickedRead: r.pickedRead,
        turns: r.turns,
        seq: r.seq,
        finalPreview: r.finalPreview,
        note: r.note,
      }),
    );
  }

  // eslint-disable-next-line no-console
  console.log("\n=== probe summary ===");
  for (const r of results) {
    const status = !r.available
      ? "SKIP (unavailable)"
      : r.pickedRead
        ? "OK (tool_calls + picked read)"
        : r.toolCallsEmitted
          ? "PARTIAL (tool_calls but wrong tool)"
          : "FAIL (no tool_calls)";
    // eslint-disable-next-line no-console
    console.log(`  ${r.model.padEnd(40)} ${status}${r.note ? ` — ${r.note}` : ""}`);
  }

  const fatalMissingToolCalls = results.some(
    (r) => r.available && !r.toolCallsEmitted,
  );
  process.exit(fatalMissingToolCalls ? 1 : 0);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(`probe: fatal: ${(e as Error).message}`);
  process.exit(2);
});
