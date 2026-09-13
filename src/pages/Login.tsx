import { useEffect, useState, type FormEvent } from 'react'
import { Navigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { ArrowLeft } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { fetchLoginDirectory } from '@/lib/api'
import { friendlyError } from '@/lib/errors'
import { Avatar, Button, Field, Spinner } from '@/components/ui'

export function LoginPage() {
  const { user, loading, signIn } = useAuth()
  const dir = useQuery({ queryKey: ['login-directory'], queryFn: fetchLoginDirectory, staleTime: 60_000 })
  const [picked, setPicked] = useState<{ name: string; email: string; avatar_url: string | null } | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [manual, setManual] = useState(false)

  useEffect(() => {
    try {
      const last = localStorage.getItem('chorewars:lastEmail')
      if (last) setEmail(last)
    } catch { /* ignore */ }
  }, [])

  if (loading) return <div className="min-h-dvh flex items-center justify-center"><Spinner /></div>
  if (user) return <Navigate to="/" replace />

  const showDirectory = !manual && !picked && (dir.data?.length ?? 0) > 0
  const activeEmail = picked?.email ?? email

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await signIn(activeEmail.trim(), password)
      try { localStorage.setItem('chorewars:lastEmail', activeEmail.trim()) } catch { /* ignore */ }
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-dvh flex flex-col safe-top safe-bottom">
      <div className="flex-1 mx-auto w-full max-w-md px-6 pt-16 pb-10 flex flex-col">
        <motion.div initial={{ y: 10, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="mb-10">
          <div className="text-5xl mb-4">🏠</div>
          <h1 className="text-3xl font-extrabold tracking-tight">ChoreWars</h1>
          <p className="text-slate-400 mt-1">Who's cleaning? Who's winning? Let's find out.</p>
        </motion.div>

        {dir.isLoading && <div className="py-10 flex justify-center"><Spinner /></div>}

        {showDirectory && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <p className="text-xs font-bold tracking-[0.18em] uppercase text-slate-400 mb-3 px-1">Tap your name</p>
            <div className="grid grid-cols-3 gap-3">
              {dir.data!.map((m) => (
                <motion.button
                  key={m.email}
                  whileTap={{ scale: 0.96 }}
                  onClick={() => { setPicked(m); setError(null) }}
                  className="rounded-3xl bg-card border border-line p-4 flex flex-col items-center gap-2 hover:bg-card-2 transition-colors"
                >
                  <Avatar name={m.name} url={m.avatar_url} size="lg" />
                  <span className="font-semibold text-sm truncate max-w-full">{m.name}</span>
                </motion.button>
              ))}
            </div>
            <button onClick={() => setManual(true)} className="mt-6 text-sm text-slate-500 hover:text-slate-300 w-full text-center">
              Sign in with email instead
            </button>
          </motion.div>
        )}

        {!dir.isLoading && !showDirectory && (
          <motion.form initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} onSubmit={submit} className="space-y-4">
            {picked ? (
              <div className="flex items-center gap-3 rounded-3xl bg-card border border-line p-3">
                <button type="button" onClick={() => { setPicked(null); setPassword(''); setError(null) }} className="p-2 rounded-full text-slate-400 hover:bg-white/5" aria-label="Back">
                  <ArrowLeft className="h-5 w-5" />
                </button>
                <Avatar name={picked.name} url={picked.avatar_url} />
                <div>
                  <div className="font-semibold">{picked.name}</div>
                  <div className="text-xs text-slate-500">{picked.email}</div>
                </div>
              </div>
            ) : (
              <Field label="Email">
                <input type="email" autoComplete="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@house.local" required />
              </Field>
            )}
            <Field label="Password">
              <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required autoFocus />
            </Field>
            {error && <p className="text-sm text-rose-300 px-1">{error}</p>}
            <Button type="submit" size="lg" className="w-full" loading={busy}>Sign in</Button>
            {manual && (dir.data?.length ?? 0) > 0 && (
              <button type="button" onClick={() => setManual(false)} className="text-sm text-slate-500 hover:text-slate-300 w-full text-center">
                Back to names
              </button>
            )}
          </motion.form>
        )}
      </div>
    </div>
  )
}
