import { describe, expect, it, vi } from 'vitest'
import { claimOnce } from '@openrampkit/adapter'
import { cloudflareKvStore, memoryStore, scopedKV } from './store.js'
import type { KVNamespaceLike } from './store.js'

describe('kv.putIfAbsent and claimOnce on the built-in stores', () => {
  it('memory store: writes only when the key has no live value', async () => {
    vi.useFakeTimers({ now: Date.now() })
    try {
      const store = memoryStore()
      expect(await store.kv.putIfAbsent!('k', 'a', 10)).toBe(true)
      expect(await store.kv.putIfAbsent!('k', 'b', 10)).toBe(false)
      expect(await store.kv.get('k')).toBe('a')
      vi.setSystemTime(Date.now() + 11_000)
      // The old value expired, so the key is free again.
      expect(await store.kv.putIfAbsent!('k', 'b', 10)).toBe(true)
      expect(await store.kv.get('k')).toBe('b')
    } finally {
      vi.useRealTimers()
    }
  })

  it('scopedKV keeps the prefix and passes putIfAbsent through', async () => {
    const store = memoryStore()
    const shared = scopedKV(store, 'a:relay')
    expect(shared.putIfAbsent).toBeTypeOf('function')
    expect(await claimOnce(shared, 'txused:base:0xabc', 'sess_1:ref', 60)).toBe(true)
    expect(await store.kv.get('a:relay:txused:base:0xabc')).toBe('sess_1:ref')
  })

  it('memory store: two claims that race, exactly one wins', async () => {
    for (let round = 0; round < 20; round++) {
      const shared = scopedKV(memoryStore(), 'a:x')
      const results = await Promise.all([claimOnce(shared, 'dep:1', 'a', 60), claimOnce(shared, 'dep:1', 'b', 60)])
      expect(results.filter(Boolean)).toHaveLength(1)
    }
  })

  it('memory store: many claims that race, exactly one wins, and it is the stored owner', async () => {
    const store = memoryStore()
    const shared = scopedKV(store, 'a:x')
    const owners = Array.from({ length: 10 }, (_, i) => `o${i}`)
    const results = await Promise.all(owners.map((o) => claimOnce(shared, 'k', o, 60)))
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(await store.kv.get('a:x:k')).toBe(owners[results.indexOf(true)])
  })

  it('Workers KV store has no putIfAbsent: claimOnce falls back to write, then read back', async () => {
    const data = new Map<string, string>()
    const ns: KVNamespaceLike = {
      get: async (k) => data.get(k) ?? null,
      put: async (k, v) => void data.set(k, v),
    }
    const store = cloudflareKvStore(ns)
    expect(store.kv.putIfAbsent).toBeUndefined()
    const shared = scopedKV(store, 'a:x')
    expect(shared.putIfAbsent).toBeUndefined()
    expect(await claimOnce(shared, 'k', 'a', 60)).toBe(true)
    expect(await claimOnce(shared, 'k', 'b', 60)).toBe(false)
    expect(data.get('k:a:x:k')).toBe('"a"')
  })
})
