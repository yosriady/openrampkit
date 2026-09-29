import type { ScopedKV } from '@openrampkit/adapter'
import type {
  Destination,
  Direction,
  LegQuote,
  LegStep,
  Pathway,
  PlanResult,
  Quote,
  SessionStatus,
  Step,
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
}

export type StoredQuote = {
  quote: Quote
  pathway: Pathway
  deliverTo: Array<{ address: string } | undefined>
}

export type SessionRecord = {
  id: string
  secretHash: string
  version: number
  userId: string
  direction: Direction
  destination: Destination
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
  active?: { quoteId: string; pathway: Pathway; legs: ActiveLeg[]; index: number }
  step: Step
  /** start-URL tokens -> provider URL */
  startUrls: Record<string, { url: string; exp: number; keepReferrer?: boolean }>
  notified: string[]
}

export interface SessionStore {
  get(id: string): Promise<SessionRecord | null>
  /** Optimistic lock: fails when the stored version is not `expectedVersion` */
  put(rec: SessionRecord, expectedVersion?: number): Promise<void>
  kv: {
    get<T = unknown>(key: string): Promise<T | undefined>
    put(key: string, value: unknown, ttlSec?: number): Promise<void>
  }
}

export class VersionConflictError extends Error {}

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
    },
  }
}

/** Minimal shape of a Cloudflare Workers KV namespace. */
export type KVNamespaceLike = {
  get(key: string, type: 'text'): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
}

/**
 * Store on Cloudflare Workers KV. KV is eventually consistent, so the version check is best effort.
 * Use a Durable Object or Redis/Postgres store for production traffic.
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
  }
}

export function scopedKV(store: SessionStore, prefix: string): ScopedKV {
  return {
    get: (key) => store.kv.get(`${prefix}:${key}`),
    put: (key, value, ttl) => store.kv.put(`${prefix}:${key}`, value, ttl),
  }
}
