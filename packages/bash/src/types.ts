import type {
  PermissionPolicy,
  ToolError,
} from "@agent-sh/harness-core";

export interface BashParams {
  readonly command: string;
  readonly cwd?: string;
  readonly timeout_ms?: number;
  readonly description?: string;
  readonly background?: boolean;
  readonly env?: Readonly<Record<string, string>>;
}

export interface BashOutputParams {
  readonly job_id: string;
  readonly since_byte?: number;
  readonly head_limit?: number;
}

export interface BashKillParams {
  readonly job_id: string;
  readonly signal?: "SIGTERM" | "SIGKILL";
}

/**
 * Executor interface — the pluggable boundary between core (which ships a
 * local subprocess runner) and adapter packages (bash-docker, bash-firejail,
 * bash-e2b). Core NEVER imports an adapter; adapters are peer deps of the
 * harness that chooses one.
 */
export interface BashRunResult {
  readonly exitCode: number | null;
  readonly killed: boolean;
  readonly signal: string | null;
}

export interface BashRunInput {
  readonly command: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly onStdout: (chunk: Uint8Array) => void;
  readonly onStderr: (chunk: Uint8Array) => void;
}

export interface BackgroundReadResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly running: boolean;
  readonly exitCode: number | null;
  readonly totalBytesStdout: number;
  readonly totalBytesStderr: number;
}

export interface BashExecutor {
  run(input: BashRunInput): Promise<BashRunResult>;

  spawnBackground?(input: {
    command: string;
    cwd: string;
    env: Readonly<Record<string, string>>;
  }): Promise<{ jobId: string }>;

  readBackground?(
    jobId: string,
    opts: { since_byte?: number; head_limit?: number },
  ): Promise<BackgroundReadResult>;

  killBackground?(
    jobId: string,
    signal?: "SIGTERM" | "SIGKILL",
  ): Promise<void>;

  closeSession?(): Promise<void>;
}

/**
 * Session-bound permission policy. Same shape as read/grep/glob sessions,
 * with an opt-in escape hatch for unsandboxed test fixtures only.
 */
export interface BashPermissionPolicy extends PermissionPolicy {
  readonly unsafeAllowBashWithoutHook?: boolean;
}

export interface BashSessionConfig {
  readonly cwd: string;
  readonly permissions: BashPermissionPolicy;
  readonly env?: Readonly<Record<string, string>>;
  readonly executor?: BashExecutor;
  readonly defaultInactivityTimeoutMs?: number;
  readonly wallclockBackstopMs?: number;
  readonly maxCommandLength?: number;
  readonly maxOutputBytesInline?: number;
  readonly maxOutputBytesFile?: number;
  readonly maxBackgroundJobs?: number;
  readonly signal?: AbortSignal;
  /**
   * Working directory the tool tracks across calls. When the model issues
   * a top-level `cd <path>` that lands inside the workspace, we mutate this
   * in place. Optional — if omitted, cwd-carry is disabled and every call
   * runs at `session.cwd`.
   */
  logicalCwd?: { value: string };
}

export type BashOk = {
  readonly kind: "ok";
  readonly output: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly logPath?: string;
  readonly byteCap: boolean;
};

export type BashNonzeroExit = {
  readonly kind: "nonzero_exit";
  readonly output: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly logPath?: string;
  readonly byteCap: boolean;
};

export type BashTimeout = {
  readonly kind: "timeout";
  readonly output: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly reason: "inactivity timeout" | "wall-clock backstop";
  readonly durationMs: number;
  readonly logPath?: string;
};

export type BashBackgroundStarted = {
  readonly kind: "background_started";
  readonly output: string;
  readonly jobId: string;
};

export type BashError = {
  readonly kind: "error";
  readonly error: ToolError;
};

export type BashResult =
  | BashOk
  | BashNonzeroExit
  | BashTimeout
  | BashBackgroundStarted
  | BashError;

export type BashOutputResult =
  | {
      readonly kind: "output";
      readonly output: string;
      readonly running: boolean;
      readonly exitCode: number | null;
      readonly stdout: string;
      readonly stderr: string;
      readonly totalBytesStdout: number;
      readonly totalBytesStderr: number;
      readonly nextSinceByte: number;
    }
  | BashError;

export type BashKillResult =
  | {
      readonly kind: "killed";
      readonly output: string;
      readonly jobId: string;
      readonly signal: "SIGTERM" | "SIGKILL";
    }
  | BashError;
