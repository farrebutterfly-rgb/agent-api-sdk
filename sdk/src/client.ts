import type { z } from "zod";
import {
  ApiErrorBody,
  ApproveResponse,
  CorrectionResponse,
  CreateJobResponse,
  ExportResponse,
  Health,
  JobList,
  JobWithText,
  Me,
  SampleList,
  type ApproveRequest,
  type CorrectionRequest,
  type CreateJobRequest,
  type ErrorCode,
  type Issue,
  type JobWithText as JobWithTextT,
} from "./schemas.ts";

/** The server answered with an error status. `code` is one of the documented ErrorCode values. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | "UNEXPECTED_RESPONSE",
    /** The server's message, without the status and code prefix. */
    readonly detail: string,
    readonly requestId: string | undefined,
    readonly issues: Issue[] = [],
    /** Set on 429: seconds until the rate-limit window resets (from Retry-After). */
    readonly retryAfterSeconds?: number,
    readonly jobId?: string,
  ) {
    super(`${status} ${code}: ${detail}`);
    this.name = "ApiError";
  }
}

/** The server answered 2xx, but the body does not match the documented schema. */
export class ResponseShapeError extends Error {
  constructor(readonly path: string, readonly issues: Issue[]) {
    super(`response from ${path} does not match the API schema: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
    this.name = "ResponseShapeError";
  }
}

export class WaitTimeoutError extends Error {
  constructor(readonly jobId: string, readonly lastStatus: string, timeoutMs: number) {
    super(`job ${jobId} still ${lastStatus} after ${timeoutMs} ms`);
    this.name = "WaitTimeoutError";
  }
}

export interface ClientOptions {
  /** For example http://127.0.0.1:8787. No trailing /api. */
  baseUrl: string;
  /** API token, sent as Authorization: Bearer. */
  token: string;
  /** Inject a fetch implementation (tests, proxies). Default: globalThis.fetch. */
  fetch?: typeof fetch;
  /** Per-request timeout. Default 15000 ms. */
  timeoutMs?: number;
}

export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  /** Called with every polled state, including the final one. */
  onUpdate?: (job: JobWithTextT) => void;
  signal?: AbortSignal;
}

const toIssues = (e: z.ZodError): Issue[] => e.issues.map((i) => ({ path: i.path.join(".") || "(root)", message: i.message }));

/**
 * Typed client for the v1 API. Every 2xx body is parsed with the zod schema from schemas.ts;
 * every non-2xx becomes an ApiError with the server's code, message, issues and request id.
 */
export class ExtractReviewClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: ClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  private async request<S extends z.ZodType>(schema: S, method: string, path: string, init: { body?: unknown; headers?: Record<string, string>; auth?: boolean } = {}): Promise<z.infer<S>> {
    const headers: Record<string, string> = { accept: "application/json", ...init.headers };
    if (init.auth !== false) headers.authorization = `Bearer ${this.opts.token}`;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const requestId = res.headers.get("x-request-id") ?? undefined;
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      throw new ApiError(res.status, "UNEXPECTED_RESPONSE", `body is not JSON: ${text.slice(0, 120)}`, requestId);
    }
    if (!res.ok) {
      const parsed = ApiErrorBody.safeParse(json);
      if (!parsed.success) throw new ApiError(res.status, "UNEXPECTED_RESPONSE", `error body does not match the API schema: ${text.slice(0, 200)}`, requestId);
      const e = parsed.data.error;
      const retryHeader = Number(res.headers.get("retry-after"));
      throw new ApiError(res.status, e.code, e.message, e.request_id, e.issues ?? [], e.retry_after_seconds ?? (Number.isFinite(retryHeader) && retryHeader > 0 ? retryHeader : undefined), e.job_id);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new ResponseShapeError(`${method} ${path}`, toIssues(parsed.error));
    return parsed.data;
  }

  /** GET /healthz (no token needed). */
  health() {
    return this.request(Health, "GET", "/healthz", { auth: false });
  }

  me() {
    return this.request(Me, "GET", "/api/v1/me");
  }

  samples() {
    return this.request(SampleList, "GET", "/api/v1/samples");
  }

  /**
   * POST /api/v1/jobs. Reusing an idempotencyKey with the same body returns the same job
   * (created: false); with a different body it fails with 409 IDEMPOTENCY_KEY_REUSED.
   */
  createJob(input: CreateJobRequest, opts: { idempotencyKey: string }) {
    return this.request(CreateJobResponse, "POST", "/api/v1/jobs", { body: input, headers: { "idempotency-key": opts.idempotencyKey } });
  }

  listJobs() {
    return this.request(JobList, "GET", "/api/v1/jobs");
  }

  getJob(jobId: string) {
    return this.request(JobWithText, "GET", `/api/v1/jobs/${encodeURIComponent(jobId)}`);
  }

  /** Poll until the job is succeeded or failed. Resolves with the final job either way. */
  async waitForJob(jobId: string, opts: WaitOptions = {}): Promise<JobWithTextT> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const intervalMs = opts.intervalMs ?? 250;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = await this.getJob(jobId);
      opts.onUpdate?.(job);
      if (job.status === "succeeded" || job.status === "failed") return job;
      if (Date.now() + intervalMs > deadline) throw new WaitTimeoutError(jobId, job.status, timeoutMs);
      if (opts.signal?.aborted) throw opts.signal.reason;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  /** Record a human correction. The model's proposal stays as it was; the reviewer is the token's user. */
  correctField(jobId: string, input: CorrectionRequest) {
    return this.request(CorrectionResponse, "POST", `/api/v1/jobs/${encodeURIComponent(jobId)}/corrections`, { body: input });
  }

  approve(jobId: string, input: ApproveRequest = {}) {
    return this.request(ApproveResponse, "POST", `/api/v1/jobs/${encodeURIComponent(jobId)}/approve`, { body: input });
  }

  /** Writes the approved local draft on the server and returns it. Fails with 409 NOT_APPROVED if a correction came after the last approval. */
  exportDraft(jobId: string) {
    return this.request(ExportResponse, "POST", `/api/v1/jobs/${encodeURIComponent(jobId)}/export`, { body: {} });
  }
}

export const createClient = (opts: ClientOptions) => new ExtractReviewClient(opts);
