import { createEvent } from '@openrampkit/core'
import { signWebhook } from './crypto.js'
import { publicSession, withTimeout } from './runtime.js'
import type { Runtime } from './runtime.js'
import type { SessionRecord } from './store.js'

/**
 * Send one signed webhook to the app. Each (type, extra) pair is sent at most once per session.
 * Delivery failures are logged, never thrown: a webhook problem must not break the user's flow.
 */
export async function notify(rt: Runtime, rec: SessionRecord, type: string, extra?: Record<string, unknown>): Promise<void> {
  const hook = rt.config.webhooks
  if (!hook) return
  const key = `${type}:${JSON.stringify(extra ?? {})}`
  if (rec.notified.includes(key)) return
  rec.notified.push(key)
  const event = createEvent(type, { session: publicSession(rec), userId: rec.userId, metadata: rec.metadata ?? {}, ...extra }, { sessionId: rec.id, livemode: rec.livemode })
  const body = JSON.stringify(event)
  const ts = Math.floor(Date.now() / 1000)
  try {
    const res = await withTimeout(
      rt.fetch(hook.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'openramp-id': event.id,
          'openramp-timestamp': String(ts),
          'openramp-signature': await signWebhook(hook.secret, event.id, ts, body),
        },
        body,
      }),
      rt.config.timeouts?.webhook ?? 4000,
    )
    if (!res.ok) rt.log.warn('webhook delivery failed', { status: res.status, type })
  } catch (e) {
    rt.log.warn('webhook delivery error', { error: String(e), type })
  }
}
