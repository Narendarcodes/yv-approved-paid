/**
 * Lightweight toast feedback for yv. - no external dependency, matching
 * the app's hand-rolled motion approach. Actions that change state should
 * always confirm themselves with a toast.
 */
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react'

export type ToastTone = 'success' | 'info' | 'warning' | 'danger'

interface ToastItem {
  id: number
  tone: ToastTone
  title: string
  desc?: string
  leaving?: boolean
}

// Quick confirmations get out of the way; warnings linger long enough to read.
const DURATION: Record<ToastTone, number> = { success: 2600, info: 3400, warning: 5200, danger: 6000 }

const ToastContext = createContext<(tone: ToastTone, title: string, desc?: string) => void>(() => {})

export function useToast() {
  return useContext(ToastContext)
}

const toneMeta: Record<ToastTone, { icon: ReactNode }> = {
  success: { icon: <CheckCircle2 size={16} strokeWidth={1.75} className="text-success" /> },
  info: { icon: <Info size={16} strokeWidth={1.75} className="text-teal" /> },
  warning: { icon: <AlertTriangle size={16} strokeWidth={1.75} className="text-warning" /> },
  danger: { icon: <AlertTriangle size={16} strokeWidth={1.75} className="text-danger" /> },
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])

  const dismiss = useCallback((id: number) => {
    setToasts((t) => t.map((x) => (x.id === id ? { ...x, leaving: true } : x)))
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 200)
  }, [])

  const push = useCallback((tone: ToastTone, title: string, desc?: string) => {
    const id = Date.now() + Math.random()
    // Keep at most three on screen so the stack never climbs over content.
    setToasts((t) => [...t.slice(-2), { id, tone, title, desc }])
    window.setTimeout(() => dismiss(id), DURATION[tone] + (desc ? 1200 : 0))
  }, [dismiss])

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-[70] flex w-[min(320px,calc(100vw_-_2rem))] flex-col items-end gap-2"
        role="region"
        aria-label="Notifications"
        aria-live="polite"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`${t.leaving ? 'toast-out' : 'toast-in'} pointer-events-auto flex w-full items-start gap-2.5 rounded-[10px] border border-line bg-surface px-3 py-2.5 shadow-pop`}
            role={t.tone === 'danger' || t.tone === 'warning' ? 'alert' : 'status'}
            data-testid="toast"
          >
            <span className="mt-0.5 shrink-0">{toneMeta[t.tone].icon}</span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium leading-5 text-ink">{t.title}</p>
              {t.desc && <p className="mt-0.5 text-[13px] leading-snug text-umber">{t.desc}</p>}
            </div>
            <button
              onClick={() => dismiss(t.id)}
              className="icon-btn !h-6 !w-6 shrink-0"
              aria-label="Dismiss"
            >
              <X size={13} strokeWidth={2} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}