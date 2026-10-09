// Work queues for the sweep: the webhook outbox (session ids with events to deliver) and the open-session
// list (session ids to poll or expire). Built-in stores give an atomic `store.queue`. A custom store
// without one gets `recordQueue`: each queue is one record, changed only through the version check of
// `store.put`, so a concurrent add makes the other write retry instead of losing an entry.

import { randomHex } from './crypto.js'
import { queueOps, VersionConflictError } from './store.js'
import type { SessionRecord, SessionStore, StoreQueue } from './store.js'
import type { Runtime } from './runtime.js'

export const OUTBOX_QUEUE = 'outbox'
export const OPEN_QUEUE = 'open-sessions'
/** Expired sessions whose payment may still arrive: polled at a slower rate (`latePayments`) */
export const GRACE_QUEUE = 'grace-sessions'

const fallbacks = new WeakMap<SessionStore, StoreQueue>()

export function queueOf(store: SessionStore): StoreQueue {
  if (store.queue) return store.queue
  let q = fallbacks.get(store)
  if (!q) fallbacks.set(store, (q = recordQueue(store)))
  return q
}

/** A new claim token for one sweep run */
export const claimToken = () => randomHex(8)

/** Put a session on the open-session list, so the sweep polls and expires it. */
export async function trackOpenSession(rt: Runtime, id: string): Promise<void> {
  await queueOf(rt.store).push(OPEN_QUEUE, id, Date.now())
}

type QueueEntry = { dueAt: number; token?: string }
type QueueRecord = { id: string; version: number; writer: string; entries: Record<string, QueueEntry> }

const MAX_RETRIES = 100

/**
 * Fallback queue for a custom store with no `queue`: one record per queue (id `__queue:{name}`), saved
 * with `put(record, expectedVersion)`. It is safe when `put` has a real version check. The first write
 * of a queue has no version to check, so the writer reads the record back and tries again when another
 * writer won.
 */
export function recordQueue(store: SessionStore): StoreQueue {
  const rid = (name: string) => `__queue:${name}`
  const load = async (name: string) => (await store.get(rid(name))) as unknown as QueueRecord | null

  async function update<T>(name: string, change: (entries: Record<string, QueueEntry>) => T): Promise<T> {
    for (let i = 0; i < MAX_RETRIES; i++) {
      const cur = await load(name)
      const entries = { ...(cur?.entries ?? {}) }
      const out = change(entries)
      const writer = randomHex(8)
      const next: QueueRecord = { id: rid(name), version: (cur?.version ?? 0) + 1, writer, entries }
      try {
        await store.put(next as unknown as SessionRecord, cur ? cur.version : undefined)
      } catch (e) {
        if (!(e instanceof VersionConflictError)) throw e
        // Random back-off so that writers at the same time do not keep colliding. Microtask turns only,
        // so it also works under fake timers.
        for (let n = Math.floor(Math.random() * 4 * (i + 1)); n > 0; n--) await null
        continue
      }
      if (cur || (await load(name))?.writer === writer) return out
    }
    throw new Error(`OpenRamp: queue ${name} changed too often; try again`)
  }

  return {
    push: (name, id, dueAt) =>
      update(name, (m) => {
        m[id] = queueOps.push(m[id], dueAt)
      }),
    claim: (name, { now, limit, leaseMs, token }) =>
      update(name, (m) => {
        const ids = queueOps.due(Object.entries(m), now, limit)
        for (const id of ids) m[id] = { dueAt: now + leaseMs, token }
        return ids
      }),
    ack: (name, id, token) =>
      update(name, (m) => {
        if (m[id]?.token !== token) return false
        delete m[id]
        return true
      }),
    size: async (name) => Object.keys((await load(name))?.entries ?? {}).length,
    range: async (name, { max, limit }) => queueOps.range(Object.entries((await load(name))?.entries ?? {}), max, limit),
  }
}
