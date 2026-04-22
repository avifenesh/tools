import { Buffer } from "node:buffer";
import type { ReadOperations } from "@agent-sh/harness-core";
import {
  MAX_BYTES,
  MAX_LINE_LENGTH,
  MAX_LINE_SUFFIX,
} from "./constants.js";

export interface StreamLinesOptions {
  readonly offset: number;
  readonly limit: number;
  readonly maxBytes?: number;
  readonly maxLineLength?: number;
  readonly signal?: AbortSignal;
}

export interface StreamLinesResult {
  readonly lines: readonly string[];
  readonly totalLines: number;
  readonly offset: number;
  readonly more: boolean;
  readonly byteCap: boolean;
}

export async function streamLines(
  ops: ReadOperations,
  path: string,
  opts: StreamLinesOptions,
): Promise<StreamLinesResult> {
  const maxBytes = opts.maxBytes ?? MAX_BYTES;
  const maxLineLen = opts.maxLineLength ?? MAX_LINE_LENGTH;
  const start = opts.offset - 1;

  const out: string[] = [];
  let bytes = 0;
  let totalLines = 0;
  let more = false;
  let byteCap = false;

  const signalOpt: { signal?: AbortSignal } = {};
  if (opts.signal !== undefined) signalOpt.signal = opts.signal;

  const iter = ops.openLineStream(path, signalOpt);

  for await (const raw of iter) {
    totalLines += 1;
    if (totalLines <= start) continue;

    if (out.length >= opts.limit) {
      more = true;
      continue;
    }

    const truncated =
      raw.length > maxLineLen ? raw.substring(0, maxLineLen) + MAX_LINE_SUFFIX : raw;

    const size = Buffer.byteLength(truncated, "utf8") + (out.length > 0 ? 1 : 0);
    if (bytes + size > maxBytes) {
      byteCap = true;
      more = true;
      break;
    }

    out.push(truncated);
    bytes += size;
  }

  return {
    lines: out,
    totalLines,
    offset: opts.offset,
    more,
    byteCap,
  };
}
