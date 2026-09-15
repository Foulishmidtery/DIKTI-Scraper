# PDDIKTI Secure Gateway

Gateway Vercel untuk aplikasi Electron. Berbeda dari versi remote-config lama, endpoint ini **tidak pernah mengirim `DATABASE_URL`**. Semua query PostgreSQL dijalankan server-side.

```text
Electron UI -> Flask lokal -> HTTPS + HMAC session -> Vercel Function -> PostgreSQL
```

## Setup singkat

1. Jalankan schema aplikasi, lalu `integration/01_gateway_security.sql` di pgAdmin.
2. Aktifkan login role melalui kanal admin aman: `ALTER ROLE pddikti_gateway LOGIN PASSWORD '<acak-panjang>';`.
3. Pasang environment dari `.env.example` pada Vercel. Jangan gunakan prefix `VITE_` untuk secret.
4. Isi `DATABASE_URL` dengan role `pddikti_gateway`, bukan `postgres` atau owner/migrator.
5. Batasi PostgreSQL agar hanya menerima koneksi dari backend/provider yang diizinkan. Jangan buka `5432` ke `0.0.0.0/0`.
6. Deploy project ini, lalu isi URL publiknya di `production/frontend/electron/runtime-config.cjs` sebelum build EXE.

Hash kode aktivasi:

```powershell
$code = Read-Host 'Kode aktivasi'
$bytes = [Text.Encoding]::UTF8.GetBytes($code)
([BitConverter]::ToString([Security.Cryptography.SHA256]::HashData($bytes))).Replace('-', '').ToLower()
```

`SESSION_MASTER_KEY` minimal 32 byte acak dan hanya berada pada Vercel. Kode aktivasi diberikan admin kepada operator, dimasukkan setiap aplikasi dibuka, tidak disimpan di disk, dan dapat dirotasi tanpa rebuild EXE.

## Proteksi request

Setelah aktivasi, server mengeluarkan session key turunan yang berlaku singkat. Setiap request membawa session ID, device/session ID, timestamp, nonce, request ID, SHA-256 body canonical, dan HMAC. Nonce/request ID dicatat dengan unique constraint sehingga replay ditolak. Session dapat di-refresh, di-revoke, atau dibiarkan kedaluwarsa.

## Perintah

```powershell
npm ci
npm run typecheck
npm run build
```

`/api/health` hanya menampilkan status generik. `/api/desktop-config` sengaja mengembalikan `410` dan tidak lagi membocorkan koneksi database.
