export type CompilationErrorCode =
  | 'SCHEMA_INVALID'
  | 'DUPLICATE_NODE_ID'
  | 'UNKNOWN_NODE_TYPE'
  | 'DANGLING_EDGE'
  | 'SELF_LOOP'
  | 'PORT_MISMATCH'
  | 'ISOLATED_NODE'
  | 'CYCLE_DETECTED';

export interface CompilationError {
  code: CompilationErrorCode;
  path: string;
  message: string;
  details?: Record<string, unknown>;
}

export const makeError = (
  code: CompilationErrorCode,
  path: string,
  message: string,
  details?: Record<string, unknown>,
): CompilationError => ({ code, path, message, details });
