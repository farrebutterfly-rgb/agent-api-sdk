import type { Message, ModelClient, ModelTurn, ToolCall } from "./types.ts";

/**
 * Fixture model. Each step is a function of the transcript so a script can react to
 * tool results (for example retry after INVALID_ARGUMENTS) without calling any API.
 * This proves the loop and the guards. It proves nothing about a real model.
 */
export type ScriptStep = (transcript: Message[]) => ModelTurn;

let n = 0;
export const call = (name: string, args: unknown): ToolCall => ({ id: `fx_${++n}`, name, args });

export class ScriptedModel implements ModelClient {
  readonly id: string;
  private i = 0;
  constructor(private readonly steps: ScriptStep[], name = "scripted", private readonly repeatLast = false) {
    this.id = `fixture:${name}`;
  }
  async next(_system: string, transcript: Message[]): Promise<ModelTurn> {
    const step = this.steps[this.i] ?? (this.repeatLast ? this.steps.at(-1) : undefined);
    this.i++;
    if (!step) throw new Error(`script exhausted after ${this.steps.length} steps`);
    return step(transcript);
  }
}

/** Tool results the model has seen so far, newest last. Handy inside scripts. */
export function toolResults(t: Message[]) {
  return t.flatMap((m) => (m.role === "tool" ? m.results : []));
}
