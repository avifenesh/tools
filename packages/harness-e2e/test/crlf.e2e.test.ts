import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
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
  makeReadExecutor,
  modelLabel,
  ollamaModelAvailable,
  resolveBackend,
  resolveModel,
  runE2E,
  type AgentTraceEvent,
} from "../src/index.js";

loadDotEnv();

const BACKEND = resolveBackend();
const MODEL = resolveModel("qwen3.5:27b-q4_K_M");
const LABEL = modelLabel(MODEL);
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

const SYSTEM_PROMPT = [
  "You are a coding agent with `read` and `edit` tools.",
  "You MUST call `read` on any existing file before you `edit` it.",
  "If edit returns NOT_READ_THIS_SESSION, call read first and retry.",
  "If old_string is not found, use the fuzzy candidates in the error to correct it.",
].join(" ");

function mkRoot(): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), "e2e-crlf-")));
}

function makeSession(root: string): WriteSessionConfig & {
  ledger: InMemoryLedger;
} {
  const ledger = new InMemoryLedger();
  return {
    cwd: root,
    permissions: {
      roots: [root],
      sensitivePatterns: DEFAULT_SENSITIVE_PATTERNS,
    },
    ledger,
  } as WriteSessionConfig & { ledger: InMemoryLedger };
}

describe(`CRLF e2e [${LABEL}]`, () => {
  let available = false;
  beforeAll(async () => {
    if (BACKEND === "bedrock") {
      available = await bedrockAvailable(process.env.AWS_REGION);
    } else {
      available = await ollamaModelAvailable(MODEL, OLLAMA_BASE_URL);
    }
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn(`[skip CRLF e2e] backend=${BACKEND} not reachable`);
    }
  });

  // CRLF fixture. Real-world scenario: a file authored on Windows lands in
  // the tree and the model has to edit a line. The engine normalizes CRLF
  // to LF on both sides (per spec §5.1). We assert:
  //   1. The model successfully edits despite CRLF line endings.
  //   2. The edit applied correctly at the targeted line.
  //   3. Post-edit the file has no stray CR bytes (\r), because the spec
  //      normalizes to LF. If the engine ever regresses and leaves mixed
  //      endings, this test catches it.
  it.runIf(() => available)(
    "edits a CRLF file; output is LF-terminated and content is correct",
    async () => {
      const root = mkRoot();
      const target = path.join(root, "win.txt");
      // Explicit CRLF — note raw \r\n in the on-disk bytes.
      const original = "alpha\r\nbravo\r\ncharlie\r\ndelta\r\n";
      writeFileSync(target, original, "utf8");

      // Sanity: the fixture actually has CR bytes.
      expect(readFileSync(target).includes(0x0d)).toBe(true);

      const session = makeSession(root);
      const tools = [
        makeReadExecutor({
          cwd: root,
          permissions: session.permissions,
          ledger: session.ledger,
        }),
        makeEditExecutor(session),
      ];

      const seq: string[] = [];
      const onTrace = (e: AgentTraceEvent) => {
        if (e.kind === "tool_call") seq.push(e.name);
      };

      const baseOpts = {
        backend: BACKEND,
        model: MODEL,
        tools,
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: `In ${target}, change 'bravo' to 'BRAVO'. Read first, then edit.`,
        maxTurns: 8,
        onTrace,
      };
      const opts =
        BACKEND === "ollama"
          ? { ...baseOpts, baseUrl: OLLAMA_BASE_URL }
          : baseOpts;

      const res = await runE2E(opts);
      // eslint-disable-next-line no-console
      console.log(`[crlf ${LABEL}]`, {
        turns: res.turns,
        seq,
        final: res.finalContent.slice(0, 120),
      });

      expectSequence(seq, ["read", "edit"]);

      const postBytes = readFileSync(target);
      const post = postBytes.toString("utf8");
      // Correctness: the edit landed.
      expect(post).toContain("BRAVO");
      expect(post).not.toContain("bravo");
      // Engine contract §5.1: no stray CR bytes after edit.
      expect(postBytes.includes(0x0d)).toBe(false);
      // Other lines are intact.
      expect(post.split("\n")).toEqual(["alpha", "BRAVO", "charlie", "delta", ""]);
    },
    300_000,
  );
});
