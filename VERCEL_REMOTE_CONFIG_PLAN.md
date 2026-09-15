# Rencana Remote Configuration PDDIKTI Scraper (DEPRECATED)

> Jangan gunakan rancangan ini untuk production. Ia digantikan oleh `SECURITY_HARDENING.md` dan `secure-gateway/`, yang tidak mengirim credential PostgreSQL ke Electron.

## 1. Tujuan

Membuat project Vite + React + TypeScript terpisah yang dapat di-deploy ke Vercel untuk:

- menyediakan halaman status konfigurasi;
- menyediakan Vercel Function sebagai endpoint konfigurasi desktop;
- membaca konfigurasi PostgreSQL dari Vercel Environment Variables;
- mengirim konfigurasi ke backend Flask di dalam `Scraper-DIKTI.exe` melalui HTTPS;
- membuat Flask terhubung langsung ke PostgreSQL setelah konfigurasi diterima;
- menghilangkan kebutuhan membuat atau mengedit `.env` pada komputer pengguna.

Vercel hanya digunakan untuk mengambil konfigurasi. Proses scraping, analisis, export, dan komunikasi database tetap dilakukan langsung oleh Flask di komputer pengguna.

## 2. Arsitektur

```text
Administrator
   │
   ├── Mengatur environment variables di Vercel
   └── Deploy/redeploy project Remote Config
                  │
                  ▼
Pengguna membuka Scraper-DIKTI.exe
                  │
                  ├── Splash screen tampil
                  ├── Backend Flask internal berjalan
                  └── GET /api/desktop-config melalui HTTPS
                                  │
                                  ▼
                     Vercel Function memeriksa token
                                  │
                                  ▼
                    Mengirim konfigurasi PostgreSQL
                                  │
                                  ▼
                       Flask menyimpan di memori
                                  │
                                  ▼
                  Flask ───── langsung ───── PostgreSQL
```

Aliran data scraping:

```text
EXE → Vercel : hanya permintaan konfigurasi
EXE → PostgreSQL : scraping, penyimpanan, analisis, dan export
```

## 3. Catatan keamanan penting

Frontend Vite tidak boleh membaca `DATABASE_URL`, password PostgreSQL, atau token rahasia. Nilai tersebut hanya boleh dibaca oleh Vercel Function melalui `process.env`.

Karena aplikasi desktop akhirnya harus terhubung langsung ke PostgreSQL, kredensial database akan tersedia di memori aplikasi. Risiko ini tidak dapat dihilangkan sepenuhnya. Pengamanan minimum:

- wajib menggunakan TLS/SSL PostgreSQL;
- gunakan user PostgreSQL khusus aplikasi;
- jangan gunakan user `postgres` atau superuser;
- batasi hak akses hanya ke schema dan tabel PDDIKTI;
- gunakan password panjang dan lakukan rotasi berkala;
- endpoint konfigurasi tidak boleh publik tanpa autentikasi;
- jangan mencetak `DATABASE_URL`, password, atau response konfigurasi ke log;
- aktifkan rate limiting jika tersedia;
- nonaktifkan scraping jika konfigurasi tidak dapat diverifikasi.

Arsitektur paling aman tetap `EXE → API → PostgreSQL`. Dokumen ini mengikuti kebutuhan komunikasi langsung ke PostgreSQL dengan menerima risikonya.

## 4. Struktur project yang diminta

Buat project baru di luar frontend Electron, misalnya:

```text
production/
├── backend/
├── frontend/
└── remote-config/
    ├── api/
    │   ├── desktop-config.ts
    │   └── health.ts
    ├── src/
    │   ├── components/
    │   ├── lib/
    │   ├── App.tsx
    │   ├── main.tsx
    │   └── styles.css
    ├── public/
    ├── .env.example
    ├── .gitignore
    ├── index.html
    ├── package.json
    ├── tsconfig.json
    ├── tsconfig.app.json
    ├── vite.config.ts
    ├── vercel.json
    └── README.md
```

## 5. Environment Variables Vercel

Tambahkan melalui Vercel Dashboard → Project → Settings → Environment Variables.

```env
# Rahasia dan hanya dibaca Vercel Function
DATABASE_URL=postgresql+psycopg://app_user:password@db.example.com:5432/pddikti?sslmode=require
DESKTOP_CONFIG_TOKEN=ganti_dengan_token_acak_panjang

# Identitas konfigurasi
CONFIG_VERSION=1
CONFIG_REFRESH_SECONDS=300
ALLOWED_DESKTOP_VERSION=2.0.0
```

Alternatif jika tidak menggunakan `DATABASE_URL` tunggal:

```env
POSTGRES_HOST=db.example.com
POSTGRES_PORT=5432
POSTGRES_DB=pddikti
POSTGRES_USER=pddikti_desktop
POSTGRES_PASSWORD=ganti_password
POSTGRES_SSLMODE=require
```

Gunakan hanya salah satu format. `DATABASE_URL` lebih sederhana.

Setiap perubahan Vercel Environment Variables memerlukan redeploy agar digunakan deployment aktif.

## 6. Kontrak endpoint

### `GET /api/health`

Endpoint publik yang tidak menampilkan rahasia.

Contoh response:

```json
{
  "success": true,
  "service": "pddikti-remote-config",
  "configured": true,
  "version": "1"
}
```

### `GET /api/desktop-config`

Header wajib:

```http
Authorization: Bearer <DESKTOP_CONFIG_TOKEN>
X-Desktop-Version: 2.0.0
Accept: application/json
```

Response berhasil:

```json
{
  "success": true,
  "config_version": "1",
  "refresh_after_seconds": 300,
  "database_url": "postgresql+psycopg://...",
  "issued_at": "2026-09-10T08:00:00.000Z"
}
```

Response ditolak:

```json
{
  "success": false,
  "error": "Unauthorized"
}
```

Gunakan status HTTP:

- `200`: konfigurasi berhasil;
- `401`: token salah;
- `426`: versi desktop tidak didukung;
- `500`: konfigurasi Vercel belum lengkap;
- `503`: layanan sementara tidak tersedia.

Tambahkan header berikut:

```http
Cache-Control: no-store, max-age=0
Pragma: no-cache
```

Jangan masukkan `database_url` ke endpoint health atau halaman React.

## 7. Halaman Vite React

Halaman React hanya menampilkan status aman:

- nama layanan;
- status deployment;
- apakah konfigurasi database lengkap;
- versi konfigurasi;
- versi desktop yang diizinkan;
- waktu server;
- petunjuk bahwa rahasia dikelola melalui Vercel Dashboard.

Halaman tidak boleh:

- menampilkan password;
- menampilkan `DATABASE_URL`;
- menyimpan rahasia di localStorage;
- menyediakan form perubahan password dari browser;
- menggunakan environment variable berawalan `VITE_` untuk rahasia.

Semua environment variable dengan awalan `VITE_` dapat masuk ke bundle frontend dan dianggap publik.

## 8. Perubahan pada aplikasi Electron/Flask

### Electron

Hapus proses pembuatan `.env` dari `prepareDataFiles()`.

Saat memulai backend, kirim hanya konfigurasi bootstrap:

```text
PDDIKTI_CONFIG_URL=https://nama-project.vercel.app/api/desktop-config
PDDIKTI_CONFIG_TOKEN=<token aplikasi>
PDDIKTI_DESKTOP_VERSION=2.0.0
PDDIKTI_REMOTE_CONFIG=1
```

Token aplikasi yang ditanam di EXE tetap dapat diekstrak. Untuk keamanan lebih tinggi, ganti token bersama dengan login pengguna atau token perangkat jangka pendek.

### Flask

Saat backend mulai:

1. Baca `PDDIKTI_CONFIG_URL`.
2. Kirim request HTTPS dengan timeout 10 detik.
3. Kirim header Authorization dan versi desktop.
4. Validasi status serta struktur JSON.
5. Simpan `database_url` hanya di memori.
6. Buat SQLAlchemy engine baru.
7. Jalankan pengecekan `SELECT 1`.
8. Izinkan UI terbuka setelah API siap, meskipun database belum siap.
9. Nonaktifkan tombol scraping selama database belum terhubung.
10. Ambil ulang konfigurasi sesuai `refresh_after_seconds`.

Jika versi konfigurasi berubah:

1. hentikan penerimaan job scraping baru;
2. tunggu transaksi aktif selesai;
3. dispose SQLAlchemy engine lama;
4. buat engine menggunakan konfigurasi baru;
5. jalankan health check;
6. aktifkan kembali scraping.

Jangan menuliskan response konfigurasi ke `.env`, JSON, log, localStorage, atau database lokal.

## 9. Penyimpanan pada komputer pengguna

Mode production tidak membuat `.env` di samping EXE.

Data sementara:

- konfigurasi database: RAM;
- log scraping: RAM dan UI;
- cache browser Electron: session in-memory;
- file Excel: dibuat hanya setelah pengguna memilih lokasi export;
- crash/temporary files Windows: tidak dapat dijamin sepenuhnya hilang.

Apabila export otomatis masih diperlukan, hasil tetap menjadi file pada komputer pengguna. Untuk benar-benar tidak membuat output otomatis, ubah proses scraping agar hanya menyimpan ke PostgreSQL dan export dilakukan melalui tombol terpisah.

## 10. Konfigurasi PostgreSQL production

PostgreSQL harus dapat diakses dari jaringan komputer pengguna.

Contoh role terbatas:

```sql
CREATE ROLE pddikti_desktop LOGIN PASSWORD 'GANTI_PASSWORD_KUAT';

GRANT CONNECT ON DATABASE pddikti TO pddikti_desktop;
GRANT USAGE ON SCHEMA public TO pddikti_desktop;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO pddikti_desktop;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pddikti_desktop;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
GRANT SELECT, INSERT, UPDATE ON TABLES TO pddikti_desktop;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
GRANT USAGE, SELECT ON SEQUENCES TO pddikti_desktop;
```

Jangan berikan hak berikut:

- `SUPERUSER`;
- `CREATEDB`;
- `CREATEROLE`;
- akses ke database lain;
- `DROP` atau `TRUNCATE` jika tidak diperlukan.

Gunakan koneksi dengan `sslmode=require` atau verifikasi sertifikat penuh jika server mendukungnya.

## 11. Deployment Vercel

Di terminal:

```powershell
cd production\remote-config
npm install
npm run build
npx vercel login
npx vercel link
npx vercel --prod
```

Setelah environment variables diatur atau diperbarui, lakukan redeploy:

```powershell
npx vercel --prod
```

Pengujian endpoint health:

```powershell
Invoke-RestMethod "https://nama-project.vercel.app/api/health"
```

Jangan menguji endpoint konfigurasi pada terminal yang merekam command history menggunakan token production secara langsung. Gunakan token testing dan rotasi setelah pengujian.

## 12. Checklist sebelum distribusi EXE

- [ ] PostgreSQL production memakai TLS.
- [ ] User PostgreSQL bukan superuser.
- [ ] Hak akses database sudah dibatasi.
- [ ] Vercel Function tidak mencetak rahasia ke log.
- [ ] Endpoint konfigurasi memakai autentikasi.
- [ ] Response memakai `Cache-Control: no-store`.
- [ ] Halaman Vite tidak menerima rahasia.
- [ ] `.env` tidak lagi dibuat oleh Electron.
- [ ] SQLAlchemy menerima konfigurasi dari memori.
- [ ] Scraping terkunci saat database offline.
- [ ] Rotasi konfigurasi sudah diuji.
- [ ] EXE lama dapat diblokir melalui pemeriksaan versi.
- [ ] Export otomatis ke komputer pengguna sudah dinonaktifkan jika tidak diperlukan.
- [ ] Token dan password testing sudah diganti sebelum production.

## 13. Prompt siap digunakan

Salin prompt berikut ketika akan membuat project-nya:

```text
Buat project production baru di folder `production/remote-config` menggunakan Vite, React, dan TypeScript untuk di-deploy ke Vercel. Jangan mengubah folder `production/frontend`, `production/backend`, atau scraper yang sudah ada sebelum project remote-config selesai dan lolos validasi.

Tujuan project adalah menjadi layanan bootstrap remote configuration untuk aplikasi Electron PDDIKTI Scraper. Vercel hanya menyediakan konfigurasi awal; setelah mendapat konfigurasi, backend Flask di dalam EXE harus tetap terhubung langsung ke PostgreSQL.

Buat struktur lengkap yang mencakup frontend Vite, Vercel Functions di folder `api`, `.env.example`, `.gitignore`, `vercel.json`, konfigurasi TypeScript, README, dan script build.

Buat endpoint `GET /api/health` yang hanya mengembalikan status aman tanpa rahasia. Buat endpoint `GET /api/desktop-config` yang membaca `DATABASE_URL`, `DESKTOP_CONFIG_TOKEN`, `CONFIG_VERSION`, `CONFIG_REFRESH_SECONDS`, dan `ALLOWED_DESKTOP_VERSION` dari server-side Vercel Environment Variables. Endpoint harus memvalidasi Bearer token dan header `X-Desktop-Version`, memakai response JSON, menambahkan `Cache-Control: no-store`, tidak mencatat rahasia, serta menangani status 200, 401, 426, 500, dan 503.

Jangan pernah mengekspos rahasia melalui variable berawalan `VITE_`. Halaman React hanya boleh menampilkan nama layanan, configured/unconfigured, config version, allowed desktop version, waktu server, dan petunjuk deployment. Gunakan desain clean, responsif, dan profesional dengan status cards tanpa menampilkan host, user, password, atau DATABASE_URL.

Setelah project remote-config selesai, integrasikan aplikasi Electron/Flask yang sudah ada. Hapus pembuatan `.env` pada komputer pengguna. Electron harus memberikan `PDDIKTI_CONFIG_URL`, `PDDIKTI_CONFIG_TOKEN`, `PDDIKTI_DESKTOP_VERSION`, dan `PDDIKTI_REMOTE_CONFIG=1` kepada backend. Flask mengambil konfigurasi melalui HTTPS dengan timeout, menyimpannya hanya di RAM, membuat ulang SQLAlchemy engine ketika config version berubah, dan mengambil ulang konfigurasi sesuai refresh interval. Jangan simpan response ke file, localStorage, log, atau database lokal.

Gunakan session Electron in-memory. Jangan membuat folder `.env`, `data`, atau log di samping EXE. Export Excel hanya dibuat setelah pengguna memilih lokasi penyimpanan. Pertahankan seluruh fungsi scraping, deduplikasi, PostgreSQL, history, analisis, filter, pagination, dan multi-select yang sudah ada.

Gunakan koneksi PostgreSQL TLS dan anggap database berada pada server publik yang telah dikonfigurasi dengan role terbatas. Jangan gunakan kredensial superuser. Tambahkan validasi, error handling berbahasa Indonesia, loading state, retry, health indicator, dan dokumentasi deployment Vercel lengkap.

Jalankan typecheck, build Vite, dan pengujian endpoint tanpa mencetak rahasia. Jangan build Electron/EXE sampai saya meminta secara eksplisit.
```

## 14. Keputusan yang harus disiapkan

Sebelum implementasi, tentukan:

1. domain Vercel production;
2. hostname PostgreSQL production;
3. apakah PostgreSQL menerima koneksi publik;
4. metode TLS PostgreSQL;
5. role dan hak akses database;
6. metode autentikasi desktop: token bersama, login pengguna, atau token perangkat;
7. interval refresh konfigurasi;
8. kebijakan versi minimum EXE;
9. apakah export Excel otomatis masih diperlukan;
10. apakah log lokal benar-benar dinonaktifkan.

Untuk penggunaan banyak pengguna, autentikasi login atau token perangkat lebih disarankan daripada satu token bersama yang ditanam di seluruh EXE.
