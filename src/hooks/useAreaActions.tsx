import { useCallback, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { claimVolunteer, completeCleaning, dismissActivation, markNeedsCleaning, releaseVolunteer, retractDismissVote, voteDismiss } from '@/lib/api'
import { friendlyError } from '@/lib/errors'
import { timeAgo } from '@/lib/format'
import { voterNames, type AreaView } from '@/lib/status'
import { Button, Sheet, useToast } from '@/components/ui'
import { useCelebration } from '@/components/Celebration'

export type ActionKind = 'mark' | 'complete' | 'volunteer' | 'release' | 'dismiss' | 'vote_dismiss' | 'unvote_dismiss'

interface Pending { kind: ActionKind; view: AreaView }

/**
 * Owns the confirm-sheet + mutation flow for all area actions.
 * Usage: const { request, sheet } = useAreaActions(); ...; {sheet}
 */
export function useAreaActions(now: Date) {
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)
  const qc = useQueryClient()
  const toast = useToast()
  const { celebrate } = useCelebration()

  const request = useCallback((kind: ActionKind, view: AreaView) => setPending({ kind, view }), [])
  const close = useCallback(() => !busy && setPending(null), [busy])

  const run = async () => {
    if (!pending) return
    const { kind, view } = pending
    const id = view.area.id
    setBusy(true)
    try {
      if (kind === 'mark') {
        const r = await markNeedsCleaning(id)
        toast.show(`${r.area_icon} ${r.area_name} needs cleaning — ${r.scheduled_user_name}'s turn.`, 'success')
      } else if (kind === 'complete') {
        const r = await completeCleaning(id)
        celebrate({ kind: 'completion', result: r })
      } else if (kind === 'volunteer') {
        const r = await claimVolunteer(id)
        celebrate({ kind: 'volunteer', areaName: r.area_name, areaIcon: r.area_icon, scheduledName: r.scheduled_user_name })
      } else if (kind === 'release') {
        await releaseVolunteer(id)
        toast.show(`Responsibility returned to ${view.scheduled?.name ?? 'the scheduled person'}.`)
      } else if (kind === 'dismiss') {
        await dismissActivation(id)
        toast.show(`${view.area.name} flag cleared.`)
      } else if (kind === 'vote_dismiss') {
        const r = await voteDismiss(id)
        if (r.dismissed) toast.show(`${view.area.name} marked as not needed.`, 'success')
        else toast.show(`Noted — ${r.votes} of ${r.needed} needed to clear the ${view.area.name}.`)
      } else if (kind === 'unvote_dismiss') {
        await retractDismissVote(id)
        toast.show('Your vote was withdrawn.')
      }
      setPending(null)
    } catch (e) {
      toast.show(friendlyError(e), 'error')
    } finally {
      setBusy(false)
      await qc.invalidateQueries()
    }
  }

  const kind = pending?.kind
  const variant = kind === 'complete' ? 'hero' : kind === 'dismiss' || kind === 'release' || kind === 'unvote_dismiss' ? 'danger' : 'primary'

  const sheet = (
    <Sheet open={pending !== null} onClose={close} title={pending ? TITLES[pending.kind](pending.view) : undefined}>
      {pending && <Body p={pending} now={now} />}
      <div className="flex gap-3 mt-5">
        <Button variant="secondary" className="flex-1" onClick={close} disabled={busy}>Cancel</Button>
        <Button variant={variant} className="flex-1" onClick={run} loading={busy}>
          {pending ? CONFIRM[pending.kind] : ''}
        </Button>
      </div>
    </Sheet>
  )

  return { request, sheet }
}

const TITLES: Record<ActionKind, (v: AreaView) => ReactNode> = {
  mark: (v) => `Does the ${v.area.name} need cleaning?`,
  complete: (v) => `Mark ${v.area.name} as cleaned?`,
  volunteer: (v) => `Volunteer to clean the ${v.area.name}?`,
  release: () => 'Cancel your volunteer claim?',
  dismiss: (v) => `Clear the flag on the ${v.area.name}?`,
  vote_dismiss: (v) => `${v.area.name} looks fine?`,
  unvote_dismiss: () => 'Withdraw your vote?',
}

const CONFIRM: Record<ActionKind, string> = {
  mark: 'Yes, mark as needed',
  complete: 'Complete',
  volunteer: "I'll do it",
  release: 'Cancel claim',
  dismiss: 'Clear flag',
  vote_dismiss: 'Yes, looks fine',
  unvote_dismiss: 'Withdraw',
}

function Body({ p, now }: { p: Pending; now: Date }) {
  const { kind, view } = p
  const a = view.area
  const next = view.rotationPreview[1] ?? view.rotationPreview[0]
  const lastCleaned = a.state.last_cleaned_at ? `Last cleaned ${timeAgo(a.state.last_cleaned_at, now)}.` : 'No cleaning recorded yet.'

  if (kind === 'mark') {
    return (
      <div className="space-y-2 text-slate-300">
        <p>{lastCleaned}</p>
        <p>{view.scheduled ? <><b className="text-slate-100">{view.scheduled.name}</b> is next in rotation and will be asked to clean it.</> : 'The first person in the rotation will be asked to clean it.'}</p>
        <p className="text-xs text-slate-500">Flagging an area earns no points.</p>
      </div>
    )
  }
  if (kind === 'complete') {
    const rescue = view.amVolunteer && !view.isMyTurn
    const pts = rescue ? a.rescue_points : a.normal_points
    return (
      <div className="space-y-3 text-slate-300">
        <div className="rounded-2xl bg-card-2 border border-line p-4 flex items-center justify-between">
          <span className="font-semibold text-slate-100">{rescue ? 'Rescue points' : 'Points'}</span>
          <span className="text-2xl font-black text-emerald-300">+{pts}</span>
        </div>
        <p className="text-sm">Bonuses for early cleaning and streaks are added automatically.</p>
        {next && <p className="text-sm">Next in rotation: <b className="text-slate-100">{next.name}</b></p>}
      </div>
    )
  }
  if (kind === 'volunteer') {
    return (
      <div className="space-y-2 text-slate-300">
        <p><b className="text-slate-100">{view.scheduled?.name ?? 'The scheduled person'}</b> stays recorded as the scheduled person.</p>
        <p>You'll receive <b className="text-emerald-300">+{a.rescue_points} rescue points</b> when you mark it done.</p>
        <p className="text-xs text-slate-500">They can still finish it themselves, in which case your claim is cleared.</p>
      </div>
    )
  }
  if (kind === 'release') {
    return <p className="text-slate-300">Responsibility for the {a.name} goes back to <b className="text-slate-100">{view.scheduled?.name ?? 'the scheduled person'}</b>.</p>
  }
  if (kind === 'vote_dismiss') {
    const votes = view.dismissVoters.length
    const needed = view.dismissVotesNeeded
    const decisive = votes + 1 >= needed
    return (
      <div className="space-y-2 text-slate-300">
        <p>{lastCleaned}</p>
        {votes > 0 && (
          <p><b className="text-slate-100">{voterNames(view.dismissVoters)}</b> {votes === 1 ? 'thinks' : 'think'} it looks fine too.</p>
        )}
        {decisive ? (
          <p>Your vote clears the flag: the {a.name} goes back to normal without advancing the rotation. Nobody earns points.</p>
        ) : (
          <p>It takes <b className="text-slate-100">{needed} of the {view.rotationPreview.length}</b> people who clean the {a.name} to agree. Yours will be vote {votes + 1}.</p>
        )}
      </div>
    )
  }
  if (kind === 'unvote_dismiss') {
    return <p className="text-slate-300">Your "looks fine" vote on the {a.name} will be removed.</p>
  }
  return (
    <p className="text-slate-300">
      Admin override: this returns the {a.name} to its normal status without advancing the rotation. Nobody earns points.
    </p>
  )
}
