import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const VERSION = "0.1.0";

export interface Config {
  host: string;
  port: number;
  /** SQLite database, review files and exports live here. */
  dataDir: string;
  usersFile: string;
  samplesDir: string;
  webDist: string;
  /** Requests per token per window (fixed window). */
  rateLimit: number;
  rateWindowSeconds: number;
  /** Structured log file (JSON lines). The log always also goes to stdout unless quiet. */
  logFile?: string;
  quiet: boolean;
  /** Artificial pause per job step, so the status changes are visible in the UI. 0 in tests. */
  stepDelayMs: number;
  /** Worker lease. A crashed server's running job is taken over by the next server after this. */
  leaseMs: number;
  extractionMode: "fixture" | "live";
  /** Allow a users file marked test_only when NODE_ENV=production. */
  allowTestUsers: boolean;
  production: boolean;
}

const int = (v: string | undefined, d: number, name: string) => {
  if (v === undefined || v === "") return d;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(v)}`);
  return n;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const mode = env.EXTRACTION_MODE ?? "fixture";
  if (mode !== "fixture" && mode !== "live") throw new Error(`EXTRACTION_MODE must be fixture or live, got ${mode}`);
  return {
    host: env.HOST ?? "127.0.0.1",
    port: int(env.PORT, 8787, "PORT"),
    dataDir: resolve(env.DATA_DIR ?? resolve(ROOT, ".data")),
    usersFile: resolve(env.USERS_FILE ?? resolve(ROOT, "data/test-users.json")),
    samplesDir: resolve(ROOT, "data/samples"),
    webDist: resolve(env.WEB_DIST ?? resolve(ROOT, "web/dist")),
    rateLimit: int(env.RATE_LIMIT, 120, "RATE_LIMIT"),
    rateWindowSeconds: Math.max(1, int(env.RATE_WINDOW_SECONDS, 60, "RATE_WINDOW_SECONDS")),
    logFile: env.LOG_FILE || undefined,
    quiet: env.LOG_QUIET === "1",
    stepDelayMs: int(env.STEP_DELAY_MS, 0, "STEP_DELAY_MS"),
    leaseMs: Math.max(200, int(env.LEASE_MS, 10_000, "LEASE_MS")),
    extractionMode: mode,
    allowTestUsers: env.ALLOW_TEST_USERS === "1",
    production: env.NODE_ENV === "production",
    ...overrides,
  };
}
