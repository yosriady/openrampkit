// The store queue (outbox and open-session list) on every built-in store and on the fallback for
// custom stores: no lost push during a claim, round robin, leases, and claim-checked ack.
import { describe, expect, it } from 'vitest'
import { OpenRampStore, durableObjectStore } from './durable-object-store.js'
import type { DurableObjectNamespaceLike } from './durable-object-store.js'
import { QUEUE_ACK_SCRIPT, QUEUE_CLAIM_SCRIPT, QUEUE_PUSH_SCRIPT, QUEUE_RANGE_SCRIPT, QUEUE_SIZE_SCRIPT, redisStore } from './redis-store.js'
import type { RedisLike } from './redis-store.js'
import { recordQueue } from './queue.js'
import { cloudflareKvStore, memoryStore } from './store.js'
import type { KVNamespaceLike, SessionStore, StoreQueue } from './store.js'

/** A Durable Object namespace in memory: one object per name, one request at a time per object. */
function fakeNamespace(): DurableObjectNamespaceLike {
  const objects = new Map<string, { obj: OpenRampStore; queue: Promise<unknown> }>()
  return {
    idFromName: (name) => name,
    get: (id) => {
      const name = id as unknown as string
      let o = objects.get(name)
      if (!o) {
        const data = new Map<string, unknown>()
        o = {
          queue: Promise.resolve(),
          obj: new OpenRampStore({
            storage: {
              get: async <T,>(k: string) => data.get(k) as T | undefined,
              put: async (k, v) => void data.set(k, v),
              deleteAll: async () => data.clear(),
              setAlarm: async () => {},
              list: async <T,>({ prefix }: { prefix: string }) => new Map([...data].filter(([k]) => k.startsWith(prefix))) as Map<string, T>,
              delete: async (k: string) => data.delete(k),
            },
          }),
        }
        objects.set(name, o)
      }
      const target = o
      return { fetch: (url, init) => (target.queue = target.queue.then(() => target.obj.fetch(new Request(url, init)))) as Promise<Response> }
    },
  }
}

/**
 * Redis in memory. The session CAS script and the queue scripts run as JavaScript with the same logic as
 * the Lua, and each `eval` runs with no `await` inside, so it is atomic like a Lua script in Redis.
 */
function fakeRedis(): RedisLike {
  const data = new Map<string, string>()
  const zsets = new Map<string, Map<string, number>>()
  const hashes = new Map<string, Map<string, string>>()
  const z = (k: string) => zsets.get(k) ?? zsets.set(k, new Map()).get(k)!
  const h = (k: string) => hashes.get(k) ?? hashes.set(k, new Map()).get(k)!
  return {
    async get(k) {
      return data.get(k) ?? null
    },
    async set(k, v) {
      data.set(k, v)
      return 'OK'
    },
    async eval(script, keys, args) {
      const [k1, k2] = keys as [string, string]
      if (script === QUEUE_PUSH_SCRIPT) {
        const [id, due] = args as [string, string]
        const cur = z(k1).get(id)
        let d = Number(due)
        if (cur !== undefined && !h(k2).has(id) && cur < d) d = cur
        z(k1).set(id, d)
        h(k2).delete(id)
        return 1
      }
      if (script === QUEUE_CLAIM_SCRIPT) {
        const [now, limit, until, token] = args as [string, string, string, string]
        const ids = [...z(k1)].filter(([, s]) => s <= Number(now)).sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1)).slice(0, Number(limit)).map(([id]) => id)
        for (const id of ids) {
          z(k1).set(id, Number(until))
          h(k2).set(id, token)
        }
        return ids
      }
      if (script === QUEUE_ACK_SCRIPT) {
        const [id, token] = args as [string, string]
        if (h(k2).get(id) !== token) return 0
        z(k1).delete(id)
        h(k2).delete(id)
        return 1
      }
      if (script === QUEUE_SIZE_SCRIPT) return z(k1).size
      if (script === QUEUE_RANGE_SCRIPT) {
        // ZREVRANGEBYSCORE max -inf WITHSCORES LIMIT 0 n: score high to low, then member high to low
        const [max, limit] = args as [string, string]
        const top = max === '+inf' ? Infinity : Number(max)
        return [...z(k1)]
          .filter(([, sc]) => sc <= top)
          .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1))
          .slice(0, Number(limit))
          .flatMap(([id, sc]) => [id, String(sc)])
      }
      // session CAS
      const [expected, json] = args as [string, string]
      const cur = data.get(k1)
      if (expected !== '' && cur && String(JSON.parse(cur).version) !== expected) return 0
      data.set(k1, json)
      return 1
    },
  }
}

/** Workers KV in memory, with `list` (and key metadata) and `delete`. */
function fakeKv(): KVNamespaceLike {
  const data = new Map<string, { v: string; metadata?: unknown }>()
  return {
    async get(k) {
      return data.get(k)?.v ?? null
    },
    async put(k, v, o) {
      data.set(k, { v, ...(o?.metadata ? { metadata: o.metadata } : {}) })
    },
    async list({ prefix }) {
      return { keys: [...data].filter(([k]) => k.startsWith(prefix)).map(([name, e]) => ({ name, metadata: e.metadata })), list_complete: true }
    },
    async delete(k) {
      data.delete(k)
    },
  }
}

/** A custom store with a real version check and no `queue`: it uses the record fallback. */
function customStore(): SessionStore {
  const { queue: _q, ...rest } = memoryStore()
  return rest
}

// `atomicClaim`: two sweeps at the same time never claim one id. Workers KV has no atomic update, so
// there a double claim can happen (a repeat delivery has the same event id); a push is still never lost.
const stores: Array<[string, () => StoreQueue, boolean]> = [
  ['memory', () => memoryStore().queue!, true],
  ['Durable Objects', () => durableObjectStore(fakeNamespace()).queue!, true],
  ['Redis', () => redisStore(fakeRedis()).queue!, true],
  ['Workers KV', () => cloudflareKvStore(fakeKv()).queue!, false],
  ['custom store (record fallback)', () => recordQueue(customStore()), true],
]

describe.each(stores)('store queue: %s', (_name, make, atomicClaim) => {
  it('claims due ids, earliest first, up to the limit, and holds them with a lease', async () => {
    const q = make()
    await q.push('w', 'b', 200)
    await q.push('w', 'a', 100)
    await q.push('w', 'later', 10_000)
    expect(await q.claim('w', { now: 1000, limit: 1, leaseMs: 500, token: 't1' })).toEqual(['a'])
    // the lease: a second sweep at the same time does not get 'a'
    expect(await q.claim('w', { now: 1000, limit: 10, leaseMs: 500, token: 't2' })).toEqual(['b'])
    expect(await q.claim('w', { now: 1001, limit: 10, leaseMs: 500, token: 't3' })).toEqual([])
    // after the lease ends, the id is due again
    expect(await q.claim('w', { now: 1600, limit: 10, leaseMs: 500, token: 't4' })).toEqual(['a', 'b'])
    expect(await q.size('w')).toBe(3)
  })

  it('a push during a claim is never lost: ack with the old claim token fails', async () => {
    const q = make()
    await q.push('w', 's1', 0)
    expect(await q.claim('w', { now: 10, limit: 10, leaseMs: 1000, token: 'sweep' })).toEqual(['s1'])
    // a new event for s1 while the sweep works on it
    await q.push('w', 's1', 20)
    // and a new id
    await q.push('w', 's2', 20)
    expect(await q.ack('w', 's1', 'sweep')).toBe(false)
    expect(await q.size('w')).toBe(2)
    expect(await q.claim('w', { now: 30, limit: 10, leaseMs: 1000, token: 'next' })).toEqual(['s1', 's2'])
    expect(await q.ack('w', 's1', 'next')).toBe(true)
    expect(await q.ack('w', 's1', 'next')).toBe(false)
    expect(await q.size('w')).toBe(1)
  })

  it('a push keeps the earlier due time of an unclaimed id, and the sweep can move a claimed id later', async () => {
    const q = make()
    await q.push('w', 'x', 100)
    await q.push('w', 'x', 900)
    expect(await q.claim('w', { now: 100, limit: 10, leaseMs: 50, token: 't' })).toEqual(['x'])
    await q.push('w', 'x', 5000)
    expect(await q.claim('w', { now: 4999, limit: 10, leaseMs: 50, token: 't2' })).toEqual([])
    expect(await q.claim('w', { now: 5000, limit: 10, leaseMs: 50, token: 't3' })).toEqual(['x'])
  })

  it('round robin: ids pushed back after a check wait behind the others', async () => {
    const q = make()
    for (const id of ['a', 'b', 'c', 'd', 'e']) await q.push('w', id, 1)
    const seen: string[] = []
    for (let run = 0, now = 10; run < 3; run++, now += 10) {
      const ids = await q.claim('w', { now, limit: 2, leaseMs: 1000, token: `r${run}` })
      seen.push(...ids)
      for (const id of ids) await q.push('w', id, now)
    }
    expect(seen).toEqual(['a', 'b', 'c', 'd', 'e', 'a'])
  })

  it('concurrent pushes and claims lose nothing', async () => {
    const q = make()
    const ids = Array.from({ length: 40 }, (_, i) => `id${i}`)
    const claimed: string[] = []
    await Promise.all([
      ...ids.map((id) => q.push('w', id, 0)),
      ...[0, 1, 2, 3].map(async (n) => claimed.push(...(await q.claim('w', { now: 1, limit: 5, leaseMs: 60_000, token: `c${n}` })))),
    ])
    expect(await q.size('w')).toBe(40)
    if (atomicClaim) expect(new Set(claimed).size).toBe(claimed.length)
  })

  it('range reads entries latest first, up to a max due time, and changes nothing', async () => {
    const q = make()
    await q.push('w', 'a', 100)
    await q.push('w', 'b', 300)
    await q.push('w', 'c', 200)
    await q.push('w', 'd', 300)
    expect(await q.range!('w', { max: Infinity, limit: 10 })).toEqual([
      { id: 'd', dueAt: 300 },
      { id: 'b', dueAt: 300 },
      { id: 'c', dueAt: 200 },
      { id: 'a', dueAt: 100 },
    ])
    expect(await q.range!('w', { max: 250, limit: 1 })).toEqual([{ id: 'c', dueAt: 200 }])
    expect(await q.size('w')).toBe(4)
    expect(await q.claim('w', { now: 1000, limit: 10, leaseMs: 10, token: 't' })).toHaveLength(4)
  })
})
