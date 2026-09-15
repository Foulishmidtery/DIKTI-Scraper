import { HoverBorderGradient } from '@/components/vendor/aceternity/hover-border-gradient'
import { NumberTicker } from '@/components/vendor/magicui/number-ticker'
import AnimatedContent from '@/components/vendor/react-bits/AnimatedContent'
import { BookOpen, ChevronLeft, ChevronRight, Database, Eye, GraduationCap, LoaderCircle, RefreshCw, Search, UserRound, X } from 'lucide-react'
import { Fragment, memo, startTransition, useCallback, useEffect, useMemo, useState } from 'react'
import { DataTable, DistributionChart, MetricCard } from '../components/AnalyticsUI'
import { EmptyState } from '../components/EmptyState'
import { useToast } from '../components/Feedback'
import { api } from '../lib/api'
import { asNumber, countBy } from '../lib/format'
import type { AnalysisResponse } from '../types'

const DOSEN_COLUMNS = ['ID Dosen PDDIKTI', 'NIDN', 'Nama', 'Perguruan Tinggi', 'Jabatan Fungsional', 'Jenis Kelamin', 'Pendidikan Terakhir', 'Status Kepegawaian', 'Jenjang', 'Jumlah Riwayat Pendidikan', 'Jumlah Riwayat Mengajar']
const PRODI_COLUMNS = ['Nama Prodi', 'Jenjang', 'Perguruan Tinggi', 'Status Prodi', 'DIKTI/DIKTIS', 'PTKIN/NON PTKIN', 'Akreditasi Program Studi', 'Berlaku Sampai Akreditasi', 'Jumlah Dosen', 'Provinsi']

const percentage = (part: number, total: number) => total ? `${((part / total) * 100).toFixed(1)}%` : '0%'
const MemoMetricCard = memo(MetricCard)
const MemoDistributionChart = memo(DistributionChart)
const MemoDataTable = memo(DataTable)

export function AnalyticsPage({ type, revision }: { type: 'dosen' | 'prodi'; revision: number }) {
  const { pushToast } = useToast()
  const [analysis, setAnalysis] = useState<AnalysisResponse | null>(null)
  const [loadingAnalysis, setLoadingAnalysis] = useState(true)
  const [error, setError] = useState('')
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')

  const loadAnalysis = useCallback(async () => {
    setLoadingAnalysis(true)
    setError('')
    try {
      setAnalysis(await api.analytics())
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Gagal membaca analitik PostgreSQL'
      setError(message)
      setAnalysis(null)
      pushToast(message, 'error')
    } finally {
      setLoadingAnalysis(false)
    }
  }, [pushToast])

  useEffect(() => { void loadAnalysis() }, [loadAnalysis, revision])

  const openDosenDetail = useCallback(async (row: Record<string, unknown>) => {
    setDetailLoading(true)
    setDetailError('')
    setDetail({ ...row })
    try {
      const response = await api.dosenDetail(String(row['ID Dosen PDDIKTI'] ?? ''), String(row.NIDN ?? ''))
      startTransition(() => setDetail(response.data))
    } catch (reason) {
      setDetailError(reason instanceof Error ? reason.message : 'Detail dosen gagal dimuat')
    } finally {
      setDetailLoading(false)
    }
  }, [])

  const openProdiDetail = useCallback(async (row: Record<string, unknown>) => {
    setDetailLoading(true)
    setDetailError('')
    setDetail({ ...row })
    try {
      const response = await api.prodiDetail(
        String(row['ID Prodi PDDIKTI'] ?? ''),
        String(row['Nama Prodi'] ?? ''),
        String(row.Jenjang ?? ''),
        String(row['Perguruan Tinggi'] ?? ''),
      )
      startTransition(() => setDetail(response.data))
    } catch (reason) {
      setDetailError(reason instanceof Error ? reason.message : 'Detail program studi gagal dimuat')
    } finally {
      setDetailLoading(false)
    }
  }, [])

  const rawRows = type === 'dosen' ? analysis?.dosen ?? [] : analysis?.prodi ?? []
  const rows = useMemo(() => type === 'prodi'
    ? rawRows.map((row) => ({
        ...row,
        'Akreditasi Program Studi': ({ A: 'Unggul', B: 'Baik Sekali', C: 'Baik' } as Record<string, string>)[String(row['Akreditasi Program Studi'] ?? '')] ?? row['Akreditasi Program Studi'],
      }))
    : rawRows, [rawRows, type])

  const view = useMemo(() => type === 'dosen' ? buildDosenView(rows) : buildProdiView(rows), [rows, type])

  return (
    <>
      <section className="analytics-page-heading">
        <div>
          <span className="page-kicker">Analytics workspace</span>
          <h2>{type === 'dosen' ? 'Analisis tenaga pengajar' : 'Analisis program studi'}</h2>
          <p>{type === 'dosen'
            ? 'Ringkasan komposisi dosen, pendidikan, jabatan, status kerja, dan institusi.'
            : 'Ringkasan persebaran program studi, institusi, akreditasi, wilayah, dan pelaporan.'}</p>
        </div>
        <HoverBorderGradient
          as="div"
          duration={2.2}
          containerClassName="refresh-gradient-shell"
          className="refresh-gradient-inner"
        >
          <button className="refresh-original-button" type="button" onClick={() => void loadAnalysis()}>
            <RefreshCw className={loadingAnalysis ? 'spin' : ''} size={15} />
            Segarkan
          </button>
        </HoverBorderGradient>
      </section>

      <section className="data-source-bar">
        <div className="data-source-icon"><Database size={18} /></div>
        <div className="database-source-copy">
          <span>Sumber data</span>
          <strong>PostgreSQL</strong>
          <small>{analysis
            ? `${analysis.metadata.total_dosen.toLocaleString('id-ID')} dosen · ${analysis.metadata.total_prodi.toLocaleString('id-ID')} prodi`
            : 'Menunggu koneksi database'}</small>
        </div>
        <span className={`source-state ${analysis ? 'ready' : ''}`}><i />{analysis ? 'Live dataset' : 'Connecting'}</span>
      </section>

      {loadingAnalysis && <div className="analytics-loading"><LoaderCircle className="spin" size={24} /><strong>Menyiapkan analisis</strong><span>Membaca dataset terbaru dari PostgreSQL.</span></div>}
      {!loadingAnalysis && error && <EmptyState title="Analisis belum dapat ditampilkan" description={error} action={<button className="button secondary" type="button" onClick={() => void loadAnalysis()}>Coba lagi</button>} />}
      {!loadingAnalysis && !error && analysis && !rows.length && <EmptyState title="Database masih kosong" description="Jalankan scraper atau impor file Excel lama untuk menambahkan data pertama." />}

      {!loadingAnalysis && !error && analysis && rows.length > 0 && (
        <>
          <AnimatedContent distance={14} duration={0.38} initialOpacity={0.9} threshold={0.04}>
            <div className="analytics-metric-grid">
              {view.metrics.map((metric, index) => <MemoMetricCard key={metric.label} index={index + 1} {...metric} />)}
            </div>
          </AnimatedContent>
          <div className="section-heading-inline">
            <div><span>Distribusi</span><h3>Pola utama pada dataset</h3></div>
            <small><NumberTicker value={view.charts.length} className="visual-count-ticker" /> visualisasi</small>
          </div>
          <AnimatedContent distance={12} duration={0.42} initialOpacity={0.94} threshold={0.04}>
            <div className="chart-grid">
              {view.charts.map((chart) => <MemoDistributionChart key={chart.title} {...chart} />)}
            </div>
          </AnimatedContent>
          <AnimatedContent distance={10} duration={0.4} initialOpacity={0.96} threshold={0.03}>
            <MemoDataTable key={`${type}-${revision}`} rows={rows} columns={type === 'dosen' ? DOSEN_COLUMNS : PRODI_COLUMNS} onOpenRow={type === 'dosen' ? openDosenDetail : openProdiDetail} />
          </AnimatedContent>
        </>
      )}
      {detail && (
        <div className="dosen-detail-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDetail(null) }}>
          <aside className={`dosen-detail-drawer ${type === 'prodi' ? 'prodi-detail-drawer' : ''}`} role="dialog" aria-modal="true" aria-label={type === 'dosen' ? 'Detail lengkap dosen' : 'Detail lengkap program studi'}>
            <header className="dosen-detail-hero">
              <div className="dosen-avatar">{type === 'dosen' ? <UserRound size={28} /> : <GraduationCap size={28} />}</div>
              <div>
                <span>{type === 'dosen' ? 'Profil dosen PDDIKTI' : 'Profil program studi PDDIKTI'}</span>
                <h3>{String(type === 'dosen' ? detail.Nama ?? 'Detail dosen' : detail.nama ?? detail['Nama Prodi'] ?? 'Detail prodi')}</h3>
                <p>{type === 'dosen'
                  ? `${String(detail['Program Studi'] ?? '—')} · ${String(detail['Perguruan Tinggi'] ?? '—')}`
                  : `${String(detail.jenjang ?? detail.Jenjang ?? '—')} · ${String(detail.pt ?? detail['Perguruan Tinggi'] ?? '—')}`}</p>
              </div>
              <button type="button" aria-label="Tutup detail" onClick={() => setDetail(null)}><X size={19} /></button>
            </header>
            <div className="dosen-detail-body">
              {type === 'dosen' ? <div className="identity-chip-row">
                <span>ID PDDIKTI <strong>{String(detail['ID Dosen PDDIKTI'] ?? '—')}</strong></span>
                <span>NIDN <strong>{String(detail.NIDN ?? '—')}</strong></span>
                <span>NUPTK <strong>{String(detail.NUPTK ?? '—')}</strong></span>
              </div> : <div className="identity-chip-row">{[
                ['Kode prodi', detail.kode_prodi ?? detail['Kode Prodi']],
                ['Status', detail.keterangan ?? detail['Status Prodi']],
                ['DIKTI/DIKTIS', detail.dikti_diktis ?? detail['DIKTI/DIKTIS']],
              ].filter(([, value]) => String(value ?? '').trim()).map(([label, value]) => <span key={String(label)}>{String(label)} <strong>{String(value)}</strong></span>)}</div>}
              {type === 'dosen' && <DetailOverview data={detail} />}
              {detailLoading && <div className="detail-loading" aria-live="polite"><div className="detail-skeleton"><i /><i /><i /><i /></div><span><LoaderCircle className="spin" size={18} /> {type === 'dosen' ? 'Melengkapi riwayat dosen…' : 'Memuat detail program studi…'}</span></div>}
              {detailError && <div className="detail-error">{detailError}</div>}
              {!detailLoading && !detailError && type === 'dosen' && (
                <>
                  <div className="detail-stat-grid">
                    <div><GraduationCap size={18} /><span>Pendidikan</span><strong>{Number(detail['Jumlah Riwayat Pendidikan'] ?? 0).toLocaleString('id-ID')}</strong></div>
                    <div><BookOpen size={18} /><span>Pengajaran</span><strong>{Number(detail['Jumlah Riwayat Mengajar'] ?? 0).toLocaleString('id-ID')}</strong></div>
                    <div><Database size={18} /><span>Sertifikasi</span><strong>{Number(detail['Jumlah Sertifikasi'] ?? 0).toLocaleString('id-ID')}</strong></div>
                  </div>
                  <DetailCollection title="Riwayat pendidikan" value={detail['Riwayat Pendidikan']} />
                  <TeachingHistory value={detail['Riwayat Mengajar']} />
                  <DetailCollection title="Sertifikasi" value={detail.Sertifikasi} empty="Belum tersedia pada endpoint publik PDDIKTI." />
                </>
              )}
              {!detailLoading && !detailError && type === 'prodi' && <ProdiDetail data={detail} />}
            </div>
          </aside>
        </div>
      )}
    </>
  )
}

function DetailOverview({ data }: { data: Record<string, unknown> }) {
  const fields = ['Jabatan Fungsional', 'Jenis Kelamin', 'Pendidikan Terakhir', 'Status Aktifitas', 'Status Ikatan Kerja', 'Status Kepegawaian', 'Jenjang', 'Semester Data']
  return <section className="detail-overview"><h4>Ringkasan profil</h4><div>{fields.map((field) => <span key={field}><small>{field}</small><strong>{String(data[field] ?? '—')}</strong></span>)}</div></section>
}

function formatProdiDate(value: unknown) {
  const raw = String(value ?? '').trim()
  if (!raw) return '—'
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/)
  if (!iso) return raw
  const date = new Date(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00Z`)
  return Number.isNaN(date.getTime())
    ? raw
    : new Intl.DateTimeFormat('id-ID', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date)
}

function prodiCount(row: Record<string, unknown> | undefined, keys: string[]) {
  for (const key of keys) {
    const raw = row?.[key]
    if (raw === null || raw === undefined || String(raw).trim() === '') continue
    const parsed = Number(String(raw).replace(/\.(?=\d{3}(?:\D|$))/g, '').replace(',', '.'))
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function ProdiDetail({ data }: { data: Record<string, unknown> }) {
  const semesterRows = (Array.isArray(data.statistik_semester) ? data.statistik_semester : [])
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .sort((left, right) => Number(String(right.semester ?? right.id_smt ?? '').replace(/\D/g, '')) - Number(String(left.semester ?? left.id_smt ?? '').replace(/\D/g, '')))
  const latestUseful = semesterRows.find((row) => prodiCount(row, ['jumlah_mahasiswa', 'total_mahasiswa', 'jml_mhs', 'mahasiswa']) > 0 || prodiCount(row, ['jumlah_dosen', 'total_dosen', 'jml_dosen', 'dosen', 'jumlah_dosen_ajar']) > 0) ?? semesterRows[0]
  const directDosen = prodiCount(data, ['jumlah_dosen_pddikti', 'jumlah_dosen'])
  const directMahasiswa = prodiCount(data, ['jumlah_mahasiswa', 'total_mahasiswa'])
  const jumlahDosen = directDosen || prodiCount(latestUseful, ['jumlah_dosen', 'total_dosen', 'jml_dosen', 'dosen', 'jumlah_dosen_ajar'])
  const jumlahMahasiswa = directMahasiswa || prodiCount(latestUseful, ['jumlah_mahasiswa', 'total_mahasiswa', 'jml_mhs', 'mahasiswa'])
  const semesterSumber = String(latestUseful?.semester ?? latestUseful?.id_smt ?? '').trim()
  const suppliedRatio = String(data.rasio_dosen_mahasiswa ?? '').trim()
  const rasio = suppliedRatio && !['0', '-', '—'].includes(suppliedRatio)
    ? suppliedRatio
    : jumlahDosen > 0 && jumlahMahasiswa > 0
      ? `1 : ${Math.round(jumlahMahasiswa / jumlahDosen).toLocaleString('id-ID')}`
      : '—'
  const overview = [
    ['Status prodi', data.keterangan],
    ['DIKTI/DIKTIS', data.dikti_diktis],
    ['PTKIN/NON PTKIN', data.ptkin_non],
    ['PTN/PTS', data.ptn_pts],
    ['Bidang ilmu', data.kelompok_bidang],
    ['Provinsi', data.provinsi],
    ['Kabupaten/Kota', data.kabupaten_kota],
    ['Semester laporan', data.semester_lapor],
  ]
  const legal = [
    ['Tanggal berdiri', formatProdiDate(data.tanggal_berdiri)],
    ['Nomor SK penyelenggaraan', data.nomor_sk_penyelenggaraan],
    ['Tanggal SK penyelenggaraan', formatProdiDate(data.tanggal_sk_penyelenggaraan)],
    ['Akreditasi PDDIKTI', data.akreditasi],
    ['Peringkat BAN-PT', data.peringkat_akreditasi_banpt],
    ['Lembaga nasional', data.lembaga_akreditasi_nasional ?? data.sumber_akreditasi],
    ['Peringkat nasional', data.peringkat_akreditasi_nasional ?? data.peringkat_akreditasi_banpt],
    ['Nomor SK akreditasi', data.nomor_sk_akreditasi],
    ['Tanggal SK akreditasi', formatProdiDate(data.tanggal_sk_akreditasi)],
    ['Status berlaku SK', data.status_berlaku_sk_akreditasi],
    ['Berlaku sampai', formatProdiDate(data.tanggal_akhir_akreditasi)],
    ['Status verifikasi', data.status_pencocokan_akreditasi],
    ['Akreditasi internasional', data.akreditasi_internasional],
  ]
  const contact = [
    ['Alamat', data.alamat],
    ['Kecamatan', data.kecamatan],
    ['Telepon', data.telepon],
    ['Email', data.email],
    ['Website', data.website],
    ['Pembina', data.pembina],
  ]
  return <>
    <section className="detail-overview prodi-overview"><h4>Identitas dan klasifikasi</h4><div>{overview.map(([label, value]) => <span key={String(label)}><small>{String(label)}</small><strong>{String(value ?? '—') || '—'}</strong></span>)}</div></section>
    <section className="prodi-accreditation-card">
      <div><span>Akreditasi</span><strong>{String(data.peringkat_akreditasi_nasional ?? data.peringkat_akreditasi_banpt ?? data.akreditasi ?? '—') || '—'}</strong></div>
      <div><span>Berlaku sampai</span><strong>{formatProdiDate(data.tanggal_akhir_akreditasi) === '—' ? 'Belum tersedia' : formatProdiDate(data.tanggal_akhir_akreditasi)}</strong></div>
      <small>{String(data.sumber_akreditasi ?? 'PDDIKTI')} · {String(data.status_pencocokan_akreditasi ?? 'belum diverifikasi')}</small>
    </section>
    <div className="detail-stat-grid prodi-stat-grid">
      <div><UserRound size={18} /><span>Dosen</span><strong>{jumlahDosen > 0 ? jumlahDosen.toLocaleString('id-ID') : 'Belum tersedia'}</strong></div>
      <div><GraduationCap size={18} /><span>Mahasiswa</span><strong>{jumlahMahasiswa > 0 ? jumlahMahasiswa.toLocaleString('id-ID') : 'Belum tersedia'}</strong></div>
      <div><Database size={18} /><span>Rasio</span><strong>{rasio}</strong></div>
    </div>
    <small className="prodi-stat-source">Sumber statistik: {semesterSumber ? `semester ${semesterSumber}` : 'detail PDDIKTI terbaru'}</small>
    <DetailKeyValues title="Legalitas dan akreditasi" rows={legal} />
    <DetailCollection title="Akreditasi internasional terverifikasi" value={data.akreditasi_internasional_terverifikasi} />
    <AccreditationHistory value={data.riwayat_akreditasi_banpt} />
    {Array.isArray(data.riwayat_perubahan_scraping) && data.riwayat_perubahan_scraping.length > 0 &&
      <DetailCollection title="Perubahan akreditasi antar-scraping" value={data.riwayat_perubahan_scraping} />}
    <DetailKeyValues title="Alamat dan kontak" rows={contact} />
    <DetailText title="Deskripsi" value={data.deskripsi_singkat} />
    <DetailText title="Visi" value={data.visi} />
    <DetailText title="Misi" value={data.misi} />
    <DetailText title="Kompetensi" value={data.kompetensi} />
    <ProdiSemesterHistory value={data.statistik_semester} />
  </>
}

function AccreditationHistory({ value }: { value: unknown }) {
  const rows = Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object') : []
  return <details className="detail-section teaching-history">
    <summary><span>Riwayat keputusan akreditasi BAN-PT</span><strong>{rows.length.toLocaleString('id-ID')}</strong></summary>
    {!rows.length ? <p className="detail-empty">Riwayat keputusan belum tersedia dari sumber publik BAN-PT.</p> :
      <div className="teaching-table-wrap"><table><thead><tr><th>Tanggal SK</th><th>Peringkat</th><th>Berlaku sampai</th><th>Status SK</th></tr></thead><tbody>
        {[...rows].reverse().map((row, index) => <tr key={`${String(row.tanggal_sk)}-${index}`}>
          <td>{formatProdiDate(row.tanggal_sk)}</td><td>{String(row.peringkat ?? '—')}</td>
          <td>{formatProdiDate(row.berlaku_sampai)}</td><td>{String(row.status_berlaku_sk ?? '—')}</td>
        </tr>)}
      </tbody></table></div>}
  </details>
}

function DetailKeyValues({ title, rows }: { title: string; rows: unknown[][] }) {
  return <details className="detail-section"><summary><span>{title}</span><strong>{rows.filter(([, value]) => String(value ?? '').trim()).length}</strong></summary><div className="detail-record-list"><article><div>{rows.map(([label, value]) => <span key={String(label)}><small>{String(label)}</small><strong>{String(value ?? '—') || '—'}</strong></span>)}</div></article></div></details>
}

function DetailText({ title, value }: { title: string; value: unknown }) {
  const text = String(value ?? '').trim()
  return <details className="detail-section"><summary><span>{title}</span><strong>{text ? 'Ada' : '—'}</strong></summary><p className="prodi-detail-text">{text || 'Belum tersedia.'}</p></details>
}

function ProdiSemesterHistory({ value }: { value: unknown }) {
  const rows = Array.isArray(value) ? value : []
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState(1)
  const pageSize = 8
  const pages = Math.max(1, Math.ceil(rows.length / pageSize))
  const visible = open ? rows.slice((page - 1) * pageSize, page * pageSize) : []
  return <details className="detail-section teaching-history" open={open} onToggle={(event) => { setOpen(event.currentTarget.open); if (!event.currentTarget.open) setPage(1) }}>
    <summary><span>Statistik mahasiswa dan dosen per semester</span><strong>{rows.length.toLocaleString('id-ID')}</strong></summary>
    {open && !rows.length && <p className="detail-empty">Statistik semester belum tersedia.</p>}
    {open && !!rows.length && <><div className="teaching-table-wrap"><table><thead><tr><th>Semester</th><th>Mahasiswa</th><th>Dosen</th><th>Dosen ajar</th></tr></thead><tbody>{visible.map((item, index) => {
      const row = item && typeof item === 'object' ? item as Record<string, unknown> : {}
      return <tr key={`${String(row.semester)}-${index}`}><td>{String(row.semester ?? '—')}</td><td>{Number(row.jumlah_mahasiswa ?? 0).toLocaleString('id-ID')}</td><td>{Number(row.jumlah_dosen ?? 0).toLocaleString('id-ID')}</td><td>{Number(row.jumlah_dosen_ajar ?? 0).toLocaleString('id-ID')}</td></tr>
    })}</tbody></table></div><div className="teaching-pagination"><span>{rows.length.toLocaleString('id-ID')} semester</span><div><button type="button" disabled={page === 1} onClick={() => setPage((current) => current - 1)}><ChevronLeft size={15} /></button><strong>{page} / {pages}</strong><button type="button" disabled={page === pages} onClick={() => setPage((current) => current + 1)}><ChevronRight size={15} /></button></div></div></>}
  </details>
}

function DetailCollection({ title, value, empty = 'Tidak ada data.' }: { title: string; value: unknown; empty?: string }) {
  const [open, setOpen] = useState(false)
  const rows = Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : []
  return (
    <details className="detail-section" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary><span>{title}</span><strong>{rows.length.toLocaleString('id-ID')}</strong></summary>
      {open && !rows.length && <p className="detail-empty">{empty}</p>}
      {open && <div className="detail-record-list">{rows.map((row, index) => {
        const record: Record<string, unknown> = row && typeof row === 'object' ? row as Record<string, unknown> : { Nilai: row }
        return <article key={`${title}-${index}`}><b>{String(record.nama_matkul ?? record.nama_prodi ?? record.nama_pt ?? `${title} ${index + 1}`)}</b><div>{Object.entries(record).filter(([key]) => !['id_sdm', 'id_reg_ptk'].includes(key.toLowerCase())).map(([key, item]) => <span key={key}><small>{key.replaceAll('_', ' ')}</small><strong>{typeof item === 'object' ? JSON.stringify(item) : String(item ?? '—')}</strong></span>)}</div></article>
      })}</div>}
    </details>
  )
}

function TeachingHistory({ value }: { value: unknown }) {
  const rows = useMemo(() => Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [], [value])
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [open, setOpen] = useState(false)
  const pageSize = 10
  const filtered = useMemo(() => open ? rows.filter((row) => JSON.stringify(row).toLocaleLowerCase('id-ID').includes(query.trim().toLocaleLowerCase('id-ID'))) : [], [open, query, rows])
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const visible = filtered.slice((page - 1) * pageSize, page * pageSize)
  useEffect(() => { setPage(1); setExpanded(null) }, [query, value])
  const pick = (record: Record<string, unknown>, keys: string[]) => String(keys.map((key) => record[key]).find((item) => item !== undefined && item !== null && item !== '') ?? '—')

  return (
    <details className="detail-section teaching-history" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary><span>Riwayat mengajar</span><strong>{rows.length.toLocaleString('id-ID')}</strong></summary>
      {open && <><div className="teaching-toolbar"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Cari mata kuliah, semester, atau prodi…" /></div>
      {!filtered.length && <p className="detail-empty">Riwayat mengajar tidak ditemukan.</p>}
      {!!filtered.length && <div className="teaching-table-wrap"><table><thead><tr><th>Mata kuliah</th><th>Semester</th><th>Prodi / PT</th><th /></tr></thead><tbody>
        {visible.map((row, index) => {
          const record = row && typeof row === 'object' ? row as Record<string, unknown> : { Nilai: row }
          const absoluteIndex = (page - 1) * pageSize + index
          const prodi = pick(record, ['nama_prodi', 'nm_prodi', 'program_studi'])
          const perguruanTinggi = pick(record, ['nama_pt', 'nm_pt', 'perguruan_tinggi'])
          return <Fragment key={absoluteIndex}>
            <tr><td>{pick(record, ['nama_matkul', 'nama_mata_kuliah', 'mata_kuliah'])}</td><td>{pick(record, ['nama_semester', 'id_smt', 'semester', 'semester_data', 'nm_smt'])}</td><td><b>{prodi === '—' ? perguruanTinggi : prodi}</b>{prodi !== '—' && <small>{perguruanTinggi}</small>}</td><td><button type="button" onClick={() => setExpanded(expanded === absoluteIndex ? null : absoluteIndex)} title="Lihat detail"><Eye size={15} /></button></td></tr>
            {expanded === absoluteIndex && <tr className="teaching-expanded"><td colSpan={4}><div>{Object.entries(record).filter(([key]) => !['id_sdm', 'id_reg_ptk'].includes(key.toLowerCase())).map(([key, item]) => <span key={key}><small>{key.replaceAll('_', ' ')}</small><strong>{typeof item === 'object' ? JSON.stringify(item) : String(item ?? '—')}</strong></span>)}</div></td></tr>}
          </Fragment>
        })}
      </tbody></table></div>}
      {!!filtered.length && <div className="teaching-pagination"><span>{filtered.length.toLocaleString('id-ID')} data</span><div><button type="button" disabled={page === 1} onClick={() => setPage((current) => current - 1)}><ChevronLeft size={15} /></button><strong>{page} / {pages}</strong><button type="button" disabled={page === pages} onClick={() => setPage((current) => current + 1)}><ChevronRight size={15} /></button></div></div>}</>}
    </details>
  )
}

function buildDosenView(rows: Record<string, unknown>[]) {
  const total = rows.length
  const male = rows.filter((row) => String(row['Jenis Kelamin'] ?? '').includes('Laki')).length
  const female = rows.filter((row) => String(row['Jenis Kelamin'] ?? '').includes('Perempuan')).length
  const s3 = rows.filter((row) => row['Pendidikan Terakhir'] === 'S3').length
  const professors = rows.filter((row) => row['Jabatan Fungsional'] === 'Profesor').length
  const permanent = rows.filter((row) => String(row['Status Ikatan Kerja'] ?? '').includes('Dosen Tetap')).length
  return {
    metrics: [
      { label: 'Total dosen', value: total.toLocaleString('id-ID'), detail: 'Tersimpan di PostgreSQL' },
      { label: 'Perempuan', value: female.toLocaleString('id-ID'), detail: `${percentage(female, total)} dari total` },
      { label: 'Laki-laki', value: male.toLocaleString('id-ID'), detail: `${percentage(male, total)} dari total` },
      { label: 'Doktor (S3)', value: percentage(s3, total), detail: `${s3.toLocaleString('id-ID')} dosen` },
      { label: 'Profesor', value: percentage(professors, total), detail: `${professors.toLocaleString('id-ID')} dosen` },
      { label: 'Dosen tetap', value: percentage(permanent, total), detail: `${permanent.toLocaleString('id-ID')} dosen` },
    ],
    charts: [
      { title: 'Komposisi gender', subtitle: 'Sebaran dosen berdasarkan jenis kelamin', data: countBy(rows, 'Jenis Kelamin'), kind: 'pie' as const },
      { title: 'Pendidikan terakhir', subtitle: 'Jenjang pendidikan tertinggi', data: countBy(rows, 'Pendidikan Terakhir') },
      { title: 'Jabatan fungsional', subtitle: 'Distribusi jenjang jabatan akademik', data: countBy(rows, 'Jabatan Fungsional') },
      { title: 'Status kepegawaian', subtitle: 'Kelompok status kepegawaian dosen', data: countBy(rows, 'Status Kepegawaian') },
      { title: 'Perguruan tinggi teratas', subtitle: '10 institusi dengan dosen terbanyak', data: countBy(rows, 'Perguruan Tinggi') },
      { title: 'Status aktivitas', subtitle: 'Kondisi aktivitas dosen saat data diambil', data: countBy(rows, 'Status Aktifitas') },
      { title: 'Ikatan kerja', subtitle: 'Sebaran hubungan kerja dosen', data: countBy(rows, 'Status Ikatan Kerja'), kind: 'pie' as const },
    ],
  }
}

function buildProdiView(rows: Record<string, unknown>[]) {
  const total = rows.length
  const institutions = new Set(rows.map((row) => String(row['Perguruan Tinggi'] ?? '')).filter(Boolean)).size
  const totalLecturers = rows.reduce((sum, row) => sum + asNumber(row['Jumlah Dosen']), 0)
  const excellent = rows.filter((row) => row['Akreditasi Program Studi'] === 'Unggul').length
  const notReported = rows.filter((row) => String(row['Semester Laporan Terakhir'] ?? '').toLocaleLowerCase('id-ID').includes('belum')).length
  return {
    metrics: [
      { label: 'Total prodi', value: total.toLocaleString('id-ID'), detail: 'Tersimpan di PostgreSQL' },
      { label: 'Perguruan tinggi', value: institutions.toLocaleString('id-ID'), detail: 'Institusi unik' },
      { label: 'Rata-rata dosen', value: total ? (totalLecturers / total).toFixed(1) : '0', detail: 'Per program studi' },
      { label: 'Akreditasi unggul', value: percentage(excellent, total), detail: `${excellent.toLocaleString('id-ID')} prodi` },
      { label: 'Belum melapor', value: percentage(notReported, total), detail: `${notReported.toLocaleString('id-ID')} prodi` },
    ],
    charts: [
      { title: 'Akreditasi program studi', subtitle: 'Komposisi peringkat akreditasi', data: countBy(rows, 'Akreditasi Program Studi'), kind: 'pie' as const },
      { title: 'Jenjang pendidikan', subtitle: 'Sebaran prodi menurut jenjang', data: countBy(rows, 'Jenjang') },
      { title: 'Provinsi teratas', subtitle: '10 wilayah dengan prodi terbanyak', data: countBy(rows, 'Provinsi') },
      { title: 'Status perguruan tinggi', subtitle: 'Perbandingan PTN dan PTS', data: countBy(rows, 'PTN/PTS'), kind: 'pie' as const },
      { title: 'Klasifikasi PTKIN', subtitle: 'Kelompok PTKIN dan non-PTKIN', data: countBy(rows, 'PTKIN/NON PTKIN'), kind: 'pie' as const },
      { title: 'Pengelola data', subtitle: 'Klasifikasi DIKTI dan DIKTIS', data: countBy(rows, 'DIKTI/DIKTIS'), kind: 'pie' as const },
      { title: 'Pelaporan semester', subtitle: 'Status laporan terakhir program studi', data: countBy(rows.map((row) => ({ status: String(row['Semester Laporan Terakhir'] ?? '').toLocaleLowerCase('id-ID').includes('belum') ? 'Belum lapor' : 'Sudah lapor' })), 'status'), kind: 'pie' as const },
    ],
  }
}
