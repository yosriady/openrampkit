import { afterEach, describe, expect, it, vi } from 'vitest'
import { cachedJson, hmacSha256, parseSignatureHeader, quoteExpiresAt, statusMap, verifyTimestampedHmac } from './index.js'
import { memoryKV, recordingLog } from './testing.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('quoteExpiresAt', () => {
  it('is minutes from now by default, and uses a provider expiry inside the window', () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-09T12:00:00Z'), toFake: ['Date'] })
    expect(quoteExpiresAt()).toBe('2026-10-09T12:05:00.000Z')
    expect(quoteExpiresAt(10)).toBe('2026-10-09T12:10:00.000Z')
    expect(quoteExpiresAt(10, '2026-10-09T12:02:00Z')).toBe('2026-10-09T12:02:00.000Z')
    expect(quoteExpiresAt(10, Date.parse('2026-10-09T12:03:00Z'))).toBe('2026-10-09T12:03:00.000Z')
  })

  it('ignores a provider expiry in the past, too far away, or not a date', () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-09T12:00:00Z'), toFake: ['Date'] })
    expect(quoteExpiresAt(5, '2026-10-09T11:00:00Z')).toBe('2026-10-09T12:05:00.000Z')
    expect(quoteExpiresAt(5, '2026-10-10T12:00:00Z')).toBe('2026-10-09T12:05:00.000Z')
    expect(quoteExpiresAt(5, 'soon')).toBe('2026-10-09T12:05:00.000Z')
    expect(quoteExpiresAt(5, null)).toBe('2026-10-09T12:05:00.000Z')
  })
})

describe('statusMap', () => {
  const S = statusMap('Prov', { done: 'succeeded', pending: 'processing' } as const)
  it('maps known statuses and gives undefined for others, with one warning per value', () => {
    const log = recordingLog()
    expect(S('done', log)).toBe('succeeded')
    expect(S('SETTLED', log)).toBeUndefined()
    expect(S('SETTLED', log)).toBeUndefined()
    expect(S(undefined, log)).toBeUndefined()
    expect(S(42, log)).toBeUndefined()
    expect(log.warnings.filter((w) => w.includes('unknown provider status'))).toHaveLength(1)
    expect(S.known).toEqual(['done', 'pending'])
  })
  it('can ignore case', () => {
    const C = statusMap('Prov2', { COMPLETED: 1 }, { ignoreCase: true })
    expect(C('completed')).toBe(1)
  })
})

describe('verifyTimestampedHmac', () => {
  const secret = 'whsec_test'
  const body = '{"a":1}'
  it('parses repeated keys', () => {
    expect(parseSignatureHeader('t=1, v1=a,v1=b ,x,=y')).toEqual({ t: ['1'], v1: ['a', 'b'] })
  })
  it('accepts a valid t=,v1= header and refuses a wrong or old one', async () => {
    const t = Math.floor(Date.now() / 1000)
    const sig = await hmacSha256(secret, `${t}.${body}`, 'hex')
    expect(await verifyTimestampedHmac({ secret, rawBody: body, header: `t=${t},v1=bad,v1=${sig}` })).toBe(true)
    expect(await verifyTimestampedHmac({ secret, rawBody: `${body} `, header: `t=${t},v1=${sig}` })).toBe(false)
    expect(await verifyTimestampedHmac({ secret, rawBody: body, header: `t=${t - 600},v1=${await hmacSha256(secret, `${t - 600}.${body}`)}` })).toBe(false)
    expect(await verifyTimestampedHmac({ secret: '', rawBody: body, header: `t=${t},v1=${sig}` })).toBe(false)
    expect(await verifyTimestampedHmac({ secret, rawBody: body, header: null })).toBe(false)
  })
  it('supports other keys, a separate timestamp, ISO times and base64url', async () => {
    const t = Math.floor(Date.now() / 1000)
    const s = await hmacSha256(secret, `${t}.${body}`, 'hex')
    expect(await verifyTimestampedHmac({ secret, rawBody: body, header: `t=${t},s=${s}`, signatureKey: 's' })).toBe(true)
    expect(await verifyTimestampedHmac({ secret, rawBody: body, header: s.toUpperCase(), timestamp: String(t) })).toBe(true)
    const iso = new Date().toISOString()
    const b64 = (await hmacSha256(secret, `${iso}.https://x.test/h.${body}`, 'base64')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(await verifyTimestampedHmac({ secret, rawBody: body, header: b64, timestamp: iso, encoding: 'base64url', message: (ts) => `${ts}.https://x.test/h.${body}` })).toBe(true)
    expect(await verifyTimestampedHmac({ secret, rawBody: body, header: b64, timestamp: null, encoding: 'base64url' })).toBe(false)
  })
})

describe('cachedJson', () => {
  it('loads once and keeps valid values only', async () => {
    const kv = memoryKV()
    let n = 0
    const load = async () => {
      n++
      return n === 1 ? [] : ['x']
    }
    const valid = (v: string[]) => v.length > 0
    expect(await cachedJson(kv, 'k', 60, load, { valid })).toEqual([])
    expect(await cachedJson(kv, 'k', 60, load, { valid })).toEqual(['x'])
    expect(await cachedJson(kv, 'k', 60, load, { valid })).toEqual(['x'])
    expect(n).toBe(2)
  })
})
