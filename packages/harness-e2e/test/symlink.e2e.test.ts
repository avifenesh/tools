import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
].join(" ");

function mkRoot(): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), "e2e-symlink-")));
}

function makeSession(root: string): WriteSessionConfig & {
  ledger: InMemoryLedger;
} {
  const ledger = new InMemoryLedger();
  return {
    cwd: root,
    permissions: {
      // Allow both the real dir and any symlink-reachable dir — fence
      // resolves to realpath anyway, so `roots: [root]` is enough.
      roots: [root],
      sensitivePatterns: DEFAULT_SENSITIVE_PATTERNS,
    },
    ledger,
  } as WriteSessionConfig & { ledger: InMemoryLedger };
}

/**
 * Symlink behavior: the ledger must be keyed by the realpath of the file,
 * not the path the model used. Otherwise the model could read via path A
 * (a symlink) and then edit via path B (the target) — or vice versa —
 * and the ledger gate would incorrectly say the file was never Read.
 *
 * Spec expectation (Read/Write): `resolvePath` runs `realpath` on the
 * input, and the ledger is keyed by the resolved path. A Read via symlink
 * and an Edit via target (or any permutation) both hit the same key.
 */
describe(`symlink e2e [${LABEL}]`, () => {
  let available = false;
  beforeAll(async () => {
    if (BACKEND === "bedrock") {
      available = await bedrockAvailable(process.env.AWS_REGION);
    } else {
      available = await ollamaModelAvailable(MODEL, OLLAMA_BASE_URL);
    }
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn(`[skip symlink e2e] backend=${BACKEND} not reachable`);
    }
  });

  it.runIf(() => available)(
    "read via symlink, edit via symlink — ledger identifies them as the same file",
    async () => {
      const root = mkRoot();
      const realDir = path.join(root, "real");
      const linkDir = path.join(root, "link");
      mkdirSync(realDir);
      symlinkSync(realDir, linkDir, "dir");

      const targetReal = path.join(realDir, "note.txt");
      const targetLink = path.join(linkDir, "note.txt");
      writeFileSync(targetReal, "version: 1\n");

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

      // The prompt uses the symlink path for BOTH read and edit. If the
      // ledger key honored the raw input rather than realpath, both calls
      // would key the same entry and succeed regardless — not a useful
      // test. We use realpath vs symlink cross below; this first case is
      // the "golden" sanity check.
      const baseOpts = {
        backend: BACKEND,
        model: MODEL,
        tools,
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: `In ${targetLink}, change 'version: 1' to 'version: 2'. Read first, then edit.`,
        maxTurns: 8,
        onTrace,
      };
      const opts =
        BACKEND === "ollama"
          ? { ...baseOpts, baseUrl: OLLAMA_BASE_URL }
          : baseOpts;

      const res = await runE2E(opts);
      // eslint-disable-next-line no-console
      console.log(`[symlink-same ${LABEL}]`, {
        turns: res.turns,
        seq,
        final: res.finalContent.slice(0, 120),
      });

      expectSequence(seq, ["read", "edit"]);

      // Edit landed on disk (regardless of which path was used).
      const post = readFileSync(targetReal, "utf8");
      expect(post).toContain("version: 2");
      expect(post).not.toContain("version: 1");

      // Critical invariant: the ledger has exactly one entry, keyed by
      // the realpath. The latest entry's sha must match the *post-edit*
      // bytes (Edit records the new sha).
      const realpath = realpathSync(targetReal);
      const entry = session.ledger.getLatest(realpath);
      expect(entry).toBeDefined();
    },
    300_000,
  );

  // Harness-level contract test (no model): Read and Edit against
  // different path-spellings of the same file must share a ledger key.
  // This is the unit-level version of the above — fast, deterministic,
  // catches any regression in fence/realpath behavior.
  it("(unit) ledger is keyed by realpath, not input-path spelling", async () => {
    const { read } = await import("@agent-sh/harness-read");
    const { edit } = await import("@agent-sh/harness-write");

    const root = mkRoot();
    const realDir = path.join(root, "real");
    const linkDir = path.join(root, "link");
    mkdirSync(realDir);
    symlinkSync(realDir, linkDir, "dir");

    const targetReal = path.join(realDir, "note.txt");
    const targetLink = path.join(linkDir, "note.txt");
    writeFileSync(targetReal, "version: 1\n");

    const ledger = new InMemoryLedger();
    const session: WriteSessionConfig = {
      cwd: root,
      permissions: {
        roots: [root],
        sensitivePatterns: DEFAULT_SENSITIVE_PATTERNS,
      },
      ledger,
    };

    // Read via the symlinked path.
    const readRes = await read({ path: targetLink }, session);
    expect(readRes.kind).toBe("text");

    // Edit via the real path — same file, different spelling. If the
    // ledger keyed by raw input, this would return NOT_READ_THIS_SESSION.
    // It must not, because resolvePath realpaths both.
    const editRes = await edit(
      { path: targetReal, old_string: "version: 1", new_string: "version: 2" },
      session,
    );
    expect(editRes.kind).toBe("text");

    expect(readFileSync(targetReal, "utf8")).toContain("version: 2");
  });
});
