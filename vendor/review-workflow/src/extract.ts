import { DEFAULT_BUDGET, type BudgetLimits } from "./budget.ts";
import { RunLog } from "./log.ts";
import { AnthropicModel } from "./model/anthropic.ts";
import { scriptedPlanner, scriptedSingle, scriptedWorker } from "./model/fixtures.ts";
import { runSingleAgent, runTwoAgent, type Models } from "./pipeline.ts";
import type { ExtractionResult } from "./schema.ts";

export type Architecture = "two-agent" | "single-agent";
export type Mode = "fixture" | "live";

export interface ExtractOptions {
  /** Default "two-agent". */
  architecture?: Architecture;
  /** Default "fixture": scripted models, no API calls, no cost. "live" needs ANTHROPIC_API_KEY. */
  mode?: Mode;
  /** Id used in tool calls and logs. Default "DOC-1". */
  docId?: string;
  budget?: BudgetLimits;
  /** Tolerance for net + vat = total. Default 0.01. */
  tolerance?: number;
  /** JSONL run log. Default: in memory only. */
  log?: RunLog;
  /** Replace the models (used by the demo's fault scenarios and by tests). */
  models?: Partial<Models>;
}

export class MissingApiKeyError extends Error {
  constructor() {
    super("ANTHROPIC_API_KEY is not set. Live mode calls the real API and costs money; fixture mode does not.");
  }
}

export const fixtureModels = (): Models => ({ planner: (d) => scriptedPlanner(d), worker: (h) => scriptedWorker(h), single: (d) => scriptedSingle(d) });

export function liveModels(env: NodeJS.ProcessEnv = process.env): Models {
  if (!env.ANTHROPIC_API_KEY) throw new MissingApiKeyError();
  return { planner: () => new AnthropicModel(), worker: () => new AnthropicModel(), single: () => new AnthropicModel(undefined, 2048) };
}

/**
 * Extract the nine invoice fields from one document.
 * Every non-null value carries a quote that is an exact substring of docText; every null carries
 * a reason. findings come from the Python validator (and the orchestrator, for budget and plan
 * failures). Reused by project 8 through this function and through `npm run extract`.
 */
export async function runExtraction(docText: string, opts: ExtractOptions = {}): Promise<ExtractionResult> {
  const mode = opts.mode ?? "fixture";
  const models = { ...(mode === "live" ? liveModels() : fixtureModels()), ...opts.models };
  const run = (opts.architecture ?? "two-agent") === "two-agent" ? runTwoAgent : runSingleAgent;
  return run(opts.docId ?? "DOC-1", docText, { models, log: opts.log ?? new RunLog(), budget: opts.budget ?? DEFAULT_BUDGET, tolerance: opts.tolerance });
}

/** The compact shape printed by `npm run --silent extract -- --json <file>`. */
export function toPublicJson(r: ExtractionResult) {
  return {
    fields: Object.fromEntries(
      Object.entries(r.fields).map(([k, f]) => [k, { value: f.value, quote: f.quote, ...(f.confidence !== undefined ? { confidence: f.confidence } : {}), ...(f.reason ? { reason: f.reason } : {}) }]),
    ),
    findings: r.findings,
    calls: r.calls,
    tool_calls: r.tool_calls,
    mode: r.mode,
    architecture: r.architecture,
    status: r.status,
    usage: r.usage,
    cost_usd: r.cost_usd,
  };
}
