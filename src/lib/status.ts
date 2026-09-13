import type { Area, Member } from './types'

export type StatusKey = 'fresh' | 'due_soon' | 'ready' | 'attention' | 'unknown'

export interface PassiveStatus {
  key: StatusKey
  label: string
  short: string
  hint: (areaName: string) => string
  hoursSince: number | null
}

const HOUR = 3_600_000

/** Pure function of last_cleaned_at + thresholds. Never stored. */
export function computeStatus(
  area: Pick<Area, 'minimum_interval_hours' | 'expected_interval_hours' | 'attention_interval_hours'>,
  lastCleanedAt: string | null,
  now: Date,
): PassiveStatus {
  if (!lastCleanedAt) {
    return {
      key: 'unknown',
      label: 'No record yet',
      short: 'New',
      hint: (n) => `Nobody has logged a clean of the ${n} yet. Worth a look.`,
      hoursSince: null,
    }
  }
  const hoursSince = (now.getTime() - new Date(lastCleanedAt).getTime()) / HOUR
  if (hoursSince < area.minimum_interval_hours) {
    return { key: 'fresh', label: 'Fresh', short: 'Fresh', hint: (n) => `The ${n} probably doesn't need cleaning yet.`, hoursSince }
  }
  if (hoursSince < area.expected_interval_hours) {
    return { key: 'due_soon', label: 'Due Soon', short: 'Due soon', hint: (n) => `The ${n} may need cleaning soon.`, hoursSince }
  }
  if (hoursSince < area.attention_interval_hours) {
    return { key: 'ready', label: 'Ready to Check', short: 'Check', hint: (n) => `Check whether the ${n} needs cleaning.`, hoursSince }
  }
  return { key: 'attention', label: 'Needs Attention', short: 'Attention', hint: (n) => `The ${n} likely needs cleaning.`, hoursSince }
}

export const STATUS_STYLES: Record<StatusKey, { dot: string; text: string; bg: string; ring: string }> = {
  fresh:     { dot: 'bg-emerald-400', text: 'text-emerald-300', bg: 'bg-emerald-400/10', ring: 'ring-emerald-400/30' },
  due_soon:  { dot: 'bg-amber-300',   text: 'text-amber-200',   bg: 'bg-amber-300/10',   ring: 'ring-amber-300/30' },
  ready:     { dot: 'bg-orange-400',  text: 'text-orange-300',  bg: 'bg-orange-400/10',  ring: 'ring-orange-400/30' },
  attention: { dot: 'bg-rose-400',    text: 'text-rose-300',    bg: 'bg-rose-400/10',    ring: 'ring-rose-400/30' },
  unknown:   { dot: 'bg-slate-400',   text: 'text-slate-300',   bg: 'bg-slate-400/10',   ring: 'ring-slate-400/30' },
}

export interface AreaView {
  area: Area
  status: PassiveStatus
  isActive: boolean
  scheduled: Member | undefined
  volunteer: Member | undefined
  activatedBy: Member | undefined
  isMyTurn: boolean
  amVolunteer: boolean
  /** I'm the one who should tap Mark as Done (scheduled, or the volunteer). */
  isMyResponsibility: boolean
  canComplete: boolean
  canMarkNeeds: boolean
  cooldownEndsAt: Date | null
  canVolunteer: boolean
  graceEndsAt: Date | null
  volunteeringEnabled: boolean
  canRelease: boolean
  canDismiss: boolean
  rotationPreview: Member[]
}

export function describeArea(
  area: Area,
  members: Member[],
  meId: string | undefined,
  isAdmin: boolean,
  settings: Record<string, string>,
  now: Date,
): AreaView {
  const byId = new Map(members.map((m) => [m.id, m]))
  const s = area.state
  const status = computeStatus(area, s.last_cleaned_at, now)
  const isActive = s.activation_state !== 'passive'
  const scheduled = s.current_scheduled_user_id ? byId.get(s.current_scheduled_user_id) : undefined
  const volunteer = s.volunteer_user_id ? byId.get(s.volunteer_user_id) : undefined
  const activatedBy = s.activated_by_user_id ? byId.get(s.activated_by_user_id) : undefined
  const isMyTurn = Boolean(meId && s.current_scheduled_user_id === meId)
  const amVolunteer = Boolean(meId && s.volunteer_user_id === meId)

  const cooldownHours = area.reactivation_cooldown_hours ?? Number(settings.default_reactivation_cooldown_hours ?? '4')
  const cooldownEndsAt = s.last_cleaned_at ? new Date(new Date(s.last_cleaned_at).getTime() + cooldownHours * HOUR) : null
  const canMarkNeeds = !isActive && (!cooldownEndsAt || now >= cooldownEndsAt)

  const volunteeringEnabled = (settings.volunteering_enabled ?? 'true') === 'true'
  const graceEndsAt = s.activated_at ? new Date(new Date(s.activated_at).getTime() + area.volunteer_grace_hours * HOUR) : null
  const canVolunteer =
    volunteeringEnabled &&
    s.activation_state === 'active' &&
    !isMyTurn &&
    Boolean(meId) &&
    Boolean(graceEndsAt && now >= graceEndsAt)

  const isMyResponsibility = isActive && (isMyTurn || amVolunteer)
  const canComplete = isMyResponsibility
  const canRelease = s.activation_state === 'volunteer_claimed' && (amVolunteer || isAdmin)
  const canDismiss = isActive && (isMyTurn || isAdmin)

  const sorted = [...area.rotation].sort((a, b) => a.position - b.position)
  const idx = sorted.findIndex((r) => r.user_id === s.current_scheduled_user_id)
  const ordered = idx >= 0 ? [...sorted.slice(idx), ...sorted.slice(0, idx)] : sorted
  const rotationPreview = ordered.map((r) => byId.get(r.user_id)).filter((m): m is Member => Boolean(m))

  return {
    area, status, isActive, scheduled, volunteer, activatedBy, isMyTurn, amVolunteer, isMyResponsibility,
    canComplete, canMarkNeeds, cooldownEndsAt, canVolunteer, graceEndsAt, volunteeringEnabled, canRelease, canDismiss,
    rotationPreview,
  }
}
