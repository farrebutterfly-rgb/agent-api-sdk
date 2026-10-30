import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { FIELD_NAMES as SDK_FIELDS } from "extract-review-sdk";
import { FIELD_NAMES as VENDOR_FIELDS } from "../vendor/review-workflow/src/index.ts";
import { api, createAndWait, startTestApp, TOKENS, waitDone } from "./helpers.ts";

const A = TOKENS.a;
const B = TOKENS.b;
const key = (k: string) => ({ "idempotency-key": k });

describe("API", () => {
  let app: Awaited<ReturnType<typeof startTestApp>>;
  let url: string;
  before(async () => {
    app = await startTestApp();
    url = app.url;
  });
  after(() => app.close());

  test("SDK field names are the review-workflow field names", () => {
    assert.deepEqual([...SDK_FIELDS], [...VENDOR_FIELDS]);
  });

  test("healthz needs no token", async () => {
    const r = await api(url, "GET", "/healthz");
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.extraction_mode, "fixture");
  });

  test("401 for a missing, malformed or unknown token", async () => {
    const variants: Record<string, string>[] = [{}, { authorization: "Basic abc" }, { authorization: "Bearer short" }, { authorization: `Bearer ${A}x` }];
    for (const headers of variants) {
      const r = await api(url, "GET", "/api/v1/jobs", { headers });
      assert.equal(r.status, 401, JSON.stringify(headers));
      assert.equal(r.json.error.code, "UNAUTHENTICATED");
      assert.match(r.headers.get("www-authenticate") ?? "", /^Bearer/);
      assert.match(r.json.error.request_id, /^[0-9a-f]{12}$/);
    }
  });

  test("400 with field issues for invalid input", async () => {
    const cases: [unknown, string][] = [
      [{}, "(root)"],
      [{ sample: "INV-001", document: { name: "a.txt", text: "x".repeat(30) } }, "(root)"],
      [{ sample: "invoice-1" }, "sample"],
      [{ document: { name: "../etc/passwd", text: "x".repeat(30) } }, "document.name"],
      [{ document: { name: "a.txt", text: "short" } }, "document.text"],
      [{ sample: "INV-001", architecture: "three-agent" }, "architecture"],
      [{ sample: "INV-001", extra: true }, "(root)"],
      [{ sample: "INV-999" }, "sample"],
    ];
    for (const [body, path] of cases) {
      const r = await api(url, "POST", "/api/v1/jobs", { token: A, body, headers: key(`bad-${Math.random()}`) });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.json.error.code, "INVALID_INPUT");
      assert.ok(r.json.error.issues.some((i: { path: string }) => i.path === path), `${JSON.stringify(body)} -> ${JSON.stringify(r.json.error.issues)}`);
    }
    const nojson = await api(url, "POST", "/api/v1/jobs", { token: A, raw: "{not json", headers: key("k-json") });
    assert.equal(nojson.status, 400);
    assert.equal(nojson.json.error.code, "INVALID_JSON");
    const nokey = await api(url, "POST", "/api/v1/jobs", { token: A, body: { sample: "INV-001" } });
    assert.equal(nokey.status, 400);
    assert.equal(nokey.json.error.code, "MISSING_IDEMPOTENCY_KEY");
    const big = await api(url, "POST", "/api/v1/jobs", { token: A, body: { document: { name: "a.txt", text: "x".repeat(70_000) } }, headers: key("k-big") });
    assert.equal(big.status, 413);
    assert.equal(big.json.error.code, "BODY_TOO_LARGE");
  });

  test("Idempotency-Key: replay returns the same job, another body gets 409, keys are per user", async () => {
    const first = await api(url, "POST", "/api/v1/jobs", { token: A, body: { sample: "INV-001" }, headers: key("order-1") });
    assert.equal(first.status, 201);
    assert.equal(first.json.created, true);
    assert.equal(first.headers.get("location"), `/api/v1/jobs/${first.json.job_id}`);
    const again = await api(url, "POST", "/api/v1/jobs", { token: A, body: { sample: "INV-001" }, headers: key("order-1") });
    assert.equal(again.status, 200);
    assert.equal(again.json.created, false);
    assert.equal(again.json.job_id, first.json.job_id);
    const other = await api(url, "POST", "/api/v1/jobs", { token: A, body: { sample: "INV-003" }, headers: key("order-1") });
    assert.equal(other.status, 409);
    assert.equal(other.json.error.code, "IDEMPOTENCY_KEY_REUSED");
    assert.equal(other.json.error.job_id, first.json.job_id);
    const userB = await api(url, "POST", "/api/v1/jobs", { token: B, body: { sample: "INV-003" }, headers: key("order-1") });
    assert.equal(userB.status, 201, "the same key from another user is a different job");
    assert.notEqual(userB.json.job_id, first.json.job_id);
    const parallel = await Promise.all(Array.from({ length: 6 }, () => api(url, "POST", "/api/v1/jobs", { token: A, body: { sample: "INV-005" }, headers: key("order-par") })));
    assert.equal(new Set(parallel.map((p) => p.json.job_id)).size, 1);
    assert.equal(parallel.filter((p) => p.status === 201).length, 1);
    const view = await waitDone(url, A, first.json.job_id);
    assert.equal(view.json.idempotency_key, "order-1", "the stored per-user scope prefix is not shown");
  });

  test("another user's job is 404, exactly like an unknown job", async () => {
    const job = await createAndWait(url, A, { sample: "INV-003" }, "own-1");
    const theirs = await api(url, "GET", `/api/v1/jobs/${job.job_id}`, { token: B });
    const unknown = await api(url, "GET", "/api/v1/jobs/job_000000000000", { token: B });
    const garbage = await api(url, "GET", "/api/v1/jobs/..%2F..%2Fetc", { token: B });
    for (const r of [theirs, unknown, garbage]) {
      assert.equal(r.status, 404);
      assert.equal(r.json.error.code, "JOB_NOT_FOUND");
    }
    assert.equal(theirs.json.error.message.replace(job.job_id, "X"), unknown.json.error.message.replace("job_000000000000", "X"));
    for (const action of ["corrections", "approve", "export"]) {
      const r = await api(url, "POST", `/api/v1/jobs/${job.job_id}/${action}`, { token: B, body: { field: "net", value: 1, quote: null } });
      assert.equal(r.status, 404, action);
    }
    const listB = await api(url, "GET", "/api/v1/jobs", { token: B });
    assert.ok(!listB.json.jobs.some((j: { job_id: string }) => j.job_id === job.job_id));
    const listA = await api(url, "GET", "/api/v1/jobs", { token: A });
    assert.ok(listA.json.jobs.some((j: { job_id: string }) => j.job_id === job.job_id));
  });

  test("full review flow: fields with quotes, correction, approve, export; proposal untouched", async () => {
    const job = await createAndWait(url, A, { sample: "INV-016" }, "flow-1");
    assert.equal(job.status, "succeeded");
    assert.deepEqual(job.steps.map((s: { name: string; status: string }) => `${s.name}:${s.status}`), ["read_document:done", "extract_fields:done", "open_review:done"]);
    const f = job.review.fields;
    assert.equal(f.invoice_number.value, null);
    assert.ok(f.invoice_number.reason.length > 3);
    assert.equal(f.total.value, 12500);
    assert.ok(job.document_text.includes(f.total.quote), "every quote is an exact substring of the document");
    assert.ok(job.review.findings.some((x: { code: string }) => x.code === "MISSING_VALUE"));
    const id = job.job_id;

    const badQuote = await api(url, "POST", `/api/v1/jobs/${id}/corrections`, { token: A, body: { field: "invoice_number", value: "7731", quote: "Invoice 7731" } });
    assert.equal(badQuote.status, 400);
    assert.equal(badQuote.json.error.issues[0].path, "quote");
    const badType = await api(url, "POST", `/api/v1/jobs/${id}/corrections`, { token: A, body: { field: "invoice_date", value: "30/09/2026", quote: null } });
    assert.equal(badType.status, 400);
    const badField = await api(url, "POST", `/api/v1/jobs/${id}/corrections`, { token: A, body: { field: "iban", value: "x" } });
    assert.equal(badField.status, 400);
    assert.equal(badField.json.error.issues[0].path, "field");

    const exportEarly = await api(url, "POST", `/api/v1/jobs/${id}/export`, { token: A });
    assert.equal(exportEarly.status, 409);
    assert.equal(exportEarly.json.error.code, "NOT_APPROVED");

    const c = await api(url, "POST", `/api/v1/jobs/${id}/corrections`, { token: A, body: { field: "invoice_number", value: "7731", quote: "Faktura 7731" } });
    assert.equal(c.status, 201);
    assert.equal(c.json.correction.reviewer, "u_test_a", "the reviewer is the authenticated user, not a client field");
    assert.deepEqual(c.json.correction.previous, { value: null, source: "model" });
    assert.equal(c.json.job.review.fields.invoice_number.source, "human");
    assert.equal(c.json.job.review.fields.invoice_number.proposed.value, null);

    const ap = await api(url, "POST", `/api/v1/jobs/${id}/approve`, { token: A, body: {} });
    assert.equal(ap.status, 200);
    assert.equal(ap.json.job.review.state, "approved");
    const ex = await api(url, "POST", `/api/v1/jobs/${id}/export`, { token: A });
    assert.equal(ex.status, 200);
    assert.equal(ex.json.file, `exports/u_test_a/${id}.draft.json`);
    assert.equal(ex.json.draft.fields.invoice_number.value, "7731");
    assert.equal(ex.json.draft.fields.invoice_number.source, "human");
    assert.equal(ex.json.draft.model_proposal.fields.invoice_number.value, null);
    assert.deepEqual(JSON.parse(readFileSync(join(app.dataDir, ex.json.file), "utf8")), ex.json.draft);
    const proposal = JSON.parse(readFileSync(join(app.dataDir, "review", id, "proposal.json"), "utf8"));
    assert.equal(proposal.result.fields.invoice_number.value, null, "the model proposal file is never rewritten");
    const after1 = await api(url, "GET", `/api/v1/jobs/${id}`, { token: A });
    assert.equal(after1.json.review.state, "exported");

    const late = await api(url, "POST", `/api/v1/jobs/${id}/corrections`, { token: A, body: { field: "net", value: 10000, quote: "10 000,00" } });
    assert.equal(late.status, 201);
    assert.equal(late.json.job.review.state, "in_review", "a correction after approval reopens review");
    const exportStale = await api(url, "POST", `/api/v1/jobs/${id}/export`, { token: A });
    assert.equal(exportStale.status, 409);
    assert.match(exportStale.json.error.message, /after the last approval/);
  });

  test("validator errors block approval until fixed or acknowledged", async () => {
    const job = await createAndWait(url, A, { sample: "INV-005" }, "mismatch-1");
    assert.deepEqual(job.review.blocking, ["TOTAL_MISMATCH"]);
    const blocked = await api(url, "POST", `/api/v1/jobs/${job.job_id}/approve`, { token: A, body: {} });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.error.code, "APPROVAL_BLOCKED");
    const ok = await api(url, "POST", `/api/v1/jobs/${job.job_id}/approve`, { token: A, body: { acknowledge: ["TOTAL_MISMATCH"] } });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json.approval.acknowledged, ["TOTAL_MISMATCH"]);
    assert.deepEqual(ok.json.job.review.blocking, []);
  });

  test("upload a text document, single-agent baseline", async () => {
    const text = "Faktura\nLeverantör: Testbolaget Ett AB\nFakturanummer: 77-001\nFakturadatum: 2026-10-01\nNetto: 100,00\nMoms: 25,00\nAtt betala: 125,00\nValuta: SEK\n";
    const job = await createAndWait(url, A, { document: { name: "my invoice.txt", text }, architecture: "single-agent" }, "upload-1");
    assert.equal(job.status, "succeeded");
    assert.equal(job.document.source, "upload");
    assert.equal(job.document.name, "my invoice.txt");
    assert.equal(job.architecture, "single-agent");
    assert.equal(job.review.extraction.architecture, "single-agent");
    for (const fname of SDK_FIELDS) {
      const fv = job.review.fields[fname];
      if (fv.value === null) assert.ok(fv.reason, `${fname} null has a reason`);
      else assert.ok(text.includes(fv.quote), `${fname} quote in text`);
    }
  });

  test("unknown routes and wrong methods", async () => {
    assert.equal((await api(url, "GET", "/api/v1/nope", { token: A })).json.error.code, "NOT_FOUND");
    const m = await api(url, "DELETE", "/api/v1/jobs", { token: A });
    assert.equal(m.status, 405);
    assert.equal(m.headers.get("allow"), "POST");
  });

  test("samples and me", async () => {
    const s = await api(url, "GET", "/api/v1/samples", { token: A });
    assert.equal(s.status, 200);
    assert.ok(s.json.samples.length >= 5);
    assert.ok(!("text" in s.json.samples[0]));
    const me = await api(url, "GET", "/api/v1/me", { token: B });
    assert.deepEqual({ id: me.json.user_id, test: me.json.test_user }, { id: "u_test_b", test: true });
  });

  test("structured log has no tokens and no document text", async () => {
    const marker = "ZEBRA-CANARY-4471 Hemlig Leverantör AB";
    const text = `${marker}\nFakturanummer: 1\nFakturadatum: 2026-10-01\nAtt betala: 5,00\n`;
    await createAndWait(url, A, { document: { name: "canary.txt", text }, architecture: "single-agent" }, "canary-1");
    await api(url, "GET", "/api/v1/jobs", { token: `${A}-wrong` });
    const log = readFileSync(app.logFile, "utf8");
    const lines = log.trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(lines.length > 20);
    assert.ok(lines.some((l) => l.event === "http_request" && l.route === "/api/v1/jobs/:id" && l.user_id === "u_test_a"));
    assert.ok(lines.some((l) => l.event === "job_event" && l.type === "step_checkpointed"));
    assert.ok(lines.some((l) => l.status === 401 && l.error_code === "UNAUTHENTICATED"));
    for (const secret of [A, B, "ers_test_", "ZEBRA-CANARY", "Hemlig", "Bearer"]) assert.ok(!log.includes(secret), `log contains ${secret}`);
  });
});

describe("rate limit and not-ready jobs", () => {
  test("429 with Retry-After per token; other users unaffected", async () => {
    const app = await startTestApp({ rateLimit: 3, rateWindowSeconds: 30 });
    try {
      const codes = [];
      for (let i = 0; i < 4; i++) codes.push(await api(app.url, "GET", "/api/v1/jobs", { token: A }));
      assert.deepEqual(codes.map((c) => c.status), [200, 200, 200, 429]);
      const limited = codes[3]!;
      assert.equal(limited.json.error.code, "RATE_LIMITED");
      const retry = Number(limited.headers.get("retry-after"));
      assert.ok(retry >= 1 && retry <= 30);
      assert.equal(limited.json.error.retry_after_seconds, retry);
      assert.equal(limited.headers.get("ratelimit-remaining"), "0");
      assert.equal(codes[0]!.headers.get("ratelimit-remaining"), "2");
      assert.equal((await api(app.url, "GET", "/api/v1/jobs", { token: B })).status, 200);
      assert.equal((await api(app.url, "GET", "/healthz")).status, 200, "health is not rate limited");
    } finally {
      await app.close();
    }
  });

  test("review actions on a job that has not finished give 409 JOB_NOT_READY", async () => {
    const app = await startTestApp({ stepDelayMs: 400 });
    try {
      const c = await api(app.url, "POST", "/api/v1/jobs", { token: A, body: { sample: "INV-001" }, headers: key("slow-1") });
      const r = await api(app.url, "POST", `/api/v1/jobs/${c.json.job_id}/approve`, { token: A, body: {} });
      assert.equal(r.status, 409);
      assert.equal(r.json.error.code, "JOB_NOT_READY");
      const v = await api(app.url, "GET", `/api/v1/jobs/${c.json.job_id}`, { token: A });
      assert.equal(v.json.review, null);
      await waitDone(app.url, A, c.json.job_id);
    } finally {
      await app.close();
    }
  });

  test("web build missing gives a clear 503, API still works", async () => {
    const app = await startTestApp({ webDist: "/nonexistent-dist" });
    try {
      const r = await api(app.url, "GET", "/");
      assert.equal(r.status, 503);
      assert.match(String(r.json), /npm run build/);
      assert.equal((await api(app.url, "GET", "/healthz")).json.web_build, false);
    } finally {
      await app.close();
    }
  });

  test("live mode without ANTHROPIC_API_KEY refuses to start with a clear message", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await assert.rejects(() => startTestApp({ extractionMode: "live" }), /needs ANTHROPIC_API_KEY/);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  test("test users are refused in production unless allowed", async () => {
    await assert.rejects(() => startTestApp({ production: true }), /test users/);
    const app = await startTestApp({ production: true, allowTestUsers: true });
    await app.close();
    assert.ok(!existsSync("/nonexistent-dist"));
  });
});
