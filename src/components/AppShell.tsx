import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Home, LayoutGrid, Trophy, User, Settings, History } from 'lucide-react'
import { useHouse, useRealtimeSync } from '@/hooks/useHouse'
import { useAuth } from '@/hooks/useAuth'
import { cx } from './ui'

export function AppShell() {
  const { user } = useAuth()
  const { isAdmin, data } = useHouse()
  useRealtimeSync(Boolean(user))
  const nav = useNavigate()
  const loc = useLocation()

  const tabs = [
    { to: '/', label: 'Home', icon: Home },
    { to: '/areas', label: 'Areas', icon: LayoutGrid },
    { to: '/league', label: 'League', icon: Trophy },
    { to: '/profile', label: 'Profile', icon: User },
    ...(isAdmin ? [{ to: '/admin', label: 'Admin', icon: Settings }] : []),
  ]

  return (
    <div className="min-h-dvh flex flex-col">
      <header className="safe-top sticky top-0 z-30 bg-surface/80 backdrop-blur border-b border-line">
        <div className="mx-auto max-w-lg px-4 h-14 flex items-center justify-between">
          <button onClick={() => nav('/')} className="flex items-center gap-2 font-extrabold tracking-tight">
            <span className="text-xl">🏠</span>
            <span>{data?.house.name ?? 'ChoreWars'}</span>
          </button>
          <button
            onClick={() => nav('/history')}
            className={cx('p-2 -mr-2 rounded-full text-slate-400 hover:bg-white/5', loc.pathname === '/history' && 'text-emerald-300')}
            aria-label="History"
          >
            <History className="h-5 w-5" />
          </button>
        </div>
      </header>

      <main className="flex-1 mx-auto w-full max-w-lg px-4 pt-4 pb-28">
        <Outlet />
      </main>

      <nav className="fixed bottom-0 inset-x-0 z-30 bg-surface/90 backdrop-blur border-t border-line safe-bottom">
        <div className="mx-auto max-w-lg grid" style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}>
          {tabs.map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
              end={t.to === '/'}
              className={({ isActive }) =>
                cx('flex flex-col items-center justify-center gap-1 h-16 text-[11px] font-semibold transition-colors', isActive ? 'text-emerald-300' : 'text-slate-500 hover:text-slate-300')
              }
            >
              {({ isActive }) => (
                <>
                  <t.icon className={cx('h-5 w-5', isActive && 'drop-shadow-[0_0_8px_rgba(52,211,153,0.6)]')} />
                  {t.label}
                </>
              )}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  )
}
