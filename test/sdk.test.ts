import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { ApiError, createClient, FIELD_NAMES, ResponseShapeError, WaitTimeoutError, type JobWithText } from "extract-review-sdk";
import { spawnServer, TOKENS, type Spawned } from "./helpers.ts";

describe("SDK against a spawned server process", () => {
  let srv: Spawned;
  before(async () => {
    srv = await spawnServer({ STEP_DELAY_MS: "60" });
  });
  after(() => srv.stop());

  test("completes a job: create (twice), wait, correct, approve, export", async () => {
    const c = createClient({ baseUrl: srv.url, token: TOKENS.a });
    assert.equal((await c.health()).ok, true);
    const first = await c.createJob({ sample: "INV-016" }, { idempotencyKey: "sdk-1" });
    const again = await c.createJob({ sample: "INV-016" }, { idempotencyKey: "sdk-1" });
    assert.equal(first.created, true);
    assert.equal(again.created, false);
    assert.equal(again.job_id, first.job_id);

    const seen = new Set<string>();
    const job = await c.waitForJob(first.job_id, { intervalMs: 20, onUpdate: (j) => seen.add(j.status) });
    assert.equal(job.status, "succeeded");
    assert.ok(seen.has("running") || seen.has("queued"), `saw ${[...seen]}`);
    assert.ok(job.review);
    for (const f of FIELD_NAMES) {
      const d = job.review.fields[f];
      if (d.value !== null) assert.ok(job.document_text.includes(d.quote!), f);
      else assert.ok(d.reason, f);
    }

    const r = await c.correctField(first.job_id, { field: "invoice_number", value: "7731", quote: "Faktura 7731", note: "sdk test" });
    assert.equal(r.correction.seq, 1);
    assert.equal(r.job.review?.fields.invoice_number.source, "human");
    const ap = await c.approve(first.job_id);
    assert.equal(ap.job.review?.state, "approved");
    const ex = await c.exportDraft(first.job_id);
    assert.equal(ex.draft.kind, "local-draft");
    assert.equal(ex.draft.fields.invoice_number.value, "7731");
    assert.equal(ex.draft.corrections.length, 1);
    const list = await c.listJobs();
    assert.equal(list.jobs.find((j) => j.job_id === first.job_id)?.review_state, "exported");
  });

  test("typed errors: 400 issues, 401, 404 for another user, 409 key reuse", async () => {
    const a = createClient({ baseUrl: srv.url, token: TOKENS.a });
    const b = createClient({ baseUrl: srv.url, token: TOKENS.b });
    const bad = createClient({ baseUrl: srv.url, token: "ers_test_not_a_real_token_123" });

    const e400 = await a.createJob({ document: { name: "x.txt", text: "too short" } }, { idempotencyKey: "sdk-bad" }).catch((e) => e);
    assert.ok(e400 instanceof ApiError);
    assert.equal(e400.status, 400);
    assert.equal(e400.code, "INVALID_INPUT");
    assert.equal(e400.issues[0]?.path, "document.text");
    assert.match(e400.requestId ?? "", /^[0-9a-f]{12}$/);

    const e401 = await bad.listJobs().catch((e) => e);
    assert.ok(e401 instanceof ApiError);
    assert.equal(e401.status, 401);
    assert.equal(e401.code, "UNAUTHENTICATED");

    const job = await a.createJob({ sample: "INV-001" }, { idempotencyKey: "sdk-own" });
    const e404 = await b.getJob(job.job_id).catch((e) => e);
    assert.ok(e404 instanceof ApiError);
    assert.equal(e404.status, 404);
    assert.equal(e404.code, "JOB_NOT_FOUND");

    const e409 = await a.createJob({ sample: "INV-003" }, { idempotencyKey: "sdk-own" }).catch((e) => e);
    assert.ok(e409 instanceof ApiError);
    assert.equal(e409.code, "IDEMPOTENCY_KEY_REUSED");
    assert.equal(e409.jobId, job.job_id);
    await a.waitForJob(job.job_id);
  });

  test("waitForJob times out with a typed error", async () => {
    const a = createClient({ baseUrl: srv.url, token: TOKENS.a });
    const job = await a.createJob({ sample: "INV-010" }, { idempotencyKey: "sdk-wait" });
    const e = await a.waitForJob(job.job_id, { timeoutMs: 30, intervalMs: 20 }).catch((x) => x);
    assert.ok(e instanceof WaitTimeoutError, String(e));
    await a.waitForJob(job.job_id);
  });
});

describe("SDK rate limit and response validation", () => {
  test("429 becomes ApiError with retryAfterSeconds", async () => {
    const srv = await spawnServer({ RATE_LIMIT: "2", RATE_WINDOW_SECONDS: "20" });
    try {
      const a = createClient({ baseUrl: srv.url, token: TOKENS.a });
      await a.me();
      await a.me();
      const e = await a.me().catch((x) => x);
      assert.ok(e instanceof ApiError);
      assert.equal(e.status, 429);
      assert.equal(e.code, "RATE_LIMITED");
      assert.ok(e.retryAfterSeconds! >= 1 && e.retryAfterSeconds! <= 20);
    } finally {
      await srv.stop();
    }
  });

  test("a 2xx body that breaks the schema is rejected, not passed on", async () => {
    const fake: typeof fetch = async () => new Response(JSON.stringify({ job_id: "job_1", status: "done-ish", created: true }), { status: 201, headers: { "content-type": "application/json" } });
    const c = createClient({ baseUrl: "http://unused", token: "t".repeat(20), fetch: fake });
    const e = await c.createJob({ sample: "INV-001" }, { idempotencyKey: "k" }).catch((x) => x);
    assert.ok(e instanceof ResponseShapeError);
    assert.equal(e.issues[0]?.path, "status");
  });

  test("a non-JSON error page becomes UNEXPECTED_RESPONSE", async () => {
    const fake: typeof fetch = async () => new Response("<html>bad gateway</html>", { status: 502 });
    const c = createClient({ baseUrl: "http://unused", token: "t".repeat(20), fetch: fake });
    const e = await c.listJobs().catch((x) => x);
    assert.ok(e instanceof ApiError);
    assert.equal(e.status, 502);
    assert.equal(e.code, "UNEXPECTED_RESPONSE");
  });
});

describe("restart recovery through the API", () => {
  test("server killed mid-job; a new server process on the same data finishes it without re-running done steps", async () => {
    const first = await spawnServer({ STEP_DELAY_MS: "700", LEASE_MS: "800" });
    const c1 = createClient({ baseUrl: first.url, token: TOKENS.a });
    const { job_id } = await c1.createJob({ sample: "INV-001" }, { idempotencyKey: "crash-1" });
    let j: JobWithText;
    for (;;) {
      j = await c1.getJob(job_id);
      if (j.steps[0]?.status === "done") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    await first.stop("SIGKILL");
    const second = await spawnServer({ STEP_DELAY_MS: "0", LEASE_MS: "800" }, first.dataDir);
    try {
      const c2 = createClient({ baseUrl: second.url, token: TOKENS.a });
      const done = await c2.waitForJob(job_id, { timeoutMs: 15_000, intervalMs: 50 });
      assert.equal(done.status, "succeeded");
      assert.equal(done.steps[0]?.attempts, 1, "read_document resumed from its checkpoint, not re-run");
      assert.ok(done.review);
      const replay = await c2.createJob({ sample: "INV-001" }, { idempotencyKey: "crash-1" });
      assert.deepEqual(replay, { job_id, status: "succeeded", created: false });
    } finally {
      await second.stop();
    }
  });
});
