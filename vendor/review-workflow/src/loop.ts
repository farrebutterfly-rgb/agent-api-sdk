import type { z } from "zod";
import type { Budget } from "./budget.ts";
import type { RunLog } from "./log.ts";
import type { ToolRegistry, ToolSpec } from "./registry.ts";
import type { Message, ModelClient } from "./model/types.ts";

export interface FinalTool<T> {
  spec: ToolSpec;
  schema: z.ZodType<T>;
  /** Checks a schema-valid final call against the document. Problems send it back to the model. */
  check: (value: T) => string[];
}

export type LoopStatus = "completed" | "budget_exhausted" | "step_limit_exceeded" | "model_error";

export interface LoopResult<T> {
  status: LoopStatus;
  final?: T;
  rejections: number;
}

/**
 * One agent's tool loop. Read tools go through the registry (validation, timeout, error shape).
 * The final tool is validated here: a call that fails its schema or its document check is
 * logged as rejected and returned to the model as an error, inside the same budget.
 */
export async function runToolLoop<T>(opts: {
  role: string;
  model: ModelClient;
  system: string;
  prompt: string;
  registry: ToolRegistry;
  final: FinalTool<T>;
  budget: Budget;
  log: RunLog;
  maxSteps?: number;
  rejectEvent?: string;
}): Promise<LoopResult<T>> {
  const { role, model, registry, final, budget, log } = opts;
  const maxSteps = opts.maxSteps ?? 6;
  const specs = [...registry.specs(), final.spec];
  const transcript: Message[] = [{ role: "user", text: opts.prompt }];
  let rejections = 0;

  for (let step = 1; step <= maxSteps; step++) {
    if (!budget.canCallModel()) {
      log.write({ type: "budget_exhausted", role, step, model_calls: budget.modelCalls });
      return { status: "budget_exhausted", rejections };
    }
    budget.modelCalls++;
    let turn;
    try {
      turn = await model.next(opts.system, transcript, specs);
    } catch (e) {
      log.write({ type: "model_error", role, step, message: (e as Error).message });
      return { status: "model_error", rejections };
    }
    budget.addUsage(turn.usage);
    log.write({ type: "model_turn", role, step, calls: turn.calls.map((c) => c.name), usage: turn.usage });
    transcript.push({ role: "assistant", text: turn.text, calls: turn.calls });

    if (turn.calls.length === 0) {
      transcript.push({ role: "user", text: `Finish by calling ${final.spec.name}.` });
      continue;
    }

    const results: { id: string; content: string; isError: boolean }[] = [];
    for (const c of turn.calls) {
      if (c.name === final.spec.name) {
        const parsed = final.schema.safeParse(c.args);
        const problems = parsed.success ? final.check(parsed.data) : parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
        if (parsed.success && problems.length === 0) {
          log.write({ type: `${role}_final`, step, args: c.args });
          return { status: "completed", final: parsed.data, rejections };
        }
        rejections++;
        log.write({ type: opts.rejectEvent ?? "final_rejected", role, step, args: c.args, problems });
        results.push({ id: c.id, content: JSON.stringify({ code: "REJECTED", tool: final.spec.name, problems }), isError: true });
        continue;
      }
      if (!budget.canCallTool()) {
        log.write({ type: "budget_exhausted", role, step, tool_calls: budget.toolCalls });
        return { status: "budget_exhausted", rejections };
      }
      budget.toolCalls++;
      const r = await registry.execute(c.name, c.args);
      log.write({ type: "tool_call", role, step, call_id: c.id, tool: c.name, args: c.args, ok: r.ok, duration_ms: r.durationMs, ...(r.ok ? {} : { error: r.error }) });
      results.push({ id: c.id, content: JSON.stringify(r.ok ? r.result : r.error), isError: !r.ok });
    }
    transcript.push({ role: "tool", results });
  }
  log.write({ type: "step_limit_exceeded", role, max_steps: maxSteps });
  return { status: "step_limit_exceeded", rejections };
}
