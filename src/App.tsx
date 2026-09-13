import type { ReactNode } from 'react'
import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AuthProvider, useAuth } from '@/hooks/useAuth'
import { useHouse } from '@/hooks/useHouse'
import { supabaseConfigured } from '@/lib/supabase'
import { Button, CelebrationSafeProviders, PageLoading, Spinner } from '@/components/providers'
import { AppShell } from '@/components/AppShell'
import { LoginPage } from '@/pages/Login'
import { HomePage } from '@/pages/Home'
import { AreasPage } from '@/pages/Areas'
import { AreaDetailPage } from '@/pages/AreaDetail'
import { HistoryPage } from '@/pages/History'
import { LeaderboardPage } from '@/pages/Leaderboard'
import { ProfilePage } from '@/pages/Profile'
import { AdminPage } from '@/pages/Admin'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: true, staleTime: 10_000 },
  },
})

function RequireAuth() {
  const { user, loading } = useAuth()
  if (loading) return <FullScreen><Spinner /></FullScreen>
  if (!user) return <Navigate to="/login" replace />
  return <RequireHouse />
}

function RequireHouse() {
  const { data, isLoading, error, refetch } = useHouse()
  const { signOut } = useAuth()
  if (isLoading) return <div className="mx-auto max-w-lg px-4 pt-6"><PageLoading /></div>
  if (error) {
    return (
      <FullScreen>
        <div className="text-center space-y-3 max-w-sm">
          <p className="text-lg font-bold">Couldn't load your house</p>
          <p className="text-sm text-slate-400">{(error as Error).message}</p>
          <div className="flex gap-2 justify-center">
            <Button variant="secondary" onClick={() => refetch()}>Retry</Button>
            <Button variant="ghost" onClick={signOut}>Sign out</Button>
          </div>
        </div>
      </FullScreen>
    )
  }
  if (!data) {
    return (
      <FullScreen>
        <div className="text-center space-y-3 max-w-sm">
          <div className="text-5xl">🏚️</div>
          <p className="text-lg font-bold">You're not in a house yet</p>
          <p className="text-sm text-slate-400">Ask an admin to add your account from the Admin panel.</p>
          <Button variant="secondary" onClick={signOut}>Sign out</Button>
        </div>
      </FullScreen>
    )
  }
  return <Outlet />
}

function FullScreen({ children }: { children: ReactNode }) {
  return <div className="min-h-dvh flex items-center justify-center p-6">{children}</div>
}

function NotConfigured() {
  return (
    <FullScreen>
      <div className="max-w-md space-y-3">
        <h1 className="text-2xl font-extrabold">ChoreWars isn't connected yet</h1>
        <p className="text-slate-300">
          Copy <code className="text-emerald-300">.env.example</code> to <code className="text-emerald-300">.env</code> and fill in your Supabase URL and anon key, then restart the dev server.
        </p>
        <p className="text-slate-400 text-sm">See README.md for the full setup.</p>
      </div>
    </FullScreen>
  )
}

export default function App() {
  if (!supabaseConfigured) return <NotConfigured />
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <CelebrationSafeProviders>
          <BrowserRouter>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route element={<RequireAuth />}>
                <Route element={<AppShell />}>
                  <Route index element={<HomePage />} />
                  <Route path="areas" element={<AreasPage />} />
                  <Route path="areas/:id" element={<AreaDetailPage />} />
                  <Route path="history" element={<HistoryPage />} />
                  <Route path="league" element={<LeaderboardPage />} />
                  <Route path="profile" element={<ProfilePage />} />
                  <Route path="profile/:id" element={<ProfilePage />} />
                  <Route path="admin" element={<AdminPage />} />
                </Route>
              </Route>
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </BrowserRouter>
        </CelebrationSafeProviders>
      </AuthProvider>
    </QueryClientProvider>
  )
}
