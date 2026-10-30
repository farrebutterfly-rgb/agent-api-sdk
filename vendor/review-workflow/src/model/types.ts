import type { ToolSpec } from "../registry.ts";

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

/** Provider-neutral transcript. Adapters translate it to each API's message format. */
export type Message =
  | { role: "user"; text: string }
  | { role: "assistant"; text?: string; calls: ToolCall[] }
  | { role: "tool"; results: { id: string; content: string; isError: boolean }[] };

export interface ModelTurn {
  text?: string;
  calls: ToolCall[];
  usage?: { input_tokens: number; output_tokens: number };
}

export interface ModelClient {
  /** Shown in the run log so fixture and live runs are never confused. */
  readonly id: string;
  next(system: string, transcript: Message[], tools: ToolSpec[]): Promise<ModelTurn>;
}
