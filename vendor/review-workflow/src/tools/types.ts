import type { z } from "zod";

export interface ToolContext {
  /** Aborted when the per-call timeout fires. Tools must pass it to any I/O. */
  signal: AbortSignal;
}

export interface ToolDefinition<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: I;
  output: O;
  run(args: z.infer<I>, ctx: ToolContext): Promise<z.infer<O>>;
}

export function defineTool<I extends z.ZodType, O extends z.ZodType>(t: ToolDefinition<I, O>): ToolDefinition<I, O> {
  return t;
}
