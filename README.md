# agent-api-sdk

Document extraction with human review, as a small complete web product. Pick a sample invoice or upload a text file, start a job, watch its steps, read every extracted field next to the exact text it came from and the Python validator's findings, correct a field, approve, and export a local draft. The same HTTP API is used by a React review UI, a typed TypeScript SDK, and a tiny Python client. Access is checked on the backend with per-user tokens, every token is rate limited, and the structured log never contains a token or a document body.

It joins two earlier projects as versioned parts: the planner/worker extraction, Python validator and review store from **review-workflow**, and the checkpointed job worker from **durable-jobs**.

## Three things kept apart

| | Status |
| --- | --- |
| **Local demo** | Works from a clean checkout with fixtures and no API key: `make install && make demo`, or `make serve` and open http://127.0.0.1:8787. |
| **Deployment-ready package** | Prepared, not deployed: [Dockerfile](Dockerfile) (Node 22, Python 3, built UI, non-root, `/data` volume, health check) and [scripts/smoke.sh](scripts/smoke.sh), which checks `/healthz`, a 401 for a bad token and one complete job against any base URL. The smoke script has been run against the local server only. The image has **not** been built here (no Docker daemon in the build environment). |
| **Verified public URL** | **None.** Nothing has been deployed. Do not read the Dockerfile as cloud experience. |

## Quick start

Node 22.13 or later (built-in `node:sqlite`), Python 3.10 or later on `PATH` (standard library only).

```bash
make install     # npm ci (pinned, workspaces: sdk, web) + vite build of the UI
make demo        # start server, run the SDK example and the Python client, stop server
make serve       # API + UI on http://127.0.0.1:8787; sign in with a token from data/test-tokens.json
make test        # 20 Python tests + 37 TypeScript tests (API, SDK on a spawned server, end to end; the browser test skips)
make test-ui     # Playwright browser test (needs playwright + Chromium; skipped in make test)
make check       # typecheck + build + test + demo
```

The tokens in `data/test-tokens.json` are **public test tokens** for two seeded test users. They exist to exercise the access checks and protect nothing. Use another interpreter with `make test PYTHON=python3.10`.

Live extraction with a real model (costs money, not run in this repo):

```bash
export ANTHROPIC_API_KEY=...
make live        # EXTRACTION_MODE=live; without the key the server exits with code 2 and says why
```

## What the demo shows

Excerpt from the recorded run of `make demo` (job ids and keys differ per run; full output in `evidence/demo-*.log`, server log in `evidence/demo-server-*.jsonl`):

```
create INV-016  key=sdk-example-70e5dba7  -> job_775187afaf0d created=true
create INV-016  key=sdk-example-70e5dba7  -> job_775187afaf0d created=false  (same job: true)
  status queued    read_document=pending extract_fields=pending open_review=pending
  status running   read_document=running extract_fields=pending open_review=pending
  status running   read_document=done extract_fields=running open_review=pending
  status running   read_document=done extract_fields=done open_review=running
  status succeeded read_document=done extract_fields=done open_review=done

fields (two-agent, fixture, 19 model calls)
  supplier        null                   model  reason: no supplier found in the document
  invoice_number  null                   model  reason: no invoice_number found in the document
  invoice_date    "2026-09-30"           model  quote: "2026-09-30"
  net             null                   model  reason: no net found in the document
  total           12500                  model  quote: "12 500,00"
  ...
validator findings:
  info    TOTALS_NOT_CHECKABLE: net + vat = total not checked, missing: net
  warning MISSING_VALUE (supplier): no value: no supplier found in the document
  ...

corrections
  #1 supplier: null -> "Mälarö Måleri HB"  quote "Mälarö Måleri HB"  by u_test_a
  #2 invoice_number: null -> "7731"  quote "Faktura 7731"  by u_test_a
  #3 net: null -> 10000  quote "10 000,00"  by u_test_a

approved by u_test_a after 3 corrections; review state approved
exported exports/u_test_a/job_775187afaf0d.draft.json
  draft fields from the model: 6, from the reviewer: 3 (supplier, invoice_number, net)
  model proposal kept unchanged in the export: 3 fields still null there
  remaining validator findings: none

second user reads job_775187afaf0d: 404 JOB_NOT_FOUND "no job job_775187afaf0d for this user"
empty create request: 400 INVALID_INPUT (root): send exactly one of sample or document
...
server stopped. structured log: 51 lines in evidence/demo-server-2026-10-30.jsonl; token or document-text occurrences: 0
```

The browser test drives the same flow in the UI (screenshots in `evidence/ui/`): a job created by the SDK is corrected and approved in the browser, exported as a download, and read back by the SDK; a job started in the browser runs through its steps; user B opening user A's job sees `404 JOB_NOT_FOUND`. A walkthrough to present is in [DEMO.md](DEMO.md).

## How it works

```
 browser (React 19, web/dist)      examples/sdk-client.ts       examples/python_client.py
        \  extract-review-sdk          /  extract-review-sdk           /  urllib
         \  (zod-validated client)    /                               /
          +--------------------------+-------------------------------+
                                     | HTTPS/HTTP, Authorization: Bearer <token>
                                     v
 server/app.ts  (node:http)
   /healthz                                       no auth
   /api/v1/*   1. auth: SHA-256(token) vs data/test-users.json, timingSafeEqual  else 401
               2. rate limit: fixed window per user                           else 429 + Retry-After
               3. route, zod-parse body                                       else 400 + issues
               4. ownership: job payload user_id == caller                    else 404 (same as unknown)
               5. respond, after parsing the body with the published schema (sdk/src/schemas.ts)
   /*          static web/dist with SPA fallback, CSP
   log         JSON lines, allowlisted keys only: route, status, user_id, job_id, step, error code
                                     |
   POST /jobs  -> documents table (text, per user) + vendor/durable-jobs submitJob(key "<user>:<Idempotency-Key>")
                                     |
 vendor/durable-jobs runWorker (in process, lease + heartbeat, checkpoint per step, bounded retries)
   read_document   load the document, check owner
   extract_fields  vendor/review-workflow runExtraction (planner/worker or single agent; fixture or live)
                       \-> validator/validate.py (Python, child process): types, quotes, net+vat=total, dates, missing
   open_review     ReviewStore.propose: proposal.json written once (idempotent on re-run)
                                     |
   GET /jobs/:id      Job = JobView (steps, status) + document + review (draft, findings, corrections, approvals)
   POST corrections   ReviewStore.correct  -> corrections.jsonl (append; reviewer = token's user)
   POST approve       ReviewStore.approve  -> approvals.jsonl  (blocked by error findings unless acknowledged)
   POST export        ReviewStore.export   -> <DATA_DIR>/exports/<user>/<job>.draft.json
```

| Path | Role |
| --- | --- |
| `server/app.ts` | HTTP routes, auth and rate-limit order, error mapping, static files, in-process worker. |
| `server/auth.ts` | Users file (hashes only), constant-time token check, refuses test users in production. |
| `server/rateLimit.ts`, `server/log.ts` | Fixed-window limiter; allowlist JSON-lines logger. |
| `server/pipeline.ts` | The three job steps, built on the vendored review-workflow and durable-jobs code. |
| `server/views.ts` | Ownership check and the public `Job` view (durable-jobs `JobView` + review-workflow review state). |
| `server/documents.ts` | Documents and exports tables in the same SQLite file. |
| `sdk/` | `extract-review-sdk`: zod schemas (the API contract), typed client, [its own README](sdk/README.md). |
| `web/` | React 19 + Vite review UI; talks to the API only through the SDK. |
| `vendor/review-workflow/`, `vendor/durable-jobs/` | Unmodified copies at recorded commits, each with `VENDORED.md`. `scripts/check-vendor.sh` verifies them. |
| `examples/` | `sdk-client.ts` (complete job via the SDK), `python_client.py` (stdlib client). |
| `scripts/` | `demo.ts`, `smoke.sh`, `gen-openapi.ts`, `check-vendor.sh`, `new-token.ts`, `record-tests.sh`. |
| `test/` | `api` (in-process server), `sdk` (spawned server, including SIGKILL restart), `e2e` (web build, examples, smoke, log), `unit`, `ui.playwright` (PLAYWRIGHT=1). |
| `API.md`, `openapi.json` | API description with real request and response JSON; OpenAPI 3.1 generated from the zod schemas. |
| `data/` | Seven synthetic sample invoices from review-workflow and the test users. See [data/README.md](data/README.md). |

## API in one screen

Full description with real responses: [API.md](API.md). Machine-readable: [openapi.json](openapi.json).

| Route | Purpose | Errors |
| --- | --- | --- |
| `POST /api/v1/jobs` + `Idempotency-Key` | create a job from `{sample}` or `{document: {name, text}}` | 400 issues, 401, 409 key reused, 413, 429 |
| `GET /api/v1/jobs` | your jobs | 401, 429 |
| `GET /api/v1/jobs/:id` | steps, status, fields with quotes, findings, review state, document text | 401, 404, 429 |
| `POST /api/v1/jobs/:id/corrections` | `{field, value, quote, reason?}` | 400 (type, quote not in document), 404, 409 not ready |
| `POST /api/v1/jobs/:id/approve` | `{acknowledge?: [codes]}` | 404, 409 blocked |
| `POST /api/v1/jobs/:id/export` | write and return the local draft JSON | 404, 409 not approved |

## SDK example

```ts
import { ApiError, createClient } from "extract-review-sdk";

const api = createClient({ baseUrl: "http://127.0.0.1:8787", token: process.env.API_TOKEN! });
const { job_id } = await api.createJob({ sample: "INV-016" }, { idempotencyKey: "order-1" });
const job = await api.waitForJob(job_id);
console.log(job.review!.fields.total);          // { value: 12500, quote: "12 500,00", source: "model", ... }
await api.correctField(job_id, { field: "invoice_number", value: "7731", quote: "Faktura 7731" });
await api.approve(job_id);
const { draft } = await api.exportDraft(job_id);
```

Errors arrive as `ApiError` (`status`, `code`, `detail`, `issues`, `retryAfterSeconds`); a 2xx body that does not match the schema is a `ResponseShapeError`. More in [sdk/README.md](sdk/README.md); a complete program is [examples/sdk-client.ts](examples/sdk-client.ts).

## Deployment-ready package (not deployed)

```bash
make docker-build                                    # docker build -t agent-api-sdk:0.1.0 .
node --import tsx scripts/new-token.ts users.json u_ops_1 "Ops user"     # prints a token once, stores its hash
docker run -p 8787:8787 -v "$PWD/users.json:/app/users.json:ro" -e USERS_FILE=/app/users.json -v agent-data:/data agent-api-sdk:0.1.0
API_TOKEN=<token> make smoke BASE_URL=http://127.0.0.1:8787
```

In the image `NODE_ENV=production`, so the server refuses the public test users unless `ALLOW_TEST_USERS=1` is set for a throwaway demo. State is one SQLite file plus review files under `/data`: run one instance (the rate limit and the worker are per process). A public URL may be claimed only after `scripts/smoke.sh` has passed against it.

## Tests and evidence

- `evidence/test-*.log`: `make test` output (Python validator tests, then all TypeScript suites), first line a session record with code revision, dataset version, Node and Python versions.
- `evidence/test-ui-*.log` and `evidence/ui/*.png`: the Playwright run.
- `evidence/demo-*.log`, `evidence/demo-server-*.jsonl`: `make demo` output and the server's structured log of that run.

## What this proves and what it does not

- Proven locally by tests: a browser and an SDK complete the same job through one API; invalid input gives 400 with field paths, a missing or wrong token 401, another user's job and an unknown job the same 404, the rate limit 429 with `Retry-After`; an Idempotency-Key replay does not create a second job (also under 6 parallel requests) and keys do not cross users; a server killed with SIGKILL mid-job is finished by the next server process without re-running the done step; the log of a run contains no token and no document text.
- TypeScript (server, SDK), React (UI) and Python (validator in every job, plus a client) each do real work in the flow.
- The extraction is review-workflow's scripted fixture model over hand-written reading rules. It proves the workflow, the guards and the review loop, not extraction quality. Live mode exists as code and has not been run ([ACCEPTANCE.md](ACCEPTANCE.md)).
- The auth is test auth: seeded users and bearer tokens, hashed at rest. No OAuth, sign-up, sessions or roles.
- Single process: one worker, an in-memory rate limit. Several instances are not supported or claimed.
- No deployment, no cloud, no public URL. All data is synthetic ([data/README.md](data/README.md)).

Design trade-offs are in [DECISIONS.md](DECISIONS.md).

Built with AI assistance (Claude); every change is reviewed and run locally.
