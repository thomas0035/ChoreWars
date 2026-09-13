import { useNavigate } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { Card, cx } from './ui'
import { StatusPill } from './StatusPill'
import { timeAgo } from '@/lib/format'
import type { AreaView } from '@/lib/status'

export function AreaRow({ view, now }: { view: AreaView; now: Date }) {
  const nav = useNavigate()
  const { area, scheduled, volunteer, isActive } = view
  const who = isActive
    ? volunteer
      ? `${volunteer.name} volunteered`
      : scheduled
        ? `${scheduled.name}'s turn`
        : 'Nobody assigned'
    : scheduled
      ? `Next: ${scheduled.name}`
      : 'No rotation'

  return (
    <Card onClick={() => nav(`/areas/${area.id}`)} className={cx('flex items-center gap-3 py-3.5', isActive && 'border-rose-400/30')}>
      <div className="h-11 w-11 rounded-2xl bg-card-2 flex items-center justify-center text-2xl shrink-0">{area.icon}</div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-semibold truncate">{area.name}</span>
          <StatusPill view={view} />
        </div>
        <div className="text-sm text-slate-400 mt-0.5 truncate">
          {who}
          <span className="text-slate-600"> · </span>
          {area.state.last_cleaned_at ? `cleaned ${timeAgo(area.state.last_cleaned_at, now)}` : 'no record'}
        </div>
      </div>
      <ChevronRight className="h-5 w-5 text-slate-600 shrink-0" />
    </Card>
  )
}
