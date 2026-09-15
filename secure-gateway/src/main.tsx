import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

function App() {
  return (
    <main>
      <section>
        <span className="mark">KNEKS</span>
        <p className="eyebrow">PDDIKTI secure gateway</p>
        <h1>Gateway aktif.</h1>
        <p>PostgreSQL hanya dapat diakses oleh fungsi server. Halaman publik ini tidak memuat konfigurasi, credential, atau data.</p>
        <a href="/api/health">Periksa status layanan</a>
      </section>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
