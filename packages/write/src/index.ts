export { write } from "./write.js";
export { edit } from "./edit.js";
export { multiEdit } from "./multiedit.js";

export {
  writeToolDefinition,
  editToolDefinition,
  multieditToolDefinition,
  WRITE_TOOL_NAME,
  EDIT_TOOL_NAME,
  MULTIEDIT_TOOL_NAME,
  WRITE_TOOL_DESCRIPTION,
  EDIT_TOOL_DESCRIPTION,
  MULTIEDIT_TOOL_DESCRIPTION,
  WriteParamsSchema,
  EditParamsSchema,
  MultiEditParamsSchema,
  safeParseWriteParams,
  safeParseEditParams,
  safeParseMultiEditParams,
} from "./schema.js";

export { applyEdit, applyPipeline } from "./engine.js";
export { unifiedDiff } from "./diff.js";
export { normalizeLineEndings } from "./normalize.js";
export { levenshtein, similarity } from "./levenshtein.js";
export {
  findAllOccurrences,
  findFuzzyCandidates,
  buildMatchLocations,
  substringBoundaryCollisions,
} from "./matching.js";

export {
  DEFAULT_FUZZY_TOP_K,
  DEFAULT_FUZZY_THRESHOLD,
  DEFAULT_FUZZY_LENGTH_TOLERANCE,
  CONTEXT_LINES,
  MAX_EDIT_FILE_SIZE,
  BINARY_SAMPLE_BYTES,
} from "./constants.js";

export type {
  EditSpec,
  WriteParams,
  EditParams,
  MultiEditParams,
  ValidateContext,
  ValidateError,
  ValidateHook,
  WriteSessionConfig,
  FuzzyCandidate,
  MatchLocation,
  WriteMeta,
  EditMeta,
  MultiEditMeta,
  PreviewMeta,
  TextWriteResult,
  PreviewResult,
  ErrorResult,
  WriteResult,
  EditResult,
  MultiEditResult,
} from "./types.js";
