import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react'
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

type ToastTone = 'success' | 'error' | 'info'
interface ToastItem { id: number; message: string; tone: ToastTone }
interface ToastContextValue { pushToast: (message: string, tone?: ToastTone) => void }

const ToastContext = createContext<ToastContextValue>({ pushToast: () => undefined })

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])

  const pushToast = useCallback((message: string, tone: ToastTone = 'info') => {
    const id = Date.now() + Math.random()
    setToasts((current) => [...current, { id, message, tone }])
    window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), 4200)
  }, [])

  const value = useMemo(() => ({ pushToast }), [pushToast])
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((toast) => {
          const Icon = toast.tone === 'success' ? CheckCircle2 : toast.tone === 'error' ? AlertCircle : Info
          return (
            <div className={`toast toast-${toast.tone}`} key={toast.id}>
              <Icon size={18} />
              <span>{toast.message}</span>
              <button type="button" aria-label="Tutup notifikasi" onClick={() => setToasts((items) => items.filter((item) => item.id !== toast.id))}>
                <X size={16} />
              </button>
            </div>
          )
        })}
      </div>
    </ToastContext.Provider>
  )
}

export const useToast = () => useContext(ToastContext)

interface DialogProps {
  open: boolean
  title: string
  description: string
  confirmLabel: string
  danger?: boolean
  children?: ReactNode
  onCancel: () => void
  onConfirm: () => void
}

export function ConfirmDialog({ open, title, description, confirmLabel, danger, children, onCancel, onConfirm }: DialogProps) {
  if (!open) return null
  return (
    <div className="dialog-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <div className="dialog-heading">
          <div className={`dialog-icon ${danger ? 'danger' : ''}`}><AlertCircle size={22} /></div>
          <div>
            <h2 id="dialog-title">{title}</h2>
            <p>{description}</p>
          </div>
        </div>
        {children}
        <div className="dialog-actions">
          <button className="button secondary" type="button" onClick={onCancel}>Batal</button>
          <button className={`button ${danger ? 'danger-button' : 'primary'}`} type="button" onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </section>
    </div>
  )
}
