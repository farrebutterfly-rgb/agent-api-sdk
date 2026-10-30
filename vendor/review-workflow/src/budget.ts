/**
 * Per-document limits shared by every agent working on that document. The two-agent pipeline
 * and the single-agent baseline get the same numbers, so the comparison is like for like.
 */
export interface BudgetLimits {
  maxModelCalls: number;
  maxToolCalls: number;
}

export const DEFAULT_BUDGET: BudgetLimits = { maxModelCalls: 30, maxToolCalls: 40 };

export class Budget {
  modelCalls = 0;
  toolCalls = 0;
  inputTokens = 0;
  outputTokens = 0;
  sawUsage = false;
  constructor(readonly limits: BudgetLimits = DEFAULT_BUDGET) {}
  canCallModel() {
    return this.modelCalls < this.limits.maxModelCalls;
  }
  canCallTool() {
    return this.toolCalls < this.limits.maxToolCalls;
  }
  addUsage(u?: { input_tokens: number; output_tokens: number }) {
    if (!u) return;
    this.sawUsage = true;
    this.inputTokens += u.input_tokens;
    this.outputTokens += u.output_tokens;
  }
  usage() {
    return this.sawUsage ? { input_tokens: this.inputTokens, output_tokens: this.outputTokens } : null;
  }
  /**
   * Cost only when prices are given explicitly (USD per million tokens). No price table is
   * built in, so the repo never reports a number nobody checked.
   */
  costUsd(env: NodeJS.ProcessEnv = process.env): number | null {
    const pin = Number(env.PRICE_INPUT_PER_MTOK);
    const pout = Number(env.PRICE_OUTPUT_PER_MTOK);
    if (!this.sawUsage || !env.PRICE_INPUT_PER_MTOK || !env.PRICE_OUTPUT_PER_MTOK || Number.isNaN(pin) || Number.isNaN(pout)) return null;
    return Math.round(((this.inputTokens * pin + this.outputTokens * pout) / 1e6) * 1e6) / 1e6;
  }
}
