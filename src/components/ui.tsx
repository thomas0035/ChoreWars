import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Crown, X } from 'lucide-react'
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
  primary: 'bg-butter text-on-butter hover:brightness-105 active:brightness-95',
  hero: 'bg-butter text-on-butter hover:brightness-105 active:brightness-95',
  secondary: 'bg-card-2 text-slate-100 hover:bg-slate-700 active:bg-slate-700',
  ghost: 'bg-transparent text-slate-300 hover:bg-white/5 active:bg-white/10',
  danger: 'bg-coral/15 text-rose-300 hover:bg-coral/25 active:bg-coral/30',
}
const SIZES: Record<Size, string> = {
  sm: 'h-9 px-3.5 text-sm rounded-full gap-1.5',
  md: 'h-12 px-5 text-[15px] rounded-full gap-2',
  lg: 'h-13 px-6 text-base rounded-full gap-2',
}

export function Button({
  variant = 'primary', size = 'md', loading, className, children, disabled, ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; loading?: boolean }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center justify-center font-semibold transition-all select-none disabled:opacity-50 active:scale-[0.98]',
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
      className={cx('block w-full text-left rounded-3xl bg-card p-4', onClick && 'hover:bg-card-2 transition-colors', className)}
    >
      {children}
    </Comp>
  )
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between px-1 mb-2 mt-6 first:mt-0">
      <h2 className="font-sans text-[13px] font-medium tracking-normal text-slate-400">{children}</h2>
      {action}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Avatar
// ---------------------------------------------------------------------------
// Flat, muted tones so people stay tellable apart without competing with the accent.
const AVATAR_COLORS = ['bg-[#a8492a]', 'bg-[#1d6a72]', 'bg-[#6a3f78]', 'bg-[#8a7420]', 'bg-[#3c6e3a]', 'bg-[#7a4a5e]']
function hue(name: string): string {
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]!
}
export function Avatar({ name, url, size = 'md', className, crown }: { name: string; url?: string | null; size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'; className?: string; crown?: boolean }) {
  const dim = { xs: 'h-6 w-6 text-[10px]', sm: 'h-8 w-8 text-xs', md: 'h-10 w-10 text-sm', lg: 'h-14 w-14 text-lg', xl: 'h-20 w-20 text-2xl' }[size]
  const img = url
    ? <img src={url} alt={name} className={cx('rounded-full object-cover shrink-0', dim, className)} />
    : (
      <div className={cx('rounded-full text-slate-100 font-semibold flex items-center justify-center shrink-0', hue(name), dim, className)}>
        {initials(name)}
      </div>
    )
  if (!crown) return img
  const crownSize = { xs: 'h-3 w-3 -top-1.5 -right-1', sm: 'h-3.5 w-3.5 -top-2 -right-1', md: 'h-4 w-4 -top-2 -right-1', lg: 'h-5 w-5 -top-2.5 -right-1', xl: 'h-7 w-7 -top-3 -right-1' }[size]
  return (
    <span className="relative inline-flex shrink-0">
      {img}
      <span className={cx('absolute rotate-12 text-butter', crownSize)} title="Reigning league champion" aria-label="Reigning league champion">
        <Crown className="h-full w-full" fill="currentColor" strokeWidth={1.5} />
      </span>
    </span>
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
    <div className="rounded-3xl bg-coral/10 p-4 text-rose-200">
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
        active ? 'bg-slate-100 text-slate-900 border-slate-100' : 'bg-card text-slate-300 border-transparent hover:bg-card-2',
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
            className="absolute inset-0 bg-black/70"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.div
            role="dialog" aria-modal="true"
            className="relative w-full sm:max-w-md bg-card rounded-t-[24px] sm:rounded-[24px] p-5 pb-[calc(1.5rem+env(safe-area-inset-bottom))] max-h-[90dvh] overflow-y-auto"
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
                'pointer-events-auto max-w-sm w-full rounded-2xl px-4 py-3 text-sm font-medium shadow-xl shadow-black/40',
                t.kind === 'error' && 'bg-coral text-[#2a0d03]',
                t.kind === 'success' && 'bg-butter text-on-butter',
                t.kind === 'info' && 'bg-card-2 text-slate-100',
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
      <span className="block text-xs font-medium text-slate-400 mb-1.5 px-1">{label}</span>
      {children}
      {hint && <span className="block text-xs text-slate-500 mt-1 px-1">{hint}</span>}
    </label>
  )
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
      className="flex items-center gap-3 w-full h-12 px-1 text-left"
    >
      <span className={cx('relative h-7 w-12 shrink-0 rounded-full transition-colors', checked ? 'bg-butter' : 'bg-slate-600')}>
        <span className={cx('absolute top-0.5 h-6 w-6 rounded-full bg-surface transition-transform', checked ? 'translate-x-[22px]' : 'translate-x-0.5')} />
      </span>
      <span className="text-[15px]">{label}</span>
    </button>
  )
}
