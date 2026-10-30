import type { DatabaseSync } from "node:sqlite";
import { Job, JobSummary, type Finding, type Review } from "extract-review-sdk";
import { getJob, type JobStore } from "../vendor/durable-jobs/src/store.ts";
import { FIELD_NAMES, type ReviewStore } from "../vendor/review-workflow/src/index.ts";
import { getDocument, lastExport } from "./documents.ts";
import { JobPayload } from "./pipeline.ts";

/** Idempotency keys are stored as "<user_id>:<client key>" so two users can never collide. */
export const scopedKey = (userId: string, key: string) => `${userId}:${key}`;
const unscope = (userId: string, key: string) => (key.startsWith(`${userId}:`) ? key.slice(userId.length + 1) : key);

export class Views {
  /** Validator findings per job and number of corrections, so polling does not spawn Python each time. */
  private findingsCache = new Map<string, { n: number; findings: Finding[] }>();

  constructor(private readonly store: JobStore, private readonly reviews: ReviewStore) {}

  private get db(): DatabaseSync {
    return this.store.db;
  }

  /** The job if it exists and belongs to userId. Another user's job is reported exactly like a missing one. */
  owned(jobId: string, userId: string) {
    if (!/^job_[0-9a-f]{12}$/.test(jobId)) return undefined;
    const raw = getJob(this.store, jobId);
    if (!raw) return undefined;
    const p = JobPayload.safeParse(raw.payload);
    if (!p.success || p.data.user_id !== userId) return undefined;
    const doc = getDocument(this.db, p.data.document_id);
    if (!doc) return undefined;
    return { raw, payload: p.data, doc };
  }

  async findings(jobId: string): Promise<Finding[]> {
    const n = this.reviews.corrections(jobId).length;
    const hit = this.findingsCache.get(jobId);
    if (hit && hit.n === n) return hit.findings;
    const findings = (await this.reviews.findings(jobId)) as Finding[];
    this.findingsCache.set(jobId, { n, findings });
    return findings;
  }

  async review(jobId: string): Promise<Review> {
    const prop = this.reviews.proposal(jobId);
    const draft = this.reviews.draft(jobId);
    const corrections = this.reviews.corrections(jobId);
    const approvals = this.reviews.approvals(jobId);
    const findings = await this.findings(jobId);
    const last = approvals.at(-1);
    const current = !!last && last.corrections_seen === corrections.length;
    const exportedAt = current && last ? lastExport(this.db, jobId, last.ts) : null;
    const acknowledged = current && last ? last.acknowledged : [];
    const blocking = [...new Set(findings.filter((f) => f.severity === "error").map((f) => f.code))].filter((c) => !acknowledged.includes(c));
    const r = prop.result;
    return {
      state: exportedAt ? "exported" : current ? "approved" : "in_review",
      blocking,
      extraction: { mode: r.mode, architecture: r.architecture, model: r.model, status: r.status, model_calls: r.calls, tool_calls: r.tool_calls },
      fields: Object.fromEntries(FIELD_NAMES.map((f) => [f, draft[f]])) as Review["fields"],
      findings,
      proposal_findings: r.findings as Finding[],
      corrections,
      approvals,
      exported_at: exportedAt,
    };
  }

  async job(jobId: string, userId: string): Promise<(Job & { document_text: string }) | undefined> {
    const o = this.owned(jobId, userId);
    if (!o) return undefined;
    const { raw, payload, doc } = o;
    const view: Job = {
      job_id: raw.job_id,
      status: raw.status,
      idempotency_key: unscope(userId, raw.idempotency_key),
      architecture: payload.architecture,
      document: { document_id: doc.id, name: doc.name, source: doc.source, chars: doc.text.length, sha256: doc.sha256 },
      created_at: raw.created_at,
      updated_at: raw.updated_at,
      steps: raw.steps,
      error: raw.error,
      review: raw.status === "succeeded" ? await this.review(jobId) : null,
    };
    return { ...Job.parse(view), document_text: doc.text };
  }

  /** Public job shape without the document text (used inside correction and approve responses). */
  async jobOnly(jobId: string, userId: string): Promise<Job | undefined> {
    const j = await this.job(jobId, userId);
    if (!j) return undefined;
    const { document_text: _t, ...rest } = j;
    return rest;
  }

  list(userId: string): JobSummary[] {
    const rows = this.db
      .prepare("SELECT id FROM jobs WHERE json_extract(payload, '$.user_id') = ? ORDER BY created_at DESC, rowid DESC LIMIT 100")
      .all(userId) as { id: string }[];
    return rows.flatMap(({ id }) => {
      const o = this.owned(id, userId);
      if (!o) return [];
      let state: JobSummary["review_state"] = null;
      if (o.raw.status === "succeeded") {
        const approvals = this.reviews.approvals(id);
        const n = this.reviews.corrections(id).length;
        const last = approvals.at(-1);
        state = last && last.corrections_seen === n ? (lastExport(this.db, id, last.ts) ? "exported" : "approved") : "in_review";
      }
      return [JobSummary.parse({ job_id: id, status: o.raw.status, document_name: o.doc.name, review_state: state, created_at: o.raw.created_at })];
    });
  }
}
