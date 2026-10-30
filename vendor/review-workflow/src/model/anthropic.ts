import Anthropic from "@anthropic-ai/sdk";
import type { ToolSpec } from "../registry.ts";
import type { Message, ModelClient, ModelTurn } from "./types.ts";

export class AnthropicModel implements ModelClient {
  readonly id: string;
  private client: Anthropic;

  constructor(private readonly model = process.env.AGENT_MODEL ?? "claude-sonnet-5-5", private readonly maxTokens = 1024) {
    this.id = `anthropic:${model}`;
    this.client = new Anthropic(); // reads ANTHROPIC_API_KEY
  }

  async next(system: string, transcript: Message[], tools: ToolSpec[]): Promise<ModelTurn> {
    const messages: Anthropic.MessageParam[] = transcript.map((m) => {
      if (m.role === "user") return { role: "user", content: m.text };
      if (m.role === "assistant") {
        const content: Anthropic.ContentBlockParam[] = [];
        if (m.text) content.push({ type: "text", text: m.text });
        for (const c of m.calls) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.args as Record<string, unknown> });
        return { role: "assistant", content };
      }
      return {
        role: "user",
        content: m.results.map((r) => ({ type: "tool_result" as const, tool_use_id: r.id, content: r.content, is_error: r.isError })),
      };
    });

    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system,
      messages,
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema as Anthropic.Tool.InputSchema })),
    });

    const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n");
    const calls = res.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, args: b.input }));
    return { text: text || undefined, calls, usage: { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens } };
  }
}
