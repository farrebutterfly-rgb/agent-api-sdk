# Decisions

**Vendor earlier projects, byte for byte, at a recorded commit.** agent-api-sdk must install from a clean checkout, so `file:../` dependencies were out. The needed source of review-workflow and durable-jobs is copied into `vendor/` with `git show <commit>:<path>` and not edited. `VENDORED.md` names the repo, the commit and every file; `scripts/check-vendor.sh` compares the copies with that commit when the sibling repo exists and skips (not fails) when it does not. Anything agent-api-sdk needs that the earlier projects do not offer is written in `server/`, outside the vendored tree. The cost: a fix in review-workflow or durable-jobs reaches agent-api-sdk only when someone re-vendors on purpose, which is the point of a versioned part.

**One schema, three uses.** The zod schemas in `sdk/src/schemas.ts` are parsed by the SDK on every response, used by the server to check every response before sending it (a mismatch is a 500, not silent drift), and turned into `openapi.json` by `scripts/gen-openapi.ts`; a test fails if the committed file is stale. This is agent-toolkit's "one schema, two uses" carried to the HTTP boundary.

**The web app uses the SDK.** The React UI talks to the API only through `extract-review-sdk`, bundled by Vite. So "web and SDK complete a job through the same API" is literal: same client code, same routes, and the browser test checks that a correction made in the UI is what the SDK reads back.

**Durable jobs for extraction, the review store for review.** The job has three checkpointed steps (`read_document`, `extract_fields`, `open_review`) run by durable-jobs's worker inside the server process. Review state (proposal, corrections, approvals) stays in review-workflow's `ReviewStore` files, keyed by job id. `open_review` is idempotent: a proposal that already exists for the same document hash, left by a crashed run, is accepted instead of failing. A restart test kills the server process with SIGKILL mid-job and shows a new process finishing it without re-running the done step.

**Document text lives in its own table, not in the job payload.** durable-jobs logs the payload in its event table and agent-api-sdk forwards job events to the structured log. Keeping the payload to `{user_id, document_id, architecture}` means neither the events nor the log can carry document text. Document ids are derived from user, name and text hash, so a retried upload produces the identical payload and the idempotency check sees a replay, not a conflict.

**Idempotency keys are scoped per user.** durable-jobs's table has one global `UNIQUE(idempotency_key)`. agent-api-sdk stores `<user_id>:<key>` and strips the prefix in responses. Without the scope, user B reusing user A's key would get a 409 that leaks the existence of A's job id.

**Another user's job is a 404, not a 403.** The answer for "exists but not yours" is byte-identical (apart from request id) to "does not exist", so job ids cannot be probed. Ownership is checked in one place (`Views.owned`) before any route-specific work.

**Test auth, clearly labelled.** Two seeded test users with random tokens; the users file stores only SHA-256 hashes (tokens are 18 random bytes, so no slow hash is needed), compared with `timingSafeEqual`. The plaintext test tokens are public in `data/test-tokens.json` so anyone can run the demo. The server refuses a `test_only` users file in production unless `ALLOW_TEST_USERS=1`; `scripts/new-token.ts` makes a real users file. This is not OAuth, sessions or user management, and it does not claim to be.

**The reviewer is the token's user.** Corrections and approvals take the reviewer from authentication, never from the request body, so the audit trail in the export cannot be spoofed by a client.

**Fixed-window rate limit in memory.** Simple, testable with a fake clock, correct for one process. It would not hold across replicas; that needs a shared store and is out of scope.

**Allowlist logger.** The logger drops every key not on a fixed list and cuts long strings. A caller cannot log a token or a body by accident, and two tests plus `make demo` grep the real log of a run for the tokens and for document text.

**node:http, no framework.** Eight routes, one error shape, one place for auth and rate limit. A framework would add dependencies without removing much code. Static files are served by the same server with a SPA fallback, a path-traversal guard and a CSP.

**Vite without the React plugin.** esbuild compiles JSX with the automatic runtime; fast refresh is not needed for a demo, and it avoids Babel. Vite brings rollup and esbuild native binaries as optional per-platform packages; `package-lock.json` lists them for macOS arm64, Linux arm64 and Linux x64. This is the one place the "no native dependencies" preference is bent, and only at build time.

**Validator findings cached per correction count.** review-workflow's `ReviewStore.findings` spawns Python twice. The UI polls; caching by `(job, number of corrections)` keeps polling cheap without ever showing stale findings.

**Not done on purpose.** No OAuth or user sign-up, no multi-instance rate limit, no several workers (durable-jobs tested one), no streaming status (polling is enough here), no publishing the SDK to npm, no deployment. Each is a separate claim that would need its own verification.
