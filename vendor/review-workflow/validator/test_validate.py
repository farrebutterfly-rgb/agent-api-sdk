"""Unit tests for validate.py. Run: python3 -m unittest discover -s validator -v"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import validate as v  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
DOC = "Netto: 6 910,00\nMoms 25 %: 1 727,50\nAtt betala: 8 637,50\nFakturadatum: 2026-09-14\n"


def good_fields():
    return {
        "supplier": {"value": "Norrsken Kontorsvaror AB", "quote": "Norrsken Kontorsvaror AB"},
        "invoice_number": {"value": "2026-0418", "quote": "2026-0418"},
        "invoice_date": {"value": "2026-09-14", "quote": "2026-09-14"},
        "due_date": {"value": "2026-10-14", "quote": "2026-10-14"},
        "currency": {"value": "SEK", "quote": "SEK"},
        "net": {"value": 6910, "quote": "6 910,00"},
        "vat": {"value": 1727.5, "quote": "1 727,50"},
        "total": {"value": 8637.5, "quote": "8 637,50"},
        "org_number": {"value": "556712-3401", "quote": "556712-3401"},
    }


def codes(result):
    return sorted(f["code"] for f in result["findings"])


class TypesAndRequired(unittest.TestCase):
    def test_clean_extraction_has_no_findings(self):
        r = v.validate({"fields": good_fields()})
        self.assertTrue(r["ok"])
        self.assertEqual(r["findings"], [])

    def test_absent_key_is_an_error(self):
        f = good_fields()
        del f["org_number"]
        r = v.validate({"fields": f, "checks": ["types"]})
        self.assertFalse(r["ok"])
        self.assertEqual(codes(r), ["MISSING_KEY"])

    def test_null_needs_a_reason(self):
        f = good_fields()
        f["due_date"] = {"value": None, "quote": None}
        self.assertEqual(codes(v.validate({"fields": f, "checks": ["types"]})), ["NULL_WITHOUT_REASON"])
        f["due_date"]["reason"] = "only payment terms are stated"
        self.assertEqual(codes(v.validate({"fields": f, "checks": ["types"]})), [])

    def test_wrong_types(self):
        f = good_fields()
        f["net"]["value"] = "6910"
        f["vat"]["value"] = True
        f["invoice_date"]["value"] = "2026-02-30"
        f["currency"]["value"] = "kr"
        f["org_number"]["value"] = "5567123401"
        r = v.validate({"fields": f, "checks": ["types"]})
        self.assertEqual(codes(r), ["TYPE_ERROR"] * 5)

    def test_unknown_field(self):
        f = good_fields()
        f["iban"] = {"value": "SE00", "quote": "SE00"}
        self.assertIn("UNKNOWN_FIELD", codes(v.validate({"fields": f, "checks": ["types"]})))


class Quotes(unittest.TestCase):
    def test_quote_must_be_exact_substring(self):
        f = {k: f for k, f in good_fields().items() if k in ("net", "vat", "total")}
        f["total"]["quote"] = "8637.50"
        r = v.validate({"fields": f, "doc_text": DOC, "checks": ["quotes"]})
        self.assertEqual(codes(r), ["QUOTE_NOT_IN_DOCUMENT"])

    def test_value_without_quote(self):
        f = good_fields()
        f["net"]["quote"] = None
        self.assertEqual(codes(v.validate({"fields": f, "checks": ["quotes"]})), ["QUOTE_MISSING"])


class Totals(unittest.TestCase):
    def test_consistent(self):
        self.assertEqual(codes(v.validate({"fields": good_fields(), "checks": ["totals"]})), [])

    def test_mismatch(self):
        f = good_fields()
        f["total"]["value"] = 8867.5
        r = v.validate({"fields": f, "checks": ["totals"]})
        self.assertEqual(codes(r), ["TOTAL_MISMATCH"])
        self.assertFalse(r["ok"])

    def test_within_tolerance(self):
        f = good_fields()
        f["total"]["value"] = 8637.51
        self.assertEqual(codes(v.validate({"fields": f, "checks": ["totals"], "tolerance": 0.01})), [])
        self.assertEqual(codes(v.validate({"fields": f, "checks": ["totals"], "tolerance": 0.001})), ["TOTAL_MISMATCH"])

    def test_float_rounding_is_not_a_mismatch(self):
        f = good_fields()
        f["net"]["value"], f["vat"]["value"], f["total"]["value"] = 0.1, 0.2, 0.3
        self.assertEqual(codes(v.validate({"fields": f, "checks": ["totals"], "tolerance": 0})), [])

    def test_negative_credit_note(self):
        f = good_fields()
        f["net"]["value"], f["vat"]["value"], f["total"]["value"] = -6000, -1500, -7500
        self.assertEqual(codes(v.validate({"fields": f, "checks": ["totals"]})), [])

    def test_missing_amount_is_not_checkable(self):
        f = good_fields()
        f["vat"] = {"value": None, "quote": None, "reason": "not present"}
        self.assertEqual(codes(v.validate({"fields": f, "checks": ["totals"]})), ["TOTALS_NOT_CHECKABLE"])


class Dates(unittest.TestCase):
    def test_due_before_invoice(self):
        f = good_fields()
        f["due_date"]["value"] = "2026-09-08"
        self.assertEqual(codes(v.validate({"fields": f, "checks": ["dates"]})), ["DUE_BEFORE_INVOICE"])

    def test_same_day_is_fine(self):
        f = good_fields()
        f["due_date"]["value"] = "2026-09-14"
        self.assertEqual(codes(v.validate({"fields": f, "checks": ["dates"]})), [])

    def test_missing_date_is_not_checkable(self):
        f = good_fields()
        f["invoice_date"] = {"value": None, "quote": None, "reason": "ambiguous"}
        self.assertEqual(codes(v.validate({"fields": f, "checks": ["dates"]})), ["DATES_NOT_CHECKABLE"])


class Missing(unittest.TestCase):
    def test_flags_each_null_field_as_warning(self):
        f = good_fields()
        f["org_number"] = {"value": None, "quote": None, "reason": "only a CVR number"}
        r = v.validate({"fields": f, "checks": ["missing"]})
        self.assertEqual(codes(r), ["MISSING_VALUE"])
        self.assertTrue(r["ok"], "a warning does not make the result fail")


class CommandLine(unittest.TestCase):
    def run_cli(self, stdin: str):
        p = subprocess.run([sys.executable, os.path.join(HERE, "validate.py")], input=stdin, capture_output=True, text=True, timeout=20)
        return p.returncode, json.loads(p.stdout)

    def test_round_trip(self):
        code, out = self.run_cli(json.dumps({"fields": good_fields(), "doc_text": DOC, "checks": ["totals", "dates"]}))
        self.assertEqual(code, 0)
        self.assertEqual(out["checks_run"], ["totals", "dates"])
        self.assertTrue(out["ok"])

    def test_bad_json_exits_2(self):
        code, out = self.run_cli("{not json")
        self.assertEqual(code, 2)
        self.assertFalse(out["ok"])

    def test_unknown_check_exits_2(self):
        code, out = self.run_cli(json.dumps({"fields": {}, "checks": ["vibes"]}))
        self.assertEqual(code, 2)
        self.assertIn("unknown checks", out["error"])


if __name__ == "__main__":
    unittest.main()
