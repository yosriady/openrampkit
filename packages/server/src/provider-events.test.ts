// Provider events that come late, twice or in the wrong order: the leg moves only forward, and an
// event id that the session already applied is dropped. A refund or a chargeback after success
// reverses the session.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAdapter } from '@openrampkit/adapter'
import type { LegEvent } from '@openrampkit/adapter'
import { USDC } from '@openrampkit/core'
import type { LegSpec, LegStatus, LegStep } from '@openrampkit/core'
import { createOpenRamp, memoryStore } from './index.js'
import type { OpenRampConfig } from './index.js'
import { eventId } from './notify.js'

const BASE = 'https://app.test/api/openramp'
const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const DEST = { type: 'crypto' as const, chain: 'eip155:8453', token: USDC['eip155:8453']!, address: '0x000000000000000000000000000000000000beef' }
const HOOKS = { url: 'https://app.test/hooks', secret: 'w'.repeat(32) }

const STATE: Record<string, LegStep['state']> = {
  pending: 'PROCESSING',
  awaiting_user: 'PAYMENT',
  processing: 'PROCESSING',
  succeeded: 'COMPLETED',
  failed: 'FAILED',
  refunded: 'REFUNDED',
  expired: 'EXPIRED',
}

/** A card provider with webhooks and status polling. `statusOf` sets what `status` answers. */
function hookedAdapter() {
  let n = 0
  const statusOf: Record<string, Partial<LegStep> & { status: LegStatus }> = {}
  const spec: LegSpec = {
    id: 'hook', kind: 'fiat_onramp', methods: ['card'],
    from: { asset: { kind: 'fiat', currencies: '*' }, location: ['user_account'] },
    to: { asset: { kind: 'crypto', chains: { 'eip155:8453': [USDC['eip155:8453']!] } }, location: ['address'] },
    regions: { allow: ['*'], deny: [] }, eta: { min: 1, max: 2 }, surfaces: ['REDIRECT'],
  }
  const poll = [{ name: 'poll', kind: 'AWAIT' as const, poll: { intervalMs: 1000, backoff: 1, maxIntervalMs: 1000, giveUpAfterMs: 60000 } }]
  const adapter = createAdapter({
    id: 'hooked', name: 'Hooked', legs: [spec],
    async quote({ leg, amountIn }) {
      return { adapterId: 'hooked', legId: leg.legId, input: amountIn!, output: { amount: '9', asset: leg.to.asset }, fees: [], eta: { min: 1, max: 2 } }
    },
    async start() {
      const ref = `order-${++n}`
      return { state: 'PAYMENT', status: 'awaiting_user', ref, surface: { kind: 'REDIRECT', url: 'https://provider.test/pay', popup: true }, transitions: poll }
    },
    async status({ ref }) {
      const s = statusOf[ref] ?? { status: 'awaiting_user' as const }
      return { state: STATE[s.status]!, ref, transitions: s.status === 'awaiting_user' ? poll : [], ...s }
    },
    webhook: {
      async verify() {
        return true
      },
      async parse(raw) {
        return JSON.parse(raw) as LegEvent[]
      },
    },
  })
  return { adapter, statusOf }
}

/** App backend that records each delivered webhook body. */
function appBackend() {
  const sent: Array<{ id: string; type: string; data: { object: Record<string, unknown> } }> = []
  const fetchFn: typeof fetch = async (_u, init) => {
    sent.push(JSON.parse(String(init?.body)))
    return new Response('ok', { status: 200 })
  }
  return { sent, fetchFn, of: (type: string) => sent.filter((e) => e.type === type) }
}

function make(extra: Partial<OpenRampConfig> = {}) {
  const hooked = hookedAdapter()
  const app = appBackend()
  const store = memoryStore()
  const ramp = createOpenRamp({ secret: 's'.repeat(40), baseUrl: BASE, adapters: [hooked.adapter], logger: quiet, webhooks: HOOKS, fetch: app.fetchFn, store, ...extra })
  const call = (path: string, init: RequestInit & { secret?: string } = {}) => {
    const headers = new Headers(init.headers)
    if (init.secret) headers.set('authorization', `Bearer ${init.secret}`)
    if (init.body) headers.set('content-type', 'application/json')
    return ramp.handle(new Request(`${BASE}${path}`, { ...init, headers }))
  }
  const post = (path: string, secret: string, body: unknown = {}) => call(path, { method: 'POST', secret, body: JSON.stringify(body) })
  const hook = async (events: LegEvent[]) => (await call('/webhooks/hooked', { method: 'POST', body: JSON.stringify(events) })).status
  /** Create a session and start a card payment (state PAYMENT, waiting for the user). Returns the session and its order ref. */
  async function toPayment(input: { ttlMinutes?: number } = {}) {
    const s = await ramp.sessions.create({ userId: 'u', country: 'SG', destination: DEST, ...input })
    await post(`/sessions/${s.id}/plan`, s.clientSecret)
    const q = await (await post(`/sessions/${s.id}/quotes`, s.clientSecret, { method: 'card', amount: '10' })).json()
    const pub = await (await post(`/sessions/${s.id}/select`, s.clientSecret, { quoteId: q.quotes[0].id })).json()
    expect(pub.step.state).toBe('PAYMENT')
    const rec = (await store.get(s.id))!
    return { ...s, ref: rec.active!.legs[0]!.ref! }
  }
  const record = async (id: string) => (await store.get(id))!
  return { ramp, store, call, post, hook, toPayment, record, app, statusOf: hooked.statusOf }
}

afterEach(() => vi.useRealTimers())

describe('P1-1: the leg moves only forward', () => {
  it('refuses an old pending event after processing, and answers 200', async () => {
    const t = make()
    const s = await t.toPayment()
    expect(await t.hook([{ ref: s.ref, status: 'processing', txHash: '0xaa' }])).toBe(200)
    expect((await t.record(s.id)).active!.legs[0]!.step!.status).toBe('processing')

    expect(await t.hook([{ ref: s.ref, status: 'pending' }])).toBe(200)
    expect(await t.hook([{ ref: s.ref, status: 'awaiting_user' }])).toBe(200)
    const rec = await t.record(s.id)
    expect(rec.active!.legs[0]!.step!.status).toBe('processing')
    expect(rec.step.state).toBe('PROCESSING')
    expect(rec.active!.legs[0]!.step!.txHash).toBe('0xaa')
  })

  it('refuses any move away from a final leg', async () => {
    const t = make()
    const s = await t.toPayment()
    await t.hook([{ ref: s.ref, status: 'failed' }])
    expect(await t.hook([{ ref: s.ref, status: 'processing' }])).toBe(200)
    expect(await t.hook([{ ref: s.ref, status: 'succeeded' }])).toBe(200)
    const rec = await t.record(s.id)
    expect(rec.step.state).toBe('FAILED')
    expect(t.app.of('session.completed')).toHaveLength(0)
  })

  it('keeps a move forward and a repeat of the same status that is not final', async () => {
    const t = make()
    const s = await t.toPayment()
    await t.hook([{ ref: s.ref, status: 'pending' }])
    await t.hook([{ ref: s.ref, status: 'processing' }])
    await t.hook([{ ref: s.ref, status: 'processing', txHash: '0xbb' }])
    expect((await t.record(s.id)).active!.legs[0]!.step!.txHash).toBe('0xbb')
    await t.hook([{ ref: s.ref, status: 'succeeded' }])
    expect((await t.record(s.id)).step.state).toBe('COMPLETED')
    expect(t.app.of('session.completed')).toHaveLength(1)
  })

  it('allows awaiting_user with a new surface after processing only before the leg has a transaction', async () => {
    const t = make()
    const s = await t.toPayment()
    const surface = { kind: 'DEPOSIT_ADDRESS' as const, chain: 'eip155:8453', token: USDC['eip155:8453']!, address: '0x00000000000000000000000000000000000000aa' }
    await t.hook([{ ref: s.ref, status: 'processing' }])
    await t.hook([{ ref: s.ref, status: 'awaiting_user', surface }])
    expect((await t.record(s.id)).step).toMatchObject({ state: 'PAYMENT', surface: { kind: 'DEPOSIT_ADDRESS' } })
    await t.hook([{ ref: s.ref, status: 'processing', txHash: '0xaa' }])
    await t.hook([{ ref: s.ref, status: 'awaiting_user', surface }])
    expect((await t.record(s.id)).step.state).toBe('PROCESSING')
  })

  it('drops a provider event whose id the session already applied', async () => {
    const t = make()
    const s = await t.toPayment()
    await t.hook([{ ref: s.ref, status: 'processing', eventId: 'evt-1', txHash: '0xaa' }])
    // The same provider event again (here with other data, to show that it is not applied).
    expect(await t.hook([{ ref: s.ref, status: 'processing', eventId: 'evt-1', txHash: '0xff' }])).toBe(200)
    let rec = await t.record(s.id)
    expect(rec.active!.legs[0]!.step!.txHash).toBe('0xaa')
    expect(rec.providerEvents).toEqual([`hooked:${s.ref}:evt-1`])
    // A new event id applies.
    await t.hook([{ ref: s.ref, status: 'processing', eventId: 'evt-2', txHash: '0xbb' }])
    rec = await t.record(s.id)
    expect(rec.active!.legs[0]!.step!.txHash).toBe('0xbb')
    expect(rec.providerEvents).toHaveLength(2)
  })
})

describe('P1-2: a refund or a chargeback after success', () => {
  it('a refund after success makes the session REVERSED and sends session.reversed once, with a stable id', async () => {
    const t = make()
    const s = await t.toPayment()
    await t.hook([{ ref: s.ref, status: 'succeeded' }])
    expect(t.app.of('session.completed')).toHaveLength(1)

    expect(await t.hook([{ ref: s.ref, status: 'refunded' }])).toBe(200)
    const rec = await t.record(s.id)
    expect(rec.status).toBe('reversed')
    expect(rec.step).toMatchObject({ state: 'REVERSED', transitions: [], error: { code: 'PAYMENT_REVERSED' }, progress: { legs: [{ status: 'refunded' }] } })
    expect(rec.reversal).toMatchObject({ index: 0, adapterId: 'hooked', legId: 'hook', status: 'refunded', previous: 'COMPLETED' })
    expect(rec.timeline!.map((e) => e.type)).toEqual(expect.arrayContaining(['leg.refunded', 'session.reversed']))

    // The provider sends the refund again, then a chargeback: nothing new.
    await t.hook([{ ref: s.ref, status: 'refunded' }])
    await t.hook([{ ref: s.ref, status: 'reversed' }])
    const reversed = t.app.of('session.reversed')
    expect(reversed).toHaveLength(1)
    const extra = { index: 0, adapterId: 'hooked', legId: 'hook', legStatus: 'refunded', previous: 'COMPLETED' }
    expect(reversed[0]!.id).toBe(await eventId(s.id, `session.reversed:${JSON.stringify(extra)}`))
    expect(reversed[0]!.data.object).toMatchObject({ ...extra, session: { status: 'reversed', step: { state: 'REVERSED' } } })
    expect(t.app.of('session.refunded')).toHaveLength(0)
    // Operators see it in the admin view.
    expect(await t.ramp.admin.get(s.id)).toMatchObject({ status: 'reversed', state: 'REVERSED', reversal: { index: 0, status: 'refunded', previous: 'COMPLETED' } })
  })

  it('a chargeback (status reversed) after success does the same; the session refuses a restart', async () => {
    const t = make()
    const s = await t.toPayment()
    await t.hook([{ ref: s.ref, status: 'succeeded' }])
    await t.hook([{ ref: s.ref, status: 'reversed' }])
    expect((await t.record(s.id)).step.state).toBe('REVERSED')
    expect(t.app.of('session.reversed')[0]!.data.object).toMatchObject({ legStatus: 'reversed' })
    expect((await t.post(`/sessions/${s.id}/transitions/restart`, s.clientSecret)).status).toBe(409)
  })

  it('a refund before success is still REFUNDED, not REVERSED', async () => {
    const t = make()
    const s = await t.toPayment()
    await t.hook([{ ref: s.ref, status: 'processing' }])
    await t.hook([{ ref: s.ref, status: 'refunded' }])
    expect((await t.record(s.id)).step.state).toBe('REFUNDED')
    expect(t.app.of('session.refunded')).toHaveLength(1)
    expect(t.app.of('session.reversed')).toHaveLength(0)
  })
})

describe('P1-3: the reported output is checked against the quote', () => {
  const usdc = (amount: string) => ({ amount, asset: { kind: 'crypto' as const, chain: 'eip155:8453', token: USDC['eip155:8453']! } })

  it('flags a shortfall beyond the tolerance: the session completes, the result and the webhook show it', async () => {
    const t = make()
    const s = await t.toPayment()
    await t.hook([{ ref: s.ref, status: 'succeeded', output: usdc('8.5') }])
    const rec = await t.record(s.id)
    expect(rec.step.state).toBe('COMPLETED')
    expect(rec.active!.legs[0]!.amountMismatch).toMatchObject({ expected: { amount: '9' }, received: { amount: '8.5' }, shortfall: '0.5' })
    expect(rec.timeline!.find((e) => e.type === 'leg.amount_mismatch')).toMatchObject({ detail: { index: 0, expected: '9', received: '8.5' } })
    const done = t.app.of('session.completed')
    expect(done).toHaveLength(1)
    expect(done[0]!.data.object).toMatchObject({
      session: { result: { output: { amount: '8.5' }, outputConfirmed: true, amountMismatch: { legIndex: 0, expected: { amount: '9' }, received: { amount: '8.5' }, shortfall: '0.5' } } },
    })
    expect((await t.ramp.admin.get(s.id))!.payment!.legs[0]).toMatchObject({ amountMismatch: { shortfall: '0.5' } })
  })

  it('does not flag an output within the default 1% tolerance, or above the quote', async () => {
    const t = make()
    const a = await t.toPayment()
    await t.hook([{ ref: a.ref, status: 'succeeded', output: usdc('8.92') }])
    const b = await t.toPayment()
    await t.hook([{ ref: b.ref, status: 'succeeded', output: usdc('9.4') }])
    for (const id of [a.id, b.id]) {
      const rec = await t.record(id)
      expect(rec.active!.legs[0]!.amountMismatch).toBeUndefined()
      expect(rec.timeline!.some((e) => e.type === 'leg.amount_mismatch')).toBe(false)
    }
    expect(t.app.of('session.completed').every((e) => !(e.data.object.session as { result: object }).result.hasOwnProperty('amountMismatch'))).toBe(true)
  })

  it('uses policy.outputToleranceBps, and skips an output in another asset', async () => {
    const t = make({ policy: { outputToleranceBps: 0 } })
    const a = await t.toPayment()
    await t.hook([{ ref: a.ref, status: 'succeeded', output: usdc('8.99') }])
    expect((await t.record(a.id)).active!.legs[0]!.amountMismatch).toMatchObject({ shortfall: '0.01' })
    const b = await t.toPayment()
    await t.hook([{ ref: b.ref, status: 'succeeded', output: { amount: '1', asset: { kind: 'fiat', currency: 'USD' } } }])
    expect((await t.record(b.id)).active!.legs[0]!.amountMismatch).toBeUndefined()
  })
})
