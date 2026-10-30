import { z } from "zod";
import { ToolFailure } from "../errors.ts";
import { defineTool, type ToolDefinition } from "./types.ts";

/** Documents the read tools can see, keyed by doc_id. Read only. */
export type DocStore = ReadonlyMap<string, string>;

const DocId = z.string().min(1).max(64);
const Line = z.object({ n: z.number().int(), text: z.string() });
const MAX_LINES = 60;

const linesOf = (text: string) => text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");

function doc(store: DocStore, id: string, tool: string): string {
  const t = store.get(id);
  if (t === undefined) throw new ToolFailure({ code: "NOT_FOUND", tool, message: `no document with id ${id}`, retryable: false });
  return t;
}

export function makeReadTools(store: DocStore): ToolDefinition[] {
  const info = defineTool({
    name: "get_document_info",
    description: "Size of a document and its first line. Use it to decide which lines to read.",
    input: z.object({ doc_id: DocId }).strict(),
    output: z.object({ doc_id: z.string(), chars: z.number().int(), lines: z.number().int(), first_line: z.string() }),
    async run({ doc_id }) {
      const t = doc(store, doc_id, "get_document_info");
      const ls = linesOf(t);
      return { doc_id, chars: t.length, lines: ls.length, first_line: ls[0] ?? "" };
    },
  });

  const read = defineTool({
    name: "read_lines",
    description: `Read lines from..to (1-based, inclusive, at most ${MAX_LINES} lines per call). Text is returned exactly as written.`,
    input: z
      .object({ doc_id: DocId, from: z.number().int().min(1), to: z.number().int().min(1) })
      .strict()
      .refine((a) => a.to >= a.from && a.to - a.from < MAX_LINES, { message: `to must be >= from and the range at most ${MAX_LINES} lines` }),
    output: z.object({ doc_id: z.string(), total_lines: z.number().int(), lines: z.array(Line) }),
    async run({ doc_id, from, to }) {
      const ls = linesOf(doc(store, doc_id, "read_lines"));
      const lines = ls.slice(from - 1, to).map((text, i) => ({ n: from + i, text }));
      return { doc_id, total_lines: ls.length, lines };
    },
  });

  const search = defineTool({
    name: "search_text",
    description: "Case-insensitive literal search. Returns every line that contains any of the terms, with its line number. Text is returned exactly as written.",
    input: z.object({ doc_id: DocId, any_of: z.array(z.string().min(1).max(60)).min(1).max(12) }).strict(),
    output: z.object({ doc_id: z.string(), matches: z.array(Line.extend({ term: z.string() })), truncated: z.boolean() }),
    async run({ doc_id, any_of }) {
      const ls = linesOf(doc(store, doc_id, "search_text"));
      const terms = any_of.map((t) => t.toLowerCase());
      const matches: { n: number; text: string; term: string }[] = [];
      ls.forEach((text, i) => {
        const low = text.toLowerCase();
        const hit = terms.findIndex((t) => low.includes(t));
        if (hit >= 0) matches.push({ n: i + 1, text, term: any_of[hit]! });
      });
      return { doc_id, matches: matches.slice(0, 20), truncated: matches.length > 20 };
    },
  });

  return [info, read, search];
}
