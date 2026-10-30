import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { PermanentError, TransientError } from "../vendor/durable-jobs/src/errors.ts";
import type { Json } from "../vendor/durable-jobs/src/json.ts";
import type { StepHandler } from "../vendor/durable-jobs/src/worker.ts";
import { MissingApiKeyError, runExtraction, type ReviewStore } from "../vendor/review-workflow/src/index.ts";
import type { ExtractionResult } from "../vendor/review-workflow/src/schema.ts";
import { getDocument } from "./documents.ts";

/** What a P8 job stores as its durable-jobs payload. No document text, only a reference. */
export const JobPayload = z.strictObject({
  user_id: z.string(),
  document_id: z.string(),
  architecture: z.enum(["two-agent", "single-agent"]),
});
export type JobPayload = z.infer<typeof JobPayload>;

export const STEPS = ["read_document", "extract_fields", "open_review"] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The three steps of an extraction job, run by the durable-jobs worker:
 *   read_document   load the stored document, check it belongs to the job's user
 *   extract_fields  review-workflow runExtraction (planner/worker or single agent, Python validator)
 *   open_review     write the proposal into the review store. Idempotent: a proposal that already
 *                   exists for the same document (a re-run after a crash) is accepted as is.
 * Each step result is checkpointed by the worker, so a restart resumes at the first unfinished step.
 */
export function extractionHandlers(opts: { db: DatabaseSync; reviews: ReviewStore; mode: "fixture" | "live"; stepDelayMs: number }): StepHandler[] {
  const pause = () => (opts.stepDelayMs > 0 ? sleep(opts.stepDelayMs) : Promise.resolve());
  const loadDoc = (payload: JobPayload) => {
    const doc = getDocument(opts.db, payload.document_id);
    if (!doc || doc.user_id !== payload.user_id) throw new PermanentError("DOCUMENT_NOT_FOUND", `document ${payload.document_id} not found`);
    return doc;
  };
  return [
    {
      name: "read_document",
      async run({ payload }) {
        await pause();
        const doc = loadDoc(JobPayload.parse(payload));
        return { output: { document_id: doc.id, sha256: doc.sha256, chars: doc.text.length } };
      },
    },
    {
      name: "extract_fields",
      async run({ jobId, payload }) {
        await pause();
        const p = JobPayload.parse(payload);
        const doc = loadDoc(p);
        let result: ExtractionResult;
        try {
          result = await runExtraction(doc.text, { architecture: p.architecture, mode: opts.mode, docId: jobId });
        } catch (e) {
          if (e instanceof MissingApiKeyError) throw new PermanentError("LIVE_MODE_UNAVAILABLE", e.message);
          throw new TransientError("EXTRACTION_FAILED", (e as Error).message);
        }
        if (result.status === "model_error") throw new TransientError("MODEL_ERROR", "the model call failed");
        return { output: result as unknown as Json };
      },
    },
    {
      name: "open_review",
      async run({ jobId, payload, outputs }) {
        await pause();
        const doc = loadDoc(JobPayload.parse(payload));
        const result = outputs.extract_fields as unknown as ExtractionResult;
        try {
          opts.reviews.propose(doc.text, result);
        } catch (e) {
          const existing = (() => { try { return opts.reviews.proposal(jobId); } catch { return undefined; } })();
          if (!existing || existing.doc_sha256 !== doc.sha256) throw e;
        }
        const nulls = Object.values(result.fields).filter((f) => f.value === null).length;
        return { output: { review_id: jobId, null_fields: nulls, findings: result.findings.length } };
      },
    },
  ];
}
