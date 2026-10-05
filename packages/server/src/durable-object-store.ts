// Session store on Cloudflare Durable Objects: strongly consistent and built into Workers (no extra service).
//
// One Durable Object per key (`s:<sessionId>` for sessions, `k:<key>` for everything else), and one per
// queue (`q:<queue>`, one storage key per entry). A Durable Object handles one request at a time, so the
// version check and the write, and each queue operation, are atomic. Values with a TTL are checked on
// read and deleted by an alarm.
//
// This file has no `cloudflare:*` imports: the class uses the plain `fetch` protocol of Durable Objects,
// so the server package still builds for Node, Bun and Deno.
//
// Setup (wrangler.toml):
//   [[durable_objects.bindings]]
//   name = "OPENRAMP_STORE"
//   class_name = "OpenRampStore"
//   [[migrations]]
//   tag = "v1"
//   new_sqlite_classes = ["OpenRampStore"]
// Worker:
//   export { OpenRampStore } from '@openrampkit/server'
//   createOpenRamp({ store: durableObjectStore(env.OPENRAMP_STORE), ... })

import { queueOps, VersionConflictError } from './store.js'
import type { SessionRecord, SessionStore, StoreQueue } from './store.js'

type Stored = { value: string; exp?: number }

/** The parts of `DurableObjectState` the class uses */
export type DurableObjectStateLike = {
  storage: {
    get<T = unknown>(key: string): Promise<T | undefined>
    put(key: string, value: unknown): Promise<void>
    deleteAll(): Promise<void>
    setAlarm(scheduledTime: number): Promise<void>
    /** Needed for queues. A real Durable Object storage has it. */
    list?<T = unknown>(opts: { prefix: string }): Promise<Map<string, T>>
    /** Needed for queues. A real Durable Object storage has it. */
    delete?(key: string): Promise<unknown>
  }
}

/** The parts of a `DurableObjectNamespace` binding the store uses */
export type DurableObjectNamespaceLike = {
  idFromName(name: string): unknown
  get(id: never): { fetch(input: string, init?: RequestInit): Promise<Response> }
}

type QueueEntry = { dueAt: number; token?: string }

type Op =
  | { op: 'get' }
  | { op: 'put'; value: string; ttlSec?: number; expectedVersion?: number }
  | { op: 'qpush'; id: string; dueAt: number }
  | { op: 'qclaim'; now: number; limit: number; leaseMs: number; token: string }
  | { op: 'qack'; id: string; token: string }
  | { op: 'qsize' }
  | { op: 'qrange'; max: number | null; limit: number }

/** The Durable Object class. Export it from your Worker entry and bind it as `OPENRAMP_STORE`. */
export class OpenRampStore {
  constructor(private readonly state: DurableObjectStateLike, _env?: unknown) {}

  async fetch(req: Request): Promise<Response> {
    const op = (await req.json()) as Op
    if (op.op.startsWith('q')) return Response.json(await this.queue(op))
    const now = Date.now()
    const cur = await this.state.storage.get<Stored>('v')
    const live = cur && (!cur.exp || cur.exp > now) ? cur : undefined
    if (op.op === 'get') return Response.json({ value: live?.value ?? null })
    if (op.op !== 'put') return Response.json({ ok: false })
    if (op.expectedVersion !== undefined && live) {
      const version = (JSON.parse(live.value) as { version?: number }).version
      if (version !== op.expectedVersion) return Response.json({ ok: false })
    }
    const exp = op.ttlSec ? now + op.ttlSec * 1000 : undefined
    await this.state.storage.put('v', { value: op.value, ...(exp ? { exp } : {}) } satisfies Stored)
    if (exp) await this.state.storage.setAlarm(exp)
    return Response.json({ ok: true })
  }

  /** Queue operations. Entries are stored as `e:<id>`. */
  private async queue(op: Op): Promise<unknown> {
    const st = this.state.storage
    if (!st.list || !st.delete) throw new Error('OpenRampStore: storage.list and storage.delete are needed for queues')
    const key = (id: string) => `e:${id}`
    const entries = async () => [...(await st.list!<QueueEntry>({ prefix: 'e:' })).entries()].map(([k, e]): [string, QueueEntry] => [k.slice(2), e])
    switch (op.op) {
      case 'qpush':
        await st.put(key(op.id), queueOps.push(await st.get<QueueEntry>(key(op.id)), op.dueAt))
        return { ok: true }
      case 'qclaim': {
        const ids = queueOps.due(await entries(), op.now, op.limit)
        for (const id of ids) await st.put(key(id), { dueAt: op.now + op.leaseMs, token: op.token } satisfies QueueEntry)
        return { ids }
      }
      case 'qack': {
        if ((await st.get<QueueEntry>(key(op.id)))?.token !== op.token) return { ok: false }
        await st.delete(key(op.id))
        return { ok: true }
      }
      case 'qsize':
        return { size: (await entries()).length }
      case 'qrange':
        return { items: queueOps.range(await entries(), op.max ?? Infinity, op.limit) }
      default:
        return { ok: false }
    }
  }

  /** TTL cleanup */
  async alarm(): Promise<void> {
    const cur = await this.state.storage.get<Stored>('v')
    if (cur?.exp && cur.exp <= Date.now()) await this.state.storage.deleteAll()
  }
}

/** Session store backed by the `OpenRampStore` Durable Object. Production-ready on Cloudflare Workers. */
export function durableObjectStore(ns: DurableObjectNamespaceLike, opts: { sessionTtlSec?: number } = {}): SessionStore {
  const sessionTtl = opts.sessionTtlSec ?? 60 * 60 * 24 * 7
  const call = async <T>(name: string, op: Op): Promise<T> => {
    const stub = ns.get(ns.idFromName(name) as never)
    const res = await stub.fetch('https://openramp-store/', { method: 'POST', body: JSON.stringify(op) })
    if (!res.ok) throw new Error(`OpenRampStore ${res.status}`)
    return (await res.json()) as T
  }
  return {
    async get(id) {
      const { value } = await call<{ value: string | null }>(`s:${id}`, { op: 'get' })
      return value ? (JSON.parse(value) as SessionRecord) : null
    },
    async put(rec, expectedVersion) {
      const { ok } = await call<{ ok: boolean }>(`s:${rec.id}`, {
        op: 'put',
        value: JSON.stringify(rec),
        ttlSec: sessionTtl,
        ...(expectedVersion !== undefined ? { expectedVersion } : {}),
      })
      if (!ok) throw new VersionConflictError(`Session ${rec.id} changed`)
    },
    kv: {
      async get(key) {
        const { value } = await call<{ value: string | null }>(`k:${key}`, { op: 'get' })
        return value ? JSON.parse(value) : undefined
      },
      async put(key, value, ttlSec) {
        await call(`k:${key}`, { op: 'put', value: JSON.stringify(value), ...(ttlSec ? { ttlSec } : {}) })
      },
    },
    queue: {
      async push(name, id, dueAt) {
        await call(`q:${name}`, { op: 'qpush', id, dueAt })
      },
      async claim(name, opts) {
        return (await call<{ ids: string[] }>(`q:${name}`, { op: 'qclaim', ...opts })).ids
      },
      async ack(name, id, token) {
        return (await call<{ ok: boolean }>(`q:${name}`, { op: 'qack', id, token })).ok
      },
      async size(name) {
        return (await call<{ size: number }>(`q:${name}`, { op: 'qsize' })).size
      },
      async range(name, { max, limit }) {
        // JSON has no Infinity: a missing `max` means no upper bound.
        return (await call<{ items: Array<{ id: string; dueAt: number }> }>(`q:${name}`, { op: 'qrange', max: Number.isFinite(max) ? max : null, limit })).items
      },
    } satisfies StoreQueue,
  }
}
