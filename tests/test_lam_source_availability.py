"""Regression tests for LAM pages that do not expose usable decision data."""

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

    def test_lamemba_uses_verified_national_registry_fallback(self):
        prodi = {
            "pt": "Universitas Indonesia",
            "nama": "Akuntansi",
            "jenjang": "S1",
            "status_pencocokan_akreditasi": "terverifikasi",
            "sumber_akreditasi": "SAPTO BAN-PT",
            "peringkat_akreditasi_banpt": "Unggul",
            "nomor_sk_akreditasi": "123/SK/LAMEMBA/2026",
            "tanggal_sk_akreditasi": "2026-02-01",
            "tanggal_akhir_akreditasi": "2031-02-01",
            "status_berlaku_sk_akreditasi": "Berlaku",
            "url_sumber_akreditasi": "https://sapto2.banpt.or.id/beranda/detail_pt/1",
            "url_sk_akreditasi": "https://sapto2.banpt.or.id/sk/prodi/10",
        }
        page = "<html><body>[data_akreditasi_mapping]</body></html>"

        with patch.object(sources, "_read", return_value=page):
            found = sources.enrich_national(prodi)

        self.assertEqual(found["status_pencocokan_lam"], "terverifikasi melalui register nasional")
        self.assertEqual(found["nomor_sk_akreditasi"], "123/SK/LAMEMBA/2026")
        self.assertEqual(found["peringkat_akreditasi_nasional"], "Unggul")
        self.assertEqual(found["cakupan_lam_terpilih"], ["LAMEMBA"])
        self.assertNotIn("lembaga_akreditasi_nasional", found)

    def test_lamspak_uses_verified_national_registry_fallback(self):
        prodi = {
            "pt": "Universitas Padjadjaran",
            "nama": "Hubungan Masyarakat",
            "jenjang": "S1",
            "status_pencocokan_akreditasi": "terverifikasi",
            "sumber_akreditasi": "SAPTO BAN-PT",
            "peringkat_akreditasi_banpt": "Unggul",
            "nomor_sk_akreditasi": "221/AK.03.05/2026",
            "tanggal_sk_akreditasi": "2026-01-01",
            "tanggal_akhir_akreditasi": "2031-01-01",
            "status_berlaku_sk_akreditasi": "Berlaku",
        }
        page = "<html><body><p>Data akreditasi tidak tersedia.</p></body></html>"

        with patch.object(sources, "_read", return_value=page):
            found = sources.enrich_national(prodi)

        self.assertEqual(found["status_pencocokan_lam"], "terverifikasi melalui register nasional")
        self.assertEqual(found["nomor_sk_akreditasi"], "221/AK.03.05/2026")
        self.assertEqual(found["cakupan_lam_terpilih"], ["LAMSPAK"])

    def test_overlapping_scope_does_not_guess_issuer(self):
        prodi = {
            "pt": "Politeknik Contoh",
            "nama": "Administrasi Bisnis",
            "jenjang": "D3",
            "status_pencocokan_akreditasi": "terverifikasi",
            "sumber_akreditasi": "SAPTO BAN-PT",
            "peringkat_akreditasi_banpt": "Baik Sekali",
            "tanggal_sk_akreditasi": "2026-03-10",
            "tanggal_akhir_akreditasi": "2031-03-10",
        }

        with patch.object(sources, "_read", side_effect=[
            "<html><body>[data_akreditasi_mapping]</body></html>",
            "<html><body>Data akreditasi tidak tersedia.</body></html>",
        ]):
            found = sources.enrich_national(prodi)

        self.assertEqual(found["status_pencocokan_lam"], "terverifikasi melalui register nasional")
        self.assertEqual(set(found["cakupan_lam_terpilih"]), {"LAMEMBA", "LAMSPAK"})
        self.assertNotIn("lembaga_akreditasi_nasional", found)


if __name__ == "__main__":
    unittest.main()
