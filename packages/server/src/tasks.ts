// Background work, run by `openramp.sweep()` (for example from a cron trigger or `POST /tasks/sweep`):
// retry failed webhooks, refresh open payments, expire old sessions.
//
// The outbox and the open-session list are small id lists in the store's KV space. KV stores are not
// atomic, so two sweeps at the same time can deliver a webhook twice. Webhooks are at-least-once anyway:
// the app must credit idempotently by event or session id.

import { isTerminal, orkError } from '@openrampkit/core'
import { signWebhook } from './crypto.js'
import { refreshActive } from './legs.js'
import { notify } from './notify.js'
import { saveSession, withTimeout } from './runtime.js'
import type { Runtime } from './runtime.js'
import type { SessionRecord } from './store.js'

const OUTBOX = 'outbox'
const OPEN = 'open-sessions'
const LIST_TTL_SEC = 60 * 60 * 24 * 14
const MAX_LIST = 5000
const RETRY_BASE_MS = 30_000
const RETRY_MAX_MS = 60 * 60_000

export type OutboxEntry = { id: string; type: string; sessionId?: string; body: string; attempts: number; nextAt: number }

export type SweepResult = {
  webhooks: { retried: number; delivered: number; dropped: number; pending: number }
  sessions: { checked: number; changed: number; expired: number; open: number }
}

async function readList(rt: Runtime, key: string): Promise<string[]> {
  return (await rt.store.kv.get<string[]>(key)) ?? []
}

async function writeList(rt: Runtime, key: string, ids: string[]): Promise<void> {
  const unique = [...new Set(ids)]
  if (unique.length > MAX_LIST) rt.log.warn(`${key} list is full; the oldest ${unique.length - MAX_LIST} ids are dropped (run the sweep more often)`)
  await rt.store.kv.put(key, unique.slice(-MAX_LIST), LIST_TTL_SEC)
}

export async function trackOpenSession(rt: Runtime, id: string): Promise<void> {
  await writeList(rt, OPEN, [...(await readList(rt, OPEN)), id])
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
    if (!res.ok) rt.log.warn('webhook delivery failed', { status: res.status, id })
    return res.ok
  } catch (e) {
    rt.log.warn('webhook delivery error', { error: String(e), id })
    return false
  }
}

/** Keep a failed delivery for retry by `sweep()`. */
export async function enqueue(rt: Runtime, entry: Omit<OutboxEntry, 'nextAt'>): Promise<void> {
  const full: OutboxEntry = { ...entry, nextAt: Date.now() + backoff(entry.attempts) }
  await rt.store.kv.put(`${OUTBOX}:${entry.id}`, full, LIST_TTL_SEC)
  await writeList(rt, OUTBOX, [...(await readList(rt, OUTBOX)), entry.id])
}

function backoff(attempts: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_MS)
}

export async function sweep(rt: Runtime, opts: { limit?: number } = {}): Promise<SweepResult> {
  const limit = opts.limit ?? 50
  const now = Date.now()
  const maxAttempts = rt.config.webhooks?.maxAttempts ?? 8
  const result: SweepResult = { webhooks: { retried: 0, delivered: 0, dropped: 0, pending: 0 }, sessions: { checked: 0, changed: 0, expired: 0, open: 0 } }

  // 1. Webhook outbox
  const keep: string[] = []
  for (const id of await readList(rt, OUTBOX)) {
    const entry = await rt.store.kv.get<OutboxEntry>(`${OUTBOX}:${id}`)
    if (!entry) continue
    if (entry.nextAt > now || result.webhooks.retried >= limit) {
      keep.push(id)
      continue
    }
    result.webhooks.retried++
    if (await deliver(rt, entry.id, entry.body)) {
      result.webhooks.delivered++
      await rt.store.kv.put(`${OUTBOX}:${id}`, null, 60)
      continue
    }
    const attempts = entry.attempts + 1
    if (attempts >= maxAttempts) {
      result.webhooks.dropped++
      rt.log.error('webhook dropped after retries', { id, type: entry.type, sessionId: entry.sessionId, attempts })
      await rt.store.kv.put(`${OUTBOX}:${id}`, null, 60)
      continue
    }
    await rt.store.kv.put(`${OUTBOX}:${id}`, { ...entry, attempts, nextAt: now + backoff(attempts) }, LIST_TTL_SEC)
    keep.push(id)
  }
  await writeList(rt, OUTBOX, keep)
  result.webhooks.pending = keep.length

  // 2. Open sessions: expire, or refresh the active payment
  const stillOpen: string[] = []
  for (const id of await readList(rt, OPEN)) {
    const rec = await rt.store.get(id)
    if (!rec || isTerminal(rec.step.state)) continue
    if (result.sessions.checked >= limit) {
      stillOpen.push(id)
      continue
    }
    result.sessions.checked++
    try {
      // Expire when nothing started, or when the payment still waits for the user past the deadline.
      const waitingForUser = rec.active?.legs[rec.active.index]?.step?.status === 'awaiting_user'
      if (Date.now() > rec.expiresAt && (!rec.active || waitingForUser)) {
        expire(rec)
        await saveSession(rt, rec)
        await notify(rt, rec, 'session.expired')
        result.sessions.expired++
        continue
      }
      if (await refreshActive(rt, rec, true)) {
        await saveSession(rt, rec)
        result.sessions.changed++
      }
    } catch (e) {
      rt.log.warn('sweep: session check failed', { id, error: String(e) })
    }
    if (!isTerminal(rec.step.state)) stillOpen.push(id)
  }
  await writeList(rt, OPEN, stillOpen)
  result.sessions.open = stillOpen.length
  return result
}

export function expire(rec: SessionRecord): void {
  rec.status = 'expired'
  rec.step = { sessionId: rec.id, state: 'EXPIRED', transitions: [], error: orkError('SESSION_EXPIRED') }
}
