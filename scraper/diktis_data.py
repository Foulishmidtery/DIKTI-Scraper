"""
diktis_data.py — Whitelist PTKI + Auto-Refresh dari SPAN-PTKIN

Sumber data:
  • Whitelist statis : SPAN-PTKIN 2026 (span.ptkin.ac.id/ptkin)
  • Auto-refresh     : Dijalankan SEKALI saat program startup.
                       Mengambil daftar PTKIN terbaru dari SPAN-PTKIN,
                       lalu merge ke PTKIN_SET agar selalu up-to-date.

Strategi is_diktis() — 3 Lapis:
  Layer 1: Exact-match PTKIN_SET (whitelist statis + hasil auto-refresh)
  Layer 2: Keyword substring pada nama kampus (UIN, IAIN, STAI, dll.)
  Layer 3: Keyword kolom 'pembina' dari PDDikti API (fallback heuristik)
"""

import re
import threading
import requests

# ─────────────────────────────────────────────────────────────────
# PTKIN NEGERI — Sumber resmi: span.ptkin.ac.id/ptkin (59 kampus)
# ─────────────────────────────────────────────────────────────────
PTKIN_NAMES = {
    # === UIN (Universitas Islam Negeri) ===
    "UIN SUMATERA UTARA MEDAN",
    "UIN SULTAN SYARIF KASIM RIAU",
    "UIN AR-RANIRY BANDA ACEH",
    "UIN IMAM BONJOL PADANG",
    "UIN SULTANAH NAHRASIYAH LHOKSEUMAWE",
    "UIN SYEKH ALI HASAN AHMAD ADDARY PADANGSIDIMPUAN",
    "UIN MAHMUD YUNUS BATUSANGKAR",
    "UIN SJECH M. DJAMIL DJAMBEK BUKITTINGGI",
    "UIN RADEN FATAH PALEMBANG",
    "UIN RADEN INTAN LAMPUNG",
    "UIN SULTHAN THAHA SAIFUDDIN JAMBI",
    "UIN FATMAWATI SUKARNO BENGKULU",
    "UIN JURAI SIWO LAMPUNG",
    "UIN SYARIF HIDAYATULLAH JAKARTA",
    "UIN SUNAN GUNUNG DJATI BANDUNG",
    "UIN SULTAN MAULANA HASANUDDIN BANTEN",
    "UIN SIBER SYEKH NURJATI CIREBON",
    "UIN SUNAN KALIJAGA YOGYAKARTA",
    "UIN WALISONGO SEMARANG",
    "UIN K.H. ABDURRAHMAN WAHID PEKALONGAN",
    "UIN RADEN MAS SAID SURAKARTA",
    "UIN PROFESOR K.H. SAIFUDDIN ZUHRI PURWOKERTO",
    "UIN SALATIGA",
    "UIN SUNAN KUDUS",
    "UIN SUNAN AMPEL SURABAYA",
    "UIN MAULANA MALIK IBRAHIM MALANG",
    "UIN KH.ACHMAD SIDDIQ ( KHAS ) JEMBER",
    "UIN KH. ACHMAD SIDDIQ JEMBER",
    "UIN MADURA",
    "UIN SYEKH WASIL KEDIRI",
    "UIN SAYYID ALI RAHMATULLAH TULUNGAGUNG",
    "UIN KIAI AGENG MUHAMMAD BESARI PONOROGO",
    "UIN ANTASARI BANJARMASIN",
    "UIN SULTAN AJI MUHAMMAD IDRIS SAMARINDA",
    "UIN PALANGKA RAYA",
    "UIN MATARAM",
    "UIN ALAUDDIN MAKASAR",    # Alias defensif — PDDikti kadang pakai ejaan tanpa double-S
    "UIN ALAUDDIN MAKASSAR",   # Ejaan resmi
    "UIN DATOKARAMA PALU",
    "UIN PALOPO",
    "UIN ABDUL MUTHALIB SANGADJI AMBON",
    # === IAIN (Institut Agama Islam Negeri) ===
    "IAIN LANGSA",
    "IAIN KERINCI",
    "IAIN CURUP",
    "IAIN SYAIKH ABDURRAHMAN SIDDIK BANGKA BELITUNG",
    "IAIN PONTIANAK",
    "IAIN SULTAN AMAI GORONTALO",
    "IAIN MANADO",
    "IAIN PAREPARE",
    "IAIN BONE",
    "IAIN KENDARI",
    "IAIN TERNATE",
    "IAIN FATTAHUL MULUK PAPUA",
    "IAIN SORONG",
    "IAIN TAKENGON",
    "IAIN DATUK LAKSEMANA BENGKALIS",
    # === STAIN (Sekolah Tinggi Agama Islam Negeri) ===
    "STAIN TEUNGKU DIRUNDENG MEULABOH",
    "STAIN MAJENE",
    "STAIN SULTAN ABDURRAHMAN KEPULAUAN RIAU",
    "STAIN MANDAILING NATAL",
    # === Bentuk lama sebelum alih status ===
    "IAIN PONOROGO",
    "IAIN KEDIRI",
    "IAIN PALOPO",
    "IAIN PALANGKA RAYA",
    "IAIN BENGKULU",
}

# Set ternormalisasi untuk lookup cepat (mutable — bisa di-update saat runtime)
PTKIN_SET = {name.upper() for name in PTKIN_NAMES}

# ─────────────────────────────────────────────────────────────────
# AUTO-REFRESH – Ambil daftar PTKIN terbaru dari SPAN-PTKIN
# ─────────────────────────────────────────────────────────────────
_refresh_done = False
_refresh_lock = threading.Lock()  # melindungi _refresh_done DAN PTKIN_SET.update()


def refresh_ptkin_whitelist(log_fn=None):
    """
    Mengambil daftar PTKIN terbaru dari span.ptkin.ac.id dan
    menambahkannya ke PTKIN_SET global.

    Hanya berjalan SEKALI per sesi (thread-safe).
    Jika gagal (timeout / offline), program tetap lanjut dengan whitelist statis.

    Args:
        log_fn: opsional, fungsi callback untuk logging (misal: callback dari scraper)
    """
    global _refresh_done, PTKIN_SET

    with _refresh_lock:
        if _refresh_done:
            return
        _refresh_done = True

    def _log(msg):
        if log_fn:
            try:
                log_fn(msg)
            except Exception:
                pass  # Abaikan error encoding di terminal Windows

    try:
        _log("🔄 Auto-refresh: Mengambil daftar PTKIN terbaru dari SPAN-PTKIN...")
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "text/html,application/xhtml+xml",
            "Referer": "https://span.ptkin.ac.id/",
        }
        resp = requests.get(
            "https://span.ptkin.ac.id/ptkin",
            headers=headers,
            timeout=15
        )
        resp.raise_for_status()
        html = resp.text

        # Ekstrak nama PTKIN dari HTML
        # Pola di SPAN-PTKIN: "Nama Kampus</div>" di dalam kartu tiap kampus
        found_names = set()
        # Regex: tangkap teks sebelum </div> yang diawali UIN/IAIN/STAIN
        pattern = re.compile(
            r'((?:UIN|IAIN|STAIN)\s[^<\n]{3,100})</div>',
            re.IGNORECASE
        )
        for match in pattern.finditer(html):
            name = match.group(1).strip()
            name = re.sub(r'\s+', ' ', name).upper()
            if 5 < len(name) < 120:
                found_names.add(name)

        if found_names:
            # ── Proteksi write ke PTKIN_SET dengan lock (thread-safe) ──
            with _refresh_lock:
                before = len(PTKIN_SET)
                PTKIN_SET.update(found_names)
                added = len(PTKIN_SET) - before
            _log(f"✅ Auto-refresh selesai: {len(found_names)} PTKIN ditemukan, "
                 f"{added} entri baru ditambahkan ke whitelist.")
        else:
            _log("⚠️  Auto-refresh: Tidak ada data baru ditemukan, pakai whitelist statis.")

    except requests.exceptions.ConnectionError:
        _log("⚠️  Auto-refresh: Tidak ada koneksi ke SPAN-PTKIN, pakai whitelist statis.")
    except requests.exceptions.Timeout:
        _log("⚠️  Auto-refresh: Timeout koneksi ke SPAN-PTKIN, pakai whitelist statis.")
    except Exception as e:
        _log(f"⚠️  Auto-refresh gagal ({type(e).__name__}), pakai whitelist statis.")


# ─────────────────────────────────────────────────────────────────
# KEYWORD pada NAMA KAMPUS → memastikan PTKIS (Swasta Islam)
# Cukup jika kata kunci ini ada di nama → DIKTIS
# ─────────────────────────────────────────────────────────────────
DIKTIS_NAME_KEYWORDS = [
    "UNIVERSITAS ISLAM NEGERI",
    "INSTITUT AGAMA ISLAM NEGERI",
    "SEKOLAH TINGGI AGAMA ISLAM NEGERI",
    "UNIVERSITAS ISLAM ",
    "INSTITUT AGAMA ISLAM",
    "SEKOLAH TINGGI AGAMA ISLAM",
    "SEKOLAH TINGGI EKONOMI ISLAM",
    "SEKOLAH TINGGI ILMU TARBIYAH",
    "SEKOLAH TINGGI ILMU USHULUDDIN",
    "SEKOLAH TINGGI ILMU SYARIAH",
    "SEKOLAH TINGGI ILMU DAKWAH",
    "SEKOLAH TINGGI ILMU EKONOMI SYARIAH",
    "AKADEMI AGAMA ISLAM",
    "INSTITUT ISLAM",
    "UNIVERSITAS NAHDLATUL ULAMA",
    "UNIVERSITAS MUHAMMADIYAH",
    "UNIVERSITAS NU ",
    "UIN ",
    "IAIN ",
    "STAIN ",
    "STAI ",
    "STEI SEBI",
    "STEBIS",
    "IAI ",   # Institut Agama Islam swasta
    "IAINU",  # IAI Nahdlatul Ulama
    "IAIM",   # IAI Muhammadiyah
]

# ─────────────────────────────────────────────────────────────────
# KEYWORD dalam field PEMBINA dari PDDikti API → DIKTIS
# Digunakan sebagai fallback (Layer 3) saat pembina tidak cocok
# dengan pola utama classify_from_pembina().
# ─────────────────────────────────────────────────────────────────
DIKTIS_PEMBINA_KEYWORDS = [
    "KEMENTERIAN AGAMA",
    "KEMENAG",
    "DIKTIS",
    "KOPERTAIS",
    "KOPERAIS",
    "DIREKTORAT JENDERAL PENDIDIKAN ISLAM",
    "DIRJEN PENDIS",
    "PENDIDIKAN ISLAM",
    "PTA ISLAM",        # PTA Islam Negeri & PTA Islam Swasta (nilai aktual PDDikti API)
]


# ─────────────────────────────────────────────────────────────────
# PRIMARY CLASSIFICATION — Langsung dari field 'pembina' PDDikti
# ─────────────────────────────────────────────────────────────────
def classify_from_pembina(pembina: str) -> dict | None:
    """
    Klasifikasi LANGSUNG dari field 'pembina' API PDDikti.

    Field pembina dari PDDikti memiliki 4 nilai tetap yang sudah
    merupakan sumber otoritatif untuk klasifikasi:

      "LLDIKTI [X]"       → DIKTI,  PTS, NON PTKIN  (Kemendikbudristek)
      "PTN"               → DIKTI,  PTN, NON PTKIN  (Kemendikbudristek)
      "PTA Islam Negeri"  → DIKTIS, PTN, PTKIN       (Kemenag)
      "PTA Islam Swasta"  → DIKTIS, PTS, NON PTKIN   (Kemenag)
      (blank/lainnya)     → None   (fallback ke heuristik)

    Returns:
        dict dengan keys ptn_pts, ptkin_non, dikti_diktis
        atau None jika pembina kosong / tidak dikenali.
    """
    if not pembina or not pembina.strip():
        return None

    p = pembina.upper().strip()

    # ── PTA Islam (Kemenag) ──
    if p.startswith("PTA ISLAM"):
        is_negeri = "NEGERI" in p
        return {
            "ptn_pts": "PTN" if is_negeri else "PTS",
            "ptkin_non": "PTKIN" if is_negeri else "NON PTKIN",
            "dikti_diktis": "DIKTIS",
        }

    # ── LLDIKTI (Kemendikbudristek — PTS) ──
    if p.startswith("LLDIKTI"):
        return {
            "ptn_pts": "PTS",
            "ptkin_non": "NON PTKIN",
            "dikti_diktis": "DIKTI",
        }

    # ── PTN (Kemendikbudristek — Negeri) ──
    if p == "PTN":
        return {
            "ptn_pts": "PTN",
            "ptkin_non": "NON PTKIN",
            "dikti_diktis": "DIKTI",
        }

    # Nilai pembina tidak dikenali → fallback ke heuristik
    return None


def classify_pt_from_name(pt_name: str) -> dict:
    """
    Klasifikasi best-effort PTN/PTS, PTKIN/NON-PTKIN, DIKTI/DIKTIS
    hanya dari NAMA kampus, tanpa data dari API PDDikti.

    Dipakai sebagai fallback di get_pt_info() saat API PDDikti
    gagal merespons (timeout, not found, dll.).

    Keterbatasan:
      - PTN/PTS hanya bisa disimpulkan jika kampus ada di whitelist PTKIN
        atau namanya mengandung kata 'NEGERI'. Jika tidak, default ke 'PTS'.
      - DIKTI/DIKTIS tetap akurat lewat Layer 1 & 2 is_diktis().
    """
    pt_upper = pt_name.upper().strip()

    # PTN: ada di whitelist PTKIN resmi ATAU nama mengandung 'NEGERI', 'NEGARA', atau 'KEMENTERIAN' (Kedinasan)
    is_negeri_guess = (
        (pt_upper in PTKIN_SET) or 
        ("NEGERI" in pt_upper) or 
        ("NEGARA" in pt_upper) or 
        ("KEMENTERIAN" in pt_upper)
    )

    # PTKIN: hanya jika ada di whitelist resmi (paling reliable)
    is_ptkin_guess = pt_upper in PTKIN_SET

    # DIKTI/DIKTIS: tetap gunakan heuristik nama
    is_diktis_val = is_diktis(pt_name)

    return {
        "ptn_pts": "PTN" if is_negeri_guess else "PTS",
        "ptkin_non": "PTKIN" if is_ptkin_guess else "NON PTKIN",
        "dikti_diktis": "DIKTIS" if is_diktis_val else "DIKTI",
    }


def is_diktis(pt_name: str, pembina: str = "", kelompok: str = "") -> bool:
    """
    Menentukan apakah sebuah Perguruan Tinggi berada di bawah naungan DIKTIS (Kemenag).

    Digunakan sebagai FALLBACK saat classify_from_pembina() gagal
    (pembina kosong / tidak dikenali).

    Strategi (3 Lapis):
      Layer 1: Exact-match PTKIN_SET (whitelist statis + hasil auto-refresh saat startup)
      Layer 2: Keyword substring pada nama kampus (UIN, IAIN, STAI, dll.)
      Layer 3: Keyword kolom 'pembina'/'kelompok' dari PDDikti API
    """
    pt_upper = pt_name.upper().strip()
    pembina_upper = pembina.upper().strip()
    kelompok_upper = kelompok.upper().strip()

    # --- Layer 1: Exact match whitelist (statis + auto-refreshed) ---
    if pt_upper in PTKIN_SET:
        return True

    # --- Layer 2: Keyword pada nama kampus ---
    if any(kw in pt_upper for kw in DIKTIS_NAME_KEYWORDS):
        return True

    # --- Layer 3: Keyword pada pembina/kelompok dari PDDikti API ---
    if any(kw in pembina_upper for kw in DIKTIS_PEMBINA_KEYWORDS):
        return True
    if any(kw in kelompok_upper for kw in DIKTIS_PEMBINA_KEYWORDS):
        return True

    return False

