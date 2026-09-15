export type PageId = 'scrape' | 'files' | 'dosen' | 'prodi'

export interface ApiErrorBody {
  success?: false
  error?: string
}

export interface TargetProdiResponse {
  success: true
  data: string[]
  total: number
  locked: boolean
  selection_mode: string
  catalog_mode: string
}

export interface StartJobResponse {
  success: true
  job_id: string
  selected_total: number
  selected_prodi: string[]
}

export interface OutputFile {
  name: string
  size: number
  modified: number
}

export interface ScrapeRun {
  id: string
  status: 'running' | 'done' | 'error' | 'cancelled'
  selected_prodi: string[]
  started_at: string
  finished_at: string | null
  duration_seconds: number | null
  dosen_seen: number
  dosen_inserted: number
  prodi_seen: number
  prodi_inserted: number
  export_filename: string | null
  error_message: string | null
}

export interface ScrapeRunsResponse {
  success: true
  data: ScrapeRun[]
  total: number
}

export interface AnalysisResponse {
  success: true
  dosen: Record<string, unknown>[]
  prodi: Record<string, unknown>[]
  metadata: {
    filename?: string
    source: 'postgresql'
    generated_at: string
    total_dosen: number
    total_prodi: number
  }
}

export interface DosenDetailResponse {
  success: true
  data: Record<string, unknown>
}

export interface ProdiDetailResponse {
  success: true
  data: Record<string, unknown>
}

export interface DatabaseStats {
  configured: boolean
  connected: boolean
  message: string
  total_dosen?: number
  total_prodi?: number
}

export interface HealthResponse {
  success: boolean
  status: 'ok' | 'degraded'
  database: DatabaseStats
  security: {
    mode: 'development' | 'secure_gateway'
    required: boolean
    authenticated: boolean
    expires_at: number | null
  }
}

export interface IngestStats {
  dosen_seen: number
  dosen_inserted: number
  dosen_updated?: number
  dosen_skipped: number
  prodi_seen: number
  prodi_inserted: number
  prodi_updated?: number
  prodi_skipped: number
}

export type StreamEvent =
  | { type: 'connected' | 'heartbeat' }
  | { type: 'log'; message: string }
  | { type: 'progress'; step: number; current: number; total: number; label: string }
  | { type: 'done'; filename: string | null; stats?: IngestStats }
  | { type: 'error'; message: string }
