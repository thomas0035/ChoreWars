import { useNavigate } from 'react-router-dom'
import { Card } from './ui'
import { StatusPill, statusStripClass } from './StatusPill'
import { timeAgo } from '@/lib/format'
import type { AreaView } from '@/lib/status'

export function AreaRow({ view, now }: { view: AreaView; now: Date }) {
  const nav = useNavigate()
  const { area, scheduled, volunteer, isActive, isPinned, cleaners } = view
  // Unflagged areas don't name a "next" person: asked area by area, the fewest-turns person wins
  // them all. The area page shows "If flagged now" instead. Only an admin's pick is a real promise.
  const who = isActive
    ? volunteer
      ? `${volunteer.name} volunteered`
      : scheduled
        ? `${scheduled.name}'s turn`
        : 'Nobody assigned'
    : isPinned && scheduled
      ? `Next: ${scheduled.name} (admin's pick)`
      : cleaners.length === 0
        ? 'Nobody cleans this'
        : null

  return (
    <Card onClick={() => nav(`/areas/${area.id}`)} className="flex items-center gap-3 py-3 pl-3.5 rounded-2xl">
      <span className={`h-9 w-1 rounded-full shrink-0 ${statusStripClass(view)}`} />
      <div className="min-w-0 flex-1">
        <div className="font-display font-semibold text-[16.5px] tracking-[-0.01em] truncate">{area.name}</div>
        <div className="text-[12.5px] text-slate-400 mt-0.5 truncate">
          {who && <>{who}<span className="text-slate-600"> · </span></>}
          {area.state.last_cleaned_at ? `cleaned ${timeAgo(area.state.last_cleaned_at, now)}` : 'no record'}
        </div>
      </div>
      <StatusPill view={view} />
    </Card>
  )
}
