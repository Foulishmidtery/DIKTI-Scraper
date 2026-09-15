import { CalendarClock, CheckCircle2, DatabaseBackup, Download, History, LoaderCircle, RefreshCw, Rows3, Search } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { EmptyState } from '../components/EmptyState'
import { useToast } from '../components/Feedback'
import { api } from '../lib/api'
import type { PageId, ScrapeRun } from '../types'

const dateTime = (value: string | null) => value
  ? new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  : 'Masih berjalan'

const duration = (seconds: number | null) => {
  if (seconds == null) return '—'
  const minutes = Math.floor(seconds / 60)
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`
}

const statusLabel: Record<string, string> = { running: 'Berjalan', done: 'Selesai', error: 'Gagal', cancelled: 'Dibatalkan' }

export function FilesPage({ revision, onNavigate }: { revision: number; onNavigate: (page: PageId) => void }) {
  const { pushToast } = useToast()
  const [runs, setRuns] = useState<ScrapeRun[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [exporting, setExporting] = useState(false)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [page, setPage] = useState(0)
  const pageSize = 10

  const loadRuns = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    if (!silent) setError('')
    try {
      const response = await api.scrapeRuns()
      setRuns(response.data)
    } catch (reason) {
      if (!silent) setError(reason instanceof Error ? reason.message : 'Gagal memuat riwayat PostgreSQL')
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])

  useEffect(() => { void loadRuns() }, [loadRuns, revision])
  useEffect(() => {
    const interval = window.setInterval(() => void loadRuns(true), 10_000)
    return () => window.clearInterval(interval)
  }, [loadRuns])

  const filtered = useMemo(() => {
    const term = query.trim().toLocaleLowerCase('id-ID')
    return runs.filter((run) => {
      const haystack = `${run.id} ${run.selected_prodi.join(' ')} ${run.export_filename ?? ''}`.toLocaleLowerCase('id-ID')
      return (status === 'all' || run.status === status) && (!term || haystack.includes(term))
    })
  }, [query, runs, status])

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const safePage = Math.min(page, pageCount - 1)
  const visible = filtered.slice(safePage * pageSize, (safePage + 1) * pageSize)
  const latest = runs[0]
  const totalInserted = runs.reduce((sum, run) => sum + run.dosen_inserted + run.prodi_inserted, 0)

  const exportDatabase = async () => {
    setExporting(true)
    try {
      const result = await api.exportDatabase()
      await api.downloadOutput(result.filename)
      pushToast(`Export ${result.filename} berhasil dibuat.`, 'success')
      await loadRuns()
    } catch (reason) {
      pushToast(reason instanceof Error ? reason.message : 'Gagal mengekspor database', 'error')
    } finally {
      setExporting(false)
    }
  }

  return (
    <>
      <section className="intro-row feature-hero">
        <div><p className="eyebrow">Riwayat PostgreSQL</p><h2>Setiap aktivitas scraping tercatat.</h2><p className="lede">Waktu, pilihan prodi, hasil baru, duplikat, dan status job dibaca langsung dari database—bukan dari daftar Excel.</p><div className="hero-chip-row"><span><i />Audit trail</span><span>Database-first</span><span>Export on demand</span></div></div>
        <div className="intro-actions">
          <button className="button primary" type="button" disabled={exporting} onClick={() => void exportDatabase()}><DatabaseBackup className={exporting ? 'spin' : ''} size={17} /> {exporting ? 'Membuat export…' : 'Export database'}</button>
          <button className="button secondary" type="button" disabled={loading} onClick={() => void loadRuns()}><RefreshCw className={loading ? 'spin' : ''} size={17} /> Segarkan</button>
        </div>
      </section>

      <div className="file-summary-grid">
        <article className="metric-card interactive-surface"><span><History size={19} /></span><div><small>Total scraping</small><strong>{runs.length}</strong></div></article>
        <article className="metric-card interactive-surface"><span><Rows3 size={19} /></span><div><small>Record baru tersimpan</small><strong>{totalInserted.toLocaleString('id-ID')}</strong></div></article>
        <article className="metric-card interactive-surface"><span><CalendarClock size={19} /></span><div><small>Scraping terakhir</small><strong className="metric-date">{latest ? dateTime(latest.started_at) : 'Belum ada'}</strong></div></article>
      </div>

      <section className="panel file-panel history-panel spotlight-panel">
        <div className="panel-heading history-heading">
          <div><h3>Riwayat scraping</h3><p>Data permanen dari tabel scrape_runs</p></div>
          <div className="history-filters">
            <label className="search-field"><Search size={16} /><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(0) }} placeholder="Cari job atau prodi…" /></label>
            <select value={status} onChange={(event) => { setStatus(event.target.value); setPage(0) }} aria-label="Filter status"><option value="all">Semua status</option><option value="running">Berjalan</option><option value="done">Selesai</option><option value="error">Gagal</option><option value="cancelled">Dibatalkan</option></select>
          </div>
        </div>

        {loading && <div className="section-loading"><LoaderCircle className="spin" /> Memuat riwayat database…</div>}
        {!loading && error && <EmptyState title="Riwayat belum dapat dimuat" description={error} action={<button className="button secondary" type="button" onClick={() => void loadRuns()}>Coba lagi</button>} />}
        {!loading && !error && !runs.length && <EmptyState title="Belum ada riwayat scraping" description="Jalankan scraper; setiap job akan langsung tercatat di PostgreSQL." />}

        {!loading && !error && runs.length > 0 && <>
          <div className="history-list">{visible.map((run) => <article className="history-row" key={run.id}>
            <div className={`history-status status-${run.status}`}><CheckCircle2 size={18} /></div>
            <div className="history-primary"><div><strong>{dateTime(run.started_at)}</strong><span className={`status-badge status-${run.status}`}>{statusLabel[run.status] ?? run.status}</span></div><p>{run.selected_prodi.length} prodi · {duration(run.duration_seconds)} · ID {run.id.slice(0, 8)}</p><small title={run.selected_prodi.join(', ')}>{run.selected_prodi.join(', ') || 'Tidak ada pilihan prodi'}</small></div>
            <div className="history-numbers"><span><small>Dosen baru</small><strong>{run.dosen_inserted.toLocaleString('id-ID')}</strong></span><span><small>Prodi baru</small><strong>{run.prodi_inserted.toLocaleString('id-ID')}</strong></span></div>
            <div className="file-actions"><button className="icon-label-button" type="button" onClick={() => onNavigate('dosen')}><Rows3 size={16} /><span>Lihat data</span></button>{run.export_filename && <button className="icon-label-button" type="button" onClick={() => void api.downloadOutput(run.export_filename!)}><Download size={16} /><span>Excel</span></button>}</div>
            {run.error_message && <p className="history-error">{run.error_message}</p>}
          </article>)}</div>
          <div className="pagination-row"><span>{filtered.length} job · Halaman {safePage + 1} dari {pageCount}</span><div><button type="button" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>‹</button><button type="button" disabled={safePage >= pageCount - 1} onClick={() => setPage(safePage + 1)}>›</button></div></div>
        </>}
      </section>
    </>
  )
}
