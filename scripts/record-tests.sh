#!/usr/bin/env bash
# Run the test suites and write evidence/test-<date>.log (first line: session record).
# With PLAYWRIGHT=1 the browser test runs too and evidence/test-ui-<date>.log is written.
set -uo pipefail
cd "$(dirname "$0")/.."
PYTHON="${PYTHON:-python3}"
d=$(date -u +%F)
rev=$(git rev-parse --short HEAD 2>/dev/null || echo uncommitted)
session() { printf '{"type":"session","ts":"%s","code_rev":"%s","dataset":"invoices-v1 (7 samples from review-workflow)","node":"%s","python":"%s","mode":"fixture","suite":"%s"}\n' "$(date -u +%FT%TZ)" "$rev" "$(node --version)" "$($PYTHON --version 2>&1)" "$1"; }
out="evidence/test-$d.log"
{
  session "make test"
  echo "\$ $PYTHON -m unittest discover -s vendor/review-workflow/validator -v"
  $PYTHON -m unittest discover -s vendor/review-workflow/validator -v 2>&1
  if command -v python3.10 >/dev/null; then echo; echo "\$ python3.10 -m unittest discover -s vendor/review-workflow/validator"; python3.10 -m unittest discover -s vendor/review-workflow/validator 2>&1; fi
  echo; echo "\$ npm test   (PLAYWRIGHT unset: the browser test skips here and runs in the UI log)"
  env -u PLAYWRIGHT npm test 2>&1
} > "$out"
status=$?
grep -E '^# (tests|pass|fail|skipped)|^Ran |^OK' "$out"
if [ "${PLAYWRIGHT:-}" = "1" ]; then
  ui="evidence/test-ui-$d.log"
  { session "make test-ui"; echo "\$ PLAYWRIGHT=1 node --test test/ui.playwright.test.ts"; PLAYWRIGHT=1 node --no-warnings=ExperimentalWarning --import tsx --test test/ui.playwright.test.ts 2>&1; } > "$ui"
  grep -E '^# (tests|pass|fail|skipped)' "$ui"
fi
exit $status
