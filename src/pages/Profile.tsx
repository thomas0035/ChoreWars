import { useState, type FormEvent } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import { LogOut } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { useHouse, queryKeys } from '@/hooks/useHouse'
import { fetchUserStats, updateMyName, updateMyPassword } from '@/lib/api'
import { supabase } from '@/lib/supabase'
import { friendlyError } from '@/lib/errors'
import type { Achievement } from '@/lib/types'
import { Avatar, Button, Card, ErrorBox, Field, PageLoading, SectionTitle, Sheet, cx, useToast } from '@/components/ui'

export function ProfilePage() {
  const { id } = useParams()
  const { me, members, isLoading } = useHouse()
  const { signOut } = useAuth()
  const toast = useToast()
  const qc = useQueryClient()
  const targetId = id ?? me?.id
  const person = members.find((m) => m.id === targetId)
  const isSelf = Boolean(me && targetId === me.id)

  const stats = useQuery({ queryKey: queryKeys.stats(targetId), queryFn: () => fetchUserStats(targetId), enabled: Boolean(targetId) })
  const allAchievements = useQuery({
    queryKey: ['achievements'],
    queryFn: async () => {
      const { data, error } = await supabase.from('achievements').select('id, name, description, icon').order('sort_order')
      if (error) throw error
      return data as Achievement[]
    },
    staleTime: Infinity,
  })

  const [editOpen, setEditOpen] = useState(false)
  const [pwOpen, setPwOpen] = useState(false)

  if (isLoading) return <PageLoading />
  if (!person) return <p className="text-slate-400">Member not found.</p>

  const s = stats.data
  const earned = new Map((s?.achievements ?? []).map((a) => [a.id, a]))

  return (
    <div>
      <div className="flex items-center gap-4">
        <Avatar name={person.name} url={person.avatar_url} size="xl" />
        <div className="min-w-0 flex-1">
          <h1 className="text-3xl font-extrabold tracking-tight truncate">{person.name}</h1>
          <p className="text-slate-400 text-sm">
            {person.role === 'admin' ? 'Admin' : 'Member'}
            {s?.weekly_rank && <> · 🏆 Rank #{s.weekly_rank} this week</>}
          </p>
        </div>
      </div>

      {stats.error && <div className="mt-4"><ErrorBox error={stats.error} retry={() => stats.refetch()} /></div>}

      <div className="grid grid-cols-3 gap-2 mt-5">
        <Big icon="⭐" value={s?.weekly_points ?? '—'} label="weekly" />
        <Big icon="💎" value={s?.total_points ?? '—'} label="all time" />
        <Big icon="🔥" value={s?.current_streak ?? '—'} label="streak" />
      </div>

      <SectionTitle>Cleaning stats</SectionTitle>
      <Card className="divide-y divide-line py-1">
        <Line label="Normal completions" value={s?.normal_completions} />
        <Line label="Rescues 🦸" value={s?.rescues} />
        <Line label="Weekly wins 👑" value={s?.weekly_wins} />
        <Line label="Longest streak" value={s?.longest_streak} />
        <Line label="This month" value={s ? `${s.monthly_points} pts` : undefined} />
      </Card>

      <SectionTitle>Achievements</SectionTitle>
      <div className="grid grid-cols-2 gap-2">
        {(allAchievements.data ?? []).map((a) => {
          const got = earned.get(a.id)
          return (
            <div key={a.id} className={cx('rounded-3xl border p-3.5 flex gap-3 items-start', got ? 'bg-amber-300/10 border-amber-300/25' : 'bg-card border-line opacity-60')}>
              <span className={cx('text-2xl', !got && 'grayscale')}>{a.icon}</span>
              <div className="min-w-0">
                <div className="font-semibold text-sm leading-tight">{a.name}</div>
                <div className="text-xs text-slate-400 mt-0.5">{got ? `Earned ${format(new Date(got.earned_at!), 'd MMM')}` : a.description}</div>
              </div>
            </div>
          )
        })}
      </div>

      {isSelf && (
        <>
          <SectionTitle>Account</SectionTitle>
          <div className="space-y-2">
            <Button variant="secondary" className="w-full" onClick={() => setEditOpen(true)}>Change my name</Button>
            <Button variant="secondary" className="w-full" onClick={() => setPwOpen(true)}>Change password</Button>
            <Button variant="ghost" className="w-full text-rose-300" onClick={signOut}><LogOut className="h-4 w-4" /> Sign out</Button>
          </div>

          <NameSheet open={editOpen} onClose={() => setEditOpen(false)} initial={person.name} onSave={async (name) => {
            try {
              await updateMyName(person.id, name)
              await qc.invalidateQueries({ queryKey: queryKeys.house })
              toast.show('Name updated', 'success')
              setEditOpen(false)
            } catch (e) { toast.show(friendlyError(e), 'error') }
          }} />
          <PasswordSheet open={pwOpen} onClose={() => setPwOpen(false)} onSave={async (pw) => {
            try {
              await updateMyPassword(pw)
              toast.show('Password changed', 'success')
              setPwOpen(false)
            } catch (e) { toast.show(friendlyError(e), 'error') }
          }} />
        </>
      )}
    </div>
  )
}

function Big({ icon, value, label }: { icon: string; value: number | string; label: string }) {
  return (
    <Card className="text-center py-3 px-2">
      <div className="text-lg">{icon}</div>
      <div className="text-2xl font-black tabular-nums leading-tight">{value}</div>
      <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">{label}</div>
    </Card>
  )
}

function Line({ label, value }: { label: string; value?: number | string }) {
  return (
    <div className="flex items-center justify-between py-3">
      <span className="text-slate-300">{label}</span>
      <span className="font-bold tabular-nums">{value ?? '—'}</span>
    </div>
  )
}

function NameSheet({ open, onClose, initial, onSave }: { open: boolean; onClose: () => void; initial: string; onSave: (name: string) => Promise<void> }) {
  const [name, setName] = useState(initial)
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setBusy(true)
    await onSave(name.trim())
    setBusy(false)
  }
  return (
    <Sheet open={open} onClose={onClose} title="Change my name">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} autoFocus /></Field>
        <Button type="submit" className="w-full" loading={busy}>Save</Button>
      </form>
    </Sheet>
  )
}

function PasswordSheet({ open, onClose, onSave }: { open: boolean; onClose: () => void; onSave: (pw: string) => Promise<void> }) {
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setErr(null)
    if (pw.length < 6) return setErr('Use at least 6 characters.')
    if (pw !== pw2) return setErr("Passwords don't match.")
    setBusy(true)
    await onSave(pw)
    setBusy(false)
    setPw(''); setPw2('')
  }
  return (
    <Sheet open={open} onClose={onClose} title="Change password">
      <form onSubmit={submit} className="space-y-4">
        <Field label="New password"><input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus /></Field>
        <Field label="Repeat it"><input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></Field>
        {err && <p className="text-sm text-rose-300 px-1">{err}</p>}
        <Button type="submit" className="w-full" loading={busy}>Update password</Button>
      </form>
    </Sheet>
  )
}
