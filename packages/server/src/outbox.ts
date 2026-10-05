// The transactional webhook outbox. `notify()` adds events to `rec.outbox`; `saveSession()` writes them
// in the same versioned put as the change, then delivers them (a best-effort kick). A session id with
// events left goes on the outbox queue, and `sweep()` retries them with backoff for about 24 hours.
// After that, an event stays in the record as a dead letter, and `webhooks.replay(sessionId)` sends it again.

import { OrkException } from '@openrampkit/core'
import { signWebhook } from './crypto.js'
import { OUTBOX_QUEUE, queueOf } from './queue.js'
import { putVersioned, withTimeout } from './runtime.js'
import { addTimeline } from './timeline.js'
import type { Runtime } from './runtime.js'
import type { OutboxEvent, SessionRecord } from './store.js'

export const RETRY_BASE_MS = 30_000
export const RETRY_MAX_MS = 2 * 60 * 60_000
export const RETRY_WINDOW_HOURS = 24

export function backoff(attempts: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_MS)
}

/** POST one signed webhook. Returns true on a 2xx answer. */
export async function deliver(rt: Runtime, id: string, body: string): Promise<boolean> {
  const hook = rt.config.webhooks
  if (!hook) return true
  const ts = Math.floor(Date.now() / 1000)
  try {
    const res = await withTimeout(
      rt.fetch(hook.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'openramp-id': id,
          'openramp-timestamp': String(ts),
          'openramp-signature': await signWebhook(hook.secret, id, ts, body),
        },
        body,
      }),
      rt.config.timeouts?.webhook ?? 4000,
    )
    if (!res.ok) {
      rt.log.warn('webhook delivery failed', { status: res.status, id })
      rt.metric('webhook.delivery_failed', 1, { status: String(res.status) })
    }
    return res.ok
  } catch (e) {
    rt.log.warn('webhook delivery error', { error: String(e), id })
    rt.metric('webhook.delivery_failed', 1, { status: 'error' })
    return false
  }
}

const isLive = (e: OutboxEvent) => e.deadAt === undefined
const isConflict = (e: unknown) => e instanceof OrkException && e.status === 409

/** The earliest next attempt of the live events, or undefined when none is left. */
export function nextDue(rec: SessionRecord): number | undefined {
  const live = (rec.outbox ?? []).filter(isLive)
  return live.length ? Math.min(...live.map((e) => e.nextAt)) : undefined
}

/**
 * Record delivery results (event id -> delivered) in `rec.outbox`. A delivered event leaves the outbox.
 * A failed one waits with backoff, or becomes a dead letter past the retry window or `maxAttempts`.
 * Returns the events that became dead letters.
 */
export function applyOutcomes(rt: Runtime, rec: SessionRecord, outcomes: Map<string, boolean>, now: number): OutboxEvent[] {
  const max = rt.config.webhooks?.maxAttempts
  const windowMs = (rt.config.webhooks?.retryHours ?? RETRY_WINDOW_HOURS) * 60 * 60_000
  const dead: OutboxEvent[] = []
  const next = (rec.outbox ?? []).flatMap((e): OutboxEvent[] => {
    const ok = outcomes.get(e.id)
    if (ok === undefined || !isLive(e)) return [e]
    if (ok) return []
    const attempts = e.attempts + 1
    if ((max !== undefined && attempts >= max) || now - e.firstAt >= windowMs) {
      const d = { ...e, attempts, deadAt: now }
      dead.push(d)
      addTimeline(rec, 'webhook.dead_letter', { event: e.id, eventType: e.type, attempts })
      return [d]
    }
    return [{ ...e, attempts, nextAt: now + backoff(attempts) }]
  })
  if (next.length) rec.outbox = next
  else delete rec.outbox
  return dead
}

function logDead(rt: Runtime, rec: SessionRecord, dead: OutboxEvent[]): void {
  for (const e of dead) {
    rt.log.error('webhook moved to dead letter after retries', { id: e.id, type: e.type, sessionId: rec.id, attempts: e.attempts })
    rt.metric('webhook.dead_letter', 1, { type: e.type })
  }
}

async function deliverAll(rt: Runtime, events: OutboxEvent[]): Promise<Map<string, boolean>> {
  const outcomes = new Map<string, boolean>()
  for (const e of events) outcomes.set(e.id, await deliver(rt, e.id, e.body))
  return outcomes
}

/**
 * Save the session with an optimistic version check (or as a new record with `create`), then deliver
 * the events it added. The session id goes on the outbox queue before the write, so an event is never
 * left without a retry, also when the process stops after the write.
 */
export async function saveSession(rt: Runtime, rec: SessionRecord, opts: { create?: boolean } = {}): Promise<void> {
  const fresh = (rec.outbox ?? []).filter((e) => e.attempts === 0 && isLive(e))
  if (fresh.length) await queueOf(rt.store).push(OUTBOX_QUEUE, rec.id, Date.now() + RETRY_BASE_MS)
  if (opts.create) await rt.store.put(rec)
  else await putVersioned(rt, rec)
  if (!fresh.length) return
  // Best-effort kick after the commit. A failure here only means that the sweep delivers the event later.
  const dead = applyOutcomes(rt, rec, await deliverAll(rt, fresh), Date.now())
  try {
    await putVersioned(rt, rec)
    logDead(rt, rec, dead)
  } catch (e) {
    if (!isConflict(e)) rt.log.warn('could not record webhook delivery; the sweep sends it again', { sessionId: rec.id, error: String(e) })
  }
}

export type OutboxStats = { retried: number; delivered: number; dropped: number }

/**
 * Sweep step for one session: deliver its due events and record the results. Returns the next due
 * time, or undefined when no live event is left.
 */
export async function flushOutbox(rt: Runtime, sessionId: string, now: number, stats: OutboxStats): Promise<number | undefined> {
  let rec = await rt.store.get(sessionId)
  if (!rec?.outbox?.length) return undefined
  const due = rec.outbox.filter((e) => isLive(e) && e.nextAt <= now)
  if (!due.length) return nextDue(rec)
  const outcomes = await deliverAll(rt, due)
  stats.retried += outcomes.size
  stats.delivered += [...outcomes.values()].filter(Boolean).length
  for (let attempt = 0; attempt < 5; attempt++) {
    const dead = applyOutcomes(rt, rec, outcomes, now)
    try {
      await putVersioned(rt, rec)
      stats.dropped += dead.length
      logDead(rt, rec, dead)
      return nextDue(rec)
    } catch (e) {
      if (!isConflict(e)) throw e
      rec = await rt.store.get(sessionId)
      if (!rec) return undefined
    }
  }
  // The session kept changing. Try again soon; a repeat delivery has the same event id.
  return now + RETRY_BASE_MS
}

/** Send the dead letters of one session again, with a new retry window. Returns how many. */
export async function replayDeadLetters(rt: Runtime, sessionId: string): Promise<number> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const rec = await rt.store.get(sessionId)
    const dead = (rec?.outbox ?? []).filter((e) => !isLive(e))
    if (!rec || !dead.length) return 0
    const now = Date.now()
    rec.outbox = rec.outbox!.map(({ deadAt, ...e }) => (deadAt === undefined ? e : { ...e, attempts: 0, firstAt: now, nextAt: now }))
    addTimeline(rec, 'webhook.replayed', { count: dead.length })
    try {
      await saveSession(rt, rec)
      return dead.length
    } catch (e) {
      if (!isConflict(e)) throw e
    }
  }
  return 0
}
