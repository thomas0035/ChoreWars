import type { ReactNode } from 'react'
import { useHouse } from '@/hooks/useHouse'
import type { Area } from '@/lib/types'
import { PageLoading, cx } from '@/components/ui'

/** "12 hours", "1 day", "2.5 days". */
function span(hours: number): string {
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`
  const d = Math.round((hours / 24) * 10) / 10
  return `${d} day${d === 1 ? '' : 's'}`
}

/** One value if every area agrees, otherwise "a range" so the copy stays true. */
function perArea(areas: Area[], pick: (a: Area) => number, fmt: (n: number) => string): string {
  const vals = [...new Set(areas.map(pick))].sort((a, b) => a - b)
  if (vals.length === 0) return fmt(0)
  if (vals.length === 1) return fmt(vals[0]!)
  return `${fmt(vals[0]!)} to ${fmt(vals[vals.length - 1]!)} (depends on the area)`
}

export function GuidePage() {
  const { areas, settings, isLoading } = useHouse()
  if (isLoading) return <PageLoading />

  const n = (k: string, d: number) => Number(settings[k] ?? d)
  const early = n('early_bonus_points', 2)
  const s3 = n('streak_bonus_3', 3), s5 = n('streak_bonus_5', 5), s10 = n('streak_bonus_10', 10)
  const penalty = n('rescue_penalty_points', 5)
  const turns = n('league_turns_per_round', 3)
  const maxDays = n('league_max_round_days', 45)
  const cooldownDefault = n('default_reactivation_cooldown_hours', 4)
  const forfeit = settings.league_forfeit ?? 'Buys snacks for the house'
  const volunteering = (settings.volunteering_enabled ?? 'true') === 'true'
  const grace = perArea(areas, (a) => a.volunteer_grace_hours, span)
  const cooldown = perArea(areas, (a) => a.reactivation_cooldown_hours ?? cooldownDefault, span)
  const turnsWord = `${turns} turn${turns === 1 ? '' : 's'}`

  return (
    <div>
      <h1 className="text-2xl font-extrabold tracking-tight">How ChoreWars works</h1>
      <p className="text-slate-400 text-sm mt-1">
        Everything you need to know, in plain words. The numbers here are your house's current settings.
      </p>

      <div className="mt-5 space-y-2">
        <Section icon="🏠" title="The idea in 30 seconds" open>
          <ol className="list-decimal pl-5 space-y-1.5">
            <li>Every area (kitchen, bathroom…) has its own <b>rotation</b>: a list of people who take turns.</li>
            <li>When an area looks dirty, <b>anyone</b> taps <Btn>🧹 This needs cleaning</Btn>. That's called <b>flagging</b> it.</li>
            <li>The person whose turn it is cleans it and taps <Btn>✓ Mark as done</Btn>. They get points.</li>
            <li>The turn moves to the next person in that area's rotation.</li>
          </ol>
          <p>That's it. Everything else (rescues, rounds, Skip Passes) is about keeping it fair and a bit competitive.</p>
        </Section>

        <Section icon="🚦" title="What the colours mean">
          <p>Each area shows how long it's been since it was last cleaned:</p>
          <ul className="space-y-1.5">
            <Dot cls="bg-emerald-400"><b>Fresh</b>: cleaned recently, probably fine.</Dot>
            <Dot cls="bg-amber-300"><b>Due soon</b>: getting close to its usual cleaning time.</Dot>
            <Dot cls="bg-orange-400"><b>Ready to check</b>: it's around the usual time. Have a look.</Dot>
            <Dot cls="bg-rose-400"><b>Needs attention</b>: it's been a long time. It almost certainly needs cleaning.</Dot>
          </ul>
          <p>These colours are only a hint. Nothing happens until someone <b>flags</b> the area. A flagged area shows whose turn it is.</p>
        </Section>

        <Section icon="⭐" title="Points">
          <Table
            head={['Area', 'Your turn', 'Rescue', 'Usually every']}
            rows={areas.map((a) => [`${a.icon} ${a.name}`, `+${a.normal_points}`, `+${a.rescue_points}`, span(a.expected_interval_hours)])}
          />
          <ul className="space-y-1.5">
            <li><b>Early bonus +{early}</b>: the area got flagged and you cleaned it before its usual time was up.</li>
            <li><b>Streak bonus</b>: +{s3} on your 3rd clean in a row, +{s5} on your 5th, +{s10} on your 10th.</li>
            <li>Flagging an area gives no points. It just tells the right person it's their turn.</li>
          </ul>
        </Section>

        <Section icon="🔥" title="Streaks">
          <p>Your streak goes up by one every time you clean on your own turn, in any area.</p>
          <p>It only goes back to 0 if someone else has to <b>rescue</b> one of your turns. Using a Skip Pass doesn't break it.</p>
        </Section>

        <Section icon="🦸" title="Rescues (volunteering)">
          {volunteering ? (
            <>
              <p>
                If a flagged area still isn't done <b>{grace}</b> after it was flagged, anyone else can tap{' '}
                <Btn>🙋 Volunteer to clean</Btn> and do it instead.
              </p>
              <ul className="space-y-1.5">
                <li>The person who rescues it gets the <b>rescue points</b> (see the table above).</li>
                {penalty > 0
                  ? <li>The person whose turn it was <b>loses {penalty} points</b> and their streak goes back to 0.</li>
                  : <li>The person whose turn it was loses their streak.</li>}
                <li>Even after someone volunteers, the person whose turn it is can still clean it themselves. Then it counts as a normal clean for them, and the volunteer gets nothing.</li>
                <li>Changed your mind after volunteering? Tap <Btn>Cancel my volunteer claim</Btn>.</li>
              </ul>
            </>
          ) : (
            <p>Volunteering is turned off in this house, so only the person whose turn it is can clean a flagged area.</p>
          )}
        </Section>

        <Section icon="👍" title={'"Looks fine" votes'}>
          <p>
            If an area was flagged but really doesn't need cleaning, the person whose turn it is can tap <Btn>Looks fine, not needed</Btn>.
            That starts a vote. Other people on that area's rotation can tap <Btn>Agree, looks fine</Btn>.
          </p>
          <p>Once <b>half</b> the rotation agrees (rounded up), the flag is cleared. Nobody gains or loses anything, and it stays the same person's turn.</p>
          <p>An admin can also clear a flag straight away.</p>
          <p>After an area is cleaned, it can't be flagged again for <b>{cooldown}</b>.</p>
        </Section>

        <Section icon="🏆" title="The league: rounds">
          <p>We compete in <b>rounds</b>, not calendar months. In a month one person might get several turns and someone else none, which isn't fair.</p>
          <ul className="space-y-1.5">
            <li>A round ends once <b>everyone has had {turnsWord}</b>. A turn counts once the area is cleaned, by you or by someone who rescued you.</li>
            <li>If a round drags on, it ends anyway after <b>{maxDays} days</b>.</li>
            <li>Only your <b>first {turnsWord}</b> in a round count towards your round score, so getting extra turns doesn't give anyone an edge.</li>
            <li>Rescues you do for other people <b>always count</b>. Volunteering is the way to climb the table.</li>
          </ul>
          <p>The League tab shows the current round, everyone's score and how many turns each person has had.</p>
        </Section>

        <Section icon="👑" title="End of a round">
          <p><b>Winner</b> (highest score): gets a <b>Skip Pass</b> and the League Champion badge, and wears the 👑 crown during the next round.</p>
          <p><b>Lowest scorer</b>: does the forfeit: <i>"{forfeit}"</i>. They tick it off in the app once it's done.</p>
          <p className="text-slate-400">
            You can only get the forfeit if you had all {turnsWord} in that round. If you joined partway through or were away, you're safe.
            If fewer than two people finished their turns before the time limit, there's no forfeit that round.
          </p>
        </Section>

        <Section icon="🎟️" title="Skip Pass">
          <p>When it's your turn on a flagged area (and nobody has volunteered yet), you can tap <Btn>🎟️ Use a Skip Pass</Btn> to hand the task on.</p>
          <ul className="space-y-1.5">
            <li>It goes to whoever came <b>last in the previous round</b>. If they're away, it goes to the next person in the rotation.</li>
            <li>It counts as <b>their</b> turn. You get no points, but no penalty, and your streak is safe.</li>
            <li>A task that was handed to you with a Skip Pass can't be skipped again.</li>
            <li>Once it's cleaned, the rotation carries on as if you had done it.</li>
          </ul>
        </Section>

        <Section icon="✈️" title="Going away">
          <p>Travelling? Ask an admin to mark you as <b>away</b>. While you're away:</p>
          <ul className="space-y-1.5">
            <li>You're skipped in every rotation.</li>
            <li>You can't lose points for a rescue.</li>
            <li>The round doesn't wait for you, and you can't get the forfeit.</li>
          </ul>
          <p>Tell an admin when you're back so you're put back in the rotations.</p>
        </Section>

        <Section icon="🥇" title="Weekly champion and badges">
          <p>Separately from rounds, whoever scores the most points each week is <b>Weekly Champion</b>. It's just for bragging rights.</p>
          <p>Badges (first clean, streaks, rescues and more) are on your <b>Profile</b>. Your all-time points are kept forever.</p>
        </Section>

        <Section icon="🔔" title="Notifications">
          <p>Go to <b>Profile → Notify me on this device</b> and allow notifications. Tap <b>Send a test</b> to check it works. Do this on each phone or computer you use.</p>
          <p>You'll get a notification when:</p>
          <ul className="space-y-1.5">
            <li>an area you're on is flagged and it's your turn,</li>
            <li>a flagged area is handed to you (Skip Pass, or someone went away),</li>
            <li>someone volunteers to rescue your turn,</li>
            <li>you're next in line for an area,</li>
            <li>an area that's your turn reaches <b>Needs attention</b>,</li>
            <li>your flagged area is still waiting and others can now rescue it.</li>
          </ul>
          <p className="text-slate-400">Reminders are only sent between 8am and 10pm. On iPhone, add the app to your Home Screen first (see below), then turn notifications on from inside it.</p>
        </Section>

        <Section icon="📱" title="Install it like an app">
          <p><b>iPhone</b>: open the site in Safari → Share → <b>Add to Home Screen</b>.</p>
          <p><b>Android</b>: open it in Chrome → ⋮ menu → <b>Add to Home screen</b> or <b>Install app</b>.</p>
          <p>It then opens full-screen like a normal app.</p>
        </Section>

        <Section icon="🛠️" title="Mistakes and admin help">
          <p>Tapped Mark as done by accident, or the wrong person is up? Ask an admin. They can undo the latest clean, change whose turn it is, and fix rotations.</p>
          <p>The clock button at the top right shows everything that has been cleaned and by whom.</p>
        </Section>
      </div>
    </div>
  )
}

function Section({ icon, title, open, children }: { icon: string; title: string; open?: boolean; children: ReactNode }) {
  return (
    <details open={open} className="group rounded-3xl bg-card border border-line">
      <summary className="flex items-center gap-3 px-4 h-14 cursor-pointer list-none select-none [&::-webkit-details-marker]:hidden">
        <span className="text-xl">{icon}</span>
        <span className="font-semibold flex-1">{title}</span>
        <span className="text-slate-500 transition-transform group-open:rotate-90">›</span>
      </summary>
      <div className="px-4 pb-4 -mt-1 space-y-3 text-[15px] leading-relaxed text-slate-300">{children}</div>
    </details>
  )
}

function Btn({ children }: { children: ReactNode }) {
  return <span className="inline-block whitespace-nowrap rounded-lg bg-white/10 px-1.5 py-0.5 text-[13px] font-semibold text-slate-100">{children}</span>
}

function Dot({ cls, children }: { cls: string; children: ReactNode }) {
  return (
    <li className="flex gap-2.5 items-baseline">
      <span className={cx('h-2.5 w-2.5 rounded-full shrink-0 translate-y-[-1px]', cls)} />
      <span>{children}</span>
    </li>
  )
}

function Table({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className="rounded-2xl border border-line overflow-hidden text-sm">
      <table className="w-full">
        <thead className="bg-white/5 text-slate-400 text-xs">
          <tr>{head.map((h, i) => <th key={h} className={cx('px-3 py-2 font-semibold', i === 0 ? 'text-left' : 'text-right')}>{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r) => (
            <tr key={r[0]}>
              {r.map((c, i) => <td key={i} className={cx('px-3 py-2', i === 0 ? 'text-left' : 'text-right tabular-nums')}>{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
