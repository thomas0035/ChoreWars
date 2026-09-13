import { Link, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { useAreaViews, queryKeys } from '@/hooks/useHouse'
import { useAreaActions } from '@/hooks/useAreaActions'
import { fetchLeaderboard, fetchUserStats } from '@/lib/api'
import { greeting, timeAgo, timeUntil } from '@/lib/format'
import type { AreaView } from '@/lib/status'
import { AreaRow } from '@/components/AreaCard'
import { Avatar, Button, Card, ErrorBox, PageLoading, SectionTitle, cx } from '@/components/ui'

export function HomePage() {
  const { views, now, me, isLoading, error } = useAreaViews()
  const stats = useQuery({ queryKey: queryKeys.stats(me?.id), queryFn: () => fetchUserStats(), enabled: Boolean(me) })
  const lb = useQuery({ queryKey: queryKeys.leaderboard('week'), queryFn: () => fetchLeaderboard('week'), enabled: Boolean(me) })
  const { request, sheet } = useAreaActions(now)

  if (isLoading) return <PageLoading />
  if (error) return <ErrorBox error={error} />
  if (!me) return null

  const mine = views.filter((v) => v.isMyResponsibility)
  const others = views.filter((v) => v.isActive && !v.isMyResponsibility)
  const top3 = (lb.data ?? []).slice(0, 3)

  return (
    <div>
      <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
        <p className="text-slate-400 text-sm">{greeting(now)},</p>
        <h1 className="text-3xl font-extrabold tracking-tight">{me.name} 👋</h1>
        <div className="flex gap-2 mt-3 flex-wrap">
          <Stat icon="⭐" label="this week" value={stats.data ? `${stats.data.weekly_points} pts` : '—'} />
          <Stat icon="🔥" label="streak" value={stats.data ? `${stats.data.current_streak}` : '—'} />
          {stats.data?.weekly_rank && <Stat icon="🏆" label="rank" value={`#${stats.data.weekly_rank}`} />}
        </div>
      </motion.div>

      <SectionTitle>Your turn</SectionTitle>
      {mine.length === 0 ? (
        <Card className="text-center py-7">
          <div className="text-4xl">🎉</div>
          <p className="font-bold text-lg mt-2">You're all caught up!</p>
          <p className="text-sm text-slate-400 mt-1">You don't have an active cleaning task right now.</p>
        </Card>
      ) : (
        <div className="space-y-3">
          {mine.map((v) => <HeroTask key={v.area.id} view={v} now={now} onComplete={() => request('complete', v)} onRelease={() => request('release', v)} onDismiss={() => request('dismiss', v)} />)}
        </div>
      )}

      {others.length > 0 && (
        <>
          <SectionTitle>Needs a hand</SectionTitle>
          <div className="space-y-3">
            {others.map((v) => <OpenTask key={v.area.id} view={v} now={now} onVolunteer={() => request('volunteer', v)} />)}
          </div>
        </>
      )}

      <SectionTitle action={<Link to="/areas" className="text-xs font-semibold text-emerald-300">All areas</Link>}>House status</SectionTitle>
      <div className="space-y-2">
        {views.filter((v) => !v.isActive).map((v) => <AreaRow key={v.area.id} view={v} now={now} />)}
        {views.filter((v) => !v.isActive).length === 0 && <p className="text-sm text-slate-500 px-1">Every area is currently flagged. Busy house!</p>}
      </div>

      <SectionTitle action={<Link to="/league" className="text-xs font-semibold text-emerald-300">Full league</Link>}>This week</SectionTitle>
      <Card className="divide-y divide-line py-1">
        {top3.length === 0 && <p className="text-sm text-slate-500 py-3">No points yet this week. First clean takes the lead.</p>}
        {top3.map((r) => (
          <div key={r.user_id} className={cx('flex items-center gap-3 py-3', r.user_id === me.id && 'text-emerald-200')}>
            <span className="w-7 text-xl text-center">{['🥇', '🥈', '🥉'][r.rank - 1] ?? `${r.rank}.`}</span>
            <Avatar name={r.name} url={r.avatar_url} size="sm" />
            <span className="font-semibold flex-1 truncate">{r.name}{r.user_id === me.id && <span className="text-slate-500 font-normal"> (you)</span>}</span>
            <span className="font-bold tabular-nums">{r.points}</span>
          </div>
        ))}
      </Card>

      {sheet}
    </div>
  )
}

function Stat({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <div className="inline-flex items-center gap-1.5 rounded-full bg-card border border-line px-3 py-1.5 text-sm">
      <span>{icon}</span>
      <span className="font-bold tabular-nums">{value}</span>
      <span className="text-slate-500">{label}</span>
    </div>
  )
}

function HeroTask({ view, now, onComplete, onRelease, onDismiss }: { view: AreaView; now: Date; onComplete: () => void; onRelease: () => void; onDismiss: () => void }) {
  const nav = useNavigate()
  const { area, scheduled, amVolunteer, isMyTurn, volunteer, activatedBy } = view
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }}
      className="relative rounded-[28px] p-[1.5px] bg-gradient-to-br from-emerald-400 via-sky-400 to-violet-400 shadow-2xl shadow-emerald-500/15"
    >
      <div className="rounded-[26px] bg-card p-5">
        <button onClick={() => nav(`/areas/${area.id}`)} className="text-left w-full">
          <div className="flex items-start gap-4">
            <div className="h-14 w-14 rounded-2xl bg-card-2 flex items-center justify-center text-3xl shrink-0">{area.icon}</div>
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-bold tracking-[0.18em] uppercase text-rose-300">⚠️ Needs cleaning</div>
              <h3 className="text-2xl font-extrabold leading-tight mt-0.5">{area.name}</h3>
              <p className="text-slate-300 mt-1">
                {amVolunteer && !isMyTurn ? <>You volunteered to cover <b>{scheduled?.name}</b>.</> : "It's your turn to clean."}
              </p>
              <p className="text-sm text-slate-500 mt-1">
                {area.state.last_cleaned_at ? `Last cleaned ${timeAgo(area.state.last_cleaned_at, now)}` : 'No cleaning recorded yet'}
                {activatedBy && <> · flagged by {activatedBy.name} {timeAgo(area.state.activated_at, now)}</>}
              </p>
              {isMyTurn && volunteer && <p className="text-sm text-sky-300 mt-1">🙋 {volunteer.name} has offered to cover you — but you can still do it.</p>}
            </div>
          </div>
        </button>
        <Button variant="hero" size="lg" className="w-full mt-4" onClick={onComplete}>✓ Mark as done</Button>
        <div className="flex justify-between mt-2">
          {amVolunteer && !isMyTurn ? (
            <Button variant="ghost" size="sm" onClick={onRelease}>Cancel volunteer</Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={onDismiss}>Looks fine, not needed</Button>
          )}
        </div>
      </div>
    </motion.div>
  )
}

function OpenTask({ view, now, onVolunteer }: { view: AreaView; now: Date; onVolunteer: () => void }) {
  const nav = useNavigate()
  const { area, scheduled, volunteer, canVolunteer, graceEndsAt, volunteeringEnabled } = view
  return (
    <Card className="border-rose-400/20">
      <button onClick={() => nav(`/areas/${area.id}`)} className="flex items-center gap-3 w-full text-left">
        <div className="h-11 w-11 rounded-2xl bg-card-2 flex items-center justify-center text-2xl shrink-0">{area.icon}</div>
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{area.name}</div>
          <div className="text-sm text-slate-400">
            {volunteer ? <>🙋 {volunteer.name} volunteered to cover {scheduled?.name ?? 'this'}</> : <>{scheduled?.name ?? 'Nobody'}'s turn · flagged {timeAgo(area.state.activated_at, now)}</>}
          </div>
        </div>
      </button>
      {!volunteer && volunteeringEnabled && (
        canVolunteer ? (
          <Button variant="secondary" className="w-full mt-3" onClick={onVolunteer}>🙋 Volunteer to clean</Button>
        ) : graceEndsAt ? (
          <p className="text-xs text-slate-500 mt-3 px-1">Volunteering opens {timeUntil(graceEndsAt, now)} if {scheduled?.name ?? 'they'} hasn't done it.</p>
        ) : null
      )}
    </Card>
  )
}
