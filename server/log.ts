import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Structured JSON-lines log. Only the keys listed in ALLOWED are written; anything else is
 * dropped, so a caller cannot leak a token, a request body or a document text by accident.
 * Values must be short primitives; longer strings are cut.
 */
const ALLOWED = new Set([
  "event", "req_id", "method", "route", "status", "duration_ms", "user_id", "job_id", "error_code",
  "type", "step", "attempt", "mode", "from", "to", "worker", "takeover", "port", "host", "extraction_mode",
  "test_users", "rate_limit", "rate_window_s", "web_build", "data_dir", "reason", "created", "document_id", "chars", "source",
]);
const MAX_STR = 120;

export type LogFields = Record<string, string | number | boolean | null | undefined>;

export class Logger {
  constructor(private readonly file?: string, private readonly toStdout = true) {
    if (file) mkdirSync(dirname(file), { recursive: true });
  }

  write(level: "info" | "warn" | "error", fields: LogFields) {
    const line: Record<string, unknown> = { ts: new Date().toISOString(), level };
    for (const [k, v] of Object.entries(fields)) {
      if (!ALLOWED.has(k) || v === undefined) continue;
      line[k] = typeof v === "string" && v.length > MAX_STR ? `${v.slice(0, MAX_STR)}...` : v;
    }
    const s = JSON.stringify(line);
    if (this.toStdout) process.stdout.write(s + "\n");
    if (this.file) appendFileSync(this.file, s + "\n");
  }

  info(f: LogFields) { this.write("info", f); }
  warn(f: LogFields) { this.write("warn", f); }
  error(f: LogFields) { this.write("error", f); }
}
