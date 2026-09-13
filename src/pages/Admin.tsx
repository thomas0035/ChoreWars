import { useEffect, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { useHouse } from '@/hooks/useHouse'
import { format } from 'date-fns'
import {
  adminAddMember, adminRemoveMember, adminRenameMember, adminSaveArea, adminSetLastCleaned, adminSetMemberRole, adminSetRotation, adminSetScheduledUser, adminSetSetting, type AreaInput,
} from '@/lib/api'
import { supabase } from '@/lib/supabase'
import { friendlyError } from '@/lib/errors'
import type { Area, Member } from '@/lib/types'
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

  useEffect(() => { setName(selected?.name ?? ''); setConfirmRemove(false) }, [selected])

  return (
    <div>
      <div className="space-y-2">
        {members.map((m) => (
          <Card key={m.id} onClick={() => setSelected(m)} className="flex items-center gap-3 py-3">
            <Avatar name={m.name} url={m.avatar_url} />
            <div className="flex-1 min-w-0">
              <div className="font-semibold truncate">{m.name}{m.id === me?.id && <span className="text-slate-500 font-normal"> (you)</span>}</div>
              <div className="text-xs text-slate-400">{m.role === 'admin' ? 'Admin' : 'Member'}</div>
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
      <p className="text-xs text-slate-500 px-1">Per-area points (normal / rescue) and grace periods are set on each area.</p>

      <SectionTitle>Login</SectionTitle>
      <Card className="py-1">
        <Toggle label="Show member names on the login screen" checked={v('public_login_directory') === 'true'} onChange={(b) => set('public_login_directory', String(b))} />
      </Card>

      <div className="sticky bottom-24 pt-2">
        <Button className="w-full" onClick={save} disabled={dirty.length === 0} loading={busy}>
          {dirty.length === 0 ? 'No changes' : `Save ${dirty.length} change${dirty.length === 1 ? '' : 's'}`}
        </Button>
      </div>
      <p className="text-xs text-slate-500 px-1">Data: ChoreWars keeps a full audit trail (ledger + area events). Nothing here deletes history.</p>
    </div>
  )
}
