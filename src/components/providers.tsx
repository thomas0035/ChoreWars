import type { ReactNode } from 'react'
import { ToastProvider } from './ui'
import { CelebrationProvider } from './Celebration'

export { Button, PageLoading, Spinner } from './ui'

/** Toasts + celebration overlays, in the order the hooks expect. */
export function CelebrationSafeProviders({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <CelebrationProvider>{children}</CelebrationProvider>
    </ToastProvider>
  )
}
