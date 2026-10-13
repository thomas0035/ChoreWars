import { supabase } from './supabase'

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined

export type PushState =
  | 'unsupported'   // browser has no Web Push (or the app isn't installed on iOS)
  | 'unconfigured'  // VITE_VAPID_PUBLIC_KEY missing from the build
  | 'denied'        // user blocked notifications in browser settings
  | 'off'
  | 'on'

export function isIosBrowserTab(): boolean {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent)
  const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true
  return ios && !standalone
}

function supported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration()
  return reg ? reg.pushManager.getSubscription() : null
}

export async function getPushState(): Promise<PushState> {
  if (!supported()) return 'unsupported'
  if (!VAPID_PUBLIC_KEY) return 'unconfigured'
  if (Notification.permission === 'denied') return 'denied'
  if (Notification.permission !== 'granted') return 'off'
  return (await currentSubscription()) ? 'on' : 'off'
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(padded)
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

async function saveSubscription(sub: PushSubscription) {
  const json = sub.toJSON()
  const { error } = await supabase.rpc('save_push_subscription', {
    p_endpoint: sub.endpoint,
    p_p256dh: json.keys?.p256dh ?? '',
    p_auth: json.keys?.auth ?? '',
    p_user_agent: navigator.userAgent,
  })
  if (error) throw error
}

/** Must be called from a tap: browsers only show the permission prompt on a user gesture. */
export async function enablePush(): Promise<PushState> {
  if (!supported()) return 'unsupported'
  if (!VAPID_PUBLIC_KEY) return 'unconfigured'
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off'
  const reg = await navigator.serviceWorker.ready
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) }))
  await saveSubscription(sub)
  return 'on'
}

/** Turns notifications off for this device only. */
export async function disablePush(): Promise<void> {
  const sub = supported() ? await currentSubscription() : null
  if (!sub) return
  await supabase.rpc('delete_push_subscription', { p_endpoint: sub.endpoint })
  await sub.unsubscribe()
}

/** On app start: re-register this device's subscription (browsers rotate endpoints; the account may have changed). */
export async function resyncPush(): Promise<void> {
  if (!supported() || !VAPID_PUBLIC_KEY || Notification.permission !== 'granted') return
  const sub = await currentSubscription()
  if (sub) await saveSubscription(sub)
}

export async function sendTestNotification(): Promise<{ devices: number }> {
  const { data, error } = await supabase.rpc('send_test_notification')
  if (error) throw error
  return data as { devices: number }
}
