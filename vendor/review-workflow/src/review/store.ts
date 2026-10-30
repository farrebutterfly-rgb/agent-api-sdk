import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIELD_NAMES, FieldNameSchema, VALUE_SCHEMAS, type ExtractionResult, type FieldName, type FieldResult, type Finding } from "../schema.ts";
import { asFindings, runValidator } from "../validator.ts";

/**
 * Local human review. Three files per document, none of them ever rewritten:
 *   proposal.json      the model's extraction, written once
 *   corrections.jsonl  one line per human correction, append only, with timestamp and reviewer
 *   approvals.jsonl    one line per approval, pinned to the number of corrections it saw
 * The effective draft is computed from these; export writes it with per-field provenance.
 */

export interface Proposal {
  doc_id: string;
  created_at: string;
  doc_sha256: string;
  doc_text: string;
  result: ExtractionResult;
}

export interface Correction {
  seq: number;
  ts: string;
  reviewer: string;
  field: FieldName;
  value: string | number | null;
  quote: string | null;
  reason?: string;
  note?: string;
  /** Effective value right before this correction, so the history reads without replaying. */
  previous: { value: string | number | null; source: "model" | "human" };
}

export interface Approval {
  ts: string;
  reviewer: string;
  corrections_seen: number;
  acknowledged: string[];
  draft_sha256: string;
}

export interface DraftField extends FieldResult {
  source: "model" | "human";
  proposed: FieldResult;
  corrected_at?: string;
  corrected_by?: string;
}

export class ReviewError extends Error {}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const readJsonl = <T>(file: string): T[] => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as T) : []);

export class ReviewStore {
  constructor(readonly dir: string, private readonly now: () => Date = () => new Date()) {}

  private paths(docId: string) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(docId)) throw new ReviewError(`bad doc id ${JSON.stringify(docId)}`);
    const d = join(this.dir, docId);
    return { d, proposal: join(d, "proposal.json"), corrections: join(d, "corrections.jsonl"), approvals: join(d, "approvals.jsonl") };
  }

  propose(docText: string, result: ExtractionResult): Proposal {
    const p = this.paths(result.doc_id);
    if (existsSync(p.proposal)) throw new ReviewError(`${result.doc_id} already has a proposal; proposals are never overwritten`);
    mkdirSync(p.d, { recursive: true });
    const proposal: Proposal = { doc_id: result.doc_id, created_at: this.now().toISOString(), doc_sha256: sha(docText), doc_text: docText, result };
    writeFileSync(p.proposal, JSON.stringify(proposal, null, 2) + "\n", { flag: "wx" });
    return proposal;
  }

  proposal(docId: string): Proposal {
    const p = this.paths(docId);
    if (!existsSync(p.proposal)) throw new ReviewError(`no proposal for ${docId}`);
    return JSON.parse(readFileSync(p.proposal, "utf8")) as Proposal;
  }

  corrections(docId: string): Correction[] {
    return readJsonl<Correction>(this.paths(docId).corrections);
  }

  approvals(docId: string): Approval[] {
    return readJsonl<Approval>(this.paths(docId).approvals);
  }

  /** The draft as it stands: model proposal, overridden field by field by the latest correction. */
  draft(docId: string): Record<FieldName, DraftField> {
    const prop = this.proposal(docId);
    const out = {} as Record<FieldName, DraftField>;
    for (const f of FIELD_NAMES) out[f] = { ...prop.result.fields[f], source: "model", proposed: prop.result.fields[f] };
    for (const c of this.corrections(docId)) {
      out[c.field] = { value: c.value, quote: c.quote, ...(c.reason ? { reason: c.reason } : {}), source: "human", proposed: prop.result.fields[c.field], corrected_at: c.ts, corrected_by: c.reviewer };
    }
    return out;
  }

  correct(docId: string, input: { field: string; value: string | number | null; quote?: string | null; reason?: string; note?: string; reviewer: string }): Correction {
    const prop = this.proposal(docId);
    const field = FieldNameSchema.safeParse(input.field);
    if (!field.success) throw new ReviewError(`unknown field ${input.field}. Fields: ${FIELD_NAMES.join(", ")}`);
    const name = field.data;
    if (!input.reviewer.trim()) throw new ReviewError("a correction needs a reviewer name");
    const quote = input.quote ?? null;
    if (input.value === null) {
      if (!input.reason) throw new ReviewError("setting a field to null needs a reason");
    } else {
      const typed = VALUE_SCHEMAS[name].safeParse(input.value);
      if (!typed.success) throw new ReviewError(`${name}: ${typed.error.issues.map((i) => i.message).join("; ")}`);
    }
    if (quote !== null && !prop.doc_text.includes(quote)) throw new ReviewError(`quote ${JSON.stringify(quote)} is not an exact substring of the document`);
    const before = this.draft(docId)[name];
    const c: Correction = {
      seq: this.corrections(docId).length + 1,
      ts: this.now().toISOString(),
      reviewer: input.reviewer,
      field: name,
      value: input.value,
      quote,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.note ? { note: input.note } : {}),
      previous: { value: before.value, source: before.source },
    };
    appendFileSync(this.paths(docId).corrections, JSON.stringify(c) + "\n");
    return c;
  }

  /** Re-runs the Python validator on the current draft. A reviewer may enter a value without a quote, so quotes are checked only where one is given. */
  async findings(docId: string): Promise<Finding[]> {
    const prop = this.proposal(docId);
    const d = this.draft(docId);
    const fields = Object.fromEntries(FIELD_NAMES.map((f) => [f, { value: d[f].value, quote: d[f].quote, ...(d[f].reason ? { reason: d[f].reason } : {}) }]));
    const humanNoQuote = FIELD_NAMES.filter((f) => d[f].source === "human" && d[f].value !== null && d[f].quote === null);
    const v = await runValidator({ fields, checks: ["types", "totals", "dates", "missing"] });
    const quoteCheck = await runValidator({ fields: Object.fromEntries(FIELD_NAMES.filter((f) => !humanNoQuote.includes(f)).map((f) => [f, fields[f]])), doc_text: prop.doc_text, checks: ["quotes"] });
    return [...asFindings(v), ...asFindings(quoteCheck)];
  }

  /**
   * Approve the current draft. Error findings block approval unless the reviewer acknowledges
   * each code explicitly (for example a TOTAL_MISMATCH that really is on the paper invoice).
   */
  async approve(docId: string, reviewer: string, acknowledge: string[] = []): Promise<Approval> {
    if (!reviewer.trim()) throw new ReviewError("approval needs a reviewer name");
    const errors = (await this.findings(docId)).filter((f) => f.severity === "error");
    const open = [...new Set(errors.map((e) => e.code))].filter((c) => !acknowledge.includes(c));
    if (open.length) throw new ReviewError(`cannot approve ${docId}: unresolved ${open.join(", ")}. Correct the fields or acknowledge the codes.`);
    const a: Approval = { ts: this.now().toISOString(), reviewer, corrections_seen: this.corrections(docId).length, acknowledged: acknowledge, draft_sha256: sha(JSON.stringify(this.draft(docId))) };
    appendFileSync(this.paths(docId).approvals, JSON.stringify(a) + "\n");
    return a;
  }

  /** Writes <outDir>/<docId>.draft.json. Only an approval that saw every correction counts. */
  async export(docId: string, outDir: string): Promise<{ file: string; draft: Record<string, unknown> }> {
    const last = this.approvals(docId).at(-1);
    const n = this.corrections(docId).length;
    if (!last) throw new ReviewError(`${docId} is not approved`);
    if (last.corrections_seen !== n) throw new ReviewError(`${docId} has ${n - last.corrections_seen} correction(s) made after the last approval; approve again`);
    const prop = this.proposal(docId);
    const fields = this.draft(docId);
    const draft = {
      kind: "local-draft",
      note: "Local review export. Not booked, sent or filed anywhere.",
      doc_id: docId,
      doc_sha256: prop.doc_sha256,
      exported_at: this.now().toISOString(),
      approved: last,
      fields: Object.fromEntries(FIELD_NAMES.map((f) => [f, { value: fields[f].value, quote: fields[f].quote, source: fields[f].source, ...(fields[f].reason ? { reason: fields[f].reason } : {}) }])),
      model_proposal: { created_at: prop.created_at, architecture: prop.result.architecture, mode: prop.result.mode, model: prop.result.model, fields: prop.result.fields },
      corrections: this.corrections(docId),
      findings: await this.findings(docId),
    };
    mkdirSync(outDir, { recursive: true });
    const file = join(outDir, `${docId}.draft.json`);
    writeFileSync(file, JSON.stringify(draft, null, 2) + "\n");
    return { file, draft };
  }
}
