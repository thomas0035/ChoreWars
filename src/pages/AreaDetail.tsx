import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'
import { useAreaViews, queryKeys } from '@/hooks/useHouse'
import { useAreaActions } from '@/hooks/useAreaActions'
import { fetchHistory } from '@/lib/api'
import { hoursHuman, intervalRange, timeAgo, timeUntil } from '@/lib/format'
import { STATUS_STYLES } from '@/lib/status'
import { StatusPill } from '@/components/StatusPill'
import { Avatar, Button, Card, ErrorBox, PageLoading, SectionTitle, cx } from '@/components/ui'
import { CompletionItem } from './History'

export function AreaDetailPage() {
  const { id } = useParams()
  const nav = useNavigate()
  const { views, now, isLoading, error, me } = useAreaViews()
  const { request, sheet } = useAreaActions(now)
  const history = useQuery({ queryKey: queryKeys.history({ areaId: id, limit: 8 }), queryFn: () => fetchHistory({ areaId: id, limit: 8 }), enabled: Boolean(id) })

  if (isLoading) return <PageLoading />
  if (error) return <ErrorBox error={error} />
  const view = views.find((v) => v.area.id === id)
  if (!view || !me) {
    return (
      <div className="text-center py-16">
        <p className="text-slate-400">That area doesn't exist any more.</p>
        <Link to="/areas" className="text-emerald-300 font-semibold text-sm">Back to areas</Link>
      </div>
    )
  }

  const { area, status, isActive, scheduled, volunteer, activatedBy, isMyTurn, amVolunteer, canComplete, canMarkNeeds, cooldownEndsAt, canVolunteer, graceEndsAt, canRelease, canDismiss, rotationPreview, volunteeringEnabled } = view
  const s = area.state
  const styles = STATUS_STYLES[status.key]

  return (
    <div>
      <button onClick={() => nav(-1)} className="inline-flex items-center gap-1 text-sm text-slate-400 hover:text-slate-200 mb-3 -ml-1 px-1 h-9">
        <ArrowLeft className="h-4 w-4" /> Back
      </button>

      <div className={cx('rounded-[28px] border p-5', isActive ? 'bg-rose-500/10 border-rose-400/30' : cx('bg-card border-line'))}>
        <div className="flex items-start gap-4">
          <div className="h-16 w-16 rounded-3xl bg-card-2 flex items-center justify-center text-4xl shrink-0">{area.icon}</div>
          <div className="min-w-0 flex-1">
            <h1 className="text-3xl font-extrabold tracking-tight leading-none">{area.name}</h1>
            <div className="mt-2"><StatusPill view={view} size="md" /></div>
          </div>
        </div>

        <p className="mt-4 text-slate-300">
          {isActive
            ? volunteer
              ? <>🙋 <b>{volunteer.name}</b> volunteered to clean this for <b>{scheduled?.name}</b>.</>
              : isMyTurn
                ? <>It's <b>your turn</b> to clean this.</>
                : <><b>{scheduled?.name ?? 'Nobody'}</b>'s turn to clean this.</>
            : status.hint(area.name)}
        </p>
        {isActive && activatedBy && (
          <p className="text-sm text-slate-500 mt-1">Flagged by {activatedBy.name} {timeAgo(s.activated_at, now)}.</p>
        )}

        <div className="grid grid-cols-2 gap-2 mt-5">
          <Fact label="Last cleaned" value={s.last_cleaned_at ? timeAgo(s.last_cleaned_at, now) : 'No record'} accent={styles.text} />
          <Fact label="Usual interval" value={intervalRange(area.minimum_interval_hours, area.expected_interval_hours)} />
          <Fact label={isActive ? 'Responsible' : 'Next up'} value={scheduled?.name ?? '—'} />
          <Fact label="Points" value={`+${area.normal_points} · rescue +${area.rescue_points}`} />
        </div>

        <div className="mt-5 space-y-2">
          {canComplete && <Button variant="hero" size="lg" className="w-full" onClick={() => request('complete', view)}>✓ Mark as done</Button>}
          {!isActive && canMarkNeeds && <Button size="lg" className="w-full" onClick={() => request('mark', view)}>🧹 This needs cleaning</Button>}
          {!isActive && !canMarkNeeds && cooldownEndsAt && (
            <div className="rounded-2xl bg-card-2 border border-line p-3 text-sm text-slate-400 text-center">
              Recently cleaned — you can flag it again {timeUntil(cooldownEndsAt, now)}.
            </div>
          )}
          {isActive && !canComplete && !volunteer && volunteeringEnabled && (
            canVolunteer
              ? <Button variant="secondary" size="lg" className="w-full" onClick={() => request('volunteer', view)}>🙋 Volunteer to clean</Button>
              : graceEndsAt && (
                <div className="rounded-2xl bg-card-2 border border-line p-3 text-sm text-slate-400 text-center">
                  {scheduled?.name ?? 'They'}'s turn for now. Volunteering opens {timeUntil(graceEndsAt, now)}.
                </div>
              )
          )}
          <div className="flex gap-2">
            {canRelease && <Button variant="ghost" size="sm" className="flex-1" onClick={() => request('release', view)}>{amVolunteer ? 'Cancel my volunteer claim' : 'Clear volunteer claim'}</Button>}
            {canDismiss && <Button variant="ghost" size="sm" className="flex-1" onClick={() => request('dismiss', view)}>Looks fine, not needed</Button>}
          </div>
        </div>
      </div>

      <SectionTitle>Rotation</SectionTitle>
      <Card className="py-3">
        {rotationPreview.length === 0 ? (
          <p className="text-sm text-slate-500">No one in this rotation yet.</p>
        ) : (
          <div className="flex gap-3 overflow-x-auto no-scrollbar -mx-1 px-1">
            {rotationPreview.map((m, i) => (
              <Link key={m.id} to={`/profile/${m.id}`} className="flex flex-col items-center gap-1.5 min-w-[64px]">
                <div className={cx('rounded-full p-[2px]', i === 0 ? 'bg-gradient-to-br from-emerald-400 to-sky-400' : 'bg-transparent')}>
                  <Avatar name={m.name} url={m.avatar_url} size="md" className={cx(i === 0 && 'ring-2 ring-card')} />
                </div>
                <span className={cx('text-xs truncate max-w-[72px]', i === 0 ? 'font-bold text-emerald-200' : 'text-slate-400')}>
                  {i === 0 ? (m.id === me.id ? 'You' : m.name) : m.name}
                </span>
              </Link>
            ))}
          </div>
        )}
        <p className="text-xs text-slate-500 mt-3">
          Thresholds: fresh under {hoursHuman(area.minimum_interval_hours)} · attention after {hoursHuman(area.attention_interval_hours)} · volunteer grace {hoursHuman(area.volunteer_grace_hours)}.
        </p>
      </Card>

      <SectionTitle action={<Link to="/history" className="text-xs font-semibold text-emerald-300">All history</Link>}>Recent history</SectionTitle>
      <Card className="divide-y divide-line py-1">
        {history.isLoading && <p className="text-sm text-slate-500 py-3">Loading…</p>}
        {history.data?.length === 0 && <p className="text-sm text-slate-500 py-3">No cleanings recorded yet.</p>}
        {history.data?.map((c) => <CompletionItem key={c.id} c={c} showArea={false} meId={me.id} />)}
      </Card>

      {sheet}
    </div>
  )
}

function Fact({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="rounded-2xl bg-card-2/70 border border-line p-3">
      <div className="text-[10px] font-bold tracking-[0.16em] uppercase text-slate-500">{label}</div>
      <div className={cx('font-semibold mt-0.5 truncate', accent)}>{value}</div>
    </div>
  )
}
