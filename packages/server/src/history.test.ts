// The user's history (`GET /sessions/:id/history`, option `history`): off by default, the client secret
// only, the session's own user only, newest first, at most 50, and a small view with no private data.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockAdapter } from '@openrampkit/adapter-mock'
import { USDC } from '@openrampkit/core'
import type { HistoryItem } from '@openrampkit/core'
import { createOpenRamp, memoryStore } from './index.js'
import type { OpenRampConfig, SessionStore } from './index.js'
import { sha256Hex } from './crypto.js'
import { HISTORY_LIMIT } from './history.js'

const BASE = 'https://app.test/api/openramp'
const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const BEEF = '0x000000000000000000000000000000000000beef'
const DEST = { type: 'crypto' as const, chain: 'eip155:8453', token: USDC['eip155:8453']!, address: BEEF }

function make(extra: Partial<OpenRampConfig> = {}) {
  const store = (extra.store ?? memoryStore()) as SessionStore
  const ramp = createOpenRamp({ secret: 's'.repeat(40), baseUrl: BASE, adapters: [mockAdapter({ settleMs: 0, crypto: true, bridge: true })], logger: quiet, history: true, store, ...extra })
  const call = (path: string, secret?: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    if (secret) headers.set('authorization', `Bearer ${secret}`)
    if (init.body) headers.set('content-type', 'application/json')
    return ramp.handle(new Request(`${BASE}${path}`, { ...init, headers }))
  }
  const history = async (s: { id: string; clientSecret: string }) => {
    const res = await call(`/sessions/${s.id}/history`, s.clientSecret)
    return { status: res.status, body: (await res.json()) as { items: HistoryItem[]; error?: { code: string } } }
  }
  /** A session of `userId` with a payment started (VietQR, the mock), and optionally paid */
  const paid = async (userId: string, opts: { pay?: boolean } = {}) => {
    const s = await ramp.sessions.create({ userId, country: 'VN', destination: DEST })
    const post = (path: string, body: unknown) => call(`/sessions/${s.id}/${path}`, s.clientSecret, { method: 'POST', body: JSON.stringify(body) })
    await post('plan', {})
    const q = await (await post('quotes', { method: 'vietqr', amount: '500000' })).json()
    await post('select', { quoteId: q.quotes[0].id })
    if (opts.pay) {
      await post('transitions/simulate_payment', {})
      for (let i = 0; i < 20 && (await ramp.sessions.retrieve(s.id))!.status !== 'succeeded'; i++) await call(`/sessions/${s.id}/step`, s.clientSecret)
    }
    return s
  }
  return { ramp, store, call, history, paid }
}

afterEach(() => vi.useRealTimers())

describe('GET /sessions/:id/history', () => {
  it('is off by default: 404, and no index is kept', async () => {
    const store = memoryStore()
    const t = make({ history: false, store })
    const s = await t.paid('u1')
    const r = await t.history(s)
    expect(r.status).toBe(404)
    expect(r.body.error?.code).toBe('NOT_FOUND')
    const index = `sessions-user:${(await sha256Hex('u1')).slice(0, 32)}`
    expect(await store.queue!.size(index)).toBe(0)
  })

  it('needs the client secret: no secret or a wrong one is 401, a pay link is 403', async () => {
    const t = make()
    const s = await t.paid('u1')
    expect((await t.call(`/sessions/${s.id}/history`)).status).toBe(401)
    expect((await t.call(`/sessions/${s.id}/history`, `${s.id}.wrong`)).status).toBe(401)
    const link = (await t.ramp.sessions.payLink(s.id))!
    const cred = link.url.slice(`${BASE}/pay/`.length)
    const res = await t.call(`/sessions/${s.id}/history`, cred)
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('UNAUTHORIZED')
  })

  it("lists only the session user's sessions with a payment, newest first, in a small view", async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-10T00:00:00Z'), toFake: ['Date'] })
    const t = make()
    const done = await t.paid('u1', { pay: true })
    vi.setSystemTime(Date.now() + 60_000)
    const open = await t.paid('u1')
    vi.setSystemTime(Date.now() + 60_000)
    const other = await t.paid('u2', { pay: true })
    // A session where no payment started is left out (this is also the session that asks).
    vi.setSystemTime(Date.now() + 60_000)
    const asking = await t.ramp.sessions.create({ userId: 'u1', country: 'VN', destination: DEST })

    const r = await t.history(asking)
    expect(r.status).toBe(200)
    expect(r.body.items.map((x) => x.id)).toEqual([open.id, done.id])
    const [o, d] = r.body.items
    expect(o).toMatchObject({ kind: 'session', direction: 'deposit', status: 'requires_action', createdAt: '2026-10-10T00:01:00.000Z' })
    expect(o!.tx).toBeUndefined()
    expect(d).toMatchObject({
      id: done.id,
      kind: 'session',
      direction: 'deposit',
      status: 'succeeded',
      createdAt: '2026-10-10T00:00:00.000Z',
      amount: { value: '500000', asset: { kind: 'fiat', currency: 'VND' } },
      destination: { type: 'crypto', chain: 'eip155:8453', token: DEST.token },
      tx: { chain: 'eip155:8453', hash: expect.stringMatching(/^0x[0-9a-f]{64}$/), explorerUrl: expect.stringMatching(/^https:\/\/basescan\.org\/tx\/0x/) },
    })
    // Nothing private: no secret, user id, address, provider ids or another user's session.
    const text = JSON.stringify(r.body)
    for (const bad of [done.clientSecret.split('.')[1]!, 'u1', 'u2', BEEF, other.id, 'mock', 'secretHash', 'ref']) expect(text).not.toContain(bad)
    expect(Object.keys(d!).sort()).toEqual(['amount', 'createdAt', 'destination', 'direction', 'id', 'kind', 'status', 'tx'])

    // The other user sees only their own.
    expect((await t.history(other)).body.items.map((x) => x.id)).toEqual([other.id])
  })

  it(`returns at most ${HISTORY_LIMIT} items, newest first`, async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-10T00:00:00Z'), toFake: ['Date'] })
    const t = make()
    const ids: string[] = []
    for (let i = 0; i < HISTORY_LIMIT + 3; i++) {
      vi.setSystemTime(Date.now() + 1000)
      ids.push((await t.paid('u1')).id)
    }
    const s = await t.ramp.sessions.create({ userId: 'u1', country: 'VN', destination: DEST })
    const r = await t.history(s)
    expect(r.body.items).toHaveLength(HISTORY_LIMIT)
    expect(r.body.items.map((x) => x.id)).toEqual(ids.reverse().slice(0, HISTORY_LIMIT))
  })

  it('indexes a repeated externalId once', async () => {
    const store = memoryStore()
    const t = make({ store })
    const a = await t.ramp.sessions.create({ userId: 'u1', country: 'VN', destination: DEST, externalId: 'order-1' })
    const b = await t.ramp.sessions.create({ userId: 'u1', country: 'VN', destination: DEST, externalId: 'order-1' })
    expect(b).toMatchObject({ id: a.id, existing: true })
    const index = `sessions-user:${(await sha256Hex('u1')).slice(0, 32)}`
    expect(await store.queue!.range!(index, { max: Number.MAX_SAFE_INTEGER, limit: 10 })).toEqual([{ id: a.id, dueAt: expect.any(Number) }])
  })

  it('a store queue with no range: 501 with a clear message', async () => {
    const mem = memoryStore()
    const { range: _range, ...queue } = mem.queue!
    const t = make({ store: { ...mem, queue } })
    const s = await t.paid('u1')
    const r = await t.history(s)
    expect(r.status).toBe(501)
    expect(r.body.error).toMatchObject({ code: 'INTERNAL', message: expect.stringMatching(/range/) })
  })
})
