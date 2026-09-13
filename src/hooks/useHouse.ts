import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchHouse } from '@/lib/api'
import { supabase } from '@/lib/supabase'
import { describeArea, type AreaView } from '@/lib/status'
import { useAuth } from './useAuth'

export const queryKeys = {
  house: ['house'] as const,
  leaderboard: (period: string) => ['leaderboard', period] as const,
  stats: (userId: string | undefined) => ['stats', userId ?? 'me'] as const,
  champion: ['champion'] as const,
  history: (filters: unknown) => ['history', filters] as const,
}

/** Re-renders on an interval so time-based statuses stay current. */
export function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), intervalMs)
    const onVisible = () => document.visibilityState === 'visible' && setNow(new Date())
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [intervalMs])
  return now
}

/**
 * One realtime channel for the whole app: any change on a watched table
 * invalidates everything (the dataset is tiny — six people, a handful of areas).
 */
export function useRealtimeSync(enabled: boolean) {
  const qc = useQueryClient()
  useEffect(() => {
    if (!enabled) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const bump = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => qc.invalidateQueries(), 150)
    }
    const channel = supabase
      .channel('house-live')
      .on('postgres_changes', { event: '*', schema: 'public' }, bump)
      .subscribe()

    const onFocus = () => qc.invalidateQueries()
    window.addEventListener('focus', onFocus)
    return () => {
      if (timer) clearTimeout(timer)
      window.removeEventListener('focus', onFocus)
      supabase.removeChannel(channel)
    }
  }, [enabled, qc])
}

export function useHouse() {
  const { user } = useAuth()
  const query = useQuery({
    queryKey: queryKeys.house,
    queryFn: fetchHouse,
    enabled: Boolean(user),
    staleTime: 10_000,
  })
  const data = query.data ?? null
  const me = useMemo(() => data?.members.find((m) => m.id === user?.id), [data, user?.id])
  const isAdmin = me?.role === 'admin'
  return { ...query, data, me, isAdmin, members: data?.members ?? [], areas: data?.areas ?? [], settings: data?.settings ?? {} }
}

export function useAreaViews(): { views: AreaView[]; now: Date; isLoading: boolean; error: unknown; me: ReturnType<typeof useHouse>['me']; isAdmin: boolean; house: ReturnType<typeof useHouse>['data'] } {
  const now = useNow()
  const { data, me, isAdmin, isLoading, error } = useHouse()
  const views = useMemo(() => {
    if (!data) return []
    return data.areas.map((a) => describeArea(a, data.members, me?.id, isAdmin, data.settings, now))
  }, [data, me?.id, isAdmin, now])
  return { views, now, isLoading, error, me, isAdmin, house: data }
}
