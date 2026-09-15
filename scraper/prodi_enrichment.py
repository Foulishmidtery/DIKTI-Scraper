"""Best-effort enrichment for program-study accreditation from public SAPTO data."""

from __future__ import annotations

import html
import re
import ssl
import threading
import time
from datetime import datetime, timezone
from typing import Any

import requests
from requests.adapters import HTTPAdapter


SAPTO_BASE_URL = "https://sapto2.banpt.or.id"
SAPTO_TIMEOUT = 15
SAPTO_CACHE_TTL = 1800
BIANGLALA_BASE_URL = "https://service.banpt.or.id/banpt2024/bianglala"
BIANGLALA_TIMEOUT = 8

# SAPTO currently omits this intermediate certificate from its TLS handshake.
# This is the official Sectigo intermediate named by the server certificate AIA.
_SECTIGO_DV_R36 = """-----BEGIN CERTIFICATE-----
MIIGTDCCBDSgAwIBAgIQOXpmzCdWNi4NqofKbqvjsTANBgkqhkiG9w0BAQwFADBf
MQswCQYDVQQGEwJHQjEYMBYGA1UEChMPU2VjdGlnbyBMaW1pdGVkMTYwNAYDVQQD
Ey1TZWN0aWdvIFB1YmxpYyBTZXJ2ZXIgQXV0aGVudGljYXRpb24gUm9vdCBSNDYw
HhcNMjEwMzIyMDAwMDAwWhcNMzYwMzIxMjM1OTU5WjBgMQswCQYDVQQGEwJHQjEY
MBYGA1UEChMPU2VjdGlnbyBMaW1pdGVkMTcwNQYDVQQDEy5TZWN0aWdvIFB1Ymxp
YyBTZXJ2ZXIgQXV0aGVudGljYXRpb24gQ0EgRFYgUjM2MIIBojANBgkqhkiG9w0B
AQEFAAOCAY8AMIIBigKCAYEAljZf2HIz7+SPUPQCQObZYcrxLTHYdf1ZtMRe7Yeq
RPSwygz16qJ9cAWtWNTcuICc++p8Dct7zNGxCpqmEtqifO7NvuB5dEVexXn9RFFH
12Hm+NtPRQgXIFjx6MSJcNWuVO3XGE57L1mHlcQYj+g4hny90aFh2SCZCDEVkAja
EMMfYPKuCjHuuF+bzHFb/9gV8P9+ekcHENF2nR1efGWSKwnfG5RawlkaQDpRtZTm
M64TIsv/r7cyFO4nSjs1jLdXYdz5q3a4L0NoabZfbdxVb+CUEHfB0bpulZQtH1Rv
38e/lIdP7OTTIlZh6OYL6NhxP8So0/sht/4J9mqIGxRFc0/pC8suja+wcIUna0HB
pXKfXTKpzgis+zmXDL06ASJf5E4A2/m+Hp6b84sfPAwQ766rI65mh50S0Di9E3Pn
2WcaJc+PILsBmYpgtmgWTR9eV9otfKRUBfzHUHcVgarub/XluEpRlTtZudU5xbFN
xx/DgMrXLUAPaI60fZ6wA+PTAgMBAAGjggGBMIIBfTAfBgNVHSMEGDAWgBRWc1hk
lfmSGrASKgRieaFAFYghSTAdBgNVHQ4EFgQUaMASFhgOr872h6YyV6NGUV3LBycw
DgYDVR0PAQH/BAQDAgGGMBIGA1UdEwEB/wQIMAYBAf8CAQAwHQYDVR0lBBYwFAYI
KwYBBQUHAwEGCCsGAQUFBwMCMBsGA1UdIAQUMBIwBgYEVR0gADAIBgZngQwBAgEw
VAYDVR0fBE0wSzBJoEegRYZDaHR0cDovL2NybC5zZWN0aWdvLmNvbS9TZWN0aWdv
UHVibGljU2VydmVyQXV0aGVudGljYXRpb25Sb290UjQ2LmNybDCBhAYIKwYBBQUH
AQEEeDB2ME8GCCsGAQUFBzAChkNodHRwOi8vY3J0LnNlY3RpZ28uY29tL1NlY3Rp
Z29QdWJsaWNTZXJ2ZXJBdXRoZW50aWNhdGlvblJvb3RSNDYucDdjMCMGCCsGAQUF
BzABhhdodHRwOi8vb2NzcC5zZWN0aWdvLmNvbTANBgkqhkiG9w0BAQwFAAOCAgEA
YtOC9Fy+TqECFw40IospI92kLGgoSZGPOSQXMBqmsGWZUQ7rux7cj1du6d9rD6C8
ze1B2eQjkrGkIL/OF1s7vSmgYVafsRoZd/IHUrkoQvX8FZwUsmPu7amgBfaY3g+d
q1x0jNGKb6I6Bzdl6LgMD9qxp+3i7GQOnd9J8LFSietY6Z4jUBzVoOoz8iAU84OF
h2HhAuiPw1ai0VnY38RTI+8kepGWVfGxfBWzwH9uIjeooIeaosVFvE8cmYUB4TSH
5dUyD0jHct2+8ceKEtIoFU/FfHq/mDaVnvcDCZXtIgitdMFQdMZaVehmObyhRdDD
4NQCs0gaI9AAgFj4L9QtkARzhQLNyRf87Kln+YU0lgCGr9HLg3rGO8q+Y4ppLsOd
unQZ6ZxPNGIfOApbPVf5hCe58EZwiWdHIMn9lPP6+F404y8NNugbQixBber+x536
WrZhFZLjEkhp7fFXf9r32rNPfb74X/U90Bdy4lzp3+X1ukh1BuMxA/EEhDoTOS3l
7ABvc7BYSQubQ2490OcdkIzUh3ZwDrakMVrbaTxUM2p24N6dB+ns2zptWCva6jzW
r8IWKIMxzxLPv5Kt3ePKcUdvkBU/smqujSczTzzSjIoR5QqQA6lN1ZRSnuHIWCvh
JEltkYnTAH41QJ6SAWO66GrrUESwN/cgZzL4JLEqz1Y=
-----END CERTIFICATE-----"""


class _StrictSaptoTlsAdapter(HTTPAdapter):
    def init_poolmanager(self, *args: Any, **kwargs: Any) -> None:
        context = ssl.create_default_context()
        context.load_verify_locations(cadata=_SECTIGO_DV_R36)
        kwargs["ssl_context"] = context
        super().init_poolmanager(*args, **kwargs)


_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_history_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}
_pt_choice_cache: dict[str, tuple[float, str]] = {}
_cache_lock = threading.Lock()
_key_locks: dict[str, threading.Lock] = {}


def _normalize(value: Any) -> str:
    text = str(value or "").upper()
    text = re.sub(r"[`'‘’‚‛“”]", "", text)
    return " ".join(text.split())


def _plain(value: str) -> str:
    return " ".join(html.unescape(re.sub(r"<[^>]+>", " ", value)).split())


def _session() -> requests.Session:
    session = requests.Session()
    session.mount(SAPTO_BASE_URL, _StrictSaptoTlsAdapter(max_retries=1))
    session.mount(BIANGLALA_BASE_URL, _StrictSaptoTlsAdapter(max_retries=0))
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "text/html,application/json",
        "Referer": f"{SAPTO_BASE_URL}/",
    })
    return session


def _coded_label(value: Any) -> tuple[str, str]:
    match = re.match(r"^\s*([A-Za-z0-9]+)\s+-\s+(.+?)\s*$", str(value or ""))
    return (match.group(1), match.group(2)) if match else ("", str(value or "").strip())


def _bianglala_pt_choice(session: requests.Session, pt_name: str, kode_pt: str) -> str:
    key = f"{_normalize(pt_name)}|{kode_pt}"
    now = time.time()
    with _cache_lock:
        cached = _pt_choice_cache.get(key)
        if cached and now - cached[0] < (SAPTO_CACHE_TTL if cached[1] else 120):
            return cached[1]
    response = session.get(
        f"{BIANGLALA_BASE_URL}/searchPT.php",
        params={"term": pt_name}, timeout=BIANGLALA_TIMEOUT,
    )
    response.raise_for_status()
    choices = response.json()
    if not isinstance(choices, list):
        return ""
    matches = [item for item in choices if isinstance(item, str)
               and _normalize(_coded_label(item)[1]) == _normalize(pt_name)
               and (not kode_pt or _coded_label(item)[0] == kode_pt)]
    result = matches[0] if len(matches) == 1 else ""
    with _cache_lock:
        _pt_choice_cache[key] = (now, result)
    return result


def _fetch_bianglala_history(prodi: dict[str, Any]) -> list[dict[str, Any]]:
    pt_name = str(prodi.get("pt", "")).strip()
    expected_name = _normalize(f"{prodi.get('jenjang', '')} {prodi.get('nama', '')}")
    kode_pt = str(prodi.get("kode_pt", "")).strip()
    kode_prodi = str(prodi.get("kode_prodi", "")).strip()
    if not pt_name or not expected_name:
        return []
    key = f"{_normalize(pt_name)}|{expected_name}|{kode_pt}|{kode_prodi}"
    now = time.time()
    with _cache_lock:
        cached = _history_cache.get(key)
        if cached and now - cached[0] < (SAPTO_CACHE_TTL if cached[1] else 120):
            return cached[1]
        key_lock = _key_locks.setdefault(f"history:{key}", threading.Lock())
    with key_lock:
        with _cache_lock:
            cached = _history_cache.get(key)
            if cached and time.time() - cached[0] < (SAPTO_CACHE_TTL if cached[1] else 120):
                return cached[1]
        result: list[dict[str, Any]] = []
        try:
            with _session() as session:
                pt_choice = _bianglala_pt_choice(session, pt_name, kode_pt)
                if pt_choice:
                    choices_response = session.get(
                        f"{BIANGLALA_BASE_URL}/searchPS.php",
                        params={"term": str(prodi.get("nama", "")), "pt": pt_choice},
                        timeout=BIANGLALA_TIMEOUT,
                    )
                    choices_response.raise_for_status()
                    choices = choices_response.json()
                    if isinstance(choices, list):
                        matches = [item for item in choices if isinstance(item, str)
                                   and _normalize(_coded_label(item)[1]) == expected_name
                                   and (not kode_prodi or _coded_label(item)[0] == kode_prodi)]
                        if len(matches) == 1:
                            history_response = session.get(
                                f"{BIANGLALA_BASE_URL}/riakps.php",
                                params={"pt": pt_choice, "ps": matches[0]},
                                timeout=BIANGLALA_TIMEOUT,
                            )
                            history_response.raise_for_status()
                            rows = history_response.json()
                            if isinstance(rows, list):
                                for row in rows:
                                    if not isinstance(row, list) or len(row) < 7:
                                        continue
                                    if (_normalize(row[0]) != _normalize(pt_name)
                                            or _normalize(f"{row[2]} {row[1]}") != expected_name
                                            or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(row[3]))):
                                        continue
                                    result.append({
                                        "tanggal_sk": str(row[3]),
                                        "peringkat": str(row[4] or "").strip(),
                                        "berlaku_sampai": str(row[5] or "").strip(),
                                        "status_berlaku_sk": "Berlaku" if str(row[6]).strip().lower() == "ya" else "Tidak berlaku",
                                        "sumber": "BAN-PT Bianglala",
                                    })
        except (requests.RequestException, ValueError, TypeError, IndexError):
            pass
        result.sort(key=lambda item: item["tanggal_sk"])
        with _cache_lock:
            _history_cache[key] = (time.time(), result)
        return result


def _date_key(value: Any) -> str:
    text = str(value or "").strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        return text
    months = {name: index for index, name in enumerate(
        ["januari", "februari", "maret", "april", "mei", "juni", "juli", "agustus",
         "september", "oktober", "november", "desember"], 1)}
    parts = text.lower().split()
    if len(parts) == 3 and parts[0].isdigit() and parts[1] in months and parts[2].isdigit():
        return f"{int(parts[2]):04d}-{months[parts[1]]:02d}-{int(parts[0]):02d}"
    return ""


def _parse_programs(page: str) -> list[dict[str, str]]:
    programs: list[dict[str, str]] = []
    for row in re.findall(r"<tr\b[^>]*>(.*?)</tr>", page, flags=re.IGNORECASE | re.DOTALL):
        code_match = re.search(r"<small\b[^>]*>(.*?)</small>", row, flags=re.IGNORECASE | re.DOTALL)
        name_match = re.search(r"<h6\b[^>]*>.*?<a\b([^>]*)>(.*?)</a>", row, flags=re.IGNORECASE | re.DOTALL)
        rank_match = re.search(r"<div\b[^>]*class=\"[^\"]*btn-info[^\"]*\"[^>]*>(.*?)</div>", row, flags=re.IGNORECASE | re.DOTALL)
        expiry_match = re.search(r"Hingga\s*:\s*<span\b[^>]*>(.*?)</span>", row, flags=re.IGNORECASE | re.DOTALL)
        if not code_match or not name_match:
            continue
        programs.append({
            "kode_prodi": _plain(code_match.group(1)),
            "nama_prodi": _plain(name_match.group(2)),
            "peringkat": _plain(rank_match.group(1)) if rank_match else "",
            "berlaku_sampai": _plain(expiry_match.group(1)) if expiry_match else "",
            "url_sk": _official_sk_url(name_match.group(1)),
        })
    return programs


def _official_sk_url(anchor_attributes: str) -> str:
    href = re.search(r"\bhref\s*=\s*['\"]([^'\"]+)['\"]", anchor_attributes, re.IGNORECASE)
    if not href:
        return ""
    path = html.unescape(href.group(1)).strip()
    if re.fullmatch(r"/sk/prodi/\d+", path):
        return f"{SAPTO_BASE_URL}{path}"
    if re.fullmatch(r"https://sapto2\.banpt\.or\.id/sk/prodi/\d+", path):
        return path
    return ""


def _fetch_verified_sk(prodi: dict[str, Any], program: dict[str, str]) -> dict[str, str]:
    url = program.get("url_sk", "")
    if not url:
        return {}
    try:
        with _session() as session:
            response = session.get(url, timeout=BIANGLALA_TIMEOUT)
            response.raise_for_status()
        page = re.sub(r"<!--.*?-->", "", response.text, flags=re.DOTALL)
        fields: dict[str, str] = {}
        for label, key in (
            ("Nomor SK", "nomor_sk"), ("Tanggal SK", "tanggal_sk"),
            ("Berlaku sampai", "berlaku_sampai"), ("Nama PT", "pt"),
            ("Nama Prodi", "nama_prodi"), ("Peringkat", "peringkat"),
        ):
            found = re.search(rf"{re.escape(label)}\s*:\s*<span\b[^>]*>(.*?)</span>", page, re.IGNORECASE | re.DOTALL)
            if found:
                fields[key] = _plain(found.group(1))
        if (_normalize(fields.get("pt")) != _normalize(prodi.get("pt"))
                or _normalize(fields.get("nama_prodi")) != _normalize(prodi.get("nama"))
                or _normalize(fields.get("peringkat")) != _normalize(program.get("peringkat"))
                or _date_key(fields.get("berlaku_sampai")) != _date_key(program.get("berlaku_sampai"))):
            return {}
        fields["url_sk"] = url
        return fields
    except requests.RequestException:
        return {}


def _fetch_pt_programs(pt_name: str) -> dict[str, Any]:
    key = _normalize(pt_name)
    now = time.time()
    with _cache_lock:
        cached = _cache.get(key)
        if cached and now - cached[0] < SAPTO_CACHE_TTL:
            return cached[1]
        key_lock = _key_locks.setdefault(key, threading.Lock())

    # Prodi dari PT yang sama berbagi satu pencarian SAPTO, sedangkan PT lain
    # tetap dapat diproses paralel.
    with key_lock:
        now = time.time()
        with _cache_lock:
            cached = _cache.get(key)
            if cached and now - cached[0] < SAPTO_CACHE_TTL:
                return cached[1]

        result: dict[str, Any] = {"programs": [], "source_url": "", "status": "tidak ditemukan"}
        try:
            with _session() as session:
                landing = session.get(f"{SAPTO_BASE_URL}/", timeout=SAPTO_TIMEOUT)
                landing.raise_for_status()
                csrf_match = re.search(r'name="_csrf_sapto"\s+value="([^"]+)"', landing.text)
                if not csrf_match:
                    raise ValueError("csrf tidak tersedia")
                response = session.post(
                    f"{SAPTO_BASE_URL}/beranda/data_pt",
                    data={"q": pt_name, "key": csrf_match.group(1)},
                    timeout=SAPTO_TIMEOUT,
                )
                response.raise_for_status()
                candidates = response.json().get("pt", [])
                match = next((item for item in candidates if _normalize(item.get("nama")) == key), None)
                if match and isinstance(match.get("kode"), str):
                    source_url = f"{SAPTO_BASE_URL}/beranda/detail_pt/{match['kode']}"
                    detail = session.get(source_url, timeout=SAPTO_TIMEOUT)
                    detail.raise_for_status()
                    result = {"programs": _parse_programs(detail.text), "source_url": source_url, "status": "tersedia"}
        except (requests.RequestException, ValueError, TypeError):
            result["status"] = "sumber sementara tidak tersedia"

        with _cache_lock:
            _cache[key] = (now, result)
        return result


def enrich_banpt(prodi: dict[str, Any]) -> dict[str, Any]:
    """Return verified accreditation fields without failing the main scraper."""
    checked_at = datetime.now(timezone.utc).isoformat()
    pt_data = _fetch_pt_programs(str(prodi.get("pt", "")))
    code = str(prodi.get("kode_prodi", "")).strip()
    expected_name = _normalize(f"{prodi.get('jenjang', '')} {prodi.get('nama', '')}")
    matches = [item for item in pt_data["programs"]
               if _normalize(item["nama_prodi"]) == expected_name
               and (not code or item["kode_prodi"] == code)]
    match = matches[0] if len(matches) == 1 else None
    sk_detail = _fetch_verified_sk(prodi, match) if match else {}
    history = _fetch_bianglala_history(prodi)
    current = next((item for item in reversed(history) if item["status_berlaku_sk"] == "Berlaku"), None)
    sources_agree = bool(match and current
                         and _normalize(match["peringkat"]) == _normalize(current["peringkat"])
                         and _date_key(match["berlaku_sampai"]) == _date_key(current["berlaku_sampai"]))
    use_history_current = bool(current and (not match or sources_agree))
    return {
        "peringkat_akreditasi_banpt": match["peringkat"] if match else current["peringkat"] if use_history_current else "",
        "nomor_sk_akreditasi": sk_detail.get("nomor_sk", ""),
        "tanggal_sk_akreditasi": sk_detail.get("tanggal_sk", "") or (current["tanggal_sk"] if use_history_current else ""),
        "tanggal_akhir_akreditasi": match["berlaku_sampai"] if match else current["berlaku_sampai"] if use_history_current else "",
        "status_berlaku_sk_akreditasi": (current["status_berlaku_sk"] if use_history_current else "") or ("Berlaku" if sk_detail else ""),
        "riwayat_akreditasi_banpt": history,
        "status_pencocokan_akreditasi": (
            "sumber BAN-PT berbeda" if match and current and not sources_agree
            else "terverifikasi" if match or use_history_current else pt_data["status"]
        ),
        "sumber_akreditasi": "SAPTO BAN-PT",
        "url_sumber_akreditasi": pt_data["source_url"],
        "url_riwayat_akreditasi": f"{BIANGLALA_BASE_URL}/" if history else "",
        "url_sk_akreditasi": sk_detail.get("url_sk", ""),
        "akreditasi_diperiksa_pada": checked_at,
    }
