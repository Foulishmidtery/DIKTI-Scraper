-- Langkah 3: jalankan melalui pgAdmin Query Tool setelah memilih database "pddikti".

BEGIN;
SET LOCAL ROLE pddikti_app;

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

CREATE INDEX IF NOT EXISTS ix_scrape_runs_started_at
    ON scrape_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS ix_dosen_first_seen_at
    ON dosen_records (first_seen_at DESC);
CREATE INDEX IF NOT EXISTS ix_dosen_program_studi
    ON dosen_records ((payload ->> 'Program Studi'));
CREATE INDEX IF NOT EXISTS ix_dosen_perguruan_tinggi
    ON dosen_records ((payload ->> 'Perguruan Tinggi'));
CREATE INDEX IF NOT EXISTS ix_prodi_first_seen_at
    ON prodi_records (first_seen_at DESC);
CREATE INDEX IF NOT EXISTS ix_prodi_nama
    ON prodi_records ((payload ->> 'nama'));

CREATE OR REPLACE VIEW v_scrape_summary AS
SELECT
    id,
    status,
    started_at,
    finished_at,
    dosen_seen,
    dosen_inserted,
    dosen_seen - dosen_inserted AS dosen_duplicates,
    prodi_seen,
    prodi_inserted,
    prodi_seen - prodi_inserted AS prodi_duplicates,
    export_filename
FROM scrape_runs;

COMMIT;
