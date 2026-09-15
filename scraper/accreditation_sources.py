"""Verify national LAM decisions and international accreditation against public directories.

Only exact identities from an accreditor's own directory become evidence. Directory
outages and pages without published results never produce an accreditation claim.
When an issuer directory is unavailable, an already exact-matched SAPTO/BAN-PT
record may be retained as national-registry evidence without guessing the issuer.
"""

from __future__ import annotations

import html
import re
import threading
import time
from datetime import date, datetime, timezone
from html.parser import HTMLParser
from typing import Any
from urllib.parse import urlencode, urljoin, urlparse

import requests


TIMEOUT = 20
CACHE_TTL = 1800
LAM_DIRECTORIES = {
    "LAMEMBA": "https://lamemba.or.id/hasil_akreditasi/",
    "LAM-PTKes": "https://akreditasi-idc.lamptkes.org/Tampil-Database-Hasil-Akreditasi",
    "LAMDIK": "https://lamdik.or.id/hasil-akreditasi/",
    "LAM Teknik": "https://sakti.lamteknik.or.id/database-akreditasi",
    "LAM Infokom": "https://laminfokom.or.id/official/data-akreditasi-1.html",
    "LAMSAMA": "https://lamsama.or.id/pencarian-data-akreditasi/",
    "LAMSPAK": "https://www.lamspak.id/akreditasi/hasil-akreditasi/",
}
INTERNATIONAL_DIRECTORIES = {
    "AACSB": "https://www.aacsb.edu/accredited",
    "EQUIS": "https://www.efmdglobal.org/accreditations-assessments/business-schools/equis/equis-accredited-schools/",
    "AMBA": "https://www.associationofmbas.com/business-schools/accreditation/accredited-schools",
    "ABET": "https://amspub.abet.org/aps/",
}
_cache: dict[str, tuple[float, str | None]] = {}
_lock = threading.Lock()
_read_locks: dict[str, threading.Lock] = {}
_lamsama_cache: dict[str, tuple[float, list[dict[str, str]]]] = {}


def _norm(value: Any) -> str:
    value = html.unescape(str(value or "")).casefold().replace("_", " ")
    return " ".join(re.sub(r"[^\w]+", " ", value, flags=re.UNICODE).split())


def _date(value: Any) -> str:
    raw = str(value or "").strip()
    for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y"):
        try:
            return datetime.strptime(raw, fmt).date().isoformat()
        except ValueError:
            pass
    months = ("januari", "februari", "maret", "april", "mei", "juni", "juli",
              "agustus", "september", "oktober", "november", "desember")
    parts = raw.casefold().split()
    if len(parts) == 3 and parts[0].isdigit() and parts[1] in months and parts[2].isdigit():
        try:
            return date(int(parts[2]), months.index(parts[1]) + 1, int(parts[0])).isoformat()
        except ValueError:
            pass
    return ""


class _DirectoryParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.rows: list[list[dict[str, str]]] = []
        self.links: list[tuple[str, str]] = []
        self.text_parts: list[str] = []
        self._row: list[dict[str, str]] | None = None
        self._cell: dict[str, str] | None = None
        self._link: dict[str, str] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "tr":
            self._row = []
        elif tag in ("td", "th") and self._row is not None:
            self._cell = {"text": "", "href": ""}
        elif tag == "a":
            self._link = {"text": "", "href": dict(attrs).get("href") or ""}
            if self._cell is not None:
                self._cell["href"] = self._link["href"]

    def handle_data(self, data: str) -> None:
        if data.strip():
            self.text_parts.append(" ".join(data.split()))
        if self._cell is not None:
            self._cell["text"] += data
        if self._link is not None:
            self._link["text"] += data

    def handle_endtag(self, tag: str) -> None:
        if tag == "a" and self._link is not None:
            self.links.append((" ".join(self._link["text"].split()), self._link["href"]))
            self._link = None
        elif tag in ("td", "th") and self._cell is not None and self._row is not None:
            self._cell["text"] = " ".join(self._cell["text"].split())
            self._row.append(self._cell)
            self._cell = None
        elif tag == "tr" and self._row is not None:
            if self._row:
                self.rows.append(self._row)
            self._row = None


def _read(url: str) -> str | None:
    with _lock:
        cached = _cache.get(url)
        if cached and time.time() - cached[0] < (CACHE_TTL if cached[1] else 120):
            return cached[1]
        request_lock = _read_locks.setdefault(url, threading.Lock())
    # Several prodi can belong to one LAM. Serialise the directory request so
    # every worker reuses one public response rather than hammering the issuer.
    with request_lock:
        with _lock:
            cached = _cache.get(url)
            if cached and time.time() - cached[0] < (CACHE_TTL if cached[1] else 120):
                return cached[1]
        try:
            response = requests.get(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "text/html"}, timeout=TIMEOUT)
            response.raise_for_status()
            page = response.text
        except requests.RequestException:
            page = None
        with _lock:
            _cache[url] = (time.time(), page)
        return page


def _selected_lams(prodi: dict[str, Any]) -> list[str]:
    name = _norm(prodi.get("nama"))
    patterns = {
        "LAMEMBA": r"\b(ekonomi|manajemen|bisnis|akuntansi|keuangan|perpajakan|perbankan|kewirausahaan)\b",
        "LAM-PTKes": r"\b(kesehatan|kedokteran|keperawatan|kebidanan|farmasi|gizi|fisioterapi|radiologi|epidemiologi|biomedis|kedokteran gigi|anestesi)\b",
        "LAMDIK": r"\b(pendidikan|tadris|keguruan|pedagogi)\b",
        "LAM Teknik": r"\b(teknik|rekayasa|teknologi industri|arsitektur|konstruksi)\b",
        "LAM Infokom": r"\b(informatika|komputer|sistem informasi|teknologi informasi|sains data|kecerdasan buatan)\b",
        "LAMSAMA": r"\b(matematika|fisika|kimia|biologi|statistika|sains alam|aktuaria)\b",
        "LAMSPAK": r"\b(sosial|politik|administrasi|komunikasi|hubungan internasional|hubungan masyarakat|humas|public relations|kriminologi|kesejahteraan sosial|pekerjaan sosial|antropologi|jurnalistik|penyiaran|periklanan|penerbitan dan media|perpustakaan|kearsipan|pemerintahan|kebijakan publik|sosiologi|kependudukan|pembangunan wilayah|komunikasi massa|manajemen komunikasi|kajian film|televisi dan film)\b",
    }
    return [source for source, pattern in patterns.items() if re.search(pattern, name)]


def _level(value: Any) -> str:
    key = _norm(value)
    aliases = {
        "sarjana": "s1", "magister": "s2", "doktor": "s3", "diploma tiga": "d3",
        "sarjana terapan": "d4", "magister terapan": "s2 terapan",
        "doctoral": "s3", "bachelor": "s1", "master": "s2",
    }
    return aliases.get(key, key)


def _column(headers: list[str], *names: str) -> int:
    for i, header in enumerate(headers):
        if any(_norm(name) == header for name in names):
            return i
    return -1


def _published_decisions(page: str, url: str) -> list[dict[str, str]]:
    parser = _DirectoryParser()
    parser.feed(page)
    decisions: list[dict[str, str]] = []
    headers: list[str] = []
    for row in parser.rows:
        cells = [cell["text"] for cell in row]
        # LAM Teknik keeps the SK number in the hidden detail row directly
        # following each visible decision. The browser reveals this row on click.
        if len(cells) == 1 and decisions and "Nomor SK" in cells[0]:
            found = re.search(r"Nomor SK\s*:\s*(.+?)(?:\s*Tahun SK\s*:|\s*Jenis SK\s*:|\s*Riwayat Akreditasi\s*:|$)",
                              cells[0], flags=re.IGNORECASE)
            if found and "SK" in found.group(1).upper():
                decisions[-1]["sk"] = found.group(1).strip()
            continue
        candidate = [_norm(value) for value in cells]
        if (any(value in ("nama perguruan tinggi", "perguruan tinggi", "nama pt", "institusi") for value in candidate)
                and any(value in ("program studi", "nama program studi", "nama ps", "prodi") for value in candidate)):
            headers = candidate
            continue
        if not headers:
            continue
        def pick(*names: str) -> str:
            index = _column(headers, *names)
            return cells[index] if 0 <= index < len(cells) else ""
        pt = pick("Nama Perguruan Tinggi", "Perguruan Tinggi", "Nama PT", "Institusi")
        name = pick("Nama Program Studi", "Program Studi", "Nama PS", "Prodi")
        if not pt or not name:
            continue
        sk = pick("No SK", "No.SK", "Nomor SK", "No SK Akreditasi")
        evidence = ""
        for cell in row:
            href = cell["href"]
            if href:
                candidate_url = urljoin(url, href)
                if urlparse(candidate_url).hostname == urlparse(url).hostname:
                    evidence = candidate_url
                    break
        decisions.append({
            "pt": pt, "prodi": name, "jenjang": pick("Jenjang", "Level"),
            "kode_pt": pick("Kode PT"), "kode_prodi": pick("Kode PS", "Kode Prodi"),
            "sk": sk, "peringkat": pick("Peringkat", "Peringkat Akreditasi"),
            "tanggal_sk": _date(pick("Tanggal SK", "Tgl SK")),
            "berlaku_sampai": _date(pick("Tanggal Kadaluarsa", "Tgl Kadaluarsa", "Tanggal Kadaluwarsa", "Tgl Kadaluwarsa", "Tanggal Kadaluwarsa SK", "Berakhir Pada")),
            "status": pick("Status", "Status Kadaluwarsa", "Status Kadaluarsa"),
            "url": evidence or url,
        })
    return decisions


def _directory_unavailable_status(source: str, page: str) -> str:
    """Classify official pages that explicitly do not expose a usable public directory."""
    text = _norm(page)
    if source == "LAMEMBA" and "data akreditasi mapping" in text:
        return "halaman hasil tersedia; direktori data tidak dapat diakses publik"
    if source == "LAMSPAK" and "data akreditasi tidak tersedia" in text:
        return "data akreditasi belum tersedia"
    return ""


def _identity_matches(decision: dict[str, str], prodi: dict[str, Any]) -> bool:
    pt = _norm(prodi.get("pt"))
    published_pt = _norm(decision["pt"])
    # LAM-PTKes appends a city after the official institution name.
    if published_pt != pt and not _norm(decision["pt"].split(",", 1)[0]) == pt:
        return False
    if _norm(decision["prodi"]) != _norm(prodi.get("nama")):
        return False
    if decision["jenjang"] and _level(decision["jenjang"]) != _level(prodi.get("jenjang")):
        return False
    for key, local_key in (("kode_pt", "kode_pt"), ("kode_prodi", "kode_prodi")):
        if decision[key] and prodi.get(local_key) and str(decision[key]).strip() != str(prodi[local_key]).strip():
            return False
    return True


def _fetch_lamsama(prodi: dict[str, Any]) -> list[dict[str, str]]:
    """Query LAMSAMA's public DataTables endpoint by PT code when available."""
    pt_name = str(prodi.get("pt", "")).strip()
    kode_pt = str(prodi.get("kode_pt", "")).strip()
    search_term = kode_pt or pt_name
    if not search_term:
        return []
    cache_key = f"{_norm(kode_pt)}|{_norm(pt_name)}"
    with _lock:
        cached = _lamsama_cache.get(cache_key)
        if cached and time.time() - cached[0] < CACHE_TTL:
            return cached[1]
        request_lock = _read_locks.setdefault(f"lamsama:{cache_key}", threading.Lock())
    with request_lock:
        with _lock:
            cached = _lamsama_cache.get(cache_key)
            if cached and time.time() - cached[0] < CACHE_TTL:
                return cached[1]
        try:
            response = requests.post(
                "https://lamsama.or.id/wp-admin/admin-ajax.php",
                data={"action": "fetch_prodi_data", "draw": "1", "start": "0", "length": "100",
                      "search[value]": search_term, "search[regex]": "false"},
                headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"}, timeout=TIMEOUT,
            )
            response.raise_for_status()
            rows = response.json().get("data", [])
        except (requests.RequestException, ValueError, AttributeError):
            rows = []
        result = [{
            "pt": str(row.get("nama_pt", "")), "prodi": str(row.get("nama_ps", "")),
            "jenjang": str(row.get("jenjang", "")), "kode_pt": str(row.get("kode_pt", "")),
            "kode_prodi": str(row.get("kode_ps", "")), "sk": str(row.get("no_sk", "")),
            "peringkat": str(row.get("peringkat", "")), "tanggal_sk": _date(row.get("tgl_sk", "")),
            "berlaku_sampai": _date(row.get("tgl_kadaluarsa", "")),
            "status": "", "url": LAM_DIRECTORIES["LAMSAMA"],
        } for row in rows if isinstance(row, dict)]
        with _lock:
            _lamsama_cache[cache_key] = (time.time(), result)
        return result


def _national_registry_fallback(
    prodi: dict[str, Any], selected: list[str], checked: list[dict[str, str]],
) -> dict[str, Any] | None:
    """Reuse exact SAPTO/BAN-PT evidence when a LAM directory cannot expose the row.

    ``enrich_banpt`` runs before this function in the production pipeline and only
    marks a program ``terverifikasi`` after an exact PT/program/code match. This
    fallback deliberately does not assign ``lembaga_akreditasi_nasional`` from the
    scope regex: some program names can belong to overlapping LAM scopes and older
    decisions can still have been issued by BAN-PT.
    """
    if not selected or _norm(prodi.get("status_pencocokan_akreditasi")) != "terverifikasi":
        return None
    source = str(prodi.get("sumber_akreditasi", "")).strip()
    if source != "SAPTO BAN-PT":
        return None
    rank = str(prodi.get("peringkat_akreditasi_banpt") or prodi.get("peringkat_akreditasi_nasional") or "").strip()
    sk = str(prodi.get("nomor_sk_akreditasi") or "").strip()
    sk_date = str(prodi.get("tanggal_sk_akreditasi") or "").strip()
    expiry = str(prodi.get("tanggal_akhir_akreditasi") or "").strip()
    if not any((rank, sk, sk_date, expiry)):
        return None
    return {
        "pemeriksaan_lam": checked,
        "status_pencocokan_lam": "terverifikasi melalui register nasional",
        "cakupan_lam_terpilih": selected,
        "peringkat_akreditasi_nasional": rank,
        "nomor_sk_akreditasi": sk,
        "tanggal_sk_akreditasi": sk_date,
        "tanggal_akhir_akreditasi": expiry,
        "status_berlaku_sk_akreditasi": str(prodi.get("status_berlaku_sk_akreditasi") or "").strip(),
        "sumber_akreditasi": source,
        "url_sumber_akreditasi": str(prodi.get("url_sumber_akreditasi") or "").strip(),
        "url_riwayat_akreditasi": str(prodi.get("url_riwayat_akreditasi") or "").strip(),
        "url_sk_akreditasi": str(prodi.get("url_sk_akreditasi") or "").strip(),
        "akreditasi_diperiksa_pada": str(prodi.get("akreditasi_diperiksa_pada") or datetime.now(timezone.utc).isoformat()),
    }


def enrich_national(prodi: dict[str, Any]) -> dict[str, Any]:
    """Look up relevant LAMs and retain exact national-registry evidence as fallback."""
    selected = _selected_lams(prodi)
    checked: list[dict[str, str]] = []
    matches: list[tuple[str, dict[str, str]]] = []
    for source in selected:
        url = LAM_DIRECTORIES[source]
        if source == "LAM Teknik":
            url = f"{url}?{urlencode({'institusi[]': str(prodi.get('pt', '')), 'prodi[]': str(prodi.get('nama', ''))})}"
        if source == "LAMSAMA":
            decisions = _fetch_lamsama(prodi)
            checked.append({"lembaga": source, "status": "direktori tersedia" if decisions else "keputusan tidak ditemukan", "url": url})
            matches.extend((source, row) for row in decisions if _identity_matches(row, prodi))
            continue
        page = _read(url)
        if page is None:
            checked.append({"lembaga": source, "status": "sumber tidak tersedia", "url": url})
            continue
        unavailable_status = _directory_unavailable_status(source, page)
        if unavailable_status:
            checked.append({"lembaga": source, "status": unavailable_status, "url": url})
            continue
        decisions = _published_decisions(page, url)
        checked.append({"lembaga": source, "status": "direktori tersedia" if decisions else "keputusan publik belum tersedia", "url": url})
        matches.extend((source, row) for row in decisions if _identity_matches(row, prodi))
    # Multiple issuers may publish overlapping records. Do not silently choose one.
    if len({source for source, _ in matches}) > 1:
        return {"pemeriksaan_lam": checked, "status_pencocokan_lam": "beberapa LAM cocok; perlu pemeriksaan"}
    if not matches:
        registry_result = _national_registry_fallback(prodi, selected, checked)
        if registry_result:
            return registry_result
        unverifiable = {
            "sumber tidak tersedia",
            "keputusan publik belum tersedia",
            "halaman hasil tersedia; direktori data tidak dapat diakses publik",
            "data akreditasi belum tersedia",
        }
        if selected and checked and all(item["status"] in unverifiable for item in checked):
            match_status = "tidak dapat diverifikasi dari sumber publik"
        else:
            match_status = "keputusan tidak ditemukan" if selected else "di luar cakupan LAM terpilih"
        return {"pemeriksaan_lam": checked, "status_pencocokan_lam": match_status}
    source, decision = max(matches, key=lambda item: (item[1]["tanggal_sk"], item[1]["berlaku_sampai"]))
    expiry = decision["berlaku_sampai"]
    status = "Tidak berlaku" if expiry and expiry < date.today().isoformat() else "Berlaku" if expiry else "Belum diketahui"
    return {
        "pemeriksaan_lam": checked, "status_pencocokan_lam": "terverifikasi",
        "lembaga_akreditasi_nasional": source,
        "peringkat_akreditasi_nasional": decision["peringkat"],
        "nomor_sk_akreditasi": decision["sk"],
        "tanggal_sk_akreditasi": decision["tanggal_sk"],
        "tanggal_akhir_akreditasi": expiry,
        "status_berlaku_sk_akreditasi": status,
        "sumber_akreditasi": source,
        "url_sumber_akreditasi": decision["url"],
        "url_sk_akreditasi": (decision["url"] if urlparse(decision["url"]).path != urlparse(LAM_DIRECTORIES[source]).path else ""),
        "akreditasi_diperiksa_pada": datetime.now(timezone.utc).isoformat(),
    }


def _international_sources(prodi: dict[str, Any]) -> list[str]:
    selected = set(_selected_lams(prodi))
    result: list[str] = []
    if "LAMEMBA" in selected:
        result.extend(("AACSB", "EQUIS"))
        if _level(prodi.get("jenjang")) in ("s2", "s3"):
            result.append("AMBA")
    if selected.intersection(("LAM Teknik", "LAM Infokom", "LAMSAMA")):
        result.append("ABET")
    return result


def _directory_links(page: str, base_url: str) -> list[tuple[str, str]]:
    parser = _DirectoryParser()
    parser.feed(page)
    result: list[tuple[str, str]] = []
    for label, href in parser.links:
        target = urljoin(base_url, href)
        if label and urlparse(target).scheme == "https":
            result.append((label, target))
    return result


def _school_aliases(pt_name: Any) -> set[str]:
    canonical = _norm(pt_name)
    aliases = {canonical}
    if canonical.startswith("universitas "):
        suffix = canonical[len("universitas "):]
        aliases.update((f"university of {suffix}", f"{suffix} university"))
    return aliases


def _school_label_matches(label: str, pt_name: Any) -> bool:
    aliases = _school_aliases(pt_name)
    label = re.sub(r"\(\s*[35]\s+years?\s*\)", "", label, flags=re.IGNORECASE).strip()
    parts = [_norm(part) for part in label.split(",")]
    if any(part in aliases for part in parts):
        return True
    # AACSB often prints "University Name College of Business ..." in one link.
    for alias in aliases:
        if any(part.startswith(alias + " " + unit) for part in parts
               for unit in ("school", "college", "faculty", "business school")):
            return True
    return False


def _abet_program(prodi: dict[str, Any]) -> dict[str, str] | None:
    # APS publishes search results under this official, server-rendered endpoint.
    # Request a single Indonesian institution to keep any program claim scoped.
    query = urlencode({"countries": "ID", "exactMatch": "true",
                       "keyword": str(prodi.get("pt", "")), "searchType": "institution"})
    url = f"{INTERNATIONAL_DIRECTORIES['ABET'].rstrip('/')}/name-search?{query}"
    page = _read(url)
    if not page:
        return None
    parser = _DirectoryParser()
    parser.feed(page)
    text = " ".join(parser.text_parts)
    if ("1 result(s)" not in text or "No currently accredited programs on record" in text
            or _norm(prodi.get("pt")) not in _norm(text)):
        return None
    program = _norm(prodi.get("nama"))
    for match in re.finditer(r"Accredited:\s*[^<]{0,100}?Present", text, flags=re.IGNORECASE):
        prior = text.rfind("Accredited:", 0, match.start())
        prefix = text[max(prior + len("Accredited:"), match.start() - 180):match.start()]
        if program and re.search(rf"\b{re.escape(program)}\b", _norm(prefix)):
            return {"lembaga": "ABET", "entitas": str(prodi.get("nama", "")),
                    "cakupan": "program studi", "status": "terakreditasi aktif", "url": url}
    return None


def enrich_international(prodi: dict[str, Any]) -> dict[str, Any]:
    """Keep accredited entities separate from national program-study decisions.

    Public school directories can verify the listed institution, but cannot alone
    prove that a particular PDDIKTI program is in the agency's reviewed scope.
    ABET requires an exact program result; its JS-only search page is not evidence.
    """
    checked: list[dict[str, str]] = []
    verified: list[dict[str, str]] = []
    for source in _international_sources(prodi):
        url = INTERNATIONAL_DIRECTORIES[source]
        if source == "ABET":
            decision = _abet_program(prodi)
            if decision:
                verified.append(decision)
            checked.append({"lembaga": source, "status": "prodi terverifikasi" if decision else "hasil prodi tidak ditemukan secara tepat",
                            "url": decision["url"] if decision else url})
            continue
        page = _read(url)
        if page is None:
            checked.append({"lembaga": source, "status": "sumber tidak tersedia", "url": url})
            continue
        matches = [(label, target) for label, target in _directory_links(page, url)
                   if _school_label_matches(label, prodi.get("pt"))]
        if len(matches) == 1:
            label, target = matches[0]
            if urlparse(target).hostname != urlparse(url).hostname:
                target = url
            verified.append({"lembaga": source, "entitas": label, "cakupan": "institusi/sekolah bisnis",
                             "status": "tercantum dalam direktori", "url": target})
            checked.append({"lembaga": source, "status": "entitas terverifikasi; cakupan prodi belum diverifikasi", "url": target})
        else:
            checked.append({"lembaga": source, "status": "entitas tidak ditemukan secara tepat", "url": url})
    return {"pemeriksaan_akreditasi_internasional": checked,
            "akreditasi_internasional_terverifikasi": verified}
