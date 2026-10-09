import { createWebhookEvent } from '@openrampkit/core'
import type { WebhookEventOf, WebhookEventType } from '@openrampkit/core'
import { sha256Hex } from './crypto.js'
import { backendSession } from './runtime.js'
import { addTimeline } from './timeline.js'
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
export async function notify(rt: Runtime, rec: SessionRecord, type: WebhookEventType, extra?: Record<string, unknown>, scope?: string): Promise<void> {
  const key = `${type}:${JSON.stringify(extra ?? {})}${scope ? `:${scope}` : ''}`
  if (rec.notified.includes(key)) return
  rec.notified.push(key)
  // The timeline keeps every event, also without webhooks.
  addTimeline(rec, type, timelineDetail(extra))
  if (!rt.config.webhooks) return
  const id = await eventId(rec.id, key)
  // The backend view of the session (with `userId` and `metadata`), then the fields of this event type.
  const object = { session: backendSession(rec), ...extra } as WebhookEventOf<typeof type>['data']['object']
  const event = createWebhookEvent(type, object, { id, sessionId: rec.id, livemode: rec.livemode })
  const now = Date.now()
  ;(rec.outbox ??= []).push({ id, type, body: JSON.stringify(event), attempts: 0, firstAt: now, nextAt: now })
}

/** The small parts of an event's extra data that the timeline keeps */
function timelineDetail(extra?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!extra) return undefined
  const out: Record<string, unknown> = {}
  for (const k of ['index', 'adapterId', 'legId', 'attempt']) if (extra[k] !== undefined) out[k] = extra[k]
  const err = extra.error as { code?: unknown } | undefined
  if (err && typeof err.code === 'string') out.error = err.code
  const res = extra.resolution as { note?: unknown } | undefined
  if (res && typeof res.note === 'string') out.note = res.note
  return out
}
