import { format, isToday, isYesterday, isThisYear } from 'date-fns'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** "just now", "3 hours ago", "9 days ago" */
export function timeAgo(iso: string | null, now: Date = new Date()): string {
  if (!iso) return 'never'
  const diff = now.getTime() - new Date(iso).getTime()
  if (diff < MIN) return 'just now'
  if (diff < HOUR) return plural(Math.floor(diff / MIN), 'minute') + ' ago'
  if (diff < DAY) return plural(Math.floor(diff / HOUR), 'hour') + ' ago'
  return plural(Math.floor(diff / DAY), 'day') + ' ago'
}

/** "in 2 hours", "in 40 minutes" */
export function timeUntil(date: Date, now: Date = new Date()): string {
  const diff = date.getTime() - now.getTime()
  if (diff <= 0) return 'now'
  if (diff < HOUR) return 'in ' + plural(Math.max(1, Math.ceil(diff / MIN)), 'minute')
  if (diff < DAY) return 'in ' + plural(Math.ceil(diff / HOUR), 'hour')
  return 'in ' + plural(Math.ceil(diff / DAY), 'day')
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** 168 -> "7 days", 36 -> "36 hours", 4 -> "4 hours" */
export function hoursHuman(h: number): string {
  if (h % 24 === 0 && h >= 24) return plural(h / 24, 'day')
  return plural(h, 'hour')
}

/** "5–7 days" */
export function intervalRange(minH: number, expH: number): string {
  const toDays = (h: number) => Math.round((h / 24) * 10) / 10
  if (minH % 24 === 0 && expH % 24 === 0) return `${minH / 24}–${expH / 24} days`
  return `${toDays(minH)}–${toDays(expH)} days`
}

export function dayLabel(iso: string): string {
  const d = new Date(iso)
  if (isToday(d)) return 'Today'
  if (isYesterday(d)) return 'Yesterday'
  return format(d, isThisYear(d) ? 'EEEE, d MMM' : 'd MMM yyyy')
}

export function timeLabel(iso: string): string {
  return format(new Date(iso), 'h:mm a')
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('')
}

export function greeting(now: Date = new Date()): string {
  const h = now.getHours()
  if (h < 5) return 'Up late'
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  if (h < 22) return 'Good evening'
  return 'Good night'
}

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]!)
}
