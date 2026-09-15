-- Jalankan melalui pgAdmin sebagai administrator pada database pddikti.
-- Role dibuat NOLOGIN agar file ini tidak pernah menyimpan password.
-- Setelah selesai, atur password melalui kanal admin aman:
-- ALTER ROLE pddikti_gateway LOGIN PASSWORD '<PASSWORD_RANDOM_PANJANG>';

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pddikti_gateway') THEN
    CREATE ROLE pddikti_gateway NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pddikti_migrator') THEN
    CREATE ROLE pddikti_migrator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS gateway_sessions (
  id VARCHAR(64) PRIMARY KEY,
  device_id VARCHAR(128) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

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

CREATE INDEX IF NOT EXISTS ix_gateway_sessions_expiry ON gateway_sessions (expires_at);
CREATE INDEX IF NOT EXISTS ix_gateway_nonces_expiry ON gateway_nonces (expires_at);
CREATE INDEX IF NOT EXISTS ix_gateway_rate_limits_expiry ON gateway_rate_limits (expires_at);
CREATE INDEX IF NOT EXISTS ix_gateway_operations_expiry ON gateway_operations (expires_at);

REVOKE ALL ON gateway_sessions, gateway_nonces, gateway_rate_limits, gateway_operations FROM PUBLIC;
-- Supabase memakai database utama bernama "postgres".
GRANT CONNECT ON DATABASE postgres TO pddikti_gateway;
GRANT USAGE ON SCHEMA public TO pddikti_gateway;
GRANT SELECT, INSERT, UPDATE ON scrape_runs, dosen_records, prodi_records TO pddikti_gateway;
GRANT USAGE, SELECT ON SEQUENCE dosen_records_id_seq, prodi_records_id_seq TO pddikti_gateway;
GRANT SELECT, INSERT, UPDATE, DELETE ON gateway_sessions, gateway_rate_limits TO pddikti_gateway;
GRANT SELECT, INSERT ON gateway_nonces TO pddikti_gateway;
GRANT SELECT, INSERT ON gateway_operations TO pddikti_gateway;

REVOKE CREATE ON SCHEMA public FROM pddikti_gateway;
ALTER ROLE pddikti_gateway SET statement_timeout = '25s';
ALTER ROLE pddikti_gateway SET idle_in_transaction_session_timeout = '10s';

COMMIT;

-- Jalankan berkala sebagai migrator/admin, bukan role runtime:
-- DELETE FROM gateway_nonces WHERE expires_at < NOW();
-- DELETE FROM gateway_sessions WHERE expires_at < NOW() - INTERVAL '1 day';
-- DELETE FROM gateway_rate_limits WHERE expires_at < NOW();
-- DELETE FROM gateway_operations WHERE expires_at < NOW();
