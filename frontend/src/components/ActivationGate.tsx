import { Eye, EyeOff, KeyRound, LoaderCircle, ShieldCheck } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { api } from '../lib/api'

export function ActivationGate({ onActivated }: { onActivated: () => void }) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [showCode, setShowCode] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api.activateSession(code)
      setCode('')
      onActivated()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Aktivasi gagal.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="dialog-layer activation-layer">
      <form className="dialog activation-dialog" onSubmit={(event) => void submit(event)}>
        <div className="dialog-heading">
          <div className="dialog-icon"><ShieldCheck size={22} /></div>
          <div><h2>Aktivasi sesi aman</h2><p>Masukkan kode dari administrator. Kode dan session key hanya dipakai di RAM hingga aplikasi ditutup.</p></div>
        </div>
        <label className="activation-field">
          <span><KeyRound size={16} /> Kode aktivasi</span>
          <span className="activation-input-wrap">
            <input type={showCode ? 'text' : 'password'} autoFocus autoComplete="off" value={code} maxLength={128} onChange={(event) => setCode(event.target.value)} />
            <button type="button" aria-label={showCode ? 'Sembunyikan kode aktivasi' : 'Tampilkan kode aktivasi'} title={showCode ? 'Sembunyikan' : 'Tampilkan'} onClick={() => setShowCode((current) => !current)}>
              {showCode ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </span>
        </label>
        {error && <p className="activation-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button className="button primary" type="submit" disabled={busy || code.length < 8}>
            {busy && <LoaderCircle className="spin" size={16} />} Hubungkan
          </button>
        </div>
      </form>
    </div>
  )
}
