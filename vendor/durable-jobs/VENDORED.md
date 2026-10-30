# Vendored: durable-jobs

| | |
| --- | --- |
| Source repo | `durable-jobs` (portfolio project 7) |
| Commit | `72a8a2455bbd1642c177ed2192ee2b0f1749f46f` |
| Copied on | 2026-10-30 |
| Changes | none: every file below is byte-identical to that commit |

Copied with `git show <commit>:<path>`. Paths are kept as in the source repo.

Not copied: P7's HTTP server, its document pipeline and extractor (P8 has its own steps built on review-workflow), fault injection, CLI, tests.

Used by P8: `createJobStore`, `submitJob` (idempotency: same key and body returns the job, same key with another body throws `IdempotencyConflictError`), `runWorker` (lease, heartbeat, checkpoints, bounded retries), `getJob` (the `JobView` shape that P8's `Job` is built from), `TransientError`, `PermanentError`.

## Files

```
src/errors.ts
src/json.ts
src/store.ts
src/view.ts
src/worker.ts
```

Check: `scripts/check-vendor.sh` compares each file with `git show 72a8a2455bbd1642c177ed2192ee2b0f1749f46f:<path>` in `../durable-jobs` when that repo exists next to this one.
