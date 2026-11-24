import type { AreaView } from '@/lib/status'

/** How an area "feels". Runs from delighted to upset as it gets dirtier. */
export type Mood = 'grin' | 'happy' | 'smile' | 'meh' | 'worried' | 'sad'

const INK = '#1b1707'

const MOUTHS: Record<Mood, string> = {
  grin: 'M7.2 13.4 Q12 20 16.8 13.4',
  happy: 'M8 14 Q12 18.2 16 14',
  smile: 'M9 14.8 Q12 17 15 14.8',
  meh: 'M9.2 15.6 L14.8 15.6',
  worried: 'M9 16.4 Q12 14.6 15 16.4',
  sad: 'M8.2 17.2 Q12 13.2 15.8 17.2',
}

export const FACE_COLORS = {
  mint: '#a8e0b0',
  butter: '#ebd98a',
  peach: '#f5b97a',
  tangerine: '#ff9466',
  coral: '#ff6f4d',
  sky: '#a9d3ee',
  grey: '#77746b',
} as const

/** Mood and colour for an area: green and happy when fresh, through to coral and upset when flagged. */
export function areaMood(view: AreaView): { mood: Mood; color: string } {
  if (view.area.state.activation_state === 'volunteer_claimed') return { mood: 'smile', color: FACE_COLORS.sky }
  if (view.isActive) return { mood: 'sad', color: FACE_COLORS.coral }
  switch (view.status.key) {
    case 'fresh': return { mood: 'happy', color: FACE_COLORS.mint }
    case 'due_soon': return { mood: 'smile', color: FACE_COLORS.butter }
    case 'ready': return { mood: 'meh', color: FACE_COLORS.peach }
    case 'attention': return { mood: 'worried', color: FACE_COLORS.tangerine }
    default: return { mood: 'meh', color: FACE_COLORS.grey }
  }
}

/** A stable 0–4s offset from any string, so faces on a page don't all blink together. */
function blinkDelay(seed: string): string {
  let h = 0
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return `${(h % 40) / 10}s`
}

export function Face({ mood, color = FACE_COLORS.butter, size = 28, seed = '', className }: { mood: Mood; color?: string; size?: number; seed?: string; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} style={{ flex: 'none' }} aria-hidden="true">
      <circle cx="12" cy="12" r="12" fill={color} style={{ transition: 'fill 0.3s' }} />
      <g className="face-eyes" style={{ animationDelay: blinkDelay(seed) }} fill={INK}>
        <circle cx="8.4" cy="10" r="1.55" />
        <circle cx="15.6" cy="10" r="1.55" />
      </g>
      <path d={MOUTHS[mood]} fill="none" stroke={INK} strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  )
}

/** A face for an area, coloured and posed from its current state. */
export function AreaFace({ view, size, className }: { view: AreaView; size?: number; className?: string }) {
  const { mood, color } = areaMood(view)
  return <Face mood={mood} color={color} size={size} seed={view.area.id} className={className} />
}
