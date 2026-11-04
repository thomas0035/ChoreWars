import { useMemo, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import { ChevronRight, Minus, Plus } from 'lucide-react'
import { useHouse, queryKeys } from '@/hooks/useHouse'
import {
  fetchInventory, inventoryAddItem, inventoryDeleteItem, inventoryFinishItem, inventoryPutBack, inventoryRecordPayment, inventoryTake, inventoryUndoPayment, inventoryUndoTake, inventoryUpdateItem,
} from '@/lib/api'
import { friendlyError } from '@/lib/errors'
import { formatQty, formatRupees, timeAgo } from '@/lib/format'
import type { InventoryBalance, InventoryItem, InventoryTake, InventoryUnit, Member } from '@/lib/types'
import { Avatar, Button, Card, ErrorBox, Field, PageLoading, SectionTitle, Sheet, cx, useToast } from '@/components/ui'

const UNITS: { value: InventoryUnit; label: string }[] = [
  { value: 'pcs', label: 'Pieces' },
  { value: 'pack', label: 'Packs' },
  { value: 'g', label: 'Grams' },
  { value: 'kg', label: 'Kilograms' },
  { value: 'ml', label: 'Millilitres' },
  { value: 'l', label: 'Litres' },
]

/** Quick amounts on the take form. */
const QUICK: Record<InventoryUnit, number[]> = {
  pcs: [1, 2, 3, 5], pack: [1, 2], g: [50, 100, 250, 500], kg: [0.25, 0.5, 1], ml: [100, 250, 500], l: [0.5, 1],
}

const countable = (u: InventoryUnit) => u === 'pcs' || u === 'pack'
const DAY = 24 * 60 * 60 * 1000

/** "₹8/pc", "₹60/kg" (grams and ml are priced per kg / L so the number is readable). */
function rateLabel(item: InventoryItem): string {
  switch (item.unit) {
    case 'pcs': return `${formatRupees(item.unit_cost)}/pc`
    case 'pack': return `${formatRupees(item.unit_cost)}/pack`
    case 'g': return `${formatRupees(item.unit_cost * 1000)}/kg`
    case 'kg': return `${formatRupees(item.unit_cost)}/kg`
    case 'ml': return `${formatRupees(item.unit_cost * 1000)}/L`
    case 'l': return `${formatRupees(item.unit_cost)}/L`
  }
}

/** Parse a ₹ input ("80", "24.5") to paise, or null. */
function toPaise(v: string): number | null {
  const n = Number(v)
  return v.trim() !== '' && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null
}

function useRun() {
  const toast = useToast()
  const qc = useQueryClient()
  return async (fn: () => Promise<unknown>, success?: string): Promise<boolean> => {
    try {
      await fn()
      await qc.invalidateQueries({ queryKey: queryKeys.inventory })
      if (success) toast.show(success, 'success')
      return true
    } catch (e) {
      toast.show(friendlyError(e), 'error')
      return false
    }
  }
}

export function InventoryPage() {
  const { members, me, isAdmin, isLoading } = useHouse()
  const q = useQuery({ queryKey: queryKeys.inventory, queryFn: fetchInventory, enabled: Boolean(me) })
  const run = useRun()
  const [adding, setAdding] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [receiveFrom, setReceiveFrom] = useState<InventoryBalance | null>(null)
  const [showFinished, setShowFinished] = useState(false)
  const [showPayments, setShowPayments] = useState(false)

  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members])
  const nameOf = (id: string) => (id === me?.id ? 'You' : memberById.get(id)?.name ?? 'Former member')

  const takesByItem = useMemo(() => {
    const map = new Map<string, InventoryTake[]>()
    for (const t of q.data?.takes ?? []) map.set(t.item_id, [...(map.get(t.item_id) ?? []), t])
    return map
  }, [q.data])

  if (isLoading || q.isLoading) return <PageLoading />
  if (q.error) return <ErrorBox error={q.error} retry={() => q.refetch()} />
  const data = q.data!

  const open = data.items.filter((i) => !i.finished_at)
  const finished = data.items.filter((i) => i.finished_at)
  const detail = data.items.find((i) => i.id === detailId)

  // No success toast: the count on the card is the feedback.
  const step = (item: InventoryItem, dir: 1 | -1) =>
    run(() => (dir === 1 ? inventoryTake(item.id, 1) : inventoryPutBack(item.id, 1)))

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-extrabold tracking-tight">Stock</h1>
        <Button size="sm" onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> I bought something</Button>
      </div>
      <p className="text-slate-400 text-sm mb-4">Food and things bought for the house. Log what you take; you pay the buyer for your share.</p>

      <BalancesCard balances={data.balances} meId={me?.id} memberById={memberById} nameOf={nameOf} onReceive={setReceiveFrom} />

      <SectionTitle>In stock</SectionTitle>
      {open.length === 0 ? (
        <Card className="text-center py-8">
          <div className="text-4xl mb-2">🧺</div>
          <p className="text-slate-400 text-sm">Nothing here yet. Bought something for the house? Add it.</p>
        </Card>
      ) : (
        <div className="space-y-2">
          {open.map((item) => (
            <ItemCard
              key={item.id} item={item} takes={takesByItem.get(item.id) ?? []} meId={me?.id} memberById={memberById} nameOf={nameOf}
              onOpen={() => setDetailId(item.id)} onStep={(dir) => step(item, dir)}
            />
          ))}
        </div>
      )}

      {finished.length > 0 && (
        <>
          <Collapser open={showFinished} onToggle={() => setShowFinished((v) => !v)}>Finished ({finished.length})</Collapser>
          {showFinished && (
            <div className="space-y-2">
              {finished.map((item) => (
                <Card key={item.id} onClick={() => setDetailId(item.id)} className="py-3">
                  <div className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold truncate text-slate-300">{item.name}</div>
                      <div className="text-xs text-slate-500">
                        {nameOf(item.bought_by)} · {formatRupees(item.price_paise)} · finished {timeAgo(item.finished_at)}
                        {item.remaining_qty > 0 && ` · ${formatQty(item.remaining_qty, item.unit)} thrown away`}
                      </div>
                    </div>
                    <ChevronRight className="h-4 w-4 text-slate-500" />
                  </div>
                </Card>
              ))}
            </div>
          )}
        </>
      )}

      {data.payments.length > 0 && (
        <>
          <Collapser open={showPayments} onToggle={() => setShowPayments((v) => !v)}>Payments ({data.payments.length})</Collapser>
          {showPayments && (
            <Card className="py-2 divide-y divide-line">
              {data.payments.map((p) => (
                <div key={p.id} className="flex items-center gap-3 py-2.5">
                  <span className="text-lg">💸</span>
                  <div className="flex-1 min-w-0 text-sm">
                    <div><b>{nameOf(p.from_user)}</b> paid <b>{nameOf(p.to_user)}</b> <span className="text-emerald-300 font-semibold">{formatRupees(p.amount_paise)}</span></div>
                    <div className="text-xs text-slate-500">{format(new Date(p.created_at), 'd MMM, h:mm a')}{p.note && ` · ${p.note}`}</div>
                  </div>
                  {(p.to_user === me?.id || isAdmin) && (
                    <button className="text-xs font-semibold text-rose-300 hover:underline"
                      onClick={() => run(() => inventoryUndoPayment(p.id), 'Payment undone')}>Undo</button>
                  )}
                </div>
              ))}
            </Card>
          )}
        </>
      )}

      <ItemFormSheet open={adding} onClose={() => setAdding(false)} />
      <ItemDetailSheet
        key={detailId ?? 'none'} item={detail ?? null} takes={detail ? takesByItem.get(detail.id) ?? [] : []} meId={me?.id} isAdmin={isAdmin}
        memberById={memberById} nameOf={nameOf} onClose={() => setDetailId(null)}
      />
      <ReceiveSheet balance={receiveFrom} nameOf={nameOf} onClose={() => setReceiveFrom(null)} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------
function BalancesCard({ balances, meId, memberById, nameOf, onReceive }: {
  balances: InventoryBalance[]; meId?: string; memberById: Map<string, Member>; nameOf: (id: string) => string; onReceive: (b: InventoryBalance) => void
}) {
  const iOwe = balances.filter((b) => b.debtor === meId)
  const owedToMe = balances.filter((b) => b.creditor === meId)
  const others = balances.filter((b) => b.debtor !== meId && b.creditor !== meId)
  const [showOthers, setShowOthers] = useState(false)

  return (
    <Card className="py-3">
      {iOwe.length === 0 && owedToMe.length === 0 ? (
        <p className="text-sm text-slate-300 py-1">✅ You're all square. Nobody owes you and you owe nobody.</p>
      ) : (
        <div className="space-y-1">
          {iOwe.map((b) => (
            <div key={b.creditor} className="flex items-center gap-3 py-1.5">
              <Avatar name={nameOf(b.creditor)} url={memberById.get(b.creditor)?.avatar_url} size="sm" />
              <div className="flex-1 min-w-0 text-sm">You owe <b>{nameOf(b.creditor)}</b></div>
              <span className="font-extrabold tabular-nums text-rose-300">{formatRupees(b.amount_paise)}</span>
            </div>
          ))}
          {owedToMe.map((b) => (
            <div key={b.debtor} className="flex items-center gap-3 py-1.5">
              <Avatar name={nameOf(b.debtor)} url={memberById.get(b.debtor)?.avatar_url} size="sm" />
              <div className="flex-1 min-w-0 text-sm"><b>{nameOf(b.debtor)}</b> owes you</div>
              <span className="font-extrabold tabular-nums text-emerald-300">{formatRupees(b.amount_paise)}</span>
              <Button size="sm" variant="secondary" onClick={() => onReceive(b)}>Received</Button>
            </div>
          ))}
          {iOwe.length > 0 && <p className="text-xs text-slate-500 px-1 pt-1">Pay them, then they mark it received here.</p>}
        </div>
      )}
      {others.length > 0 && (
        <div className="border-t border-line mt-2 pt-2">
          <button className="text-xs text-slate-400 hover:text-slate-200 font-semibold" onClick={() => setShowOthers((v) => !v)}>
            {showOthers ? 'Hide' : 'Show'} everyone else ({others.length})
          </button>
          {showOthers && (
            <div className="mt-1 space-y-1">
              {others.map((b) => (
                <div key={b.debtor + b.creditor} className="flex justify-between text-sm text-slate-400">
                  <span>{nameOf(b.debtor)} → {nameOf(b.creditor)}</span>
                  <span className="tabular-nums">{formatRupees(b.amount_paise)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

function ReceiveSheet({ balance, nameOf, onClose }: { balance: InventoryBalance | null; nameOf: (id: string) => string; onClose: () => void }) {
  const run = useRun()
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [forId, setForId] = useState<string | null>(null)
  // Pre-fill with the full debt each time the sheet opens for someone.
  if (balance && forId !== balance.debtor) {
    setForId(balance.debtor)
    setAmount(String(balance.amount_paise / 100))
    setNote('')
  }
  const paise = toPaise(amount)
  const valid = balance !== null && paise !== null && paise > 0 && paise <= balance.amount_paise

  const close = () => { if (!busy) { setForId(null); onClose() } }

  return (
    <Sheet open={balance !== null} onClose={close} title={balance ? `Received from ${nameOf(balance.debtor)}` : undefined}>
      {balance && (
        <form className="space-y-4" onSubmit={async (e) => {
          e.preventDefault()
          if (!valid) return
          setBusy(true)
          const ok = await run(() => inventoryRecordPayment(balance.debtor, paise!, note.trim() || undefined),
            `${formatRupees(paise!)} from ${nameOf(balance.debtor)} recorded`)
          setBusy(false)
          if (ok) { setForId(null); onClose() }
        }}>
          <p className="text-sm text-slate-400">They owe you <b className="text-slate-100">{formatRupees(balance.amount_paise)}</b>. Only mark what you've actually got.</p>
          <Field label="Amount (₹)">
            <input type="number" inputMode="decimal" min={0.01} step={0.01} value={amount} onChange={(e) => setAmount(e.target.value)} required />
          </Field>
          <Field label="Note (optional)">
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={100} placeholder="GPay, cash…" />
          </Field>
          <Button type="submit" className="w-full" loading={busy} disabled={!valid}>
            Mark {paise ? formatRupees(paise) : ''} received
          </Button>
        </form>
      )}
    </Sheet>
  )
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------
/** Per-person totals for an item, biggest first. */
function takers(takes: InventoryTake[]) {
  const map = new Map<string, { qty: number; cost: number }>()
  for (const t of takes) {
    const cur = map.get(t.user_id) ?? { qty: 0, cost: 0 }
    map.set(t.user_id, { qty: cur.qty + t.qty, cost: cur.cost + t.cost_paise })
  }
  return [...map.entries()].sort((a, b) => b[1].qty - a[1].qty)
}

function ItemCard({ item, takes, meId, memberById, nameOf, onOpen, onStep }: {
  item: InventoryItem; takes: InventoryTake[]; meId?: string; memberById: Map<string, Member>; nameOf: (id: string) => string
  onOpen: () => void; onStep: (dir: 1 | -1) => Promise<boolean>
}) {
  const [busy, setBusy] = useState(false)
  const pct = Math.max(0, Math.min(100, (item.remaining_qty / item.total_qty) * 100))
  const who = takers(takes)
  const mine = takes.filter((t) => t.user_id === meId)
  const myQty = mine.reduce((s, t) => s + t.qty, 0)
  // "−" can only take back what you took in the last 24 hours (the server enforces the same).
  const canPutBack = mine.some((t) => Date.now() - new Date(t.created_at).getTime() < DAY)
  const step = async (dir: 1 | -1) => { setBusy(true); await onStep(dir); setBusy(false) }

  return (
    <Card className="py-3">
      <div className="flex items-start gap-3">
        <button className="flex-1 min-w-0 text-left" onClick={onOpen}>
          <div className="font-bold truncate">{item.name}</div>
          <div className="text-xs text-slate-400">
            {nameOf(item.bought_by)} bought · {formatRupees(item.price_paise)} · {rateLabel(item)}
          </div>
        </button>
        {countable(item.unit) ? (
          <div className={cx('flex items-center shrink-0 rounded-xl border border-line bg-card-2 transition-opacity', busy && 'opacity-60')}>
            <button aria-label={`Put back one ${item.name}`} disabled={busy || !canPutBack} onClick={() => step(-1)}
              className="h-9 w-9 flex items-center justify-center rounded-l-xl text-slate-200 hover:bg-white/5 disabled:text-slate-600 disabled:hover:bg-transparent">
              <Minus className="h-4 w-4" />
            </button>
            <span className="min-w-7 text-center text-sm font-bold tabular-nums" title="How many you've taken">{Number(myQty.toFixed(3))}</span>
            <button aria-label={`Take one ${item.name}`} disabled={busy || item.remaining_qty < 1} onClick={() => step(1)}
              className="h-9 w-9 flex items-center justify-center rounded-r-xl text-emerald-300 hover:bg-white/5 disabled:text-slate-600 disabled:hover:bg-transparent">
              <Plus className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <Button size="sm" variant="secondary" onClick={onOpen}>Take</Button>
        )}
      </div>

      <button className="block w-full text-left mt-2.5" onClick={onOpen}>
        <div className="h-1.5 rounded-full bg-card-2 overflow-hidden">
          <div className={cx('h-full rounded-full', pct > 25 ? 'bg-emerald-400' : 'bg-amber-300')} style={{ width: `${pct}%` }} />
        </div>
        <div className="flex items-center justify-between gap-2 mt-1.5">
          <span className="text-xs text-slate-400 tabular-nums">{formatQty(item.remaining_qty, item.unit)} of {formatQty(item.total_qty, item.unit)} left</span>
          <div className="flex items-center gap-1.5 overflow-hidden">
            {who.slice(0, 4).map(([uid, v]) => (
              <span key={uid} className="flex items-center gap-1 text-[11px] text-slate-300 tabular-nums">
                <Avatar name={nameOf(uid)} url={memberById.get(uid)?.avatar_url} size="xs" />
                {Number(v.qty.toFixed(3))}
              </span>
            ))}
            {who.length > 4 && <span className="text-[11px] text-slate-500">+{who.length - 4}</span>}
          </div>
        </div>
      </button>
    </Card>
  )
}

function ItemDetailSheet({ item, takes, meId, isAdmin, memberById, nameOf, onClose }: {
  item: InventoryItem | null; takes: InventoryTake[]; meId?: string; isAdmin: boolean; memberById: Map<string, Member>; nameOf: (id: string) => string; onClose: () => void
}) {
  const run = useRun()
  const [qty, setQty] = useState('')
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [confirmFinish, setConfirmFinish] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const close = () => { if (!busy) { setQty(''); setConfirmFinish(false); setConfirmDelete(false); onClose() } }
  if (!item) return <Sheet open={false} onClose={onClose}>{null}</Sheet>

  const isOpen = !item.finished_at
  const canManage = item.bought_by === meId || isAdmin
  const n = Number(qty)
  const validQty = qty.trim() !== '' && Number.isFinite(n) && n > 0 && n <= item.remaining_qty && (!countable(item.unit) || Number.isInteger(n))
  const estimate = validQty ? n * item.unit_cost : null
  const who = takers(takes)
  const othersOwed = who.filter(([uid]) => uid !== item.bought_by)

  const take = async () => {
    if (!validQty) return
    setBusy(true)
    const ok = await run(() => inventoryTake(item.id, n), `Took ${formatQty(n, item.unit)} of ${item.name} · ${formatRupees(n * item.unit_cost)}`)
    setBusy(false)
    if (ok) setQty('')
  }

  return (
    <>
      <Sheet open={!editing} onClose={close} title={item.name}>
        <div className="space-y-4">
          <div className="text-sm text-slate-400">
            <b className="text-slate-200">{nameOf(item.bought_by)}</b> bought {formatQty(item.total_qty, item.unit)} for <b className="text-slate-200">{formatRupees(item.price_paise)}</b> on {format(new Date(item.created_at), 'd MMM')}.
            <div className="mt-1">
              {isOpen
                ? <>{formatQty(item.remaining_qty, item.unit)} left · {rateLabel(item)}</>
                : <>Finished {timeAgo(item.finished_at)}{item.remaining_qty > 0 && <> with {formatQty(item.remaining_qty, item.unit)} thrown away</>} · cost now {rateLabel(item)}</>}
            </div>
          </div>

          {isOpen && (
            <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); take() }}>
              <Field label={`How much did you take? (${UNITS.find((u) => u.value === item.unit)?.label.toLowerCase()})`}>
                <input type="number" inputMode="decimal" min={0} step={countable(item.unit) ? 1 : 'any'} value={qty} onChange={(e) => setQty(e.target.value)} placeholder="0" />
              </Field>
              <div className="flex gap-2 overflow-x-auto no-scrollbar -mx-1 px-1">
                {QUICK[item.unit].filter((v) => v <= item.remaining_qty).map((v) => (
                  <button key={v} type="button" onClick={() => setQty(String(v))}
                    className={cx('shrink-0 rounded-full border px-3 h-8 text-xs font-semibold', Number(qty) === v ? 'bg-slate-100 text-slate-900 border-slate-100' : 'border-line text-slate-300 hover:bg-white/5')}>
                    {formatQty(v, item.unit)}
                  </button>
                ))}
                <button type="button" onClick={() => setQty(String(item.remaining_qty))}
                  className="shrink-0 rounded-full border border-line px-3 h-8 text-xs font-semibold text-slate-300 hover:bg-white/5">
                  All the rest
                </button>
              </div>
              <Button type="submit" className="w-full" loading={busy} disabled={!validQty}>
                {estimate !== null ? `Take ${formatQty(n, item.unit)} · ${formatRupees(estimate)}` : 'Take'}
              </Button>
            </form>
          )}

          <div>
            <h4 className="text-[11px] font-bold tracking-[0.18em] uppercase text-slate-400 mb-2 px-1">Who took what</h4>
            {who.length === 0 ? (
              <p className="text-sm text-slate-500 px-1">Nobody has taken any yet.</p>
            ) : (
              <div className="rounded-2xl border border-line divide-y divide-line">
                {who.map(([uid, v]) => (
                  <div key={uid} className="flex items-center gap-3 px-3 py-2">
                    <Avatar name={nameOf(uid)} url={memberById.get(uid)?.avatar_url} size="xs" />
                    <span className="flex-1 text-sm">{nameOf(uid)}</span>
                    <span className="text-sm tabular-nums text-slate-300">{formatQty(v.qty, item.unit)}</span>
                    <span className={cx('text-sm tabular-nums w-16 text-right font-semibold', uid === item.bought_by ? 'text-slate-500' : 'text-slate-100')}>
                      {uid === item.bought_by ? 'paid' : formatRupees(v.cost)}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {isOpen && item.remaining_qty > 0 && who.length > 0 && (
              <p className="text-xs text-slate-500 px-1 mt-2">If the rest gets thrown away, its cost is shared by the people who took some, so these amounts can go up.</p>
            )}
          </div>

          {takes.length > 0 && (
            <details className="group">
              <summary className="text-xs font-semibold text-slate-400 cursor-pointer list-none px-1 [&::-webkit-details-marker]:hidden">
                <span className="group-open:hidden">Show every entry ({takes.length})</span><span className="hidden group-open:inline">Hide entries</span>
              </summary>
              <div className="mt-2 space-y-1">
                {takes.map((t) => {
                  const canUndo = isAdmin || (t.user_id === meId && Date.now() - new Date(t.created_at).getTime() < DAY)
                  return (
                    <div key={t.id} className="flex items-center gap-2 text-sm px-1">
                      <span className="flex-1 text-slate-300">{nameOf(t.user_id)} · {formatQty(t.qty, item.unit)}</span>
                      <span className="text-xs text-slate-500">{timeAgo(t.created_at)}</span>
                      {canUndo && (
                        <button className="text-xs font-semibold text-rose-300 hover:underline"
                          onClick={() => run(() => inventoryUndoTake(t.id), 'Undone')}>Undo</button>
                      )}
                    </div>
                  )
                })}
              </div>
            </details>
          )}

          {canManage && (
            <div className="border-t border-line pt-4 space-y-2">
              {isOpen && (
                confirmFinish ? (
                  <div className="space-y-2">
                    <p className="text-sm text-slate-300">
                      Mark it finished with {formatQty(item.remaining_qty, item.unit)} left (thrown away or gone off)?
                      {who.length > 0 ? ' Its full price will be shared by the people who took some.' : ' Nobody took any, so you keep the cost.'}
                    </p>
                    <div className="flex gap-2">
                      <Button variant="ghost" className="flex-1" onClick={() => setConfirmFinish(false)}>Cancel</Button>
                      <Button variant="danger" className="flex-1" loading={busy} onClick={async () => {
                        setBusy(true)
                        const ok = await run(() => inventoryFinishItem(item.id, true), `${item.name} finished`)
                        setBusy(false)
                        if (ok) setConfirmFinish(false)
                      }}>Yes, finish it</Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <Button variant="secondary" className="flex-1" onClick={() => setEditing(true)}>Edit</Button>
                    <Button variant="secondary" className="flex-1" onClick={() => { setConfirmDelete(false); setConfirmFinish(true) }}>Finished / thrown away</Button>
                  </div>
                )
              )}
              {!isOpen && item.remaining_qty > 0 && (
                <Button variant="secondary" className="w-full" loading={busy} onClick={() => run(() => inventoryFinishItem(item.id, false), `${item.name} is back in stock`)}>
                  Put back in stock
                </Button>
              )}
              {confirmDelete ? (
                <div className="space-y-2 rounded-2xl border border-rose-400/20 bg-rose-500/10 p-3">
                  <p className="text-sm text-rose-100">
                    Delete {item.name} for good?
                    {othersOwed.length > 0 && (
                      <> It also removes what {othersOwed.map(([uid, v]) => `${nameOf(uid)} (${formatQty(v.qty, item.unit)}, ${formatRupees(v.cost)})`).join(', ')} took, so they won't owe you for it. They'll be notified. If someone already paid you for it, you'll owe that back.</>
                    )}
                  </p>
                  <div className="flex gap-2">
                    <Button variant="ghost" className="flex-1" onClick={() => setConfirmDelete(false)}>Cancel</Button>
                    <Button variant="danger" className="flex-1" loading={busy} onClick={async () => {
                      setBusy(true)
                      const ok = await run(() => inventoryDeleteItem(item.id), `${item.name} deleted`)
                      setBusy(false)
                      if (ok) onClose()
                    }}>Yes, delete</Button>
                  </div>
                </div>
              ) : (
                <Button variant="danger" className="w-full" onClick={() => { setConfirmFinish(false); setConfirmDelete(true) }}>Delete item</Button>
              )}
            </div>
          )}
        </div>
      </Sheet>
      <ItemFormSheet open={editing} item={item} onClose={() => setEditing(false)} />
    </>
  )
}

/** Add an item (bought by me), or edit one when `item` is given. The unit can't change after adding. */
function ItemFormSheet({ open, item, onClose }: { open: boolean; item?: InventoryItem; onClose: () => void }) {
  const run = useRun()
  const [name, setName] = useState('')
  const [unit, setUnit] = useState<InventoryUnit>('pcs')
  const [qty, setQty] = useState('')
  const [price, setPrice] = useState('')
  const [busy, setBusy] = useState(false)
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  // Load the item's values each time the edit sheet opens.
  const key = open ? (item?.id ?? 'new') : null
  if (key !== loadedFor) {
    setLoadedFor(key)
    if (key) {
      setName(item?.name ?? '')
      setUnit(item?.unit ?? 'pcs')
      setQty(item ? String(item.total_qty) : '')
      setPrice(item ? String(item.price_paise / 100) : '')
    }
  }

  const n = Number(qty)
  const paise = toPaise(price)
  const valid = name.trim().length > 0 && Number.isFinite(n) && n > 0 && (!countable(unit) || Number.isInteger(n)) && paise !== null
  const close = () => { if (!busy) onClose() }

  return (
    <Sheet open={open} onClose={close} title={item ? `Edit ${item.name}` : 'I bought something'}>
      <form className="space-y-4" onSubmit={async (e) => {
        e.preventDefault()
        if (!valid) return
        setBusy(true)
        const ok = item
          ? await run(() => inventoryUpdateItem(item.id, name.trim(), n, paise!), 'Saved')
          : await run(() => inventoryAddItem(name.trim(), unit, n, paise!), `${name.trim()} added. Everyone's been told.`)
        setBusy(false)
        if (ok) onClose()
      }}>
        <Field label="What is it?">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required placeholder="Half-cooked chapati, rice, bananas…" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="How much?">
            <input type="number" inputMode="decimal" min={0} step={countable(unit) ? 1 : 'any'} value={qty} onChange={(e) => setQty(e.target.value)} required placeholder={countable(unit) ? '10' : '1000'} />
          </Field>
          <Field label="Unit">
            <select value={unit} onChange={(e) => setUnit(e.target.value as InventoryUnit)} disabled={Boolean(item)}>
              {UNITS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Total price (₹)" hint={valid && n > 0 && paise ? `That's ${formatRupees(paise / n)} per ${unit === 'pcs' ? 'piece' : unit === 'pack' ? 'pack' : unit === 'l' ? 'L' : unit}.` : undefined}>
          <input type="number" inputMode="decimal" min={0} step={0.01} value={price} onChange={(e) => setPrice(e.target.value)} required placeholder="80" />
        </Field>
        <Button type="submit" className="w-full" loading={busy} disabled={!valid}>{item ? 'Save' : 'Add to stock'}</Button>
        {item && <p className="text-xs text-slate-500 px-1">Changing the price re-prices everything already taken.</p>}
      </form>
    </Sheet>
  )
}

function Collapser({ open, onToggle, children }: { open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <button onClick={onToggle} className="flex items-center gap-1.5 px-1 mt-6 mb-2 text-[11px] font-bold tracking-[0.18em] uppercase text-slate-400 hover:text-slate-200">
      <ChevronRight className={cx('h-3.5 w-3.5 transition-transform', open && 'rotate-90')} />
      {children}
    </button>
  )
}
