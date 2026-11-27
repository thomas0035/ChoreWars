import { format } from 'date-fns'
import { formatRupees } from './format'

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
  user_not_found: 'No account with that email.',
  invalid_email: "That doesn't look like an email address.",
  invalid_password: 'Use a starting password of at least 6 characters.',
  already_member: "They're already in the house.",
  unknown_setting: 'Unknown setting.',
  completion_not_found: 'That completion no longer exists.',
  not_latest_completion: 'Only the most recent completion of an area can be undone.',
  area_active: 'This area is currently flagged. Use "Clear flag" first, then undo.',
  not_in_area_rotation: "Only people in this area's rotation can vote on it.",
  dismiss_vote_not_started: 'Only the person whose turn it is can start a "looks fine" vote.',
  no_vote: "You haven't voted on this one.",
  no_skip_pass: "You don't have a Skip Pass. Win a round to earn one.",
  turn_not_skippable: "This task was passed to you with a Skip Pass, so it can't be skipped again.",
  no_one_to_skip_to: 'Nobody else is available in this rotation to take the turn.',
  result_not_found: 'That round no longer exists.',
  round_open: "That round hasn't finished yet.",
  round_settled: "That clean belongs to a round that has already been settled, so it can't be undone.",
  invalid_timezone: "That isn't a valid IANA timezone (e.g. Europe/London).",
  invalid_value: 'That value is not allowed.',
  skip_pass_used: "That round's Skip Pass was already used, so the round can't be discarded.",
  no_push_devices: 'Turn on notifications for this device first.',
  member_not_found: 'That person is not in this house.',
  note_required: 'Add a reason (3 to 200 characters) so everyone can see why.',
  adjustment_not_found: 'That adjustment no longer exists.',
  item_not_found: 'That item no longer exists.',
  item_finished: 'That item is finished. Nothing left to take.',
  invalid_name: 'Give the item a name (up to 60 characters).',
  invalid_unit: 'Pick a unit.',
  invalid_amount: 'Enter an amount greater than 0.',
  invalid_price: 'Enter a valid price.',
  whole_number_only: 'Use whole numbers for pieces and packs.',
  not_buyer: 'Only the person who bought it (or an admin) can do that.',
  nothing_to_put_back: "You haven't taken any of this.",
  nothing_left: 'All of it has been taken, so it stays finished.',
  take_not_found: 'That entry no longer exists.',
  undo_window_passed: 'You can only undo within 24 hours. Ask an admin.',
  nothing_owed: "They don't owe you anything right now.",
  payment_not_found: 'That payment no longer exists.',
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
  if (msg === 'adjustment_out_of_range') {
    const max = e?.details && /^\d+$/.test(e.details) ? e.details : null
    return max ? `Adjustments must be between 1 and ${max} points (change the limit in Settings).` : 'That adjustment is too large or zero.'
  }
  if (msg === 'not_enough_left') return e?.details ? `Only ${e.details} left.` : 'Not enough left.'
  if (msg === 'not_that_many') return e?.details ? `You can only put back ${e.details} (what you took in the last 24 hours).` : "You didn't take that many in the last 24 hours."
  if (msg === 'qty_below_taken') return e?.details ? `${e.details} has already been taken, so the quantity can't be lower.` : "The quantity can't be lower than what's been taken."
  if (msg === 'amount_exceeds_debt') {
    const owed = e?.details && /^\d+$/.test(e.details) ? Number(e.details) : null
    return owed !== null ? `They only owe you ${formatRupees(owed)}.` : "That's more than they owe you."
  }
  if (COPY[msg]) return COPY[msg]!
  if (msg.includes('Invalid login credentials')) return 'Wrong password. Try again.'
  if (msg.toLowerCase().includes('banned')) return "This account isn't in the house any more. Ask an admin to add you back."
  if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) return "Can't reach the server. Check your connection."
  if (msg.includes('violates check constraint')) return 'Those values are out of range. Check minimum ≤ expected ≤ attention.'
  return msg || 'Something went wrong.'
}
