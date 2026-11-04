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
  if (h < 5) return 'Up late?'
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  if (h < 22) return 'Good evening'
  return 'Good night'
}

// {name} is replaced with the person's first name. {tod} with the time-of-day greeting.
const GREETINGS = [
  '{tod}, {name}',
  '{tod}, {name}',
  'Welcome back, {name}',
  'Good to see you, {name}',
  'Hey {name}, good to have you back',
  'Hello again, {name}',
  'Nice to see you, {name}',
  'Glad you’re here, {name}',
  'Back at it, {name}?',
  'Ready when you are, {name}',
  'How’s it going, {name}?',
  'What’s on your mind, {name}?',
  'How’s the house looking, {name}?',
  'What needs doing today, {name}?',
  'Let’s keep the place sparkling, {name}',
  'The house missed you, {name}',
  'Let’s see how things stand, {name}',
  'Time for a quick look around, {name}',
  'Hope your day’s going well, {name}',
  'Good to have you here, {name}',
  'Let’s make the place shine, {name}',
  'You’re here. Nice, {name}',
]

/** A different greeting each visit, with the person's first name. */
export function randomGreeting(name: string, now: Date = new Date()): string {
  const first = name.trim().split(/\s+/)[0] || name
  const tpl = GREETINGS[Math.floor(Math.random() * GREETINGS.length)]!
  return tpl.replace('{tod}', greeting(now)).replace('{name}', first)
}

/** 8000 -> "₹80", 2450 -> "₹24.50" */
export function formatRupees(paise: number): string {
  const p = Math.round(paise)
  return '₹' + (p / 100).toLocaleString('en-IN', p % 100 === 0 ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const UNIT_LABEL: Record<string, string> = { pcs: 'pcs', pack: 'packs', g: 'g', kg: 'kg', ml: 'ml', l: 'L' }

/** (10, 'pcs') -> "10 pcs", (1, 'pack') -> "1 pack", (1.5, 'kg') -> "1.5 kg" */
export function formatQty(qty: number, unit: string): string {
  const n = Math.round(qty * 1000) / 1000
  const label = unit === 'pack' && n === 1 ? 'pack' : (UNIT_LABEL[unit] ?? unit)
  return `${n.toLocaleString('en-IN', { maximumFractionDigits: 3 })} ${label}`
}

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]!)
}
