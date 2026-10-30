import { isDeepStrictEqual } from "node:util";
import { Budget, DEFAULT_BUDGET, type BudgetLimits } from "./budget.ts";
import { extractionFinal, fieldFinal, planFinal } from "./agents/finals.ts";
import { PLANNER_SYSTEM, SINGLE_SYSTEM, WORKER_SYSTEM } from "./agents/prompts.ts";
import { runToolLoop } from "./loop.ts";
import type { RunLog } from "./log.ts";
import type { ModelClient } from "./model/types.ts";
import { ToolRegistry } from "./registry.ts";
import { FIELD_NAMES, HandoffSchema, nullField, type ExtractionResult, type FieldName, type Fields, type Finding, type Handoff, type Plan, type Task } from "./schema.ts";
import { makeReadTools } from "./tools/readTools.ts";
import { asFindings, runValidator, type Check } from "./validator.ts";

export interface Models {
  planner: (docId: string) => ModelClient;
  worker: (h: Handoff) => ModelClient;
  single: (docId: string) => ModelClient;
}

export interface PipelineOptions {
  models: Models;
  log: RunLog;
  budget?: BudgetLimits;
  tolerance?: number;
}

const allNull = (reason: string) => Object.fromEntries(FIELD_NAMES.map((f) => [f, nullField(reason)])) as Fields;
const docInfo = (text: string) => `${text.length} characters, ${text.replace(/\n$/, "").split("\n").length} lines`;
const CHECK_FOR_TASK: Record<Exclude<Task["type"], "extract_field">, Check> = { check_totals: "totals", check_dates: "dates", flag_missing: "missing" };

/**
 * Gate for planner-to-worker handoffs. The orchestrator builds handoffs from an accepted plan,
 * so in normal runs this never fires; it exists so a corrupted or injected handoff (wrong
 * document, task not in the plan, field outside the schema) is stopped and logged, not executed.
 */
export function checkHandoff(raw: unknown, plan: Plan, docId: string): { handoff?: Handoff; problems: string[] } {
  const parsed = HandoffSchema.safeParse(raw);
  if (!parsed.success) return { problems: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  const h = parsed.data;
  const problems: string[] = [];
  if (h.doc_id !== docId) problems.push(`handoff is for ${h.doc_id}, run is for ${docId}`);
  const planned = plan.tasks[h.task_index];
  if (!planned || !isDeepStrictEqual(planned, h.task)) problems.push(`task ${h.task_index} in the handoff is not the task in the accepted plan`);
  return problems.length ? { problems } : { handoff: h, problems };
}

function finish(base: { docId: string; architecture: ExtractionResult["architecture"]; model: string; log: RunLog; budget: Budget }, fields: Fields, findings: Finding[], status: ExtractionResult["status"], rejections: ExtractionResult["rejections"]): ExtractionResult {
  const r: ExtractionResult = {
    doc_id: base.docId,
    mode: base.model.includes("fixture:") ? "fixture" : "live",
    architecture: base.architecture,
    model: base.model,
    fields,
    findings,
    calls: base.budget.modelCalls,
    tool_calls: base.budget.toolCalls,
    usage: base.budget.usage(),
    cost_usd: base.budget.costUsd(),
    rejections,
    status,
    run_id: base.log.runId,
  };
  base.log.write({ type: "run_end", architecture: r.architecture, doc_id: r.doc_id, status, calls: r.calls, tool_calls: r.tool_calls, rejections, findings: findings.map((f) => f.code) });
  return r;
}

export async function runTwoAgent(docId: string, text: string, opts: PipelineOptions): Promise<ExtractionResult> {
  const { log } = opts;
  const budget = new Budget(opts.budget ?? DEFAULT_BUDGET);
  const workerTools = new ToolRegistry(makeReadTools(new Map([[docId, text]])));
  const planner = opts.models.planner(docId);
  const rejections = { plans: 0, handoffs: 0, finals: 0 };
  const workerIds = new Set<string>();
  log.write({ type: "run_start", architecture: "two-agent", doc_id: docId, planner: planner.id, budget: budget.limits });

  const p = await runToolLoop({
    role: "planner",
    model: planner,
    system: PLANNER_SYSTEM,
    prompt: `Document ${docId} (${docInfo(text)}). Plan the extraction and checks.`,
    registry: new ToolRegistry([]),
    final: planFinal(docId),
    budget,
    log,
    maxSteps: 3,
    rejectEvent: "plan_rejected",
  });
  rejections.plans = p.rejections;
  const base = () => ({ docId, architecture: "two-agent" as const, model: [planner.id, ...workerIds].join(" + "), log, budget });
  if (!p.final) {
    const why = p.status === "completed" ? "no valid plan" : `planner ${p.status}`;
    const status = p.status === "budget_exhausted" ? "budget_exhausted" : p.status === "model_error" ? "model_error" : "plan_rejected";
    return finish(base(), allNull(`not extracted: ${why}`), [{ code: "NO_VALID_PLAN", severity: "error", message: why, source: "orchestrator" }], status, rejections);
  }
  const plan = p.final;
  log.write({ type: "plan_accepted", tasks: plan.tasks });

  const fields = allNull("not extracted: the plan did not include this field");
  const findings: Finding[] = [];
  let budgetHit = false;

  for (const [i, task] of plan.tasks.entries()) {
    const raw = { handoff_id: `${log.runId}-h${i}`, task_index: i, doc_id: docId, task };
    const hc = checkHandoff(raw, plan, docId);
    if (!hc.handoff) {
      rejections.handoffs++;
      log.write({ type: "handoff_rejected", direction: "planner->worker", handoff: raw, problems: hc.problems });
      continue;
    }
    const h = hc.handoff;

    if (task.type !== "extract_field") {
      const v = await runValidator({ fields, checks: [CHECK_FOR_TASK[task.type]], tolerance: opts.tolerance });
      findings.push(...asFindings(v));
      log.write({ type: "check_task", handoff_id: h.handoff_id, task, findings: v.findings.map((f) => f.code) });
      continue;
    }

    const field: FieldName = task.field;
    if (!budget.canCallModel()) {
      budgetHit = true;
      fields[field] = nullField("not extracted: budget exhausted before this task");
      log.write({ type: "handoff_skipped", handoff_id: h.handoff_id, field, reason: "budget_exhausted" });
      continue;
    }
    log.write({ type: "handoff", direction: "planner->worker", handoff: h });
    const worker = opts.models.worker(h);
    workerIds.add(worker.id);
    const w = await runToolLoop({
      role: "worker",
      model: worker,
      system: WORKER_SYSTEM,
      prompt: `Handoff: ${JSON.stringify(h)}`,
      registry: workerTools,
      final: fieldFinal(h, text),
      budget,
      log,
      maxSteps: 4,
      rejectEvent: "handoff_rejected",
    });
    rejections.handoffs += w.rejections;
    if (w.final) {
      const { field: _f, ...result } = w.final;
      fields[field] = result;
      log.write({ type: "handoff_accepted", direction: "worker->planner", handoff_id: h.handoff_id, field, value: result.value, quote: result.quote, reason: result.reason });
    } else {
      if (w.status === "budget_exhausted") budgetHit = true;
      fields[field] = nullField(`not extracted: worker ${w.status}`);
      log.write({ type: "handoff_failed", handoff_id: h.handoff_id, field, status: w.status });
    }
  }

  const v = await runValidator({ fields, doc_text: text, checks: ["types", "quotes"], tolerance: opts.tolerance });
  findings.push(...asFindings(v));
  if (budgetHit) findings.push({ code: "BUDGET_EXHAUSTED", severity: "error", message: `model call budget of ${budget.limits.maxModelCalls} used up; remaining fields left null`, source: "orchestrator" });
  return finish(base(), fields, findings, budgetHit ? "budget_exhausted" : "completed", rejections);
}

export async function runSingleAgent(docId: string, text: string, opts: PipelineOptions): Promise<ExtractionResult> {
  const { log } = opts;
  const budget = new Budget(opts.budget ?? DEFAULT_BUDGET);
  const model = opts.models.single(docId);
  log.write({ type: "run_start", architecture: "single-agent", doc_id: docId, model: model.id, budget: budget.limits });
  const s = await runToolLoop({
    role: "single",
    model,
    system: SINGLE_SYSTEM,
    prompt: `Document ${docId} (${docInfo(text)}). Extract every field.`,
    registry: new ToolRegistry(makeReadTools(new Map([[docId, text]]))),
    final: extractionFinal(text),
    budget,
    log,
    maxSteps: 6,
  });
  const fields = s.final ? (s.final.fields as Fields) : allNull(`not extracted: ${s.status}`);
  const v = await runValidator({ fields, doc_text: text, tolerance: opts.tolerance });
  const findings = asFindings(v);
  if (s.status === "budget_exhausted") findings.push({ code: "BUDGET_EXHAUSTED", severity: "error", message: `model call budget of ${budget.limits.maxModelCalls} used up`, source: "orchestrator" });
  const status = s.status;
  return finish({ docId, architecture: "single-agent", model: model.id, log, budget }, fields, findings, status, { plans: 0, handoffs: 0, finals: s.rejections });
}
