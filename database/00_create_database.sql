-- Langkah 1: jalankan melalui pgAdmin Query Tool pada database "postgres".
-- Ganti password sebelum dijalankan.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pddikti_app') THEN
        CREATE ROLE pddikti_app LOGIN PASSWORD 'CHANGE_ME_NOW';
    END IF;
END
$$;
