import { describe, expect, it } from 'vitest'
import { claimOnce, claimWebhook, releaseWebhook, webhookBodyKey } from './index.js'
import type { ScopedKV } from './index.js'

/** Map-backed ScopedKV that records each call. `atomic` adds `putIfAbsent`. */
function kv(atomic: boolean) {
  const data = new Map<string, unknown>()
  const calls: Array<[string, string, unknown?, number?]> = []
  const shared: ScopedKV = {
    async get<T>(key: string) {
      calls.push(['get', key])
      return data.get(key) as T | undefined
    },
    async put(key, value, ttlSec) {
      calls.push(['put', key, value, ttlSec])
      data.set(key, value)
    },
    ...(atomic
      ? {
          async putIfAbsent(key: string, value: unknown, ttlSec: number) {
            calls.push(['putIfAbsent', key, value, ttlSec])
            if (data.has(key)) return false
            data.set(key, value)
            return true
          },
        }
      : {}),
  }
  return { shared, data, calls }
}

describe.each([
  ['with putIfAbsent', true],
  ['write then read back', false],
])('claimOnce (%s)', (_name, atomic) => {
  it('first claim wins and stores the owner', async () => {
    const { shared, data } = kv(atomic)
    expect(await claimOnce(shared, 'txused:base:0xabc', 'sess_1:ref', 60)).toBe(true)
    expect(data.get('txused:base:0xabc')).toBe('sess_1:ref')
  })

  it('the same owner again gets true (retries are idempotent)', async () => {
    const { shared } = kv(atomic)
    expect(await claimOnce(shared, 'k', 'a', 60)).toBe(true)
    expect(await claimOnce(shared, 'k', 'a', 60)).toBe(true)
  })

  it('another owner is refused, and the first owner keeps the key', async () => {
    const { shared, data } = kv(atomic)
    expect(await claimOnce(shared, 'k', 'a', 60)).toBe(true)
    expect(await claimOnce(shared, 'k', 'b', 60)).toBe(false)
    expect(data.get('k')).toBe('a')
  })

  it('passes the TTL to the store', async () => {
    const { shared, calls } = kv(atomic)
    await claimOnce(shared, 'k', 'a', 1234)
    const write = calls.find(([op]) => op === (atomic ? 'putIfAbsent' : 'put'))
    expect(write).toEqual([atomic ? 'putIfAbsent' : 'put', 'k', 'a', 1234])
  })
})

describe('claimOnce code paths', () => {
  it('uses putIfAbsent when the store has it, and never put', async () => {
    const { shared, calls } = kv(true)
    await claimOnce(shared, 'k', 'a', 60)
    await claimOnce(shared, 'k', 'b', 60)
    expect(calls.map(([op]) => op)).toEqual(['putIfAbsent', 'putIfAbsent', 'get'])
  })

  it('without putIfAbsent: reads, writes, then reads back', async () => {
    const { shared, calls } = kv(false)
    await claimOnce(shared, 'k', 'a', 60)
    expect(calls.map(([op]) => op)).toEqual(['get', 'put', 'get'])
  })

  it('without putIfAbsent: a rival write between the write and the read back loses the claim', async () => {
    const { shared, data } = kv(false)
    const racy: ScopedKV = {
      get: shared.get,
      async put(key, value, ttl) {
        await shared.put(key, value, ttl)
        data.set(key, 'rival') // another writer lands last
      },
    }
    expect(await claimOnce(racy, 'k', 'a', 60)).toBe(false)
  })
})

describe.each([
  ['with putIfAbsent', true],
  ['write then read back', false],
])('claimWebhook (%s)', (_name, atomic) => {
  it('the first delivery gets a token, a repeat gets none, for 7 days by default', async () => {
    const { shared, calls } = kv(atomic)
    const key = await webhookBodyKey('{"a":1}')
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    const token = await claimWebhook(shared, key)
    expect(token).toMatch(/^[0-9a-f]{24}$/)
    expect(await claimWebhook(shared, key)).toBeUndefined()
    expect(calls.find((c) => c[0] !== 'get')?.[3]).toBe(7 * 24 * 60 * 60)
  })

  it('a released key goes to the next delivery, and only the holder can release', async () => {
    const { shared } = kv(atomic)
    const token = (await claimWebhook(shared, 'k'))!
    await releaseWebhook(shared, 'k', 'not-the-token')
    expect(await claimWebhook(shared, 'k')).toBeUndefined()
    await releaseWebhook(shared, 'k', token)
    const next = await claimWebhook(shared, 'k')
    expect(next).toBeDefined()
    expect(next).not.toBe(token)
    expect(await claimWebhook(shared, 'k')).toBeUndefined()
  })
})
