import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { format } from 'date-fns'
import { useHouse, useLeagueRound, useLeagueRounds, queryKeys } from '@/hooks/useHouse'
import { fetchLastWeekChampion, fetchLeaderboard, markForfeitDone } from '@/lib/api'
import { friendlyError } from '@/lib/errors'
import type { LeaderboardRow, LeaguePeriod, LeagueRound, LeagueRoundStatus } from '@/lib/types'
import { Avatar, Button, Card, ErrorBox, PageLoading, SectionTitle, cx, useToast } from '@/components/ui'

/** How a member relates to the open round, for the small label next to their name. */
type RoundTag = 'away' | 'exempt' | null

export function LeaderboardPage() {
  const [period, setPeriod] = useState<LeaguePeriod>('round')
  const { me, members, isAdmin, settings } = useHouse()
  const lb = useQuery({ queryKey: queryKeys.leaderboard(period), queryFn: () => fetchLeaderboard(period), enabled: Boolean(me) })
  const champ = useQuery({ queryKey: queryKeys.champion, queryFn: fetchLastWeekChampion, enabled: Boolean(me) })
  const rounds = useLeagueRounds()
  const round = useLeagueRound()

  const rows = lb.data ?? []
  const mine = rows.find((r) => r.user_id === me?.id)
  const leader = rows[0]
  const podium = rows.slice(0, 3)
  const rest = rows.slice(3)
  const awayIds = new Set(members.filter((m) => m.away).map((m) => m.id))
  const exemptIds = new Set((round.data?.members ?? []).filter((m) => !m.eligible && !m.away).map((m) => m.user_id))
  const tagFor = (id: string): RoundTag => (awayIds.has(id) ? 'away' : period === 'round' && exemptIds.has(id) ? 'exempt' : null)
  const lastRound = rounds.data?.[0]
  const reigning = lastRound?.champion_user_id ?? null
  const penalty = Number(settings.rescue_penalty_points ?? '5')
  const turns = Number(settings.league_turns_per_round ?? '3')
  const maxDays = Number(settings.league_max_round_days ?? '45')

  return (
    <div>
      <h1 className="text-2xl font-extrabold tracking-tight">🏆 House League</h1>
      <div className="mt-3 grid grid-cols-3 rounded-2xl bg-card border border-line p-1">
        {(['round', 'week', 'all'] as LeaguePeriod[]).map((p) => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            className={cx('h-10 rounded-xl text-sm font-semibold transition-colors', period === p ? 'bg-slate-100 text-slate-900' : 'text-slate-400 hover:text-slate-200')}
          >
            {p === 'week' ? 'This week' : p === 'round' ? 'This round' : 'All time'}
          </button>
        ))}
      </div>

      {period === 'round' && !round.isLoading && <RoundHeader status={round.data ?? null} />}

      {lb.isLoading && <div className="mt-4"><PageLoading /></div>}
      {lb.error && <div className="mt-4"><ErrorBox error={lb.error} retry={() => lb.refetch()} /></div>}

      {rows.length > 0 && (
        <>
          <div className="mt-6 grid grid-cols-3 items-end gap-2">
            {[podium[1], podium[0], podium[2]].map((r, i) => r && (
              <PodiumSpot key={r.user_id} row={r} tall={i === 1} isMe={r.user_id === me?.id} crown={r.user_id === reigning} tag={tagFor(r.user_id)} />
            ))}
          </div>

          {mine && leader && (
            <Card className="mt-4 text-center py-3 text-sm">
              {mine.rank === 1 ? (
                rows[1] && rows[1].points === mine.points ? <>You're tied for <b>#1</b>. Every clean counts.</> : <>You're <b>#1</b>{rows[1] ? <> — {mine.points - rows[1].points} points ahead of {rows[1].name}</> : ''}. Keep it up!</>
              ) : (
                <>You are <b>#{mine.rank}</b> — {leader.points - mine.points} points behind {leader.name}.</>
              )}
            </Card>
          )}

          {rest.length > 0 && (
            <Card className="mt-3 divide-y divide-line py-1">
              {rest.map((r) => {
                const tag = tagFor(r.user_id)
                return (
                  <Link key={r.user_id} to={`/profile/${r.user_id}`} className={cx('flex items-center gap-3 py-3', r.user_id === me?.id && 'text-emerald-200')}>
                    <span className="w-7 text-center font-bold text-slate-500">{r.rank}.</span>
                    <Avatar name={r.name} url={r.avatar_url} size="sm" crown={r.user_id === reigning} />
                    <span className="font-semibold flex-1 truncate">
                      {r.name}
                      {tag === 'away' && <span className="text-xs text-amber-200 font-normal"> · ✈️ away</span>}
                      {tag === 'exempt' && <span className="text-xs text-slate-500 font-normal"> · sits this round out</span>}
                    </span>
                    {r.own_turns !== null && r.turns_needed !== null
                      ? <TurnsChip have={r.own_turns} need={r.turns_needed} />
                      : r.current_streak > 1 && <span className="text-xs text-orange-300">🔥 {r.current_streak}</span>}
                    <span className={cx('font-bold tabular-nums w-10 text-right', r.points < 0 && 'text-rose-300')}>{r.points}</span>
                  </Link>
                )
              })}
            </Card>
          )}
        </>
      )}

      {lastRound && (
        <>
          <SectionTitle>Last round</SectionTitle>
          <LastRoundCard r={lastRound} meId={me?.id} isAdmin={isAdmin} />
        </>
      )}

      {champ.data && (
        <Card className="mt-3 flex items-center gap-3 py-3 bg-gradient-to-br from-amber-300/10 to-transparent border-amber-300/20">
          <div className="text-2xl">👑</div>
          <div className="flex-1 min-w-0">
            <div className="text-[10px] font-bold tracking-[0.18em] uppercase text-amber-200">Last week's champion</div>
            <div className="font-bold truncate">{champ.data.name} <span className="text-slate-400 font-normal text-sm">· {champ.data.points} pts · week of {format(new Date(champ.data.week_start), 'd MMM')}</span></div>
          </div>
          <Avatar name={champ.data.name} url={champ.data.avatar_url} size="sm" />
        </Card>
      )}

      {rounds.data && rounds.data.length > 1 && <HallOfFame results={rounds.data} meId={me?.id} />}

      <p className="text-xs text-slate-500 mt-6 px-1 leading-relaxed">
        The league runs in rounds. A round ends once everyone has had {turns} {turns === 1 ? 'turn' : 'turns'}, or after {maxDays} days at most.
        Only your first {turns} {turns === 1 ? 'turn counts' : 'turns count'} for you, but every rescue you do counts in full, and getting rescued costs {penalty} points.
        The winner earns a 🎟️ Skip Pass. The lowest scorer among those who had all their turns takes the forfeit.
        Ties go to whoever did more rescues, then whoever got there first (see the guide).
        A Skip Pass hands your turn to last round's lowest scorer. A weekly champion is still crowned every week, and all-time points are kept forever.
      </p>
    </div>
  )
}

function RoundHeader({ status }: { status: LeagueRoundStatus | null }) {
  if (!status) {
    return <Card className="mt-4 text-center py-3 text-sm text-slate-400">The league starts with the first clean.</Card>
  }
  const waitingFor = status.members.filter((m) => m.eligible)
  const done = waitingFor.filter((m) => m.own_turns >= status.turns_needed).length
  return (
    <Card className="mt-4 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-[11px] font-bold tracking-[0.18em] uppercase text-emerald-300">Round {status.round_no}</div>
        <div className="text-xs text-slate-500">since {format(new Date(status.started_at), 'd MMM')}</div>
      </div>
      <p className="text-sm mt-1">
        <b>{done} of {waitingFor.length}</b> {waitingFor.length === 1 ? 'member has' : 'members have'} had {status.turns_needed}/{status.turns_needed} turns.
      </p>
      <p className="text-xs text-slate-500 mt-0.5">Settles when everyone has, or on {format(new Date(status.settles_by), 'd MMM')} at the latest.</p>
    </Card>
  )
}

function TurnsChip({ have, need }: { have: number; need: number }) {
  const full = have >= need
  return (
    <span className={cx('text-xs tabular-nums rounded-full px-2 py-0.5 border', full ? 'text-emerald-300 border-emerald-300/30' : 'text-slate-400 border-line')}>
      {Math.min(have, need)}/{need}
    </span>
  )
}

function roundRange(r: LeagueRound) {
  return `${format(new Date(r.started_at), 'd MMM')} – ${format(new Date(r.ended_at), 'd MMM')}`
}

function LastRoundCard({ r, meId, isAdmin }: { r: LeagueRound; meId?: string; isAdmin: boolean }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const canTick = Boolean(meId && (meId === r.loser_user_id || isAdmin))
  const done = Boolean(r.forfeit_done_at)

  const tick = async (value: boolean) => {
    setBusy(true)
    try {
      await markForfeitDone(r.id, value)
      toast.show(value ? 'Forfeit marked as done.' : 'Forfeit reopened.', 'success')
      await qc.invalidateQueries({ queryKey: queryKeys.rounds })
    } catch (e) { toast.show(friendlyError(e), 'error') } finally { setBusy(false) }
  }

  return (
    <Card className="bg-gradient-to-br from-amber-300/10 via-transparent to-rose-400/10 border-amber-300/20 py-3">
      <div className="flex items-baseline justify-between gap-2 mb-2">
        <div className="text-[11px] font-bold tracking-[0.18em] uppercase text-amber-200">
          {r.settle_reason === 'legacy' ? format(new Date(r.started_at), 'MMMM yyyy') : `Round ${r.round_no} · ${roundRange(r)}`}
        </div>
        {r.settle_reason === 'max_length' && <span className="text-[10px] text-slate-500 shrink-0">hit the time limit</span>}
      </div>

      {r.champion_user_id ? (
        <Link to={`/profile/${r.champion_user_id}`} className="flex items-center gap-3 py-2">
          <span className="text-2xl w-8 text-center">🥇</span>
          <Avatar name={r.champion_name ?? '?'} url={r.champion_avatar_url} size="md" crown />
          <div className="flex-1 min-w-0">
            <div className={cx('font-extrabold truncate', r.champion_user_id === meId && 'text-emerald-200')}>{r.champion_name}{r.champion_user_id === meId && <span className="text-slate-500 font-normal"> (you)</span>}</div>
            <div className="text-xs text-slate-400">{r.champion_points} pts · earned a 🎟️ Skip Pass</div>
          </div>
        </Link>
      ) : (
        <p className="text-sm text-slate-400 py-2">No champion. Nobody scored this round.</p>
      )}

      {r.loser_user_id ? (
        <div className="border-t border-line mt-1 pt-3">
          <div className="flex items-center gap-3">
            <span className="text-2xl w-8 text-center">🫠</span>
            <Avatar name={r.loser_name ?? '?'} url={r.loser_avatar_url} size="md" />
            <div className="flex-1 min-w-0">
              <div className={cx('font-bold truncate', r.loser_user_id === meId && 'text-emerald-200')}>{r.loser_name}{r.loser_user_id === meId && <span className="text-slate-500 font-normal"> (you)</span>}</div>
              <div className={cx('text-sm', done ? 'text-slate-500 line-through' : 'text-rose-200')}>{r.forfeit ?? 'Forfeit'}</div>
            </div>
            {done
              ? <span className="text-xs text-emerald-300 font-semibold shrink-0">Done ✓</span>
              : canTick && <Button variant="secondary" size="sm" loading={busy} onClick={() => tick(true)}>Mark done</Button>}
          </div>
          {done && (
            <p className="text-xs text-slate-500 mt-2 px-1">
              Marked done{r.forfeit_done_by_name ? ` by ${r.forfeit_done_by_name}` : ''} on {format(new Date(r.forfeit_done_at!), 'd MMM')}.
              {isAdmin && <> <button onClick={() => tick(false)} disabled={busy} className="text-rose-300 hover:underline font-semibold">Reopen</button></>}
            </p>
          )}
        </div>
      ) : r.champion_user_id && r.settle_reason !== 'legacy' ? (
        <p className="text-xs text-slate-500 border-t border-line mt-1 pt-3 px-1">No forfeit. Fewer than two people had all their turns before the time limit.</p>
      ) : null}
    </Card>
  )
}

function HallOfFame({ results, meId }: { results: LeagueRound[]; meId?: string }) {
  const [open, setOpen] = useState(false)
  const past = results.slice(1)
  return (
    <>
      <SectionTitle action={<button onClick={() => setOpen((o) => !o)} className="text-xs font-semibold text-emerald-300">{open ? 'Hide' : `Show ${past.length}`}</button>}>Hall of fame</SectionTitle>
      {open && (
        <Card className="divide-y divide-line py-1">
          {past.map((r) => (
            <div key={r.id} className="flex items-center gap-3 py-2.5 text-sm">
              <span className="w-16 text-xs text-slate-500 shrink-0">{r.settle_reason === 'legacy' ? format(new Date(r.started_at), 'MMM yy') : `Round ${r.round_no}`}</span>
              <span className="flex-1 min-w-0 truncate">
                🥇 <b className={cx(r.champion_user_id === meId && 'text-emerald-200')}>{r.champion_name ?? '—'}</b>
                <span className="text-slate-500"> {r.champion_points}</span>
              </span>
              {r.loser_name && (
                <span className="flex-1 min-w-0 truncate text-slate-400">
                  🫠 {r.loser_name}{r.forfeit_done_at ? ' ✓' : ''}
                </span>
              )}
            </div>
          ))}
        </Card>
      )}
    </>
  )
}

function PodiumSpot({ row, tall, isMe, crown, tag }: { row: LeaderboardRow; tall: boolean; isMe: boolean; crown: boolean; tag: RoundTag }) {
  const medal = ['🥇', '🥈', '🥉'][row.rank - 1] ?? `#${row.rank}`
  return (
    <motion.div initial={{ y: 12, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: tall ? 0 : 0.1 }}>
      <Link to={`/profile/${row.user_id}`} className="flex flex-col items-center">
        <div className={cx('rounded-full p-[3px]', tall ? 'bg-gradient-to-br from-amber-300 to-orange-400' : 'bg-card-2')}>
          <Avatar name={row.name} url={row.avatar_url} size={tall ? 'xl' : 'lg'} className="ring-2 ring-card" crown={crown} />
        </div>
        <div className="text-2xl -mt-3">{medal}</div>
        <div className={cx('font-bold truncate max-w-full text-center', isMe && 'text-emerald-200')}>{row.name}</div>
        <div className={cx('font-black tabular-nums', tall ? 'text-2xl' : 'text-lg', row.points < 0 && 'text-rose-300')}>{row.points}</div>
        {tag === 'away'
          ? <div className="text-xs text-amber-200">✈️ away</div>
          : tag === 'exempt'
            ? <div className="text-xs text-slate-500">sits this round out</div>
            : row.own_turns !== null && row.turns_needed !== null
              ? <div className="mt-0.5"><TurnsChip have={row.own_turns} need={row.turns_needed} /></div>
              : row.current_streak > 1 && <div className="text-xs text-orange-300">🔥 {row.current_streak} streak</div>}
        <div className={cx('w-full rounded-t-2xl bg-card border border-line border-b-0 mt-2', tall ? 'h-16' : 'h-8')} />
      </Link>
    </motion.div>
  )
}
