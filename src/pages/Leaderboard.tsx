import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { format } from 'date-fns'
import { useHouse, queryKeys } from '@/hooks/useHouse'
import { fetchLastWeekChampion, fetchLeaderboard } from '@/lib/api'
import type { LeaderboardRow } from '@/lib/types'
import { Avatar, Card, ErrorBox, PageLoading, cx } from '@/components/ui'

type Period = 'week' | 'month' | 'all'

export function LeaderboardPage() {
  const [period, setPeriod] = useState<Period>('week')
  const { me } = useHouse()
  const lb = useQuery({ queryKey: queryKeys.leaderboard(period), queryFn: () => fetchLeaderboard(period), enabled: Boolean(me) })
  const champ = useQuery({ queryKey: queryKeys.champion, queryFn: fetchLastWeekChampion, enabled: Boolean(me) })

  const rows = lb.data ?? []
  const mine = rows.find((r) => r.user_id === me?.id)
  const leader = rows[0]
  const podium = rows.slice(0, 3)
  const rest = rows.slice(3)

  return (
    <div>
      <h1 className="text-2xl font-extrabold tracking-tight">🏆 House League</h1>
      <div className="mt-3 grid grid-cols-3 rounded-2xl bg-card border border-line p-1">
        {(['week', 'month', 'all'] as Period[]).map((p) => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            className={cx('h-10 rounded-xl text-sm font-semibold transition-colors', period === p ? 'bg-slate-100 text-slate-900' : 'text-slate-400 hover:text-slate-200')}
          >
            {p === 'week' ? 'This week' : p === 'month' ? 'This month' : 'All time'}
          </button>
        ))}
      </div>

      {lb.isLoading && <div className="mt-4"><PageLoading /></div>}
      {lb.error && <div className="mt-4"><ErrorBox error={lb.error} retry={() => lb.refetch()} /></div>}

      {rows.length > 0 && (
        <>
          <div className="mt-6 grid grid-cols-3 items-end gap-2">
            {[podium[1], podium[0], podium[2]].map((r, i) => r && <PodiumSpot key={r.user_id} row={r} tall={i === 1} isMe={r.user_id === me?.id} />)}
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
              {rest.map((r) => (
                <Link key={r.user_id} to={`/profile/${r.user_id}`} className={cx('flex items-center gap-3 py-3', r.user_id === me?.id && 'text-emerald-200')}>
                  <span className="w-7 text-center font-bold text-slate-500">{r.rank}.</span>
                  <Avatar name={r.name} url={r.avatar_url} size="sm" />
                  <span className="font-semibold flex-1 truncate">{r.name}</span>
                  {r.current_streak > 1 && <span className="text-xs text-orange-300">🔥 {r.current_streak}</span>}
                  <span className="font-bold tabular-nums">{r.points}</span>
                </Link>
              ))}
            </Card>
          )}
        </>
      )}

      {champ.data && (
        <Card className="mt-6 flex items-center gap-4 bg-gradient-to-br from-amber-300/10 to-transparent border-amber-300/20">
          <div className="text-4xl">🏆</div>
          <div className="flex-1 min-w-0">
            <div className="text-[11px] font-bold tracking-[0.18em] uppercase text-amber-200">Last week's champion</div>
            <div className="font-extrabold text-lg truncate">{champ.data.name}</div>
            <div className="text-sm text-slate-400">{champ.data.points} points · week of {format(new Date(champ.data.week_start), 'd MMM')}</div>
          </div>
          <Avatar name={champ.data.name} url={champ.data.avatar_url} size="lg" />
        </Card>
      )}

      <p className="text-xs text-slate-500 mt-6 px-1 leading-relaxed">
        Weekly points are the main competition — everyone starts fresh each week. All-time points are kept forever.
      </p>
    </div>
  )
}

function PodiumSpot({ row, tall, isMe }: { row: LeaderboardRow; tall: boolean; isMe: boolean }) {
  const medal = ['🥇', '🥈', '🥉'][row.rank - 1] ?? `#${row.rank}`
  return (
    <motion.div initial={{ y: 12, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: tall ? 0 : 0.1 }}>
      <Link to={`/profile/${row.user_id}`} className="flex flex-col items-center">
        <div className={cx('rounded-full p-[3px]', tall ? 'bg-gradient-to-br from-amber-300 to-orange-400' : 'bg-card-2')}>
          <Avatar name={row.name} url={row.avatar_url} size={tall ? 'xl' : 'lg'} className="ring-2 ring-card" />
        </div>
        <div className="text-2xl -mt-3">{medal}</div>
        <div className={cx('font-bold truncate max-w-full text-center', isMe && 'text-emerald-200')}>{row.name}</div>
        <div className={cx('font-black tabular-nums', tall ? 'text-2xl' : 'text-lg')}>{row.points}</div>
        {row.current_streak > 1 && <div className="text-xs text-orange-300">🔥 {row.current_streak} streak</div>}
        <div className={cx('w-full rounded-t-2xl bg-card border border-line border-b-0 mt-2', tall ? 'h-16' : 'h-8')} />
      </Link>
    </motion.div>
  )
}
