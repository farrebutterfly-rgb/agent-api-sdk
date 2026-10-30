/**
 * Writes openapi.json from the same zod schemas the server validates its responses with and the
 * SDK parses them with. `--check` exits 1 if the committed file is out of date (used by a test).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import * as S from "extract-review-sdk";
import { ROOT, VERSION } from "../server/config.ts";

const schemas = {
  CreateJobRequest: S.CreateJobRequest,
  CreateJobResponse: S.CreateJobResponse,
  CorrectionRequest: S.CorrectionRequest,
  CorrectionResponse: S.CorrectionResponse,
  ApproveRequest: S.ApproveRequest,
  ApproveResponse: S.ApproveResponse,
  ExportResponse: S.ExportResponse,
  Job: S.Job,
  JobWithText: S.JobWithText,
  JobList: S.JobList,
  SampleList: S.SampleList,
  Me: S.Me,
  Health: S.Health,
  Error: S.ApiErrorBody,
};
const components = Object.fromEntries(Object.entries(schemas).map(([k, v]) => [k, z.toJSONSchema(v, { io: k.endsWith("Request") ? "input" : "output", unrepresentable: "any" })]));
for (const c of Object.values(components)) delete (c as Record<string, unknown>).$schema;

const ref = (n: keyof typeof schemas) => ({ $ref: `#/components/schemas/${n}` });
const json = (n: keyof typeof schemas, description: string) => ({ description, content: { "application/json": { schema: ref(n) } } });
const err = (description: string) => json("Error", description);
const common = { "401": err("missing or unknown token (UNAUTHENTICATED)"), "429": { ...err("rate limit reached (RATE_LIMITED); see Retry-After"), headers: { "Retry-After": { schema: { type: "integer" }, description: "seconds until the window resets" } } } };
const jobId = { name: "id", in: "path", required: true, schema: { type: "string", pattern: "^job_[0-9a-f]{12}$" } };
const notFound = { "404": err("unknown job, or a job of another user (JOB_NOT_FOUND); the two are indistinguishable") };
const body = (n: keyof typeof schemas) => ({ required: true, content: { "application/json": { schema: ref(n) } } });

const doc = {
  openapi: "3.1.0",
  info: { title: "agent-api-sdk extraction and review API", version: VERSION, description: "Document extraction with human review. Every error body has the Error shape. Test auth: Bearer tokens of seeded test users (see README). Responses are validated against these schemas by the server before they are sent." },
  servers: [{ url: "http://127.0.0.1:8787", description: "local demo" }],
  security: [{ bearer: [] }],
  paths: {
    "/healthz": { get: { summary: "Liveness and build info", security: [], responses: { "200": json("Health", "server is up") } } },
    "/api/v1/me": { get: { summary: "The authenticated user", responses: { "200": json("Me", "user and rate limit"), ...common } } },
    "/api/v1/samples": { get: { summary: "Sample documents", responses: { "200": json("SampleList", "samples (no text)"), ...common } } },
    "/api/v1/jobs": {
      post: {
        summary: "Create an extraction job",
        parameters: [{ name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", pattern: "^[A-Za-z0-9_.:-]{1,128}$" }, description: "Same key and body returns the existing job (200, created false). Same key, other body: 409. Keys are scoped per user." }],
        requestBody: body("CreateJobRequest"),
        responses: { "201": json("CreateJobResponse", "job created"), "200": json("CreateJobResponse", "replay of the same key and body"), "400": err("INVALID_INPUT with issues, INVALID_JSON or MISSING_IDEMPOTENCY_KEY"), "409": err("IDEMPOTENCY_KEY_REUSED with job_id"), "413": err("BODY_TOO_LARGE"), ...common },
      },
      get: { summary: "List your jobs (newest first, max 100)", responses: { "200": json("JobList", "jobs of the authenticated user"), ...common } },
    },
    "/api/v1/jobs/{id}": { get: { summary: "Get a job with steps, document text and review", parameters: [jobId], responses: { "200": json("JobWithText", "the job"), ...notFound, ...common } } },
    "/api/v1/jobs/{id}/corrections": { post: { summary: "Record a human correction", parameters: [jobId], requestBody: body("CorrectionRequest"), responses: { "201": json("CorrectionResponse", "correction stored; the model proposal is unchanged"), "400": err("INVALID_INPUT: unknown field, wrong type, quote not in the document, null without reason"), "409": err("JOB_NOT_READY"), ...notFound, ...common } } },
    "/api/v1/jobs/{id}/approve": { post: { summary: "Approve the current draft", parameters: [jobId], requestBody: body("ApproveRequest"), responses: { "200": json("ApproveResponse", "approved"), "409": err("APPROVAL_BLOCKED (unacknowledged error findings) or JOB_NOT_READY"), ...notFound, ...common } } },
    "/api/v1/jobs/{id}/export": { post: { summary: "Write and return the approved local draft", parameters: [jobId], responses: { "200": json("ExportResponse", "draft written under the server data directory"), "409": err("NOT_APPROVED (never approved, or corrected after the last approval) or JOB_NOT_READY"), ...notFound, ...common } } },
  },
  components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } }, schemas: components },
};

const out = JSON.stringify(doc, null, 2) + "\n";
const file = join(ROOT, "openapi.json");
if (process.argv.includes("--check")) {
  let current = "";
  try { current = readFileSync(file, "utf8"); } catch { /* missing */ }
  if (current !== out) {
    console.error("openapi.json is out of date: run npm run openapi");
    process.exit(1);
  }
  console.log("openapi.json is up to date");
} else {
  writeFileSync(file, out);
  console.log(`wrote ${file} (${Object.keys(doc.paths).length} paths, ${Object.keys(components).length} schemas)`);
}
