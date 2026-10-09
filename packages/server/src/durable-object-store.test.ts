import { describe, expect, it, vi } from 'vitest'
import { mockAdapter } from '@openrampkit/adapter-mock'
import { OpenRampStore, durableObjectStore } from './durable-object-store.js'
import type { DurableObjectNamespaceLike } from './durable-object-store.js'
import { createOpenRamp, VersionConflictError } from './index.js'

/** In-memory stand-in for a Durable Object namespace: one OpenRampStore per name, serialized per object. */
function fakeNamespace() {
  const objects = new Map<string, { obj: OpenRampStore; data: Map<string, unknown>; alarm?: number; queue: Promise<unknown> }>()
  const ns: DurableObjectNamespaceLike & { objects: typeof objects } = {
    objects,
    idFromName: (name) => name,
    get: (id) => {
      const name = id as unknown as string
      let o = objects.get(name)
      if (!o) {
        const data = new Map<string, unknown>()
        const entry = { data, queue: Promise.resolve() as Promise<unknown> } as { obj: OpenRampStore; data: Map<string, unknown>; alarm?: number; queue: Promise<unknown> }
        entry.obj = new OpenRampStore({
          storage: {
            get: async <T,>(k: string) => data.get(k) as T | undefined,
            put: async (k, v) => void data.set(k, v),
            deleteAll: async () => data.clear(),
            setAlarm: async (t) => void (entry.alarm = t),
            list: async <T,>({ prefix }: { prefix: string }) => new Map([...data].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1))) as Map<string, T>,
            delete: async (k: string) => data.delete(k),
          },
        })
        objects.set(name, entry)
        o = entry
      }
      const target = o
      // A Durable Object runs one request at a time.
      return { fetch: (url, init) => (target.queue = target.queue.then(() => target.obj.fetch(new Request(url, init)))) as Promise<Response> }
    },
  }
  return ns
}

describe('durableObjectStore', () => {
  it('stores sessions with an atomic version check', async () => {
    const store = durableObjectStore(fakeNamespace())
    expect(await store.get('a')).toBeNull()
    await store.put({ id: 'a', version: 1 } as never)
    await store.put({ id: 'a', version: 2 } as never, 1)
    await expect(store.put({ id: 'a', version: 3 } as never, 1)).rejects.toBeInstanceOf(VersionConflictError)
    expect((await store.get('a'))!.version).toBe(2)
  })

  it('concurrent writers: exactly one wins', async () => {
    const store = durableObjectStore(fakeNamespace())
    await store.put({ id: 'r', version: 1 } as never)
    const results = await Promise.allSettled([1, 2, 3, 4].map((n) => store.put({ id: 'r', version: 2, n } as never, 1)))
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  })

  it('kv values expire by TTL (read check and alarm cleanup)', async () => {
    vi.useFakeTimers({ now: Date.now() })
    try {
      const ns = fakeNamespace()
      const store = durableObjectStore(ns)
      await store.kv.put('x', { a: 1 }, 10)
      await store.kv.put('forever', 1)
      expect(await store.kv.get('x')).toEqual({ a: 1 })
      const entry = ns.objects.get('k:x')!
      expect(entry.alarm).toBeGreaterThan(Date.now())
      vi.setSystemTime(Date.now() + 11_000)
      expect(await store.kv.get('x')).toBeUndefined()
      await entry.obj.alarm()
      expect(entry.data.size).toBe(0)
      expect(await store.kv.get('forever')).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('kv.putIfAbsent: atomic inside the object, and an expired value counts as absent', async () => {
    vi.useFakeTimers({ now: Date.now() })
    try {
      const store = durableObjectStore(fakeNamespace())
      const results = await Promise.all(['a', 'b', 'c'].map((v) => store.kv.putIfAbsent!('used', v, 10)))
      expect(results.filter(Boolean)).toHaveLength(1)
      expect(await store.kv.get('used')).toBe(['a', 'b', 'c'][results.indexOf(true)])
      vi.setSystemTime(Date.now() + 11_000)
      expect(await store.kv.putIfAbsent!('used', 'd', 10)).toBe(true)
      expect(await store.kv.get('used')).toBe('d')
    } finally {
      vi.useRealTimers()
    }
  })

  it('runs a whole deposit flow', async () => {
    const ramp = createOpenRamp({ secret: 's'.repeat(40), baseUrl: 'https://a.test/api', adapters: [mockAdapter({ settleMs: 0 })], store: durableObjectStore(fakeNamespace()), logger: { debug() {}, info() {}, warn() {}, error() {} } })
    const s = await ramp.sessions.create({ userId: 'u', country: 'ID', destination: { type: 'merchant', currency: 'IDR' } })
    const call = (p: string, body?: unknown) => ramp.handle(new Request(`https://a.test/api${p}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${s.clientSecret}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
    await call(`/sessions/${s.id}/plan`, {})
    const q = await (await call(`/sessions/${s.id}/quotes`, { method: 'qris', amount: '150000' })).json()
    const sel = await (await call(`/sessions/${s.id}/select`, { quoteId: q.quotes[0].id })).json()
    expect(sel.step.surface.kind).toBe('QR')
    await call(`/sessions/${s.id}/transitions/simulate_payment`, {})
    await ramp.sweep()
    expect((await ramp.sessions.retrieve(s.id))!.status).toBe('completed')
  })
})
