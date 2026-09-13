import { cx } from './ui'
import { STATUS_STYLES, type AreaView } from '@/lib/status'

export function StatusPill({ view, size = 'sm' }: { view: AreaView; size?: 'sm' | 'md' }) {
  const base = cx('inline-flex items-center gap-1.5 rounded-full font-semibold whitespace-nowrap', size === 'sm' ? 'text-[11px] px-2 py-0.5' : 'text-xs px-2.5 py-1')
  if (view.area.state.activation_state === 'volunteer_claimed') {
    return <span className={cx(base, 'bg-sky-400/15 text-sky-200 ring-1 ring-sky-400/30')}>🙋 Volunteered</span>
  }
  if (view.isActive) {
    return (
      <span className={cx(base, 'bg-rose-500/15 text-rose-200 ring-1 ring-rose-400/40')}>
        <span className="h-1.5 w-1.5 rounded-full bg-rose-400 animate-pulse" /> Needs cleaning
      </span>
    )
  }
  const s = STATUS_STYLES[view.status.key]
  return (
    <span className={cx(base, s.bg, s.text, 'ring-1', s.ring)}>
      <span className={cx('h-1.5 w-1.5 rounded-full', s.dot)} /> {view.status.label}
    </span>
  )
}
