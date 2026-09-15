import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { query, transaction } from './db.js'

type JsonRecord = Record<string, unknown>
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function object(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('bad_request')
  return value as JsonRecord
}

function text(value: unknown, maximum = 255): string {
  if (typeof value !== 'string') throw new Error('bad_request')
  const result = value.trim()
  if (!result || result.length > maximum) throw new Error('bad_request')
  return result
}

function uuid(value: unknown): string {
  const result = text(value, 36)
  if (!UUID_PATTERN.test(result)) throw new Error('bad_request')
  return result
}

function normalize(value: unknown): string {
  return String(value ?? '').normalize('NFKC').trim().toUpperCase().split(/\s+/).filter(Boolean).join(' ')
}

function sourceKey(kind: string, value: string): string {
  return createHash('sha256').update(`${kind}|${value}`, 'utf8').digest('hex')
}

function dosenIdentity(payload: JsonRecord): [string, string, string] {
  const nidn = normalize(payload.NIDN)
  if (nidn) return [sourceKey('nidn', nidn), 'nidn', nidn]
  const nuptk = normalize(payload.NUPTK)
  if (nuptk) return [sourceKey('nuptk', nuptk), 'nuptk', nuptk]
  const fallback = [payload.Nama, payload['Perguruan Tinggi'], payload['Program Studi']].map(normalize).join('|')
  return [sourceKey('fallback', fallback), 'fallback', fallback]
}

function prodiIdentity(payload: JsonRecord): [string, string, string] {
  const logical = [payload.nama, payload.jenjang, payload.pt].map(normalize).join('|')
  const pddiktiId = normalize(payload.id)
  return [sourceKey('prodi', logical), pddiktiId ? 'pddikti_id' : 'logical', pddiktiId || logical]
}

const accreditationFields = [
  'peringkat_akreditasi_banpt', 'nomor_sk_akreditasi', 'tanggal_sk_akreditasi',
  'tanggal_akhir_akreditasi', 'status_berlaku_sk_akreditasi',
  'sumber_akreditasi', 'url_sumber_akreditasi', 'url_riwayat_akreditasi', 'url_sk_akreditasi',
]

function accreditationDateKey(value: unknown): string {
  const raw = String(value ?? '').trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw
  const months: Record<string, string> = {
    januari: '01', februari: '02', maret: '03', april: '04', mei: '05', juni: '06',
    juli: '07', agustus: '08', september: '09', oktober: '10', november: '11', desember: '12',
  }
  const parts = raw.toLowerCase().split(/\s+/)
  if (parts.length === 3 && months[parts[1]] && /^\d{1,2}$/.test(parts[0]) && /^\d{4}$/.test(parts[2])) {
    return `${parts[2]}-${months[parts[1]]}-${parts[0].padStart(2, '0')}`
  }
  return normalize(raw)
}

function mergeProdiAccreditation(previous: JsonRecord | undefined, incoming: JsonRecord, runId: string): JsonRecord {
  if (!previous) return incoming
  const merged: JsonRecord = { ...incoming }
  if ((!Array.isArray(merged.riwayat_akreditasi_banpt) || merged.riwayat_akreditasi_banpt.length === 0)
      && Array.isArray(previous.riwayat_akreditasi_banpt)) {
    merged.riwayat_akreditasi_banpt = previous.riwayat_akreditasi_banpt
  }
  const verified = merged.status_pencocokan_akreditasi === 'terverifikasi'
  const oldRank = normalize(previous.peringkat_akreditasi_banpt)
  const newRank = normalize(merged.peringkat_akreditasi_banpt)
  const sameDecision = oldRank === newRank && accreditationDateKey(previous.tanggal_akhir_akreditasi) === accreditationDateKey(merged.tanggal_akhir_akreditasi)
  if (verified && sameDecision) {
    for (const field of ['nomor_sk_akreditasi', 'tanggal_sk_akreditasi', 'url_sk_akreditasi']) {
      if (!merged[field] && previous[field]) merged[field] = previous[field]
    }
  }
  if (!verified && oldRank) {
    for (const field of accreditationFields) {
      if (previous[field]) merged[field] = previous[field]
    }
    merged.status_pencocokan_akreditasi = 'data terakhir terverifikasi; sumber belum sinkron'
  }
  const changes = Array.isArray(previous.riwayat_perubahan_scraping)
    ? [...previous.riwayat_perubahan_scraping] : []
  if (verified && oldRank && newRank &&
      (oldRank !== newRank || accreditationDateKey(previous.tanggal_akhir_akreditasi) !== accreditationDateKey(merged.tanggal_akhir_akreditasi))) {
    changes.push({
      run_id: runId,
      dicatat_pada: new Date().toISOString(),
      peringkat_sebelum: previous.peringkat_akreditasi_banpt ?? '',
      peringkat_sesudah: merged.peringkat_akreditasi_banpt ?? '',
      berlaku_sampai_sebelum: previous.tanggal_akhir_akreditasi ?? '',
      berlaku_sampai_sesudah: merged.tanggal_akhir_akreditasi ?? '',
    })
  }
  if (changes.length) merged.riwayat_perubahan_scraping = changes.slice(-100)
  return merged
}

function records(value: unknown): JsonRecord[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('bad_request')
  return value.map((item) => {
    const row = object(item)
    if (Buffer.byteLength(JSON.stringify(row), 'utf8') > 600_000) throw new Error('bad_request')
    return row
  })
}

type PersistCounts = { inserted: number; updated: number }

async function insertRecords(
  client: PoolClient,
  table: 'dosen_records' | 'prodi_records',
  runId: string,
  rows: JsonRecord[],
): Promise<PersistCounts> {
  if (!rows.length) return { inserted: 0, updated: 0 }
  if (table === 'prodi_records') {
    const keys = rows.map((payload) => prodiIdentity(payload)[0])
    const existing = await client.query<{ source_key: string; payload: JsonRecord }>(
      'SELECT source_key, payload FROM prodi_records WHERE source_key = ANY($1::text[]) ORDER BY source_key FOR UPDATE',
      [keys],
    )
    const previous = new Map(existing.rows.map((row) => [row.source_key, row.payload]))
    rows = rows.map((payload, index) => mergeProdiAccreditation(previous.get(keys[index]), payload, runId))
  }
  const values: unknown[] = []
  const placeholders = rows.map((payload, index) => {
    const identity = table === 'dosen_records' ? dosenIdentity(payload) : prodiIdentity(payload)
    values.push(identity[0], identity[1], identity[2], JSON.stringify(payload), runId)
    const offset = index * 5
    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}::jsonb, $${offset + 5}, NOW())`
  })
  const result = await client.query(
    `INSERT INTO ${table} (source_key, identity_kind, identity_value, payload, first_seen_run_id, first_seen_at)
     VALUES ${placeholders.join(',')}
     ON CONFLICT (source_key) DO UPDATE SET
       identity_kind = EXCLUDED.identity_kind,
       identity_value = EXCLUDED.identity_value,
       payload = EXCLUDED.payload
     WHERE ${table}.payload IS DISTINCT FROM EXCLUDED.payload
       AND CASE WHEN '${table}' = 'dosen_records'
         THEN COALESCE(EXCLUDED.payload->>'ID Dosen PDDIKTI', '') <> ''
         ELSE COALESCE(EXCLUDED.payload->>'id', '') <> ''
       END
     RETURNING (xmax = 0) AS inserted`,
    values,
  )
  const inserted = result.rows.filter((row) => row.inserted === true).length
  return { inserted, updated: (result.rowCount ?? 0) - inserted }
}

async function createRun(payloadValue: unknown) {
  const payload = object(payloadValue)
  const runId = uuid(payload.run_id)
  if (!Array.isArray(payload.selected_prodi) || payload.selected_prodi.length < 1 || payload.selected_prodi.length > 100) {
    throw new Error('bad_request')
  }
  const selected = payload.selected_prodi.map((item) => text(item, 200))
  await query(
    `INSERT INTO scrape_runs (id, status, selected_prodi, started_at)
     VALUES ($1, 'running', $2::jsonb, NOW())
     ON CONFLICT (id) DO NOTHING`,
    [runId, JSON.stringify(selected)],
  )
  return { success: true }
}

async function persistResults(payloadValue: unknown, sessionId: string) {
  const payload = object(payloadValue)
  const runId = uuid(payload.run_id)
  const operationId = uuid(payload.operation_id)
  const profiles = records(payload.profiles ?? [])
  const prodi = records(payload.prodi ?? [])
  if (payload.finalize !== undefined && typeof payload.finalize !== 'boolean') throw new Error('bad_request')
  const finalize = payload.finalize === true
  if (profiles.length + prodi.length < 1 || profiles.length + prodi.length > 100) throw new Error('bad_request')

  return transaction(async (client) => {
    const previous = await client.query<{ response_body: JsonRecord }>(
      'SELECT response_body FROM gateway_operations WHERE operation_id = $1 AND action = $2',
      [operationId, 'persist_results'],
    )
    if (previous.rows[0]) return previous.rows[0].response_body

    const dosenCounts = await insertRecords(client, 'dosen_records', runId, profiles)
    const prodiCounts = await insertRecords(client, 'prodi_records', runId, prodi)
    const updated = await client.query(
      `UPDATE scrape_runs SET
         dosen_seen = dosen_seen + $2,
         dosen_inserted = dosen_inserted + $3,
         prodi_seen = prodi_seen + $4,
         prodi_inserted = prodi_inserted + $5,
         status = CASE WHEN $6 THEN 'done' ELSE status END,
         finished_at = CASE WHEN $6 THEN NOW() ELSE finished_at END,
         error_message = CASE WHEN $6 THEN NULL ELSE error_message END
       WHERE id = $1 AND status = 'running' RETURNING id`,
      [runId, profiles.length, dosenCounts.inserted, prodi.length, prodiCounts.inserted, finalize],
    )
    if (updated.rowCount !== 1) throw new Error('bad_request')
    const response = {
      success: true,
      dosen_seen: profiles.length,
      dosen_inserted: dosenCounts.inserted,
      dosen_updated: dosenCounts.updated,
      dosen_skipped: profiles.length - dosenCounts.inserted - dosenCounts.updated,
      prodi_seen: prodi.length,
      prodi_inserted: prodiCounts.inserted,
      prodi_updated: prodiCounts.updated,
      prodi_skipped: prodi.length - prodiCounts.inserted - prodiCounts.updated,
    }
    await client.query(
      `INSERT INTO gateway_operations (operation_id, session_id, action, response_body, expires_at)
       VALUES ($1, $2, 'persist_results', $3::jsonb, NOW() + INTERVAL '2 days')`,
      [operationId, sessionId, JSON.stringify(response)],
    )
    return response
  })
}

async function finishRun(payloadValue: unknown) {
  const payload = object(payloadValue)
  const runId = uuid(payload.run_id)
  const status = text(payload.status, 24)
  if (!['done', 'error', 'cancelled'].includes(status)) throw new Error('bad_request')
  const result = await query(
    `UPDATE scrape_runs
     SET status = $2, finished_at = NOW()
     WHERE id = $1
     RETURNING id`,
    [runId, status],
  )
  if (result.rowCount !== 1) throw new Error('bad_request')
  return { success: true }
}

async function listRuns(payloadValue: unknown) {
  const payload = object(payloadValue ?? {})
  const rawLimit = Number(payload.limit ?? 250)
  const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 500) : 250
  const result = await query(
    `SELECT id, status, selected_prodi, started_at, finished_at,
       CASE WHEN finished_at IS NULL THEN NULL ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM finished_at - started_at)))::int END AS duration_seconds,
       dosen_seen, dosen_inserted, prodi_seen, prodi_inserted, export_filename, error_message
     FROM scrape_runs ORDER BY started_at DESC LIMIT $1`,
    [limit],
  )
  return { success: true, data: result.rows }
}

async function getRecords(payloadValue: unknown) {
  const payload = object(payloadValue)
  const kind = text(payload.kind, 16)
  if (!['dosen', 'prodi'].includes(kind)) throw new Error('bad_request')
  const afterId = Number(payload.after_id ?? 0)
  const rawLimit = Number(payload.limit ?? 500)
  if (payload.compact !== undefined && typeof payload.compact !== 'boolean') throw new Error('bad_request')
  const compact = payload.compact === true
  if (!Number.isSafeInteger(afterId) || afterId < 0 || !Number.isInteger(rawLimit)) throw new Error('bad_request')
  const limit = Math.min(Math.max(rawLimit, 1), 500)
  const table = kind === 'dosen' ? 'dosen_records' : 'prodi_records'
  const payloadExpression = compact && kind === 'dosen'
    ? `payload - ARRAY['Data Homebase Mentah','Data Pencarian Mentah','Profil Mentah','Riwayat Pendidikan','Riwayat Mengajar','Sertifikasi','Status Detail PDDIKTI']::text[]`
    : 'payload'
  const result = await query<{ id: string; payload: JsonRecord }>(
    `SELECT id, ${payloadExpression} AS payload FROM ${table} WHERE id > $1 ORDER BY id LIMIT $2`,
    [afterId, limit],
  )
  return {
    success: true,
    data: result.rows.map((row) => row.payload),
    next_after_id: result.rows.length ? Number(result.rows[result.rows.length - 1].id) : afterId,
    has_more: result.rows.length === limit,
  }
}

async function status() {
  const result = await query<{ total_dosen: string; total_prodi: string }>(
    `SELECT
       (SELECT COUNT(*) FROM dosen_records)::text AS total_dosen,
       (SELECT COUNT(*) FROM prodi_records)::text AS total_prodi`,
  )
  return {
    success: true,
    total_dosen: Number(result.rows[0]?.total_dosen ?? 0),
    total_prodi: Number(result.rows[0]?.total_prodi ?? 0),
  }
}

async function getDosenDetail(payloadValue: unknown) {
  const payload = object(payloadValue)
  const pddiktiId = typeof payload.pddikti_id === 'string' ? payload.pddikti_id.trim().slice(0, 255) : ''
  const nidn = typeof payload.nidn === 'string' ? normalize(payload.nidn).slice(0, 255) : ''
  if (!pddiktiId && !nidn) throw new Error('bad_request')
  const nidnSourceKey = nidn ? sourceKey('nidn', nidn) : ''
  const result = await query<{ payload: JsonRecord }>(
    `SELECT payload FROM dosen_records
     WHERE ($1 <> '' AND source_key = $1)
        OR ($2 <> '' AND payload->>'ID Dosen PDDIKTI' = $2)
     ORDER BY id LIMIT 1`,
    [nidnSourceKey, pddiktiId],
  )
  return { success: true, data: result.rows[0]?.payload ?? null }
}

async function getProdiDetail(payloadValue: unknown) {
  const payload = object(payloadValue)
  const pddiktiId = typeof payload.pddikti_id === 'string' ? payload.pddikti_id.trim().slice(0, 255) : ''
  const nama = typeof payload.nama === 'string' ? normalize(payload.nama).slice(0, 200) : ''
  const jenjang = typeof payload.jenjang === 'string' ? normalize(payload.jenjang).slice(0, 32) : ''
  const pt = typeof payload.pt === 'string' ? normalize(payload.pt).slice(0, 255) : ''
  const logicalKey = nama && jenjang && pt ? sourceKey('prodi', `${nama}|${jenjang}|${pt}`) : ''
  if (!pddiktiId && !logicalKey) throw new Error('bad_request')
  const result = await query<{ payload: JsonRecord }>(
    `SELECT payload FROM prodi_records
     WHERE ($1 <> '' AND payload->>'id' = $1)
        OR ($2 <> '' AND source_key = $2)
     ORDER BY id LIMIT 1`,
    [pddiktiId, logicalKey],
  )
  return { success: true, data: result.rows[0]?.payload ?? null }
}

export async function runOperation(action: string, payload: unknown, sessionId: string): Promise<unknown> {
  switch (action) {
    case 'status': return status()
    case 'create_run': return createRun(payload)
    case 'persist_results': return persistResults(payload, sessionId)
    case 'finish_run': return finishRun(payload)
    case 'list_runs': return listRuns(payload)
    case 'records': return getRecords(payload)
    case 'dosen_detail': return getDosenDetail(payload)
    case 'prodi_detail': return getProdiDetail(payload)
    default: throw new Error('bad_request')
  }
}
