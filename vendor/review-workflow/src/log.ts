import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export interface LogEvent {
  type: string;
  [k: string]: unknown;
}

/** Append-only JSONL run log. Every line carries run_id and a sequence number. */
export class RunLog {
  readonly runId = randomUUID().slice(0, 8);
  readonly events: (LogEvent & { run_id: string; seq: number; ts: string })[] = [];
  private seq = 0;
  constructor(private readonly file?: string, private readonly echo = false) {
    if (file) mkdirSync(dirname(file), { recursive: true });
  }
  write(e: LogEvent) {
    const line = { run_id: this.runId, seq: ++this.seq, ts: new Date().toISOString(), ...e };
    this.events.push(line);
    if (this.file) appendFileSync(this.file, JSON.stringify(line) + "\n");
    if (this.echo) console.log(format(line));
  }
}

function format(e: LogEvent & { seq: number }): string {
  const pad = String(e.seq).padStart(2, "0");
  switch (e.type) {
    case "tool_call":
      return `  [${pad}] ${e.ok ? "ok " : "ERR"} ${e.tool}(${JSON.stringify(e.args)}) ${e.duration_ms}ms${e.ok ? "" : `  -> ${(e.error as { code: string }).code}: ${(e.error as { message: string }).message}`}`;
    case "final_rejected":
      return `  [${pad}] ERR final_answer rejected -> ${e.reason}`;
    case "run_end":
      return `  [${pad}] END status=${e.status} steps=${e.steps}`;
    default:
      return `  [${pad}] ${e.type}`;
  }
}
