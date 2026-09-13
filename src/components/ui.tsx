import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { X } from 'lucide-react'
import { initials } from '@/lib/format'

// ---------------------------------------------------------------------------
// cx
// ---------------------------------------------------------------------------
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'hero'
type Size = 'sm' | 'md' | 'lg'

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-emerald-400 text-emerald-950 hover:bg-emerald-300 active:bg-emerald-500 shadow-lg shadow-emerald-500/20',
  hero: 'bg-gradient-to-r from-emerald-400 to-sky-400 text-slate-950 hover:brightness-110 active:brightness-95 shadow-xl shadow-emerald-500/25',
  secondary: 'bg-card-2 text-slate-100 hover:bg-slate-700/60 active:bg-slate-700 border border-line',
  ghost: 'bg-transparent text-slate-300 hover:bg-white/5 active:bg-white/10',
  danger: 'bg-rose-500/15 text-rose-300 hover:bg-rose-500/25 active:bg-rose-500/30 border border-rose-400/20',
}
const SIZES: Record<Size, string> = {
  sm: 'h-9 px-3 text-sm rounded-xl gap-1.5',
  md: 'h-12 px-5 text-[15px] rounded-2xl gap-2',
  lg: 'h-14 px-6 text-base rounded-2xl gap-2',
}

export function Button({
  variant = 'primary', size = 'md', loading, className, children, disabled, ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; loading?: boolean }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center justify-center font-semibold transition-all select-none disabled:opacity-50 disabled:shadow-none active:scale-[0.98]',
        VARIANTS[variant], SIZES[size], className,
      )}
    >
      {loading ? <Spinner className="h-4 w-4" /> : children}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------
export function Card({ className, children, onClick }: { className?: string; children: ReactNode; onClick?: () => void }) {
  const Comp = onClick ? motion.button : motion.div
  return (
    <Comp
      onClick={onClick}
      whileTap={onClick ? { scale: 0.985 } : undefined}
      className={cx('block w-full text-left rounded-3xl bg-card border border-line p-4', onClick && 'hover:bg-card-2 transition-colors', className)}
    >
      {children}
    </Comp>
  )
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between px-1 mb-2 mt-6 first:mt-0">
      <h2 className="text-[11px] font-bold tracking-[0.18em] uppercase text-slate-400">{children}</h2>
      {action}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Avatar
// ---------------------------------------------------------------------------
const AVATAR_COLORS = [
  'from-emerald-400 to-teal-500', 'from-sky-400 to-indigo-500', 'from-amber-300 to-orange-500',
  'from-pink-400 to-rose-500', 'from-violet-400 to-purple-600', 'from-lime-300 to-green-500',
]
function hue(name: string): string {
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]!
}
export function Avatar({ name, url, size = 'md', className }: { name: string; url?: string | null; size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'; className?: string }) {
  const dim = { xs: 'h-6 w-6 text-[10px]', sm: 'h-8 w-8 text-xs', md: 'h-10 w-10 text-sm', lg: 'h-14 w-14 text-lg', xl: 'h-20 w-20 text-2xl' }[size]
  if (url) return <img src={url} alt={name} className={cx('rounded-full object-cover shrink-0', dim, className)} />
  return (
    <div className={cx('rounded-full bg-gradient-to-br text-slate-950 font-bold flex items-center justify-center shrink-0', hue(name), dim, className)}>
      {initials(name)}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Spinner / Skeleton / Empty
// ---------------------------------------------------------------------------
export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cx('animate-spin', className ?? 'h-6 w-6')} viewBox="0 0 24 24" fill="none" aria-label="Loading">
      <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('rounded-2xl bg-card-2 animate-pulse-soft', className)} />
}

export function PageLoading() {
  return (
    <div className="space-y-3 pt-2">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-40" />
      <Skeleton className="h-20" />
      <Skeleton className="h-20" />
    </div>
  )
}

export function ErrorBox({ error, retry }: { error: unknown; retry?: () => void }) {
  const msg = (error as { message?: string })?.message ?? 'Something went wrong.'
  return (
    <div className="rounded-3xl border border-rose-400/20 bg-rose-500/10 p-4 text-rose-200">
      <p className="font-semibold">Couldn't load</p>
      <p className="text-sm mt-1 text-rose-200/80">{msg}</p>
      {retry && <Button variant="secondary" size="sm" className="mt-3" onClick={retry}>Try again</Button>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Chip (filter pill)
// ---------------------------------------------------------------------------
export function Chip({ active, children, onClick }: { active?: boolean; children: ReactNode; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cx(
        'h-9 px-3.5 rounded-full text-sm font-medium whitespace-nowrap border transition-colors',
        active ? 'bg-slate-100 text-slate-900 border-slate-100' : 'bg-card-2 text-slate-300 border-line hover:bg-slate-700/50',
      )}
    >
      {children}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Sheet (bottom modal)
// ---------------------------------------------------------------------------
export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [open, onClose])

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
          <motion.div
            className="absolute inset-0 bg-black/60 backdrop-blur-[2px]"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.div
            role="dialog" aria-modal="true"
            className="relative w-full sm:max-w-md bg-card border border-line rounded-t-[28px] sm:rounded-[28px] p-5 pb-6 safe-bottom shadow-2xl max-h-[90dvh] overflow-y-auto"
            initial={{ y: 60, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 60, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 380, damping: 34 }}
          >
            <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-slate-600/60 sm:hidden" />
            {title && (
              <div className="flex items-start justify-between gap-3 mb-3">
                <h3 className="text-lg font-bold leading-tight">{title}</h3>
                <button onClick={onClose} className="p-1.5 -mr-1.5 -mt-1 rounded-full text-slate-400 hover:bg-white/5" aria-label="Close">
                  <X className="h-5 w-5" />
                </button>
              </div>
            )}
            {children}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  )
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------
type ToastKind = 'info' | 'success' | 'error'
interface Toast { id: number; kind: ToastKind; message: string }
const ToastContext = createContext<{ show: (message: string, kind?: ToastKind) => void } | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const idRef = useRef(0)
  const show = useCallback((message: string, kind: ToastKind = 'info') => {
    const id = ++idRef.current
    setToasts((t) => [...t, { id, kind, message }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 5000 : 3200)
  }, [])
  const value = useMemo(() => ({ show }), [show])
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="fixed inset-x-0 top-3 z-[60] flex flex-col items-center gap-2 px-4 pointer-events-none safe-top">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              initial={{ y: -16, opacity: 0, scale: 0.95 }} animate={{ y: 0, opacity: 1, scale: 1 }} exit={{ y: -10, opacity: 0, scale: 0.95 }}
              className={cx(
                'pointer-events-auto max-w-sm w-full rounded-2xl px-4 py-3 text-sm font-medium shadow-xl border backdrop-blur',
                t.kind === 'error' && 'bg-rose-500/20 border-rose-400/30 text-rose-100',
                t.kind === 'success' && 'bg-emerald-500/20 border-emerald-400/30 text-emerald-100',
                t.kind === 'info' && 'bg-slate-800/90 border-line text-slate-100',
              )}
            >
              {t.message}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used inside ToastProvider')
  return ctx
}

// ---------------------------------------------------------------------------
// Form bits
// ---------------------------------------------------------------------------
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-semibold text-slate-400 mb-1.5 px-1">{label}</span>
      {children}
      {hint && <span className="block text-xs text-slate-500 mt-1 px-1">{hint}</span>}
    </label>
  )
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
      className="flex items-center justify-between w-full h-12 px-1"
    >
      <span className="text-[15px]">{label}</span>
      <span className={cx('relative h-7 w-12 rounded-full transition-colors', checked ? 'bg-emerald-400' : 'bg-slate-600')}>
        <span className={cx('absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-[22px]' : 'translate-x-0.5')} />
      </span>
    </button>
  )
}
