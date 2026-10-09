import type { ScopedKV } from '@openrampkit/adapter'
import type {
  AllowedTargets,
  AmountMismatch,
  Destination,
  Direction,
  LegQuote,
  LegStep,
  Pathway,
  PlanResult,
  Quote,
  SessionStatus,
  StateName,
  Step,
  WithdrawSource,
} from '@openrampkit/core'
import { isStepSub } from '@openrampkit/core'

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
  /** Set when the reported output is short of the quote beyond the tolerance, or not comparable with it */
  amountMismatch?: Omit<AmountMismatch, 'legIndex'>
  /** Set when a provider event moved the leg from `processing` back to `awaiting_user` (allowed once) */
  surfaceReopened?: boolean
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
  /** The session destination when this payment began. A withdraw target can change after a restart. */
  destination?: Destination
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
  /**
   * Schema of this record (see `SESSION_SCHEMA` and `migrateRecord`). Records written before this field
   * existed have none: they are schema 0. Not the same as `version`.
   */
  schema?: number
  /** Optimistic-lock counter: each write adds 1 (see `SessionStore.put`). Not the record schema. */
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
  /** Set when a provider refunded or reversed a leg after it succeeded. The session is then `REVERSED`. */
  reversal?: Reversal
  /** Provider event ids applied to this session (`adapterId:ref:eventId`), newest last. At most 50. */
  providerEvents?: string[]
}

/** A refund or a chargeback after a leg succeeded (see `SessionRecord.reversal`) */
export type Reversal = {
  /** When the server learnt it (ms) */
  at: number
  /** The leg that the provider took back */
  index: number
  adapterId: string
  legId: string
  /** The new leg status */
  status: 'refunded' | 'reversed'
  /** The session state before the reversal, e.g. COMPLETED */
  previous: StateName
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

/** The schema that this server writes in `SessionRecord.schema`. */
export const SESSION_SCHEMA = 1

/** True for a session record. A custom store without a `queue` also keeps queue records (`__queue:*`). */
function isSessionRecord(rec: unknown): rec is SessionRecord {
  const r = rec as Partial<SessionRecord> | null
  return !!r && typeof r === 'object' && typeof r.id === 'string' && typeof r.secretHash === 'string' && !!r.step
}

/**
 * Bring a stored session record up to `SESSION_SCHEMA`. The server runs it on every store read, so a
 * record written by an earlier version loads and works. It changes the record in place, returns it, and
 * runs again with no effect (idempotent). The next write saves the result.
 *
 * Schema 0 to 1 (records with no `schema`): `updatedAt` from `createdAt`; `ActivePayment.n` from the number
 * of earlier attempts, and `n` of each earlier attempt from its place; empty `quotes`, `startUrls`,
 * `notified` and `outbox` when absent; each step `sub` in lower case when that is in `STEP_SUBS`, else removed.
 *
 * A record with a newer schema (written by a newer server) is returned as it is. Other records (for
 * example the queue records of a custom store) are returned as they are.
 */
export function migrateRecord<T>(rec: T): T {
  if (!isSessionRecord(rec)) return rec
  const from = rec.schema ?? 0
  if (from >= SESSION_SCHEMA) return rec
  if (from < 1) {
    rec.updatedAt ??= rec.createdAt
    rec.quotes ??= {}
    rec.startUrls ??= {}
    rec.notified ??= []
    rec.outbox ??= []
    rec.attempts?.forEach((p, i) => {
      p.n ??= i
    })
    if (rec.active) rec.active.n ??= rec.attempts?.length ?? 0
    // `sub` was free text (for example 'SETTLING'); now it is the closed list `STEP_SUBS`.
    for (const step of [rec.step, ...[rec.active, ...(rec.attempts ?? [])].flatMap((p) => p?.legs.map((l) => l.step) ?? [])]) {
      if (step?.sub === undefined || isStepSub(step.sub)) continue
      const lower = String(step.sub).toLowerCase()
      if (isStepSub(lower)) step.sub = lower
      else delete step.sub
    }
  }
  rec.schema = SESSION_SCHEMA
  return rec
}

/**
 * The store that the server uses: `store`, with `migrateRecord` on every `get`. `put`, `kv` and `queue`
 * are the same as in `store`.
 */
export function migratingStore(store: SessionStore): SessionStore {
  return {
    get: async (id) => {
      const rec = await store.get(id)
      return rec ? migrateRecord(rec) : rec
    },
    put: (rec, expectedVersion) => store.put(rec, expectedVersion),
    kv: store.kv,
    ...(store.queue ? { queue: store.queue } : {}),
  }
}

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
