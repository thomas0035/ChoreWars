export type HouseRole = 'member' | 'admin'
export type ActivationState = 'passive' | 'active' | 'volunteer_claimed'
export type CompletionType = 'normal' | 'volunteer'

export interface Profile {
  id: string
  name: string
  avatar_url: string | null
}

export interface Member extends Profile {
  role: HouseRole
  joined_at: string
  /** Away members are skipped in every rotation, take no penalty and are excluded from the forfeit. */
  away: boolean
}

export interface House {
  id: string
  name: string
}

export type HouseSettings = Record<string, string>

export interface AreaState {
  cleaning_area_id: string
  current_scheduled_user_id: string | null
  activation_state: ActivationState
  last_cleaned_at: string | null
  activated_at: string | null
  activated_by_user_id: string | null
  volunteer_user_id: string | null
  volunteer_claimed_at: string | null
  /** Set when the current turn was passed on with a Skip Pass: the skipper, whose rotation position resumes afterwards. */
  skip_from_user_id: string | null
  updated_at: string
}

export interface RotationMember {
  user_id: string
  position: number
}

export interface Area {
  id: string
  house_id: string
  name: string
  icon: string
  active: boolean
  normal_points: number
  rescue_points: number
  minimum_interval_hours: number
  expected_interval_hours: number
  attention_interval_hours: number
  volunteer_grace_hours: number
  reactivation_cooldown_hours: number | null
  sort_order: number
  state: AreaState
  rotation: RotationMember[]
  /** User ids who have voted "looks fine" on the current flag. */
  dismiss_votes: string[]
}

export interface HouseData {
  house: House
  settings: HouseSettings
  members: Member[]
  areas: Area[]
}

export interface Completion {
  id: string
  cleaning_area_id: string
  scheduled_user_id: string | null
  completed_by_user_id: string | null
  completion_type: CompletionType
  points_awarded: number
  activated_at: string | null
  completed_at: string
  area: { name: string; icon: string } | null
  scheduled: { name: string } | null
  cleaner: { name: string } | null
}

/** A manual give/take of points by an admin (a ledger row with reason 'admin_adjustment'). */
export interface PointAdjustment {
  id: string
  user_id: string
  points: number
  note: string
  created_at: string
  created_by: string | null
  member: { name: string } | null
  admin: { name: string } | null
}

export interface LeaderboardRow {
  user_id: string
  name: string
  avatar_url: string | null
  points: number
  rank: number
  current_streak: number
  /** Round tab only: own turns this round and the turns everyone needs. Null for week / all time. */
  own_turns: number | null
  turns_needed: number | null
}

export type LeaguePeriod = 'round' | 'week' | 'all'

export interface Achievement {
  id: string
  name: string
  description: string
  icon: string
  earned_at?: string
}

export interface UserStats {
  user_id: string
  weekly_points: number
  /** Capped score in the open league round. */
  round_points: number
  total_points: number
  weekly_rank: number | null
  round_rank: number | null
  /** Own turns resolved this round, and how many a round needs. */
  round_turns: number
  round_turns_needed: number
  round_no: number | null
  round_started_at: string | null
  member_count: number
  current_streak: number
  longest_streak: number
  normal_completions: number
  rescues: number
  weekly_wins: number
  round_wins: number
  /** Unused Skip Passes. */
  skip_passes: number
  /** Points lost to rescue penalties this round (positive number). */
  penalty_points: number
  achievements: Achievement[]
  week_start: string
  week_end: string
}

/** A settled league round (the open round is LeagueRoundStatus). */
export interface LeagueRound {
  id: string
  round_no: number
  started_at: string
  ended_at: string
  settle_reason: 'complete' | 'max_length' | 'legacy'
  champion_user_id: string | null
  champion_name: string | null
  champion_avatar_url: string | null
  champion_points: number
  loser_user_id: string | null
  loser_name: string | null
  loser_avatar_url: string | null
  loser_points: number | null
  forfeit: string | null
  forfeit_done_at: string | null
  forfeit_done_by_name: string | null
}

export interface LeagueRoundMember {
  user_id: string
  name: string
  avatar_url: string | null
  own_turns: number
  round_points: number
  /** False for members the round doesn't wait for: away, joined mid-round, or in no rotation. */
  eligible: boolean
  away: boolean
}

export interface LeagueRoundStatus {
  round_id: string
  round_no: number
  started_at: string
  /** The round settles by this time at the latest. */
  settles_by: string
  turns_needed: number
  max_days: number
  members: LeagueRoundMember[]
}

export interface SkipPassResult {
  area_id: string
  area_name: string
  next_user_id: string
  next_user_name: string
  /** lowest_last_round: went to last round's lowest scorer; rotation: their pick was away or no round has finished yet. */
  reason: 'lowest_last_round' | 'rotation'
  passes_left: number
}

export interface DismissVoteResult {
  area_id: string
  area_name: string
  dismissed: boolean
  votes: number
  needed: number
}

export interface Champion {
  user_id: string
  name: string
  avatar_url: string | null
  points: number
  week_start: string
}

export interface CompletionResult {
  completion_id: string
  completion_type: CompletionType
  area_id: string
  area_name: string
  area_icon: string
  points: number
  breakdown: { base: number; early_bonus: number; streak_bonus: number }
  /** Points the scheduled person lost (rescues only; 0 otherwise). */
  penalty: number
  streak: number
  scheduled_user_id: string | null
  scheduled_user_name: string | null
  next_user_id: string | null
  next_user_name: string | null
  new_achievements: Achievement[]
}
