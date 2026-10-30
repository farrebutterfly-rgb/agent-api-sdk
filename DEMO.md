# Demo script (2 to 3 minutes)

A script to record or present instead of a video. Everything runs locally in fixture mode: no API key, no cost. Times are a guide.

## Before you start

```bash
make install                 # npm ci + web build
make serve                   # API and UI on http://127.0.0.1:8787, 400 ms pause per step so status is visible
```

Open two terminals next to the browser. Have `data/test-tokens.json` open to copy tokens from.

## 0:00 to 0:20: what it is

**Do:** show the sign-in page at http://127.0.0.1:8787.

**Say:** "This is a small product for document extraction with human review. An agent workflow from an earlier project extracts nine invoice fields, each with the exact text it came from. A Python validator checks the result. A person corrects, approves and exports a local draft. The web app, a typed SDK and a Python script all use the same HTTP API."

## 0:20 to 1:10: the web flow

**Do:** paste token `a`, open the desk. Pick `INV-016`, keep "planner + worker", click **Start extraction**.

**Say (while the three step dots fill):** "The job runs in a durable worker: read the document, extract, open the review. Each step is checkpointed, so a server restart continues where it stopped."

**Do:** click the **Total** row, then the highlighted `12 500,00` in the document.

**Say:** "Every value is linked to its quote in the document. Three fields are empty: the reading rules could not find a supplier, an unlabelled invoice number, or a net written under 'Summa'. They stay empty with a reason instead of being guessed. The validator lists them as missing."

**Do:** on **Net**, click **Correct**, type `10000`, select `10 000,00` in the document, click **Use selection**, **Save correction**.

**Say:** "The correction is stored next to the model's proposal, not over it. The validator re-runs: net plus VAT now equals the total."

**Do:** click **Approve draft**, then **Export local draft**. Open the downloaded JSON briefly.

**Say:** "The export says which values came from the model and which from the reviewer, and keeps the original proposal. Nothing is sent anywhere."

## 1:10 to 1:50: the same API from the SDK

**Do:** in a terminal:

```bash
npm run example -- INV-016
```

**Say (while it prints):** "This is a separate program using the TypeScript SDK. Every response is validated against the same zod schemas the server uses. It sends the create request twice with one Idempotency-Key and gets the same job back. It waits for the job, prints fields and findings, fills in the three empty fields with their quotes, approves and exports."

**Point at:** `created=false (same job: true)`, the three `#n` correction lines, `exported exports/u_test_a/...`.

## 1:50 to 2:30: what is refused

**Point at** the last lines of the example output:

```
second user reads job_...: 404 JOB_NOT_FOUND "no job job_... for this user"
empty create request: 400 INVALID_INPUT (root): send exactly one of sample or document
```

**Say:** "User B gets exactly the answer for a job that does not exist, so ids cannot be probed. Bad input comes back as 400 with the field that failed."

**Do:** in the browser, **Sign out**, sign in with token `b`, paste the URL of A's job (`#/jobs/<id>`).

**Say:** "Same in the UI: not found for this user."

**Do (optional, 10 s):** `curl -s localhost:8787/api/v1/jobs` (no token): `401 UNAUTHENTICATED`.

## 2:30 to 2:50: what this is and is not

**Say:** "Three honest limits. The extraction here is a scripted fixture model, so it shows the workflow, not model quality; live mode exists but has not been run. The tokens are public test tokens. And it is deployment-ready, with a Dockerfile and a smoke test, but not deployed: there is no verified public URL."

## Without a browser

`make demo` runs the SDK example and the Python client against a fresh server and stops it; the output is the same as in the SDK section above.
