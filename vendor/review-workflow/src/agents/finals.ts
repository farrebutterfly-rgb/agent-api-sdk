import { z } from "zod";
import { FIELD_NAMES, FullExtractionSchema, PlanSchema, WorkerReturnSchema, checkField, validatePlan, type FieldName, type Handoff, type Plan, type WorkerReturn } from "../schema.ts";
import type { FinalTool } from "../loop.ts";

const spec = (name: string, description: string, schema: z.ZodType) => ({ name, description, input_schema: z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown> });

export function planFinal(docId: string): FinalTool<Plan> {
  return {
    spec: spec("submit_plan", "Submit the ordered task plan for this document.", PlanSchema),
    schema: PlanSchema,
    check: (p) => validatePlan(p, docId).problems,
  };
}

/** The worker's return for one handoff: right field, typed value, exact quote, or null with a reason. */
export function fieldFinal(handoff: Handoff, docText: string): FinalTool<WorkerReturn> {
  const expected = handoff.task.type === "extract_field" ? handoff.task.field : undefined;
  return {
    spec: spec("submit_field", "Submit the one field you were asked to extract.", WorkerReturnSchema),
    schema: WorkerReturnSchema,
    check: (r) => {
      if (r.field !== expected) return [`handoff ${handoff.handoff_id} asked for ${expected}, got ${r.field}`];
      const { field, ...rest } = r;
      return checkField(field, rest, docText);
    },
  };
}

export type FullExtraction = z.infer<typeof FullExtractionSchema>;
export function extractionFinal(docText: string): FinalTool<FullExtraction> {
  return {
    spec: spec("submit_extraction", "Submit every field of the document.", FullExtractionSchema),
    schema: FullExtractionSchema,
    check: (x) => FIELD_NAMES.flatMap((f: FieldName) => checkField(f, x.fields[f], docText)),
  };
}
