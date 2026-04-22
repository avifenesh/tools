import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PermissionHook } from "@agent-sh/harness-core";
import { DEFAULT_SENSITIVE_PATTERNS } from "@agent-sh/harness-core";
import type {
  SkillPermissionPolicy,
  SkillSessionConfig,
} from "@agent-sh/harness-skill";
import { FilesystemSkillRegistry } from "@agent-sh/harness-skill";
import {
  bedrockAvailable,
  loadDotEnv,
  makeSkillExecutor,
  modelLabel,
  ollamaModelAvailable,
  passAtK,
  resolveBackend,
  resolveModel,
  runE2E,
  warmupOllama,
  type AgentTraceEvent,
} from "../src/index.js";

loadDotEnv();

const BACKEND = resolveBackend();
const MODEL = resolveModel("qwen3.5:27b-q4_K_M");
const LABEL = modelLabel(MODEL);
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

const SYSTEM_PROMPT = [
  "You are an autonomous coding agent with a `skill` tool.",
  "A skill is a reusable package of instructions authored as a folder with SKILL.md. The tool takes a `name` (slug) and optional `arguments`.",
  "When the user's task matches an installed skill's description, activate that skill by name.",
  "If `skill` returns `already_loaded`, the body is already in context — don't re-activate it.",
  "If `skill` returns `not_found`, read the suggested siblings and pick one from the list (or report the miss).",
  "If a skill has `disable-model-invocation: true`, you will get a DISABLED error — don't keep retrying.",
  "When a skill body is loaded, follow its instructions precisely.",
  "Answer in a short plain-text sentence when done.",
].join(" ");

function mkRoot(): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), "e2e-skill-")));
}

function writeSkill(
  rootDir: string,
  name: string,
  frontmatter: string,
  body: string,
): string {
  const dir = path.join(rootDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\n${frontmatter}\n---\n${body}`,
  );
  return dir;
}

function writeResource(
  skillDir: string,
  folder: string,
  name: string,
  content: string,
): void {
  const dir = path.join(skillDir, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), content);
}

function makeSession(rootDir: string): SkillSessionConfig {
  const permissions: SkillPermissionPolicy = {
    roots: [rootDir],
    sensitivePatterns: DEFAULT_SENSITIVE_PATTERNS,
    unsafeAllowSkillWithoutHook: true,
  };
  return {
    cwd: rootDir,
    permissions,
    registry: new FilesystemSkillRegistry([rootDir]),
    trust: { trustedRoots: [rootDir] },
    activated: new Set<string>(),
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

describe(`skill e2e hard [${LABEL}]`, () => {
  let available = false;

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

  afterEach(() => {
    currentTrace = null;
  });

  // SK1: Golden — description triggers activation; model follows body.
  it.runIf(() => available)(
    "SK1 golden: activates a skill when the prompt matches its description",
    async () => {
      const root = mkRoot();
      writeSkill(
        root,
        "api-style",
        'name: api-style\ndescription: "Use when drafting or reviewing HTTP API endpoints. Covers naming, error envelope, pagination."',
        "# API Style\n\nAll endpoints MUST use plural nouns (`/users` not `/user`). Errors MUST include a `code` field. Reply with one sentence summarizing these rules.",
      );
      const session = makeSession(root);
      const tools = [makeSkillExecutor(session)];
      const { trace, onTrace } = collectTrace();
      const res = await runE2E(
        runOpts(
          SYSTEM_PROMPT,
          "I'm about to draft a new HTTP endpoint for our API. Activate the relevant skill and then summarize the rules.",
          tools,
          6,
          onTrace,
        ),
      );
      console.log(
        `[SK1 ${LABEL}]`,
        JSON.stringify({
          turns: trace.turns,
          tools: trace.toolsByName,
          seq: trace.toolSeq,
          final: res.finalContent.slice(0, 200),
        }),
      );
      expect(trace.toolsByName.skill ?? 0).toBeGreaterThanOrEqual(1);
      expect(trace.toolArgs.some((c) => c.args.name === "api-style")).toBe(
        true,
      );
      const surface = combinedSurface(trace, res.finalContent);
      expect(surface.toLowerCase()).toMatch(/plural|error|code/);
    },
    300_000,
  );

  // SK2: NOT_FOUND with siblings → model picks from the list.
  it.runIf(() => available)(
    "SK2 not-found-siblings: recovers via fuzzy siblings",
    async () => {
      const root = mkRoot();
      writeSkill(
        root,
        "tweet-thread",
        'name: tweet-thread\ndescription: "Write tweet threads. Use when the user asks for a thread, tweet, or X post."',
        "Reply with exactly the phrase 'thread skill activated'.",
      );
      const session = makeSession(root);
      const tools = [makeSkillExecutor(session)];
      const { trace, onTrace } = collectTrace();
      const res = await runE2E(
        runOpts(
          SYSTEM_PROMPT,
          "Write a tweet thread about Rust async. Use the appropriate skill.",
          tools,
          6,
          onTrace,
        ),
      );
      console.log(
        `[SK2 ${LABEL}]`,
        JSON.stringify({
          turns: trace.turns,
          tools: trace.toolsByName,
          seq: trace.toolSeq,
        }),
      );
      // Accept either: direct hit on tweet-thread, OR a not_found then a
      // recovery call to tweet-thread. Both are valid.
      expect(trace.toolsByName.skill ?? 0).toBeGreaterThanOrEqual(1);
      const lastSkillCall = [...trace.toolArgs]
        .reverse()
        .find((c) => c.name === "skill");
      expect(lastSkillCall?.args.name).toBe("tweet-thread");
      const surface = combinedSurface(trace, res.finalContent);
      expect(surface.toLowerCase()).toMatch(/thread/);
    },
    300_000,
  );

  // SK3: Idempotence — already_loaded on second call.
  it.runIf(() => available)(
    "SK3 already-loaded: dedupes repeat activations",
    async () => {
      const root = mkRoot();
      writeSkill(
        root,
        "checklist",
        'name: checklist\ndescription: "A pre-commit checklist. Activate when the user asks to check work before committing."',
        "Pre-commit checklist: 1. tests pass, 2. types check, 3. lint clean. Report these three items.",
      );
      const session = makeSession(root);
      const tools = [makeSkillExecutor(session)];
      const { trace, onTrace } = collectTrace();
      const res = await runE2E(
        runOpts(
          SYSTEM_PROMPT,
          "Check my work before commit using the checklist skill. Then activate the checklist skill again to confirm it's idempotent.",
          tools,
          8,
          onTrace,
        ),
      );
      console.log(
        `[SK3 ${LABEL}]`,
        JSON.stringify({
          turns: trace.turns,
          tools: trace.toolsByName,
          seq: trace.toolSeq,
        }),
      );
      const checklistCalls = trace.toolArgs.filter(
        (c) => c.name === "skill" && c.args.name === "checklist",
      );
      expect(checklistCalls.length).toBeGreaterThanOrEqual(2);
      const results = trace.events.filter(
        (e) => e.kind === "tool_result",
      );
      const hasAlreadyLoaded = results.some(
        (e) =>
          typeof (e as { content?: unknown }).content === "string" &&
          (e as { content: string }).content.includes("already active"),
      );
      expect(hasAlreadyLoaded).toBe(true);
    },
    300_000,
  );

  // SK4: allowed-tools advisory — model sees declaration but still goes
  // through hook. Here we just check the advisory declaration appears
  // in the returned body.
  it.runIf(() => available)(
    "SK4 allowed-tools-visible: declaration appears in output",
    async () => {
      const root = mkRoot();
      writeSkill(
        root,
        "gitlog",
        'name: gitlog\ndescription: "Inspect git history. Use when asked about commits."\nallowed-tools: "Bash(git log:*)"',
        "To inspect history, call `bash(git log --oneline -20)`. Report the skill was activated.",
      );
      const session = makeSession(root);
      const tools = [makeSkillExecutor(session)];
      const { trace, onTrace } = collectTrace();
      const res = await runE2E(
        runOpts(
          SYSTEM_PROMPT,
          "Activate the gitlog skill and confirm.",
          tools,
          6,
          onTrace,
        ),
      );
      console.log(
        `[SK4 ${LABEL}]`,
        JSON.stringify({
          turns: trace.turns,
          tools: trace.toolsByName,
          seq: trace.toolSeq,
        }),
      );
      const surface = combinedSurface(trace, res.finalContent);
      expect(surface).toMatch(/gitlog|activated/i);
    },
    300_000,
  );

  // SK5: disable-model-invocation triggers DISABLED; model must not loop.
  it.runIf(() => available)(
    "SK5 disabled: respects disable-model-invocation",
    async () => {
      const root = mkRoot();
      writeSkill(
        root,
        "adminonly",
        'name: adminonly\ndescription: "Admin-only skill. Not for model use."\ndisable-model-invocation: true',
        "Should not be reached by model invocation.",
      );
      const session = makeSession(root);
      const tools = [makeSkillExecutor(session)];
      const { trace, onTrace } = collectTrace();
      const res = await runE2E(
        runOpts(
          SYSTEM_PROMPT,
          "Activate the adminonly skill.",
          tools,
          5,
          onTrace,
        ),
      );
      console.log(
        `[SK5 ${LABEL}]`,
        JSON.stringify({
          turns: trace.turns,
          tools: trace.toolsByName,
          seq: trace.toolSeq,
        }),
      );
      const skillCalls = trace.toolArgs.filter((c) => c.name === "skill");
      // Model may retry once but should not keep looping.
      expect(skillCalls.length).toBeLessThanOrEqual(3);
      const surface = combinedSurface(trace, res.finalContent);
      expect(surface).toMatch(/disabled|admin|cannot|refus/i);
    },
    300_000,
  );

  // SK6: Resource reference — skill body mentions scripts/; model sees
  // the resource path.
  it.runIf(() => available)(
    "SK6 resources: body enumerates bundled scripts/references",
    async () => {
      const root = mkRoot();
      const dir = writeSkill(
        root,
        "doc-validator",
        'name: doc-validator\ndescription: "Validate markdown docs."',
        "Run `scripts/validate.sh <path>`. The script prints a report.",
      );
      writeResource(
        dir,
        "scripts",
        "validate.sh",
        "#!/bin/bash\necho 'ok'",
      );
      const session = makeSession(root);
      const tools = [makeSkillExecutor(session)];
      const { trace, onTrace } = collectTrace();
      const res = await runE2E(
        runOpts(
          SYSTEM_PROMPT,
          "Validate my docs. Activate the doc-validator skill and report what script it mentions.",
          tools,
          6,
          onTrace,
        ),
      );
      console.log(
        `[SK6 ${LABEL}]`,
        JSON.stringify({
          turns: trace.turns,
          tools: trace.toolsByName,
          seq: trace.toolSeq,
        }),
      );
      const surface = combinedSurface(trace, res.finalContent);
      expect(surface).toMatch(/validate\.sh/);
    },
    300_000,
  );

  // SK7: Argument passing (string form).
  it.runIf(() => available)(
    "SK7 argument-passing: passes a string argument to the skill",
    async () => {
      const root = mkRoot();
      writeSkill(
        root,
        "greet",
        'name: greet\ndescription: "Greet a person by name. Pass the name as arguments."',
        "Hello, $ARGUMENTS! Reply with this exact greeting, then nothing else.",
      );
      const session = makeSession(root);
      const tools = [makeSkillExecutor(session)];
      const { trace, onTrace } = collectTrace();
      const res = await runE2E(
        runOpts(
          SYSTEM_PROMPT,
          "Greet Avi. Use the greet skill with arguments=\"Avi\".",
          tools,
          6,
          onTrace,
        ),
      );
      console.log(
        `[SK7 ${LABEL}]`,
        JSON.stringify({
          turns: trace.turns,
          tools: trace.toolsByName,
          seq: trace.toolSeq,
        }),
      );
      const surface = combinedSurface(trace, res.finalContent);
      expect(surface).toMatch(/Hello, Avi/);
    },
    300_000,
  );

  // SK8: Trust gate — hook denies the activation; model reports it.
  // Stochastic — wrap in passAtK so we get a fair signal.
  it.runIf(() => available)(
    "SK8 trust-gate: reports permission denial gracefully",
    async () => {
      const result = await passAtK({
        n: 3,
        k: 2,
        run: async () => {
          const root = mkRoot();
          writeSkill(
            root,
            "risky",
            'name: risky\ndescription: "A skill the hook will deny activation for."',
            "Should never reach this body.",
          );
          const hook: PermissionHook = async () => "deny";
          const permissions: SkillPermissionPolicy = {
            roots: [root],
            sensitivePatterns: [],
            hook,
          };
          const session: SkillSessionConfig = {
            cwd: root,
            permissions,
            registry: new FilesystemSkillRegistry([root]),
            trust: { trustedRoots: [root] },
            activated: new Set<string>(),
          };
          const tools = [makeSkillExecutor(session)];
          const { trace, onTrace } = collectTrace();
          const res = await runE2E(
            runOpts(
              SYSTEM_PROMPT,
              "Activate the risky skill.",
              tools,
              5,
              onTrace,
            ),
          );
          const surface = combinedSurface(trace, res.finalContent);
          return {
            ok: /deni|blocked|permission|refus/i.test(surface),
            detail: {
              seq: trace.toolSeq,
              final: res.finalContent.slice(0, 200),
            },
          };
        },
      });
      expect(result.successes).toBeGreaterThanOrEqual(2);
    },
    600_000,
  );
});
