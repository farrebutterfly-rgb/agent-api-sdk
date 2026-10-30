import { z } from "zod";

/**
 * The labelled field schema. Every extraction, every gold record and every review draft
 * uses exactly these nine fields. Values are normalised: dates as YYYY-MM-DD, amounts as
 * numbers in the invoice currency, currency as an ISO 4217 code.
 */
export const FIELD_NAMES = ["supplier", "invoice_number", "invoice_date", "due_date", "currency", "net", "vat", "total", "org_number"] as const;
export type FieldName = (typeof FIELD_NAMES)[number];
export const FieldNameSchema = z.enum(FIELD_NAMES);

export const AMOUNT_FIELDS: readonly FieldName[] = ["net", "vat", "total"];
export const DATE_FIELDS: readonly FieldName[] = ["invoice_date", "due_date"];
/** Fields whose normalised value must appear character for character inside the quote. */
export const VERBATIM_FIELDS: readonly FieldName[] = ["invoice_number", "org_number"];

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD").refine((s) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}, "not a calendar date");

export const VALUE_SCHEMAS: Record<FieldName, z.ZodType> = {
  supplier: z.string().min(1),
  invoice_number: z.string().min(1),
  invoice_date: isoDate,
  due_date: isoDate,
  currency: z.string().regex(/^[A-Z]{3}$/, "currency must be an ISO 4217 code like SEK"),
  net: z.number().finite(),
  vat: z.number().finite(),
  total: z.number().finite(),
  org_number: z.string().regex(/^\d{6}-\d{4}$/, "org_number must look like 556123-4567"),
};

/** One field as the worker or baseline proposes it. */
export const FieldResultSchema = z
  .object({
    value: z.union([z.string(), z.number(), z.null()]),
    quote: z.string().nullable(),
    confidence: z.number().min(0).max(1).optional(),
    reason: z.string().min(3).optional().describe("Required when value is null: why the value is missing or ambiguous."),
  })
  .strict();
export type FieldResult = z.infer<typeof FieldResultSchema>;

export type Fields = Record<FieldName, FieldResult>;

/**
 * Checks one field against the document. Returns a list of problems; empty means accepted.
 * This is the gate that keeps guesses out: a value needs an exact quote, a missing value
 * needs a reason and no quote.
 */
export function checkField(name: FieldName, r: FieldResult, docText: string): string[] {
  const p: string[] = [];
  if (r.value === null) {
    if (!r.reason) p.push(`${name}: value is null, so a reason is required`);
    if (r.quote !== null) p.push(`${name}: value is null, so quote must be null too`);
    return p;
  }
  const typed = VALUE_SCHEMAS[name].safeParse(r.value);
  if (!typed.success) p.push(`${name}: ${typed.error.issues.map((i) => i.message).join("; ")}`);
  if (r.quote === null || r.quote.trim() === "") p.push(`${name}: a value needs a source quote`);
  else if (!docText.includes(r.quote)) p.push(`${name}: quote ${JSON.stringify(r.quote)} is not an exact substring of the document`);
  else if (VERBATIM_FIELDS.includes(name) && typeof r.value === "string" && !r.quote.includes(r.value)) {
    p.push(`${name}: value ${JSON.stringify(r.value)} does not appear in its quote`);
  }
  return p;
}

// ---------------------------------------------------------------- planner and handoffs

export const TaskSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("extract_field"), field: FieldNameSchema }).strict(),
  z.object({ type: z.literal("check_totals") }).strict(),
  z.object({ type: z.literal("check_dates") }).strict(),
  z.object({ type: z.literal("flag_missing") }).strict(),
]);
export type Task = z.infer<typeof TaskSchema>;
export const TASK_TYPES = ["extract_field", "check_totals", "check_dates", "flag_missing"] as const;

export const PlanSchema = z
  .object({
    doc_id: z.string().min(1),
    tasks: z.array(TaskSchema).min(1).max(16),
  })
  .strict();
export type Plan = z.infer<typeof PlanSchema>;

/**
 * Schema validation plus the ordering rules a schema cannot express.
 * Returns problems; empty means the plan is accepted.
 */
export function validatePlan(raw: unknown, docId: string): { plan?: Plan; problems: string[] } {
  const parsed = PlanSchema.safeParse(raw);
  if (!parsed.success) {
    return { problems: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  }
  const plan = parsed.data;
  const problems: string[] = [];
  if (plan.doc_id !== docId) problems.push(`doc_id ${plan.doc_id} does not match the document being processed (${docId})`);
  const extracted = new Set<FieldName>();
  plan.tasks.forEach((t, i) => {
    if (t.type === "extract_field") {
      if (extracted.has(t.field)) problems.push(`tasks.${i}: ${t.field} is extracted twice`);
      extracted.add(t.field);
    }
    if (t.type === "check_totals") {
      const missing = AMOUNT_FIELDS.filter((f) => !extracted.has(f));
      if (missing.length) problems.push(`tasks.${i}: check_totals needs ${missing.join(", ")} extracted earlier in the plan`);
    }
    if (t.type === "check_dates") {
      const missing = DATE_FIELDS.filter((f) => !extracted.has(f));
      if (missing.length) problems.push(`tasks.${i}: check_dates needs ${missing.join(", ")} extracted earlier in the plan`);
    }
    if (t.type === "flag_missing" && i !== plan.tasks.length - 1) problems.push(`tasks.${i}: flag_missing must be the last task`);
  });
  if (extracted.size === 0) problems.push("plan extracts no fields");
  return problems.length ? { problems } : { plan, problems };
}

/** Planner to worker. The orchestrator builds it from an accepted plan and validates it again before sending. */
export const HandoffSchema = z
  .object({
    handoff_id: z.string().min(1),
    task_index: z.number().int().min(0),
    doc_id: z.string().min(1),
    task: TaskSchema,
  })
  .strict();
export type Handoff = z.infer<typeof HandoffSchema>;

/** Worker back to the orchestrator: the submit_field tool arguments. */
export const WorkerReturnSchema = FieldResultSchema.extend({ field: FieldNameSchema }).strict();
export type WorkerReturn = z.infer<typeof WorkerReturnSchema>;

/** Baseline: all fields in one submit_extraction call. */
export const FullExtractionSchema = z
  .object({ fields: z.object(Object.fromEntries(FIELD_NAMES.map((f) => [f, FieldResultSchema])) as Record<FieldName, typeof FieldResultSchema>).strict() })
  .strict();

// ---------------------------------------------------------------- findings and results

export interface Finding {
  code: string;
  severity: "error" | "warning" | "info";
  field?: string;
  message: string;
  source: "validator" | "orchestrator";
}

export interface ExtractionResult {
  doc_id: string;
  mode: "fixture" | "live";
  architecture: "two-agent" | "single-agent";
  model: string;
  fields: Fields;
  findings: Finding[];
  /** Model calls (planner and worker together for two-agent). */
  calls: number;
  tool_calls: number;
  usage: { input_tokens: number; output_tokens: number } | null;
  cost_usd: number | null;
  rejections: { plans: number; handoffs: number; finals: number };
  status: "completed" | "budget_exhausted" | "plan_rejected" | "model_error" | "step_limit_exceeded";
  run_id: string;
}

export function nullField(reason: string): FieldResult {
  return { value: null, quote: null, reason };
}
