import { useEffect, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { useHouse, useLeagueRounds } from '@/hooks/useHouse'
import { format } from 'date-fns'
import {
  adminAddMember, adminAdjustPoints, adminDiscardRound, adminRemoveMember, adminRenameMember, adminResetHouse, adminSaveArea, adminSetLastCleaned, adminSetMemberAway, adminSetMemberRole, adminSetRotation, adminSetScheduledUser, adminSetSetting, type AreaInput,
} from '@/lib/api'
import { supabase } from '@/lib/supabase'
import { friendlyError } from '@/lib/errors'
import type { Area, LeagueRound, Member } from '@/lib/types'
import { Avatar, Button, Card, Field, PageLoading, SectionTitle, Sheet, Toggle, cx, useToast } from '@/components/ui'

type Tab = 'members' | 'areas' | 'settings'

export function AdminPage() {
  const { isAdmin, isLoading } = useHouse()
  const [tab, setTab] = useState<Tab>('areas')
  if (isLoading) return <PageLoading />
  if (!isAdmin) return <p className="text-slate-400">Admins only.</p>

  return (
    <div>
      <h1 className="text-2xl font-extrabold tracking-tight">Admin</h1>
      <div className="mt-3 grid grid-cols-3 rounded-2xl bg-card border border-line p-1">
        {(['areas', 'members', 'settings'] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={cx('h-10 rounded-xl text-sm font-semibold capitalize transition-colors', tab === t ? 'bg-slate-100 text-slate-900' : 'text-slate-400 hover:text-slate-200')}>
            {t}
          </button>
        ))}
      </div>
      <div className="mt-4">
        {tab === 'areas' && <AreasTab />}
        {tab === 'members' && <MembersTab />}
        {tab === 'settings' && <SettingsTab />}
      </div>
    </div>
  )
}

/** Wraps an admin call with toast + invalidation. */
function useAdminAction() {
  const toast = useToast()
  const qc = useQueryClient()
  return async (fn: () => Promise<unknown>, success?: string): Promise<boolean> => {
    try {
      await fn()
      await qc.invalidateQueries()
      if (success) toast.show(success, 'success')
      return true
    } catch (e) {
      toast.show(friendlyError(e), 'error')
      return false
    }
  }
}

// ---------------------------------------------------------------------------
// Areas
// ---------------------------------------------------------------------------
function AreasTab() {
  const { areas, members } = useHouse()
  const [editing, setEditing] = useState<Area | 'new' | null>(null)
  const run = useAdminAction()
  const removed = useQuery({
    queryKey: ['areas-removed'],
    queryFn: async () => {
      const { data, error } = await supabase.from('cleaning_areas').select('id, name, icon').eq('active', false).order('name')
      if (error) throw error
      return data as { id: string; name: string; icon: string }[]
    },
  })

  return (
    <div>
      <div className="space-y-2">
        {areas.map((a) => {
          const rotationNames = a.rotation.map((r) => members.find((m) => m.id === r.user_id)?.name ?? '?')
          const current = members.find((m) => m.id === a.state.current_scheduled_user_id)
          return (
            <Card key={a.id} onClick={() => setEditing(a)} className="flex items-center gap-3 py-3">
              <div className="h-11 w-11 rounded-2xl bg-card-2 flex items-center justify-center text-2xl shrink-0">{a.icon}</div>
              <div className="min-w-0 flex-1">
                <div className="font-semibold">{a.name}</div>
                <div className="text-xs text-slate-400 truncate">
                  {rotationNames.length ? rotationNames.join(' → ') : 'No rotation'}
                  {current && <> · up: {current.name}</>}
                </div>
              </div>
            </Card>
          )
        })}
      </div>
      <Button variant="secondary" className="w-full mt-3" onClick={() => setEditing('new')}><Plus className="h-4 w-4" /> Add area</Button>

      {(removed.data?.length ?? 0) > 0 && (
        <>
          <SectionTitle>Removed areas</SectionTitle>
          <Card className="divide-y divide-line py-1">
            {removed.data!.map((a) => (
              <div key={a.id} className="flex items-center gap-3 py-2.5">
                <span className="text-xl">{a.icon}</span>
                <span className="flex-1 text-slate-300">{a.name}</span>
                <Button size="sm" variant="secondary" onClick={() => run(() => adminSaveArea({ id: a.id, active: true }), `${a.name} restored`)}>Restore</Button>
              </div>
            ))}
          </Card>
        </>
      )}

      <AreaSheet key={editing === 'new' ? 'new' : editing?.id ?? 'none'} area={editing === 'new' ? null : editing} open={editing !== null} onClose={() => setEditing(null)} members={members} />
    </div>
  )
}

const ICONS = ['🍳', '🚰', '🧽', '🚿', '🚽', '🛋️', '🧺', '🗑️', '🪟', '🌿', '🧹', '🧼', '🛏️', '🚪', '🪴', '🧊']

function AreaSheet({ area, open, onClose, members }: { area: Area | null; open: boolean; onClose: () => void; members: Member[] }) {
  const run = useAdminAction()
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState(() => toForm(area))
  const [rotation, setRotation] = useState<string[]>(() => area?.rotation.map((r) => r.user_id) ?? [])
  const [scheduled, setScheduled] = useState<string | null>(area?.state.current_scheduled_user_id ?? null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const initialLastCleaned = toLocalInput(area?.state.last_cleaned_at ?? null)
  const [lastCleaned, setLastCleaned] = useState(initialLastCleaned)
  const [cleanedBy, setCleanedBy] = useState('')

  useEffect(() => {
    setForm(toForm(area))
    setRotation(area?.rotation.map((r) => r.user_id) ?? [])
    setScheduled(area?.state.current_scheduled_user_id ?? null)
    setConfirmRemove(false)
    setLastCleaned(toLocalInput(area?.state.last_cleaned_at ?? null))
    setCleanedBy('')
  }, [area, open])

  // Picking who cleaned it last also proposes the next person in the rotation as the current turn.
  const pickCleanedBy = (uid: string) => {
    setCleanedBy(uid)
    if (!uid) return
    const i = rotation.indexOf(uid)
    if (i >= 0 && rotation.length > 0) setScheduled(rotation[(i + 1) % rotation.length]!)
  }

  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }))
  const notInRotation = members.filter((m) => !rotation.includes(m.id))
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= rotation.length) return
    const next = [...rotation]
    ;[next[i], next[j]] = [next[j]!, next[i]!]
    setRotation(next)
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    const days = (s: string) => Math.round(Number(s) * 24)
    const input: AreaInput = {
      ...(area ? { id: area.id } : {}),
      name: form.name.trim(),
      icon: form.icon || '🧹',
      normal_points: Number(form.normal_points),
      rescue_points: Number(form.rescue_points),
      minimum_interval_hours: days(form.min_days),
      expected_interval_hours: days(form.exp_days),
      attention_interval_hours: days(form.att_days),
      volunteer_grace_hours: Number(form.grace_hours),
      reactivation_cooldown_hours: form.cooldown_days.trim() === '' ? null : days(form.cooldown_days),
    }
    const lastCleanedChanged = lastCleaned !== initialLastCleaned || cleanedBy !== ''
    const ok = await run(async () => {
      const id = await adminSaveArea(input)
      await adminSetRotation(id, rotation)
      if (lastCleanedChanged && lastCleaned) {
        await adminSetLastCleaned(id, new Date(lastCleaned).toISOString(), cleanedBy || null)
      }
      if (scheduled && rotation.includes(scheduled)) await adminSetScheduledUser(id, scheduled)
    }, area ? 'Area saved' : 'Area added')
    setBusy(false)
    if (ok) onClose()
  }

  const remove = async () => {
    if (!area) return
    setBusy(true)
    const ok = await run(() => adminSaveArea({ id: area.id, active: false }), `${area.name} removed`)
    setBusy(false)
    if (ok) onClose()
  }

  return (
    <Sheet open={open} onClose={onClose} title={area ? `Edit ${area.name}` : 'New area'}>
      <form onSubmit={submit} className="space-y-4">
        <div className="flex gap-3">
          <div className="w-20 shrink-0">
            <Field label="Icon"><input value={form.icon} onChange={(e) => set('icon', e.target.value)} className="text-center text-xl px-0" maxLength={4} /></Field>
          </div>
          <div className="flex-1 min-w-0">
            <Field label="Name"><input value={form.name} onChange={(e) => set('name', e.target.value)} required maxLength={40} placeholder="e.g. Kitchen" /></Field>
          </div>
        </div>
        <div className="flex gap-1.5 flex-wrap -mt-2">
          {ICONS.map((i) => (
            <button type="button" key={i} onClick={() => set('icon', i)} className={cx('h-9 w-9 rounded-xl text-lg', form.icon === i ? 'bg-slate-100' : 'bg-card-2 hover:bg-slate-700/60')}>{i}</button>
          ))}
        </div>

        <SectionTitle>Suggested intervals (days)</SectionTitle>
        <div className="grid grid-cols-3 gap-2">
          <Field label="Fresh until"><input type="number" inputMode="decimal" step="0.5" min="0" value={form.min_days} onChange={(e) => set('min_days', e.target.value)} required /></Field>
          <Field label="Expected"><input type="number" inputMode="decimal" step="0.5" min="0" value={form.exp_days} onChange={(e) => set('exp_days', e.target.value)} required /></Field>
          <Field label="Attention"><input type="number" inputMode="decimal" step="0.5" min="0" value={form.att_days} onChange={(e) => set('att_days', e.target.value)} required /></Field>
        </div>
        <p className="text-xs text-slate-500 -mt-2 px-1">Fresh → Due Soon at "fresh until"; → Ready to Check at "expected"; → Needs Attention at "attention".</p>

        <SectionTitle>Points & timing</SectionTitle>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Normal points"><input type="number" inputMode="numeric" min="0" value={form.normal_points} onChange={(e) => set('normal_points', e.target.value)} required /></Field>
          <Field label="Rescue points"><input type="number" inputMode="numeric" min="0" value={form.rescue_points} onChange={(e) => set('rescue_points', e.target.value)} required /></Field>
          <Field label="Volunteer grace (hours)"><input type="number" inputMode="numeric" min="0" value={form.grace_hours} onChange={(e) => set('grace_hours', e.target.value)} required /></Field>
          <Field label="Re-flag cooldown (days)" hint="Blank = house default"><input type="number" inputMode="decimal" step="0.5" min="0" value={form.cooldown_days} onChange={(e) => set('cooldown_days', e.target.value)} placeholder="default" /></Field>
        </div>

        <SectionTitle>Rotation order</SectionTitle>
        <div className="space-y-1.5">
          {rotation.length === 0 && <p className="text-sm text-slate-500 px-1">Nobody yet — add members below.</p>}
          {rotation.map((uid, i) => {
            const m = members.find((x) => x.id === uid)
            if (!m) return null
            return (
              <div key={uid} className="flex items-center gap-2 rounded-2xl bg-card-2 border border-line p-2">
                <button type="button" onClick={() => setScheduled(uid)} title="Set as current turn"
                  className={cx('h-8 w-8 rounded-full text-xs font-bold', scheduled === uid ? 'bg-emerald-400 text-emerald-950' : 'bg-slate-700 text-slate-300')}>
                  {i + 1}
                </button>
                <Avatar name={m.name} url={m.avatar_url} size="sm" />
                <span className="flex-1 font-medium truncate">{m.name}{scheduled === uid && <span className="text-xs text-emerald-300 font-normal"> · current turn</span>}</span>
                <button type="button" onClick={() => move(i, -1)} className="p-1.5 rounded-lg text-slate-400 hover:bg-white/5" aria-label="Move up"><ArrowUp className="h-4 w-4" /></button>
                <button type="button" onClick={() => move(i, 1)} className="p-1.5 rounded-lg text-slate-400 hover:bg-white/5" aria-label="Move down"><ArrowDown className="h-4 w-4" /></button>
                <button type="button" onClick={() => { setRotation(rotation.filter((x) => x !== uid)); if (scheduled === uid) setScheduled(null) }} className="p-1.5 rounded-lg text-rose-300 hover:bg-rose-500/10" aria-label="Remove"><Trash2 className="h-4 w-4" /></button>
              </div>
            )
          })}
        </div>
        {notInRotation.length > 0 && (
          <div className="flex gap-1.5 flex-wrap">
            {notInRotation.map((m) => (
              <button type="button" key={m.id} onClick={() => setRotation([...rotation, m.id])} className="h-9 px-3 rounded-full bg-card-2 border border-line text-sm hover:bg-slate-700/60">
                + {m.name}
              </button>
            ))}
          </div>
        )}
        <p className="text-xs text-slate-500 px-1">Tap a number to set whose turn it is now.</p>

        {area && (
          <>
            <SectionTitle>Last cleaned</SectionTitle>
            <div className="grid grid-cols-2 gap-2">
              <Field label="When">
                <input type="datetime-local" value={lastCleaned} max={toLocalInput(new Date().toISOString())} onChange={(e) => setLastCleaned(e.target.value)} />
              </Field>
              <Field label="Cleaned by">
                <select value={cleanedBy} onChange={(e) => pickCleanedBy(e.target.value)}>
                  <option value="">Just set the date</option>
                  {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </Field>
            </div>
            <p className="text-xs text-slate-500 -mt-2 px-1">
              For setup or corrections. No points are awarded. Choosing a person logs it in history and moves the turn to the next in rotation.
            </p>
          </>
        )}

        <div className="flex gap-2 pt-2">
          {area && !confirmRemove && <Button type="button" variant="danger" onClick={() => setConfirmRemove(true)}>Remove</Button>}
          {area && confirmRemove && <Button type="button" variant="danger" onClick={remove} loading={busy}>Confirm remove</Button>}
          <Button type="submit" className="flex-1" loading={busy}>{area ? 'Save changes' : 'Add area'}</Button>
        </div>
      </form>
    </Sheet>
  )
}

/** ISO -> value for <input type="datetime-local"> in the browser's local time. */
function toLocalInput(iso: string | null): string {
  if (!iso) return ''
  return format(new Date(iso), "yyyy-MM-dd'T'HH:mm")
}

function toForm(a: Area | null) {
  const d = (h: number) => String(Math.round((h / 24) * 10) / 10)
  return {
    name: a?.name ?? '',
    icon: a?.icon ?? '🧹',
    normal_points: String(a?.normal_points ?? 10),
    rescue_points: String(a?.rescue_points ?? 12),
    min_days: d(a?.minimum_interval_hours ?? 120),
    exp_days: d(a?.expected_interval_hours ?? 168),
    att_days: d(a?.attention_interval_hours ?? 288),
    grace_hours: String(a?.volunteer_grace_hours ?? 24),
    cooldown_days: a?.reactivation_cooldown_hours == null ? '' : d(a.reactivation_cooldown_hours),
  }
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------
function MembersTab() {
  const { members, me } = useHouse()
  const run = useAdminAction()
  const [selected, setSelected] = useState<Member | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [adjusting, setAdjusting] = useState<Member | null>(null)

  useEffect(() => { setName(selected?.name ?? ''); setConfirmRemove(false) }, [selected])

  return (
    <div>
      <div className="space-y-2">
        {members.map((m) => (
          <Card key={m.id} onClick={() => setSelected(m)} className="flex items-center gap-3 py-3">
            <Avatar name={m.name} url={m.avatar_url} />
            <div className="flex-1 min-w-0">
              <div className="font-semibold truncate">{m.name}{m.id === me?.id && <span className="text-slate-500 font-normal"> (you)</span>}</div>
              <div className="text-xs text-slate-400">{m.role === 'admin' ? 'Admin' : 'Member'}{m.away && <span className="text-amber-200"> · ✈️ Away</span>}</div>
            </div>
          </Card>
        ))}
      </div>
      <Button variant="secondary" className="w-full mt-3" onClick={() => setAddOpen(true)}><Plus className="h-4 w-4" /> Add member</Button>

      <Sheet open={selected !== null} onClose={() => setSelected(null)} title={selected?.name}>
        {selected && (
          <div className="space-y-4">
            <form className="flex gap-2" onSubmit={async (e) => {
              e.preventDefault()
              setBusy(true)
              await run(() => adminRenameMember(selected.id, name), 'Renamed')
              setBusy(false)
            }}>
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required />
              <Button type="submit" variant="secondary" loading={busy}>Rename</Button>
            </form>
            <Button variant="secondary" className="w-full" onClick={async () => {
              const role = selected.role === 'admin' ? 'member' : 'admin'
              if (await run(() => adminSetMemberRole(selected.id, role), role === 'admin' ? `${selected.name} is now an admin` : `${selected.name} is no longer an admin`)) setSelected({ ...selected, role })
            }}>
              {selected.role === 'admin' ? 'Remove admin role' : 'Make admin'}
            </Button>
            <div>
              <Button variant="secondary" className="w-full" onClick={() => { setAdjusting(selected); setSelected(null) }}>⚖️ Adjust points</Button>
              <p className="text-xs text-slate-500 mt-1.5 px-1">
                Give or take points for things that aren't a clean: dishes left dirty, an area not checked, extra effort. A reason is required and everyone can see it in History.
              </p>
            </div>
            <div>
              <Button variant="secondary" className="w-full" onClick={async () => {
                const away = !selected.away
                if (await run(() => adminSetMemberAway(selected.id, away), away ? `${selected.name} is away — skipped in every rotation` : `${selected.name} is back in the rotations`)) setSelected({ ...selected, away })
              }}>
                {selected.away ? '✈️ Mark as back' : '✈️ Mark as away'}
              </Button>
              <p className="text-xs text-slate-500 mt-1.5 px-1">
                {selected.away
                  ? "Away: skipped in every rotation, no penalties, and the league round doesn't wait for them or give them the forfeit."
                  : "Away members are skipped in every rotation, take no penalties, and the league round doesn't wait for them or give them the forfeit. Their current turns move to the next person."}
              </p>
            </div>
            {selected.id !== me?.id && (
              !confirmRemove
                ? <Button variant="danger" className="w-full" onClick={() => setConfirmRemove(true)}>Remove from house</Button>
                : <Button variant="danger" className="w-full" onClick={async () => { if (await run(() => adminRemoveMember(selected.id), `${selected.name} removed`)) setSelected(null) }}>
                    Confirm — remove {selected.name} from every rotation
                  </Button>
            )}
          </div>
        )}
      </Sheet>

      <AdjustPointsSheet key={adjusting?.id ?? 'none'} member={adjusting} onClose={() => setAdjusting(null)} />

      <Sheet open={addOpen} onClose={() => setAddOpen(false)} title="Add member">
        <form className="space-y-4" onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          const ok = await run(() => adminAddMember(email, newName), 'Member added')
          setBusy(false)
          if (ok) { setAddOpen(false); setEmail(''); setNewName('') }
        }}>
          <p className="text-sm text-slate-400">
            First create their login in the Supabase dashboard (Authentication → Users → Add user, with a password). Then enter the same email here.
          </p>
          <Field label="Email"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="name@house.local" /></Field>
          <Field label="Display name"><input value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={40} placeholder="Optional" /></Field>
          <Button type="submit" className="w-full" loading={busy}>Add to house</Button>
        </form>
      </Sheet>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Point adjustments
// ---------------------------------------------------------------------------
const DEDUCT_REASONS = ['Left dirty dishes out', 'Area not checked after cleaning', 'Left a mess behind', 'Skipped a shared task']
const BONUS_REASONS = ['Extra effort', 'Cleaned something off-rota', 'Helped someone out']

function AdjustPointsSheet({ member, onClose }: { member: Member | null; onClose: () => void }) {
  const { settings } = useHouse()
  const run = useAdminAction()
  const max = Math.max(1, Number(settings.max_point_adjustment ?? '50') || 50)
  const [mode, setMode] = useState<'deduct' | 'give'>('deduct')
  const [amount, setAmount] = useState('5')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const n = Math.floor(Number(amount))
  const valid = Number.isFinite(n) && n >= 1 && n <= max && note.trim().length >= 3
  const reasons = mode === 'deduct' ? DEDUCT_REASONS : BONUS_REASONS

  return (
    <Sheet open={member !== null} onClose={() => { if (!busy) onClose() }} title={member ? `Adjust ${member.name}'s points` : undefined}>
      {member && (
        <form className="space-y-4" onSubmit={async (e) => {
          e.preventDefault()
          if (!valid) return
          setBusy(true)
          const signed = mode === 'deduct' ? -n : n
          const ok = await run(() => adminAdjustPoints(member.id, signed, note.trim()),
            mode === 'deduct' ? `−${n} for ${member.name}` : `+${n} for ${member.name}`)
          setBusy(false)
          if (ok) onClose()
        }}>
          <div className="grid grid-cols-2 rounded-2xl bg-card-2 border border-line p-1">
            {(['deduct', 'give'] as const).map((m) => (
              <button key={m} type="button" onClick={() => setMode(m)}
                className={cx('h-10 rounded-xl text-sm font-semibold transition-colors', mode === m ? (m === 'deduct' ? 'bg-rose-400/90 text-slate-950' : 'bg-emerald-400/90 text-slate-950') : 'text-slate-400 hover:text-slate-200')}>
                {m === 'deduct' ? '− Deduct' : '+ Give'}
              </button>
            ))}
          </div>
          <Field label="Points" hint={`1 to ${max}. The limit is in Settings.`}>
            <input type="number" inputMode="numeric" min={1} max={max} value={amount} onChange={(e) => setAmount(e.target.value)} required />
          </Field>
          <Field label="Reason (everyone will see this)">
            <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} rows={2} required minLength={3}
              placeholder={mode === 'deduct' ? 'What did they leave undone?' : 'What did they do?'} />
          </Field>
          <div className="flex gap-2 overflow-x-auto no-scrollbar -mx-1 px-1">
            {reasons.map((r) => (
              <button key={r} type="button" onClick={() => setNote(r)}
                className={cx('shrink-0 rounded-full border px-3 h-8 text-xs font-semibold', note === r ? 'bg-slate-100 text-slate-900 border-slate-100' : 'border-line text-slate-300 hover:bg-white/5')}>
                {r}
              </button>
            ))}
          </div>
          <Button type="submit" className="w-full" variant={mode === 'deduct' ? 'danger' : 'primary'} loading={busy} disabled={!valid}>
            {mode === 'deduct' ? `Take ${Number.isFinite(n) && n > 0 ? n : ''} points from ${member.name}` : `Give ${member.name} ${Number.isFinite(n) && n > 0 ? n : ''} points`}
          </Button>
          <p className="text-xs text-slate-500 px-1">
            Counts towards the current round, this week and all time. {member.name} gets a notification. You can undo it from History until the round is settled.
          </p>
        </form>
      )}
    </Sheet>
  )
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']

/** Stored value is hours; the UI shows days (to 2 decimals). */
function hoursToDays(hours: string): string {
  if (hours.trim() === '') return ''
  return String(Math.round((Number(hours) / 24) * 100) / 100)
}
const TZ_SUGGESTIONS = ['Asia/Kolkata', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Asia/Dubai', 'Asia/Singapore', 'Australia/Sydney', 'UTC']

function SettingsTab() {
  const { settings, data } = useHouse()
  const run = useAdminAction()
  const [form, setForm] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  const base: Record<string, string> = {
    house_name: data?.house.name ?? '',
    timezone: settings.timezone ?? 'UTC',
    week_start_day: settings.week_start_day ?? 'monday',
    default_reactivation_cooldown_hours: settings.default_reactivation_cooldown_hours ?? '4',
    volunteering_enabled: settings.volunteering_enabled ?? 'true',
    early_bonus_points: settings.early_bonus_points ?? '2',
    streak_bonus_3: settings.streak_bonus_3 ?? '3',
    streak_bonus_5: settings.streak_bonus_5 ?? '5',
    streak_bonus_10: settings.streak_bonus_10 ?? '10',
    rescue_penalty_points: settings.rescue_penalty_points ?? '5',
    max_point_adjustment: settings.max_point_adjustment ?? '50',
    league_turns_per_round: settings.league_turns_per_round ?? '3',
    league_max_round_days: settings.league_max_round_days ?? '45',
    league_forfeit: settings.league_forfeit ?? 'Buys snacks for the house',
    public_login_directory: settings.public_login_directory ?? 'true',
  }
  const v = (k: string) => form[k] ?? base[k] ?? ''
  const set = (k: string, val: string) => setForm((f) => ({ ...f, [k]: val }))
  const dirty = Object.keys(form).filter((k) => form[k] !== base[k])

  const save = async () => {
    setBusy(true)
    const ok = await run(async () => {
      for (const k of dirty) await adminSetSetting(k, form[k]!)
    }, 'Settings saved')
    setBusy(false)
    if (ok) setForm({})
  }

  return (
    <div className="space-y-4">
      <Field label="House name"><input value={v('house_name')} onChange={(e) => set('house_name', e.target.value)} maxLength={40} /></Field>

      <SectionTitle>Week & time</SectionTitle>
      <Field label="Timezone (IANA)" hint="Affects when 'this week' rolls over and the weekly champion is crowned.">
        <input list="tz" value={v('timezone')} onChange={(e) => set('timezone', e.target.value)} />
        <datalist id="tz">{TZ_SUGGESTIONS.map((t) => <option key={t} value={t} />)}</datalist>
      </Field>
      <Field label="Week starts on">
        <select value={v('week_start_day')} onChange={(e) => set('week_start_day', e.target.value)}>
          {DAYS.map((d) => <option key={d} value={d} className="capitalize">{d[0]!.toUpperCase() + d.slice(1)}</option>)}
        </select>
      </Field>
      <Field label="Default re-flag cooldown (days)" hint="How long after a clean before an area can be flagged again. Areas can override this.">
        <input
          type="number" inputMode="decimal" step="0.5" min="0"
          value={hoursToDays(v('default_reactivation_cooldown_hours'))}
          onChange={(e) => set('default_reactivation_cooldown_hours', e.target.value === '' ? '' : String(Math.round(Number(e.target.value) * 24)))}
        />
      </Field>

      <SectionTitle>Volunteering & points</SectionTitle>
      <Card className="py-1">
        <Toggle label="Volunteering enabled" checked={v('volunteering_enabled') === 'true'} onChange={(b) => set('volunteering_enabled', String(b))} />
      </Card>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Early-clean bonus"><input type="number" inputMode="numeric" min="0" value={v('early_bonus_points')} onChange={(e) => set('early_bonus_points', e.target.value)} /></Field>
        <Field label="3-streak bonus"><input type="number" inputMode="numeric" min="0" value={v('streak_bonus_3')} onChange={(e) => set('streak_bonus_3', e.target.value)} /></Field>
        <Field label="5-streak bonus"><input type="number" inputMode="numeric" min="0" value={v('streak_bonus_5')} onChange={(e) => set('streak_bonus_5', e.target.value)} /></Field>
        <Field label="10-streak bonus"><input type="number" inputMode="numeric" min="0" value={v('streak_bonus_10')} onChange={(e) => set('streak_bonus_10', e.target.value)} /></Field>
      </div>
      <Field label="Rescue penalty" hint="Points the scheduled person loses when someone else cleans their area. 0 turns it off.">
        <input type="number" inputMode="numeric" min="0" value={v('rescue_penalty_points')} onChange={(e) => set('rescue_penalty_points', e.target.value)} />
      </Field>
      <Field label="Biggest admin adjustment" hint="The most points an admin can give or take in one go (Admin → Members → Adjust points).">
        <input type="number" inputMode="numeric" min="1" max="500" value={v('max_point_adjustment')} onChange={(e) => set('max_point_adjustment', e.target.value)} />
      </Field>
      <p className="text-xs text-slate-500 px-1">Per-area points (normal / rescue) and grace periods are set on each area.</p>

      <SectionTitle>League rounds</SectionTitle>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Turns per round">
          <input type="number" inputMode="numeric" min="1" max="20" value={v('league_turns_per_round')} onChange={(e) => set('league_turns_per_round', e.target.value)} />
        </Field>
        <Field label="Max round length (days)">
          <input type="number" inputMode="numeric" min="7" max="365" value={v('league_max_round_days')} onChange={(e) => set('league_max_round_days', e.target.value)} />
        </Field>
      </div>
      <p className="text-xs text-slate-500 px-1 -mt-2">
        A round ends once every member who isn't away has had this many turns, or at the max length. Only those turns count toward a member's score; rescues always count.
        Changes apply to the current round straight away, so lowering the turns can end it on the next page load.
      </p>
      <Field label="Forfeit for the lowest scorer" hint="Shown on the League page under 'Last round' until it's marked done. Only members who had all their turns can get it. The winner gets a Skip Pass automatically.">
        <input value={v('league_forfeit')} onChange={(e) => set('league_forfeit', e.target.value)} maxLength={120} placeholder="Buys snacks for the house" />
      </Field>

      <SectionTitle>Login</SectionTitle>
      <Card className="py-1">
        <Toggle label="Show member names on the login screen" checked={v('public_login_directory') === 'true'} onChange={(b) => set('public_login_directory', String(b))} />
      </Card>

      <div className="sticky bottom-24 pt-2">
        <Button className="w-full" onClick={save} disabled={dirty.length === 0} loading={busy}>
          {dirty.length === 0 ? 'No changes' : `Save ${dirty.length} change${dirty.length === 1 ? '' : 's'}`}
        </Button>
      </div>
      <DiscardRound />
      <DangerZone />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Discard a finished league round
// ---------------------------------------------------------------------------
function roundLabel(r: LeagueRound) {
  return r.settle_reason === 'legacy'
    ? format(new Date(r.started_at), 'MMMM yyyy')
    : `Round ${r.round_no} (${format(new Date(r.started_at), 'd MMM')} – ${format(new Date(r.ended_at), 'd MMM')})`
}

function DiscardRound() {
  const run = useAdminAction()
  const rounds = useLeagueRounds()
  const [target, setTarget] = useState<LeagueRound | null>(null)
  const [busy, setBusy] = useState(false)

  const confirm = async () => {
    if (!target) return
    setBusy(true)
    const ok = await run(() => adminDiscardRound(target.id), 'Round discarded')
    setBusy(false)
    if (ok) setTarget(null)
  }

  const list = rounds.data ?? []
  if (list.length === 0) return null

  return (
    <>
      <SectionTitle>Finished rounds</SectionTitle>
      <Card className="divide-y divide-line py-1">
        {list.map((r) => (
          <div key={r.id} className="flex items-center gap-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="font-semibold text-sm truncate">{roundLabel(r)}</div>
              <div className="text-xs text-slate-400 truncate">
                {r.champion_name ? `🥇 ${r.champion_name}` : 'No winner'}
                {r.loser_name && ` · forfeit: ${r.loser_name}`}
              </div>
            </div>
            <Button variant="ghost" size="sm" className="text-rose-300" onClick={() => setTarget(r)}>Discard</Button>
          </div>
        ))}
      </Card>
      <p className="text-xs text-slate-500 px-1 mt-2">
        Discarding removes a finished round's winner, crown, Skip Pass and forfeit, as if the round never happened. Points and cleaning history stay. The current round is not affected.
      </p>

      <Sheet open={target !== null} onClose={() => { if (!busy) setTarget(null) }} title="Discard this round?">
        {target && (
          <p className="text-sm text-slate-300">
            <b>{roundLabel(target)}</b> will be removed.
            {target.champion_name && <> {target.champion_name} loses the win, the crown and the Skip Pass from it.</>}
            {target.loser_name && <> {target.loser_name} no longer owes the forfeit.</>}
            {' '}Everyone's points stay as they are. This cannot be undone.
          </p>
        )}
        <div className="flex gap-3 mt-5">
          <Button variant="secondary" className="flex-1" onClick={() => setTarget(null)} disabled={busy}>Cancel</Button>
          <Button variant="danger" className="flex-1" onClick={confirm} loading={busy}>Discard round</Button>
        </div>
      </Sheet>
    </>
  )
}

// ---------------------------------------------------------------------------
// Danger zone: reset scores / reset everything
// ---------------------------------------------------------------------------
function DangerZone() {
  const run = useAdminAction()
  const [mode, setMode] = useState<'scores' | 'everything' | null>(null)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const close = () => { if (!busy) { setMode(null); setTyped('') } }

  const confirm = async () => {
    if (!mode) return
    setBusy(true)
    const ok = await run(() => adminResetHouse(mode), mode === 'scores' ? 'Scores reset' : 'House reset')
    setBusy(false)
    if (ok) { setMode(null); setTyped('') }
  }

  return (
    <>
      <SectionTitle>Danger zone</SectionTitle>
      <Card className="border-rose-400/20 space-y-3">
        <div>
          <div className="font-semibold">Reset scores</div>
          <p className="text-xs text-slate-400 mt-0.5">Clears all points, streaks, achievements, weekly champions, league rounds and Skip Passes, and starts round 1. Cleaning history is kept (shown with no points).</p>
          <Button variant="danger" size="sm" className="mt-2" onClick={() => setMode('scores')}>Reset scores</Button>
        </div>
        <div className="border-t border-line pt-3">
          <div className="font-semibold">Reset everything</div>
          <p className="text-xs text-slate-400 mt-0.5">Also deletes all cleaning history, clears every flag and puts each rotation back to its first person. Members, areas, rotations and settings are kept.</p>
          <Button variant="danger" size="sm" className="mt-2" onClick={() => setMode('everything')}>Reset everything</Button>
        </div>
        <p className="text-xs text-slate-500">To undo a single completion instead, open History or an area's Recent history and tap Undo on the latest entry.</p>
      </Card>

      <Sheet open={mode !== null} onClose={close} title={mode === 'scores' ? 'Reset all scores?' : 'Reset the whole house?'}>
        <p className="text-sm text-slate-300">
          {mode === 'scores'
            ? 'Everyone goes back to 0 points, 0 streak and no achievements. This cannot be undone.'
            : 'All points, streaks, achievements and cleaning history will be deleted, every area becomes unflagged with no last-cleaned date, and each rotation starts from its first person. This cannot be undone.'}
        </p>
        <Field label='Type RESET to confirm'>
          <input value={typed} onChange={(e) => setTyped(e.target.value)} autoCapitalize="characters" autoComplete="off" placeholder="RESET" />
        </Field>
        <div className="flex gap-3 mt-5">
          <Button variant="secondary" className="flex-1" onClick={close} disabled={busy}>Cancel</Button>
          <Button variant="danger" className="flex-1" onClick={confirm} loading={busy} disabled={typed.trim().toUpperCase() !== 'RESET'}>
            {mode === 'scores' ? 'Reset scores' : 'Reset everything'}
          </Button>
        </div>
      </Sheet>
    </>
  )
}
