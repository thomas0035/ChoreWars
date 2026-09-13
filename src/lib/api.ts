import { supabase } from './supabase'
import type {
  Area, AreaState, Champion, Completion, CompletionResult, HouseData, HouseRole, LeaderboardRow, Member, RotationMember, UserStats,
} from './types'

function unwrap<T>(res: { data: T | null; error: { message: string; details?: string } | null }): T {
  if (res.error) throw res.error
  return res.data as T
}

function one<T>(v: T | T[] | null | undefined): T | undefined {
  if (Array.isArray(v)) return v[0]
  return v ?? undefined
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
export async function fetchHouse(): Promise<HouseData | null> {
  const [houses, members, areas, settings] = await Promise.all([
    supabase.from('houses').select('id, name').limit(1),
    supabase.from('house_members').select('user_id, role, joined_at, profile:profiles(id, name, avatar_url)'),
    supabase
      .from('cleaning_areas')
      .select('*, state:cleaning_area_state(*), rotation:cleaning_rotation_members(user_id, position)')
      .eq('active', true)
      .order('sort_order'),
    supabase.from('house_settings').select('key, value'),
  ])

  const house = unwrap(houses)[0]
  if (!house) return null

  type RawMember = { user_id: string; role: HouseRole; joined_at: string; profile: { id: string; name: string; avatar_url: string | null } | { id: string; name: string; avatar_url: string | null }[] | null }
  const memberRows: Member[] = (unwrap(members) as RawMember[])
    .map((m) => {
      const p = one(m.profile)
      return p ? { id: p.id, name: p.name, avatar_url: p.avatar_url, role: m.role, joined_at: m.joined_at } : null
    })
    .filter((m): m is Member => m !== null)
    .sort((a, b) => a.name.localeCompare(b.name))

  type RawArea = Omit<Area, 'state' | 'rotation'> & { state: AreaState | AreaState[] | null; rotation: RotationMember[] | null }
  const areaRows: Area[] = (unwrap(areas) as RawArea[])
    .map((a) => {
      const state = one(a.state)
      if (!state) return null
      return { ...a, state, rotation: (a.rotation ?? []).sort((x, y) => x.position - y.position) }
    })
    .filter((a): a is Area => a !== null)

  const settingsMap: Record<string, string> = {}
  for (const row of unwrap(settings) as { key: string; value: string }[]) settingsMap[row.key] = row.value

  return { house, settings: settingsMap, members: memberRows, areas: areaRows }
}

export async function fetchLeaderboard(period: 'week' | 'month' | 'all'): Promise<LeaderboardRow[]> {
  return unwrap(await supabase.rpc('get_leaderboard', { p_period: period })) as LeaderboardRow[]
}

export async function fetchUserStats(userId?: string): Promise<UserStats> {
  return unwrap(await supabase.rpc('get_user_stats', userId ? { p_user_id: userId } : {})) as UserStats
}

export async function fetchLastWeekChampion(): Promise<Champion | null> {
  return (unwrap(await supabase.rpc('get_last_week_champion')) as Champion | null) ?? null
}

export interface HistoryFilters {
  userId?: string
  areaId?: string
  type?: 'normal' | 'volunteer'
  limit?: number
}

export async function fetchHistory(f: HistoryFilters = {}): Promise<Completion[]> {
  let q = supabase
    .from('cleaning_completions')
    .select(
      'id, cleaning_area_id, scheduled_user_id, completed_by_user_id, completion_type, points_awarded, activated_at, completed_at, ' +
        'area:cleaning_areas(name, icon), scheduled:profiles!cleaning_completions_scheduled_user_id_fkey(name), cleaner:profiles!cleaning_completions_completed_by_user_id_fkey(name)',
    )
    .order('completed_at', { ascending: false })
    .limit(f.limit ?? 100)
  if (f.userId) q = q.or(`completed_by_user_id.eq.${f.userId},scheduled_user_id.eq.${f.userId}`)
  if (f.areaId) q = q.eq('cleaning_area_id', f.areaId)
  if (f.type) q = q.eq('completion_type', f.type)
  const rows = unwrap(await q) as unknown as Array<Omit<Completion, 'area' | 'scheduled' | 'cleaner'> & {
    area: Completion['area'] | NonNullable<Completion['area']>[]
    scheduled: Completion['scheduled'] | NonNullable<Completion['scheduled']>[]
    cleaner: Completion['cleaner'] | NonNullable<Completion['cleaner']>[]
  }>
  return rows.map((r) => ({ ...r, area: one(r.area) ?? null, scheduled: one(r.scheduled) ?? null, cleaner: one(r.cleaner) ?? null }))
}

export async function fetchLoginDirectory(): Promise<{ name: string; avatar_url: string | null; email: string }[]> {
  const res = await supabase.rpc('login_directory')
  if (res.error) return []
  return (res.data ?? []) as { name: string; avatar_url: string | null; email: string }[]
}

// ---------------------------------------------------------------------------
// Member actions (all server-side, atomic)
// ---------------------------------------------------------------------------
export async function markNeedsCleaning(areaId: string) {
  return unwrap(await supabase.rpc('mark_needs_cleaning', { p_area_id: areaId })) as {
    area_id: string; area_name: string; area_icon: string; scheduled_user_id: string; scheduled_user_name: string
  }
}
export async function dismissActivation(areaId: string) {
  return unwrap(await supabase.rpc('dismiss_activation', { p_area_id: areaId }))
}
export async function claimVolunteer(areaId: string) {
  return unwrap(await supabase.rpc('claim_volunteer', { p_area_id: areaId })) as {
    area_id: string; area_name: string; area_icon: string; scheduled_user_name: string
  }
}
export async function releaseVolunteer(areaId: string) {
  return unwrap(await supabase.rpc('release_volunteer', { p_area_id: areaId }))
}
export async function completeCleaning(areaId: string): Promise<CompletionResult> {
  return unwrap(await supabase.rpc('complete_cleaning', { p_area_id: areaId })) as CompletionResult
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------
export interface AreaInput {
  id?: string
  name?: string
  icon?: string
  normal_points?: number
  rescue_points?: number
  minimum_interval_hours?: number
  expected_interval_hours?: number
  attention_interval_hours?: number
  volunteer_grace_hours?: number
  reactivation_cooldown_hours?: number | null
  sort_order?: number
  active?: boolean
}
export async function adminSaveArea(input: AreaInput): Promise<string> {
  return unwrap(await supabase.rpc('admin_save_area', { p: input })) as string
}
export async function adminSetRotation(areaId: string, userIds: string[]) {
  return unwrap(await supabase.rpc('admin_set_rotation', { p_area_id: areaId, p_user_ids: userIds }))
}
export async function adminSetScheduledUser(areaId: string, userId: string) {
  return unwrap(await supabase.rpc('admin_set_scheduled_user', { p_area_id: areaId, p_user_id: userId }))
}
export async function adminSetMemberRole(userId: string, role: HouseRole) {
  return unwrap(await supabase.rpc('admin_set_member_role', { p_user_id: userId, p_role: role }))
}
export async function adminRenameMember(userId: string, name: string) {
  return unwrap(await supabase.rpc('admin_rename_member', { p_user_id: userId, p_name: name }))
}
export async function adminAddMember(email: string, name?: string) {
  return unwrap(await supabase.rpc('admin_add_member', { p_email: email, p_name: name ?? null }))
}
export async function adminRemoveMember(userId: string) {
  return unwrap(await supabase.rpc('admin_remove_member', { p_user_id: userId }))
}
export async function adminSetSetting(key: string, value: string) {
  return unwrap(await supabase.rpc('admin_set_setting', { p_key: key, p_value: value }))
}

// ---------------------------------------------------------------------------
// Self
// ---------------------------------------------------------------------------
export async function updateMyName(userId: string, name: string) {
  return unwrap(await supabase.from('profiles').update({ name }).eq('id', userId).select().single())
}
export async function updateMyPassword(password: string) {
  const res = await supabase.auth.updateUser({ password })
  if (res.error) throw res.error
}
