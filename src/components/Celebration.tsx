import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import confetti from 'canvas-confetti'
import type { CompletionResult } from '@/lib/types'
import { Button } from './ui'

type Celebration =
  | { kind: 'completion'; result: CompletionResult }
  | { kind: 'volunteer'; areaName: string; areaIcon: string; scheduledName: string }
  | null

const Ctx = createContext<{ celebrate: (c: NonNullable<Celebration>) => void } | null>(null)

export function CelebrationProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<Celebration>(null)
  const celebrate = useCallback((c: NonNullable<Celebration>) => setCurrent(c), [])
  const value = useMemo(() => ({ celebrate }), [celebrate])
  const close = useCallback(() => setCurrent(null), [])

  useEffect(() => {
    if (!current) return
    const rescue = current.kind === 'completion' && current.result.completion_type === 'volunteer'
    confetti({
      particleCount: rescue ? 160 : 110,
      spread: 75,
      startVelocity: 38,
      origin: { y: 0.6 },
      colors: rescue ? ['#38bdf8', '#a78bfa', '#f472b6', '#fde68a'] : ['#34d399', '#38bdf8', '#fde68a', '#f9a8d4'],
      disableForReducedMotion: true,
    })
    const t = setTimeout(close, 6000)
    return () => clearTimeout(t)
  }, [current, close])

  return (
    <Ctx.Provider value={value}>
      {children}
      <AnimatePresence>
        {current && (
          <motion.div
            className="fixed inset-0 z-[70] flex items-center justify-center p-6 bg-slate-950/80 backdrop-blur-sm"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={close}
          >
            <motion.div
              initial={{ scale: 0.8, y: 20, opacity: 0 }} animate={{ scale: 1, y: 0, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 320, damping: 24 }}
              className="w-full max-w-sm rounded-[32px] bg-card border border-line p-7 text-center shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              {current.kind === 'completion' ? <CompletionBody r={current.result} /> : <VolunteerBody c={current} />}
              <Button variant="secondary" className="mt-6 w-full" onClick={close}>Nice</Button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </Ctx.Provider>
  )
}

function CompletionBody({ r }: { r: CompletionResult }) {
  const rescue = r.completion_type === 'volunteer'
  return (
    <>
      <motion.div initial={{ scale: 0 }} animate={{ scale: [0, 1.25, 1] }} transition={{ duration: 0.5, delay: 0.1 }} className="text-6xl">
        {rescue ? '🦸' : '🎉'}
      </motion.div>
      <h2 className="text-2xl font-extrabold mt-3">{rescue ? 'House Hero!' : `${r.area_name} Cleaned!`}</h2>
      {rescue && (
        <p className="text-slate-400 mt-1">You cleaned the {r.area_name} when {r.scheduled_user_name ?? 'someone'} couldn't.</p>
      )}
      <div className="mt-5 text-4xl font-black bg-gradient-to-r from-emerald-300 to-sky-300 bg-clip-text text-transparent">
        +{r.points} {rescue ? 'Rescue Points' : 'Points'}
      </div>
      {(r.breakdown.early_bonus > 0 || r.breakdown.streak_bonus > 0) && (
        <p className="text-xs text-slate-400 mt-1">
          {r.breakdown.base} base
          {r.breakdown.early_bonus > 0 && ` · +${r.breakdown.early_bonus} early`}
          {r.breakdown.streak_bonus > 0 && ` · +${r.breakdown.streak_bonus} streak bonus`}
        </p>
      )}
      <div className="mt-5 flex justify-center gap-2 flex-wrap">
        {!rescue && r.streak > 1 && <Pill>🔥 {r.streak}-task streak</Pill>}
        {r.next_user_name && <Pill>Next up: {r.next_user_name}</Pill>}
      </div>
      {r.new_achievements.length > 0 && (
        <div className="mt-5 space-y-2">
          {r.new_achievements.map((a) => (
            <motion.div key={a.id} initial={{ x: -10, opacity: 0 }} animate={{ x: 0, opacity: 1 }} transition={{ delay: 0.4 }}
              className="flex items-center gap-3 rounded-2xl bg-amber-300/10 border border-amber-300/25 p-3 text-left">
              <span className="text-2xl">{a.icon}</span>
              <div>
                <div className="text-xs font-bold uppercase tracking-wider text-amber-200">Achievement unlocked</div>
                <div className="font-semibold">{a.name}</div>
              </div>
            </motion.div>
          ))}
        </div>
      )}
    </>
  )
}

function VolunteerBody({ c }: { c: { areaName: string; areaIcon: string; scheduledName: string } }) {
  return (
    <>
      <div className="text-6xl">🙋</div>
      <h2 className="text-2xl font-extrabold mt-3">You're on it</h2>
      <p className="text-slate-400 mt-2">
        You're volunteering to clean the {c.areaName}. {c.scheduledName} stays recorded as the scheduled person, and you'll earn rescue points when it's done.
      </p>
    </>
  )
}

function Pill({ children }: { children: ReactNode }) {
  return <span className="rounded-full bg-card-2 border border-line px-3 py-1.5 text-sm font-medium">{children}</span>
}

export function useCelebration() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useCelebration must be used inside CelebrationProvider')
  return ctx
}
