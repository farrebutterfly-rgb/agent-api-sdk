import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Fields, Finding } from "./schema.ts";

export type Check = "types" | "quotes" | "totals" | "dates" | "missing";
export const ALL_CHECKS: Check[] = ["types", "quotes", "totals", "dates", "missing"];

export interface ValidatorOutput {
  ok: boolean;
  checks_run: Check[];
  findings: Omit<Finding, "source">[];
}

const SCRIPT = fileURLToPath(new URL("../validator/validate.py", import.meta.url));
/** Python interpreter. Override with PYTHON=/path/to/python3.10 to test another version. */
export const pythonBin = () => process.env.PYTHON ?? "python3";

/**
 * Runs validator/validate.py as a child process: extraction JSON on stdin, findings JSON on stdout.
 * Fails loudly (rejects) when Python is missing, times out or prints something that is not JSON.
 */
export function runValidator(input: { fields: Partial<Fields> | Record<string, unknown>; doc_text?: string; checks?: Check[]; tolerance?: number }, timeoutMs = 10_000): Promise<ValidatorOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin(), [SCRIPT], { stdio: ["pipe", "pipe", "pipe"], timeout: timeoutMs });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => reject(new Error(`could not start ${pythonBin()}: ${e.message}. The validator needs Python 3.10 or later on PATH (or set PYTHON).`)));
    child.on("close", (code, signal) => {
      if (signal) return reject(new Error(`validator stopped by ${signal} (timeout ${timeoutMs} ms?)`));
      let parsed: unknown;
      try {
        parsed = JSON.parse(out);
      } catch {
        return reject(new Error(`validator printed no JSON (exit ${code}): ${err.trim() || out.trim()}`));
      }
      if (code !== 0) return reject(new Error(`validator rejected its input: ${(parsed as { error?: string }).error ?? out}`));
      resolve(parsed as ValidatorOutput);
    });
    child.stdin.end(JSON.stringify(input));
  });
}

export const asFindings = (v: ValidatorOutput): Finding[] => v.findings.map((f) => ({ ...f, source: "validator" as const }));
