"""Evidence-matching tests use representative rows from official directory layouts."""

import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch


# The bundled QA Python lacks the production requests package. Network calls are
# mocked here; deployed code uses the pinned requests dependency.
sys.modules.setdefault("requests", types.SimpleNamespace(RequestException=Exception))
path = Path(__file__).resolve().parents[1] / "scraper" / "accreditation_sources.py"
spec = importlib.util.spec_from_file_location("accreditation_sources", path)
sources = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sources)


class AccreditationSourceTests(unittest.TestCase):
    def setUp(self):
        self.prodi = {"pt": "Universitas Indonesia", "nama": "Akuntansi", "jenjang": "S1",
                      "kode_pt": "001002", "kode_prodi": "62201"}
        sources._lamemba_cache = None

    def test_lamemba_exact_decision_uses_public_table_without_document_download(self):
        rows = [{"value": {"perguruan_tinggi": "Universitas Indonesia", "jenjang": "Akuntansi",
                             "program_studi": "Sarjana", "download": '<a href="https://drive.google.com/file/d/example/view">Download</a>'}}]
        class Response:
            headers = {"content-disposition": 'attachment; filename="123 SK Terakreditasi Universitas Indonesia.pdf"'}
            def raise_for_status(self): pass
            def json(self): return rows
        original_requests = sources.requests
        sources.requests = types.SimpleNamespace(RequestException=Exception, get=lambda *args, **kwargs: Response())
        try:
            found = sources.enrich_national(self.prodi)
        finally:
            sources.requests = original_requests
        self.assertEqual(found["lembaga_akreditasi_nasional"], "LAMEMBA")
        self.assertEqual(found["peringkat_akreditasi_nasional"], "Terakreditasi Sementara")
        self.assertEqual(found["url_sk_akreditasi"], "https://drive.google.com/file/d/example/view")

    def test_similar_school_and_wrong_level_rejected(self):
        page = """<table><tr><th>Nama PT</th><th>Nama PS</th><th>Jenjang</th>
        <th>No SK</th></tr><tr><td>Universitas Indonesia Timur</td>
        <td>Akuntansi</td><td>S1</td><td>1/SK/LAMEMBA</td></tr>
        <tr><td>Universitas Indonesia</td><td>Akuntansi</td><td>S2</td>
        <td>2/SK/LAMEMBA</td></tr></table>"""
        with patch.object(sources, "_read", return_value=page):
            found = sources.enrich_national(self.prodi)
        self.assertNotIn("nomor_sk_akreditasi", found)

    def test_outage_does_not_claim_accreditation(self):
        with patch.object(sources, "_read", return_value=None):
            found = sources.enrich_national(self.prodi)
        self.assertNotIn("nomor_sk_akreditasi", found)
        self.assertEqual(found["pemeriksaan_lam"][0]["status"], "sumber SK publik tidak tersedia")

    def test_international_school_does_not_claim_program_scope(self):
        page = '<a href="/schools/ui">Universitas Indonesia</a>'
        with patch.object(sources, "_read", return_value=page):
            found = sources.enrich_international(self.prodi)
        self.assertEqual({item["lembaga"] for item in found["akreditasi_internasional_terverifikasi"]},
                         {"AACSB", "EQUIS"})
        self.assertTrue(all(item["cakupan"] == "institusi/sekolah bisnis"
                            for item in found["akreditasi_internasional_terverifikasi"]))

    def test_abet_requires_current_exact_program(self):
        prodi = {"pt": "Institut Teknologi Bandung", "nama": "Informatics/Computer Science", "jenjang": "S1"}
        page = "<div>1 result(s) Institut Teknologi Bandung Programs that are no longer accredited are excluded " \
               "Informatics/Computer Science (B.Sc.) Accredited: Oct 1, 2012 – Present</div>"
        with patch.object(sources, "_read", return_value=page):
            self.assertEqual(sources._abet_program(prodi)["lembaga"], "ABET")
        with patch.object(sources, "_read", return_value=page.replace("Present", "2018")):
            self.assertIsNone(sources._abet_program(prodi))

    def test_amba_school_translation_stays_at_school_scope(self):
        prodi = dict(self.prodi, jenjang="S2")
        page = '<a href="https://www.amba-bga.com/school/ui">Faculty of Economics and Business, University of Indonesia</a>'
        with patch.object(sources, "_read", return_value=page):
            found = sources.enrich_international(prodi)
        amba = next(item for item in found["akreditasi_internasional_terverifikasi"]
                    if item["lembaga"] == "AMBA")
        self.assertEqual(amba["cakupan"], "institusi/sekolah bisnis")
        self.assertEqual(amba["url"], sources.INTERNATIONAL_DIRECTORIES["AMBA"])

    def test_lam_teknik_hidden_detail_contains_sk(self):
        prodi = {"pt": "Universitas Indonesia", "nama": "Teknik Sipil", "jenjang": "S1"}
        page = """<table><tr><th>Detil</th><th>Prodi</th><th>Institusi</th><th>Jenjang</th>
        <th>Peringkat</th><th>Berlaku Mulai</th><th>Berakhir Pada</th></tr>
        <tr><td></td><td>Teknik Sipil</td><td>Universitas Indonesia</td>
        <td>Sarjana</td><td>Terakreditasi Unggul</td><td>21-08-2026</td>
        <td>20-08-2031</td></tr><tr style="display:none"><td colspan="7">
        Nomor SK: 0299/SK/LAM Teknik/AS/VIII/2026 Tahun SK: 2026
        Jenis SK: Akreditasi</td></tr></table>"""
        with patch.object(sources, "_read", return_value=page) as read:
            found = sources.enrich_national(prodi)
        self.assertIn("institusi%5B%5D=Universitas+Indonesia", read.call_args.args[0])
        self.assertEqual(found["nomor_sk_akreditasi"], "0299/SK/LAM Teknik/AS/VIII/2026")

    def test_lamptkes_public_directory_matches_city_suffix(self):
        prodi = {"pt": "Universitas Indonesia", "nama": "Keperawatan Jiwa", "jenjang": "Spesialis"}
        page = """<table><tr><th>Jenjang</th><th>Perguruan Tinggi</th><th>Program Studi</th>
        <th>Peringkat Akreditasi</th><th>Nomor SK</th><th>Tahun SK</th>
        <th>Tanggal Kadaluwarsa</th><th>Status Kadaluwarsa</th></tr>
        <tr><td>SPESIALIS</td><td>UNIVERSITAS INDONESIA, JAKARTA</td>
        <td>KEPERAWATAN JIWA</td><td>Unggul</td>
        <td>1020/LAM-PTKes/Akr/Spe/XII/2022</td><td>2022</td>
        <td>15 Desember 2027</td><td>MASIH BERLAKU</td></tr></table>"""
        with patch.object(sources, "_read", return_value=page):
            found = sources.enrich_national(prodi)
        self.assertEqual(found["lembaga_akreditasi_nasional"], "LAM-PTKes")
        self.assertEqual(found["tanggal_akhir_akreditasi"], "2027-12-15")

    def test_lamsama_uses_public_search_endpoint(self):
        prodi = {"pt": "Universitas Contoh", "nama": "Matematika", "jenjang": "S1", "kode_pt": "001", "kode_prodi": "44101"}
        payload = {"data": [{"kode_pt": "001", "nama_pt": "Universitas Contoh", "kode_ps": "44101",
                               "nama_ps": "Matematika", "jenjang": "S1", "no_sk": "17/SK/LAMSAMA/2026",
                               "peringkat": "Unggul", "tgl_sk": "2026-01-15", "tgl_kadaluarsa": "2031-01-15"}]}
        class Response:
            def raise_for_status(self): pass
            def json(self): return payload
        original_requests = sources.requests
        sources.requests = types.SimpleNamespace(RequestException=Exception, post=lambda *args, **kwargs: Response())
        try:
            found = sources.enrich_national(prodi)
        finally:
            sources.requests = original_requests
        self.assertEqual(found["nomor_sk_akreditasi"], "17/SK/LAMSAMA/2026")


if __name__ == "__main__":
    unittest.main()
