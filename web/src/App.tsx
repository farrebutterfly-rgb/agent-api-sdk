import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  ExtractReviewClient,
  FIELD_NAMES,
  type Architecture,
  type DraftField,
  type FieldName,
  type Finding,
  type JobSummary,
  type JobWithText,
  type Me,
  type SampleList,
} from "extract-review-sdk";

const TOKEN_KEY = "folio.token";
const AMOUNT: readonly FieldName[] = ["net", "vat", "total"];
const LABEL: Record<FieldName, string> = {
  supplier: "Supplier",
  invoice_number: "Invoice no.",
  invoice_date: "Invoice date",
  due_date: "Due date",
  currency: "Currency",
  net: "Net",
  vat: "VAT",
  total: "Total",
  org_number: "Org. no.",
};

const readToken = () => {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
};
const saveToken = (t: string) => {
  try {
    if (t) sessionStorage.setItem(TOKEN_KEY, t);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage blocked: the token lives in memory only */
  }
};

const jobFromHash = () => /^#\/jobs\/(job_[0-9a-f]{12}|[^/]+)$/.exec(location.hash)?.[1] ?? null;

function describe(e: unknown): string {
  if (e instanceof ApiError) {
    const issues = e.issues.length ? ` (${e.issues.map((i) => `${i.path}: ${i.message}`).join("; ")})` : "";
    const retry = e.retryAfterSeconds ? ` Retry in ${e.retryAfterSeconds} s.` : "";
    return `${e.status} ${e.code}: ${e.detail}${issues}.${retry}`;
  }
  return e instanceof Error ? e.message : String(e);
}

const fmt = (v: string | number | null) => (v === null ? "null" : typeof v === "number" ? v.toLocaleString("sv-SE", { minimumFractionDigits: 2 }) : v);

// ------------------------------------------------------------------ sign in

function SignIn({ onToken, error }: { onToken: (t: string) => void; error: string | null }) {
  const [value, setValue] = useState("");
  return (
    <main className="signin">
      <div className="signin-card rise">
        <p className="kicker">Folio · extraction review desk</p>
        <h1>
          Every value with its <em>source</em>.
        </h1>
        <p className="lede">Start an extraction job on a sample invoice or your own text file, read each field next to the line it came from, correct what is wrong, approve, export a local draft.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onToken(value.trim());
          }}
        >
          <label htmlFor="token">API token</label>
          <input id="token" name="token" type="password" autoComplete="off" spellCheck={false} value={value} onChange={(e) => setValue(e.target.value)} placeholder="ers_test_..." />
          <button type="submit" className="primary" disabled={value.trim().length < 16}>
            Open the desk
          </button>
        </form>
        {error && <p className="error" role="alert">{error}</p>}
        <p className="fineprint">Local demo: the two public test tokens are in <code>data/test-tokens.json</code>. The server checks the token on every request; this page only keeps it for the browser session.</p>
      </div>
    </main>
  );
}

// ------------------------------------------------------------------ new job

function NewJob({ client, samples, onCreated }: { client: ExtractReviewClient; samples: SampleList["samples"]; onCreated: (id: string) => void }) {
  const [sample, setSample] = useState(samples[samples.length - 1]?.id ?? "");
  const [upload, setUpload] = useState<{ name: string; text: string } | null>(null);
  const [arch, setArch] = useState<Architecture>("two-agent");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key per intended job: a double click or a retry after a network error reuses it.
  const key = useRef(`web-${crypto.randomUUID()}`);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const input = upload ? { document: upload, architecture: arch } : { sample, architecture: arch };
      const r = await client.createJob(input, { idempotencyKey: key.current });
      key.current = `web-${crypto.randomUUID()}`;
      onCreated(r.job_id);
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel newjob" aria-labelledby="newjob-h">
      <h2 id="newjob-h">New job</h2>
      <fieldset disabled={busy}>
        <legend>Document</legend>
        <ul className="samples">
          {samples.map((s) => (
            <li key={s.id}>
              <label className={!upload && sample === s.id ? "on" : ""}>
                <input type="radio" name="sample" value={s.id} checked={!upload && sample === s.id} onChange={() => { setUpload(null); setSample(s.id); }} />
                <span className="mono">{s.id}</span>
                <span className="case">{s.case}</span>
              </label>
            </li>
          ))}
        </ul>
        <label className={`upload ${upload ? "on" : ""}`}>
          <input
            type="file"
            accept=".txt,text/plain"
            aria-label="Upload a text file"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              const name = f.name.replace(/[^A-Za-z0-9 _.-]/g, "_").slice(0, 80) || "upload.txt";
              setUpload({ name: /^[A-Za-z0-9]/.test(name) ? name : `f${name}`.slice(0, 80), text: await f.text() });
            }}
          />
          <span>{upload ? `${upload.name} · ${upload.text.length} chars` : "or upload a .txt file"}</span>
        </label>
      </fieldset>
      <fieldset disabled={busy} className="arch">
        <legend>Architecture</legend>
        {(["two-agent", "single-agent"] as const).map((a) => (
          <label key={a} className={arch === a ? "on" : ""}>
            <input type="radio" name="arch" value={a} checked={arch === a} onChange={() => setArch(a)} />
            {a === "two-agent" ? "planner + worker" : "single agent"}
          </label>
        ))}
      </fieldset>
      <button className="primary wide" onClick={start} disabled={busy || (!upload && !sample)}>
        {busy ? "Starting..." : "Start extraction"}
      </button>
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

// ------------------------------------------------------------------ job list

function JobListPanel({ jobs, active, onPick }: { jobs: JobSummary[]; active: string | null; onPick: (id: string) => void }) {
  return (
    <section className="panel joblist" aria-labelledby="jobs-h">
      <h2 id="jobs-h">Your jobs</h2>
      {jobs.length === 0 ? (
        <p className="muted">None yet.</p>
      ) : (
        <ol>
          {jobs.map((j) => (
            <li key={j.job_id}>
              <button className={`jobrow ${active === j.job_id ? "on" : ""}`} onClick={() => onPick(j.job_id)}>
                <span className="mono">{j.document_name}</span>
                <span className={`chip ${j.review_state ?? j.status}`}>{j.review_state ?? j.status}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ document with quotes

function DocumentPane({ text, fields, active, onPick, onSelect }: { text: string; fields: Record<FieldName, DraftField> | null; active: FieldName | null; onPick: (f: FieldName) => void; onSelect: (s: string) => void }) {
  const segments = useMemo(() => {
    if (!fields) return [{ text, field: null as FieldName | null }];
    const spans: { start: number; end: number; field: FieldName }[] = [];
    for (const f of FIELD_NAMES) {
      const q = fields[f].quote;
      if (!q) continue;
      const start = text.indexOf(q);
      if (start < 0) continue;
      const end = start + q.length;
      if (spans.some((s) => start < s.end && end > s.start)) continue;
      spans.push({ start, end, field: f });
    }
    spans.sort((a, b) => a.start - b.start);
    const out: { text: string; field: FieldName | null }[] = [];
    let at = 0;
    for (const s of spans) {
      if (s.start > at) out.push({ text: text.slice(at, s.start), field: null });
      out.push({ text: text.slice(s.start, s.end), field: s.field });
      at = s.end;
    }
    if (at < text.length) out.push({ text: text.slice(at), field: null });
    return out;
  }, [text, fields]);

  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (!active) return;
    ref.current?.querySelector(`mark[data-field="${active}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [active]);

  return (
    <section className="paper" aria-label="Document">
      <pre
        ref={ref}
        data-testid="document"
        onMouseUp={() => {
          const s = window.getSelection()?.toString() ?? "";
          if (s.trim()) onSelect(s);
        }}
      >
        {segments.map((s, i) =>
          s.field ? (
            <mark key={i} data-field={s.field} className={`${active === s.field ? "active" : ""} ${fields?.[s.field].source === "human" ? "human" : ""}`} onClick={() => onPick(s.field!)} title={LABEL[s.field]}>
              {s.text}
            </mark>
          ) : (
            <span key={i}>{s.text}</span>
          ),
        )}
      </pre>
    </section>
  );
}

// ------------------------------------------------------------------ one field row with its editor

function FieldRow({ name, f, active, selection, onPick, onSave, locked }: { name: FieldName; f: DraftField; active: boolean; selection: string; onPick: () => void; onSave: (input: { value: string | number | null; quote: string | null; reason?: string }) => Promise<string | null>; locked: boolean }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [quote, setQuote] = useState("");
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const changed = f.source === "human";

  const open = () => {
    setValue(f.value === null ? "" : String(f.value));
    setQuote(f.quote ?? "");
    setReason("");
    setErr(null);
    setEditing(true);
    onPick();
  };
  const save = async () => {
    const raw = value.trim();
    let v: string | number | null = raw === "" ? null : raw;
    if (v !== null && AMOUNT.includes(name)) {
      const n = Number(raw.replace(/\s/g, "").replace(",", "."));
      v = Number.isFinite(n) ? n : raw;
    }
    const e = await onSave({ value: v, quote: quote.trim() === "" ? null : quote, ...(v === null ? { reason: reason.trim() } : {}) });
    setErr(e);
    if (!e) setEditing(false);
  };

  return (
    <li className={`field ${active ? "active" : ""} ${f.value === null ? "isnull" : ""}`} data-field={name}>
      <button className="fieldhead" onClick={onPick} aria-label={`Show ${LABEL[name]} in the document`}>
        <span className="fname">{LABEL[name]}</span>
        <span className="fvalue mono">{f.value === null ? <span className="nullv">no value</span> : fmt(f.value)}</span>
        <span className={`src ${f.source}`}>{changed ? "corrected" : "model"}</span>
      </button>
      <div className="fdetail">
        {f.value === null ? <p className="reason">{f.reason}</p> : f.quote ? <p className="quote">“{f.quote}”</p> : <p className="reason">entered without a source quote</p>}
        {changed && (
          <p className="was">
            model proposed <span className="mono">{fmt(f.proposed.value)}</span>
            {f.corrected_by ? ` · corrected by ${f.corrected_by}` : ""}
          </p>
        )}
        {!editing && !locked && (
          <button className="ghost" onClick={open}>
            Correct
          </button>
        )}
      </div>
      {editing && (
        <form
          className="editor"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label>
            Value <span className="hint">{AMOUNT.includes(name) ? "number" : name.endsWith("date") ? "YYYY-MM-DD" : name === "currency" ? "ISO code, e.g. SEK" : "text"} · empty means no value</span>
            <input name="value" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
          </label>
          <label>
            Source quote <span className="hint">exact text from the document</span>
            <span className="row">
              <input name="quote" value={quote} onChange={(e) => setQuote(e.target.value)} />
              <button type="button" className="ghost" disabled={!selection} onClick={() => setQuote(selection)} title="Select text in the document first">
                Use selection
              </button>
            </span>
          </label>
          {value.trim() === "" && (
            <label>
              Reason <span className="hint">required for no value</span>
              <input name="reason" value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
          )}
          <span className="row">
            <button type="submit" className="primary">Save correction</button>
            <button type="button" className="ghost" onClick={() => setEditing(false)}>Cancel</button>
          </span>
          {err && <p className="error" role="alert">{err}</p>}
        </form>
      )}
    </li>
  );
}

function Findings({ items }: { items: Finding[] }) {
  if (items.length === 0) return <p className="muted">Python validator: no findings.</p>;
  return (
    <ul className="findings" aria-label="Validator findings">
      {items.map((f, i) => (
        <li key={i} className={f.severity}>
          <span className="sev">{f.severity}</span>
          <span className="mono code">{f.code}</span>
          <span>{f.message}</span>
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------ job detail

function JobDetail({ client, jobId, onChanged }: { client: ExtractReviewClient; jobId: string; onChanged: () => void }) {
  const [job, setJob] = useState<JobWithText | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<FieldName | null>(null);
  const [selection, setSelection] = useState("");
  const [ack, setAck] = useState<string[]>([]);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const j = await client.getJob(jobId);
      setJob(j);
      setError(null);
      return j;
    } catch (e) {
      setJob(null);
      setError(describe(e));
      return null;
    }
  }, [client, jobId]);

  useEffect(() => {
    setJob(null);
    setNotice(null);
    setAck([]);
    let stop = false;
    let t: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const j = await load();
      if (stop) return;
      if (j && (j.status === "queued" || j.status === "running")) t = setTimeout(tick, 300);
      else onChanged();
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, [jobId, load, onChanged]);

  if (error) {
    return (
      <section className="detail">
        <div className="denied" role="alert">
          <p className="kicker">Not available</p>
          <p>{error}</p>
          <p className="muted">A job that belongs to another user is answered exactly like a job that does not exist.</p>
        </div>
      </section>
    );
  }
  if (!job) return <section className="detail"><p className="muted">Loading {jobId}...</p></section>;

  const review = job.review;
  const save = async (field: FieldName, input: { value: string | number | null; quote: string | null; reason?: string }) => {
    setNotice(null);
    try {
      await client.correctField(job.job_id, { field, ...input });
      await load();
      onChanged();
      return null;
    } catch (e) {
      return describe(e);
    }
  };
  const approve = async () => {
    setBusy(true);
    try {
      await client.approve(job.job_id, { acknowledge: ack });
      await load();
      onChanged();
    } catch (e) {
      setNotice({ kind: "error", text: describe(e) });
    } finally {
      setBusy(false);
    }
  };
  const doExport = async () => {
    setBusy(true);
    try {
      const r = await client.exportDraft(job.job_id);
      const blob = new Blob([JSON.stringify(r.draft, null, 2) + "\n"], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${job.job_id}.draft.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      setNotice({ kind: "ok", text: `Exported. The server wrote ${r.file}; your browser downloaded the same JSON.` });
      await load();
      onChanged();
    } catch (e) {
      setNotice({ kind: "error", text: describe(e) });
    } finally {
      setBusy(false);
    }
  };
  const errorCodes = review ? [...new Set(review.findings.filter((f) => f.severity === "error").map((f) => f.code))] : [];

  return (
    <section className="detail" aria-label={`Job ${job.job_id}`}>
      <header className="jobhead rise">
        <div>
          <p className="kicker ids">{job.job_id} · key {job.idempotency_key}</p>
          <h2>{job.document.name}</h2>
          <p className="muted">
            {job.document.source} · {job.document.chars} chars · {job.architecture}
            {review ? ` · ${review.extraction.model_calls} model calls, ${review.extraction.tool_calls} tool calls (${review.extraction.mode})` : ""}
          </p>
        </div>
        <ol className="steps" aria-label="Job steps" data-testid="steps">
          {job.steps.map((s) => (
            <li key={s.name} className={s.status}>
              <span className="dot" />
              <span className="mono">{s.name}</span>
              <span className="muted">{s.status}{s.attempts > 1 ? ` ×${s.attempts}` : ""}</span>
            </li>
          ))}
          <li className={`final ${job.status}`} data-testid="job-status">
            <span className="dot" />
            <span>{job.status}</span>
          </li>
        </ol>
      </header>

      {job.error && <p className="error" role="alert">{job.error.code}: {job.error.message}</p>}

      <div className="desk">
        <DocumentPane text={job.document_text} fields={review?.fields ?? null} active={active} onPick={setActive} onSelect={setSelection} />
        <div className="sheet">
          {!review ? (
            <p className="muted">Fields appear when the job has succeeded.</p>
          ) : (
            <>
              <div className="sheethead">
                <h3>Fields</h3>
                <span className={`chip ${review.state}`} data-testid="review-state">{review.state.replace("_", " ")}</span>
              </div>
              <ul className="fields">
                {FIELD_NAMES.map((f) => (
                  <FieldRow key={f} name={f} f={review.fields[f]} active={active === f} selection={selection} onPick={() => setActive(f)} onSave={(i) => save(f, i)} locked={review.state === "exported"} />
                ))}
              </ul>
              <h3>Validator</h3>
              <Findings items={review.findings} />
              {review.corrections.length > 0 && (
                <>
                  <h3>Corrections</h3>
                  <ol className="history">
                    {review.corrections.map((c) => (
                      <li key={c.seq}>
                        <span className="mono">#{c.seq}</span> {LABEL[c.field]}: <span className="mono">{fmt(c.previous.value)}</span> → <span className="mono">{fmt(c.value)}</span> <span className="muted">by {c.reviewer}</span>
                      </li>
                    ))}
                  </ol>
                </>
              )}
              <div className="actions">
                {errorCodes.length > 0 && review.state === "in_review" && (
                  <fieldset className="ack">
                    <legend>Acknowledge errors that are on the paper itself</legend>
                    {errorCodes.map((c) => (
                      <label key={c}>
                        <input type="checkbox" checked={ack.includes(c)} onChange={(e) => setAck(e.target.checked ? [...ack, c] : ack.filter((x) => x !== c))} />
                        <span className="mono">{c}</span>
                      </label>
                    ))}
                  </fieldset>
                )}
                <button className="primary" onClick={approve} disabled={busy || review.state !== "in_review"}>
                  {review.state === "in_review" ? "Approve draft" : "Approved"}
                </button>
                <button className="ink" onClick={doExport} disabled={busy || review.state === "in_review"}>
                  Export local draft
                </button>
              </div>
              {notice && <p className={notice.kind} role="status" data-testid="notice">{notice.text}</p>}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ app

export function App() {
  const [token, setToken] = useState(readToken);
  const [me, setMe] = useState<Me | null>(null);
  const [samples, setSamples] = useState<SampleList["samples"]>([]);
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [active, setActive] = useState<string | null>(jobFromHash);
  const [signInError, setSignInError] = useState<string | null>(null);

  const client = useMemo(() => (token ? new ExtractReviewClient({ baseUrl: location.origin, token }) : null), [token]);

  useEffect(() => {
    const on = () => setActive(jobFromHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  useEffect(() => {
    if (!client) return;
    (async () => {
      try {
        const [m, s, j] = await Promise.all([client.me(), client.samples(), client.listJobs()]);
        setMe(m);
        setSamples(s.samples);
        setJobs(j.jobs);
        setSignInError(null);
      } catch (e) {
        setSignInError(describe(e));
        setToken("");
        saveToken("");
      }
    })();
  }, [client]);

  const refreshJobs = useCallback(() => {
    client?.listJobs().then((j) => setJobs(j.jobs)).catch(() => {});
  }, [client]);

  const pick = (id: string) => {
    location.hash = `#/jobs/${id}`;
  };

  if (!client || !me) {
    return <SignIn error={signInError} onToken={(t) => { saveToken(t); setToken(t); }} />;
  }

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">Folio<span className="dotmark">.</span></span>
        <span className="muted">extraction review desk</span>
        <span className="spacer" />
        <span className="who" data-testid="who">
          {me.name}
          {me.test_user && <span className="testtag">test user</span>}
        </span>
        <button className="ghost" onClick={() => { saveToken(""); setToken(""); setMe(null); location.hash = ""; }}>
          Sign out
        </button>
      </header>
      <aside className="rail">
        <NewJob client={client} samples={samples} onCreated={(id) => { refreshJobs(); pick(id); }} />
        <JobListPanel jobs={jobs} active={active} onPick={pick} />
      </aside>
      <main className="main">
        {active ? (
          <JobDetail key={active} client={client} jobId={active} onChanged={refreshJobs} />
        ) : (
          <section className="nothing rise">
            <p className="kicker">Nothing open</p>
            <h2>Pick a sample, start a job, then read the fields against the paper.</h2>
            <p className="muted">Each value carries the exact text it was read from. Missing or ambiguous values stay empty with a reason. A Python validator checks types, net + vat = total and due date after invoice date.</p>
          </section>
        )}
      </main>
    </div>
  );
}
