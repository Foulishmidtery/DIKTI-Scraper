import { AnimatedCircularProgressBar } from '@/components/vendor/magicui/animated-circular-progress-bar'
import { BlurFade } from '@/components/vendor/magicui/blur-fade'
import { BorderBeam } from '@/components/vendor/magicui/border-beam'
import { AnimatedSpan, Terminal } from '@/components/vendor/magicui/terminal'
import {
  Check,
  CheckCircle2,
  Clipboard,
  Database,
  Download,
  FileSpreadsheet,
  LoaderCircle,
  Play,
  Search,
  ShieldCheck,
  Square,
  TerminalSquare,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ConfirmDialog, useToast } from '../components/Feedback'
import { api } from '../lib/api'
import type { StreamEvent } from '../types'

type RunState = 'idle' | 'starting' | 'running' | 'done' | 'error' | 'cancelled'

interface ProgressState {
  step: number
  current: number
  total: number
  label: string
}

const PROCESS_STEPS = ['Sinkronisasi', 'Daftar dosen', 'Profil dosen', 'Simpan database', 'Ekspor Excel']

export function ScrapePage({ databaseOnline, onOutputCreated }: { databaseOnline: boolean | null; onOutputCreated: () => void }) {
  const { pushToast } = useToast()
  const [targets, setTargets] = useState<string[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [runState, setRunState] = useState<RunState>('idle')
  const [jobId, setJobId] = useState<string | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [progress, setProgress] = useState<ProgressState>({ step: 0, current: 0, total: 1, label: 'Menunggu proses' })
  const [resultFile, setResultFile] = useState<string | null>(null)
  const cancelStreamRef = useRef<(() => void) | null>(null)
  const logEndRef = useRef<HTMLSpanElement | null>(null)

  const loadTargets = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      const response = await api.targets()
      setTargets(response.data)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Gagal memuat daftar program studi')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadTargets()
    return () => cancelStreamRef.current?.()
  }, [loadTargets])

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [logs])

  const filteredTargets = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('id-ID')
    return query ? targets.filter((target) => target.toLocaleLowerCase('id-ID').includes(query)) : targets
  }, [search, targets])

  const selectedOrdered = useMemo(() => targets.filter((target) => selected.has(target)), [selected, targets])
  const selectedPreview = selectedOrdered.slice(0, 3)
  const isBusy = runState === 'starting' || runState === 'running'
  const progressPercent = progress.total > 0 ? Math.min(100, Math.round((progress.current / progress.total) * 100)) : 0
  const progressVisible = isBusy || runState === 'done'

  const toggleTarget = (target: string) => {
    if (isBusy) return
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(target)) next.delete(target)
      else next.add(target)
      return next
    })
  }

  const appendLog = (message: string) => setLogs((current) => [...current, message])

  const startStream = (id: string) => {
    cancelStreamRef.current?.()
    cancelStreamRef.current = api.streamJob(id, (event: StreamEvent) => {
      if (event.type === 'log') appendLog(event.message)
      if (event.type === 'progress') {
        setProgress({ step: event.step, current: event.current, total: event.total, label: event.label })
      }
      if (event.type === 'done') {
        cancelStreamRef.current = null
        setRunState('done')
        setJobId(null)
        setResultFile(event.filename)
        setProgress((current) => ({ ...current, current: current.total, label: 'Data selesai diproses' }))
        appendLog(event.filename ? `Selesai. File ${event.filename} siap diunduh.` : 'Selesai. Data baru tersimpan aman di PostgreSQL.')
        if (event.stats) {
          appendLog(`Ringkasan database: ${event.stats.dosen_inserted} dosen baru, ${event.stats.dosen_updated ?? 0} dosen diperbarui.`)
          appendLog(`Prodi: ${event.stats.prodi_inserted} baru, ${event.stats.prodi_updated ?? 0} diperbarui. Tanpa perubahan: ${event.stats.dosen_skipped} dosen dan ${event.stats.prodi_skipped} prodi.`)
        }
        pushToast(event.filename ? 'Scraping selesai dan file Excel tersedia.' : 'Scraping selesai dan database telah diperbarui.', 'success')
        onOutputCreated()
      }
      if (event.type === 'error') {
        cancelStreamRef.current = null
        const cancelled = event.message.toLocaleLowerCase('id-ID').includes('dihentikan')
        setRunState(cancelled ? 'cancelled' : 'error')
        setJobId(null)
        appendLog(cancelled ? 'Proses dihentikan sepenuhnya.' : `Gagal: ${event.message}`)
        pushToast(cancelled ? 'Scraping dibatalkan.' : event.message, cancelled ? 'info' : 'error')
      }
    }, () => appendLog('Koneksi progress terputus. Job tetap berjalan di background.'))
  }

  const runScraper = async () => {
    setConfirmOpen(false)
    setRunState('starting')
    setLogs([])
    setResultFile(null)
    setProgress({ step: 0, current: 0, total: 1, label: 'Menyiapkan sinkronisasi katalog…' })
    try {
      const response = await api.startJob(selectedOrdered)
      setJobId(response.job_id)
      setRunState('running')
      appendLog(`${response.selected_total} program studi masuk antrean.`)
      startStream(response.job_id)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Gagal memulai scraper'
      setRunState('error')
      appendLog(message)
      pushToast(message, 'error')
    }
  }

  const stopScraper = async () => {
    if (!jobId) return
    try {
      await api.stopJob(jobId)
      appendLog('Sinyal berhenti dikirim ke engine. Menunggu proses aktif ditutup…')
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Gagal menghentikan proses', 'error')
    }
  }

  const stateLabel: Record<RunState, string> = {
    idle: databaseOnline === false ? 'PostgreSQL belum siap' : selected.size ? `${selected.size} prodi siap diproses` : 'Pilih program studi',
    starting: 'Menyiapkan job…',
    running: 'Scraping sedang berjalan',
    done: 'Scraping selesai',
    error: 'Proses mengalami kendala',
    cancelled: 'Scraping dibatalkan',
  }

  return (
    <>
      <BlurFade delay={0.04} duration={0.42} offset={8} inView>
        <section className="scrape-overview">
          <div className="scrape-overview-copy">
            <p className="eyebrow">Pengambilan data</p>
            <h2>Siapkan dataset PDDIKTI.</h2>
            <p className="lede">Pilih program studi, jalankan pipeline, lalu simpan hasil yang sudah dideduplikasi ke PostgreSQL dan Excel.</p>
          </div>

          <div className="scrape-overview-metrics" aria-label="Ringkasan scraping">
            <div className="overview-metric">
              <span>Dipilih</span>
              <strong>{selected.size} <small>/ {targets.length || 0}</small></strong>
            </div>
            <div className="overview-metric">
              <span>Output</span>
              <strong className="overview-text-value"><FileSpreadsheet size={16} /> Excel</strong>
            </div>
            <div className={`overview-metric database-overview ${databaseOnline === true ? 'ready' : databaseOnline === false ? 'offline' : ''}`}>
              <span>Database</span>
              <strong className="overview-text-value"><i /> {databaseOnline === true ? 'Ready' : databaseOnline === false ? 'Offline' : 'Checking'}</strong>
            </div>
          </div>
        </section>
      </BlurFade>

      <div className="scrape-layout scrape-layout-v3">
        <BlurFade className="panel-motion-wrap" delay={0.08} duration={0.42} offset={10} inView>
          <section className="panel target-panel target-panel-v3">
            <div className="panel-heading panel-heading-v3">
              <div>
                <span className="step-number">01</span>
                <div><h3>Pilih program studi</h3><p>Tentukan cakupan data yang akan ditarik.</p></div>
              </div>
              <span className="selection-count">{selected.size} dipilih</span>
            </div>

            <label className="search-field search-field-v3">
              <Search size={17} />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Cari dari 21 program studi…" />
              {search && <button type="button" aria-label="Hapus pencarian" onClick={() => setSearch('')}><X size={15} /></button>}
            </label>

            <div className="selection-toolbar selection-toolbar-v3">
              <span>{filteredTargets.length} hasil</span>
              <div>
                <button type="button" disabled={isBusy || !targets.length} onClick={() => setSelected(new Set(targets))}>Pilih semua</button>
                <button type="button" disabled={isBusy || !selected.size} onClick={() => setSelected(new Set())}>Reset</button>
              </div>
            </div>

            {selectedOrdered.length > 0 && (
              <div className="selection-preview" aria-label="Program studi terpilih">
                {selectedPreview.map((item) => <span key={item}>{item}</span>)}
                {selectedOrdered.length > selectedPreview.length && <span className="selection-more">+{selectedOrdered.length - selectedPreview.length}</span>}
              </div>
            )}

            <div className="target-list target-list-v3" aria-busy={loading}>
              {loading && <div className="inline-state"><LoaderCircle className="spin" size={22} /> Memuat whitelist prodi…</div>}
              {loadError && <div className="inline-error"><span>{loadError}</span><button type="button" onClick={() => void loadTargets()}>Coba lagi</button></div>}
              {!loading && !loadError && filteredTargets.map((target) => {
                const checked = selected.has(target)
                return (
                  <button type="button" className={`target-row target-row-v3 ${checked ? 'selected' : ''}`} key={target} aria-pressed={checked} onClick={() => toggleTarget(target)}>
                    <span className="checkbox-box">{checked && <Check size={13} strokeWidth={3} />}</span>
                    <span>{target}</span>
                    <span className="target-row-state">{checked ? <CheckCircle2 size={16} /> : null}</span>
                  </button>
                )
              })}
              {!loading && !loadError && filteredTargets.length === 0 && <div className="inline-state">Tidak ada program studi yang cocok.</div>}
            </div>

            <div className={`safety-note safety-note-v3 ${databaseOnline === false ? 'database-warning' : ''}`}>
              <ShieldCheck size={17} />
              <span>{databaseOnline === false ? 'PostgreSQL harus aktif sebelum scraper dijalankan.' : 'Deduplication aktif — data lama dilewati, record baru disimpan.'}</span>
            </div>
          </section>
        </BlurFade>

        <BlurFade className="panel-motion-wrap" delay={0.12} duration={0.42} offset={10} inView>
          <section className={`panel run-panel run-panel-v3 ${isBusy ? 'is-running' : ''}`}>
            {isBusy && <BorderBeam size={90} duration={7} colorFrom="#00984a" colorTo="#126da3" borderWidth={1} />}

            <div className="run-panel-head">
              <div className="panel-heading panel-heading-v3 run-heading-v3">
                <div>
                  <span className="step-number">02</span>
                  <div><h3>Jalankan pipeline</h3><p>Monitor setiap tahap tanpa meninggalkan halaman.</p></div>
                </div>
              </div>

              <div className="progress-gauge-wrap" aria-label={`Progress ${progressVisible ? progressPercent : 0}%`}>
                <AnimatedCircularProgressBar
                  value={progressVisible ? progressPercent : 0}
                  gaugePrimaryColor="#00984a"
                  gaugeSecondaryColor="rgba(17, 54, 38, 0.08)"
                  className="scrape-progress-gauge"
                />
              </div>
            </div>

            <div className="run-status-strip">
              <div><span className={`run-indicator ${isBusy ? 'active' : ''}`} /><strong>{stateLabel[runState]}</strong></div>
              <span>{isBusy ? `${progress.current} / ${progress.total}` : `${selected.size} target`}</span>
            </div>

            <div className="process-map process-map-v3" aria-label="Tahapan proses">
              {PROCESS_STEPS.map((label, index) => {
                const stepNumber = index + 1
                const complete = progress.step > stepNumber || runState === 'done'
                const current = progress.step === stepNumber && isBusy
                return (
                  <div className={complete ? 'complete' : current ? 'current' : ''} key={label}>
                    <span>{complete ? <Check size={12} /> : stepNumber}</span>
                    <small>{label}</small>
                  </div>
                )
              })}
            </div>

            <div className="progress-block progress-block-v3">
              <div><span>{progress.label}</span><strong>{progressVisible ? `${progressPercent}%` : 'Belum dimulai'}</strong></div>
              <div className="progress-track"><span style={{ width: `${progressVisible ? progressPercent : 0}%` }} /></div>
            </div>

            <div className="run-actions run-actions-v3">
              <button className="button primary wide primary-run-button" type="button" disabled={!selected.size || isBusy || databaseOnline === false} onClick={() => setConfirmOpen(true)}>
                {isBusy ? <LoaderCircle className="spin" size={17} /> : <Play size={17} fill="currentColor" />}
                {isBusy ? 'Sedang memproses…' : selected.size ? `Mulai scraping · ${selected.size} prodi` : 'Pilih prodi untuk mulai'}
              </button>
              {isBusy && <button className="button stop compact-stop-button" type="button" onClick={() => void stopScraper()}><Square size={15} fill="currentColor" /> Batalkan</button>}
              {resultFile && <button className="button success-button result-download-button" type="button" onClick={() => void api.downloadOutput(resultFile)}><Download size={17} /> Unduh Excel</button>}
            </div>

            <div className="terminal-section">
              <div className="terminal-toolbar">
                <div><TerminalSquare size={15} /><span>Live process log</span><i className={isBusy ? 'active' : ''} /></div>
                <div>
                  <button type="button" disabled={!logs.length} onClick={() => { void navigator.clipboard.writeText(logs.join('\n')); pushToast('Log disalin.', 'success') }}><Clipboard size={14} /> Salin</button>
                  <button type="button" disabled={!logs.length || isBusy} onClick={() => setLogs([])}>Bersihkan</button>
                </div>
              </div>
              <Terminal className="scrape-terminal" sequence={false} startOnView={false}>
                {!logs.length ? (
                  <AnimatedSpan delay={0} startOnView={false} className="scrape-terminal-empty">$ menunggu job baru...</AnimatedSpan>
                ) : logs.map((log, index) => (
                  <AnimatedSpan delay={0} startOnView={false} className="scrape-terminal-line" key={`${index}-${log}`}>
                    <span className="terminal-prompt">›</span>{log}
                  </AnimatedSpan>
                ))}
                <span ref={logEndRef} />
              </Terminal>
            </div>
          </section>
        </BlurFade>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Mulai proses scraping?"
        description={`Katalog akan disinkronkan dan data akan diambil untuk ${selected.size} program studi terpilih.`}
        confirmLabel="Ya, mulai scraping"
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => void runScraper()}
      >
        <div className="confirm-list">
          {selectedOrdered.map((item) => <div key={item}><CheckCircle2 size={15} /><span>{item}</span></div>)}
        </div>
      </ConfirmDialog>
    </>
  )
}
