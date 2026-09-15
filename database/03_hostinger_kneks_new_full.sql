-- Jalankan di database kneks_new menggunakan akun yang juga dipakai gateway (Admin123).
-- Tidak membuat role PostgreSQL baru.

BEGIN;

CREATE TABLE IF NOT EXISTS scrape_runs (
  id VARCHAR(36) PRIMARY KEY,
  status VARCHAR(24) NOT NULL,
  selected_prodi JSONB NOT NULL DEFAULT '[]'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TIMESTAMPTZ,
  dosen_seen INTEGER NOT NULL DEFAULT 0 CHECK (dosen_seen >= 0),
  dosen_inserted INTEGER NOT NULL DEFAULT 0 CHECK (dosen_inserted >= 0),
  prodi_seen INTEGER NOT NULL DEFAULT 0 CHECK (prodi_seen >= 0),
  prodi_inserted INTEGER NOT NULL DEFAULT 0 CHECK (prodi_inserted >= 0),
  export_filename VARCHAR(255),
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS dosen_records (
  id BIGSERIAL PRIMARY KEY,
  source_key VARCHAR(64) NOT NULL UNIQUE,
  identity_kind VARCHAR(24) NOT NULL,
  identity_value VARCHAR(255) NOT NULL,
  payload JSONB NOT NULL,
  first_seen_run_id VARCHAR(36) REFERENCES scrape_runs(id) ON DELETE SET NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS prodi_records (
  id BIGSERIAL PRIMARY KEY,
  source_key VARCHAR(64) NOT NULL UNIQUE,
  identity_kind VARCHAR(24) NOT NULL,
  identity_value VARCHAR(500) NOT NULL,
  payload JSONB NOT NULL,
  first_seen_run_id VARCHAR(36) REFERENCES scrape_runs(id) ON DELETE SET NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS gateway_sessions (
  id VARCHAR(64) PRIMARY KEY,
  device_id VARCHAR(128) NOT NULL,
  client_public_key VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

ALTER TABLE gateway_sessions
  ADD COLUMN IF NOT EXISTS client_public_key VARCHAR(100);

CREATE TABLE IF NOT EXISTS gateway_nonces (
  session_id VARCHAR(64) NOT NULL REFERENCES gateway_sessions(id) ON DELETE CASCADE,
  nonce VARCHAR(64) NOT NULL,
  request_id UUID NOT NULL,
  used_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (session_id, nonce),
  UNIQUE (session_id, request_id)
);

CREATE TABLE IF NOT EXISTS gateway_rate_limits (
  rate_key CHAR(64) NOT NULL,
  window_bucket BIGINT NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count > 0),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (rate_key, window_bucket)
);

CREATE TABLE IF NOT EXISTS gateway_operations (
  operation_id UUID PRIMARY KEY,
  session_id VARCHAR(64) NOT NULL REFERENCES gateway_sessions(id) ON DELETE CASCADE,
  action VARCHAR(40) NOT NULL,
  response_body JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'gateway_sessions_client_public_key_format'
      AND conrelid = 'gateway_sessions'::regclass
  ) THEN
    ALTER TABLE gateway_sessions
      ADD CONSTRAINT gateway_sessions_client_public_key_format
      CHECK (client_public_key IS NULL OR client_public_key ~ '^[A-Za-z0-9_-]{50,100}$');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_scrape_runs_started_at ON scrape_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS ix_dosen_first_seen_at ON dosen_records (first_seen_at DESC);
CREATE INDEX IF NOT EXISTS ix_dosen_program_studi ON dosen_records ((payload ->> 'Program Studi'));
CREATE INDEX IF NOT EXISTS ix_dosen_perguruan_tinggi ON dosen_records ((payload ->> 'Perguruan Tinggi'));
CREATE INDEX IF NOT EXISTS ix_prodi_first_seen_at ON prodi_records (first_seen_at DESC);
CREATE INDEX IF NOT EXISTS ix_prodi_nama ON prodi_records ((payload ->> 'nama'));
CREATE INDEX IF NOT EXISTS ix_gateway_sessions_expiry ON gateway_sessions (expires_at);
CREATE INDEX IF NOT EXISTS ix_gateway_nonces_expiry ON gateway_nonces (expires_at);
CREATE INDEX IF NOT EXISTS ix_gateway_rate_limits_expiry ON gateway_rate_limits (expires_at);
CREATE INDEX IF NOT EXISTS ix_gateway_operations_expiry ON gateway_operations (expires_at);

CREATE OR REPLACE VIEW v_scrape_summary AS
SELECT
  id, status, started_at, finished_at,
  dosen_seen, dosen_inserted,
  dosen_seen - dosen_inserted AS dosen_duplicates,
  prodi_seen, prodi_inserted,
  prodi_seen - prodi_inserted AS prodi_duplicates,
  export_filename
FROM scrape_runs;

REVOKE ALL ON scrape_runs, dosen_records, prodi_records,
  gateway_sessions, gateway_nonces, gateway_rate_limits, gateway_operations
  FROM PUBLIC;
REVOKE ALL ON v_scrape_summary FROM PUBLIC;

GRANT CONNECT ON DATABASE kneks_new TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO CURRENT_USER;
GRANT SELECT, INSERT, UPDATE ON scrape_runs, dosen_records, prodi_records TO CURRENT_USER;
GRANT SELECT ON v_scrape_summary TO CURRENT_USER;
GRANT USAGE, SELECT ON SEQUENCE dosen_records_id_seq, prodi_records_id_seq TO CURRENT_USER;
GRANT SELECT, INSERT, UPDATE, DELETE ON gateway_sessions, gateway_rate_limits TO CURRENT_USER;
GRANT SELECT, INSERT ON gateway_nonces, gateway_operations TO CURRENT_USER;

COMMIT;

-- Verifikasi setelah berhasil:
-- Semua objek menggunakan akun CURRENT_USER yang menjalankan file ini.
-- SELECT COUNT(*) FROM scrape_runs;
-- SELECT COUNT(*) FROM gateway_sessions;
-- RESET ROLE;
