import { FIELD_NAMES, type FieldName, type Handoff, type Task } from "../schema.ts";
import { readField, searchTerms, type Line } from "./heuristics.ts";
import { call, ScriptedModel, toolResults } from "./scripted.ts";
import type { Message } from "./types.ts";

/**
 * Scripted fixture models for the three roles. Each step is a function of the transcript, so the
 * values they submit are computed from the lines the read tools actually returned. No API calls.
 */

const okResults = (t: Message[]) => toolResults(t).filter((r) => !r.isError).map((r) => JSON.parse(r.content) as Record<string, unknown>);
const lastError = (t: Message[]) => {
  const r = toolResults(t).at(-1);
  return r?.isError ? (JSON.parse(r.content) as { code?: string; problems?: string[] }) : undefined;
};
const linesSeen = (t: Message[]): Line[] => {
  const byN = new Map<number, string>();
  for (const r of okResults(t)) {
    const ls = Array.isArray(r.lines) ? r.lines : Array.isArray(r.matches) ? r.matches : [];
    for (const l of ls as Line[]) byN.set(l.n, l.text);
  }
  return [...byN.entries()].sort((a, b) => a[0] - b[0]).map(([n, text]) => ({ n, text }));
};

export const FULL_PLAN = (docId: string): { doc_id: string; tasks: Task[] } => ({
  doc_id: docId,
  tasks: [
    ...FIELD_NAMES.map((field) => ({ type: "extract_field" as const, field })),
    { type: "check_totals" },
    { type: "check_dates" },
    { type: "flag_missing" },
  ],
});

export function scriptedPlanner(docId: string, name = "planner"): ScriptedModel {
  return new ScriptedModel([() => ({ calls: [call("submit_plan", FULL_PLAN(docId))] })], name);
}

/** search_text with the field's terms, then read the field from the returned lines. */
export function scriptedWorker(h: Handoff, name = "worker"): ScriptedModel {
  const field = (h.task as { field: FieldName }).field;
  return new ScriptedModel(
    [
      () => ({ calls: [call("search_text", { doc_id: h.doc_id, any_of: searchTerms(field) })] }),
      (t) => ({ calls: [call("submit_field", { field, ...readField(field, linesSeen(t)) })] }),
    ],
    name,
  );
}

/** Baseline: document info, read every line, submit all nine fields in one call. */
export function scriptedSingle(docId: string, name = "single"): ScriptedModel {
  return new ScriptedModel(
    [
      () => ({ calls: [call("get_document_info", { doc_id: docId })] }),
      (t) => {
        const info = okResults(t).at(-1) as { lines: number } | undefined;
        const total = info?.lines ?? 60;
        const calls = [];
        for (let from = 1; from <= total; from += 60) calls.push(call("read_lines", { doc_id: docId, from, to: Math.min(total, from + 59) }));
        return { calls };
      },
      (t) => {
        const lines = linesSeen(t);
        return { calls: [call("submit_extraction", { fields: Object.fromEntries(FIELD_NAMES.map((f) => [f, readField(f, lines)])) })] };
      },
    ],
    name,
  );
}

// ---------------------------------------------------------------- fault scenarios for the demo

/**
 * First plan fails the schema (unknown task type, field outside the schema). Second passes the
 * schema but breaks the ordering rules (check before extraction, flag_missing not last).
 * Third is valid.
 */
export function plannerWithBadFirstPlan(docId: string): ScriptedModel {
  return new ScriptedModel(
    [
      () => ({ calls: [call("submit_plan", { doc_id: docId, tasks: [{ type: "extract_field", field: "iban" }, { type: "summarize" }] })] }),
      (t) =>
        lastError(t)
          ? { calls: [call("submit_plan", { doc_id: docId, tasks: [{ type: "check_totals" }, { type: "flag_missing" }, { type: "extract_field", field: "total" }] })] }
          : { calls: [] },
      (t) => (lastError(t) ? { calls: [call("submit_plan", FULL_PLAN(docId))] } : { calls: [] }),
    ],
    "planner-bad-plans",
  );
}

/**
 * Worker that first hands back a normalised quote ("8637.50") that is not in the document,
 * then, after the rejection, the exact span.
 */
export function workerParaphrasesFirst(h: Handoff): ScriptedModel {
  const field = (h.task as { field: FieldName }).field;
  return new ScriptedModel(
    [
      () => ({ calls: [call("search_text", { doc_id: h.doc_id, any_of: searchTerms(field) })] }),
      (t) => {
        const r = readField(field, linesSeen(t));
        return { calls: [call("submit_field", { field, ...r, quote: r.value === null ? null : String(r.value) })] };
      },
      (t) => (lastError(t) ? { calls: [call("submit_field", { field, ...readField(field, linesSeen(t)) })] } : { calls: [] }),
    ],
    "worker-paraphrase-first",
  );
}

/**
 * Worker that tries to fill a missing field with a plausible guess and an invented quote,
 * is rejected, and then submits null with a reason.
 */
export function workerGuessesFirst(h: Handoff, guess: string | number): ScriptedModel {
  const field = (h.task as { field: FieldName }).field;
  return new ScriptedModel(
    [
      () => ({ calls: [call("search_text", { doc_id: h.doc_id, any_of: searchTerms(field) })] }),
      (t) => {
        const r = readField(field, linesSeen(t));
        return { calls: [call("submit_field", r.value === null ? { field, value: guess, quote: `${field}: ${guess}`, confidence: 0.4 } : { field, ...r })] };
      },
      (t) => (lastError(t) ? { calls: [call("submit_field", { field, ...readField(field, linesSeen(t)) })] } : { calls: [] }),
    ],
    "worker-guess-first",
  );
}
