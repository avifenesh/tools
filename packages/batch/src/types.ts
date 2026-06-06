export type BatchTargetSubdirs = {
  kind: "subdirs";
  path: string;
  name_filter?: string;
};

export type BatchTargetGlob = {
  kind: "glob";
  pattern: string;
};

export type BatchTargetExplicit = {
  kind: "explicit";
  paths: string[];
};

export type BatchTarget = BatchTargetSubdirs | BatchTargetGlob | BatchTargetExplicit;

export type BatchMode = "sequential" | "parallel";

export interface BatchParams {
  command: string;
  targets: BatchTarget;
  mode?: BatchMode;
  max_concurrent?: number;
  timeout_secs?: number;
  fail_fast?: boolean;
  summary_only?: boolean;
}

export type BatchStatus =
  | "success"
  | "failed"
  | "timed_out"
  | "skipped";

export interface TargetResult {
  path: string;
  status: BatchStatus;
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  duration_ms?: number;
}

export interface BatchSummary {
  total: number;
  success: number;
  failed: number;
  timed_out: number;
}
