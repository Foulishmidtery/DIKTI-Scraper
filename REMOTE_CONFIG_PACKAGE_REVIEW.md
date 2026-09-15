# Review PDDIKTI Remote Config Package (DEPRECATED)

> Arsip review lama. Implementasi production yang berlaku ada di `SECURITY_HARDENING.md`.

Sumber yang diperiksa:

```text
C:\Users\jenki\Downloads\pddikti-remote-config-package\production\remote-config
```

Tanggal review: 10 September 2026.

## Kesimpulan

Struktur package sudah baik untuk prototype dan sudah mengikuti konsep utama:

- Vite + React + TypeScript terpisah;
- Vercel Functions berada di folder `api/`;
- secret tidak dimasukkan ke variable `VITE_*`;
- endpoint health tidak mengembalikan kredensial;
- endpoint desktop memakai Bearer token dan pemeriksaan versi;
- konfigurasi PostgreSQL diwajibkan memakai TLS;
- tersedia contoh integrasi Electron, Flask, dan role PostgreSQL.

Namun package **belum siap dianggap production**. Bagian `integration/` masih berupa contoh dan belum terpasang ke aplikasi PDDIKTI Scraper yang sebenarnya. Beberapa revisi keamanan dan reliability juga perlu dilakukan sebelum EXE didistribusikan.

## Revisi wajib sebelum production

| Prioritas | Masalah | Dampak | Revisi |
|---|---|---|---|
| Kritis | Integrasi Electron dan Flask masih berupa template | EXE saat ini tetap memakai `.env` lokal dan belum mengambil konfigurasi Vercel | Gabungkan template ke `production/frontend/electron/main.cjs`, `production/backend/config.py`, dan `production/backend/database.py` |
| Kritis | Satu shared token akan ditanam di semua EXE | Token dapat diekstrak dari binary dan dipakai untuk mengambil kredensial database | Gunakan login/token perangkat. Jika sementara memakai shared token, batasi role DB, aktifkan rate limit, dan siapkan rotasi cepat |
| Tinggi | PostgreSQL harus terbuka dari seluruh komputer pengguna | Database menjadi target langsung dari jaringan luar | Wajib TLS, firewall/VPN, role non-superuser, monitoring, dan pembatasan hak akses |
| Tinggi | Refresh Flask hanya membandingkan `CONFIG_VERSION` | Perubahan URL/password diabaikan jika admin lupa menaikkan versi | Bandingkan juga fingerprint SHA-256 dari `database_url` di memori |
| Tinggi | Kegagalan bootstrap pertama baru dicoba ulang sekitar 300 detik | Pengguna bisa menunggu lima menit setelah gangguan jaringan singkat | Gunakan retry awal 5, 10, 20, lalu maksimal 60 detik sampai konfigurasi pertama berhasil |
| Tinggi | Validasi URL PostgreSQL hanya kuat di sisi Vercel | Endpoint yang salah/terkompromi dapat mengarahkan Flask ke URL lain | Flask juga wajib memvalidasi scheme PostgreSQL dan `sslmode` sebelum membuat engine |
| Sedang | `package-lock.json` belum tersedia | Versi dependency dapat berubah antarmesin/deployment | Jalankan `npm install`, simpan `package-lock.json`, kemudian gunakan `npm ci` di CI |
| Sedang | `engines.node` menggunakan `>=22.12.0` | Vercel dapat memilih Node terbaru, bukan pasti Node 22 | Jika target pengujian Node 22, ubah menjadi `22.x`; jika memilih Node 24, uji dan tetapkan `24.x` |
| Sedang | Full `npm install` dan Vite build belum dijalankan pada package asal | Catatan validasi belum membuktikan bundle production berhasil | Jalankan install, typecheck, build, `vercel dev`, dan preview deployment |
| Sedang | SQL default privileges tidak menyebut role pemilik tabel | Tabel baru yang dibuat role lain mungkin tidak mewarisi grant | Gunakan `ALTER DEFAULT PRIVILEGES FOR ROLE <schema_owner>` atau migration khusus |

## Temuan keamanan

### 1. Shared token bukan perlindungan permanen

Contoh Electron memakai:

```text
PDDIKTI_CONFIG_TOKEN=GANTI_TOKEN_BUILD
```

Jika token diganti lalu dibundel ke EXE, pengguna yang memiliki binary tetap dapat mengekstraknya. HTTPS melindungi data saat transit, tetapi tidak membuat secret yang tertanam dalam aplikasi desktop menjadi rahasia permanen.

Pilihan production:

1. pengguna login dan memperoleh access token jangka pendek;
2. perangkat didaftarkan lalu memperoleh token per perangkat;
3. shared token hanya sebagai fase sementara dengan expiry, rate limit, dan rotasi rutin.

Jika tidak ingin menyimpan token di komputer, pengguna harus login setiap membuka aplikasi. Tanpa login dan tanpa penyimpanan lokal, satu-satunya pilihan praktis adalah secret yang tertanam di EXE, dengan risiko ekstraksi.

### 2. Direct PostgreSQL perlu batas jaringan

Karena Flask pada setiap PC terhubung langsung ke PostgreSQL, Vercel bukan firewall database. Gunakan salah satu:

- VPN/private network;
- database provider dengan TLS dan network restriction;
- IP allowlist jika alamat pengguna stabil;
- sebagai opsi paling aman, pindahkan operasi database ke API server.

Untuk production, utamakan `sslmode=verify-full`. `sslmode=require` mengenkripsi koneksi tetapi verifikasi identitas server lebih kuat dengan sertifikat yang benar.

### 3. Validasi URL harus dilakukan dua kali

`api/_lib/config.ts` perlu memastikan protocol hanya:

```text
postgresql+psycopg:
postgresql:
```

Validasi minimum:

- hostname wajib ada;
- nama database wajib ada;
- username dan password wajib ada;
- port harus integer `1-65535`;
- `sslmode` hanya `require`, `verify-ca`, atau `verify-full`;
- production sebaiknya menolak hostname loopback/private jika memang database harus online.

Validasi yang sama harus ada pada Flask sebelum `create_engine()`.

### 4. Urutan validasi endpoint

Saat ini endpoint memeriksa kelengkapan konfigurasi sebelum Authorization. Ubah agar response eksternal lebih konsisten:

1. pastikan server memiliki token;
2. periksa Bearer token;
3. periksa versi desktop;
4. baru baca dan validasi konfigurasi database;
5. kembalikan error generik tanpa detail internal.

Jangan mengembalikan stack trace, nama environment variable yang hilang, hostname, atau bagian connection string.

## Revisi Flask yang disarankan

### Bootstrap

1. Backend Flask mulai tanpa `.env` production.
2. UI boleh terbuka dalam status `Menyiapkan konfigurasi`.
3. Flask mengambil remote config melalui HTTPS.
4. Response divalidasi lengkap.
5. Engine baru dibuat dan diuji dengan `SELECT 1`.
6. Scraping baru diaktifkan setelah database ready.

### Retry awal

Gunakan pola:

```text
gagal pertama  → tunggu 5 detik
gagal kedua    → tunggu 10 detik
gagal ketiga   → tunggu 20 detik
berikutnya     → maksimal 60 detik
```

Setelah engine pertama berhasil, gunakan `CONFIG_REFRESH_SECONDS` normal.

### Deteksi perubahan

Jangan hanya menggunakan `config_version`. Simpan nilai berikut di RAM:

```text
config_version
sha256(database_url)
```

Reconfigure ketika salah satunya berubah. Jangan menuliskan hash atau URL ke log jika tidak diperlukan.

### Last-known-good

Jika refresh berikutnya gagal:

- pertahankan engine lama yang masih sehat;
- tampilkan warning pada health status;
- jangan mengganti engine dengan konfigurasi yang gagal;
- coba ulang tanpa menghentikan job yang sedang berjalan.

Jika engine lama juga tidak sehat, blokir job baru sampai koneksi pulih.

## Revisi Electron yang disarankan

Package ini belum mengubah Electron utama. Saat integrasi:

- hapus pembuatan `.env` pada `prepareDataFiles()`;
- jangan membuat `data/logs/desktop.log` dan `backend.log` pada mode no-local-trace;
- ubah `stdio` backend menjadi `ignore` atau simpan log ringkas hanya di RAM;
- gunakan Electron partition tanpa prefix `persist:`;
- arahkan cache/session ke temporary location bila diperlukan;
- jangan menyimpan response config di localStorage;
- jangan membuat export Excel otomatis setelah scraping;
- tampilkan dialog lokasi hanya ketika pengguna menekan tombol Export;
- tetap pertahankan splash screen saat remote config sedang diambil.

Perlu dipahami: portable Electron tetap dapat diekstrak sementara oleh Windows dan sistem operasi dapat membuat Prefetch, antivirus history, crash dump, atau network log. Target realistisnya adalah tidak membuat `.env`, folder data, dan log permanen milik aplikasi.

## Revisi PostgreSQL

Role `pddikti_desktop` sudah tidak diberi superuser, tetapi production perlu memastikan:

1. schema dan tabel dibuat melalui migration/admin sebelum aplikasi dipakai;
2. aplikasi tidak diberi hak `CREATE`, `DROP`, atau `TRUNCATE`;
3. `ALTER DEFAULT PRIVILEGES` dijalankan untuk role pemilik schema yang benar;
4. koneksi wajib TLS;
5. password testing tidak dipakai di production;
6. koneksi gagal dan aktivitas abnormal dimonitor;
7. backup dan recovery database sudah diuji.

Contoh pola default privileges:

```sql
ALTER DEFAULT PRIVILEGES FOR ROLE pddikti_owner IN SCHEMA public
GRANT SELECT, INSERT, UPDATE ON TABLES TO pddikti_desktop;

ALTER DEFAULT PRIVILEGES FOR ROLE pddikti_owner IN SCHEMA public
GRANT USAGE, SELECT ON SEQUENCES TO pddikti_desktop;
```

Ganti `pddikti_owner` dengan role yang benar-benar membuat tabel.

## Revisi deployment

Saat membuat project Vercel, tetapkan **Root Directory** ke:

```text
production/remote-config
```

Jika folder `remote-config` di-upload sebagai repository tersendiri, Root Directory cukup `.`.

Pilih versi Node secara eksplisit. Vercel saat ini menyediakan major Node 20, 22, dan 24; range `>=22.12.0` dapat dipetakan ke versi terbaru. Gunakan versi yang benar-benar diuji.

Setelah `npm install`, commit file lock dan validasi:

```powershell
npm ci
npm run typecheck
npm run build
npx vercel dev
```

Kemudian deploy preview dan uji:

- health tidak mengandung database URL;
- token salah menghasilkan `401`;
- versi salah menghasilkan `426`;
- URL tanpa TLS ditolak;
- method selain GET menghasilkan `405`;
- response config memakai `Cache-Control: no-store`;
- secret tidak muncul di browser bundle atau Vercel log;
- perubahan konfigurasi diterima setelah environment diperbarui dan deployment baru aktif.

Vercel Environment Variables hanya diterapkan pada deployment baru. Polling dari EXE tidak akan melihat perubahan environment sampai project di-redeploy.

## Konfigurasi awal yang disarankan

```env
DATABASE_URL=postgresql+psycopg://ROLE_TERBATAS:PASSWORD_URL_ENCODED@HOST:5432/pddikti?sslmode=verify-full
DESKTOP_CONFIG_TOKEN=TOKEN_RANDOM_MINIMAL_32_BYTES
CONFIG_VERSION=1
CONFIG_REFRESH_SECONDS=300
ALLOWED_DESKTOP_VERSION=2.0.0
```

Jangan memasukkan nilai production ke `.env.example`, repository Git, screenshot, atau prompt AI.

## Checklist kelulusan production

- [ ] `package-lock.json` tersedia.
- [ ] Node major version ditetapkan dan diuji.
- [ ] `npm ci`, typecheck, dan build berhasil.
- [ ] Preview Vercel berhasil.
- [ ] Vercel Root Directory benar.
- [ ] Tidak ada secret `VITE_*`.
- [ ] Scheme dan TLS URL divalidasi di Vercel serta Flask.
- [ ] Endpoint memakai token dan rate limiting/firewall.
- [ ] Strategi token perangkat/login sudah dipilih.
- [ ] Fast retry bootstrap sudah diterapkan.
- [ ] Fingerprint URL ikut dibandingkan saat refresh.
- [ ] Last-known-good engine dipertahankan.
- [ ] Template Electron sudah benar-benar digabung ke aplikasi utama.
- [ ] Template Flask sudah benar-benar digabung ke aplikasi utama.
- [ ] `.env` dan log lokal tidak dibuat pada production mode.
- [ ] Export otomatis sudah dinonaktifkan jika targetnya tanpa file lokal.
- [ ] Role PostgreSQL dan default privileges sudah diverifikasi.
- [ ] TLS, firewall/VPN, backup, dan monitoring database tersedia.
- [ ] Rotasi token/password berhasil diuji.

## Status akhir

```text
Struktur project       : Baik
Pemisahan frontend/API : Baik
Secret frontend        : Aman secara desain
Endpoint contract      : Baik, perlu hardening kecil
Integrasi aplikasi     : Belum dilakukan, masih template
Keamanan direct DB     : Perlu keputusan autentikasi dan jaringan
Build production       : Belum terbukti pada package asal
Kelayakan production   : Belum, selesaikan checklist wajib
```

## Referensi resmi

- Vercel Node.js versions: https://vercel.com/docs/functions/runtimes/node-js/node-js-versions
- Vercel Functions Node runtime: https://vercel.com/docs/functions/runtimes/node-js
- Vite on Vercel: https://vercel.com/docs/frameworks/frontend/vite
- Vercel project configuration: https://vercel.com/docs/project-configuration/vercel-json
- Vercel environment variables: https://vercel.com/docs/environment-variables
