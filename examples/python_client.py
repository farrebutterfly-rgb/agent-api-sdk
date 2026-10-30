"""Tiny Python client for the same API, standard library only (Python 3.10+).

    API_URL=http://127.0.0.1:8787 API_TOKEN=... python3 examples/python_client.py [INV-001]

Creates a job for a sample invoice, polls until it settles and prints each field with its quote.
Without API_TOKEN it reads the public test token from data/test-tokens.json (local demo only).
The Python validator that produces the findings runs inside the server (vendor/review-workflow/validator).
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.environ.get("API_URL", "http://127.0.0.1:8787").rstrip("/")


def token() -> str:
    if os.environ.get("API_TOKEN"):
        return os.environ["API_TOKEN"]
    with open(os.path.join(HERE, "..", "data", "test-tokens.json"), encoding="utf-8") as f:
        return json.load(f)["tokens"]["a"]


def call(method: str, path: str, body: dict | None = None, headers: dict | None = None, tok: str | None = None) -> tuple[int, dict]:
    h = {"accept": "application/json", **(headers or {})}
    if tok:
        h["authorization"] = f"Bearer {tok}"
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        h["content-type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8"))


def main() -> int:
    sample = sys.argv[1] if len(sys.argv) > 1 else "INV-001"
    tok = token()

    status, body = call("GET", "/api/v1/jobs", tok="not-a-valid-token-at-all")
    print(f"python: bad token -> {status} {body['error']['code']}")

    status, created = call("POST", "/api/v1/jobs", {"sample": sample, "architecture": "single-agent"}, {"idempotency-key": f"py-{uuid.uuid4().hex[:8]}"}, tok)
    if status not in (200, 201):
        print(f"python: create failed {status} {created}", file=sys.stderr)
        return 1
    job_id = created["job_id"]
    print(f"python: created {job_id} for {sample} -> {status}")

    deadline = time.time() + 30
    while True:
        status, job = call("GET", f"/api/v1/jobs/{job_id}", tok=tok)
        if job["status"] in ("succeeded", "failed") or time.time() > deadline:
            break
        time.sleep(0.1)
    print(f"python: job {job['status']}")
    if job["status"] != "succeeded":
        return 1
    review = job["review"]
    for name, f in review["fields"].items():
        shown = f"quote {f['quote']!r}" if f["value"] is not None else f"reason {f.get('reason')!r}"
        print(f"python:   {name:<15} {json.dumps(f['value'], ensure_ascii=False):<28} {shown}")
    codes = [x["code"] for x in review["findings"]]
    print(f"python: validator findings {codes or 'none'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
