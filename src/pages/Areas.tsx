import { useAreaViews } from '@/hooks/useHouse'
import { AreaRow } from '@/components/AreaCard'
import { ErrorBox, PageLoading } from '@/components/ui'

export function AreasPage() {
  const { views, now, isLoading, error } = useAreaViews()
  if (isLoading) return <PageLoading />
  if (error) return <ErrorBox error={error} />

  const active = views.filter((v) => v.isActive)
  const passive = views.filter((v) => !v.isActive)

  return (
    <div>
      <h1 className="text-2xl font-extrabold tracking-tight mb-4">Areas</h1>
      {views.length === 0 && <p className="text-slate-400">No cleaning areas yet. An admin can add some.</p>}
      {active.length > 0 && (
        <div className="space-y-2 mb-5">
          <p className="text-[11px] font-bold tracking-[0.18em] uppercase text-rose-300 px-1">Needs cleaning</p>
          {active.map((v) => <AreaRow key={v.area.id} view={v} now={now} />)}
        </div>
      )}
      <div className="space-y-2">
        {active.length > 0 && passive.length > 0 && <p className="text-[11px] font-bold tracking-[0.18em] uppercase text-slate-400 px-1">Everything else</p>}
        {passive.map((v) => <AreaRow key={v.area.id} view={v} now={now} />)}
      </div>
      <p className="text-xs text-slate-500 mt-6 px-1 leading-relaxed">
        Statuses are estimates from the last clean. Tap an area and flag it when it actually needs cleaning — that's what puts it on someone's list.
      </p>
    </div>
  )
}
