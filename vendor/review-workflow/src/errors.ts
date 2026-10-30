/**
 * One error shape for everything that can go wrong around a tool call.
 * The same object is logged and sent back to the model as a tool_result with is_error.
 */
export type ToolErrorCode =
  | "UNKNOWN_TOOL"
  | "INVALID_ARGUMENTS"
  | "INVALID_RESULT"
  | "TIMEOUT"
  | "UPSTREAM_ERROR"
  | "NOT_FOUND";

export interface ToolError {
  code: ToolErrorCode;
  tool: string;
  message: string;
  /** True when the same call might succeed if repeated (timeouts, 5xx). */
  retryable: boolean;
  /** Field-level problems from schema validation, when there are any. */
  issues?: { path: string; message: string }[];
}

export class ToolFailure extends Error {
  constructor(public readonly error: ToolError) {
    super(`${error.code}: ${error.message}`);
  }
}
