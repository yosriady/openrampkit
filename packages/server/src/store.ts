import type { ScopedKV } from '@openrampkit/adapter'
import type {
  AllowedTargets,
  Destination,
  Direction,
  LegQuote,
  LegStep,
  Pathway,
  PlanResult,
  Quote,
  SessionStatus,
  Step,
  WithdrawSource,
} from '@openrampkit/core'

export type ActiveLeg = {
  adapterId: string
  legId: string
  quote: LegQuote
  deliverTo?: { address: string }
  ref?: string
  step?: LegStep
  started: boolean
  lastCheckedAt?: number
  /** Withdraw with app custody: idempotency keys of WALLET_TX steps already sent by the treasury */
  treasurySent?: string[]
}

export type StoredQuote = {
  quote: Quote
  pathway: Pathway
  deliverTo: Array<{ address: string } | undefined>
}

/** The payment in progress: the selected quote's pathway and its legs */
export type ActivePayment = {
  /** Attempt number in this session: 0 for the first payment, then 1, 2 and so on */
  n?: number
  quoteId: string
  pathway: Pathway
  legs: ActiveLeg[]
  index: number
}

/** An earlier payment attempt, kept after a restart. Its provider refs stay indexed, so a late event still finds it. */
export type PaymentAttempt = ActivePayment & { endedAt: number }

/**
 * One webhook event in the session's outbox. The server writes it in the same versioned `put` as the
 * change that caused it, and delivers it only after that write succeeds.
 */
export type OutboxEvent = {
  /** Deterministic event id (`evt_...`): the same change always gets the same id */
  id: string
  type: string
  body: string
  /** Delivery attempts so far. 0 means not tried yet. */
  attempts: number
  /** When the event was made (ms) */
  firstAt: number
  /** Earliest time of the next attempt (ms) */
  nextAt: number
  /** Set when the retries stopped. The event stays here as a dead letter (see `webhooks.replay`). */
  deadAt?: number
}

export type SessionRecord = {
  id: string
  secretHash: string
  version: number
  userId: string
  direction: Direction
  /** Deposit: set at creation. Withdraw: the target the user picked, absent until then. */
  destination?: Destination
  /** Withdraw only */
  source?: WithdrawSource
  /** Withdraw only */
  allowedTargets?: AllowedTargets
  /** Withdraw only: the app set the target at creation with `lockTarget`. `/target` refuses changes. */
  targetLocked?: boolean
  /** Ids of pay links that no longer work (see `sessions.revokePayLink`) */
  revokedPayLinks?: string[]
  country?: string
  region?: string
  email?: string
  ip?: string
  /** Set only when the app gave a locale; adapters get 'en' by default */
  locale?: string
  amountBounds?: { min?: string; max?: string; currency: string }
  allowedMethods?: string[]
  metadata?: Record<string, string>
  livemode: boolean
  status: SessionStatus
  createdAt: number
  expiresAt: number
  walletConnected?: boolean
  walletAddress?: string
  plan?: PlanResult
  quotes: Record<string, StoredQuote>
  active?: ActivePayment
  /** Earlier attempts (after `restart`), oldest first */
  attempts?: PaymentAttempt[]
  step: Step
  /** start-URL tokens -> provider URL */
  startUrls: Record<string, { url: string; exp: number; keepReferrer?: boolean }>
  notified: string[]
  /** Webhook events not delivered yet, and dead letters */
  outbox?: OutboxEvent[]
  /** Time of the last write (ms). Records from earlier versions do not have it. */
  updatedAt?: number
  /** What happened to the session, oldest first, for operators (see `admin.get`). At most 100 entries. */
  timeline?: TimelineEntry[]
  /** Set when an operator forced a final state with `admin.resolve`. Provider events then change the legs only. */
  resolution?: Resolution
  /** Provider event ids applied to this session (`adapterId:ref:eventId`), newest last. At most 50. */
  providerEvents?: string[]
}

/** One entry of the session timeline */
export type TimelineEntry = { at: number; type: string; detail?: Record<string, unknown> }

/** An operator decision on a session (`admin.resolve`) */
export type Resolution = { state: 'COMPLETED' | 'FAILED' | 'REFUNDED' | 'EXPIRED'; note: string; at: number; previous: string }

/**
 * A work queue in the store. The server uses it for the webhook outbox and the open-session list.
 * Each entry is an id with a due time. Every operation must be atomic, so that a `push` that runs at
 * the same time as a `claim` or an `ack` is never lost.
 */
export interface StoreQueue {
  /**
   * Add `id`, due at `dueAt`. When `id` is already there and not claimed, keep the earlier due time.
   * When it is claimed, set `dueAt` and remove the claim.
   */
  push(queue: string, id: string, dueAt: number): Promise<void>
  /**
   * Claim up to `limit` ids that are due at `now`, earliest due time first. Each claimed id gets the due
   * time `now + leaseMs` (so other sweeps skip it until the lease ends) and the claim `token`.
   */
  claim(queue: string, opts: { now: number; limit: number; leaseMs: number; token: string }): Promise<string[]>
  /** Remove `id` only when it still has the claim `token`, that is, no `push` came after the claim. */
  ack(queue: string, id: string, token: string): Promise<boolean>
  /** Number of ids in the queue */
  size(queue: string): Promise<number>
  /**
   * Optional: read up to `limit` entries with a due time of at most `max`, latest due time first (ties:
   * id from high to low). It changes nothing. The admin index needs it (see `admin.list`). All built-in
   * stores have it.
   */
  range?(queue: string, opts: { max: number; limit: number }): Promise<QueueItem[]>
}

/** An entry that `StoreQueue.range` returns */
export type QueueItem = { id: string; dueAt: number }

export interface SessionStore {
  get(id: string): Promise<SessionRecord | null>
  /** Optimistic lock: fails when the stored version is not `expectedVersion` */
  put(rec: SessionRecord, expectedVersion?: number): Promise<void>
  kv: {
    get<T = unknown>(key: string): Promise<T | undefined>
    put(key: string, value: unknown, ttlSec?: number): Promise<void>
    /**
     * Optional: write only when the key has no live value, as one atomic step. Returns true when it
     * wrote. Adapters get it through `ScopedKV.putIfAbsent` (see `claimOnce`). The memory, Redis and
     * Durable Object stores have it. Workers KV has no atomic operation, so its store leaves it out.
     */
    putIfAbsent?(key: string, value: unknown, ttlSec: number): Promise<boolean>
  }
  /**
   * Optional atomic work queue. All built-in stores have one. A store without it gets a fallback that
   * keeps each queue in one record, written with the version check of `put`.
   */
  queue?: StoreQueue
}

export class VersionConflictError extends Error {}

type QueueEntry = { dueAt: number; token?: string }

/** The queue rules on one entry map. Shared by the memory store and the Durable Object. */
export const queueOps = {
  push(cur: QueueEntry | undefined, dueAt: number): QueueEntry {
    if (!cur || cur.token !== undefined) return { dueAt }
    return { dueAt: Math.min(cur.dueAt, dueAt) }
  },
  due(entries: Iterable<[string, QueueEntry]>, now: number, limit: number): string[] {
    return [...entries]
      .filter(([, e]) => e.dueAt <= now)
      .sort((a, b) => a[1].dueAt - b[1].dueAt || (a[0] < b[0] ? -1 : 1))
      .slice(0, Math.max(0, limit))
      .map(([id]) => id)
  },
  range(entries: Iterable<[string, QueueEntry]>, max: number, limit: number): QueueItem[] {
    return [...entries]
      .filter(([, e]) => e.dueAt <= max)
      .sort((a, b) => b[1].dueAt - a[1].dueAt || (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
      .slice(0, Math.max(0, limit))
      .map(([id, e]) => ({ id, dueAt: e.dueAt }))
  },
}

/** In-memory queue. Each call runs to the end with no `await`, so it is atomic in one process. */
export function memoryQueue(): StoreQueue {
  const queues = new Map<string, Map<string, QueueEntry>>()
  const q = (name: string) => {
    let m = queues.get(name)
    if (!m) queues.set(name, (m = new Map()))
    return m
  }
  return {
    async push(name, id, dueAt) {
      const m = q(name)
      m.set(id, queueOps.push(m.get(id), dueAt))
    },
    async claim(name, { now, limit, leaseMs, token }) {
      const m = q(name)
      const ids = queueOps.due(m, now, limit)
      for (const id of ids) m.set(id, { dueAt: now + leaseMs, token })
      return ids
    },
    async ack(name, id, token) {
      const m = q(name)
      if (m.get(id)?.token !== token) return false
      m.delete(id)
      return true
    },
    async size(name) {
      return q(name).size
    },
    async range(name, { max, limit }) {
      return queueOps.range(q(name), max, limit)
    },
  }
}

/** In-memory store. For local development and tests only. */
export function memoryStore(): SessionStore {
  const sessions = new Map<string, string>()
  const kv = new Map<string, { v: string; exp?: number }>()
  return {
    async get(id) {
      const s = sessions.get(id)
      return s ? (JSON.parse(s) as SessionRecord) : null
    },
    async put(rec, expectedVersion) {
      const cur = sessions.get(rec.id)
      if (expectedVersion !== undefined && cur && (JSON.parse(cur) as SessionRecord).version !== expectedVersion) {
        throw new VersionConflictError(`Session ${rec.id} changed`)
      }
      sessions.set(rec.id, JSON.stringify(rec))
    },
    kv: {
      async get(key) {
        const e = kv.get(key)
        if (!e) return undefined
        if (e.exp && e.exp < Date.now()) {
          kv.delete(key)
          return undefined
        }
        return JSON.parse(e.v)
      },
      async put(key, value, ttlSec) {
        kv.set(key, { v: JSON.stringify(value), ...(ttlSec ? { exp: Date.now() + ttlSec * 1000 } : {}) })
      },
      // No `await` between the read and the write, so this is atomic in one process.
      async putIfAbsent(key, value, ttlSec) {
        const e = kv.get(key)
        if (e && !(e.exp && e.exp < Date.now())) return false
        kv.set(key, { v: JSON.stringify(value), ...(ttlSec ? { exp: Date.now() + ttlSec * 1000 } : {}) })
        return true
      },
    },
    queue: memoryQueue(),
  }
}

/**
 * Minimal shape of a Cloudflare Workers KV namespace. A real namespace also has `list` and `delete`;
 * with them, the store keeps one key per queue entry, so a new entry is never lost.
 */
export type KVNamespaceLike = {
  get(key: string, type: 'text'): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number; metadata?: unknown }): Promise<void>
  list?(opts: { prefix: string; cursor?: string }): Promise<{ keys: Array<{ name: string; metadata?: unknown }>; list_complete: boolean; cursor?: string }>
  delete?(key: string): Promise<void>
}

/**
 * Queue on Workers KV: one key per entry (`q:{queue}:{id}`), with the entry in the key metadata.
 * A push never overwrites another id, so no add is lost. KV has no atomic update, so two sweeps at
 * the same time can claim the same id, and a new key can take up to a minute to show in `list`.
 */
function kvQueue(ns: Required<KVNamespaceLike>): StoreQueue {
  const key = (name: string, id: string) => `q:${name}:${id}`
  const read = async (name: string, id: string) => {
    const s = await ns.get(key(name, id), 'text')
    return s ? (JSON.parse(s) as QueueEntry) : undefined
  }
  const write = (name: string, id: string, e: QueueEntry) => ns.put(key(name, id), JSON.stringify(e), { metadata: e })
  const all = async (name: string) => {
    const out: Array<[string, QueueEntry]> = []
    const prefix = `q:${name}:`
    let cursor: string | undefined
    do {
      const page = await ns.list({ prefix, ...(cursor ? { cursor } : {}) })
      for (const k of page.keys) if (k.metadata) out.push([k.name.slice(prefix.length), k.metadata as QueueEntry])
      cursor = page.list_complete ? undefined : page.cursor
    } while (cursor)
    return out
  }
  return {
    async push(name, id, dueAt) {
      await write(name, id, queueOps.push(await read(name, id), dueAt))
    },
    async claim(name, { now, limit, leaseMs, token }) {
      const ids = queueOps.due(await all(name), now, limit)
      for (const id of ids) await write(name, id, { dueAt: now + leaseMs, token })
      return ids
    },
    async ack(name, id, token) {
      if ((await read(name, id))?.token !== token) return false
      await ns.delete(key(name, id))
      return true
    },
    async size(name) {
      return (await all(name)).length
    },
    async range(name, { max, limit }) {
      return queueOps.range(await all(name), max, limit)
    },
  }
}

/**
 * Store on Cloudflare Workers KV. KV is eventually consistent, so the version check is best effort.
 * On Workers, prefer `durableObjectStore` (strongly consistent, also built in) for production traffic.
 */
export function cloudflareKvStore(ns: KVNamespaceLike, opts: { sessionTtlSec?: number } = {}): SessionStore {
  const ttl = opts.sessionTtlSec ?? 60 * 60 * 24 * 7
  return {
    async get(id) {
      const s = await ns.get(`s:${id}`, 'text')
      return s ? (JSON.parse(s) as SessionRecord) : null
    },
    async put(rec, expectedVersion) {
      if (expectedVersion !== undefined) {
        const cur = await ns.get(`s:${rec.id}`, 'text')
        if (cur && (JSON.parse(cur) as SessionRecord).version !== expectedVersion) throw new VersionConflictError(`Session ${rec.id} changed`)
      }
      await ns.put(`s:${rec.id}`, JSON.stringify(rec), { expirationTtl: ttl })
    },
    kv: {
      async get(key) {
        const s = await ns.get(`k:${key}`, 'text')
        return s ? JSON.parse(s) : undefined
      },
      async put(key, value, ttlSec) {
        await ns.put(`k:${key}`, JSON.stringify(value), ttlSec ? { expirationTtl: Math.max(60, ttlSec) } : undefined)
      },
    },
    ...(ns.list && ns.delete ? { queue: kvQueue(ns as Required<KVNamespaceLike>) } : {}),
  }
}

export function scopedKV(store: SessionStore, prefix: string): ScopedKV {
  const kv = store.kv
  return {
    get: (key) => kv.get(`${prefix}:${key}`),
    put: (key, value, ttl) => kv.put(`${prefix}:${key}`, value, ttl),
    ...(kv.putIfAbsent ? { putIfAbsent: (key: string, value: unknown, ttl: number) => kv.putIfAbsent!(`${prefix}:${key}`, value, ttl) } : {}),
  }
}
