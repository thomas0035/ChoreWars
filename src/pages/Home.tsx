import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'motion/react'
import { useAreaViews, useReigningChampion, queryKeys } from '@/hooks/useHouse'
import { useAreaActions } from '@/hooks/useAreaActions'
import { fetchLeaderboard, fetchUserStats } from '@/lib/api'
import { ordinal, randomGreeting, timeAgo, timeUntil } from '@/lib/format'
import { voterNames, type AreaView } from '@/lib/status'
import { AreaRow } from '@/components/AreaCard'
import { DoneFlood, SlideToClean, useSlideComplete } from '@/components/SlideToClean'
import type { CompletionResult } from '@/lib/types'
import { Avatar, Button, Card, ErrorBox, PageLoading, SectionTitle, cx } from '@/components/ui'

export function HomePage() {
  const { views, now, me, isLoading, error } = useAreaViews()
  const [hello, setHello] = useState('')
  useEffect(() => { if (me) setHello(randomGreeting(me.name)) }, [me?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const stats = useQuery({ queryKey: queryKeys.stats(me?.id), queryFn: () => fetchUserStats(), enabled: Boolean(me) })
  const lb = useQuery({ queryKey: queryKeys.leaderboard('round'), queryFn: () => fetchLeaderboard('round'), enabled: Boolean(me) })
  const { request, sheet } = useAreaActions(now)
  const champ = useReigningChampion()
  const slide = useSlideComplete()

  if (isLoading) return <PageLoading />
  if (error) return <ErrorBox error={error} />
  if (!me) return null

  // A just-finished task is no longer "mine" once the data refreshes, so keep its card around
  // (from the snapshot) while the finished state plays.
  const finished = slide.done
  const mine = [
    ...(finished && !views.some((v) => v.isMyResponsibility && v.area.id === finished.view.area.id) ? [finished.view] : []),
    ...views.filter((v) => v.isMyResponsibility),
  ]
  const others = views.filter((v) => v.isActive && !v.isMyResponsibility && v.area.id !== finished?.view.area.id)
  const calm = views.filter((v) => !v.isActive && v.area.id !== finished?.view.area.id)
  const top3 = (lb.data ?? []).slice(0, 3)
  const st = stats.data

  return (
    <div>
      <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
        <h1 className="text-[26px] font-bold leading-tight">{hello || ' '}</h1>
        <p className="text-[13.5px] text-slate-400 mt-1.5">
          <b className="text-slate-100 font-semibold tabular-nums">{st ? `${st.round_points} pts` : '—'}</b> this round
          <span className="text-slate-600"> · </span>
          <b className="text-slate-100 font-semibold">{st?.round_rank ? ordinal(st.round_rank) : '—'}</b>
          <span className="text-slate-600"> · </span>
          <b className="text-slate-100 font-semibold tabular-nums">{st ? st.current_streak : '—'}</b> in a row
        </p>
      </motion.div>

      <SectionTitle>Your turn</SectionTitle>
      {mine.length === 0 ? (
        <Card className="py-6">
          <p className="font-display font-semibold text-lg">You're all caught up</p>
          <p className="text-sm text-slate-400 mt-1">Nothing is waiting on you right now.</p>
        </Card>
      ) : (
        <div className="space-y-2">
          <AnimatePresence initial={false}>
            {mine.map((v) => (
              <HeroTask
                key={v.area.id} view={v} now={now} meId={me.id} skipPasses={st?.skip_passes ?? 0}
                result={finished?.view.area.id === v.area.id ? finished.result : undefined}
                onComplete={() => slide.complete(v)} onDismissResult={slide.dismiss}
                onRelease={() => request('release', v)} onVote={() => request('vote_dismiss', v)} onSkip={() => request('skip', v)}
              />
            ))}
          </AnimatePresence>
        </div>
      )}

      {others.length > 0 && (
        <>
          <SectionTitle>Needs a hand</SectionTitle>
          <div className="space-y-2">
            {others.map((v) => <OpenTask key={v.area.id} view={v} now={now} meId={me.id} onVolunteer={() => request('volunteer', v)} onVote={() => request('vote_dismiss', v)} />)}
          </div>
        </>
      )}

      <SectionTitle action={<Link to="/areas" className="text-[13px] font-medium text-butter">All areas</Link>}>The house</SectionTitle>
      <div className="space-y-1.5">
        {calm.map((v) => <AreaRow key={v.area.id} view={v} now={now} />)}
        {calm.length === 0 && <p className="text-sm text-slate-500 px-1">Every area is currently flagged. Busy house.</p>}
      </div>

      <SectionTitle action={<Link to="/league" className="text-[13px] font-medium text-butter">Full league</Link>}>
        {st && st.round_no !== null ? `Round ${st.round_no}` : 'This round'}
      </SectionTitle>
      {st && st.round_no !== null && (
        <p className="text-xs text-slate-500 -mt-1 mb-2 px-1">
          You've had {Math.min(st.round_turns, st.round_turns_needed)} of {st.round_turns_needed} turns
        </p>
      )}
      <Card className="py-2">
        {top3.length === 0 && <p className="text-sm text-slate-500 py-2">No points yet this round. First clean takes the lead.</p>}
        {top3.map((r) => (
          <div key={r.user_id} className={cx('flex items-center gap-3 py-2', r.user_id === me.id ? 'text-butter' : 'text-slate-200')}>
            <span className="w-4 text-sm text-slate-500 tabular-nums">{r.rank}</span>
            <Avatar name={r.name} url={r.avatar_url} size="sm" crown={r.user_id === champ} />
            <span className={cx('flex-1 truncate', r.user_id === me.id ? 'font-semibold' : 'font-medium')}>{r.name}{r.user_id === me.id && <span className="text-slate-500 font-normal"> (you)</span>}</span>
            <span className="font-semibold tabular-nums">{r.points}</span>
          </div>
        ))}
      </Card>

      {sheet}
    </div>
  )
}

/** "Priya thinks it looks fine · 1 of 3" with an Agree button for rotation members. */
function VoteLine({ view, meId, onVote }: { view: AreaView; meId: string; onVote: () => void }) {
  const { dismissVoters, dismissVotesNeeded, hasVotedDismiss, canVoteDismiss } = view
  if (dismissVoters.length === 0) return null
  return (
    <div className="mt-3 rounded-2xl bg-surface/60 px-3 py-2 text-xs text-slate-400 flex items-center gap-2">
      <span className="flex-1 min-w-0">
        <b className="text-slate-200">{voterNames(dismissVoters, meId)}</b> {dismissVoters.length === 1 ? 'thinks' : 'think'} it looks fine
        <span className="text-slate-600"> · </span>{dismissVoters.length} of {dismissVotesNeeded}
      </span>
      {canVoteDismiss && <button onClick={onVote} className="font-semibold text-butter shrink-0">Agree</button>}
      {hasVotedDismiss && <span className="text-butter/70 shrink-0">You agreed</span>}
    </div>
  )
}

const quiet = 'text-[13.5px] text-slate-300 underline underline-offset-[3px] decoration-slate-600 py-1'

function HeroTask({ view, now, meId, skipPasses, result, onComplete, onDismissResult, onRelease, onVote, onSkip }: {
  view: AreaView; now: Date; meId: string; skipPasses: number; result?: CompletionResult
  onComplete: () => Promise<boolean>; onDismissResult: () => void; onRelease: () => void; onVote: () => void; onSkip: () => void
}) {
  const nav = useNavigate()
  const { area, scheduled, amVolunteer, isMyTurn, volunteer, activatedBy, canVoteDismiss, dismissVoters } = view
  const canSkip = isMyTurn && area.state.activation_state === 'active' && !area.state.skip_from_user_id && skipPasses > 0
  const covering = amVolunteer && !isMyTurn
  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.25 } }}
      className="relative overflow-hidden rounded-3xl bg-card p-[18px] min-h-[208px]"
    >
      <button onClick={() => nav(`/areas/${area.id}`)} className="text-left w-full">
        <div className="text-[12.5px] font-semibold text-coral">{covering ? `Covering ${scheduled?.name ?? 'someone'}` : 'Your turn'}</div>
        <h3 className="text-[32px] font-bold leading-[1.1] tracking-[-0.03em] mt-0.5">{area.name}</h3>
        <p className="text-[13.5px] text-slate-300 mt-1">
          {activatedBy && <>{activatedBy.name} flagged it {timeAgo(area.state.activated_at, now)}. </>}
          {area.state.last_cleaned_at ? `Last cleaned ${timeAgo(area.state.last_cleaned_at, now)}.` : 'No cleaning recorded yet.'}
        </p>
        {isMyTurn && volunteer && <p className="text-[13.5px] text-butter mt-1">{volunteer.name} has offered to cover you, but you can still do it.</p>}
      </button>
      <SlideToClean className="mt-3.5" onComplete={onComplete} />
      {(covering || (canVoteDismiss && dismissVoters.length === 0) || canSkip) && (
        <div className="flex justify-between gap-3 mt-2.5 px-1">
          {covering
            ? <button className={quiet} onClick={onRelease}>Cancel volunteer</button>
            : canVoteDismiss && dismissVoters.length === 0
              ? <button className={quiet} onClick={onVote}>Looks fine to me</button>
              : <span />}
          {canSkip && <button className={quiet} onClick={onSkip}>Use a Skip Pass</button>}
        </div>
      )}
      <VoteLine view={view} meId={meId} onVote={onVote} />
      {result && <DoneFlood result={result} onDismiss={onDismissResult} />}
    </motion.div>
  )
}

function OpenTask({ view, now, meId, onVolunteer, onVote }: { view: AreaView; now: Date; meId: string; onVolunteer: () => void; onVote: () => void }) {
  const nav = useNavigate()
  const { area, scheduled, volunteer, canVolunteer, graceEndsAt, volunteeringEnabled } = view
  return (
    <Card className="rounded-2xl pl-3.5">
      <button onClick={() => nav(`/areas/${area.id}`)} className="flex items-center gap-3 w-full text-left">
        <span className="h-9 w-1 rounded-full shrink-0 bg-coral" />
        <div className="min-w-0 flex-1">
          <div className="font-display font-semibold text-[16.5px] tracking-[-0.01em]">{area.name}</div>
          <div className="text-[12.5px] text-slate-400 mt-0.5">
            {volunteer ? <>{volunteer.name} volunteered to cover {scheduled?.name ?? 'this'}</> : <><span className="text-coral">{scheduled?.name ?? 'Nobody'}'s turn</span> · flagged {timeAgo(area.state.activated_at, now)}</>}
          </div>
        </div>
      </button>
      {!volunteer && volunteeringEnabled && (
        canVolunteer ? (
          <Button variant="secondary" className="w-full mt-3" onClick={onVolunteer}>Volunteer to clean</Button>
        ) : graceEndsAt ? (
          <p className="text-xs text-slate-500 mt-2.5 pl-4">Volunteering opens {timeUntil(graceEndsAt, now)} if {scheduled?.name ?? 'they'} hasn't done it.</p>
        ) : null
      )}
      <VoteLine view={view} meId={meId} onVote={onVote} />
    </Card>
  )
}
