#!/usr/bin/env bash
# Smoke test for a running deployment. Needs only curl and python3 (no Node, no repo install).
#   API_TOKEN=... scripts/smoke.sh https://your-host.example
# Checks /healthz, runs one sample job to the end and checks that a bad token gets 401.
# Exit 0 only if all checks pass.
set -euo pipefail
BASE="${1:?usage: API_TOKEN=... scripts/smoke.sh <base-url>}"
BASE="${BASE%/}"
TOKEN="${API_TOKEN:?set API_TOKEN to a token the deployment accepts}"
SAMPLE="${SMOKE_SAMPLE:-INV-001}"
KEY="smoke-$(date +%s)-$$"
json() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

health=$(curl -fsS --max-time 10 "$BASE/healthz")
echo "healthz: $health"
[ "$(echo "$health" | json 'd["ok"]')" = "True" ] || { echo "FAIL healthz"; exit 1; }

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H "authorization: Bearer smoke-invalid-token-000" "$BASE/api/v1/jobs")
echo "bad token: HTTP $code"
[ "$code" = "401" ] || { echo "FAIL expected 401"; exit 1; }

created=$(curl -fsS --max-time 10 -X POST "$BASE/api/v1/jobs" -H "authorization: Bearer $TOKEN" -H "idempotency-key: $KEY" -H 'content-type: application/json' -d "{\"sample\":\"$SAMPLE\"}")
job=$(echo "$created" | json 'd["job_id"]')
echo "created: $created"

for _ in $(seq 1 100); do
  view=$(curl -fsS --max-time 10 -H "authorization: Bearer $TOKEN" "$BASE/api/v1/jobs/$job")
  status=$(echo "$view" | json 'd["status"]')
  case "$status" in succeeded|failed) break ;; esac
  sleep 0.3
done
echo "job $job: $status"
[ "$status" = "succeeded" ] || { echo "FAIL job did not succeed: $(echo "$view" | json 'd["error"]')"; exit 1; }
echo "$view" | json '"fields: " + ", ".join(k + "=" + repr(v.get("value")) for k, v in d["review"]["fields"].items())'
echo "$view" | json '"findings: " + (", ".join(f["code"] for f in d["review"]["findings"]) or "none")'
echo "SMOKE OK $BASE"
