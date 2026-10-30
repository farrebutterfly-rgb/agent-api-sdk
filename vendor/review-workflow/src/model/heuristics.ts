import type { FieldName, FieldResult } from "../schema.ts";

/**
 * Reading rules used ONLY by the scripted fixture models. They stand in for a language model
 * so the pipeline can run with zero API cost. They are deliberately plain: label at the start
 * of a column segment, then a typed value. Whatever they get wrong shows up in the eval report
 * as fixture error; it says nothing about how a real model would do.
 *
 * Both fixture architectures use these same rules on the same lines, so any accuracy difference
 * between them comes from orchestration (budget, call count), not from different reading skill.
 */

export interface Line {
  n: number;
  text: string;
}

interface Rule {
  labels: string[];
  /** Extra search terms for the fallback when no label matches. */
  fallbackTerms: string[];
  /** Segments containing any of these (case-insensitive) are skipped. */
  exclude?: RegExp;
  kind: "text" | "id" | "date" | "currency" | "amount" | "org";
}

export const RULES: Record<FieldName, Rule> = {
  supplier: { labels: ["Leverantör", "Supplier", "Säljare", "Seller", "From"], fallbackTerms: [" AB", " Ltd", " Oy", " Inc"], kind: "text" },
  invoice_number: { labels: ["Fakturanummer", "Fakturanr", "Faktura nr", "Invoice number", "Invoice no", "Invoice #"], fallbackTerms: [], kind: "id" },
  invoice_date: { labels: ["Fakturadatum", "Invoice date", "Date of issue", "Datum"], fallbackTerms: [], kind: "date" },
  due_date: { labels: ["Förfallodatum", "Förfallodag", "Due date", "Payment due", "Betalas senast"], fallbackTerms: [], kind: "date" },
  currency: { labels: ["Valuta", "Currency"], fallbackTerms: ["SEK", "EUR", "USD", "GBP", "NOK", "DKK", " kr"], kind: "currency" },
  net: { labels: ["Summa exkl. moms", "Totalt exkl. moms", "Belopp exkl. moms", "Net amount", "Netto", "Net"], fallbackTerms: [], kind: "amount" },
  vat: { labels: ["Mervärdesskatt", "Moms", "VAT"], fallbackTerms: [], exclude: /reg|exkl|excl|inkl|incl/i, kind: "amount" },
  total: { labels: ["Totalt att betala", "Summa att betala", "Att betala", "Total due", "Amount due", "Totalt", "Total"], fallbackTerms: [], exclude: /exkl|excl/i, kind: "amount" },
  org_number: { labels: ["Organisationsnummer", "Org.nr", "Org. nr", "Org nr", "Corporate ID"], fallbackTerms: [], kind: "org" },
};

/** The literal terms a scripted worker passes to search_text for a field. */
export const searchTerms = (f: FieldName) => [...RULES[f].labels, ...RULES[f].fallbackTerms];

const LETTER = "A-Za-zÅÄÖåäöÉé";
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Columns in a line are separated by two or more spaces. */
const segments = (text: string) => text.split(/\s{2,}/).map((s) => s.trim()).filter(Boolean);

const MONTHS: Record<string, number> = {
  january: 1, januari: 1, jan: 1, february: 2, februari: 2, feb: 2, march: 3, mars: 3, mar: 3, april: 4, apr: 4, may: 5, maj: 5,
  june: 6, juni: 6, jun: 6, july: 7, juli: 7, jul: 7, august: 8, augusti: 8, aug: 8, september: 9, sept: 9, sep: 9,
  october: 10, oktober: 10, oct: 10, okt: 10, november: 11, nov: 11, december: 12, dec: 12,
};
const pad = (n: number) => String(n).padStart(2, "0");
const validYmd = (y: number, m: number, d: number) => {
  const s = `${y}-${pad(m)}-${pad(d)}`;
  const t = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === s ? s : null;
};

export const AMOUNT_RE = /-?\d{1,3}(?:[  .,]\d{3})*[.,]\d{2}(?!\d)/g;

/** "12 500,00" -> 12500, "2,268.00" -> 2268, "-1 500,00" -> -1500. The last separator is the decimal one. */
export function parseAmount(raw: string): number {
  const s = raw.replace(/[  ]/g, "");
  const dec = Math.max(s.lastIndexOf(","), s.lastIndexOf("."));
  const intPart = s.slice(0, dec).replace(/[.,]/g, "");
  return Number(`${intPart}.${s.slice(dec + 1)}`);
}

type Parsed = { value: string | number; quote: string } | { missing: string };

function parseValue(kind: Rule["kind"], rest: string, field: FieldName): Parsed {
  if (/\[|oläslig|illegible|#|\?/i.test(rest) && kind !== "text") return { missing: `${field} is marked illegible or partly unreadable in the document` };
  switch (kind) {
    case "text": {
      const v = rest.trim();
      return v ? { value: v, quote: v } : { missing: `${field} label has no value` };
    }
    case "id": {
      const m = rest.match(/[A-Za-z0-9][A-Za-z0-9\-/]*/);
      return m && /\d/.test(m[0]) ? { value: m[0], quote: m[0] } : { missing: `${field} label has no identifier after it` };
    }
    case "org": {
      const m = rest.match(/\d{6}-\d{4}/);
      return m ? { value: m[0], quote: m[0] } : { missing: `${field} label has no number in the 556123-4567 format` };
    }
    case "currency": {
      const m = rest.match(/\b[A-Z]{3}\b/);
      return m ? { value: m[0], quote: m[0] } : { missing: "currency label has no ISO code" };
    }
    case "amount": {
      const all = [...rest.matchAll(AMOUNT_RE)];
      const m = all.at(-1);
      return m ? { value: parseAmount(m[0]), quote: m[0] } : { missing: `${field} label has no amount` };
    }
    case "date":
      return parseDate(rest, field);
  }
}

export function parseDate(rest: string, field = "date"): Parsed {
  let m = rest.match(/\d{4}-\d{2}-\d{2}/);
  if (m) {
    const [y, mo, d] = m[0].split("-").map(Number) as [number, number, number];
    const v = validYmd(y, mo, d);
    return v ? { value: v, quote: m[0] } : { missing: `${field} ${m[0]} is not a calendar date` };
  }
  m = rest.match(/(\d{1,2})\s+([A-Za-zåäö]+)\.?\s+(\d{4})/);
  if (m && MONTHS[m[2]!.toLowerCase()]) {
    const v = validYmd(Number(m[3]), MONTHS[m[2]!.toLowerCase()]!, Number(m[1]));
    if (v) return { value: v, quote: m[0] };
  }
  m = rest.match(/(\d{1,2})[./](\d{1,2})[./](\d{4})/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = Number(m[3]);
    let v: string | null = null;
    if (a > 12) v = validYmd(y, b, a); // day first
    else if (b > 12) v = validYmd(y, a, b); // month first
    else if (a === b) v = validYmd(y, a, b);
    else return { missing: `${field} ${m[0]} is ambiguous: day and month could be either way round` };
    return v ? { value: v, quote: m[0] } : { missing: `${field} ${m[0]} is not a calendar date` };
  }
  return { missing: `${field} label has no readable date` };
}

const result = (p: Parsed, confidence: number): FieldResult =>
  "missing" in p ? { value: null, quote: null, reason: p.missing } : { value: p.value, quote: p.quote, confidence };

/**
 * Read one field from lines. Lines are first filtered by the field's search terms, so a worker
 * that called search_text with searchTerms(field) and a baseline that read every line get the
 * same input and the same answer.
 */
export function readField(field: FieldName, lines: Line[]): FieldResult {
  const rule = RULES[field];
  const terms = searchTerms(field).map((t) => t.toLowerCase());
  const relevant = lines.filter((l) => terms.some((t) => l.text.toLowerCase().includes(t)));

  // 1. A label at the start of a column segment.
  for (const label of rule.labels) {
    const re = new RegExp(`^${esc(label)}(?![${LETTER}])`, "i");
    for (const l of relevant) {
      for (const seg of segments(l.text)) {
        if (!re.test(seg) || rule.exclude?.test(seg)) continue;
        const after = seg.slice(label.length);
        const colon = after.indexOf(":");
        const rest = colon >= 0 ? after.slice(colon + 1) : after;
        return result(parseValue(rule.kind, rest, field), 0.9);
      }
    }
  }

  // 2. Fallbacks for fields that are often written without a label.
  if (field === "supplier") {
    for (const l of relevant) {
      const seg = segments(l.text)[0];
      if (seg && /(?:\bAB|\bLtd|\bOy|\bInc\.?)$/.test(seg) && !/^(kund|customer|bill to|buyer|köpare)/i.test(seg)) return { value: seg, quote: seg, confidence: 0.6 };
    }
  }
  if (field === "currency") {
    for (const l of relevant) {
      const m = l.text.match(/\b(SEK|EUR|USD|GBP|NOK|DKK)\b/);
      if (m) return { value: m[1]!, quote: m[1]!, confidence: 0.6 };
    }
    if (relevant.some((l) => /\bkr\b/i.test(l.text))) return { value: null, quote: null, reason: 'only "kr" is written, which can mean SEK, NOK or DKK' };
  }
  return { value: null, quote: null, reason: `no ${field} found in the document` };
}
