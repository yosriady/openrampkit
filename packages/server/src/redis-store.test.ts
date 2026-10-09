import { describe, expect, it } from 'vitest'
import { KV_PUT_IF_ABSENT_SCRIPT, fromNodeRedis, fromNodeRedisV4, redisStore } from './redis-store.js'
import type { RedisLike } from './redis-store.js'
import { VersionConflictError } from './store.js'

/** In-memory fake that runs the CAS script's logic (Lua is not available in tests). */
function fakeRedis(opts: { autoParse?: boolean } = {}): RedisLike & { data: Map<string, string>; ex: Map<string, number | undefined> } {
  const data = new Map<string, string>()
  const ex = new Map<string, number | undefined>()
  return {
    data,
    ex,
    async get(k) {
      const v = data.get(k)
      if (v === undefined) return null
      return opts.autoParse ? JSON.parse(v) : v
    },
    async set(k, v, o) {
      data.set(k, v)
      ex.set(k, o?.ex)
      return 'OK'
    },
    async eval(script, keys, args) {
      if (script === KV_PUT_IF_ABSENT_SCRIPT) {
        // SET NX, with EX when the TTL is above 0
        if (data.has(keys[0]!)) return 0
        data.set(keys[0]!, args[0]!)
        ex.set(keys[0]!, Number(args[1]) > 0 ? Number(args[1]) : undefined)
        return 1
      }
      const [key] = keys
      const [expected, json, ttl] = args
      const cur = data.get(key!)
      if (expected !== '' && cur && String(JSON.parse(cur).version) !== expected) return 0
      data.set(key!, json!)
      ex.set(key!, Number(ttl))
      return 1
    },
  }
}

describe('redisStore', () => {
  it('stores sessions with an atomic version check and TTL', async () => {
    const r = fakeRedis()
    const store = redisStore(r, { prefix: 't:', sessionTtlSec: 100 })
    expect(await store.get('a')).toBeNull()
    await store.put({ id: 'a', version: 1 } as never)
    expect(r.ex.get('t:s:a')).toBe(100)
    await store.put({ id: 'a', version: 2 } as never, 1)
    await expect(store.put({ id: 'a', version: 3 } as never, 1)).rejects.toBeInstanceOf(VersionConflictError)
    expect((await store.get('a'))!.version).toBe(2)
  })

  it('kv with TTL, and works with clients that auto-parse JSON (Upstash)', async () => {
    for (const autoParse of [false, true]) {
      const r = fakeRedis({ autoParse })
      const store = redisStore(r)
      await store.kv.put('x', { n: 1 }, 1.5)
      expect(r.ex.get('openramp:k:x')).toBe(2)
      expect(await store.kv.get('x')).toEqual({ n: 1 })
      expect(await store.kv.get('missing')).toBeUndefined()
      await store.kv.put('y', 'v')
      expect(r.ex.get('openramp:k:y')).toBeUndefined()
    }
  })

  it('kv.putIfAbsent: SET NX with EX, one atomic script call', async () => {
    const r = fakeRedis()
    const store = redisStore(r)
    expect(await store.kv.putIfAbsent!('used', 'a', 1.5)).toBe(true)
    expect(r.ex.get('openramp:k:used')).toBe(2)
    expect(await store.kv.putIfAbsent!('used', 'b', 60)).toBe(false)
    expect(await store.kv.get('used')).toBe('a')
    expect(KV_PUT_IF_ABSENT_SCRIPT).toContain("'NX', 'EX'")
  })

  it('fromNodeRedis maps ioredis-style calls', async () => {
    const calls: unknown[][] = []
    const client = {
      get: async (k: string) => (calls.push(['get', k]), null),
      set: async (...a: Array<string | number>) => (calls.push(['set', ...a]), 'OK'),
      eval: async (...a: Array<string | number>) => (calls.push(['eval', ...a]), 1),
    }
    const r = fromNodeRedis(client)
    await r.get('k')
    await r.set('k', 'v', { ex: 5 })
    await r.set('k2', 'v')
    await r.eval('S', ['k'], ['1', '{}', '9'])
    expect(calls).toEqual([['get', 'k'], ['set', 'k', 'v', 'EX', 5], ['set', 'k2', 'v'], ['eval', 'S', 1, 'k', '1', '{}', '9']])
  })

  it('fromNodeRedisV4 maps node-redis v4 calls', async () => {
    const calls: unknown[][] = []
    const client = {
      get: async (k: string) => (calls.push(['get', k]), null),
      set: async (k: string, v: string, o?: { EX?: number }) => (calls.push(['set', k, v, o]), 'OK'),
      eval: async (sc: string, o: { keys: string[]; arguments: string[] }) => (calls.push(['eval', sc, o]), 1),
    }
    const r = fromNodeRedisV4(client)
    await r.get('k')
    await r.set('k', 'v', { ex: 5 })
    await r.set('k2', 'v')
    await r.eval('S', ['k'], ['1'])
    expect(calls).toEqual([['get', 'k'], ['set', 'k', 'v', { EX: 5 }], ['set', 'k2', 'v', undefined], ['eval', 'S', { keys: ['k'], arguments: ['1'] }]])
  })
})
