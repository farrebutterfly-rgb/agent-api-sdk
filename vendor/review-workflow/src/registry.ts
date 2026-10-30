import { z } from "zod";
import { ToolFailure, type ToolError } from "./errors.ts";
import type { ToolDefinition } from "./tools/types.ts";

type Outcome = { ok: true; result: unknown } | { ok: false; error: ToolError };
export type ExecResult = Outcome & { durationMs: number };

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

const issuesOf = (e: z.ZodError) =>
  e.issues.map((i) => ({ path: i.path.join(".") || "(root)", message: i.message }));

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  constructor(tools: ToolDefinition[], private readonly timeoutMs = 2000) {
    for (const t of tools) {
      if (this.tools.has(t.name)) throw new Error(`duplicate tool name ${t.name}`);
      this.tools.set(t.name, t);
    }
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** JSON Schema for the model, generated from the same zod schema used to validate. */
  specs(): ToolSpec[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: z.toJSONSchema(t.input, { io: "input" }) as Record<string, unknown>,
    }));
  }

  async execute(name: string, rawArgs: unknown): Promise<ExecResult> {
    const started = performance.now();
    const done = (r: Outcome): ExecResult => ({ ...r, durationMs: Math.round(performance.now() - started) });

    const tool = this.tools.get(name);
    if (!tool) {
      return done({ ok: false, error: { code: "UNKNOWN_TOOL", tool: name, message: `no tool named "${name}". Available: ${this.names().join(", ")}`, retryable: false } });
    }

    const parsed = tool.input.safeParse(rawArgs);
    if (!parsed.success) {
      return done({ ok: false, error: { code: "INVALID_ARGUMENTS", tool: name, message: "arguments did not match the input schema", retryable: false, issues: issuesOf(parsed.error) } });
    }

    const ac = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ac.abort();
        reject(new ToolFailure({ code: "TIMEOUT", tool: name, message: `no result within ${this.timeoutMs} ms`, retryable: true }));
      }, this.timeoutMs);
    });

    try {
      // Race as well as abort: a tool that ignores its signal still cannot hang the agent.
      const raw = await Promise.race([tool.run(parsed.data, { signal: ac.signal }), timeout]);
      const out = tool.output.safeParse(raw);
      if (!out.success) {
        return done({ ok: false, error: { code: "INVALID_RESULT", tool: name, message: "tool returned data that did not match its output schema", retryable: false, issues: issuesOf(out.error) } });
      }
      return done({ ok: true, result: out.data });
    } catch (e) {
      if (e instanceof ToolFailure) return done({ ok: false, error: e.error });
      if (ac.signal.aborted) {
        return done({ ok: false, error: { code: "TIMEOUT", tool: name, message: `no result within ${this.timeoutMs} ms`, retryable: true } });
      }
      return done({ ok: false, error: { code: "UPSTREAM_ERROR", tool: name, message: (e as Error).message, retryable: false } });
    } finally {
      clearTimeout(timer);
    }
  }
}
