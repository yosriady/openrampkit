import { createEvent } from '@openrampkit/core'
import { publicSession } from './runtime.js'
import { deliver, enqueue } from './tasks.js'
import type { Runtime } from './runtime.js'
import type { SessionRecord } from './store.js'

/**
 * Send one signed webhook to the app. Each (type, extra) pair is queued at most once per session.
 * Delivery failures never throw: a webhook problem must not break the user's flow.
 */
export async function notify(rt: Runtime, rec: SessionRecord, type: string, extra?: Record<string, unknown>): Promise<void> {
  if (!rt.config.webhooks) return
  const key = `${type}:${JSON.stringify(extra ?? {})}`
  if (rec.notified.includes(key)) return
  rec.notified.push(key)
  const event = createEvent(type, { session: publicSession(rec), userId: rec.userId, metadata: rec.metadata ?? {}, ...extra }, { sessionId: rec.id, livemode: rec.livemode })
  const body = JSON.stringify(event)
  // A failed delivery goes to the outbox; `sweep()` retries it with backoff.
  if (!(await deliver(rt, event.id, body))) await enqueue(rt, { id: event.id, type, sessionId: rec.id, body, attempts: 1 })
}
