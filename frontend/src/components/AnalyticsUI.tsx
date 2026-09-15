import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, ClipboardCopy, Eye, Search, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { asText } from '../lib/format'
import { useToast } from './Feedback'
import { NumberTicker } from '@/components/vendor/magicui/number-ticker'

export const CHART_COLORS = ['#2563eb', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316', '#84cc16']

const tooltipStyle = {
  border: '1px solid #e2e7e4',
  borderRadius: 10,
  boxShadow: '0 10px 28px rgba(26, 40, 34, .10)',
  fontSize: 12,
  background: '#ffffff',
}

export function MetricCard({ label, value, detail, index }: { label: string; value: string | number; detail?: string; index?: number }) {
  return (
    <article className="analytics-metric analytics-metric-v3" data-metric-index={index ? String(index).padStart(2, '0') : undefined}>
      <div className="metric-card-topline"><small>{label}</small><span>{index ? String(index).padStart(2, '0') : ''}</span></div>
      <strong>{typeof value === 'number' ? <NumberTicker value={value} /> : value}</strong>
      {detail && <p>{detail}</p>}
    </article>
  )
}

export function DistributionChart({
  title,
  subtitle,
  data,
  kind = 'bar',
  limit = 10,
}: {
  title: string
  subtitle: string
  data: Array<{ name: string; value: number }>
  kind?: 'bar' | 'pie'
  limit?: number
}) {
  const visible = data.slice(0, limit)
  const total = visible.reduce((sum, item) => sum + item.value, 0)

  return (
    <article className="chart-card">
      <div className="chart-heading">
        <div>
          <h3>{title}</h3>
          <p>{subtitle}</p>
        </div>
        <span className="chart-total">{total.toLocaleString('id-ID')}</span>
      </div>
      <div className={`chart-container ${kind === 'pie' ? 'pie-container' : ''}`}>
        <ResponsiveContainer width="100%" height="100%">
          {kind === 'pie' ? (
            <PieChart>
              <Pie data={visible} dataKey="value" nameKey="name" innerRadius="58%" outerRadius="80%" paddingAngle={2} stroke="#fff" strokeWidth={2}>
                {visible.map((entry, index) => <Cell key={entry.name} fill={CHART_COLORS[index % CHART_COLORS.length]} />)}
              </Pie>
              <Tooltip contentStyle={tooltipStyle} formatter={(value) => [Number(value).toLocaleString('id-ID'), 'Jumlah']} />
            </PieChart>
          ) : (
            <BarChart data={visible} layout="vertical" margin={{ top: 4, right: 18, bottom: 4, left: 4 }}>
              <CartesianGrid stroke="#edf0ee" horizontal={false} />
              <XAxis type="number" axisLine={false} tickLine={false} tick={{ fill: '#8a9690', fontSize: 11 }} allowDecimals={false} />
              <YAxis type="category" dataKey="name" width={132} axisLine={false} tickLine={false} tick={{ fill: '#56625c', fontSize: 11 }} tickFormatter={(value: string) => value.length > 21 ? `${value.slice(0, 19)}…` : value} />
              <Tooltip contentStyle={tooltipStyle} cursor={{ fill: '#f6f8f7' }} formatter={(value) => [Number(value).toLocaleString('id-ID'), 'Jumlah']} />
              <Bar dataKey="value" fill="#0a8f4e" radius={[0, 4, 4, 0]} maxBarSize={22} />
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
      {kind === 'pie' && (
        <div className="chart-legend">
          {visible.map((item, index) => (
            <div key={item.name}>
              <i style={{ background: CHART_COLORS[index % CHART_COLORS.length] }} />
              <span>{item.name}</span>
              <strong>{item.value.toLocaleString('id-ID')}</strong>
            </div>
          ))}
        </div>
      )}
    </article>
  )
}

function TableValue({ column, value }: { column: string; value: unknown }) {
  const text = asText(value)
  if (column.startsWith('Jumlah ')) return <span className="table-count-badge">{text || '0'}</span>
  if (column === 'ID Dosen PDDIKTI' || column === 'NIDN') return <span className="table-id-value">{text || '—'}</span>
  if (column === 'Jenis Kelamin') return <span className={`table-soft-badge ${text.includes('Perempuan') ? 'rose' : 'blue'}`}>{text || '—'}</span>
  if (column === 'Status Prodi') return <span className={`table-soft-badge ${text.toUpperCase() === 'AKTIF' ? 'green' : 'rose'}`}>{text || '—'}</span>
  if (column === 'DIKTI/DIKTIS' || column === 'PTKIN/NON PTKIN') return <span className="table-soft-badge violet">{text || '—'}</span>
  if (column.includes('Akreditasi')) return <span className="table-soft-badge amber">{text || '—'}</span>
  return <>{text || '—'}</>
}

export function DataTable({ rows, columns, onOpenRow }: {
  rows: Record<string, unknown>[]
  columns: string[]
  onOpenRow?: (row: Record<string, unknown>) => void
}) {
  const { pushToast } = useToast()
  const [pageSize, setPageSize] = useState(20)
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [sort, setSort] = useState<{ column: string; direction: 'asc' | 'desc' } | null>(null)
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const indexedRows = useMemo(() => rows.map((row, index) => ({ row, key: `${asText(row.No)}-${index}` })), [rows])

  const filtered = useMemo(() => {
    const term = query.trim().toLocaleLowerCase('id-ID')
    const matching = indexedRows.filter(({ row }) => {
      if (term && !columns.some((column) => asText(row[column]).toLocaleLowerCase('id-ID').includes(term))) return false
      return columns.every((column) => {
        const filter = (columnFilters[column] ?? '').trim().toLocaleLowerCase('id-ID')
        return !filter || asText(row[column]).toLocaleLowerCase('id-ID').includes(filter)
      })
    })
    if (!sort) return matching
    return [...matching].sort((a, b) => {
      const aValue = asText(a.row[sort.column])
      const bValue = asText(b.row[sort.column])
      const numericA = Number(aValue)
      const numericB = Number(bValue)
      const comparison = Number.isFinite(numericA) && Number.isFinite(numericB)
        ? numericA - numericB
        : aValue.localeCompare(bValue, 'id-ID')
      return sort.direction === 'asc' ? comparison : -comparison
    })
  }, [columnFilters, columns, indexedRows, query, sort])

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const safePage = Math.min(page, pageCount - 1)
  const visibleRows = filtered.slice(safePage * pageSize, (safePage + 1) * pageSize)
  const allPageSelected = visibleRows.length > 0 && visibleRows.every(({ key }) => selected.has(key))

  const toggleSort = (column: string) => {
    setSort((current) => current?.column === column
      ? { column, direction: current.direction === 'asc' ? 'desc' : 'asc' }
      : { column, direction: 'asc' })
  }

  const togglePage = () => setSelected((current) => {
    const next = new Set(current)
    visibleRows.forEach(({ key }) => allPageSelected ? next.delete(key) : next.add(key))
    return next
  })

  const copySelected = async () => {
    const chosen = indexedRows.filter(({ key }) => selected.has(key)).map(({ row }) => row)
    const text = [columns.join('\t'), ...chosen.map((row) => columns.map((column) => asText(row[column])).join('\t'))].join('\n')
    try {
      await navigator.clipboard.writeText(text)
      pushToast(`${chosen.length} baris disalin.`, 'success')
    } catch {
      pushToast('Data terpilih gagal disalin.', 'error')
    }
  }

  return (
    <section className="panel table-panel">
      <div className="table-toolbar">
        <div className="table-title-wrap">
          <div>
            <span className="table-kicker">Dataset</span>
            <h3>Data rinci</h3>
            <p>{filtered.length.toLocaleString('id-ID')} baris ditemukan · {selected.size} dipilih</p>
          </div>
        </div>
        <div className="table-actions">
          <label className="search-field table-search"><Search size={16} /><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(0) }} placeholder="Cari semua kolom…" /></label>
          <button type="button" disabled={!filtered.length} onClick={() => setSelected(new Set(filtered.map(({ key }) => key)))}>Pilih semua</button>
          <button type="button" disabled={!selected.size} onClick={() => void copySelected()}><ClipboardCopy size={14} /> Salin</button>
          <button type="button" disabled={!selected.size} onClick={() => setSelected(new Set())}><X size={14} /> Reset</button>
        </div>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr><th className="select-column"><input type="checkbox" aria-label="Pilih semua di halaman ini" checked={allPageSelected} onChange={togglePage} /></th>{columns.map((column) => <th key={column}><button type="button" onClick={() => toggleSort(column)}>{column}<span>{sort?.column === column ? sort.direction === 'asc' ? '↑' : '↓' : ''}</span></button></th>)}{onOpenRow && <th className="row-action-column">Detail</th>}</tr>
            <tr className="filter-row"><th className="select-column" />{columns.map((column) => <th key={column}><input value={columnFilters[column] ?? ''} onChange={(event) => { setColumnFilters((current) => ({ ...current, [column]: event.target.value })); setPage(0) }} placeholder={`Filter ${column}`} aria-label={`Filter ${column}`} /></th>)}{onOpenRow && <th className="row-action-column" />}</tr>
          </thead>
          <tbody>
            {visibleRows.map(({ row, key }) => <tr key={key} className={selected.has(key) ? 'selected-data-row' : ''}><td className="select-column"><input type="checkbox" checked={selected.has(key)} aria-label="Pilih baris" onChange={() => setSelected((current) => { const next = new Set(current); next.has(key) ? next.delete(key) : next.add(key); return next })} /></td>{columns.map((column) => <td key={column} title={asText(row[column])}><TableValue column={column} value={row[column]} /></td>)}{onOpenRow && <td className="row-action-column"><button className="row-detail-button" type="button" onClick={() => onOpenRow(row)}><Eye size={14} /> Buka</button></td>}</tr>)}
          </tbody>
        </table>
      </div>
      <div className="pagination-row">
        <label>Tampilkan <select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(0) }}><option value={10}>10</option><option value={20}>20</option><option value={50}>50</option><option value={100}>100</option></select> baris</label>
        <span>Halaman {safePage + 1} dari {pageCount}</span>
        <div>
          <button type="button" aria-label="Halaman pertama" disabled={safePage === 0} onClick={() => setPage(0)}><ChevronsLeft size={16} /></button>
          <button type="button" aria-label="Halaman sebelumnya" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}><ChevronLeft size={16} /></button>
          <button type="button" aria-label="Halaman berikutnya" disabled={safePage >= pageCount - 1} onClick={() => setPage(safePage + 1)}><ChevronRight size={16} /></button>
          <button type="button" aria-label="Halaman terakhir" disabled={safePage >= pageCount - 1} onClick={() => setPage(pageCount - 1)}><ChevronsRight size={16} /></button>
        </div>
      </div>
    </section>
  )
}
