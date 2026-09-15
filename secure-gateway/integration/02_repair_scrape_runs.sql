-- Jalankan sekali di Supabase SQL Editor sebagai administrator.
-- Aman untuk schema lama: ADD COLUMN IF NOT EXISTS tidak menghapus data.

BEGIN;

ALTER TABLE public.scrape_runs
  ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dosen_seen INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS dosen_inserted INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS prodi_seen INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS prodi_inserted INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS export_filename VARCHAR(255),
  ADD COLUMN IF NOT EXISTS error_message TEXT;

GRANT SELECT, INSERT, UPDATE ON public.scrape_runs TO pddikti_gateway;

-- Pulihkan job lama yang datanya sudah selesai tersimpan tetapi statusnya
-- tertahan akibat schema lama.
UPDATE public.scrape_runs
SET status = 'done',
    finished_at = COALESCE(finished_at, NOW()),
    error_message = NULL
WHERE status IN ('running', 'error')
  AND dosen_seen > 0
  AND prodi_seen > 0;

COMMIT;
