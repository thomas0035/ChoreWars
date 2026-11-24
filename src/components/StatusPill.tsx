import { cx } from './ui'
import { STATUS_STYLES, type AreaView } from '@/lib/status'

/** Plain coloured status text. No pill, no ring: the colour carries it. */
export function StatusPill({ view, size = 'sm' }: { view: AreaView; size?: 'sm' | 'md' }) {
  const base = cx('font-medium whitespace-nowrap', size === 'sm' ? 'text-[12.5px]' : 'text-sm')
  if (view.area.state.activation_state === 'volunteer_claimed') {
    return <span className={cx(base, 'text-soap')}>Volunteered</span>
  }
  if (view.isActive) {
    return <span className={cx(base, 'text-coral')}>Needs cleaning</span>
  }
  return <span className={cx(base, STATUS_STYLES[view.status.key].text)}>{view.status.label}</span>
}
