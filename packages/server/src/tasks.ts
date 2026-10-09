// Background work, run by `openramp.sweep()` (for example from a cron trigger or `POST /tasks/sweep`):
// retry webhooks, refresh open payments, expire old sessions.
//
// Both lists are store queues (see queue.ts): one entry per session id, with atomic push, claim and ack.
// A claim takes the entries that are due longest, so every session gets its turn (round robin), and it
// holds a lease, so a second sweep at the same time skips those entries. Webhooks are still
// at-least-once (a lease can end during a slow run): the app must dedupe by event id.

import { isLegTerminal, isTerminal, OrkException, orkError } from '@openrampkit/core'
import { DEFAULT_LATE_GRACE_HOURS, DEFAULT_LATE_POLL_MINUTES } from './config.js'
import { refreshActive, refreshAttempts } from './legs.js'
import { notify } from './notify.js'
import { flushOutbox, saveSession } from './outbox.js'
import { putVersioned } from './runtime.js'
import { claimToken, GRACE_QUEUE, OPEN_QUEUE, OUTBOX_QUEUE, queueOf, trackOpenSession } from './queue.js'
import type { Runtime } from './runtime.js'
import { pruneIndex } from './admin.js'
import type { SessionRecord } from './store.js'

const LAST_SWEEP_KEY = 'sweep:last-run'

/** How long a sweep holds the entries it claimed. Longer than one sweep run. */
const LEASE_MS = 10 * 60_000

export type SweepResult = {
  webhooks: { retried: number; delivered: number; dropped: number; pending: number }
  sessions: { checked: number; changed: number; expired: number; open: number; grace: number }
}

const graceMs = (rt: Runtime) => Math.max(0, rt.config.latePayments?.graceHours ?? DEFAULT_LATE_GRACE_HOURS) * 60 * 60_000
const gracePollMs = (rt: Runtime) => Math.max(1, rt.config.latePayments?.pollMinutes ?? DEFAULT_LATE_POLL_MINUTES) * 60_000

/** True when an expired session has a payment that can still arrive and that the sweep can poll. */
function canArriveLate(rt: Runtime, rec: SessionRecord): boolean {
  const leg = rec.active?.legs[rec.active.index]
  if (!leg?.ref || !leg.step || isLegTerminal(leg.step.status)) return false
  return !!rt.adapters.get(leg.adapterId)?.status
}

type LegacyOutboxEntry = { id: string; type: string; sessionId?: string; body: string; attempts: number; nextAt: number }

/**
 * Earlier versions kept the outbox and the open-session list as JSON arrays in the KV space (`outbox`,
 * `open-sessions`). Move what is left of them to the queues, so nothing in flight is lost on upgrade.
 */
async function migrateLegacyLists(rt: Runtime): Promise<void> {
  const q = queueOf(rt.store)
  const open = await rt.store.kv.get<string[]>('open-sessions')
  if (open?.length) {
    for (const id of open) await q.push(OPEN_QUEUE, id, Date.now())
    await rt.store.kv.put('open-sessions', null, 60)
  }
  const outbox = await rt.store.kv.get<string[]>('outbox')
  if (!outbox?.length) return
  const kept: string[] = []
  for (const eid of outbox) {
    const e = await rt.store.kv.get<LegacyOutboxEntry>(`outbox:${eid}`)
    let moved = !e?.sessionId
    for (let attempt = 0; !moved && attempt < 3; attempt++) {
      const rec = await rt.store.get(e!.sessionId!)
      if (!rec) {
        rt.log.warn('old outbox entry for a session that is not in the store; dropped', { id: e!.id, sessionId: e!.sessionId })
        moved = true
        break
      }
      if (!rec.outbox?.some((x) => x.id === e!.id)) {
        ;(rec.outbox ??= []).push({ id: e!.id, type: e!.type, body: e!.body, attempts: e!.attempts, firstAt: Date.now(), nextAt: e!.nextAt })
      }
      await q.push(OUTBOX_QUEUE, rec.id, e!.nextAt)
      try {
        await putVersioned(rt, rec)
        moved = true
      } catch (err) {
        if (!(err instanceof OrkException && err.status === 409)) throw err
      }
    }
    if (moved) await rt.store.kv.put(`outbox:${eid}`, null, 60)
    else kept.push(eid)
  }
  await rt.store.kv.put('outbox', kept.length ? kept : null, kept.length ? 60 * 60 * 24 * 14 : 60)
}

export async function sweep(rt: Runtime, opts: { limit?: number } = {}): Promise<SweepResult> {
  const limit = opts.limit ?? 50
  const started = Date.now()
  // Sweep lag: the time since the previous run started. It grows when the scheduler stops.
  if (rt.config.telemetry) {
    const previous = await rt.store.kv.get<number>(LAST_SWEEP_KEY)
    if (typeof previous === 'number') rt.metric('sweep.lag_ms', started - previous, {})
    await rt.store.kv.put(LAST_SWEEP_KEY, started, 7 * 24 * 60 * 60)
  }
  await migrateLegacyLists(rt)
  const now = Date.now()
  const q = queueOf(rt.store)
  const token = claimToken()
  const result: SweepResult = { webhooks: { retried: 0, delivered: 0, dropped: 0, pending: 0 }, sessions: { checked: 0, changed: 0, expired: 0, open: 0, grace: 0 } }

  // 1. Webhook outbox: session ids with events to deliver
  for (const sid of await q.claim(OUTBOX_QUEUE, { now, limit, leaseMs: LEASE_MS, token })) {
    let next: number | undefined
    try {
      next = await flushOutbox(rt, sid, now, result.webhooks)
    } catch (e) {
      rt.log.warn('sweep: webhook retry failed', { sessionId: sid, error: String(e) })
      continue // the lease ends and a later sweep tries again
    }
    if (next === undefined) await q.ack(OUTBOX_QUEUE, sid, token)
    else await q.push(OUTBOX_QUEUE, sid, next)
  }
  result.webhooks.pending = await q.size(OUTBOX_QUEUE)
  rt.metric('outbox.depth', result.webhooks.pending, {})

  // 2. Open sessions: expire, or refresh the payment (and earlier attempts that still wait)
  for (const id of await q.claim(OPEN_QUEUE, { now, limit, leaseMs: LEASE_MS, token })) {
    const rec = await rt.store.get(id)
    if (!rec || isTerminal(rec.step.state)) {
      await q.ack(OPEN_QUEUE, id, token)
      continue
    }
    result.sessions.checked++
    let saved = true
    try {
      // Expire when nothing started, or when the payment still waits for the user past the deadline.
      const waitingForUser = rec.active?.legs[rec.active.index]?.step?.status === 'awaiting_user'
      if (Date.now() > rec.expiresAt && (!rec.active || waitingForUser)) {
        expire(rec)
        await notify(rt, rec, 'session.expired')
        // The payment may still arrive (a bank transfer, a deposit address): poll it at a slower rate.
        const late = graceMs(rt) > 0 && canArriveLate(rt, rec)
        if (late) await q.push(GRACE_QUEUE, id, Date.now() + gracePollMs(rt))
        await saveSession(rt, rec)
        result.sessions.expired++
      } else if ((await refreshActive(rt, rec, true)) || (await refreshAttempts(rt, rec))) {
        await saveSession(rt, rec)
        result.sessions.changed++
      }
    } catch (e) {
      saved = false
      rt.log.warn('sweep: session check failed', { id, error: String(e) })
    }
    // Back of the line: a later push time means a later turn. Keep the session when its save failed.
    // (An expired session with a payment that can still arrive is on the grace list now.)
    if (saved && isTerminal(rec.step.state)) await q.ack(OPEN_QUEUE, id, token)
    else await q.push(OPEN_QUEUE, id, Date.now())
  }
  result.sessions.open = await q.size(OPEN_QUEUE)
  rt.metric('open_sessions.depth', result.sessions.open, {})

  // 3. Grace list: expired sessions whose payment can still arrive (`latePayments`)
  for (const id of await q.claim(GRACE_QUEUE, { now, limit, leaseMs: LEASE_MS, token })) {
    const rec = await rt.store.get(id)
    const ended = !rec || rec.step.state !== 'EXPIRED' || !!rec.resolution || !!rec.reversal || Date.now() > rec.expiresAt + graceMs(rt) || !canArriveLate(rt, rec)
    if (ended) {
      await q.ack(GRACE_QUEUE, id, token)
      continue
    }
    result.sessions.grace++
    try {
      if (await refreshActive(rt, rec, true, { late: true })) {
        await saveSession(rt, rec)
        result.sessions.changed++
      }
    } catch (e) {
      rt.log.warn('sweep: late payment check failed', { id, error: String(e) })
    }
    if (rec.step.state === 'EXPIRED') {
      await q.push(GRACE_QUEUE, id, Date.now() + gracePollMs(rt))
      continue
    }
    // The payment arrived: the session completed, or goes on (the next leg), so the open list polls it.
    if (!isTerminal(rec.step.state)) await trackOpenSession(rt, id)
    await q.ack(GRACE_QUEUE, id, token)
  }
  try {
    await pruneIndex(rt)
  } catch (e) {
    rt.log.warn('sweep: admin index cleanup failed', { error: String(e) })
  }
  rt.metric('sweep.duration_ms', Date.now() - started, {})
  return result
}

export function expire(rec: SessionRecord): void {
  rec.status = 'expired'
  rec.step = { sessionId: rec.id, state: 'EXPIRED', transitions: [], error: orkError('SESSION_EXPIRED') }
}
