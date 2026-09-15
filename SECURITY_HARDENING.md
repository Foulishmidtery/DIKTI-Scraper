# Implementasi Security Hardening PDDIKTI Scraper

## Arsitektur final

```text
Electron renderer
  -> preload allowlist + token lokal per-launch
  -> Flask 127.0.0.1 (scraper/worker, session key di RAM)
  -> HTTPS + timestamp + nonce + request ID + HMAC
  -> Vercel Secure Gateway
  -> PostgreSQL role pddikti_gateway
```

Electron dan Flask yang dibundel tidak menerima `DATABASE_URL`, username, atau password PostgreSQL production. Gateway menjalankan query terparameterisasi dan hanya mengembalikan hasil bisnis.

## Hasil audit dan perubahan

| Temuan | Risiko | Solusi konkret | File |
|---|---|---|---|
| Endpoint lama mengirim `database_url` ke desktop | Kritis | Endpoint lama `410`; query dipindah server-side | `secure-gateway/api` |
| Token permanen direncanakan berada di EXE | Tinggi | Aktivasi operator menghasilkan session key singkat di RAM | `api/session.ts`, `backend/secure_gateway.py` |
| Request dapat direplay | Tinggi | HMAC method/path/body, timestamp, nonce, request ID dan unique constraint | `api/_lib/auth.ts`, SQL gateway |
| `.env` dan log dibuat di PC penerima | Tinggi | Production tidak membuat `.env`/log; runtime diarahkan ke OS temp dan dibersihkan | `electron/main.cjs` |
| Backend localhost tanpa auth | Tinggi | Token lokal acak 256-bit per launch | `main.cjs`, `preload.cjs`, `backend/app.py` |
| Renderer dapat meminta URL bebas | Tinggi | Preload allowlist method/path, batas payload/file, redirect ditolak | `preload.cjs` |
| DevTools/debug/navigasi terbuka | Sedang | Ditutup pada production melalui window policy dan Electron fuses | `main.cjs`, `package.json` |
| Source Electron mudah dibaca | Sedang | Bundle/minify tanpa source map; hanya hasil build masuk ASAR | `vite.config.ts`, `build-main.cjs` |
| Backend resource dapat diganti | Tinggi | SHA-256 manifest + ASAR integrity + only-load-ASAR | `main.cjs`, `build-portable.ps1` |
| Role DB terlalu luas | Kritis | Role runtime tanpa superuser/create/drop dan grant tabel minimum | `integration/01_gateway_security.sql` |
| Error/log membuka detail internal | Sedang | Error generik, tanpa logging secret/stack trace production | backend dan handler gateway |

Minification/ASAR bukan kontrol utama. Obfuscation agresif sengaja tidak dipakai karena rawan merusak Electron dan memberi rasa aman palsu; tidak ada secret production di JavaScript/Python client.

## Bootstrap dan session

1. EXE memverifikasi manifest backend dan ASAR integrity.
2. Domain HTTPS dibaca dari public trust anchor `frontend/electron/runtime-config.cjs`.
3. TLS divalidasi Node/Python; HTTP hanya boleh untuk localhost development.
4. Operator memasukkan kode aktivasi; hanya hash-nya berada di Vercel.
5. Gateway mengeluarkan session ID/key sementara yang terikat pada instance aplikasi.
6. Server memeriksa expiry, timestamp, nonce, request ID, signature, ukuran dan schema setiap request.
7. Session diperbarui sebelum expiry dan direvoke saat aplikasi ditutup; shutdown paksa tetap dibatasi expiry.

Batch persistence memakai `operation_id`, sehingga retry tidak menggandakan counter. Deduplikasi data tetap berdasarkan `source_key` unik yang dihitung server.

## Development

PostgreSQL lokal tetap didukung melalui `production/.env.example`:

```env
PDDIKTI_SECURE_GATEWAY=0
DATABASE_URL=postgresql+psycopg://pddikti_app:...@127.0.0.1:5432/pddikti
```

Untuk gateway lokal saja:

```env
PDDIKTI_SECURE_GATEWAY=1
PDDIKTI_GATEWAY_URL=http://127.0.0.1:3000
PDDIKTI_ALLOW_INSECURE_GATEWAY=1
```

DevTools hanya tersedia ketika Electron tidak packaged.

## Production Vercel

Atur env server-side, tanpa prefix `VITE_`:

- `DATABASE_URL`: role `pddikti_gateway`, URL `postgresql://`, TLS aktif.
- `POSTGRES_CA_CERT`: opsional untuk CA privat.
- `SESSION_MASTER_KEY`: minimal 32 byte acak; hanya server.
- `DESKTOP_ACTIVATION_CODE_SHA256`: SHA-256 hex kode aktivasi.
- `ALLOWED_DESKTOP_VERSION`: contoh `2.0.0`.
- `SESSION_TTL_SECONDS`: default 2700, batas 300–7200.
- `REQUEST_CLOCK_SKEW_SECONDS`: default 60.
- `MAX_REQUEST_BYTES`: default 1048576.
- `SESSION_RATE_LIMIT_MAX`, `GATEWAY_RATE_LIMIT_MAX`.

Aktifkan Vercel Firewall/WAF sebagai rate-limit terdistribusi. Rate limiter database di source adalah defense-in-depth.

Sebelum build, ubah public trust anchor:

```js
// production/frontend/electron/runtime-config.cjs
gatewayUrl: "https://DOMAIN-GATEWAY-ANDA.vercel.app"
```

Perubahan koneksi PostgreSQL berikutnya cukup melalui env server + redeploy gateway; EXE tidak perlu dibuat ulang selama domain tetap sama.

## Database dan network

1. Jalankan schema aplikasi, lalu `secure-gateway/integration/01_gateway_security.sql` sebagai admin.
2. SQL membuat role `NOLOGIN`; aktifkan password melalui kanal admin aman.
3. Vercel memakai role `pddikti_gateway`, bukan `postgres`, owner, atau migrator.
4. Batasi port 5432 ke private network/backend/provider allowlist; jangan `0.0.0.0/0`.
5. Cleanup session/nonce/rate-limit dijalankan role admin, bukan runtime.

Revoke/rotasi tanpa rebuild EXE:

```sql
UPDATE gateway_sessions SET revoked_at = NOW() WHERE id = '<SESSION_ID>';
```

Ubah `DESKTOP_ACTIVATION_CODE_SHA256` untuk rotasi kode. Ubah `SESSION_MASTER_KEY` dan revoke session aktif untuk memutus seluruh sesi.

## Build dan signing

Python dipaketkan PyInstaller; build ditolak bila `.py` mentah ditemukan. Electron hanya membawa bundle minified, ASAR, manifest dan binary backend.

```powershell
cd D:\Coding\Magang_Kemenkeu\PDDIKTI-Scraper-V2\production
$env:CSC_LINK='PATH_ATAU_BASE64_CERTIFICATE'
$env:CSC_KEY_PASSWORD='PASSWORD_DARI_SECRET_STORE_CI'
.\build-portable.ps1
```

Signing credential tidak disimpan di repository. Test lokal unsigned: `.\build-portable.ps1 -UnsignedTest`. Artifact unsigned tidak boleh menjadi release production.

## Verifikasi

```powershell
cd production\secure-gateway
npm ci
npm run typecheck
npm run build
npm audit

cd ..\frontend
npm ci
npm run typecheck
npm run build
```

Uji: kode salah ditolak; kode benar membuat sesi; timestamp lama/signature salah/nonce sama ditolak; scraping tetap berjalan ketika pindah tab; duplikat tidak bertambah; history/analitik dari DB; export hanya setelah aksi pengguna; aplikasi ditutup lalu session revoked/expired dan folder `pddikti-runtime-*` dibersihkan.

Electron portable/Windows masih dapat membuat extraction sementara, Prefetch, catatan antivirus atau network history OS. Itu di luar kontrol aplikasi dan tidak berisi credential PostgreSQL. Cache Chromium, session, crash dump, output sementara dan log aplikasi diarahkan ke folder temp random dan dihapus saat shutdown normal. Excel hasil download adalah artefak yang memang diminta pengguna.

Pengguna dengan akses penuh tetap dapat menganalisis memory/session sementara. Dampaknya dibatasi TLS, expiry, revocation, HMAC, anti-replay, authorization gateway, dan role DB least-privilege.
