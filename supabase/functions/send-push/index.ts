// send-push: delivers queued rows from public.notifications as Web Push messages.
//
// Called by Postgres (pg_net) with header x-push-secret and body { ids: uuid[] | null }.
// ids = null sweeps every undelivered row. Which rows exist, who gets them and
// retry limits are all decided in SQL (see migration 0009); this only delivers.
//
// Secrets (supabase secrets set ...): VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY,
// VAPID_SUBJECT (mailto: or https: URL), PUSH_WEBHOOK_SECRET.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by the platform.

import { createClient } from 'npm:@supabase/supabase-js@2'
import webpush from 'npm:web-push@3.6.7'

interface NotificationRow {
  id: string
  user_id: string
  kind: string
  cleaning_area_id: string | null
  title: string
  body: string
  url: string
}

interface SubscriptionRow {
  id: string
  endpoint: string
  p256dh: string
  auth: string
}

const env = (k: string) => {
  const v = Deno.env.get(k)
  if (!v) throw new Error(`missing secret ${k}`)
  return v
}

webpush.setVapidDetails(env('VAPID_SUBJECT'), env('VAPID_PUBLIC_KEY'), env('VAPID_PRIVATE_KEY'))
const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })
const webhookSecret = env('PUSH_WEBHOOK_SECRET')

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })
  if (req.headers.get('x-push-secret') !== webhookSecret) return new Response('forbidden', { status: 403 })

  const { ids } = (await req.json().catch(() => ({}))) as { ids?: string[] | null }

  const claimed = await db.rpc('claim_notifications', { p_ids: ids && ids.length ? ids : null })
  if (claimed.error) return Response.json({ error: claimed.error.message }, { status: 500 })
  const rows = (claimed.data ?? []) as NotificationRow[]
  if (rows.length === 0) return Response.json({ sent: 0 })

  const userIds = [...new Set(rows.map((r) => r.user_id))]
  const subs = await db.from('push_subscriptions').select('id, user_id, endpoint, p256dh, auth').in('user_id', userIds)
  if (subs.error) return Response.json({ error: subs.error.message }, { status: 500 })
  const byUser = new Map<string, SubscriptionRow[]>()
  for (const s of (subs.data ?? []) as (SubscriptionRow & { user_id: string })[]) {
    byUser.set(s.user_id, [...(byUser.get(s.user_id) ?? []), s])
  }

  const gone = new Set<string>()
  let sent = 0

  await Promise.all(rows.map(async (n) => {
    const targets = byUser.get(n.user_id) ?? []
    const payload = JSON.stringify({
      title: n.title,
      body: n.body,
      url: n.url,
      // Same area + kind replaces the previous notification instead of stacking.
      tag: n.cleaning_area_id ? `${n.kind}:${n.cleaning_area_id}` : n.kind,
    })
    const errors: string[] = []
    let delivered = false

    await Promise.all(targets.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload,
          { TTL: 60 * 60 * 12, urgency: 'normal' },
        )
        delivered = true
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode
        // 404/410: the browser dropped this subscription for good.
        if (status === 404 || status === 410) gone.add(s.id)
        else errors.push(`${status ?? ''} ${(e as Error).message}`.trim())
      }
    }))

    // No live devices left counts as done: nothing to retry.
    const ok = delivered || errors.length === 0
    if (ok) sent++
    await db.rpc('finish_notification', { p_id: n.id, p_ok: ok, p_error: errors.join('; ') || null })
  }))

  if (gone.size) await db.from('push_subscriptions').delete().in('id', [...gone])

  return Response.json({ sent, claimed: rows.length, removed: gone.size })
})
