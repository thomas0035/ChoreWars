import { format } from 'date-fns'

const COPY: Record<string, string> = {
  not_authenticated: 'You need to sign in first.',
  not_a_member: "You're not a member of this house.",
  not_admin: 'Only admins can do that.',
  area_not_found: "That area doesn't exist any more.",
  already_active: 'Someone already flagged this area.',
  not_active: 'This area needs to be flagged as Needs Cleaning first.',
  not_authorized: "It's not your turn for this one.",
  no_rotation: 'This area has nobody in its rotation yet. Ask an admin.',
  already_claimed: 'Someone else just volunteered for this.',
  is_scheduled_user: "It's already your turn — just mark it done.",
  not_claimed: 'Nobody has volunteered for this.',
  volunteering_disabled: 'Volunteering is turned off for this house.',
  not_in_rotation: 'That person is not in this rotation.',
  duplicate_member: 'Each person can only appear once in a rotation.',
  last_admin: "You're the last admin — promote someone else first.",
  cannot_remove_self: "You can't remove yourself.",
  user_not_found: 'No account with that email. Create it in Supabase Auth first.',
  unknown_setting: 'Unknown setting.',
  invalid_timezone: "That isn't a valid IANA timezone (e.g. Europe/London).",
  invalid_value: 'That value is not allowed.',
}

export function friendlyError(err: unknown): string {
  const e = err as { message?: string; details?: string; code?: string } | undefined
  const msg = e?.message ?? ''
  if (msg === 'cooldown') {
    const at = e?.details ? new Date(e.details) : null
    return at && !Number.isNaN(at.getTime())
      ? `Recently cleaned — you can flag this again after ${format(at, 'h:mm a')}.`
      : 'Recently cleaned — check back later.'
  }
  if (msg === 'grace_period') {
    const at = e?.details ? new Date(e.details) : null
    return at && !Number.isNaN(at.getTime())
      ? `Give them a chance first — volunteering opens ${format(at, 'EEE h:mm a')}.`
      : 'Volunteering opens after the grace period.'
  }
  if (COPY[msg]) return COPY[msg]!
  if (msg.includes('Invalid login credentials')) return 'Wrong password. Try again.'
  if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) return "Can't reach the server. Check your connection."
  if (msg.includes('violates check constraint')) return 'Those values are out of range. Check minimum ≤ expected ≤ attention.'
  return msg || 'Something went wrong.'
}
