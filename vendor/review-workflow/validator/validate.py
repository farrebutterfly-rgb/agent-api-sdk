#!/usr/bin/env python3
"""Deterministic checks for one invoice extraction. Standard library only, Python 3.10+.

Reads JSON on stdin:
    {"fields": {name: {"value": ..., "quote": ..., "reason": ...}, ...},
     "doc_text": "optional, enables the quote check",
     "checks": ["types", "quotes", "totals", "dates", "missing"],   (optional, default all)
     "tolerance": 0.01}                                             (optional)

Prints JSON on stdout:
    {"ok": bool, "checks_run": [...], "findings": [{"code", "severity", "field"?, "message"}]}

"ok" is false when any finding has severity "error". Exit code 0 when the input could be read,
2 when it could not (the reason is printed as JSON on stdout as well).
"""

from __future__ import annotations

import datetime as _dt
import json
import re
import sys
from typing import Any, Dict, List, Optional

FIELDS = ["supplier", "invoice_number", "invoice_date", "due_date", "currency", "net", "vat", "total", "org_number"]
AMOUNTS = ["net", "vat", "total"]
DATES = ["invoice_date", "due_date"]
ALL_CHECKS = ["types", "quotes", "totals", "dates", "missing"]
DEFAULT_TOLERANCE = 0.01

_ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_CURRENCY = re.compile(r"^[A-Z]{3}$")
_ORG = re.compile(r"^\d{6}-\d{4}$")

Finding = Dict[str, Any]


def _finding(code: str, severity: str, message: str, field: Optional[str] = None) -> Finding:
    f: Finding = {"code": code, "severity": severity, "message": message}
    if field is not None:
        f["field"] = field
    return f


def _is_number(v: Any) -> bool:
    # bool is a subclass of int in Python; True is not an amount.
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def parse_date(v: Any) -> Optional[_dt.date]:
    if not isinstance(v, str) or not _ISO_DATE.match(v):
        return None
    try:
        return _dt.date(int(v[0:4]), int(v[5:7]), int(v[8:10]))
    except ValueError:
        return None


def _type_problem(name: str, v: Any) -> Optional[str]:
    if name in AMOUNTS:
        return None if _is_number(v) else "expected a number"
    if name in DATES:
        return None if parse_date(v) else "expected a calendar date as YYYY-MM-DD"
    if not isinstance(v, str) or not v.strip():
        return "expected a non-empty string"
    if name == "currency" and not _CURRENCY.match(v):
        return "expected an ISO 4217 code like SEK"
    if name == "org_number" and not _ORG.match(v):
        return "expected an organisation number like 556123-4567"
    return None


def _value(fields: Dict[str, Any], name: str) -> Any:
    f = fields.get(name)
    return f.get("value") if isinstance(f, dict) else None


def check_types(fields: Dict[str, Any]) -> List[Finding]:
    out: List[Finding] = []
    for name in FIELDS:
        if name not in fields:
            out.append(_finding("MISSING_KEY", "error", "field is absent; use value null with a reason instead", name))
            continue
        f = fields[name]
        if not isinstance(f, dict) or "value" not in f:
            out.append(_finding("BAD_SHAPE", "error", "field must be an object with a value key", name))
            continue
        v = f["value"]
        if v is None:
            reason = f.get("reason")
            if not isinstance(reason, str) or not reason.strip():
                out.append(_finding("NULL_WITHOUT_REASON", "error", "a null value needs a reason", name))
            continue
        problem = _type_problem(name, v)
        if problem:
            out.append(_finding("TYPE_ERROR", "error", "%s, got %r" % (problem, v), name))
    for name in fields:
        if name not in FIELDS:
            out.append(_finding("UNKNOWN_FIELD", "error", "not part of the field schema", name))
    return out


def check_quotes(fields: Dict[str, Any], doc_text: Optional[str]) -> List[Finding]:
    out: List[Finding] = []
    for name in FIELDS:
        f = fields.get(name)
        if not isinstance(f, dict) or f.get("value") is None:
            continue
        q = f.get("quote")
        if not isinstance(q, str) or not q.strip():
            out.append(_finding("QUOTE_MISSING", "error", "a value needs a source quote", name))
        elif doc_text is not None and q not in doc_text:
            out.append(_finding("QUOTE_NOT_IN_DOCUMENT", "error", "quote %r is not an exact substring of the document" % q, name))
    return out


def check_totals(fields: Dict[str, Any], tolerance: float) -> List[Finding]:
    vals = {n: _value(fields, n) for n in AMOUNTS}
    if not all(_is_number(v) for v in vals.values()):
        missing = [n for n, v in vals.items() if not _is_number(v)]
        return [_finding("TOTALS_NOT_CHECKABLE", "info", "net + vat = total not checked, missing: %s" % ", ".join(missing))]
    diff = round(vals["net"] + vals["vat"] - vals["total"], 6)
    if abs(diff) > tolerance:
        return [_finding(
            "TOTAL_MISMATCH", "error",
            "net %s + vat %s = %s, but total is %s (difference %s, tolerance %s)"
            % (vals["net"], vals["vat"], round(vals["net"] + vals["vat"], 2), vals["total"], round(diff, 2), tolerance),
            "total",
        )]
    return []


def check_dates(fields: Dict[str, Any]) -> List[Finding]:
    inv = parse_date(_value(fields, "invoice_date"))
    due = parse_date(_value(fields, "due_date"))
    if inv is None or due is None:
        return [_finding("DATES_NOT_CHECKABLE", "info", "due_date >= invoice_date not checked, a date is missing or invalid")]
    if due < inv:
        return [_finding("DUE_BEFORE_INVOICE", "error", "due_date %s is before invoice_date %s" % (due.isoformat(), inv.isoformat()), "due_date")]
    return []


def check_missing(fields: Dict[str, Any]) -> List[Finding]:
    out: List[Finding] = []
    for name in FIELDS:
        f = fields.get(name)
        if isinstance(f, dict) and "value" in f and f["value"] is None:
            out.append(_finding("MISSING_VALUE", "warning", "no value: %s" % (f.get("reason") or "no reason given"), name))
    return out


def validate(payload: Dict[str, Any]) -> Dict[str, Any]:
    fields = payload.get("fields")
    if not isinstance(fields, dict):
        raise ValueError("input must have a 'fields' object")
    checks = payload.get("checks") or ALL_CHECKS
    unknown = [c for c in checks if c not in ALL_CHECKS]
    if unknown:
        raise ValueError("unknown checks: %s" % ", ".join(unknown))
    tolerance = payload.get("tolerance", DEFAULT_TOLERANCE)
    if not _is_number(tolerance) or tolerance < 0:
        raise ValueError("tolerance must be a non-negative number")
    doc_text = payload.get("doc_text")
    if doc_text is not None and not isinstance(doc_text, str):
        raise ValueError("doc_text must be a string")

    findings: List[Finding] = []
    for c in checks:
        if c == "types":
            findings += check_types(fields)
        elif c == "quotes":
            findings += check_quotes(fields, doc_text)
        elif c == "totals":
            findings += check_totals(fields, float(tolerance))
        elif c == "dates":
            findings += check_dates(fields)
        elif c == "missing":
            findings += check_missing(fields)
    return {"ok": not any(f["severity"] == "error" for f in findings), "checks_run": list(checks), "findings": findings}


def main(argv: List[str]) -> int:
    try:
        payload = json.loads(sys.stdin.read())
        if not isinstance(payload, dict):
            raise ValueError("input must be a JSON object")
        result = validate(payload)
    except (ValueError, json.JSONDecodeError) as e:
        print(json.dumps({"ok": False, "error": str(e)}))
        return 2
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
