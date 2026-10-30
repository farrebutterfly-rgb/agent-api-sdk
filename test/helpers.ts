import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, type App } from "../server/app.ts";
import { loadConfig, ROOT, type Config } from "../server/config.ts";

export const TOKENS = (JSON.parse(readFileSync(join(ROOT, "data/test-tokens.json"), "utf8")) as { tokens: { a: string; b: string } }).tokens;

export const tmp = (prefix = "p8-") => mkdtempSync(join(tmpdir(), prefix));

/** In-process server on a random port with its own data directory and log file. */
export async function startTestApp(overrides: Partial<Config> = {}): Promise<App & { dataDir: string; logFile: string }> {
  const dataDir = tmp();
  const logFile = join(dataDir, "server.log.jsonl");
  const app = await startApp(loadConfig({}, { port: 0, host: "127.0.0.1", dataDir, logFile, quiet: true, ...overrides }));
  return Object.assign(app, { dataDir, logFile });
}

export interface Spawned {
  url: string;
  child: ChildProcess;
  dataDir: string;
  logFile: string;
  stop(signal?: NodeJS.Signals): Promise<void>;
}

/** The real server as a separate OS process (node --import tsx server/main.ts). */
export function spawnServer(env: Record<string, string> = {}, dataDir = tmp()): Promise<Spawned> {
  const logFile = join(dataDir, "server.log.jsonl");
  const child = spawn(process.execPath, ["--no-warnings=ExperimentalWarning", "--import", "tsx", "server/main.ts"], {
    cwd: ROOT,
    env: { ...process.env, PORT: "0", HOST: "127.0.0.1", DATA_DIR: dataDir, LOG_FILE: logFile, LOG_QUIET: "1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let err = "";
    const timer = setTimeout(() => reject(new Error(`server did not start: ${err}`)), 15_000);
    child.stderr!.on("data", (d: Buffer) => {
      err += d.toString();
      const m = /listening on (http:\/\/[\d.]+:\d+)/.exec(err);
      if (m) {
        clearTimeout(timer);
        resolve({
          url: m[1]!,
          child,
          dataDir,
          logFile,
          stop: (signal = "SIGTERM") =>
            new Promise((r) => {
              if (child.exitCode !== null || child.signalCode !== null) return r();
              child.once("exit", () => r());
              child.kill(signal);
            }),
        });
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited with ${code}: ${err}`));
    });
  });
}

export interface Res {
  status: number;
  headers: Headers;
  // eslint-style any on purpose: tests assert on arbitrary response JSON
  json: any;
}

/** Raw HTTP call, no SDK, so tests see exactly what the server sends. */
export async function api(url: string, method: string, path: string, opts: { token?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {}): Promise<Res> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const body = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(url + path, { method, headers, body });
  const text = await r.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: r.status, headers: r.headers, json };
}

export async function waitDone(url: string, token: string, jobId: string, timeoutMs = 20_000): Promise<Res> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const r = await api(url, "GET", `/api/v1/jobs/${jobId}`, { token });
    if (r.status !== 200 || r.json.status === "succeeded" || r.json.status === "failed") return r;
    if (Date.now() > end) throw new Error(`job ${jobId} still ${r.json.status}`);
    await new Promise((res) => setTimeout(res, 40));
  }
}

export async function createAndWait(url: string, token: string, body: unknown, key: string) {
  const c = await api(url, "POST", "/api/v1/jobs", { token, body, headers: { "idempotency-key": key } });
  if (c.status !== 201) throw new Error(`create failed ${c.status} ${JSON.stringify(c.json)}`);
  return (await waitDone(url, token, c.json.job_id)).json;
}
