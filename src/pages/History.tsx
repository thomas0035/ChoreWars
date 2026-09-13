import { useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useHouse, queryKeys } from '@/hooks/useHouse'
import { useUndoCompletion } from '@/hooks/useUndoCompletion'
import { fetchHistory } from '@/lib/api'
import { dayLabel, timeLabel } from '@/lib/format'
import type { Completion } from '@/lib/types'
import { Card, Chip, ErrorBox, PageLoading, cx } from '@/components/ui'

export function HistoryPage() {
  const { members, areas, me, isAdmin, isLoading } = useHouse()
  const [userId, setUserId] = useState<string | undefined>()
  const [areaId, setAreaId] = useState<string | undefined>()
  const [type, setType] = useState<'normal' | 'volunteer' | undefined>()
  const undo = useUndoCompletion()

  const filters = { userId, areaId, type, limit: 200 }
  const history = useQuery({ queryKey: queryKeys.history(filters), queryFn: () => fetchHistory(filters), enabled: Boolean(me) })

  // Undo is offered only on the latest completion per area, which we can only be sure of
  // when the list isn't filtered by person or type (area filter alone is fine).
  const latestPerArea = useMemo(() => {
    const ids = new Set<string>()
    if (!isAdmin || userId || type) return ids
    const seen = new Set<string>()
    for (const c of history.data ?? []) {
      if (!seen.has(c.cleaning_area_id)) { seen.add(c.cleaning_area_id); ids.add(c.id) }
    }
    return ids
  }, [history.data, isAdmin, userId, type])

  const groups = useMemo(() => {
    const map = new Map<string, Completion[]>()
    for (const c of history.data ?? []) {
      const k = dayLabel(c.completed_at)
      map.set(k, [...(map.get(k) ?? []), c])
    }
    return [...map.entries()]
  }, [history.data])

  if (isLoading) return <PageLoading />

  return (
    <div>
      <h1 className="text-2xl font-extrabold tracking-tight mb-3">History</h1>

      <div className="space-y-2 mb-4">
        <Row>
          <Chip active={!userId} onClick={() => setUserId(undefined)}>Everyone</Chip>
          {members.map((m) => <Chip key={m.id} active={userId === m.id} onClick={() => setUserId(m.id)}>{m.name}</Chip>)}
        </Row>
        <Row>
          <Chip active={!areaId} onClick={() => setAreaId(undefined)}>All areas</Chip>
          {areas.map((a) => <Chip key={a.id} active={areaId === a.id} onClick={() => setAreaId(a.id)}>{a.icon} {a.name}</Chip>)}
        </Row>
        <Row>
          <Chip active={!type} onClick={() => setType(undefined)}>Any type</Chip>
          <Chip active={type === 'normal'} onClick={() => setType('normal')}>Normal</Chip>
          <Chip active={type === 'volunteer'} onClick={() => setType('volunteer')}>🦸 Rescue</Chip>
        </Row>
      </div>

      {history.error && <ErrorBox error={history.error} retry={() => history.refetch()} />}
      {history.isLoading && <PageLoading />}
      {history.data?.length === 0 && (
        <Card className="text-center py-8 text-slate-400">
          <div className="text-3xl mb-1">🧼</div>
          Nothing here yet.
        </Card>
      )}
      {groups.map(([day, items]) => (
        <div key={day} className="mb-4">
          <p className="text-[11px] font-bold tracking-[0.18em] uppercase text-slate-400 px-1 mb-2">{day}</p>
          <Card className="divide-y divide-line py-1">
            {items.map((c) => <CompletionItem key={c.id} c={c} meId={me?.id} onUndo={latestPerArea.has(c.id) ? () => undo.request(c) : undefined} />)}
          </Card>
        </div>
      ))}
      {undo.sheet}
    </div>
  )
}

function Row({ children }: { children: ReactNode }) {
  return <div className="flex gap-2 overflow-x-auto no-scrollbar -mx-4 px-4">{children}</div>
}

export function CompletionItem({ c, showArea = true, meId, onUndo }: { c: Completion; showArea?: boolean; meId?: string; onUndo?: () => void }) {
  const rescue = c.completion_type === 'volunteer'
  const logged = c.activated_at === null && !rescue // admin-logged, never flagged
  const cleanerName = c.cleaner?.name ?? 'Someone'
  const scheduledName = c.scheduled?.name ?? 'Unassigned'
  return (
    <div className="flex items-center gap-3 py-3">
      {showArea && <div className="h-10 w-10 rounded-2xl bg-card-2 flex items-center justify-center text-xl shrink-0">{c.area?.icon ?? '🧹'}</div>}
      <div className="min-w-0 flex-1">
        <div className="font-semibold truncate">
          {showArea && <>{c.area?.name ?? 'Area'} · </>}
          <Link to={c.completed_by_user_id ? `/profile/${c.completed_by_user_id}` : '#'} className={cx(c.completed_by_user_id === meId && 'text-emerald-200')}>
            {cleanerName}
          </Link>
          {rescue && ' 🦸'}
        </div>
        <div className="text-xs text-slate-500 truncate">
          {logged ? 'Logged by admin' : rescue ? <>Volunteer rescue · scheduled: {scheduledName}</> : 'Normal turn'} · {timeLabel(c.completed_at)}
          {onUndo && (
            <> · <button onClick={onUndo} className="text-rose-300 hover:underline font-semibold">Undo</button></>
          )}
        </div>
      </div>
      {c.points_awarded === 0
        ? <span className="text-xs text-slate-500">no pts</span>
        : <span className={cx('font-bold tabular-nums', rescue ? 'text-sky-300' : 'text-emerald-300')}>+{c.points_awarded}</span>}
    </div>
  )
}
