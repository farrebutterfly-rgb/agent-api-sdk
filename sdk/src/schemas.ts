import { z } from "zod";

/**
 * The public JSON contract of the extraction and review API, version v1.
 * The server parses every response it sends with these schemas, and the client parses every
 * response it receives with them, so the two cannot drift apart silently.
 */

/** The nine invoice fields. Same names and order as the review-workflow field schema. */
export const FIELD_NAMES = ["supplier", "invoice_number", "invoice_date", "due_date", "currency", "net", "vat", "total", "org_number"] as const;
export const FieldName = z.enum(FIELD_NAMES);
export type FieldName = z.infer<typeof FieldName>;

export const FieldValue = z.union([z.string(), z.number(), z.null()]);
export type FieldValue = z.infer<typeof FieldValue>;

export const Architecture = z.enum(["two-agent", "single-agent"]);
export type Architecture = z.infer<typeof Architecture>;

// ------------------------------------------------------------------ requests

export const DOC_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,79}$/;
export const MAX_DOC_CHARS = 20_000;

export const CreateJobRequest = z
  .strictObject({
    sample: z.string().regex(/^INV-\d{3}$/, "sample id like INV-001").optional(),
    document: z
      .strictObject({
        name: z.string().regex(DOC_NAME_PATTERN, "1 to 80 characters: letters, digits, space, _ . -"),
        text: z.string().min(20, "document text needs at least 20 characters").max(MAX_DOC_CHARS, `document text over ${MAX_DOC_CHARS} characters`),
      })
      .optional(),
    architecture: Architecture.optional(),
  })
  .superRefine((v, ctx) => {
    if ((v.sample === undefined) === (v.document === undefined)) {
      ctx.addIssue({ code: "custom", path: [], message: "send exactly one of sample or document" });
    }
  });
export type CreateJobRequest = z.infer<typeof CreateJobRequest>;

export const CorrectionRequest = z.strictObject({
  field: FieldName,
  value: FieldValue,
  /** Exact substring of the document, or null when the value is typed in without a source. */
  quote: z.string().min(1).max(500).nullable().optional(),
  /** Required when value is null. */
  reason: z.string().min(3).max(500).optional(),
  note: z.string().max(500).optional(),
});
export type CorrectionRequest = z.infer<typeof CorrectionRequest>;

export const ApproveRequest = z.strictObject({
  /** Error finding codes the reviewer accepts as they are (for example a mismatch that really is on the paper). */
  acknowledge: z.array(z.string().regex(/^[A-Z_]{2,64}$/)).max(20).optional(),
});
export type ApproveRequest = z.infer<typeof ApproveRequest>;

// ------------------------------------------------------------------ responses

export const Finding = z.object({
  code: z.string(),
  severity: z.enum(["error", "warning", "info"]),
  field: z.string().optional(),
  message: z.string(),
  source: z.enum(["validator", "orchestrator"]),
});
export type Finding = z.infer<typeof Finding>;

export const ProposedField = z.object({
  value: FieldValue,
  quote: z.string().nullable(),
  confidence: z.number().min(0).max(1).optional(),
  reason: z.string().optional(),
});
export type ProposedField = z.infer<typeof ProposedField>;

export const DraftField = ProposedField.extend({
  source: z.enum(["model", "human"]),
  /** The model's original proposal for this field. Never overwritten by a correction. */
  proposed: ProposedField,
  corrected_at: z.string().optional(),
  corrected_by: z.string().optional(),
});
export type DraftField = z.infer<typeof DraftField>;

export const Correction = z.object({
  seq: z.number().int().positive(),
  ts: z.string(),
  reviewer: z.string(),
  field: FieldName,
  value: FieldValue,
  quote: z.string().nullable(),
  reason: z.string().optional(),
  note: z.string().optional(),
  previous: z.object({ value: FieldValue, source: z.enum(["model", "human"]) }),
});
export type Correction = z.infer<typeof Correction>;

export const Approval = z.object({
  ts: z.string(),
  reviewer: z.string(),
  corrections_seen: z.number().int().nonnegative(),
  acknowledged: z.array(z.string()),
  draft_sha256: z.string(),
});
export type Approval = z.infer<typeof Approval>;

export const StepView = z.object({
  name: z.string(),
  status: z.enum(["pending", "running", "done", "failed"]),
  attempts: z.number().int().nonnegative(),
  last_error: z.object({ code: z.string(), message: z.string(), transient: z.boolean() }).nullable(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
});
export type StepView = z.infer<typeof StepView>;

export const JobStatus = z.enum(["queued", "running", "succeeded", "failed"]);
export type JobStatus = z.infer<typeof JobStatus>;

export const ReviewState = z.enum(["in_review", "approved", "exported"]);
export type ReviewState = z.infer<typeof ReviewState>;

export const DocumentInfo = z.object({
  document_id: z.string(),
  name: z.string(),
  source: z.enum(["sample", "upload"]),
  chars: z.number().int().nonnegative(),
  sha256: z.string(),
});
export type DocumentInfo = z.infer<typeof DocumentInfo>;

export const Review = z.object({
  state: ReviewState,
  /** Error finding codes that still block approval (not fixed and not acknowledged). */
  blocking: z.array(z.string()),
  extraction: z.object({
    mode: z.enum(["fixture", "live"]),
    architecture: Architecture,
    model: z.string(),
    status: z.string(),
    model_calls: z.number().int().nonnegative(),
    tool_calls: z.number().int().nonnegative(),
  }),
  fields: z.record(FieldName, DraftField),
  /** Python validator findings on the current draft (re-run after every correction). */
  findings: z.array(Finding),
  /** Findings on the model's proposal as it was extracted. */
  proposal_findings: z.array(Finding),
  corrections: z.array(Correction),
  approvals: z.array(Approval),
  exported_at: z.string().nullable(),
});
export type Review = z.infer<typeof Review>;

export const Job = z.object({
  job_id: z.string(),
  status: JobStatus,
  /** The key the client sent. Keys are scoped per user on the server. */
  idempotency_key: z.string(),
  architecture: Architecture,
  document: DocumentInfo,
  created_at: z.string(),
  updated_at: z.string(),
  steps: z.array(StepView),
  error: z.object({ code: z.string(), message: z.string(), transient: z.boolean(), step: z.string(), attempts: z.number().int() }).nullable(),
  /** null until the job has succeeded. */
  review: Review.nullable(),
});
export type Job = z.infer<typeof Job>;

export const JobWithText = Job.extend({
  /** The document text, so the UI can show where each quote comes from. Only on GET /jobs/:id. */
  document_text: z.string(),
});
export type JobWithText = z.infer<typeof JobWithText>;

export const JobSummary = z.object({
  job_id: z.string(),
  status: JobStatus,
  document_name: z.string(),
  review_state: ReviewState.nullable(),
  created_at: z.string(),
});
export type JobSummary = z.infer<typeof JobSummary>;

export const JobList = z.object({ jobs: z.array(JobSummary) });
export type JobList = z.infer<typeof JobList>;

export const CreateJobResponse = z.object({
  job_id: z.string(),
  status: JobStatus,
  /** false: the same Idempotency-Key and body were seen before, and this is the existing job. */
  created: z.boolean(),
});
export type CreateJobResponse = z.infer<typeof CreateJobResponse>;

export const CorrectionResponse = z.object({ correction: Correction, job: Job });
export type CorrectionResponse = z.infer<typeof CorrectionResponse>;

export const ApproveResponse = z.object({ approval: Approval, job: Job });
export type ApproveResponse = z.infer<typeof ApproveResponse>;

export const ExportedDraft = z.object({
  kind: z.literal("local-draft"),
  note: z.string(),
  doc_id: z.string(),
  doc_sha256: z.string(),
  exported_at: z.string(),
  approved: Approval,
  fields: z.record(FieldName, z.object({ value: FieldValue, quote: z.string().nullable(), source: z.enum(["model", "human"]), reason: z.string().optional() })),
  model_proposal: z.object({ created_at: z.string(), architecture: Architecture, mode: z.enum(["fixture", "live"]), model: z.string(), fields: z.record(FieldName, ProposedField) }),
  corrections: z.array(Correction),
  findings: z.array(Finding),
});
export type ExportedDraft = z.infer<typeof ExportedDraft>;

export const ExportResponse = z.object({
  /** Where the server wrote the file, relative to its data directory. Nothing is sent anywhere. */
  file: z.string(),
  draft: ExportedDraft,
});
export type ExportResponse = z.infer<typeof ExportResponse>;

export const Sample = z.object({ id: z.string(), name: z.string(), chars: z.number().int(), case: z.string() });
export const SampleList = z.object({ samples: z.array(Sample) });
export type SampleList = z.infer<typeof SampleList>;

export const Me = z.object({
  user_id: z.string(),
  name: z.string(),
  test_user: z.boolean(),
  rate_limit: z.object({ limit: z.number().int(), window_seconds: z.number().int() }),
});
export type Me = z.infer<typeof Me>;

export const Health = z.object({ ok: z.literal(true), version: z.string(), extraction_mode: z.enum(["fixture", "live"]), web_build: z.boolean() });
export type Health = z.infer<typeof Health>;

export const Issue = z.object({ path: z.string(), message: z.string() });
export type Issue = z.infer<typeof Issue>;

export const ErrorCode = z.enum([
  "INVALID_INPUT",
  "INVALID_JSON",
  "MISSING_IDEMPOTENCY_KEY",
  "BODY_TOO_LARGE",
  "UNAUTHENTICATED",
  "JOB_NOT_FOUND",
  "NOT_FOUND",
  "METHOD_NOT_ALLOWED",
  "IDEMPOTENCY_KEY_REUSED",
  "JOB_NOT_READY",
  "APPROVAL_BLOCKED",
  "NOT_APPROVED",
  "RATE_LIMITED",
  "INTERNAL",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ApiErrorBody = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    request_id: z.string(),
    issues: z.array(Issue).optional(),
    job_id: z.string().optional(),
    retry_after_seconds: z.number().int().positive().optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;
