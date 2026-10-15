import { useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useHouse, queryKeys } from '@/hooks/useHouse'
import { useUndoCompletion } from '@/hooks/useUndoCompletion'
import { adminUndoAdjustment, fetchAdjustments, fetchHistory } from '@/lib/api'
import { friendlyError } from '@/lib/errors'
import { dayLabel, timeLabel } from '@/lib/format'
import type { Completion, PointAdjustment } from '@/lib/types'
import { Card, Chip, ErrorBox, PageLoading, cx, useToast } from '@/components/ui'

type TypeFilter = 'normal' | 'volunteer' | 'adjustment' | undefined
type Item = { kind: 'completion'; at: string; c: Completion } | { kind: 'adjustment'; at: string; a: PointAdjustment }

export function HistoryPage() {
  const { members, areas, me, isAdmin, isLoading } = useHouse()
  const [userId, setUserId] = useState<string | undefined>()
  const [areaId, setAreaId] = useState<string | undefined>()
  const [type, setType] = useState<TypeFilter>()
  const undo = useUndoCompletion()
  const toast = useToast()
  const qc = useQueryClient()

  const filters = { userId, areaId, type: type === 'adjustment' ? undefined : type, limit: 200 }
  const history = useQuery({ queryKey: queryKeys.history(filters), queryFn: () => fetchHistory(filters), enabled: Boolean(me) && type !== 'adjustment' })
  // Adjustments have no area, so they only appear when no area filter is set.
  const showAdjustments = !areaId && (type === undefined || type === 'adjustment')
  const adjFilters = { userId, limit: 200 }
  const adjustments = useQuery({ queryKey: queryKeys.adjustments(adjFilters), queryFn: () => fetchAdjustments(adjFilters), enabled: Boolean(me) && showAdjustments })

  const undoAdjustment = async (a: PointAdjustment) => {
    try {
      await adminUndoAdjustment(a.id)
      await qc.invalidateQueries()
      toast.show('Adjustment undone', 'success')
    } catch (e) { toast.show(friendlyError(e), 'error') }
  }

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
    const items: Item[] = [
      ...(type === 'adjustment' ? [] : (history.data ?? [])).map((c): Item => ({ kind: 'completion', at: c.completed_at, c })),
      ...(showAdjustments ? (adjustments.data ?? []) : []).map((a): Item => ({ kind: 'adjustment', at: a.created_at, a })),
    ].sort((x, y) => y.at.localeCompare(x.at))
    const map = new Map<string, Item[]>()
    for (const it of items) {
      const k = dayLabel(it.at)
      map.set(k, [...(map.get(k) ?? []), it])
    }
    return [...map.entries()]
  }, [history.data, adjustments.data, showAdjustments, type])

  if (isLoading) return <PageLoading />
  const loading = (type !== 'adjustment' && history.isLoading) || (showAdjustments && adjustments.isLoading)
  const empty = !loading && groups.length === 0

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
          <Chip active={type === 'adjustment'} onClick={() => { setType('adjustment'); setAreaId(undefined) }}>⚖️ Adjustments</Chip>
        </Row>
      </div>

      {history.error && <ErrorBox error={history.error} retry={() => history.refetch()} />}
      {loading && <PageLoading />}
      {empty && (
        <Card className="text-center py-8 text-slate-400">
          <div className="text-3xl mb-1">{type === 'adjustment' ? '⚖️' : '🧼'}</div>
          {type === 'adjustment' ? 'No point adjustments yet.' : 'Nothing here yet.'}
        </Card>
      )}
      {groups.map(([day, items]) => (
        <div key={day} className="mb-4">
          <p className="text-[11px] font-bold tracking-[0.18em] uppercase text-slate-400 px-1 mb-2">{day}</p>
          <Card className="divide-y divide-line py-1">
            {items.map((it) => it.kind === 'completion'
              ? <CompletionItem key={it.c.id} c={it.c} meId={me?.id} onUndo={latestPerArea.has(it.c.id) ? () => undo.request(it.c) : undefined} />
              : <AdjustmentItem key={it.a.id} a={it.a} meId={me?.id} onUndo={isAdmin ? () => undoAdjustment(it.a) : undefined} />)}
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

/** An admin give/take of points, with the reason and who did it. */
export function AdjustmentItem({ a, meId, onUndo }: { a: PointAdjustment; meId?: string; onUndo?: () => void }) {
  const gain = a.points > 0
  const [expanded, setExpanded] = useState(false)
  const long = a.note.length > 40
  return (
    <div className="flex items-start gap-3 py-3 cursor-pointer" onClick={() => setExpanded((v) => !v)}>
      <div className="h-10 w-10 rounded-2xl bg-card-2 flex items-center justify-center text-xl shrink-0">⚖️</div>
      <div className="min-w-0 flex-1">
        <div className="font-semibold truncate">
          <Link to={`/profile/${a.user_id}`} onClick={(e) => e.stopPropagation()} className={cx(a.user_id === meId && 'text-emerald-200')}>{a.member?.name ?? 'Someone'}</Link>
          <span className="text-slate-500 font-normal text-xs"> · {gain ? 'Bonus' : 'Deduction'} by {a.admin?.name ?? 'an admin'}</span>
        </div>
        <p className={cx('text-sm text-slate-300 break-words', !expanded && 'line-clamp-1')}>{a.note}</p>
        <div className="text-xs text-slate-500">
          {timeLabel(a.created_at)}
          {long && <> · <span className="text-sky-300 font-semibold">{expanded ? 'Show less' : 'See more'}</span></>}
          {onUndo && (
            <> · <button onClick={(e) => { e.stopPropagation(); onUndo() }} className="text-rose-300 hover:underline font-semibold">Undo</button></>
          )}
        </div>
      </div>
      <span className={cx('font-bold tabular-nums pt-0.5', gain ? 'text-emerald-300' : 'text-rose-300')}>{gain ? '+' : '−'}{Math.abs(a.points)}</span>
    </div>
  )
}

export function CompletionItem({ c, showArea = true, meId, onUndo }: { c: Completion; showArea?: boolean; meId?: string; onUndo?: () => void }) {
  const { settings } = useHouse()
  const rescue = c.completion_type === 'volunteer'
  const logged = c.activated_at === null && !rescue // admin-logged, never flagged
  const cleanerName = c.cleaner?.name ?? 'Someone'
  const scheduledName = c.scheduled?.name ?? 'Unassigned'
  const penalty = Number(settings.rescue_penalty_points ?? '5')
  const penaltyNote = rescue && c.scheduled && penalty > 0 && c.points_awarded > 0 ? ` · −${penalty} for ${scheduledName}` : ''
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
          {logged ? 'Logged by admin' : rescue ? <>Volunteer rescue · scheduled: {scheduledName}<span className="text-rose-300/80">{penaltyNote}</span></> : 'Normal turn'} · {timeLabel(c.completed_at)}
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
