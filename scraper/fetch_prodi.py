"""
fetch_prodi.py — Ambil daftar semua prodi dari PDDikti berdasarkan bidang ilmu.

Fitur:
  • Retry otomatis + backoff (menyamakan pattern dengan dosen_scraper.py)
  • Support stop_event untuk cancellation
  • Deduplikasi prodi berdasarkan nama
"""

import os
import time
import json
import requests

BIDANG_ILMU = [
    "Agama", "Ekonomi", "Humaniora", "Kesehatan",
    "MIPA", "Pendidikan", "Pertanian", "Seni", "Sosial", "Teknik"
]

HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Origin": "https://pddikti.kemdiktisaintek.go.id",
    "Referer": "https://pddikti.kemdiktisaintek.go.id/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
}

TIMEOUT = int(os.environ.get("PDDIKTI_TIMEOUT", 30))
MAX_RETRIES = max(1, int(os.environ.get("PDDIKTI_MAX_RETRIES", 3)))
RETRY_DELAY = int(os.environ.get("PDDIKTI_RETRY_DELAY", 2))


def _sleep(seconds, stop_event=None):
    """Interruptible sleep yang respect stop_event."""
    if stop_event:
        stop_event.wait(seconds)
    else:
        time.sleep(seconds)


def _normalize_api_payload(payload, bidang):
    """Ubah berbagai bentuk respons API menjadi list[dict].

    API PDDIKTI pernah mengembalikan list langsung dan pada versi lain
    membungkus data di dalam object seperti {"data": [...]}. Fungsi ini
    menjaga scraper tetap kompatibel dengan kedua bentuk tersebut.
    """
    # Beberapa gateway dapat mengembalikan JSON sebagai string JSON.
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError as exc:
            raise ValueError(
                f"Respons API bidang {bidang} berupa string, bukan JSON terstruktur: "
                f"{payload[:120]!r}"
            ) from exc

    if isinstance(payload, list):
        items = payload
    elif isinstance(payload, dict):
        items = None

        # Bentuk yang paling umum: {"data": [...]}
        for key in ("data", "results", "result", "items", "prodi"):
            candidate = payload.get(key)
            if isinstance(candidate, list):
                items = candidate
                break

            # Antisipasi wrapper bertingkat, mis. {"data": {"items": [...]}}
            if isinstance(candidate, dict):
                for nested_key in ("data", "results", "items", "prodi"):
                    nested = candidate.get(nested_key)
                    if isinstance(nested, list):
                        items = nested
                        break
                if items is not None:
                    break

        if items is None:
            raise ValueError(
                f"Format respons API bidang {bidang} tidak dikenali. "
                f"Keys: {list(payload.keys())}"
            )
    else:
        raise ValueError(
            f"Format respons API bidang {bidang} tidak valid: "
            f"{type(payload).__name__}"
        )

    # Jangan biarkan elemen string/null membuat .get() crash.
    return [item for item in items if isinstance(item, dict)]


def _fetch_bidang(bidang, stop_event=None):
    """Fetch 1 bidang dengan retry & backoff. Return list[dict] atau None."""
    url = f"https://api-pddikti.kemdiktisaintek.go.id/prodi/bidang-ilmu/{bidang}"
    last_err = None
    for attempt in range(MAX_RETRIES):
        if stop_event and stop_event.is_set():
            return None
        try:
            r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
            r.raise_for_status()
            return _normalize_api_payload(r.json(), bidang)
        except requests.exceptions.RequestException as e:
            last_err = e
            # Backoff lebih lama jika rate-limit 429
            if getattr(e, "response", None) is not None and e.response.status_code == 429:
                _sleep(5, stop_event)
            elif attempt < MAX_RETRIES - 1:
                _sleep(RETRY_DELAY * (attempt + 1), stop_event)
        except (ValueError, TypeError) as e:
            # Respons HTTP valid tetapi struktur JSON berubah/tidak sesuai.
            # Retry tidak banyak membantu; tampilkan error yang informatif.
            raise ValueError(f"Gagal membaca respons bidang {bidang}: {e}") from e

    # Gagal total setelah semua retry
    raise last_err if last_err else Exception(f"Gagal fetch bidang {bidang}")


def fetch_all_prodi(callback=None, stop_event=None):
    """
    Ambil daftar prodi unik dari semua bidang ilmu PDDikti.

    Args:
        callback: opsional, fungsi log(msg)
        stop_event: opsional, threading.Event untuk cancellation
    """
    all_data = []
    seen_prodi = set()

    def log(msg):
        if callback:
            try:
                callback(msg)
            except Exception:
                pass  # abaikan error logging

    for bidang in BIDANG_ILMU:
        if stop_event and stop_event.is_set():
            log("⏹️  Fetch prodi dibatalkan oleh pengguna.")
            break

        log(f"🔍 Mengambil bidang: {bidang}...")
        try:
            data = _fetch_bidang(bidang, stop_event=stop_event)
        except Exception as e:
            log(f"❌ Error {bidang}: {type(e).__name__}: {e}")
            continue

        if data is None:  # Dibatalkan di tengah
            break

        count_new = 0
        for item in data:
            nama = (item.get("nama_prodi") or item.get("nama") or "").strip()
            if not nama or nama in seen_prodi:
                continue
            seen_prodi.add(nama)
            all_data.append({
                "nama_prodi": nama,
                "total_mahasiswa": item.get("total_mahasiswa", item.get("jumlah_mahasiswa", 0)),
                "persentase_kelulusan": item.get("persentase_kelulusan", item.get("kelulusan", "0")),
                "bidang": bidang,
            })
            count_new += 1
        log(f"✅ {bidang}: {len(data)} data, {count_new} prodi baru.")

    all_data.sort(key=lambda x: x["nama_prodi"])
    log(f"📊 Total prodi unik: {len(all_data)}")
    return all_data



def _normalize_name(name):
    """Normalisasi ringan untuk pencocokan exact nama prodi katalog."""
    import re
    text = str(name or "").upper()
    text = re.sub(r"[`'\u2018\u2019\u201A\u201B\u201C\u201D]", "", text)
    return " ".join(text.split())


def fetch_target_prodi_catalog(target_names, callback=None, stop_event=None):
    """Sinkronisasi katalog hanya untuk daftar prodi target wajib.

    Endpoint bidang ilmu tetap dipakai sebagai sumber katalog, tetapi data yang
    disimpan hanya nama yang exact-match dengan target_names setelah normalisasi.
    Proses berhenti lebih cepat jika semua target sudah ditemukan.
    """
    targets = [str(x).strip() for x in target_names if str(x).strip()]
    target_by_norm = {_normalize_name(name): name for name in targets}
    remaining = set(target_by_norm)
    found = {}

    def log(msg):
        if callback:
            try:
                callback(msg)
            except Exception:
                pass

    log("🔄 Auto-katalog: sinkronisasi target prodi wajib dari PDDIKTI...")

    for bidang in BIDANG_ILMU:
        if stop_event and stop_event.is_set():
            raise Exception("Sinkronisasi katalog dihentikan oleh pengguna.")

        if not remaining:
            break

        log(f"   ↳ Memeriksa katalog bidang {bidang}...")
        try:
            data = _fetch_bidang(bidang, stop_event=stop_event)
        except Exception as exc:
            log(f"   ⚠️ Bidang {bidang} gagal dibaca: {type(exc).__name__}: {exc}")
            continue

        if data is None:
            break

        for item in data:
            nama = (item.get("nama_prodi") or item.get("nama") or "").strip()
            norm = _normalize_name(nama)
            if not norm or norm not in remaining:
                continue

            found[norm] = {
                "nama_prodi": nama,
                "target_name": target_by_norm[norm],
                "total_mahasiswa": item.get("total_mahasiswa", item.get("jumlah_mahasiswa", 0)),
                "persentase_kelulusan": item.get("persentase_kelulusan", item.get("kelulusan", "0")),
                "bidang": bidang,
            }
            remaining.discard(norm)

    ordered = []
    for target in targets:
        item = found.get(_normalize_name(target))
        if item:
            ordered.append(item)

    missing = [target_by_norm[norm] for norm in target_by_norm if norm not in found]
    log(f"✅ Auto-katalog selesai: {len(ordered)}/{len(targets)} target ditemukan di katalog.")
    if missing:
        log("⚠️ Target belum muncul di endpoint katalog: " + ", ".join(missing))
        log("   Scraper tetap akan mencari target wajib tersebut lewat endpoint pencarian prodi.")

    return ordered
