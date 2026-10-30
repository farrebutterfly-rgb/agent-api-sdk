# extract-review-sdk

Typed TypeScript client for the agent-api-sdk extraction and review API (v1). Every 2xx response is parsed with the zod schemas in [src/schemas.ts](src/schemas.ts) before you see it; every error becomes an `ApiError` with the server's code, message, field issues and request id. The same schemas are what the server validates its own responses with, and what `openapi.json` is generated from.

Works in Node 22+ and in the browser (the repo's React app uses it). Only dependency: `zod` 4.6.7. Not published to npm; it is a workspace package in this repo, consumed as TypeScript source (`tsx`, Vite or any bundler that compiles `.ts`).

## Use

```ts
import { ApiError, createClient } from "extract-review-sdk";

const api = createClient({ baseUrl: "http://127.0.0.1:8787", token: process.env.API_TOKEN! });

const { job_id, created } = await api.createJob({ sample: "INV-016" }, { idempotencyKey: "order-1" });
const job = await api.waitForJob(job_id, { onUpdate: (j) => console.log(j.status) });

for (const [name, f] of Object.entries(job.review!.fields)) console.log(name, f.value, f.quote ?? f.reason);

await api.correctField(job_id, { field: "invoice_number", value: "7731", quote: "Faktura 7731" });
await api.approve(job_id);                    // or { acknowledge: ["TOTAL_MISMATCH"] }
const { file, draft } = await api.exportDraft(job_id);

try {
  await api.getJob("job_000000000000");
} catch (e) {
  if (e instanceof ApiError) console.log(e.status, e.code, e.detail, e.issues, e.retryAfterSeconds);
}
```

A complete program is [examples/sdk-client.ts](../examples/sdk-client.ts) (`npm run example` against a running server).

## Methods

| Method | Route | Returns |
| --- | --- | --- |
| `health()` | `GET /healthz` (no token) | `Health` |
| `me()` | `GET /api/v1/me` | `Me` |
| `samples()` | `GET /api/v1/samples` | `SampleList` |
| `createJob(input, { idempotencyKey })` | `POST /api/v1/jobs` | `CreateJobResponse` (`created: false` on a replay) |
| `listJobs()` | `GET /api/v1/jobs` | `JobList` |
| `getJob(id)` | `GET /api/v1/jobs/:id` | `JobWithText` |
| `waitForJob(id, { timeoutMs, intervalMs, onUpdate, signal })` | polls `getJob` | final `JobWithText` (succeeded or failed), or `WaitTimeoutError` |
| `correctField(id, input)` | `POST /api/v1/jobs/:id/corrections` | `CorrectionResponse` |
| `approve(id, { acknowledge })` | `POST /api/v1/jobs/:id/approve` | `ApproveResponse` |
| `exportDraft(id)` | `POST /api/v1/jobs/:id/export` | `ExportResponse` |

## Errors

| Class | When |
| --- | --- |
| `ApiError` | non-2xx. `status`, `code` (`INVALID_INPUT`, `UNAUTHENTICATED`, `JOB_NOT_FOUND`, `RATE_LIMITED`, ... or `UNEXPECTED_RESPONSE` for a non-JSON error page), `detail`, `issues[]`, `requestId`, `retryAfterSeconds` (429), `jobId` (409 key reuse) |
| `ResponseShapeError` | 2xx whose body does not match the schema: the client refuses to hand back unvalidated data |
| `WaitTimeoutError` | `waitForJob` deadline passed |

The client does not retry on its own. `createJob` takes the idempotency key explicitly so that a retry you make after a timeout cannot create a second job.

## Options

`createClient({ baseUrl, token, fetch?, timeoutMs? })`: `fetch` lets you inject an implementation (tests use it to feed malformed bodies); `timeoutMs` (default 15000) applies per request.
