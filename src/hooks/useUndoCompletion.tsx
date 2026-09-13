import { useCallback, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { adminUndoCompletion } from '@/lib/api'
import { friendlyError } from '@/lib/errors'
import type { Completion } from '@/lib/types'
import { Button, Sheet, useToast } from '@/components/ui'

/** Admin-only: confirm + undo the latest completion of an area. */
export function useUndoCompletion() {
  const [pending, setPending] = useState<Completion | null>(null)
  const [busy, setBusy] = useState(false)
  const qc = useQueryClient()
  const toast = useToast()

  const request = useCallback((c: Completion) => setPending(c), [])
  const close = useCallback(() => !busy && setPending(null), [busy])

  const run = async () => {
    if (!pending) return
    setBusy(true)
    try {
      await adminUndoCompletion(pending.id)
      toast.show(`Undone. ${pending.scheduled?.name ?? 'The scheduled person'} is up for the ${pending.area?.name ?? 'area'} again.`, 'success')
      setPending(null)
    } catch (e) {
      toast.show(friendlyError(e), 'error')
    } finally {
      setBusy(false)
      await qc.invalidateQueries()
    }
  }

  const sheet = (
    <Sheet open={pending !== null} onClose={close} title={pending ? `Undo ${pending.area?.name ?? 'this'} completion?` : undefined}>
      {pending && (
        <div className="space-y-2 text-slate-300 text-sm">
          <p>
            <b className="text-slate-100">{pending.cleaner?.name ?? 'Someone'}</b> loses the <b className="text-slate-100">{pending.points_awarded} points</b> from this clean.
            The turn goes back to <b className="text-slate-100">{pending.scheduled?.name ?? 'the scheduled person'}</b> and streaks are recalculated.
          </p>
          <p className="text-xs text-slate-500">Only the most recent completion of an area can be undone.</p>
        </div>
      )}
      <div className="flex gap-3 mt-5">
        <Button variant="secondary" className="flex-1" onClick={close} disabled={busy}>Cancel</Button>
        <Button variant="danger" className="flex-1" onClick={run} loading={busy}>Undo</Button>
      </div>
    </Sheet>
  )

  return { request, sheet }
}
