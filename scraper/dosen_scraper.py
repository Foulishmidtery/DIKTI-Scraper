"""
Dosen Scraper - refactored from pddikti_scraping_update_copy.py
Accepts prodi_keywords as parameter instead of hardcoded constant.
"""

import requests
import time
import json
import os
import re
import sys
import threading
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
import urllib.parse
from html import unescape
try:
    from scraper.diktis_data import (
        is_diktis, refresh_ptkin_whitelist, classify_pt_from_name,
        classify_from_pembina, PTKIN_SET,
    )
except ImportError:
    from diktis_data import (
        is_diktis, refresh_ptkin_whitelist, classify_pt_from_name,
        classify_from_pembina, PTKIN_SET,
    )

try:
    from scraper.prodi_enrichment import enrich_banpt
except ImportError:
    from prodi_enrichment import enrich_banpt
try:
    from scraper.accreditation_sources import enrich_national, enrich_international
except ImportError:
    from accreditation_sources import enrich_national, enrich_international

BASE_URL = "https://api-pddikti.kemdiktisaintek.go.id"
HEADERS = {
    "Origin": "https://pddikti.kemdiktisaintek.go.id",
    "Referer": "https://pddikti.kemdiktisaintek.go.id/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "application/json",
}
TIMEOUT = int(os.environ.get("PDDIKTI_TIMEOUT", 30))
MAX_RETRIES = max(1, int(os.environ.get("PDDIKTI_MAX_RETRIES", 3)))
RETRY_DELAY = int(os.environ.get("PDDIKTI_RETRY_DELAY", 2))
REQUEST_DELAY = float(os.environ.get("PDDIKTI_REQUEST_DELAY", 0.15))
MAX_WORKERS = int(os.environ.get("PDDIKTI_MAX_WORKERS", 5))

# Endpoint detail dosen yang benar-benar tersedia pada API publik PDDIKTI.
# Data lain tetap dicatat status ketersediaannya agar tidak diisi dengan tebakan.
DOSEN_DETAIL_ENDPOINTS = {
    "Riwayat Pendidikan": "study-history",
    "Riwayat Mengajar": "teaching-history",
}

COLOR_DOSEN_HEADER = "1F4E79"
COLOR_DOSEN_ALT_ROW = "D6E4F0"
COLOR_DOSEN_TITLE = "2E75B6"

COLOR_PRODI_HEADER = "228B22"  # Forest Green
COLOR_PRODI_ALT_ROW = "E8F5E9" # Light Green
COLOR_PRODI_TITLE = "2E8B57"   # Sea Green


def normalize(name):
    """
    Normalize nama prodi untuk perbandingan:
      - Uppercase
      - Hapus semua varian apostrophe: ' ` \u2018 \u2019 dll.
      - Normalisasi spasi

    Contoh:
      'Akuntansi Syari\'ah'  → 'AKUNTANSI SYARIAH'
      'Akuntansi Syari`ah'   → 'AKUNTANSI SYARIAH'
      'Akuntansi Syariah'    → 'AKUNTANSI SYARIAH'
    Ketiganya identik setelah normalisasi — JANGAN ubah logika ini.
    """
    name = name.upper()
    name = re.sub(r"[`'\u2018\u2019\u201A\u201B\u201C\u201D]", "", name)
    return " ".join(name.split())


def _generate_subqueries(keyword: str) -> list[str]:
    """
    Hasilkan daftar sub-query fallback untuk keyword panjang yang
    mengembalikan 0 hasil dari API PDDikti.

    Strategi: coba versi pendek dari keyword dengan membuang
    satu kata dari awal atau dari akhir secara bergantian.

    Contoh:
      'Akuntansi Lembaga Keuangan Syariah'
      → ['Lembaga Keuangan Syariah', 'Akuntansi Lembaga Keuangan']
    """
    words = keyword.split()
    if len(words) <= 2:
        return []
    subqueries = []
    # Buang kata pertama
    subqueries.append(" ".join(words[1:]))
    # Buang kata terakhir
    if len(words) > 3:
        subqueries.append(" ".join(words[:-1]))
    # Deduplicate, pertahankan urutan
    seen = set()
    result = []
    for sq in subqueries:
        if sq not in seen:
            seen.add(sq)
            result.append(sq)
    return result


def _strict_match(keyword_norm: str, prodi_norm: str) -> bool:
    """
    Pencocokan ketat: SEMUA kata penting (>3 karakter) dari keyword
    harus muncul di nama prodi.

    Digunakan saat fallback sub-query aktif agar hasil sub-query
    yang lebih luas tidak menangkap prodi yang tidak relevan.

    Contoh:
      keyword_norm: 'AKUNTANSI LEMBAGA KEUANGAN SYARIAH'
      prodi_norm:   'AKUNTANSI LEMBAGA KEUANGAN SYARIAH'
      → semua kata penting ada → True

      prodi_norm:   'KEUANGAN SYARIAH'
      → kata 'AKUNTANSI' dan 'LEMBAGA' tidak ada → False
    """
    sig_words = [w for w in keyword_norm.split() if len(w) > 3]
    if not sig_words:
        return False
    return all(w in prodi_norm for w in sig_words)



def _clean_provinsi(raw: str) -> str:
    """Bersihkan nama provinsi dari API PDDikti.
    Contoh: 'Prov. D.K.I. Jakarta' → 'DKI JAKARTA'
            'Prov. Jawa Barat'     → 'JAWA BARAT'
    """
    if not raw:
        return ""
    s = str(raw).strip()
    # Hilangkan prefix "Prov." / "Prov"
    s = re.sub(r"^Prov\.?\s*", "", s, flags=re.IGNORECASE)
    # Hilangkan titik dalam singkatan (D.K.I. → DKI, D.I. → DI)
    s = s.replace(".", "")
    return " ".join(s.split()).upper()


def _plain_html(raw) -> str:
    """Convert rich-text API fields to safe display text before persistence."""
    if not raw:
        return ""
    return " ".join(unescape(re.sub(r"<[^>]+>", " ", str(raw))).split())


def get_semesters(num_fallbacks=4):
    now = datetime.now()
    year, month = now.year, now.month
    if month == 1:
        current = f"{year-1}1"
    elif 2 <= month <= 8:
        current = f"{year-1}2"
    else:
        current = f"{year}1"
    sems, yr, t = [], int(current[:4]), int(current[4])
    for _ in range(num_fallbacks + 1):
        sems.append(f"{yr}{t}")
        if t == 2:
            t = 1
        else:
            t, yr = 2, yr - 1
    return sems[0], sems[1:]


def make_session():
    s = requests.Session()
    a = requests.adapters.HTTPAdapter(pool_connections=20, pool_maxsize=100, max_retries=3)
    s.mount("https://", a)
    s.mount("http://", a)
    return s


def _unwrap_api_payload(payload):
    """Normalisasi response PDDikti agar pemanggil menerima payload sebenarnya.

    PDDikti saat ini dapat mengembalikan response dalam beberapa bentuk, misalnya::

        [{...}, {...}]

    atau dibungkus metadata::

        {"status": "success", "data": [{...}, {...}]}
        {"code": 200, "message": "ok", "data": {...}}

    Kode scraper lama langsung mengiterasi object terluar. Jika response dibungkus
    ``data``, Python justru mengiterasi key string seperti ``status``/``data`` dan
    pemanggilan ``item.get(...)`` gagal dengan:
    ``'str' object has no attribute 'get'``.

    Fungsi ini unwrap wrapper umum secara konservatif dan juga menangani JSON
    yang kebetulan dikirim sebagai string.
    """
    current = payload

    for _ in range(5):
        # Ada API/proxy yang mengirim JSON sebagai string JSON.
        if isinstance(current, str):
            stripped = current.strip()
            if stripped.startswith("{") or stripped.startswith("["):
                try:
                    current = json.loads(stripped)
                    continue
                except (TypeError, ValueError, json.JSONDecodeError):
                    return current
            return current

        if not isinstance(current, dict):
            return current

        message = str(current.get("message", "")).strip().lower()
        if message == "not found":
            return None

        # Wrapper yang dipakai API PDDikti saat ini.
        if "data" in current:
            current = current["data"]
            continue

        # Toleransi terhadap wrapper proxy/API lain tanpa merusak detail object
        # normal yang memang tidak memiliki key-key tersebut.
        unwrapped = False
        for key in ("results", "result", "items"):
            if key in current and isinstance(current[key], (list, dict)):
                current = current[key]
                unwrapped = True
                break
        if unwrapped:
            continue

        return current

    return current


def fetch_api(session, endpoint, retries=MAX_RETRIES, stop_event=None):
    url = f"{BASE_URL}/{endpoint}"
    last_err = None
    for attempt in range(retries):
        try:
            r = session.get(url, headers=HEADERS, timeout=TIMEOUT)
            r.raise_for_status()
            raw = r.json()
            data = _unwrap_api_payload(raw)

            # Jangan biarkan perubahan format API berubah menjadi error .get()
            # yang tidak informatif di bagian scraper lain.
            if isinstance(data, str):
                preview = data[:120].replace("\n", " ")
                raise Exception(
                    f"Format respons PDDikti tidak dikenali pada endpoint '{endpoint}'. "
                    f"Payload berupa string: {preview!r}"
                )

            return data
        except requests.exceptions.Timeout as e:
            last_err = e
            if attempt < retries - 1:
                if stop_event: stop_event.wait(RETRY_DELAY * (attempt + 1))
                else: time.sleep(RETRY_DELAY * (attempt + 1))
        except requests.exceptions.RequestException as e:
            last_err = e
            if attempt < retries - 1:
                # Backoff lebih lama jika terkena Rate Limit 429
                if e.response is not None and e.response.status_code == 429:
                    if stop_event: stop_event.wait(5)
                    else: time.sleep(5)
                else:
                    if stop_event: stop_event.wait(RETRY_DELAY * (attempt + 1))
                    else: time.sleep(RETRY_DELAY * (attempt + 1))
        except (json.JSONDecodeError, ValueError):
            return None

    # Jika gagal total gara-gara server PDDikti (nge-lag/rate-limit)
    if last_err:
        raise Exception("Gagal terhubung ke server PDDikti (Server sibuk/rate-limit). Mohon jeda beberapa saat lalu coba lagi.")
    return None


PT_CACHE = {}
PT_CACHE_LOCK = threading.Lock()
PT_CACHE_TTL = int(os.environ.get("PDDIKTI_CACHE_TTL", 1800))  # 30 menit default


def _fallback_pt_info(pt_query):
    """Helper: kembalikan klasifikasi fallback dari nama PT saja (tanpa API)."""
    info = classify_pt_from_name(pt_query)
    info.setdefault("pembina", "")
    info.setdefault("provinsi_pt", "")
    return info


def get_pt_info(session, pt_query, stop_event=None):
    """
    Mengidentifikasi: PTN/PTS, PTKIN/NON-PTKIN, DIKTI/DIKTIS.

    Strategi klasifikasi (2-tier):
      Primary : classify_from_pembina() — klasifikasi langsung dari field
                'pembina' API PDDikti (sumber paling otoritatif).
                PTA Islam Negeri/Swasta → DIKTIS, LLDIKTI/PTN → DIKTI.
      Fallback: Heuristik 3-lapis saat pembina kosong / tidak dikenal
                (whitelist PTKIN → keyword nama → keyword pembina/kelompok)

    Jika API PDDikti gagal di tahap mana pun (timeout / not found),
    fungsi tetap mengembalikan klasifikasi best-effort dari nama PT
    menggunakan classify_pt_from_name() — kolom Excel tidak akan kosong.
    """
    if not pt_query or not pt_query.strip():
        return {}

    # Thread-safe cache read with TTL
    with PT_CACHE_LOCK:
        if pt_query in PT_CACHE:
            entry = PT_CACHE[pt_query]
            if time.time() - entry["ts"] < PT_CACHE_TTL:
                return entry["data"]
            # TTL expired — refetch dari API
            del PT_CACHE[pt_query]

    def _cache_and_return(info):
        with PT_CACHE_LOCK:
            PT_CACHE[pt_query] = {"data": info, "ts": time.time()}
        return info

    # ── Step 1: Cari ID kampus di PDDikti ─────────────────────────
    quoted_pt = urllib.parse.quote(pt_query)
    results = fetch_api(session, f"pencarian/pt/{quoted_pt}", stop_event=stop_event)
    if not results:
        return _cache_and_return(_fallback_pt_info(pt_query))

    pt_id = results[0].get("id")
    if not pt_id:
        return _cache_and_return(_fallback_pt_info(pt_query))

    # ── Step 2: Ambil detail PT (pembina, kelompok, provinsi) ─────
    detail = fetch_api(session, f"pt/detail/{pt_id}", stop_event=stop_event)
    if not detail:
        return _cache_and_return(_fallback_pt_info(pt_query))

    pembina = (detail.get("pembina") or "").strip()
    kelompok = (detail.get("kelompok") or "").strip()
    provinsi_pt = _clean_provinsi(detail.get("provinsi_pt", ""))
    pt_upper = pt_query.upper().strip()

    # ── Step 3A (Primary): Klasifikasi langsung dari field pembina ──
    # Field pembina dari PDDikti API adalah sumber paling otoritatif:
    #   "PTA Islam Negeri"  → DIKTIS, PTN, PTKIN   (Kemenag)
    #   "PTA Islam Swasta"  → DIKTIS, PTS, NON PTKIN (Kemenag)
    #   "LLDIKTI [X]"       → DIKTI,  PTS, NON PTKIN (Kemendikbudristek)
    #   "PTN"               → DIKTI,  PTN, NON PTKIN (Kemendikbudristek)
    cls = classify_from_pembina(pembina)
    if cls:
        # Safety net: jika kampus ada di whitelist PTKIN tapi pembina-nya
        # tidak terduga (edge case saat data PDDikti belum di-update)
        if pt_upper in PTKIN_SET and cls["ptkin_non"] != "PTKIN":
            cls["ptkin_non"] = "PTKIN"
            cls["ptn_pts"] = "PTN"
            cls["dikti_diktis"] = "DIKTIS"
        info = {**cls, "pembina": pembina, "provinsi_pt": provinsi_pt}
        return _cache_and_return(info)

    # ── Step 3B (Fallback): Heuristik saat pembina kosong / tidak dikenal ──
    if pt_upper in PTKIN_SET:
        is_negeri = True
        is_ptkin = True
    else:
        # Kedinasan / PTN check: NEGERI, NEGARA (contoh: STAN), KEMENTERIAN, BADAN
        pembina_kel_upper = pembina.upper() + " " + kelompok.upper()
        is_negeri = (
            "NEGERI" in pembina_kel_upper or 
            "NEGERI" in pt_upper or
            "NEGARA" in pt_upper or
            "KEMENTERIAN" in pembina_kel_upper or
            "BADAN" in pembina_kel_upper
        )
        is_islam_check = (
            any(k in pembina.upper() for k in ["ISLAM", "AGAMA"])
            or any(k in kelompok.upper() for k in ["ISLAM", "AGAMA"])
        )
        is_ptkin = is_negeri and is_islam_check

    is_diktis_result = is_diktis(pt_query, pembina=pembina, kelompok=kelompok)

    info = {
        "ptn_pts": "PTN" if is_negeri else "PTS",
        "ptkin_non": "PTKIN" if is_ptkin else "NON PTKIN",
        "dikti_diktis": "DIKTIS" if is_diktis_result else "DIKTI",
        "pembina": pembina,
        "provinsi_pt": provinsi_pt,
    }
    return _cache_and_return(info)


def search_all_prodi(session, prodi_keywords, cb, stop_event=None):
    """Cari hanya program studi yang ada pada daftar target wajib.

    Setiap item pada ``prodi_keywords`` berasal dari konfigurasi backend
    ``scraper/target_prodi.py``.
    API PDDikti tetap memakai endpoint pencarian nama, tetapi hasilnya difilter
    EXACT setelah normalisasi. Dengan begitu memilih ``KEUANGAN SYARIAH`` tidak
    ikut mengambil ``MANAJEMEN KEUANGAN DAN PERBANKAN SYARIAH`` atau prodi lain
    yang hanya kebetulan mengandung kata yang sama.

    Exact matching tetap toleran terhadap variasi apostrophe/whitespace yang
    ditangani oleh ``normalize()`` (mis. SYARI'AH == SYARIAH).
    """
    cb("=" * 60)
    cb(f"STEP 1: Mencari {len(prodi_keywords)} Program Studi Terpilih...")
    cb("=" * 60)
    cb({"__progress__": True, "step": 1, "current": 0, "total": len(prodi_keywords), "label": "Search Prodi"})

    all_prodi, seen_ids, seen_logical = [], set(), set()

    for kw_idx, keyword in enumerate(prodi_keywords, 1):
        if stop_event and stop_event.is_set():
            raise Exception("Scraping dihentikan oleh pengguna.")

        cb({"__progress__": True, "step": 1, "current": kw_idx, "total": len(prodi_keywords), "label": "Search Prodi"})
        cb(f"\n🔍 Target prodi: {keyword}")

        if stop_event:
            stop_event.wait(REQUEST_DELAY)
        else:
            time.sleep(REQUEST_DELAY)

        target_norm = normalize(keyword)
        quoted_kw = urllib.parse.quote(keyword)
        results = fetch_api(session, f"pencarian/prodi/{quoted_kw}", stop_event=stop_event)

        # Beberapa nama panjang kadang tidak menghasilkan respons pada query penuh.
        # Kita boleh memakai sub-query untuk MENEMUKAN kandidat, tetapi kandidat
        # tetap harus sama persis dengan nama prodi yang dipilih setelah normalize().
        if not results and len(keyword.split()) > 2:
            for subq in _generate_subqueries(keyword):
                if stop_event and stop_event.is_set():
                    break
                if stop_event:
                    stop_event.wait(REQUEST_DELAY)
                else:
                    time.sleep(REQUEST_DELAY)

                cb(f"   🔄 Fallback pencarian: '{subq}' (filter exact tetap aktif)...")
                results = fetch_api(
                    session,
                    f"pencarian/prodi/{urllib.parse.quote(subq)}",
                    stop_event=stop_event,
                )
                if results:
                    break

        if not results:
            cb("   ⚠️ Tidak ditemukan di PDDikti")
            continue

        # Defensive: endpoint pencarian seharusnya list. Kalau bentuknya berubah,
        # jangan iterasi dict/string dan menghasilkan error '.get'.
        if isinstance(results, dict):
            results = [results]
        if not isinstance(results, list):
            cb(f"   ⚠️ Format hasil pencarian tidak didukung: {type(results).__name__}")
            continue

        count = 0
        rejected = 0

        for prodi in results:
            if stop_event and stop_event.is_set():
                break
            if not isinstance(prodi, dict):
                rejected += 1
                continue

            prodi_id = str(prodi.get("id", "")).strip()
            prodi_name = str(prodi.get("nama", "")).strip()
            prodi_norm = normalize(prodi_name)

            # FILTER UTAMA: hanya nama prodi yang benar-benar dipilih.
            if prodi_norm != target_norm:
                rejected += 1
                continue

            # seen_ids baru dicatat SETELAH kandidat lolos exact filter.
            # Ini penting pada multi-select: hasil broad dari query sebelumnya
            # tidak boleh membuat target query berikutnya ter-skip.
            if not prodi_id or prodi_id in seen_ids:
                continue

            pt_name = str(prodi.get("pt", "")).strip()
            jenjang = str(prodi.get("jenjang", "")).strip()
            logical_key = f"{prodi_norm}|{jenjang}|{pt_name}".upper()
            if logical_key in seen_logical:
                continue

            if stop_event:
                stop_event.wait(REQUEST_DELAY)
            else:
                time.sleep(REQUEST_DELAY)

            detail = fetch_api(session, f"prodi/detail/{prodi_id}", stop_event=stop_event)
            if not isinstance(detail, dict):
                continue

            status = str(detail.get("status") or "").strip()
            if status.upper() != "AKTIF":
                continue

            # Tandai seen hanya untuk record yang benar-benar diterima.
            seen_ids.add(prodi_id)
            seen_logical.add(logical_key)

            pt_info = get_pt_info(session, pt_name, stop_event=stop_event)
            provinsi_val = _clean_provinsi(detail.get("provinsi", "")) or pt_info.get("provinsi_pt", "")

            all_prodi.append({
                "id": prodi_id,
                "id_sp": detail.get("id_sp", ""),
                "id_sms": detail.get("id_sms", ""),
                "nama": prodi_name,
                "jenjang": jenjang,
                "pt": pt_name,
                "pt_singkat": prodi.get("pt_singkat", ""),
                "kode_pt": str(detail.get("kode_pt", "")).strip(),
                "kode_prodi": str(detail.get("kode_prodi", "")).strip(),
                "kelompok_bidang": detail.get("kel_bidang", ""),
                "keterangan": status,
                "akreditasi": detail.get("akreditasi", ""),
                "akreditasi_internasional": detail.get("akreditasi_internasional", ""),
                "status_akreditasi": detail.get("status_akreditasi", ""),
                "tanggal_berdiri": detail.get("tgl_berdiri", ""),
                "tanggal_sk_penyelenggaraan": detail.get("tgl_sk_selenggara", ""),
                "nomor_sk_penyelenggaraan": detail.get("sk_selenggara", ""),
                "telepon": detail.get("no_tel", ""),
                "fax": detail.get("no_fax", ""),
                "website": detail.get("website", ""),
                "email": detail.get("email", ""),
                "alamat": detail.get("alamat", ""),
                "provinsi": provinsi_val,
                "kabupaten_kota": detail.get("kab_kota", ""),
                "kecamatan": detail.get("kecamatan", ""),
                "lintang": detail.get("lintang"),
                "bujur": detail.get("bujur"),
                "ptn_pts": pt_info.get("ptn_pts", ""),
                "ptkin_non": pt_info.get("ptkin_non", ""),
                "dikti_diktis": pt_info.get("dikti_diktis", ""),
                "pembina": pt_info.get("pembina", ""),
                "detail_pddikti": detail,
            })
            count += 1

        cb(f"   ✅ {count} prodi aktif cocok EXACT untuk '{keyword}'")
        if rejected:
            cb(f"   ↪️ {rejected} hasil mirip diabaikan karena bukan exact target")

    cb(f"\n📊 Total instance prodi terpilih ditemukan: {len(all_prodi)}")
    return all_prodi


def _fetch_prodi_enrichment(prodi, stop_event=None):
    if stop_event and stop_event.is_set():
        return {}
    worker_session = make_session()
    prodi_id = prodi.get("id", "")
    result = {}
    try:
        desc = fetch_api(worker_session, f"prodi/desc/{prodi_id}", stop_event=stop_event)
        if isinstance(desc, dict):
            result.update({
                "jumlah_dosen_pddikti": desc.get("jumlah_dosen", 0),
                "jumlah_mahasiswa": desc.get("jumlah_mahasiswa", 0),
                "jumlah_dosen_ajar": desc.get("jumlah_dosen_ajar", 0),
                "rasio_dosen_mahasiswa": desc.get("rasio", ""),
                "rasio_diterima_pendaftar": desc.get("rasio_terima_daftar", ""),
                "jumlah_pendaftar": desc.get("jumlah_pendaftar", 0),
                "jumlah_diterima": desc.get("jumlah_diterima", 0),
                "persentase_diterima": desc.get("persentase", 0),
                "deskripsi_singkat": _plain_html(desc.get("deskripsi_singkat", "")),
                "visi": _plain_html(desc.get("visi", "")),
                "misi": _plain_html(desc.get("misi", "")),
                "kompetensi": _plain_html(desc.get("kompetensi", "")),
                "deskripsi_pddikti": desc,
            })
        history = fetch_api(
            worker_session,
            f"prodi/num-students-lecturers/{prodi_id}",
            stop_event=stop_event,
        )
        result["statistik_semester"] = history if isinstance(history, list) else []
    except Exception:
        result["status_detail_prodi"] = "detail PDDIKTI sementara tidak tersedia"
    try:
        result.update(enrich_banpt({**prodi, **result}))
    except Exception:
        result.update({
            "tanggal_sk_akreditasi": "",
            "tanggal_akhir_akreditasi": "",
            "status_pencocokan_akreditasi": "sumber sementara tidak tersedia",
            "sumber_akreditasi": "SAPTO BAN-PT",
        })
    try:
        lam_result = enrich_national({**prodi, **result})
        # A LAM decision supersedes BAN-PT only when the issuer's own public
        # directory identifies the exact PT, program and level.
        if lam_result.get("status_pencocokan_lam") == "terverifikasi":
            result.update(lam_result)
            result["status_pencocokan_akreditasi"] = "terverifikasi"
        else:
            result.update(lam_result)
    except Exception:
        result["status_pencocokan_lam"] = "sumber sementara tidak tersedia"
    try:
        result.update(enrich_international({**prodi, **result}))
    except Exception:
        result["pemeriksaan_akreditasi_internasional"] = []
    return result


def enrich_prodi_records(prodi_list, cb, stop_event=None):
    """Enrich prodi concurrently while keeping failures non-fatal."""
    if not prodi_list:
        return prodi_list
    cb("\n🔎 Melengkapi detail prodi dan masa berlaku akreditasi...")
    worker_count = min(max(1, MAX_WORKERS), 4, len(prodi_list))
    with ThreadPoolExecutor(max_workers=worker_count) as executor:
        futures = {
            executor.submit(_fetch_prodi_enrichment, prodi, stop_event): prodi
            for prodi in prodi_list
        }
        for index, future in enumerate(as_completed(futures), 1):
            if stop_event and stop_event.is_set():
                break
            prodi = futures[future]
            try:
                prodi.update(future.result())
            except Exception:
                prodi["status_detail_prodi"] = "detail sementara tidak tersedia"
            cb({"__progress__": True, "step": 1, "current": index, "total": len(prodi_list), "label": "Detail Prodi"})
    verified = sum(1 for item in prodi_list if item.get("status_pencocokan_akreditasi") == "terverifikasi")
    cb(f"   ✅ Detail prodi lengkap; masa akreditasi terverifikasi: {verified}/{len(prodi_list)}")
    return prodi_list

def fetch_dosen_homebase(session, prodi_list, semester, fallbacks, cb, stop_event=None):
    cb("\n" + "=" * 60)
    cb("STEP 2: Mengambil daftar dosen homebase per prodi")
    cb("=" * 60)
    cb({"__progress__": True, "step": 2, "current": 0, "total": len(prodi_list), "label": "Fetch Dosen"})
    all_dosen, seen_nidn, failed = [], set(), []
    for i, prodi in enumerate(prodi_list, 1):
        if stop_event and stop_event.is_set():
            raise Exception("Scraping dihentikan oleh pengguna.")
        cb({"__progress__": True, "step": 2, "current": i, "total": len(prodi_list), "label": "Fetch Dosen"})
        prodi_id = prodi["id"]
        label = f"{prodi['nama']} ({prodi['jenjang']}) - {prodi['pt']}"
        cb(f"\n[{i}/{len(prodi_list)}] {label}")
        if stop_event: stop_event.wait(REQUEST_DELAY)
        else: time.sleep(REQUEST_DELAY)
        dosen_list = fetch_api(session, f"dosen/homebase/{prodi_id}?semester={semester}", stop_event=stop_event)
        sem_used = semester
        if not dosen_list:
            for prev in fallbacks:
                if stop_event: stop_event.wait(REQUEST_DELAY)
                else: time.sleep(REQUEST_DELAY)
                dosen_list = fetch_api(session, f"dosen/homebase/{prodi_id}?semester={prev}", stop_event=stop_event)
                if dosen_list:
                    cb(f"   ℹ️ Menggunakan semester {prev}")
                    sem_used = prev
                    break
            if not dosen_list:
                cb(f"   ⚠️ Tidak ada data dosen")
                failed.append(label)
                prodi["semester_lapor"] = "Belum Lapor"
                continue
        prodi["semester_lapor"] = sem_used
        count_new = 0
        for d in dosen_list:
            if stop_event and stop_event.is_set():
                break
            nidn = d.get("nidn", "")
            nuptk = d.get("nuptk", "")
            nama = d.get("nama_dosen", "")
            key = nidn if nidn else (nuptk if nuptk else nama)
            if key in seen_nidn:
                continue
            seen_nidn.add(key)
            all_dosen.append({
                "nama_dosen": nama, "nidn": nidn, "nuptk": nuptk,
                "pendidikan": d.get("pendidikan", ""), "status_aktif": d.get("status_aktif", ""),
                "status_pegawai": d.get("status_pegawai", ""), "ikatan_kerja": d.get("ikatan_kerja", ""),
                "prodi_asal": prodi["nama"], "jenjang_prodi": prodi["jenjang"],
                "pt_asal": prodi["pt"], "semester_data": sem_used,
                "_raw_homebase": d,
            })
            count_new += 1
        cb(f"   ✅ {len(dosen_list)} dosen, {count_new} baru (total unik: {len(all_dosen)})")
    if failed:
        cb(f"\n⚠️ {len(failed)} prodi tidak punya data dosen")
    cb(f"\n📊 Total dosen unik: {len(all_dosen)}")
    return all_dosen


def fetch_single_profile(session, dosen, stop_event=None):
    nidn = dosen.get("nidn", "")
    nuptk = dosen.get("nuptk", "")
    nama = dosen.get("nama_dosen", "")
    result = {
        "Nama": nama, "Perguruan Tinggi": dosen.get("pt_asal", ""),
        "Jabatan Fungsional": "", "Status Ikatan Kerja": dosen.get("ikatan_kerja", ""),
        "Jenis Kelamin": "", "Program Studi": dosen.get("prodi_asal", ""),
        "Jenjang": dosen.get("jenjang_prodi", ""), "Pendidikan Terakhir": dosen.get("pendidikan", ""),
        "Status Aktifitas": dosen.get("status_aktif", ""), "NIDN": nidn,
        "NUPTK": nuptk, "Status Kepegawaian": dosen.get("status_pegawai", ""),
        "Semester Data": dosen.get("semester_data", ""),
        "ID Dosen PDDIKTI": "",
        "Data Homebase Mentah": dosen.get("_raw_homebase", {}),
        "Data Pencarian Mentah": {},
        "Profil Mentah": {},
        "Riwayat Pendidikan": [],
        "Riwayat Mengajar": [],
        "Sertifikasi": [],
        "Jumlah Riwayat Pendidikan": 0,
        "Jumlah Riwayat Mengajar": 0,
        "Jumlah Sertifikasi": 0,
        "Status Detail PDDIKTI": {
            "profil": "belum ditemukan",
            "riwayat_pendidikan": "belum diambil",
            "riwayat_mengajar": "belum diambil",
            "sertifikasi": "endpoint publik tidak tersedia",
            "penelitian": "endpoint publik tidak tersedia",
            "pengabdian": "endpoint publik tidak tersedia",
            "karya": "endpoint publik tidak tersedia",
            "paten": "endpoint publik tidak tersedia",
        },
    }
    search_key = nidn if nidn else (nuptk if nuptk else nama)
    if not search_key:
        return result
    if stop_event: stop_event.wait(REQUEST_DELAY)
    else: time.sleep(REQUEST_DELAY)
    search_results = fetch_api(session, f"pencarian/dosen/{search_key}", stop_event=stop_event)
    if not search_results:
        return result
    search_id = None
    matched_search = None
    for sr in search_results:
        if nidn and sr.get("nidn", "") == nidn:
            search_id, matched_search = sr.get("id", ""), sr; break
        elif nuptk and sr.get("nuptk", "") == nuptk:
            search_id, matched_search = sr.get("id", ""), sr; break
        elif sr.get("nama", "").upper() == nama.upper():
            search_id, matched_search = sr.get("id", ""), sr; break
    if not search_id:
        return result
    result["ID Dosen PDDIKTI"] = search_id
    result["Data Pencarian Mentah"] = matched_search or {}
    if stop_event: stop_event.wait(REQUEST_DELAY)
    else: time.sleep(REQUEST_DELAY)
    profile = fetch_api(session, f"dosen/profile/{search_id}", stop_event=stop_event)
    if profile and isinstance(profile, dict):
        profile_nidn = profile.get("nidn_dosen", "") or profile.get("nidn", "")
        profile_nuptk = profile.get("nuptk", "")
        if nidn and profile_nidn and profile_nidn != nidn:
            return result
        if not nidn and nuptk and profile_nuptk and profile_nuptk != nuptk:
            return result
        profil_nama = profile.get("nama_dosen", "")
        if profil_nama and nama:
            t1 = set(w for w in nama.lower().split() if len(w) > 2)
            t2 = set(w for w in profil_nama.lower().split() if len(w) > 2)
            if t1 and t2 and t1.isdisjoint(t2):
                return result
        result["Profil Mentah"] = profile
        result["Status Detail PDDIKTI"]["profil"] = "tersedia"
        result["Nama"] = profile.get("nama_dosen", nama)
        result["Perguruan Tinggi"] = profile.get("nama_pt", result["Perguruan Tinggi"])
        result["Jabatan Fungsional"] = profile.get("jabatan_akademik", "")
        result["Status Ikatan Kerja"] = profile.get("status_ikatan_kerja", result["Status Ikatan Kerja"])
        result["Jenis Kelamin"] = profile.get("jenis_kelamin", "")
        result["Pendidikan Terakhir"] = profile.get("pendidikan_tertinggi", result["Pendidikan Terakhir"])
        result["Status Aktifitas"] = profile.get("status_aktivitas", result["Status Aktifitas"])

    for field_name, endpoint_name in DOSEN_DETAIL_ENDPOINTS.items():
        if stop_event: stop_event.wait(REQUEST_DELAY)
        else: time.sleep(REQUEST_DELAY)
        status_key = "riwayat_pendidikan" if field_name == "Riwayat Pendidikan" else "riwayat_mengajar"
        try:
            detail = fetch_api(session, f"dosen/{endpoint_name}/{search_id}", stop_event=stop_event)
            if isinstance(detail, list):
                rows = detail
            elif isinstance(detail, dict):
                rows = [detail]
            else:
                rows = []
            result[field_name] = rows
            result["Status Detail PDDIKTI"][status_key] = "tersedia" if rows else "kosong"
        except Exception:
            # Profil utama tetap berguna walaupun satu endpoint tambahan sedang gagal.
            result["Status Detail PDDIKTI"][status_key] = "gagal diambil"

    result["Jumlah Riwayat Pendidikan"] = len(result["Riwayat Pendidikan"])
    result["Jumlah Riwayat Mengajar"] = len(result["Riwayat Mengajar"])
    result["Jumlah Sertifikasi"] = len(result["Sertifikasi"])
    return result


def fetch_all_profiles(session, dosen_list, cb, stop_event=None):
    cb("\n" + "=" * 60)
    cb(f"STEP 3: Mengambil profil detail {len(dosen_list)} dosen...")
    cb("=" * 60)
    cb({"__progress__": True, "step": 3, "current": 0, "total": len(dosen_list), "label": "Profil Dosen"})
    all_profiles, completed, failed = [], 0, 0
    start = time.time()
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = {executor.submit(fetch_single_profile, session, d, stop_event): i + 1 for i, d in enumerate(dosen_list)}
        for future in as_completed(futures):
            if stop_event and stop_event.is_set():
                # cancel_futures hanya tersedia sejak Python 3.9
                if sys.version_info >= (3, 9):
                    executor.shutdown(wait=False, cancel_futures=True)
                else:
                    executor.shutdown(wait=False)
                raise Exception("Scraping dihentikan oleh pengguna.")
            completed += 1
            try:
                all_profiles.append(future.result())
            except Exception:
                failed += 1
            if completed % 50 == 0 or completed == len(dosen_list):
                cb({"__progress__": True, "step": 3, "current": completed, "total": len(dosen_list), "label": "Profil Dosen"})
                elapsed = time.time() - start
                rate = completed / elapsed if elapsed > 0 else 1
                eta = (len(dosen_list) - completed) / rate
                pct = completed * 100 // len(dosen_list)
                cb(f"📊 Progress: {completed}/{len(dosen_list)} ({pct}%) — ETA: ~{eta:.0f}s")
    cb(f"\n✅ {len(all_profiles)} profil berhasil, {failed} gagal")
    return all_profiles




def export_to_excel(profiles, prodi_list, semester, output_dir, cb):
    """Ekspor terstruktur; scraping dan penyimpanan PostgreSQL tetap tidak berubah."""
    from scraper.excel_export import export_to_excel as write_excel

    return write_excel(profiles, prodi_list, semester, output_dir, cb)



def collect_dosen_data(prodi_keywords, callback, stop_event=None):
    """Collect raw scraper results without deciding how they are persisted or exported."""
    # PT_CACHE bersifat additive (data PT tidak berubah antar sesi),
    # sehingga TIDAK perlu di-clear — ini juga mencegah corruption
    # jika ada dua job berjalan bersamaan (C2 fix).

    # ── Auto-refresh whitelist PTKIN dari SPAN-PTKIN (sekali per sesi) ──
    refresh_ptkin_whitelist(log_fn=callback)

    session = make_session()
    semester, fallbacks = get_semesters()
    callback(f"\n⚙️  Semester: {semester}")
    callback(f"⚙️  Target prodi wajib: {len(prodi_keywords)}")
    callback(f"⚙️  Max Workers: {MAX_WORKERS}\n")

    prodi_list = search_all_prodi(session, prodi_keywords, callback, stop_event)
    if not prodi_list:
        raise Exception("Tidak ada prodi ditemukan. Periksa koneksi internet atau keyword.")

    prodi_list = enrich_prodi_records(prodi_list, callback, stop_event)

    dosen_list = fetch_dosen_homebase(session, prodi_list, semester, fallbacks, callback, stop_event)
    if not dosen_list:
        raise Exception("Tidak ada dosen ditemukan.")

    profiles = fetch_all_profiles(session, dosen_list, callback, stop_event)
    return profiles, prodi_list, semester


def run_dosen_scraper(prodi_keywords, output_dir, callback, stop_event=None):
    """Backward-compatible entry point that still produces an Excel file directly."""
    profiles, prodi_list, semester = collect_dosen_data(
        prodi_keywords, callback, stop_event
    )
    filename = export_to_excel(profiles, prodi_list, semester, output_dir, callback)

    callback(f"\n🎉 SELESAI! Total dosen: {len(profiles)}, Total prodi: {len(prodi_list)}")
    return filename
