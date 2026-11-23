import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'
import { useAreaViews, queryKeys } from '@/hooks/useHouse'
import { useAreaActions } from '@/hooks/useAreaActions'
import { useUndoCompletion } from '@/hooks/useUndoCompletion'
import { fetchHistory, fetchUserStats } from '@/lib/api'
import { hoursHuman, intervalRange, timeAgo, timeUntil } from '@/lib/format'
import { STATUS_STYLES, voterNames } from '@/lib/status'
import { StatusPill } from '@/components/StatusPill'
import { DoneFlood, SlideToClean, useSlideComplete } from '@/components/SlideToClean'
import { Avatar, Button, Card, ErrorBox, PageLoading, SectionTitle, cx } from '@/components/ui'
import { CompletionItem } from './History'

export function AreaDetailPage() {
  const { id } = useParams()
  const nav = useNavigate()
  const { views, now, isLoading, error, me, isAdmin, house } = useAreaViews()
  const { request, sheet } = useAreaActions(now)
  const undo = useUndoCompletion()
  const slide = useSlideComplete()
  const history = useQuery({ queryKey: queryKeys.history({ areaId: id, limit: 8 }), queryFn: () => fetchHistory({ areaId: id, limit: 8 }), enabled: Boolean(id) })
  const stats = useQuery({ queryKey: queryKeys.stats(me?.id), queryFn: () => fetchUserStats(), enabled: Boolean(me) })

  if (isLoading) return <PageLoading />
  if (error) return <ErrorBox error={error} />
  const view = views.find((v) => v.area.id === id)
  if (!view || !me) {
    return (
      <div className="text-center py-16">
        <p className="text-slate-400">That area doesn't exist any more.</p>
        <Link to="/areas" className="text-butter font-medium text-sm">Back to areas</Link>
      </div>
    )
  }

  const { area, status, isActive, scheduled, volunteer, activatedBy, isMyTurn, amVolunteer, canComplete, canMarkNeeds, cooldownEndsAt, canVolunteer, graceEndsAt, canRelease, canDismiss, cleaners, isPinned, volunteeringEnabled, dismissVoters, dismissVotesNeeded, hasVotedDismiss, canVoteDismiss } = view
  // Ring the person who actually holds this area: the one responsible now, or an admin's pick for next.
  const holderId = isActive || isPinned ? scheduled?.id : undefined
  const s = area.state
  const styles = STATUS_STYLES[status.key]
  const canSkip = isMyTurn && s.activation_state === 'active' && !s.skip_from_user_id && (stats.data?.skip_passes ?? 0) > 0
  const skippedBy = s.skip_from_user_id ? house?.members.find((m) => m.id === s.skip_from_user_id) : undefined

  return (
    <div>
      <button onClick={() => nav(-1)} className="inline-flex items-center gap-1 text-sm text-slate-400 hover:text-slate-200 mb-3 -ml-1 px-1 h-9">
        <ArrowLeft className="h-4 w-4" /> Back
      </button>

      <div className="relative overflow-hidden rounded-3xl bg-card p-[18px]">
        <StatusPill view={view} size="md" />
        <h1 className="text-[34px] font-bold leading-[1.1] tracking-[-0.03em] mt-0.5">{area.name}</h1>

        <p className="mt-2 text-slate-300">
          {isActive
            ? volunteer
              ? <><b>{volunteer.name}</b> volunteered to clean this for <b>{scheduled?.name}</b>.</>
              : isMyTurn
                ? <>It's <b>your turn</b> to clean this.</>
                : <><b>{scheduled?.name ?? 'Nobody'}</b>'s turn to clean this.</>
            : status.hint(area.name)}
        </p>
        {isActive && activatedBy && (
          <p className="text-sm text-slate-500 mt-1">Flagged by {activatedBy.name} {timeAgo(s.activated_at, now)}.</p>
        )}
        {skippedBy && (
          <p className="text-sm text-slate-400 mt-1">Passed on by {skippedBy.id === me.id ? 'you' : skippedBy.name} with a Skip Pass.</p>
        )}

        <div className="grid grid-cols-2 gap-2 mt-5">
          <Fact label="Last cleaned" value={s.last_cleaned_at ? timeAgo(s.last_cleaned_at, now) : 'No record'} accent={styles.text} />
          <Fact label="Usual interval" value={intervalRange(area.minimum_interval_hours, area.expected_interval_hours)} />
          <Fact label={isActive ? 'Responsible' : isPinned ? "Next (admin's pick)" : 'If flagged now'} value={scheduled?.name ?? '—'} />
          <Fact label="Points" value={`+${area.normal_points} · rescue +${area.rescue_points}`} />
        </div>

        <div className="mt-5 space-y-2">
          {canComplete && <SlideToClean onComplete={() => slide.complete(view)} />}
          {!isActive && canMarkNeeds && <Button size="lg" className="w-full" onClick={() => request('mark', view)}>This needs cleaning</Button>}
          {!isActive && !canMarkNeeds && cooldownEndsAt && (
            <div className="rounded-2xl bg-surface/60 p-3 text-sm text-slate-400 text-center">
              Recently cleaned. You can flag it again {timeUntil(cooldownEndsAt, now)}.
            </div>
          )}
          {isActive && !canComplete && !volunteer && volunteeringEnabled && (
            canVolunteer
              ? <Button variant="secondary" size="lg" className="w-full" onClick={() => request('volunteer', view)}>Volunteer to clean</Button>
              : graceEndsAt && (
                <div className="rounded-2xl bg-surface/60 p-3 text-sm text-slate-400 text-center">
                  {scheduled?.name ?? 'They'}'s turn for now. Volunteering opens {timeUntil(graceEndsAt, now)}.
                </div>
              )
          )}
          {isActive && (dismissVoters.length > 0 || canVoteDismiss) && (
            <div className="rounded-2xl bg-surface/60 p-3 text-sm">
              {dismissVoters.length > 0 ? (
                <p className="text-slate-300">
                  <b>{voterNames(dismissVoters, me.id)}</b> {dismissVoters.length === 1 ? 'thinks' : 'think'} it looks fine
                  <span className="text-slate-600"> · </span><b>{dismissVoters.length} of {dismissVotesNeeded}</b> needed to clear the flag.
                </p>
              ) : (
                <p className="text-slate-400">Doesn't actually need cleaning? It takes {dismissVotesNeeded} of the {cleaners.length} people who clean it to agree.</p>
              )}
              {(canVoteDismiss || hasVotedDismiss) && (
                <div className="flex gap-2 mt-2">
                  {canVoteDismiss && <Button variant="secondary" size="sm" className="flex-1" onClick={() => request('vote_dismiss', view)}>{dismissVoters.length > 0 ? 'Agree, looks fine' : 'Looks fine, not needed'}</Button>}
                  {hasVotedDismiss && <Button variant="ghost" size="sm" className="flex-1" onClick={() => request('unvote_dismiss', view)}>Withdraw my vote</Button>}
                </div>
              )}
            </div>
          )}
          <div className="flex gap-2">
            {canRelease && <Button variant="ghost" size="sm" className="flex-1" onClick={() => request('release', view)}>{amVolunteer ? 'Cancel my volunteer claim' : 'Clear volunteer claim'}</Button>}
            {canDismiss && <Button variant="ghost" size="sm" className="flex-1" onClick={() => request('dismiss', view)}>Clear flag (admin)</Button>}
            {canSkip && <Button variant="ghost" size="sm" className="flex-1" onClick={() => request('skip', view)}>Use a Skip Pass</Button>}
          </div>
        </div>
        {slide.done?.view.area.id === area.id && <DoneFlood result={slide.done.result} onDismiss={slide.dismiss} />}
      </div>

      <SectionTitle>Who cleans this</SectionTitle>
      <Card className="py-3">
        {cleaners.length === 0 ? (
          <p className="text-sm text-slate-500">No one cleans this area yet.</p>
        ) : (
          <div className="flex gap-3 overflow-x-auto no-scrollbar -mx-1 px-1">
            {cleaners.map((m) => (
              <Link key={m.id} to={`/profile/${m.id}`} className={cx('flex flex-col items-center gap-1.5 min-w-[64px]', m.away && 'opacity-40')}>
                <div className={cx('rounded-full p-[2px]', m.id === holderId ? 'bg-butter' : 'bg-transparent')}>
                  <Avatar name={m.name} url={m.avatar_url} size="md" className={cx(m.id === holderId && 'ring-2 ring-card')} />
                </div>
                <span className={cx('text-xs truncate max-w-[72px]', m.id === holderId ? 'font-semibold text-butter' : 'text-slate-400')}>
                  {m.id === me.id ? 'You' : m.name}
                </span>
                {m.away && <span className="text-[10px] text-slate-400 -mt-1">away</span>}
              </Link>
            ))}
          </div>
        )}
        <p className="text-xs text-slate-500 mt-3">
          Thresholds: fresh under {hoursHuman(area.minimum_interval_hours)} · attention after {hoursHuman(area.attention_interval_hours)} · volunteer grace {hoursHuman(area.volunteer_grace_hours)}.
        </p>
      </Card>

      <SectionTitle action={<Link to="/history" className="text-[13px] font-medium text-butter">All history</Link>}>Recent history</SectionTitle>
      <Card className="divide-y divide-line py-1">
        {history.isLoading && <p className="text-sm text-slate-500 py-3">Loading…</p>}
        {history.data?.length === 0 && <p className="text-sm text-slate-500 py-3">No cleanings recorded yet.</p>}
        {history.data?.map((c, i) => (
          <CompletionItem key={c.id} c={c} showArea={false} meId={me.id} onUndo={isAdmin && i === 0 && !isActive ? () => undo.request(c) : undefined} />
        ))}
      </Card>

      {sheet}
      {undo.sheet}
    </div>
  )
}

function Fact({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="rounded-2xl bg-surface/60 p-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={cx('font-semibold mt-0.5 truncate', accent)}>{value}</div>
    </div>
  )
}
