import { lazy, Suspense, useEffect, useState } from 'react'
import { ActivationGate } from './components/ActivationGate'
import { ToastProvider } from './components/Feedback'
import { api } from './lib/api'
import type { HealthResponse, PageId } from './types'

const AppShell = lazy(() => import('./components/AppShell').then((module) => ({ default: module.AppShell })))
const FilesPage = lazy(() => import('./pages/FilesPage').then((module) => ({ default: module.FilesPage })))
const ScrapePage = lazy(() => import('./pages/ScrapePage').then((module) => ({ default: module.ScrapePage })))
const AnalyticsPage = lazy(() => import('./pages/AnalyticsPage').then((module) => ({ default: module.AnalyticsPage })))

const pageIds: PageId[] = ['scrape', 'files', 'dosen', 'prodi']

const pageFromHash = (): PageId => {
  const hash = window.location.hash.replace('#/', '') as PageId
  return pageIds.includes(hash) ? hash : 'scrape'
}

export default function App() {
  const [page, setPage] = useState<PageId>(pageFromHash)
  const [apiOnline, setApiOnline] = useState<boolean | null>(null)
  const [databaseOnline, setDatabaseOnline] = useState<boolean | null>(null)
  const [security, setSecurity] = useState<HealthResponse['security'] | null>(null)
  const [outputRevision, setOutputRevision] = useState(0)

  useEffect(() => {
    const onHashChange = () => setPage(pageFromHash())
    window.addEventListener('hashchange', onHashChange)
    if (!window.location.hash) window.history.replaceState(null, '', '#/scrape')
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  useEffect(() => {
    let active = true
    const checkApi = () => api.health()
      .then((health) => {
        if (active) {
          setApiOnline(true)
          setDatabaseOnline(health.database.connected)
          setSecurity(health.security)
        }
      })
      .catch(() => {
        if (active) {
          setApiOnline(false)
          setDatabaseOnline(false)
        }
      })
    void checkApi()
    const interval = window.setInterval(checkApi, 15_000)
    window.addEventListener('focus', checkApi)
    return () => {
      active = false
      window.clearInterval(interval)
      window.removeEventListener('focus', checkApi)
    }
  }, [])

  const navigate = (nextPage: PageId) => {
    window.location.hash = `/${nextPage}`
    setPage(nextPage)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const handleActivated = () => {
    setSecurity((current) => current ? { ...current, authenticated: true } : current)
    void api.health().then((health) => {
      setDatabaseOnline(health.database.connected)
      setSecurity(health.security)
    })
  }

  if (apiOnline === null || apiOnline === false || (apiOnline === true && security?.required && !security.authenticated)) {
    return (
      <ToastProvider>
        <main className="secure-entry-shell">
          {apiOnline === null ? (
            <section className="secure-entry-loading" aria-live="polite">
              <span className="secure-entry-spinner" />
              <strong>Menyiapkan layanan aman…</strong>
              <small>Mohon tunggu sebentar</small>
            </section>
          ) : apiOnline === false ? (
            <section className="secure-entry-loading" role="alert">
              <strong>Flask lokal terputus</strong>
              <small>Buka ulang aplikasi atau tekan tombol berikut.</small>
              <button className="button primary" type="button" onClick={() => window.location.reload()}>Coba lagi</button>
            </section>
          ) : (
            <ActivationGate onActivated={handleActivated} />
          )}
        </main>
      </ToastProvider>
    )
  }

  return (
    <ToastProvider>
      <Suspense fallback={<main className="secure-entry-shell"><section className="secure-entry-loading"><span className="secure-entry-spinner" /><strong>Menyiapkan workspace…</strong></section></main>}>
        <AppShell activePage={page} apiOnline={apiOnline} databaseOnline={databaseOnline} onNavigate={navigate}>
          <div className={page === 'scrape' ? '' : 'route-hidden'} aria-hidden={page !== 'scrape'}>
            <Suspense fallback={<div className="analytics-loading"><strong>Menyiapkan scraper…</strong></div>}>
              <ScrapePage databaseOnline={databaseOnline} onOutputCreated={() => setOutputRevision((value) => value + 1)} />
            </Suspense>
          </div>
          {page === 'files' && (
            <Suspense fallback={<div className="analytics-loading"><strong>Menyiapkan riwayat…</strong></div>}>
              <FilesPage revision={outputRevision} onNavigate={navigate} />
            </Suspense>
          )}
          {(page === 'dosen' || page === 'prodi') && (
            <Suspense fallback={<div className="analytics-loading"><strong>Menyiapkan modul analisis…</strong></div>}>
              <AnalyticsPage type={page} revision={outputRevision} />
            </Suspense>
          )}
        </AppShell>
      </Suspense>
    </ToastProvider>
  )
}
