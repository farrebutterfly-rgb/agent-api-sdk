# Vendored: review-workflow

| | |
| --- | --- |
| Source repo | `review-workflow` (portfolio project 4) |
| Commit | `b9d05133d46f20ef1262a84605857217191c38a2` |
| Copied on | 2026-10-30 |
| Changes | none: every file below is byte-identical to that commit |

Copied with `git show <commit>:<path>`, so uncommitted work in the source repo cannot leak in. Paths are kept as in the source repo, because `src/validator.ts` finds the Python validator at `../validator/validate.py`.

Not copied: `src/cli/` (the P4 command-line tools), `src/evaluate.ts` (scoring against P4's gold labels, reads P4's `data/`), tests other than the Python validator's, data.

Used by P8: `runExtraction`, `ReviewStore`, `FIELD_NAMES` and the Python validator (`validator/validate.py`, run as a child process by `runValidator`; its own unit tests are `validator/test_validate.py`, run by `make test-py`).

## Files

```
src/agents/finals.ts
src/agents/prompts.ts
src/budget.ts
src/errors.ts
src/extract.ts
src/index.ts
src/log.ts
src/loop.ts
src/model/anthropic.ts
src/model/fixtures.ts
src/model/heuristics.ts
src/model/scripted.ts
src/model/types.ts
src/pipeline.ts
src/registry.ts
src/review/store.ts
src/schema.ts
src/tools/readTools.ts
src/tools/types.ts
src/validator.ts
validator/test_validate.py
validator/validate.py
```

Check: `scripts/check-vendor.sh` compares each file with `git show b9d05133d46f20ef1262a84605857217191c38a2:<path>` in `../review-workflow` when that repo exists next to this one.
