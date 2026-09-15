import type { ReactNode } from 'react'

interface KpiCardProps {
  label: string
  value: ReactNode
  caption?: string
  index?: number
}

export function KpiCard({ label, value, caption, index }: KpiCardProps) {
  return (
    <article className="local-kpi-card">
      <header>
        <small>{label}</small>
        {index != null && <span>{String(index).padStart(2, '0')}</span>}
      </header>
      <strong>{value}</strong>
      <footer><i aria-hidden="true" />{caption || 'Data PostgreSQL terkini'}</footer>
    </article>
  )
}
