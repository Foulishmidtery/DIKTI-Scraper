"""Regression tests for official LAM pages that do not expose usable decision data."""

import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch


sys.modules.setdefault("requests", types.SimpleNamespace(RequestException=Exception))
path = Path(__file__).resolve().parents[1] / "scraper" / "accreditation_sources.py"
spec = importlib.util.spec_from_file_location("accreditation_sources_availability", path)
sources = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sources)


class LamSourceAvailabilityTests(unittest.TestCase):
    def test_lamemba_placeholder_is_not_treated_as_empty_directory(self):
        prodi = {"pt": "Universitas Indonesia", "nama": "Akuntansi", "jenjang": "S1"}
        page = "<html><body>[data_akreditasi_mapping]</body></html>"

        with patch.object(sources, "_read", return_value=page):
            found = sources.enrich_national(prodi)

        self.assertNotIn("nomor_sk_akreditasi", found)
        self.assertEqual(
            found["pemeriksaan_lam"][0]["status"],
            "halaman hasil tersedia; direktori data tidak dapat diakses publik",
        )
        self.assertEqual(found["status_pencocokan_lam"], "tidak dapat diverifikasi dari sumber publik")

    def test_lamspak_official_unavailable_message_is_preserved(self):
        prodi = {"pt": "Universitas Indonesia", "nama": "Administrasi Publik", "jenjang": "S1"}
        page = "<html><body><h1>Hasil Akreditasi</h1><p>Data akreditasi tidak tersedia.</p></body></html>"

        with patch.object(sources, "_read", return_value=page):
            found = sources.enrich_national(prodi)

        self.assertNotIn("nomor_sk_akreditasi", found)
        self.assertEqual(found["pemeriksaan_lam"][0]["status"], "data akreditasi belum tersedia")
        self.assertEqual(found["status_pencocokan_lam"], "tidak dapat diverifikasi dari sumber publik")


if __name__ == "__main__":
    unittest.main()
