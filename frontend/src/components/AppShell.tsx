import {
  BarChart3,
  Database,
  Files,
  GraduationCap,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Server,
  X,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import kneksLogo from '../assets/kneks-logo.png'
import type { PageId } from '../types'

const navigation: Array<{
  id: PageId
  label: string
  eyebrow: string
  icon: typeof Database
}> = [
  { id: 'scrape', label: 'Scraping', eyebrow: 'Koleksi data', icon: Database },
  { id: 'files', label: 'Hasil & riwayat', eyebrow: 'Riwayat database', icon: Files },
  { id: 'dosen', label: 'Analisis dosen', eyebrow: 'Profil SDM', icon: BarChart3 },
  { id: 'prodi', label: 'Analisis prodi', eyebrow: 'Pemetaan institusi', icon: GraduationCap },
]

interface AppShellProps {
  activePage: PageId
  apiOnline: boolean | null
  databaseOnline: boolean | null
  children: ReactNode
  onNavigate: (page: PageId) => void
}

function StatusDot({ online }: { online: boolean | null }) {
  return <span className={`status-dot ${online === false ? 'is-offline' : online === null ? 'is-checking' : ''}`} />
}

export function AppShell({ activePage, apiOnline, databaseOnline, children, onNavigate }: AppShellProps) {
  const [mobileOpen, setMobileOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(() => window.localStorage.getItem('sidebar-collapsed') === '1')
  const current = navigation.find((item) => item.id === activePage) ?? navigation[0]

  const toggleCollapsed = () => {
    setCollapsed((currentValue) => {
      const nextValue = !currentValue
      window.localStorage.setItem('sidebar-collapsed', nextValue ? '1' : '0')
      return nextValue
    })
  }

  const navigate = (page: PageId) => {
    onNavigate(page)
    setMobileOpen(false)
  }

  return (
    <div className={`app-shell ${collapsed ? 'sidebar-collapsed' : ''}`}>
      <button
        className="mobile-menu-button"
        type="button"
        aria-label="Buka menu"
        onClick={() => setMobileOpen(true)}
      >
        <Menu size={20} />
      </button>

      {mobileOpen && (
        <button
          type="button"
          className="sidebar-scrim"
          aria-label="Tutup menu"
          onClick={() => setMobileOpen(false)}
        />
      )}

      <aside className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`}>
        <div className="brand-lockup">
          <img src={kneksLogo} alt="KNEKS" className="brand-logo" />
          <button className="sidebar-collapse" type="button" aria-label={collapsed ? 'Perluas sidebar' : 'Ciutkan sidebar'} onClick={toggleCollapsed}>
            {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </button>
          <button
            className="sidebar-close"
            type="button"
            aria-label="Tutup menu"
            onClick={() => setMobileOpen(false)}
          >
            <X size={18} />
          </button>
        </div>

        <div className="workspace-caption">
          <span>Data workspace</span>
          <strong>PDDIKTI Scraper</strong>
        </div>

        <nav className="sidebar-nav" aria-label="Navigasi utama">
          {navigation.map(({ id, label, eyebrow, icon: Icon }) => (
            <button
              type="button"
              key={id}
              title={collapsed ? label : undefined}
              className={activePage === id ? 'nav-link active' : 'nav-link'}
              onClick={() => navigate(id)}
            >
              <Icon className="nav-icon" size={18} />
              <span className="nav-copy">
                <strong>{label}</strong>
                <small>{eyebrow}</small>
              </span>
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="system-card">
            <div className="system-card-heading"><Server size={14} /><span>System status</span></div>
            <div className="api-state">
              <StatusDot online={apiOnline} />
              <div>
                <strong>{apiOnline === null ? 'Memeriksa API' : apiOnline ? 'API aktif' : 'API terputus'}</strong>
                <small>Flask · localhost:5000</small>
              </div>
            </div>
            <div className="api-state database-state">
              <StatusDot online={databaseOnline} />
              <div>
                <strong>{databaseOnline === null ? 'Memeriksa database' : databaseOnline ? 'PostgreSQL aktif' : 'PostgreSQL belum siap'}</strong>
                <small>Sumber data utama</small>
              </div>
            </div>
          </div>
          <div className="version-row"><span>KNEKS</span><span>v2.0</span></div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="topbar-title">
            <span className="topbar-overline">PDDIKTI / {current.eyebrow}</span>
            <h1>{current.label}</h1>
          </div>
          <div className="topbar-actions" aria-label="Status sistem">
            <div className="topbar-status"><StatusDot online={apiOnline} /><span>API</span></div>
            <div className="topbar-status"><StatusDot online={databaseOnline} /><span>PostgreSQL</span></div>
          </div>
        </header>
        <div className="page-content">{children}</div>
      </main>
    </div>
  )
}
