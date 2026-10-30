import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, relative, resolve, sep } from "node:path";
import {
  ApiErrorBody,
  ApproveRequest,
  ApproveResponse,
  CorrectionRequest,
  CorrectionResponse,
  CreateJobRequest,
  CreateJobResponse,
  ExportResponse,
  Health,
  JobList,
  JobWithText,
  Me,
  SampleList,
  type ErrorCode,
  type Issue,
} from "extract-review-sdk";
import type { z } from "zod";
import { IdempotencyConflictError } from "../vendor/durable-jobs/src/errors.ts";
import { createJobStore, submitJob, type JobStore, type StoredEvent } from "../vendor/durable-jobs/src/store.ts";
import { runWorker } from "../vendor/durable-jobs/src/worker.ts";
import { ReviewStore } from "../vendor/review-workflow/src/index.ts";
import { ReviewError } from "../vendor/review-workflow/src/review/store.ts";
import { Authenticator, type User } from "./auth.ts";
import { VERSION, type Config } from "./config.ts";
import { P8_SCHEMA, putDocument, recordExport } from "./documents.ts";
import { Logger } from "./log.ts";
import { extractionHandlers, STEPS, type JobPayload } from "./pipeline.ts";
import { FixedWindowLimiter } from "./rateLimit.ts";
import { scopedKey, Views } from "./views.ts";

const MAX_BODY = 64 * 1024;

/** An error that becomes a JSON error response. Messages must never contain tokens or document text. */
class HttpError extends Error {
  constructor(readonly status: number, readonly code: ErrorCode, message: string, readonly extra: { issues?: Issue[]; job_id?: string; retry_after_seconds?: number } = {}, readonly headers: Record<string, string> = {}) {
    super(message);
  }
}

const issuesOf = (e: z.ZodError): Issue[] => e.issues.map((i) => ({ path: i.path.join(".") || "(root)", message: i.message }));

function parseBody<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  const r = schema.safeParse(raw);
  if (!r.success) throw new HttpError(400, "INVALID_INPUT", "request body failed validation", { issues: issuesOf(r.error) });
  return r.data;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let tooBig = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) tooBig = true;
      else chunks.push(c);
    });
    req.on("end", () => {
      if (tooBig) return reject(new HttpError(413, "BODY_TOO_LARGE", `request body over ${MAX_BODY} bytes`));
      const s = Buffer.concat(chunks).toString("utf8");
      if (s.trim() === "") return resolveBody({});
      try {
        resolveBody(JSON.parse(s));
      } catch {
        reject(new HttpError(400, "INVALID_JSON", "request body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};
const CSP = "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'";

/** Sample documents and the case each one tests (from data/README.md). */
const SAMPLE_CASES: Record<string, string> = {
  "INV-001": "complete Swedish invoice",
  "INV-003": "no due date, only payment terms",
  "INV-005": "net + vat does not equal total (on paper)",
  "INV-006": "ambiguous dates 03/04/2026",
  "INV-010": "currency only \"kr\", dotted dates",
  "INV-013": "credit note with negative amounts",
  "INV-016": "invoice number without a label, net under \"Summa\"",
};

export interface App {
  url: string;
  server: Server;
  store: JobStore;
  close(): Promise<void>;
}

/** Start the HTTP API, the static web build and one in-process durable-jobs worker. */
export async function startApp(config: Config): Promise<App> {
  const log = new Logger(config.logFile, !config.quiet);
  const auth = new Authenticator(config.usersFile, { production: config.production, allowTestUsers: config.allowTestUsers });
  if (config.extractionMode === "live" && !process.env.ANTHROPIC_API_KEY) {
    throw new Error("EXTRACTION_MODE=live needs ANTHROPIC_API_KEY. Live mode calls the real API and costs money; the default fixture mode does not.");
  }
  const store = createJobStore(join(config.dataDir, "jobs.db"));
  store.db.exec(P8_SCHEMA);
  const reviews = new ReviewStore(join(config.dataDir, "review"));
  const views = new Views(store, reviews);
  const limiter = new FixedWindowLimiter(config.rateLimit, config.rateWindowSeconds * 1000);
  const webIndex = join(config.webDist, "index.html");
  const webBuild = () => existsSync(webIndex);

  const samples = readdirSync(config.samplesDir).filter((f) => /^INV-\d{3}\.txt$/.test(f)).sort().map((f) => {
    const id = f.replace(/\.txt$/, "");
    const text = readFileSync(join(config.samplesDir, f), "utf8");
    return { id, name: f, chars: text.length, case: SAMPLE_CASES[id] ?? "sample invoice", text };
  });

  // Job events from the durable-jobs store, reduced to allowlisted fields (no payload, no outputs).
  store.onEvent = (e: StoredEvent) => {
    if (e.type === "worker_started" || e.type === "worker_stopped") return;
    const err = (e.error as { code?: string } | undefined)?.code;
    log.info({ event: "job_event", type: e.type, job_id: e.job_id ?? undefined, step: e.step as string | undefined, attempt: e.attempt as number | undefined, mode: e.mode as string | undefined, from: e.from as string | undefined, to: e.to as string | undefined, takeover: e.takeover as boolean | undefined, error_code: err });
  };

  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS, ...headers });
    res.end(JSON.stringify(body));
  };
  /** Validate the response against the published schema before sending. A mismatch is a server bug and becomes a 500. */
  const reply = <S extends z.ZodType>(res: ServerResponse, status: number, schema: S, body: z.infer<S>, headers: Record<string, string> = {}) => {
    const r = schema.safeParse(body);
    if (!r.success) throw new Error(`response failed its own schema: ${issuesOf(r.error).map((i) => `${i.path} ${i.message}`).join("; ")}`);
    send(res, status, r.data, headers);
  };

  const serveStatic = (res: ServerResponse, pathname: string) => {
    if (!webBuild()) {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8", ...SECURITY_HEADERS });
      res.end("The web build is missing. Run: npm run build\n");
      return 503;
    }
    const root = resolve(config.webDist);
    let file = resolve(root, "." + decodeURIComponent(pathname));
    const inside = file === root || file.startsWith(root + sep);
    if (!inside || !existsSync(file) || statSync(file).isDirectory()) file = webIndex; // SPA fallback
    const type = CONTENT_TYPES[extname(file)] ?? "application/octet-stream";
    const immutable = relative(root, file).startsWith("assets" + sep);
    res.writeHead(200, { "content-type": type, "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache", "content-security-policy": CSP, ...SECURITY_HEADERS });
    res.end(readFileSync(file));
    return 200;
  };

  async function handleApi(req: IncomingMessage, res: ServerResponse, path: string, ctx: { reqId: string; route: string; user?: User; jobId?: string }) {
    const method = req.method ?? "GET";
    const user = auth.authenticate(req.headers.authorization);
    if (!user) throw new HttpError(401, "UNAUTHENTICATED", "send Authorization: Bearer <token>; the token was missing or not recognised", {}, { "www-authenticate": 'Bearer realm="api"' });
    ctx.user = user;
    const rate = limiter.hit(user.user_id);
    const rateHeaders = { "ratelimit-limit": String(rate.limit), "ratelimit-remaining": String(rate.remaining), "ratelimit-reset": String(Math.ceil(rate.resetMs / 1000)) };
    if (!rate.allowed) {
      const retry = Math.max(1, Math.ceil(rate.resetMs / 1000));
      throw new HttpError(429, "RATE_LIMITED", `rate limit of ${rate.limit} requests per ${config.rateWindowSeconds} s reached`, { retry_after_seconds: retry }, { ...rateHeaders, "retry-after": String(retry) });
    }
    const ok = <S extends z.ZodType>(status: number, schema: S, body: z.infer<S>, extra: Record<string, string> = {}) => reply(res, status, schema, body, { ...rateHeaders, "x-request-id": ctx.reqId, ...extra });
    const methods = (allowed: string) => {
      if (method !== allowed) throw new HttpError(405, "METHOD_NOT_ALLOWED", `use ${allowed} ${ctx.route}`, {}, { allow: allowed });
    };

    if (path === "/api/v1/me") {
      ctx.route = path;
      methods("GET");
      return ok(200, Me, { user_id: user.user_id, name: user.name, test_user: user.test_user, rate_limit: { limit: config.rateLimit, window_seconds: config.rateWindowSeconds } });
    }
    if (path === "/api/v1/samples") {
      ctx.route = path;
      methods("GET");
      return ok(200, SampleList, { samples: samples.map(({ text: _t, ...s }) => s) });
    }
    if (path === "/api/v1/jobs") {
      ctx.route = path;
      if (method === "GET") return ok(200, JobList, { jobs: views.list(user.user_id) });
      methods("POST");
      const key = req.headers["idempotency-key"];
      if (typeof key !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(key)) {
        throw new HttpError(400, "MISSING_IDEMPOTENCY_KEY", "send an Idempotency-Key header: 1 to 128 characters from A-Z a-z 0-9 _ . : -");
      }
      const body = parseBody(CreateJobRequest, await readBody(req));
      let doc;
      if (body.sample !== undefined) {
        const s = samples.find((x) => x.id === body.sample);
        if (!s) throw new HttpError(400, "INVALID_INPUT", "unknown sample", { issues: [{ path: "sample", message: `no sample ${body.sample}; GET /api/v1/samples lists them` }] });
        doc = putDocument(store.db, user.user_id, s.name, "sample", s.text);
      } else {
        doc = putDocument(store.db, user.user_id, body.document!.name, "upload", body.document!.text);
      }
      const payload: JobPayload = { user_id: user.user_id, document_id: doc.id, architecture: body.architecture ?? "two-agent" };
      try {
        const r = submitJob(store, payload, scopedKey(user.user_id, key), STEPS);
        ctx.jobId = r.job_id;
        log.info({ event: "job_submitted", req_id: ctx.reqId, user_id: user.user_id, job_id: r.job_id, created: r.created, document_id: doc.id, source: doc.source, chars: doc.text.length });
        return ok(r.created ? 201 : 200, CreateJobResponse, r, { location: `/api/v1/jobs/${r.job_id}` });
      } catch (e) {
        if (e instanceof IdempotencyConflictError) {
          throw new HttpError(409, "IDEMPOTENCY_KEY_REUSED", "this Idempotency-Key was already used with a different body; use a new key for a new job", { job_id: e.existingJobId });
        }
        throw e;
      }
    }

    const m = /^\/api\/v1\/jobs\/([^/]+)(?:\/(corrections|approve|export))?$/.exec(path);
    if (m) {
      const jobId = m[1]!;
      const action = m[2];
      ctx.route = `/api/v1/jobs/:id${action ? `/${action}` : ""}`;
      methods(action ? "POST" : "GET");
      const notFound = () => new HttpError(404, "JOB_NOT_FOUND", `no job ${/^job_[0-9a-f]{12}$/.test(jobId) ? jobId : "with that id"} for this user`);
      const owned = views.owned(jobId, user.user_id);
      if (!owned) throw notFound();
      ctx.jobId = jobId;
      if (!action) return ok(200, JobWithText, (await views.job(jobId, user.user_id))!);

      const body = await readBody(req);
      if (owned.raw.status !== "succeeded") throw new HttpError(409, "JOB_NOT_READY", `job is ${owned.raw.status}; review actions need a succeeded job`);
      if (action === "corrections") {
        const input = parseBody(CorrectionRequest, body);
        let correction;
        try {
          correction = reviews.correct(jobId, { field: input.field, value: input.value, quote: input.quote ?? null, reason: input.reason, note: input.note, reviewer: user.user_id });
        } catch (e) {
          if (e instanceof ReviewError) throw new HttpError(400, "INVALID_INPUT", "correction rejected", { issues: [{ path: /quote/.test(e.message) ? "quote" : /null needs a reason/.test(e.message) ? "reason" : "value", message: e.message }] });
          throw e;
        }
        return ok(201, CorrectionResponse, { correction, job: (await views.jobOnly(jobId, user.user_id))! });
      }
      if (action === "approve") {
        const input = parseBody(ApproveRequest, body);
        let approval;
        try {
          approval = await reviews.approve(jobId, user.user_id, input.acknowledge ?? []);
        } catch (e) {
          if (e instanceof ReviewError) throw new HttpError(409, "APPROVAL_BLOCKED", e.message);
          throw e;
        }
        return ok(200, ApproveResponse, { approval, job: (await views.jobOnly(jobId, user.user_id))! });
      }
      // export
      let out;
      try {
        out = await reviews.export(jobId, join(config.dataDir, "exports", user.user_id));
      } catch (e) {
        if (e instanceof ReviewError) throw new HttpError(409, "NOT_APPROVED", e.message);
        throw e;
      }
      const file = relative(config.dataDir, out.file).split(sep).join("/");
      const draft = out.draft as { exported_at: string; approved: { ts: string } };
      recordExport(store.db, jobId, draft.approved.ts, draft.exported_at, file);
      return ok(200, ExportResponse, { file, draft: out.draft as z.infer<typeof ExportResponse>["draft"] });
    }
    ctx.route = "/api/*";
    throw new HttpError(404, "NOT_FOUND", "no such route; see API.md");
  }

  const server = createServer(async (req, res) => {
    const started = performance.now();
    const reqId = randomBytes(6).toString("hex");
    const ctx: { reqId: string; route: string; user?: User; jobId?: string; errorCode?: string } = { reqId, route: "static" };
    let status = 200;
    try {
      const url = new URL(req.url ?? "/", "http://local");
      const path = url.pathname;
      if (path === "/healthz") {
        ctx.route = "/healthz";
        reply(res, 200, Health, { ok: true, version: VERSION, extraction_mode: config.extractionMode, web_build: webBuild() }, { "x-request-id": reqId });
      } else if (path === "/api" || path.startsWith("/api/")) {
        ctx.route = "/api/*";
        await handleApi(req, res, path, ctx);
        status = res.statusCode;
      } else {
        if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "METHOD_NOT_ALLOWED", "static files are GET only", {}, { allow: "GET" });
        status = serveStatic(res, path);
      }
    } catch (e) {
      const he = e instanceof HttpError ? e : new HttpError(500, "INTERNAL", "internal error; see the server log with this request id");
      if (!(e instanceof HttpError)) log.error({ event: "internal_error", req_id: reqId, route: ctx.route, reason: (e as Error).name });
      status = he.status;
      ctx.errorCode = he.code;
      const body = { error: { code: he.code, message: he.message, request_id: reqId, ...he.extra } };
      ApiErrorBody.parse(body);
      if (!res.headersSent) send(res, he.status, body, { "x-request-id": reqId, ...he.headers });
      else res.end();
    } finally {
      log.info({ event: "http_request", req_id: reqId, method: req.method, route: ctx.route, status, duration_ms: Math.round(performance.now() - started), user_id: ctx.user?.user_id, job_id: ctx.jobId, error_code: ctx.errorCode });
    }
  });

  await new Promise<void>((r) => server.listen(config.port, config.host, r));
  const addr = server.address() as AddressInfo;
  const url = `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${addr.port}`;

  const stop = new AbortController();
  const handlers = extractionHandlers({ db: store.db, reviews, mode: config.extractionMode, stepDelayMs: config.stepDelayMs });
  const worker = runWorker(store, handlers, { until: "forever", signal: stop.signal, leaseMs: config.leaseMs, pollMs: 50, maxAttempts: 3, workerId: `api-${process.pid}` }).catch((e) => {
    log.error({ event: "worker_crashed", reason: (e as Error).name });
  });

  log.info({ event: "server_started", host: config.host, port: addr.port, extraction_mode: config.extractionMode, test_users: auth.testOnly, rate_limit: config.rateLimit, rate_window_s: config.rateWindowSeconds, web_build: webBuild() });

  return {
    url,
    server,
    store,
    async close() {
      stop.abort();
      await worker;
      const closed = new Promise<void>((r) => server.close(() => r()));
      server.closeAllConnections();
      await closed;
      store.close();
    },
  };
}
