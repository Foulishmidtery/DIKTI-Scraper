# Final Review — PDDIKTI Remote Config Revised Package (DEPRECATED)

> Arsip review lama. Implementasi production yang berlaku ada di `SECURITY_HARDENING.md`.

Package yang diperiksa:

```text
C:\Users\jenki\Downloads\pddikti-remote-config-revised-final\pddikti-remote-config-package
```

Tanggal review: 10 September 2026.

## Kesimpulan

Project `production/remote-config` sudah jauh lebih baik dan layak dilanjutkan ke pengujian deployment Vercel. Revisi endpoint, validasi PostgreSQL/TLS, package lock, retry, fingerprint, last-known-good engine, dan SQL privilege sudah diterapkan dengan baik.

Namun package secara keseluruhan **belum boleh langsung menimpa folder `production` aplikasi PDDIKTI Scraper**. File integrasi yang diberikan merupakan implementasi minimal dan tidak mempertahankan seluruh fungsi aplikasi yang sudah ada.

## Hasil pemeriksaan

```text
Unit test remote config Python : PASS (7 tests)
Syntax Electron main.cjs       : PASS
package-lock.json              : ADA dan valid
Node target                    : 22.x
Secret nyata di repository     : TIDAK DITEMUKAN
Full npm ci/build              : BELUM dibuktikan oleh package
Integrasi aplikasi existing    : BELUM lengkap
```

## Revisi sebelumnya yang sudah benar

- autentikasi diperiksa sebelum konfigurasi database dibaca;
- tersedia token per perangkat melalui `DESKTOP_DEVICE_TOKENS_JSON`;
- shared token dinonaktifkan secara default;
- rate limiter lokal disertai peringatan bahwa Vercel Firewall tetap diperlukan;
- scheme PostgreSQL dan TLS divalidasi di Vercel dan Flask;
- URL database dibandingkan menggunakan fingerprint SHA-256 di RAM;
- perubahan URL terdeteksi meskipun `CONFIG_VERSION` tidak berubah;
- bootstrap retry menjadi 5, 10, 20, 40, lalu 60 detik;
- koneksi terakhir yang sehat dipertahankan ketika refresh gagal;
- Node ditetapkan ke `22.x`;
- `package-lock.json` tersedia;
- default privilege PostgreSQL memakai role owner;
- password production tidak ditulis pada SQL;
- session Electron diarahkan ke temporary/in-memory;
- stdout/stderr backend dapat dinonaktifkan.

## Masalah kritis yang masih tersisa

### 1. Jangan menimpa `production/backend/database.py`

File database pada package revisi hanya berisi `RemoteDatabaseManager`. File database aplikasi asli memiliki:

- deklarasi `scrape_runs`;
- `dosen_records` dan `prodi_records`;
- deduplikasi `ON CONFLICT DO NOTHING`;
- pencatatan history;
- analytics;
- export database;
- fungsi insert/update/cancel job;
- API pendukung tabel dosen dan prodi.

Jika file revisi disalin menggantikan file asli, seluruh fungsi tersebut akan hilang dan import pada Flask API akan rusak.

Solusi: merge `RemoteDatabaseManager` ke file database aplikasi asli atau buat modul baru:

```text
production/backend/remote_config.py
production/backend/remote_database.py
```

Kemudian fungsi `get_engine()` pada database lama mengambil engine aktif dari manager tersebut tanpa menghapus fungsi persistence lainnya.

### 2. Jangan menimpa `production/backend/config.py`

Config aplikasi asli masih menyimpan pengaturan berikut:

- output directory;
- Flask host dan port;
- desktop mode;
- CORS frontend origins;
- authentication key;
- konfigurasi runtime lain.

Config revisi hanya menangani remote bootstrap. Menimpanya akan menghilangkan interface `settings` yang dipakai source Flask saat ini.

Solusi: pertahankan `Settings` lama untuk pengaturan non-database. Pindahkan remote bootstrap ke modul terpisah dan gunakan remote URL hanya sebagai sumber database pada production mode.

### 3. `production/frontend/electron/main.cjs` bukan Electron entrypoint lengkap

File revisi hanya mengekspor helper function. File tersebut tidak memiliki alur aplikasi lengkap seperti:

- `app.whenReady()` untuk menjalankan aplikasi;
- pencarian port backend;
- lokasi executable Flask/PyInstaller;
- menunggu `/api/health`;
- memuat splash HTML;
- memuat `dist/index.html`;
- single-instance lock;
- fokus window kedua;
- penghentian process tree Flask di Windows;
- icon dan konfigurasi window aplikasi existing.

Jika dipakai langsung sebagai `main` dari Electron, aplikasi hanya mendefinisikan dan mengekspor fungsi lalu tidak membuka window utama.

Solusi: merge fitur ephemeral session, remote credential, dan no-local-log ke `main.cjs` aplikasi asli. Jangan mengganti entrypoint penuh dengan file revisi.

### 4. Alur login/provisioning perangkat belum tersedia

`setDeviceCredentials()` sudah ada, tetapi belum ada UI, IPC, atau proses lain yang memanggilnya sebelum `startFlaskBackend()`.

Akibatnya `resolveRuntimeToken()` akan gagal kecuali komputer menjalankan EXE dengan environment berikut:

```text
PDDIKTI_DEVICE_ID
PDDIKTI_DEVICE_TOKEN
```

Ini belum memenuhi target pengguna yang cukup membuka EXE tanpa konfigurasi manual.

Harus dipilih salah satu:

1. **Login setiap aplikasi dibuka** — tidak menyimpan token lokal dan paling sesuai target no-local-secret.
2. **Provisioning per perangkat** — token disimpan memakai Windows Credential Manager; lebih nyaman tetapi meninggalkan data kredensial lokal.
3. **Shared token tertanam dalam EXE** — paling mudah, tetapi dapat diekstrak dan hanya layak sebagai transisi terbatas.

Tanpa memilih salah satu, aplikasi production tidak dapat mengambil remote config secara otomatis.

### 5. URL Vercel masih placeholder

Nilai berikut masih ada:

```text
https://NAMA-PROJECT.vercel.app/api/desktop-config
```

URL production harus dimasukkan saat proses build atau melalui konfigurasi build yang tidak mengandung password database. URL endpoint boleh tertanam di EXE karena bukan secret.

## Revisi aplikasi utama yang tetap diperlukan

### Flask API

- buat satu instance `RemoteDatabaseManager` pada startup;
- expose status manager melalui `/api/health`;
- gunakan manager pada fungsi `get_engine()` existing;
- blokir `/api/run-scraper` ketika manager belum ready;
- pertahankan seluruh fungsi history, deduplikasi, analytics, dan export;
- hentikan manager secara bersih saat backend shutdown;
- jangan menulis response remote config ke file atau log.

### Electron

- pertahankan splash screen dan logo KNEKS existing;
- pertahankan startup PyInstaller backend existing;
- jangan membuat `.env` dalam remote production mode;
- jangan membuat `data/logs` jika no-local-trace aktif;
- gunakan session non-persistent;
- tambahkan alur login/provisioning sebelum backend membutuhkan token;
- jangan mengirim token ke renderer React jika tidak diperlukan;
- gunakan IPC terbatas dan context isolation;
- tetap hentikan process tree Flask ketika Electron keluar.

### Export

Backend aplikasi saat ini membuat Excel otomatis setelah scraping. Jika targetnya tidak membuat file lokal:

- hapus export otomatis dari worker scraping;
- simpan hasil dan history ke PostgreSQL;
- export hanya saat pengguna menekan tombol;
- gunakan dialog pemilihan lokasi penyimpanan;
- jangan membuat folder output otomatis.

## Pengujian Vercel yang masih wajib

Di folder berikut:

```text
production/remote-config
```

Jalankan:

```powershell
npm ci
npm run typecheck
npm run build
npx vercel dev
```

Kemudian uji preview deployment sebelum production:

- `/api/health` tidak membocorkan rahasia;
- token tidak valid menghasilkan `401`;
- device ID/token valid menghasilkan `200`;
- versi desktop salah menghasilkan `426`;
- limit menghasilkan `429`;
- URL non-PostgreSQL ditolak;
- URL tanpa TLS ditolak;
- config response tidak di-cache;
- Vercel log tidak memuat token atau database URL.

Aktifkan Vercel Firewall/WAF. Limiter `Map` dalam function hanya bekerja pada instance yang sama dan bukan limiter global.

## Cara menggunakan package revisi ini

### Yang boleh digunakan langsung

Folder berikut dapat diproses sebagai project Vercel tersendiri:

```text
production/remote-config
```

Tetapkan folder tersebut sebagai Vercel Root Directory, isi environment variables testing, lalu jalankan preview deployment.

### Yang tidak boleh ditimpa langsung

```text
production/backend/config.py
production/backend/database.py
production/frontend/electron/main.cjs
```

Ketiga file tersebut harus dijadikan referensi merge ke source aplikasi PDDIKTI Scraper lengkap.

## File yang diperlukan untuk tahap integrasi berikutnya

Agar integrasi dapat dikerjakan dengan benar, gunakan dua source sekaligus:

1. project PDDIKTI Scraper lengkap yang sekarang;
2. folder `production/remote-config` dari package revisi ini.

Jangan meminta model mengganti tiga file utama secara langsung. Instruksikan agar fitur remote config digabung sambil mempertahankan seluruh behavior lama.

## Prompt integrasi lanjutan

```text
Integrasikan project remote-config yang sudah direvisi ke aplikasi PDDIKTI Scraper lengkap.

PENTING: jangan menimpa production/backend/config.py, production/backend/database.py, atau production/frontend/electron/main.cjs dengan versi minimal dari package remote-config. Lakukan merge behavior secara hati-hati dan pertahankan seluruh fungsi existing: startup Electron, splash KNEKS, PyInstaller backend, scraping, deduplikasi PostgreSQL, scrape history, analytics, filtering, pagination, multi-select, dan export.

Pindahkan class/fungsi remote bootstrap ke modul backend baru jika diperlukan. Buat get_engine existing memakai RemoteDatabaseManager ketika PDDIKTI_REMOTE_CONFIG=1, tetapi tetap sediakan mode local .env khusus development. Endpoint /api/health harus menampilkan status remote config, dan /api/run-scraper harus menolak job ketika database belum ready.

Pada Electron, pertahankan lifecycle lengkap existing dan gabungkan ephemeral session, no-local-log, serta remote credential. Implementasikan alur kredensial yang jelas sebelum backend dimulai. Untuk target tanpa secret lokal, gunakan login setiap aplikasi dibuka; jangan menyimpan token di file atau localStorage. Jangan kirim token ke renderer kecuali melalui IPC yang sangat terbatas.

Hapus pembuatan .env dan folder log hanya pada production remote mode. Hapus export Excel otomatis jika target no-local-file aktif; export dilakukan hanya melalui aksi pengguna dan dialog pemilihan lokasi.

Gunakan URL Vercel testing terlebih dahulu dan placeholder untuk credential. Jangan memasukkan secret production ke source, log, test, dokumentasi, atau frontend Vite.

Setelah integrasi, jalankan unit test backend, typecheck/build frontend, npm ci/build remote-config, endpoint contract tests, dan Electron development smoke test. Jangan build EXE sampai saya meminta secara eksplisit.
```

## Status akhir

```text
Remote-config Vercel     : Siap diuji setelah npm ci/build
Hardening endpoint       : Baik
Unit test Python         : Lulus 7/7
Electron helper syntax   : Valid
Integrasi Flask existing : Belum di-merge
Integrasi Electron       : Belum menjadi entrypoint lengkap
Provisioning/login       : Belum dibuat
Production ready         : Belum
```
