# API v1

Base URL in the local demo: `http://127.0.0.1:8787`. Machine-readable description: [openapi.json](openapi.json), generated from the zod schemas in [sdk/src/schemas.ts](sdk/src/schemas.ts) (`npm run openapi`; a test fails if it is out of date). The server parses every response with those schemas before sending it, and the SDK parses every response it receives with them.

All bodies are JSON. The examples below are real responses from a local run (timestamps and ids differ per run; long arrays are shortened where marked).

## Authentication, limits, errors

- Every `/api/v1/*` route needs `Authorization: Bearer <token>`. In the local demo the tokens belong to two seeded **test users** (`u_test_a`, `u_test_b`); the tokens are public in `data/test-tokens.json`, and the server stores only their SHA-256 (`data/test-users.json`). `/healthz` needs no token.
- Rate limit: fixed window per user, default 120 requests per 60 s (`RATE_LIMIT`, `RATE_WINDOW_SECONDS`). Every authenticated response carries `ratelimit-limit`, `ratelimit-remaining`, `ratelimit-reset`. Over the limit: `429` with `Retry-After`.
- Every response has `x-request-id`; error bodies repeat it as `request_id`.

Error shape (always):

```json
{ "error": { "code": "INVALID_INPUT", "message": "request body failed validation", "request_id": "be04c9f52c32",
             "issues": [{ "path": "document.text", "message": "document text needs at least 20 characters" }] } }
```

| Status | `code` | When |
| --- | --- | --- |
| 400 | `INVALID_INPUT` | body fails the schema; `issues` lists each field path and message. Also a correction whose quote is not in the document. |
| 400 | `INVALID_JSON`, `MISSING_IDEMPOTENCY_KEY` | body is not JSON; `POST /jobs` without a usable `Idempotency-Key` |
| 401 | `UNAUTHENTICATED` | token missing, malformed or unknown (`WWW-Authenticate: Bearer`) |
| 404 | `JOB_NOT_FOUND` | unknown job **or another user's job**: the two answers are identical |
| 404 / 405 | `NOT_FOUND`, `METHOD_NOT_ALLOWED` | unknown route, wrong method (`Allow` header) |
| 409 | `IDEMPOTENCY_KEY_REUSED` | same key, different body; `job_id` is the existing job |
| 409 | `JOB_NOT_READY`, `APPROVAL_BLOCKED`, `NOT_APPROVED` | review action before the job succeeded; approval with unacknowledged error findings; export without a current approval |
| 413 | `BODY_TOO_LARGE` | body over 64 KiB |
| 429 | `RATE_LIMITED` | limit reached; `retry_after_seconds` and `Retry-After` |
| 500 | `INTERNAL` | server bug; the log has the request id, never the body |

## POST /api/v1/jobs: create a job

Headers: `Idempotency-Key` (required, 1 to 128 of `A-Z a-z 0-9 _ . : -`). Body: exactly one of `sample` or `document`; `architecture` defaults to `two-agent`.

```json
{ "sample": "INV-016" }
{ "document": { "name": "my invoice.txt", "text": "Faktura\nLeverantör: ...\n" }, "architecture": "single-agent" }
```

```
HTTP/1.1 201 Created
location: /api/v1/jobs/job_0a662fc54475
{"job_id":"job_0a662fc54475","status":"queued","created":true}
```

Same key and same body again (a retry): the existing job, nothing new is created.

```
HTTP/1.1 200 OK
{"job_id":"job_0a662fc54475","status":"queued","created":false}
```

Same key, different body:

```
HTTP/1.1 409 Conflict
{"error":{"code":"IDEMPOTENCY_KEY_REUSED","message":"this Idempotency-Key was already used with a different body; use a new key for a new job","request_id":"89f6280e91d1","job_id":"job_0a662fc54475"}}
```

Keys are scoped per user: user B sending user A's key creates B's own job and learns nothing about A's.

## GET /api/v1/jobs: list your jobs

```json
{"jobs":[{"job_id":"job_0a662fc54475","status":"succeeded","document_name":"INV-016.txt","review_state":"in_review","created_at":"2026-10-30T05:41:38.872Z"}]}
```

`review_state` is `null` until the job has succeeded, then `in_review`, `approved` or `exported`.

## GET /api/v1/jobs/{id}: job, steps, fields, findings

`status` is `queued`, `running`, `succeeded` or `failed`. `steps` come from the durable-jobs worker (one row per checkpointed step). `review` is `null` until the job has succeeded. `document_text` is included so a client can show where each quote is.

```json
{
  "job_id": "job_0a662fc54475",
  "status": "succeeded",
  "idempotency_key": "order-1",
  "architecture": "two-agent",
  "document": { "document_id": "doc_36c8c5fc5b096183", "name": "INV-016.txt", "source": "sample", "chars": 269, "sha256": "a3113814..." },
  "created_at": "2026-10-30T05:41:38.872Z",
  "updated_at": "2026-10-30T05:41:39.083Z",
  "steps": [
    { "name": "read_document",  "status": "done", "attempts": 1, "last_error": null, "started_at": "...", "finished_at": "..." },
    { "name": "extract_fields", "status": "done", "attempts": 1, "last_error": null, "started_at": "...", "finished_at": "..." },
    { "name": "open_review",    "status": "done", "attempts": 1, "last_error": null, "started_at": "...", "finished_at": "..." }
  ],
  "error": null,
  "review": {
    "state": "in_review",
    "blocking": [],
    "extraction": { "mode": "fixture", "architecture": "two-agent", "model": "fixture:planner + fixture:worker", "status": "completed", "model_calls": 19, "tool_calls": 9 },
    "fields": {
      "invoice_number": { "value": null, "quote": null, "reason": "no invoice_number found in the document", "source": "model",
                          "proposed": { "value": null, "quote": null, "reason": "no invoice_number found in the document" } },
      "total":          { "value": 12500, "quote": "12 500,00", "confidence": 0.9, "source": "model",
                          "proposed": { "value": 12500, "quote": "12 500,00", "confidence": 0.9 } },
      "...": "all nine fields: supplier, invoice_number, invoice_date, due_date, currency, net, vat, total, org_number"
    },
    "findings": [
      { "code": "TOTALS_NOT_CHECKABLE", "severity": "info", "message": "net + vat = total not checked, missing: net", "source": "validator" },
      { "code": "MISSING_VALUE", "severity": "warning", "field": "invoice_number", "message": "no value: no invoice_number found in the document", "source": "validator" }
    ],
    "proposal_findings": ["... findings on the model proposal as extracted"],
    "corrections": [],
    "approvals": [],
    "exported_at": null
  },
  "document_text": "Mälarö Måleri HB\nOrg nr 969712-4410\n\nFaktura 7731\n..."
}
```

`findings` come from the Python validator (`vendor/review-workflow/validator/validate.py`) run on the current draft; `blocking` lists error codes that still prevent approval. A non-null value always has a quote that is an exact substring of the document; a null value always has a reason.

A failed job has `status: "failed"`, `review: null` and `error: { code, message, transient, step, attempts }`.

## POST /api/v1/jobs/{id}/corrections

```json
{ "field": "invoice_number", "value": "7731", "quote": "Faktura 7731", "note": "optional" }
```

`value` is typed per field (dates `YYYY-MM-DD`, amounts as numbers, currency ISO 4217). `quote` must be an exact substring of the document, or `null` for a value typed without a source. `value: null` needs a `reason`. The reviewer is the authenticated user; the client cannot set it.

```
HTTP/1.1 201 Created
{ "correction": { "seq": 1, "ts": "2026-10-30T05:41:40.188Z", "reviewer": "u_test_a", "field": "invoice_number", "value": "7731", "quote": "Faktura 7731",
                  "previous": { "value": null, "source": "model" } },
  "job": { "...": "the Job, without document_text" } }
```

A quote that is not in the document:

```
HTTP/1.1 400 Bad Request
{"error":{"code":"INVALID_INPUT","message":"correction rejected","request_id":"ddc1a75d46af","issues":[{"path":"quote","message":"quote \"Invoice 7731\" is not an exact substring of the document"}]}}
```

Corrections are appended; the model's proposal (`fields.*.proposed`, and `proposal.json` on disk) is never changed.

## POST /api/v1/jobs/{id}/approve

```json
{ "acknowledge": ["TOTAL_MISMATCH"] }
```

`acknowledge` is optional: error codes the reviewer accepts as they are (for example a sum that really is wrong on the paper invoice). Without it, any error finding blocks:

```
HTTP/1.1 409 Conflict
{"error":{"code":"APPROVAL_BLOCKED","message":"cannot approve job_...: unresolved TOTAL_MISMATCH. Correct the fields or acknowledge the codes.","request_id":"..."}}
```

Success:

```json
{ "approval": { "ts": "2026-10-30T05:41:40.399Z", "reviewer": "u_test_a", "corrections_seen": 1, "acknowledged": [], "draft_sha256": "281f1885..." },
  "job": { "...": "review.state is now approved" } }
```

A correction made after an approval sets the state back to `in_review`.

## POST /api/v1/jobs/{id}/export

No body. Writes `<DATA_DIR>/exports/<user_id>/<job_id>.draft.json` on the server and returns it. Nothing is sent anywhere else.

Before approval, or after a later correction:

```
HTTP/1.1 409 Conflict
{"error":{"code":"NOT_APPROVED","message":"job_0a662fc54475 is not approved","request_id":"2e1caa4cf1e1"}}
```

Success (fields shortened to two):

```json
{
  "file": "exports/u_test_a/job_0a662fc54475.draft.json",
  "draft": {
    "kind": "local-draft",
    "note": "Local review export. Not booked, sent or filed anywhere.",
    "doc_id": "job_0a662fc54475",
    "doc_sha256": "a3113814f6b47f51bfe62e1e348027079cb11460e367448245dab011818babe2",
    "exported_at": "2026-10-30T05:41:40.417Z",
    "approved": { "ts": "2026-10-30T05:41:40.399Z", "reviewer": "u_test_a", "corrections_seen": 1, "acknowledged": [], "draft_sha256": "281f1885..." },
    "fields": {
      "invoice_number": { "value": "7731", "quote": "Faktura 7731", "source": "human" },
      "total": { "value": 12500, "quote": "12 500,00", "source": "model" }
    },
    "model_proposal": { "created_at": "2026-10-30T05:41:39.082Z", "architecture": "two-agent", "mode": "fixture", "model": "fixture:planner + fixture:worker", "fields": { "...": "nine fields as proposed" } },
    "corrections": [{ "seq": 1, "ts": "2026-10-30T05:41:40.188Z", "reviewer": "u_test_a", "field": "invoice_number", "value": "7731", "quote": "Faktura 7731", "previous": { "value": null, "source": "model" } }],
    "findings": [{ "code": "TOTALS_NOT_CHECKABLE", "severity": "info", "message": "net + vat = total not checked, missing: net", "source": "validator" }]
  }
}
```

## Other routes

| Route | Response |
| --- | --- |
| `GET /healthz` | `{"ok":true,"version":"0.1.0","extraction_mode":"fixture","web_build":true}` |
| `GET /api/v1/me` | `{"user_id":"u_test_a","name":"Test user A","test_user":true,"rate_limit":{"limit":120,"window_seconds":60}}` |
| `GET /api/v1/samples` | `{"samples":[{"id":"INV-001","name":"INV-001.txt","chars":661,"case":"complete Swedish invoice"}, ...]}` |
| `GET /` and any other path | the built React app (`web/dist`), with a SPA fallback to `index.html` |

## Rate limit example

```
HTTP/1.1 429 Too Many Requests
retry-after: 17
ratelimit-remaining: 0
{"error":{"code":"RATE_LIMITED","message":"rate limit of 3 requests per 30 s reached","request_id":"...","retry_after_seconds":17}}
```
