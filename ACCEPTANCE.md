# Acceptance

Checked 2026-10-30 on Node 22.23.4 and Python 3.13 (validator tests also on Python 3.10), Linux x64. Fixture extraction only. "Not run" means not run, not passed.

Acceptance criteria:

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Someone else can follow the README from a clean environment with fixtures | **Partly.** `rm -rf node_modules web/dist .data && npm ci && make check` passed in the build container, and the repo installs without its sibling repos (vendored parts, no `file:` dependencies). Not yet tried by a second person or on macOS. | `evidence/test-*.log`, `evidence/demo-*.log`; test `no file:../ dependencies`; `scripts/check-vendor.sh` |
| 2 | The web UI and the SDK complete a full job through the same API | Passed | `test/ui.playwright.test.ts` (run with PLAYWRIGHT=1, `evidence/test-ui-*.log`, `evidence/ui/*.png`): a job created by the SDK is corrected, approved and exported in the browser and read back by the SDK; a job started in the browser runs to `succeeded`. SDK alone: `test/sdk.test.ts`, `examples/sdk-client.ts` in `evidence/demo-*.log`. The UI uses the SDK for every call. |
| 3 | Invalid input, missing authorisation, unknown job and rate limit have clear results | Passed | `test/api.test.ts`: 400 `INVALID_INPUT` with field paths (8 bodies), `INVALID_JSON`, `MISSING_IDEMPOTENCY_KEY`, 413; 401 for missing, malformed and unknown tokens; 404 `JOB_NOT_FOUND` for unknown ids and for another user's job (identical message); 429 `RATE_LIMITED` with `Retry-After`. Typed in the SDK: `test/sdk.test.ts`. |
| 4 | TypeScript, React and Python each have a demonstrated function | Passed | TypeScript: server and SDK (all tests). React: the UI in the browser test. Python: `validate.py` runs in every job and after every correction (its findings appear in the demo output) with 20 unit tests; `examples/python_client.py` runs in `make demo` and in `test/e2e.test.ts`. |
| 5 | API description, SDK example, architecture sketch, test log and a 2 to 3 minute demo exist | Passed | [API.md](API.md) + generated [openapi.json](openapi.json) (test: up to date), [examples/sdk-client.ts](examples/sdk-client.ts), diagram in [README.md](README.md), `evidence/test-*.log`, [DEMO.md](DEMO.md) (script instead of a video) |

Show list from the plan: "the same job via web and SDK, and one denied access attempt": browser test steps 1 to 7 and 9; the denied attempt is also in the demo output (`second user reads ...: 404 JOB_NOT_FOUND`) and in `evidence/ui/3-denied.png`.

Other checks done:

| Check | Status | Evidence |
| --- | --- | --- |
| Backend access: user B cannot read, correct, approve or export user A's job, or see it in a list | Passed | `test/api.test.ts` "another user's job is 404" |
| Idempotency-Key: replay returns the same job, other body 409, 6 parallel requests give one job, keys scoped per user | Passed | `test/api.test.ts`, `test/sdk.test.ts` |
| Restart: server SIGKILLed after a checkpoint, a new server process finishes the job, done step not re-run | Passed | `test/sdk.test.ts` "restart recovery" |
| Logs contain no tokens or document text | Passed | `test/api.test.ts` (canary document), `test/e2e.test.ts` (whole run), `make demo` (0 occurrences), `test/unit.test.ts` (allowlist) |
| Corrections stored separately from the model proposal; export needs a current approval; validator errors block approval unless acknowledged | Passed | `test/api.test.ts` "full review flow", "validator errors block approval" |
| Vendored copies byte-identical to the recorded commits | Passed (siblings present here) | `scripts/check-vendor.sh`, `test/e2e.test.ts` |
| Smoke script against a running server | Passed against the local server only | `test/e2e.test.ts` "scripts/smoke.sh" |
| Docker image builds and runs | **Not run.** No Docker daemon in the build environment. | [Dockerfile](Dockerfile) |
| Deployment and smoke test against a public URL | **Not run.** Nothing deployed. Verified public URL: none. | |
| Live model extraction (`make live`) | **Not run.** No `ANTHROPIC_API_KEY`. Without it the server exits with code 2 and a clear message (tested). | `test/api.test.ts` "live mode without ANTHROPIC_API_KEY" |

## Open gaps

- No live model run, so nothing here says how well a real model extracts.
- No deployment, no cloud, Docker build not run.
- Test auth only: no OAuth, no real user management.
- Not yet followed from the README by another person.
