/**
 * A separate client program that drives one complete job through the HTTP API with the SDK:
 * create (with an Idempotency-Key, sent twice), watch status, read fields with source quotes and
 * validator findings, correct fields, approve, export the local draft. Then it shows what a
 * second user and a bad request get back.
 *
 *   API_URL=http://127.0.0.1:8787 API_TOKEN=... npm run example
 *
 * Without API_TOKEN it uses the public test tokens from data/test-tokens.json (local demo only).
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { ApiError, createClient, FIELD_NAMES, type FieldName, type JobWithText } from "extract-review-sdk";

const baseUrl = process.env.API_URL ?? "http://127.0.0.1:8787";
const testTokens = () => (JSON.parse(readFileSync(new URL("../data/test-tokens.json", import.meta.url), "utf8")) as { tokens: { a: string; b: string } }).tokens;
const token = process.env.API_TOKEN ?? testTokens().a;
const otherToken = process.env.API_TOKEN_OTHER ?? (process.env.API_TOKEN ? undefined : testTokens().b);
const sample = process.argv[2] ?? "INV-016";
const key = process.env.IDEMPOTENCY_KEY ?? `sdk-example-${randomUUID().slice(0, 8)}`;

const client = createClient({ baseUrl, token });
const show = (v: unknown) => (v === null ? "null" : JSON.stringify(v));

const health = await client.health();
const me = await client.me();
console.log(`API ${baseUrl}  version ${health.version}  extraction ${health.extraction_mode}  as ${me.user_id}${me.test_user ? " (test user)" : ""}`);

// 1. create, then send the same request again with the same key
const first = await client.createJob({ sample }, { idempotencyKey: key });
const again = await client.createJob({ sample }, { idempotencyKey: key });
console.log(`\ncreate ${sample}  key=${key}  -> ${first.job_id} created=${first.created}`);
console.log(`create ${sample}  key=${key}  -> ${again.job_id} created=${again.created}  (same job: ${first.job_id === again.job_id})`);

// 2. watch status until it settles
let lastLine = "";
const job = await client.waitForJob(first.job_id, {
  intervalMs: 100,
  onUpdate: (j) => {
    const line = `${j.status.padEnd(9)} ${j.steps.map((s) => `${s.name}=${s.status}`).join(" ")}`;
    if (line !== lastLine) console.log(`  status ${line}`);
    lastLine = line;
  },
});
if (job.status !== "succeeded" || !job.review) {
  console.error(`job ended ${job.status}: ${job.error?.code} ${job.error?.message}`);
  process.exit(1);
}

// 3. fields with source quotes, and the Python validator's findings
const printFields = (j: JobWithText) => {
  for (const f of FIELD_NAMES) {
    const d = j.review!.fields[f];
    const src = d.value === null ? `reason: ${d.reason}` : `quote: ${show(d.quote)}`;
    console.log(`  ${f.padEnd(15)} ${show(d.value).padEnd(22)} ${d.source.padEnd(6)} ${src}`);
  }
};
console.log(`\nfields (${job.review.extraction.architecture}, ${job.review.extraction.mode}, ${job.review.extraction.model_calls} model calls)`);
printFields(job);
console.log("validator findings:");
for (const f of job.review.findings) console.log(`  ${f.severity.padEnd(7)} ${f.code}${f.field ? ` (${f.field})` : ""}: ${f.message}`);

// 4. a reviewer fills the empty fields from the document text. These readers stand in for a
//    person looking at the paper; each one returns a value and the exact line it came from.
const text = job.document_text;
const readers: Partial<Record<FieldName, () => { value: string | number; quote: string } | null>> = {
  supplier: () => {
    const line = text.split("\n").find((l) => l.trim() !== "");
    return line ? { value: line.trim(), quote: line.trim() } : null;
  },
  invoice_number: () => {
    const m = /^Faktura (\d+)$/m.exec(text);
    return m ? { value: m[1]!, quote: m[0] } : null;
  },
  net: () => {
    const m = /^Summa: ([\d ]+,\d{2})$/m.exec(text);
    return m ? { value: Number(m[1]!.replace(/ /g, "").replace(",", ".")), quote: m[1]! } : null;
  },
};
let current: JobWithText = job;
console.log("\ncorrections");
for (const f of FIELD_NAMES) {
  if (current.review!.fields[f].value !== null) continue;
  const read = readers[f]?.();
  if (!read) {
    console.log(`  ${f}: left empty (no reader for it)`);
    continue;
  }
  const r = await client.correctField(first.job_id, { field: f, value: read.value, quote: read.quote, note: "filled in by the SDK example" });
  console.log(`  #${r.correction.seq} ${f}: ${show(r.correction.previous.value)} -> ${show(r.correction.value)}  quote ${show(r.correction.quote)}  by ${r.correction.reviewer}`);
}
current = await client.getJob(first.job_id);

// 5. approve (acknowledging only error codes that are still open) and export
const ack = current.review!.blocking;
const approved = await client.approve(first.job_id, { acknowledge: ack });
console.log(`\napproved by ${approved.approval.reviewer} after ${approved.approval.corrections_seen} corrections${ack.length ? `, acknowledged ${ack.join(", ")}` : ""}; review state ${approved.job.review?.state}`);
const exported = await client.exportDraft(first.job_id);
const human = FIELD_NAMES.filter((f) => exported.draft.fields[f].source === "human");
console.log(`exported ${exported.file}`);
console.log(`  draft fields from the model: ${FIELD_NAMES.length - human.length}, from the reviewer: ${human.length} (${human.join(", ")})`);
console.log(`  model proposal kept unchanged in the export: ${FIELD_NAMES.filter((f) => exported.draft.model_proposal.fields[f].value === null).length} fields still null there`);
console.log(`  remaining validator findings: ${exported.draft.findings.map((f) => f.code).join(", ") || "none"}`);

// 6. what a second user and a bad request get
if (otherToken) {
  const other = createClient({ baseUrl, token: otherToken });
  try {
    await other.getJob(first.job_id);
    console.error("second user could read the job: access control is broken");
    process.exit(1);
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    console.log(`\nsecond user reads ${first.job_id}: ${e.status} ${e.code} "${e.detail}"`);
  }
}
try {
  await client.createJob({} as never, { idempotencyKey: `${key}-bad` });
} catch (e) {
  if (!(e instanceof ApiError)) throw e;
  console.log(`empty create request: ${e.status} ${e.code} ${e.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
}
console.log(`\ndone: ${first.job_id} ${current.status}, review ${exported.draft.kind} exported`);
