import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_SENSITIVE_PATTERNS,
  InMemoryLedger,
} from "@agent-sh/harness-core";
import type { ReadSessionConfig } from "@agent-sh/harness-read";
import {
  bedrockAvailable,
  loadDotEnv,
  makeReadExecutor,
  modelLabel,
  ollamaModelAvailable,
  passAtK,
  resolveBackend,
  resolveModel,
  runE2E,
  type AgentTraceEvent,
  type ToolExecutor,
} from "../src/index.js";

loadDotEnv();

const BACKEND = resolveBackend();
const MODEL = resolveModel("qwen3.5:27b-q4_K_M");
const LABEL = modelLabel(MODEL);
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

const SYSTEM_PROMPT = [
  "You are an agent. Pick the best-suited tool for the user's request.",
  "Do not call multiple competing tools; pick one that fits.",
].join(" ");

function mkRoot(): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), "e2e-distractor-")));
}

/**
 * A deliberately worse-described competitor to the real `read` tool.
 * Same name prefix, same schema shape, same return style — but with:
 *   - a vaguer description,
 *   - a generic parameter name (`file_path` instead of `path`, which some
 *     models prefer from training data),
 *   - and a response that is *technically* correct (echoes the content).
 *
 * The point of the test is: does the model pick the well-described tool
 * (`read`) when both are available? If the distractor wins too often,
 * that's a tool-description quality signal — you need to tighten `read`'s
 * description until it consistently beats this one.
 */
function makeDistractorReadFile(): ToolExecutor {
  return {
    tool: {
      type: "function",
      function: {
        name: "read_file",
        description: "Reads a file.",
        parameters: {
          type: "object",
          properties: {
            file_path: { type: "string", description: "The file path." },
          },
          required: ["file_path"],
          additionalProperties: false,
        },
      },
    },
    async execute(args) {
      // Return a response the model can parse, so routing to the
      // distractor still "works" — we want to measure routing preference,
      // not error-driven retry.
      const fp = typeof args["file_path"] === "string" ? args["file_path"] : "";
      try {
        const { readFileSync } = await import("node:fs");
        return `CONTENTS OF ${fp}:\n${readFileSync(fp, "utf8")}`;
      } catch (e) {
        return `read_file error: ${(e as Error).message}`;
      }
    },
  };
}

describe(`distractor e2e [${LABEL}]`, () => {
  let available = false;
  beforeAll(async () => {
    if (BACKEND === "bedrock") {
      available = await bedrockAvailable(process.env.AWS_REGION);
    } else {
      available = await ollamaModelAvailable(MODEL, OLLAMA_BASE_URL);
    }
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn(`[skip distractor e2e] backend=${BACKEND} not reachable`);
    }
  });

  // Pass@k: we expect `read` to win more often than the distractor, but
  // not every single time. A 3/5 threshold lets us detect routing
  // degradation while tolerating routine variance.
  it.runIf(() => available)(
    "model prefers the well-described `read` over a vague `read_file` distractor (pass@3/5)",
    async () => {
      const root = mkRoot();
      const target = path.join(root, "manifest.json");
      writeFileSync(target, '{"name": "sample", "version": "1.0.0"}\n');

      const summary = await passAtK({
        n: 5,
        k: 3,
        label: `distractor-${LABEL}`,
        run: async (attempt) => {
          const ledger = new InMemoryLedger();
          const readSession: ReadSessionConfig = {
            cwd: root,
            permissions: {
              roots: [root],
              sensitivePatterns: DEFAULT_SENSITIVE_PATTERNS,
            },
            ledger,
          };

          const readTool = makeReadExecutor(readSession);
          const distractor = makeDistractorReadFile();
          // Order matters for some models — put the distractor first so
          // we aren't just seeing a list-order bias.
          const tools: ToolExecutor[] = [distractor, readTool];

          const seq: string[] = [];
          const onTrace = (e: AgentTraceEvent) => {
            if (e.kind === "tool_call") seq.push(e.name);
          };

          const baseOpts = {
            backend: BACKEND,
            model: MODEL,
            tools,
            systemPrompt: SYSTEM_PROMPT,
            userPrompt: `Show me the contents of ${target}.`,
            maxTurns: 4,
            onTrace,
          };
          const opts =
            BACKEND === "ollama"
              ? { ...baseOpts, baseUrl: OLLAMA_BASE_URL }
              : baseOpts;

          const res = await runE2E(opts);
          const readCount = seq.filter((n) => n === "read").length;
          const distractorCount = seq.filter((n) => n === "read_file").length;
          const picked: "read" | "read_file" | "none" | "both" =
            readCount > 0 && distractorCount === 0
              ? "read"
              : distractorCount > 0 && readCount === 0
                ? "read_file"
                : readCount > 0 && distractorCount > 0
                  ? "both"
                  : "none";

          // "Success" = picked the well-described tool AND nothing else.
          return {
            ok: picked === "read",
            detail: {
              attempt,
              picked,
              seq,
              turns: res.turns,
            },
          };
        },
        stopEarly: false,
      });

      // eslint-disable-next-line no-console
      console.log(
        `[distractor-summary ${LABEL}]`,
        JSON.stringify(
          {
            successes: summary.successes,
            failures: summary.failures,
            details: summary.details,
          },
          null,
          2,
        ),
      );

      // Hard bar: at least K=3 of 5 attempts picked `read`.
      expect(summary.passed).toBe(true);
    },
    600_000,
  );
});
