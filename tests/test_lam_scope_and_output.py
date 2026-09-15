"""Regression tests for LAM scope classification and issuer/source separation."""

import importlib.util
import sys
import types
import unittest
from pathlib import Path

sys.modules.setdefault("requests", types.SimpleNamespace(RequestException=Exception))
path = Path(__file__).resolve().parents[1] / "scraper" / "accreditation_sources.py"
spec = importlib.util.spec_from_file_location("accreditation_scope_output", path)
sources = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sources)


class LamScopeAndOutputTests(unittest.TestCase):
    def test_official_lamspak_scope_variants_are_selected(self):
        names = ("Jurnalistik", "Perpustakaan", "Kebijakan Publik", "Manajemen Komunikasi", "Pekerjaan Sosial")
        for name in names:
            with self.subTest(name=name):
                self.assertIn("LAMSPAK", sources._selected_lams({"nama": name}))

    def test_accounting_does_not_become_lamspak(self):
        selected = sources._selected_lams({"nama": "Akuntansi"})
        self.assertIn("LAMEMBA", selected)
        self.assertNotIn("LAMSPAK", selected)

    def test_excel_does_not_treat_register_source_as_issuer(self):
        export_source = (Path(__file__).resolve().parents[1] / "scraper" / "excel_export.py").read_text(encoding="utf-8")
        self.assertNotIn('p.get("lembaga_akreditasi_nasional") or p.get("sumber_akreditasi")', export_source)


if __name__ == "__main__":
    unittest.main()
