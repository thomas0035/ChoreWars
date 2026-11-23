import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { ChevronRight } from 'lucide-react'
import { completeCleaning } from '@/lib/api'
import { friendlyError } from '@/lib/errors'
import type { AreaView } from '@/lib/status'
import type { CompletionResult } from '@/lib/types'
import { Spinner, cx, useToast } from './ui'

const KNOB = 48
/** How long the finished card stays on screen before it leaves. */
const DONE_MS = 5000

export interface SlideDone { view: AreaView; result: CompletionResult }

/**
 * Completes an area straight from the slide gesture (the slide is the confirmation),
 * then holds the result so the card can show its finished state for a few seconds.
 */
export function useSlideComplete() {
  const qc = useQueryClient()
  const toast = useToast()
  const [done, setDone] = useState<SlideDone | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(timer.current), [])

  const dismiss = useCallback(() => {
    clearTimeout(timer.current)
    setDone(null)
  }, [])

  const complete = useCallback(async (view: AreaView): Promise<boolean> => {
    try {
      const result = await completeCleaning(view.area.id)
      setDone({ view, result })
      for (const a of result.new_achievements) toast.show(`Achievement unlocked: ${a.name}`, 'success')
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setDone(null), DONE_MS)
      void qc.invalidateQueries()
      return true
    } catch (e) {
      toast.show(friendlyError(e), 'error')
      void qc.invalidateQueries()
      return false
    }
  }, [qc, toast])

  return { done, complete, dismiss }
}

/** Drag the knob to the end to confirm. Springs back if released early or if the action fails. */
export function SlideToClean({ onComplete, label = 'Slide to clean', className }: { onComplete: () => Promise<boolean>; label?: string; className?: string }) {
  const track = useRef<HTMLDivElement>(null)
  const start = useRef<{ px: number; x0: number } | null>(null)
  const [x, setX] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)

  const max = () => Math.max(0, (track.current?.clientWidth ?? KNOB) - KNOB)

  const finish = async () => {
    setBusy(true)
    setX(max())
    const ok = await onComplete()
    if (!ok) setX(0)
    setBusy(false)
  }

  const onDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (busy) return
    start.current = { px: e.clientX, x0: x }
    setDragging(true)
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onMove = (e: PointerEvent<HTMLButtonElement>) => {
    if (!start.current) return
    setX(Math.min(max(), Math.max(0, start.current.x0 + e.clientX - start.current.px)))
  }
  const onUp = () => {
    if (!start.current) return
    start.current = null
    setDragging(false)
    if (x >= max() * 0.85) void finish()
    else setX(0)
  }
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (busy || (e.key !== 'Enter' && e.key !== ' ')) return
    e.preventDefault()
    void finish()
  }

  const ease = dragging ? undefined : 'all 0.35s cubic-bezier(0.5, 0, 0.2, 1)'
  return (
    <div ref={track} className={cx('relative h-12 rounded-full bg-surface overflow-hidden select-none flex items-center justify-center', className)}>
      <span className="text-[13.5px] font-medium text-slate-400 pl-8" style={{ opacity: Math.max(0, 1 - x / 90) }}>{label}</span>
      <span className="absolute inset-y-0 left-0 rounded-full bg-butter/30" style={{ width: x + KNOB, transition: ease }} />
      <button
        type="button"
        aria-label={label}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onKeyDown={onKey}
        className="absolute top-0 left-0 h-12 w-12 rounded-full bg-butter text-on-butter grid place-items-center touch-none cursor-grab active:cursor-grabbing"
        style={{ transform: `translateX(${x}px)`, transition: ease }}
      >
        {busy ? <Spinner className="h-4 w-4" /> : <ChevronRight className="h-5 w-5" strokeWidth={2.5} />}
      </button>
    </div>
  )
}

/**
 * The finished state: butter floods the card from where the knob landed and the points pop in.
 * Render inside a `relative overflow-hidden` card.
 */
export function DoneFlood({ result, onDismiss }: { result: CompletionResult; onDismiss?: () => void }) {
  const rescue = result.completion_type === 'volunteer'
  const { base, early_bonus, streak_bonus } = result.breakdown
  const parts = [
    (early_bonus > 0 || streak_bonus > 0) && `${base} base`,
    early_bonus > 0 && `+${early_bonus} early`,
    streak_bonus > 0 && `+${streak_bonus} streak bonus`,
    !rescue && result.streak > 1 && `${result.streak} in a row`,
  ].filter(Boolean)

  return (
    <motion.div
      role="status"
      onClick={onDismiss}
      className="absolute inset-0 z-10 bg-butter text-on-butter p-[18px] flex flex-col justify-between"
      initial={{ clipPath: 'circle(0% at 88% 76%)' }}
      animate={{ clipPath: 'circle(170% at 88% 76%)' }}
      transition={{ duration: 0.8, ease: [0.5, 0, 0.2, 1] }}
    >
      <div>
        <div className="text-[12.5px] font-semibold">{rescue ? 'Rescued, just now' : 'Clean, just now'}</div>
        <h3 className="text-[32px] font-bold leading-[1.1] tracking-[-0.03em] mt-0.5">{result.area_name}</h3>
        <p className="text-[13.5px] mt-1 max-w-[26ch]">
          {rescue
            ? <>You covered {result.scheduled_user_name ?? 'someone'}.{result.penalty > 0 && <> They lose {result.penalty} points.</>}</>
            : result.next_user_name
              ? <>{result.next_user_name} is up next.</>
              : 'Nicely done.'}
        </p>
        {parts.length > 0 && <p className="text-xs mt-1 opacity-75">{parts.join(' · ')}</p>}
      </div>
      <motion.div
        className="self-end font-display text-[60px] font-bold leading-[0.9] tracking-[-0.045em] tabular-nums"
        initial={{ opacity: 0, y: 14, scale: 0.9 }} animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ delay: 0.45, type: 'spring', stiffness: 320, damping: 18 }}
        style={{ transformOrigin: '100% 100%' }}
      >
        +{result.points}
      </motion.div>
    </motion.div>
  )
}
