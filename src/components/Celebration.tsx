import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Button } from './ui'

// Completions are celebrated in the card itself (see SlideToClean). This overlay is only for
// moments that happen away from a card, currently a volunteer claim.
type Celebration =
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
    const t = setTimeout(close, 6000)
    return () => clearTimeout(t)
  }, [current, close])

  return (
    <Ctx.Provider value={value}>
      {children}
      <AnimatePresence>
        {current && (
          <motion.div
            className="fixed inset-0 z-[70] flex items-center justify-center p-6 bg-black/75"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={close}
          >
            <motion.div
              initial={{ scale: 0.94, y: 12, opacity: 0 }} animate={{ scale: 1, y: 0, opacity: 1 }} exit={{ scale: 0.96, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 320, damping: 26 }}
              className="w-full max-w-sm rounded-3xl bg-card p-6"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="text-[12.5px] font-semibold text-butter">Volunteered</div>
              <h2 className="text-[28px] font-bold leading-tight mt-0.5">You're on it</h2>
              <p className="text-slate-300 text-sm mt-2">
                You're volunteering to clean the {current.areaName}. {current.scheduledName} stays recorded as the scheduled person, and you'll earn rescue points when it's done.
              </p>
              <Button className="mt-5 w-full" onClick={close}>Got it</Button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </Ctx.Provider>
  )
}

export function useCelebration() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useCelebration must be used inside CelebrationProvider')
  return ctx
}
