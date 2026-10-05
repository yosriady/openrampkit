import { createEvent } from '@openrampkit/core'
import { sha256Hex } from './crypto.js'
import { publicSession } from './runtime.js'
import type { Runtime } from './runtime.js'
import type { SessionRecord } from './store.js'

/** The event id for one (session, event key) pair. The same change always gets the same id, also on a retry. */
export async function eventId(sessionId: string, key: string): Promise<string> {
  return `evt_${(await sha256Hex(`${sessionId}|${key}`)).slice(0, 32)}`
}

/**
 * Add one signed webhook event to the session's outbox. Each (type, extra, scope) is added at most once
 * per session. The event is saved with the session (`saveSession`) and delivered only after that save
 * succeeds, so a lost save never sends an event, and a retry after a conflict makes the same event id.
 */
export async function notify(rt: Runtime, rec: SessionRecord, type: string, extra?: Record<string, unknown>, scope?: string): Promise<void> {
  if (!rt.config.webhooks) return
  const key = `${type}:${JSON.stringify(extra ?? {})}${scope ? `:${scope}` : ''}`
  if (rec.notified.includes(key)) return
  rec.notified.push(key)
  const id = await eventId(rec.id, key)
  const event = createEvent(type, { session: publicSession(rec), userId: rec.userId, metadata: rec.metadata ?? {}, ...extra }, { id, sessionId: rec.id, livemode: rec.livemode })
  const now = Date.now()
  ;(rec.outbox ??= []).push({ id, type, body: JSON.stringify(event), attempts: 0, firstAt: now, nextAt: now })
}
