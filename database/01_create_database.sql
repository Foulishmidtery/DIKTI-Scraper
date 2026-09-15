-- Langkah 2: jalankan SENDIRI dengan Auto-commit aktif pada database "postgres".
-- Abaikan file ini jika database pddikti sudah dibuat melalui UI pgAdmin4.

CREATE DATABASE pddikti
    WITH OWNER = pddikti_app
         ENCODING = 'UTF8'
         TEMPLATE = template0;
