// Provider events that come late, twice or in the wrong order: the leg moves only forward, and an
// event id that the session already applied is dropped. A refund or a chargeback after success
// reverses the session.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAdapter, webhookBodyKey } from '@openrampkit/adapter'
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
function hookedAdapter(specExtra: Partial<LegSpec> = {}, replay = false) {
  let n = 0
  const statusOf: Record<string, Partial<LegStep> & { status: LegStatus }> = {}
  const transitionOf: Record<string, Partial<LegStep> & { status: LegStatus }> = {}
  const spec: LegSpec = {
    id: 'hook', kind: 'fiat_onramp', methods: ['card'],
    from: { asset: { kind: 'fiat', currencies: '*' }, location: ['user_account'] },
    to: { asset: { kind: 'crypto', chains: { 'eip155:8453': [USDC['eip155:8453']!] } }, location: ['address'] },
    regions: { allow: ['*'], deny: [] }, eta: { min: 1, max: 2 }, surfaces: ['REDIRECT'],
    ...specExtra,
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
    async transition({ ref }) {
      const s = transitionOf[ref] ?? { status: 'processing' as const }
      return { state: STATE[s.status]!, ref, transitions: [], ...s }
    },
    webhook: {
      async verify() {
        return true
      },
      async parse(raw) {
        return JSON.parse(raw) as LegEvent[]
      },
      ...(replay ? { replayKey: async (_req: Request, raw: string) => webhookBodyKey(raw) } : {}),
    },
  })
  return { adapter, statusOf, transitionOf }
}

/** A bridge from USDC on Base to USDC on Arbitrum: the second leg of a two-leg pathway. */
function bridgeAdapter() {
  let n = 0
  const starts: string[] = []
  /** Set `down` to make `start` fail (the provider API is down) */
  const ctl = { down: false }
  const spec: LegSpec = {
    id: 'bridge', kind: 'bridge_swap',
    from: { asset: { kind: 'crypto', chains: { 'eip155:8453': [USDC['eip155:8453']!] } }, location: ['address'] },
    to: { asset: { kind: 'crypto', chains: { 'eip155:42161': [USDC['eip155:42161']!] } }, location: ['address'] },
    regions: { allow: ['*'], deny: [] }, eta: { min: 1, max: 2 }, surfaces: ['DEPOSIT_ADDRESS'],
  }
  const adapter = createAdapter({
    id: 'bridger', name: 'Bridger', legs: [spec],
    async prepareDeposit() {
      return { address: '0x00000000000000000000000000000000000000dd' }
    },
    async quote({ leg, amountIn }) {
      return { adapterId: 'bridger', legId: leg.legId, input: amountIn!, output: { amount: amountIn!.amount, asset: leg.to.asset }, fees: [], eta: { min: 1, max: 2 } }
    },
    async start() {
      if (ctl.down) throw new Error('bridge API down')
      const ref = `bridge-${++n}`
      starts.push(ref)
      return { state: 'PROCESSING', status: 'processing', ref, transitions: [{ name: 'poll', kind: 'AWAIT', poll: { intervalMs: 1000, backoff: 1, maxIntervalMs: 1000, giveUpAfterMs: 60000 } }] }
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
  return { adapter, starts, ctl }
}

/** App backend that records each delivered webhook body. */
function appBackend() {
  const sent: Array<{ id: string; type: string; sessionId?: string; data: { object: Record<string, unknown> } }> = []
  const fetchFn: typeof fetch = async (_u, init) => {
    sent.push(JSON.parse(String(init?.body)))
    return new Response('ok', { status: 200 })
  }
  return { sent, fetchFn, of: (type: string) => sent.filter((e) => e.type === type) }
}

function make(extra: Partial<OpenRampConfig> = {}, specExtra: Partial<LegSpec> = {}, opts: { replay?: boolean } = {}) {
  const hooked = hookedAdapter(specExtra, opts.replay)
  const bridge = bridgeAdapter()
  const app = appBackend()
  const store = memoryStore()
  const ramp = createOpenRamp({ secret: 's'.repeat(40), baseUrl: BASE, adapters: [hooked.adapter, bridge.adapter], logger: quiet, webhooks: HOOKS, fetch: app.fetchFn, store, ...extra })
  const call = (path: string, init: RequestInit & { secret?: string } = {}) => {
    const headers = new Headers(init.headers)
    if (init.secret) headers.set('authorization', `Bearer ${init.secret}`)
    if (init.body) headers.set('content-type', 'application/json')
    return ramp.handle(new Request(`${BASE}${path}`, { ...init, headers }))
  }
  const post = (path: string, secret: string, body: unknown = {}) => call(path, { method: 'POST', secret, body: JSON.stringify(body) })
  const hook = async (events: LegEvent[], adapter = 'hooked') => (await call(`/webhooks/${adapter}`, { method: 'POST', body: JSON.stringify(events) })).status
  const hookRes = (events: LegEvent[]) => call('/webhooks/hooked', { method: 'POST', body: JSON.stringify(events) })
  /** Create a session and start a card payment (state PAYMENT, waiting for the user). Returns the session and its order ref. */
  async function toPayment(input: { ttlMinutes?: number; destination?: typeof DEST } = {}) {
    const s = await ramp.sessions.create({ userId: 'u', country: 'SG', destination: DEST, ...input })
    return { ...s, ref: await pay(s) }
  }
  /** Plan, quote and select a card payment for session `s`. Returns the new order ref. */
  async function pay(s: { id: string; clientSecret: string }) {
    await post(`/sessions/${s.id}/plan`, s.clientSecret)
    const q = await (await post(`/sessions/${s.id}/quotes`, s.clientSecret, { method: 'card', amount: '10' })).json()
    const pub = await (await post(`/sessions/${s.id}/select`, s.clientSecret, { quoteId: q.quotes[0].id })).json()
    expect(pub.step.state).toBe('PAYMENT')
    const rec = (await store.get(s.id))!
    return rec.active!.legs[0]!.ref!
  }
  const record = async (id: string) => (await store.get(id))!
  return { ramp, store, call, post, hook, hookRes, toPayment, pay, record, app, statusOf: hooked.statusOf, transitionOf: hooked.transitionOf, bridgeStarts: bridge.starts, bridge: bridge.ctl }
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

  const depositSurface = (address: string) => ({ kind: 'DEPOSIT_ADDRESS' as const, chain: 'eip155:8453', token: USDC['eip155:8453']!, address })

  it('refuses awaiting_user with a new surface after processing when the leg does not opt in', async () => {
    const t = make()
    const s = await t.toPayment()
    await t.hook([{ ref: s.ref, status: 'processing' }])
    await t.hook([{ ref: s.ref, status: 'awaiting_user', surface: depositSurface('0x00000000000000000000000000000000000000aa') }])
    const rec = await t.record(s.id)
    expect(rec.step.state).toBe('PROCESSING')
    expect(rec.step.surface?.kind).not.toBe('DEPOSIT_ADDRESS')
  })

  it('with surface_after_processing: allows it once, with a declared surface kind, before the leg has a transaction', async () => {
    const t = make({}, { capabilities: ['webhooks', 'surface_after_processing'], surfaces: ['REDIRECT', 'DEPOSIT_ADDRESS'] })
    // A surface kind the leg does not declare is refused.
    const a = await t.toPayment()
    await t.hook([{ ref: a.ref, status: 'processing' }])
    await t.hook([{ ref: a.ref, status: 'awaiting_user', surface: { kind: 'QR', payload: 'x', amount: '1', currency: 'SGD' } }])
    expect((await t.record(a.id)).step.state).toBe('PROCESSING')

    const s = await t.toPayment()
    await t.hook([{ ref: s.ref, status: 'processing' }])
    await t.hook([{ ref: s.ref, status: 'awaiting_user', surface: depositSurface('0x00000000000000000000000000000000000000aa') }])
    let rec = await t.record(s.id)
    expect(rec.step).toMatchObject({ state: 'PAYMENT', surface: { kind: 'DEPOSIT_ADDRESS', address: '0x00000000000000000000000000000000000000aa' } })
    expect(rec.timeline!.some((e) => e.type === 'leg.surface_after_processing')).toBe(true)
    // Only once: a second move back with another address is refused.
    await t.hook([{ ref: s.ref, status: 'processing' }])
    await t.hook([{ ref: s.ref, status: 'awaiting_user', surface: depositSurface('0x00000000000000000000000000000000000000bb') }])
    rec = await t.record(s.id)
    expect(rec.step.state).toBe('PROCESSING')
    expect(JSON.stringify(rec.step)).not.toContain('00bb')

    // Never after the leg has a transaction.
    const b = await t.toPayment()
    await t.hook([{ ref: b.ref, status: 'processing', txHash: '0xaa' }])
    await t.hook([{ ref: b.ref, status: 'awaiting_user', surface: depositSurface('0x00000000000000000000000000000000000000aa') }])
    expect((await t.record(b.id)).step.state).toBe('PROCESSING')
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

describe('P1-2 review: a reversal is final, always notified, and stops all fund movement', () => {
  const ARB = { type: 'crypto' as const, chain: 'eip155:42161', token: USDC['eip155:42161']!, address: '0x000000000000000000000000000000000000beef' }

  it('after a reversal on the first leg, later events of the next leg change nothing and send no leg or session events', async () => {
    const t = make()
    const s = await t.toPayment({ destination: ARB })
    expect((await t.record(s.id)).active!.legs).toHaveLength(2)
    await t.hook([{ ref: s.ref, status: 'succeeded' }])
    expect(t.bridgeStarts).toHaveLength(1)
    await t.hook([{ ref: s.ref, status: 'refunded' }])
    expect((await t.record(s.id)).step.state).toBe('REVERSED')

    await t.hook([{ ref: t.bridgeStarts[0]!, status: 'succeeded' }], 'bridger')
    const rec = await t.record(s.id)
    expect(rec.step.state).toBe('REVERSED')
    expect(rec.status).toBe('reversed')
    expect(rec.active!.legs[1]!.step!.status).toBe('succeeded') // the leg data is kept
    expect(t.app.of('leg.succeeded').map((e) => e.data.object.index)).toEqual([0])
    expect(t.app.of('session.completed')).toHaveLength(0)
    expect(t.app.of('session.reversed')).toHaveLength(1)
    expect(t.bridgeStarts).toHaveLength(1)
  })

  it('a reversal of an earlier attempt sends session.reversed once, with the attempt, and keeps the session state', async () => {
    const t = make()
    const s = await t.toPayment()
    const first = s.ref
    expect((await t.post(`/sessions/${s.id}/transitions/restart`, s.clientSecret)).status).toBe(200)
    const second = await t.pay(s)
    await t.hook([{ ref: second, status: 'succeeded' }])
    await t.hook([{ ref: first, status: 'succeeded' }])
    expect(t.app.of('session.late_payment')).toHaveLength(1)

    await t.hook([{ ref: first, status: 'refunded' }])
    await t.hook([{ ref: first, status: 'refunded' }])
    const rec = await t.record(s.id)
    expect(rec.step.state).toBe('COMPLETED')
    const reversed = t.app.of('session.reversed')
    expect(reversed).toHaveLength(1)
    const extra = { attempt: 0, index: 0, adapterId: 'hooked', legId: 'hook', legStatus: 'refunded', previous: 'COMPLETED' }
    expect(reversed[0]!.data.object).toMatchObject(extra)
    expect(reversed[0]!.id).toBe(await eventId(s.id, `session.reversed:${JSON.stringify(extra)}`))
  })

  it('a reversal of a session that an operator closed still sends session.reversed and makes it REVERSED', async () => {
    const t = make()
    const s = await t.toPayment()
    await t.hook([{ ref: s.ref, status: 'processing' }])
    await t.ramp.admin.resolve(s.id, 'COMPLETED', 'credited by hand after a support call')
    await t.hook([{ ref: s.ref, status: 'succeeded' }])
    await t.hook([{ ref: s.ref, status: 'reversed' }])
    const rec = await t.record(s.id)
    expect(rec).toMatchObject({ status: 'reversed', step: { state: 'REVERSED' }, reversal: { status: 'reversed' } })
    expect(t.app.of('session.reversed')).toHaveLength(1)
  })

  it('an earlier attempt paid after the reversal does not become the payment again', async () => {
    const t = make()
    const s = await t.toPayment()
    const first = s.ref
    await t.post(`/sessions/${s.id}/transitions/restart`, s.clientSecret)
    const second = await t.pay(s)
    await t.hook([{ ref: second, status: 'succeeded' }])
    await t.hook([{ ref: second, status: 'reversed' }])
    expect((await t.record(s.id)).step.state).toBe('REVERSED')

    await t.hook([{ ref: first, status: 'succeeded' }])
    const rec = await t.record(s.id)
    expect(rec.step.state).toBe('REVERSED')
    expect(rec.status).toBe('reversed')
    expect(rec.active!.legs[0]!.ref).toBe(second)
    expect(t.app.of('session.late_payment')).toHaveLength(1)
    expect(t.app.of('session.completed')).toHaveLength(1)
    const pub = await (await t.call(`/sessions/${s.id}`, { secret: s.clientSecret })).json()
    expect(pub).toMatchObject({ status: 'reversed', step: { state: 'REVERSED' } })
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

  it('uses policy.outputToleranceBps', async () => {
    const t = make({ policy: { outputToleranceBps: 0 } })
    const a = await t.toPayment()
    await t.hook([{ ref: a.ref, status: 'succeeded', output: usdc('8.99') }])
    expect((await t.record(a.id)).active!.legs[0]!.amountMismatch).toMatchObject({ reason: 'short', shortfall: '0.01' })
  })

  it('fails closed: an output in another asset, or with an amount that is not a number, is flagged and not confirmed', async () => {
    const t = make()
    const a = await t.toPayment()
    // The right amount, but on another chain.
    await t.hook([{ ref: a.ref, status: 'succeeded', output: { amount: '9', asset: { kind: 'crypto', chain: 'eip155:1', token: USDC['eip155:1']! } } }])
    const ra = await t.record(a.id)
    expect(ra.active!.legs[0]!.amountMismatch).toMatchObject({ reason: 'asset_mismatch', shortfall: '9' })
    expect(ra.timeline!.find((e) => e.type === 'leg.amount_mismatch')).toMatchObject({ detail: { reason: 'asset_mismatch' } })
    const done = t.app.of('session.completed').find((e) => e.sessionId === a.id) ?? t.app.of('session.completed')[0]!
    expect(done.data.object).toMatchObject({ session: { result: { outputConfirmed: false, amountMismatch: { reason: 'asset_mismatch', legIndex: 0 } } } })

    const b = await t.toPayment()
    await t.hook([{ ref: b.ref, status: 'succeeded', output: { amount: '9e9', asset: usdc('9').asset } }])
    const rb = await t.record(b.id)
    expect(rb.active!.legs[0]!.amountMismatch).toMatchObject({ reason: 'invalid_amount' })
    expect((await t.ramp.admin.get(b.id))!.payment!.legs[0]).toMatchObject({ amountMismatch: { reason: 'invalid_amount' } })
  })

  it('does not start the next leg when a leg before the last delivered another asset', async () => {
    const t = make()
    const ARB = { type: 'crypto' as const, chain: 'eip155:42161', token: USDC['eip155:42161']!, address: '0x000000000000000000000000000000000000beef' }
    const s = await t.toPayment({ destination: ARB })
    await t.hook([{ ref: s.ref, status: 'succeeded', output: { amount: '9', asset: { kind: 'crypto', chain: 'eip155:8453', token: '0x00000000000000000000000000000000000000ee' } } }])
    const rec = await t.record(s.id)
    expect(t.bridgeStarts).toHaveLength(0)
    expect(rec.active!.index).toBe(0)
    expect(rec.step).toMatchObject({ state: 'FAILED', error: { code: 'DELIVERY_FAILED', recovery: 'contact_support' } })
    expect(t.app.of('session.failed')).toHaveLength(1)
    expect(t.app.of('session.failed')[0]!.data.object).toMatchObject({ session: { result: { amountMismatch: { reason: 'asset_mismatch', legIndex: 0 } } } })

    // A short (but same asset) delivery still starts the next leg: it bridges what arrived.
    const u = await t.toPayment({ destination: ARB })
    await t.hook([{ ref: u.ref, status: 'succeeded', output: usdc('8') }])
    expect(t.bridgeStarts).toHaveLength(1)
  })
})

describe('P1-4: replay protection for provider webhooks with a replayKey', () => {
  it('answers a replayed body with 200 and applies nothing; a new body applies', async () => {
    const metrics: string[] = []
    const t = make({ telemetry: { onMetric: (name) => void metrics.push(name) } }, {}, { replay: true })
    const s = await t.toPayment()
    const first = await t.hookRes([{ ref: s.ref, status: 'processing', txHash: '0xaa' }])
    expect(await first.json()).toEqual({ received: true })
    // Someone replays the same signed body later, after the leg moved on with another body.
    await t.hook([{ ref: s.ref, status: 'processing', txHash: '0xbb' }])
    const replay = await t.hookRes([{ ref: s.ref, status: 'processing', txHash: '0xaa' }])
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual({ received: true, duplicate: true })
    expect((await t.record(s.id)).active!.legs[0]!.step!.txHash).toBe('0xbb')
    expect(metrics).toContain('webhook.replayed')
  })

  it('gives the key back when the event could not be applied (503), so the provider retry still applies', async () => {
    const t = make({}, {}, { replay: true })
    const body = [{ ref: 'order-unknown', status: 'succeeded' as const }]
    expect((await t.hookRes(body)).status).toBe(503)
    const again = await t.hookRes(body)
    expect(again.status).toBe(503)
    expect(await again.json()).not.toHaveProperty('duplicate')
  })
})

describe('P1-5: grace polling for late payments', () => {
  const MIN = 60_000

  it('keeps polling an expired session at a slower rate; a late payment completes it and sends session.late_payment once', async () => {
    vi.useFakeTimers({ now: Date.now() })
    const t = make()
    const s = await t.toPayment({ ttlMinutes: 1 })
    vi.setSystemTime(Date.now() + 2 * MIN)
    const r1 = await t.ramp.sweep()
    expect(r1.sessions.expired).toBe(1)
    expect((await t.record(s.id)).step.state).toBe('EXPIRED')
    expect(t.app.of('session.expired')).toHaveLength(1)

    // Before the poll interval (10 min): not polled.
    vi.setSystemTime(Date.now() + 5 * MIN)
    expect((await t.ramp.sweep()).sessions.grace).toBe(0)
    // Still not paid: polled, still EXPIRED.
    vi.setSystemTime(Date.now() + 6 * MIN)
    expect((await t.ramp.sweep()).sessions.grace).toBe(1)
    expect((await t.record(s.id)).step.state).toBe('EXPIRED')

    // The bank transfer arrives two hours late.
    t.statusOf[s.ref] = { status: 'succeeded' }
    vi.setSystemTime(Date.now() + 2 * 60 * MIN)
    const r = await t.ramp.sweep()
    expect(r.sessions).toMatchObject({ grace: 1, changed: 1 })
    const rec = await t.record(s.id)
    expect(rec).toMatchObject({ status: 'completed', step: { state: 'COMPLETED' } })
    const late = t.app.of('session.late_payment')
    expect(late).toHaveLength(1)
    expect(late[0]!.data.object).toMatchObject({ reason: 'after_expiry', index: 0, adapterId: 'hooked', legId: 'hook' })
    expect(t.app.of('session.completed')).toHaveLength(1)

    // Off the grace list now.
    vi.setSystemTime(Date.now() + 20 * MIN)
    expect((await t.ramp.sweep()).sessions.grace).toBe(0)
  })

  it('stops polling after latePayments.graceHours', async () => {
    vi.useFakeTimers({ now: Date.now() })
    const t = make({ latePayments: { graceHours: 1, pollMinutes: 5 } })
    const s = await t.toPayment({ ttlMinutes: 1 })
    vi.setSystemTime(Date.now() + 2 * MIN)
    await t.ramp.sweep()
    vi.setSystemTime(Date.now() + 6 * MIN)
    expect((await t.ramp.sweep()).sessions.grace).toBe(1)
    t.statusOf[s.ref] = { status: 'succeeded' }
    vi.setSystemTime(Date.now() + 2 * 60 * MIN)
    expect((await t.ramp.sweep()).sessions.grace).toBe(0)
    expect((await t.record(s.id)).step.state).toBe('EXPIRED')
  })

  it('graceHours 0 turns it off: neither a poll nor a webhook completes the expired session', async () => {
    vi.useFakeTimers({ now: Date.now() })
    const t = make({ latePayments: { graceHours: 0 } })
    const s = await t.toPayment({ ttlMinutes: 1 })
    vi.setSystemTime(Date.now() + 2 * MIN)
    await t.ramp.sweep()
    t.statusOf[s.ref] = { status: 'succeeded' }
    vi.setSystemTime(Date.now() + 15 * MIN)
    expect((await t.ramp.sweep()).sessions.grace).toBe(0)
    expect((await t.record(s.id)).step.state).toBe('EXPIRED')

    await t.hook([{ ref: s.ref, status: 'succeeded' }])
    const rec = await t.record(s.id)
    expect(rec.step.state).toBe('EXPIRED')
    expect(rec.active!.legs[0]!.step!.status).toBe('succeeded') // the leg data is kept
    expect(t.app.of('session.completed')).toHaveLength(0)
    expect(t.app.of('session.late_payment')[0]!.data.object).toMatchObject({ reason: 'after_grace' })
  })
})

describe('third review: who can move a session on, and how far', () => {
  const MIN = 60_000

  it('(a) a webhook inside the grace window completes an expired session; after the window it does not', async () => {
    vi.useFakeTimers({ now: Date.now() })
    const t = make({ latePayments: { graceHours: 1 } })
    const a = await t.toPayment({ ttlMinutes: 1 })
    const b = await t.toPayment({ ttlMinutes: 1 })
    vi.setSystemTime(Date.now() + 2 * MIN)
    await t.ramp.sweep()
    await t.hook([{ ref: a.ref, status: 'succeeded' }])
    expect((await t.record(a.id)).step.state).toBe('COMPLETED')

    vi.setSystemTime(Date.now() + 2 * 60 * MIN)
    await t.hook([{ ref: b.ref, status: 'succeeded' }])
    expect((await t.record(b.id)).step.state).toBe('EXPIRED')
    const late = t.app.of('session.late_payment').map((e) => [e.sessionId, e.data.object.reason])
    expect(late).toEqual([[a.id, 'after_expiry'], [b.id, 'after_grace']])
    expect(t.app.of('session.completed').map((e) => e.sessionId)).toEqual([a.id])
  })

  it('(a) a failure event does not move an expired session to FAILED', async () => {
    vi.useFakeTimers({ now: Date.now() })
    const t = make()
    const s = await t.toPayment({ ttlMinutes: 1 })
    vi.setSystemTime(Date.now() + 2 * MIN)
    await t.ramp.sweep()
    await t.hook([{ ref: s.ref, status: 'failed' }])
    expect((await t.record(s.id)).step.state).toBe('EXPIRED')
    expect(t.app.of('session.failed')).toHaveLength(0)
  })

  it('(a) an event for an earlier attempt does not revive an expired session; client routes stay closed', async () => {
    vi.useFakeTimers({ now: Date.now() })
    const t = make()
    const s = await t.toPayment({ ttlMinutes: 1 })
    const first = s.ref
    await t.post(`/sessions/${s.id}/transitions/restart`, s.clientSecret)
    const second = await t.pay(s)
    vi.setSystemTime(Date.now() + 2 * MIN)
    await t.ramp.sweep()
    expect((await t.record(s.id)).step.state).toBe('EXPIRED')

    await t.hook([{ ref: first, status: 'succeeded' }])
    const rec = await t.record(s.id)
    expect(rec.step.state).toBe('EXPIRED')
    expect(rec.active!.legs[0]!.ref).toBe(second)
    expect(t.app.of('session.late_payment')[0]!.data.object).toMatchObject({ reason: 'earlier_attempt' })
    for (const path of ['restart', 'simulate']) expect((await t.post(`/sessions/${s.id}/transitions/${path}`, s.clientSecret)).status).toBeGreaterThanOrEqual(400)
    expect((await t.post(`/sessions/${s.id}/select`, s.clientSecret, { quoteId: 'x' })).status).toBeGreaterThanOrEqual(400)
  })

  it('(b) a status poll cannot move a leg back; a KYC review can end with a payment step', async () => {
    const t = make()
    const s = await t.toPayment()
    await t.hook([{ ref: s.ref, status: 'processing', txHash: '0xaa' }])
    t.statusOf[s.ref] = { status: 'awaiting_user' }
    await t.ramp.sessions.refresh(s.id)
    expect((await t.record(s.id)).step.state).toBe('PROCESSING')

    const k = await t.toPayment()
    t.statusOf[k.ref] = { status: 'processing', state: 'KYC', sub: 'KYC_REVIEW' }
    await t.ramp.sessions.refresh(k.id)
    expect((await t.record(k.id)).step).toMatchObject({ state: 'KYC', sub: 'KYC_REVIEW' })
    t.statusOf[k.ref] = { status: 'awaiting_user' }
    await t.ramp.sessions.refresh(k.id)
    expect((await t.record(k.id)).step.state).toBe('PAYMENT')
  })

  it('(b) a client transition cannot move a leg back', async () => {
    const t = make()
    const s = await t.toPayment()
    t.statusOf[s.ref] = { status: 'processing', state: 'PROCESSING', transitions: [{ name: 'change', kind: 'SUBMIT', label: 'Change' }] }
    await t.ramp.sessions.refresh(s.id)
    expect((await t.record(s.id)).step.transitions).toEqual([expect.objectContaining({ name: 'change' })])
    t.transitionOf[s.ref] = { status: 'awaiting_user', state: 'PAYMENT', surface: { kind: 'DEPOSIT_ADDRESS', chain: 'eip155:8453', token: USDC['eip155:8453']!, address: '0x00000000000000000000000000000000000000cc' } }
    const res = await t.post(`/sessions/${s.id}/transitions/change`, s.clientSecret)
    expect(res.status).toBe(409)
    const rec = await t.record(s.id)
    expect(rec.step.state).toBe('PROCESSING')
    expect(JSON.stringify(rec.step)).not.toContain('00cc')
  })

  it('(c) a completed or reversed session refuses plan, quotes, target, select and transitions from the browser', async () => {
    const t = make()
    for (const final of ['succeeded', 'reversed'] as const) {
      const s = await t.toPayment()
      await t.hook([{ ref: s.ref, status: 'succeeded' }])
      if (final === 'reversed') await t.hook([{ ref: s.ref, status: 'reversed' }])
      for (const [path, body] of [['plan', {}], ['quotes', { method: 'card', amount: '10' }], ['target', { type: 'fiat', currency: 'USD' }], ['select', { quoteId: 'x' }], ['transitions/restart', {}]] as const) {
        expect((await t.post(`/sessions/${s.id}/${path}`, s.clientSecret, body)).status, `${final} ${path}`).toBe(409)
      }
      expect((await t.call(`/sessions/${s.id}`, { secret: s.clientSecret })).status).toBe(200)
    }
  })
})

describe('fourth review: output checks and earlier attempts', () => {
  const ARB = { type: 'crypto' as const, chain: 'eip155:42161', token: USDC['eip155:42161']!, address: '0x000000000000000000000000000000000000beef' }
  const usdc = (amount: string) => ({ amount, asset: { kind: 'crypto' as const, chain: 'eip155:8453', token: USDC['eip155:8453']! } })
  const other = (amount: string) => ({ amount, asset: { kind: 'crypto' as const, chain: 'eip155:8453', token: '0x00000000000000000000000000000000000000ee' } })

  it('checks the output again when only its asset changes: another asset with the same amount does not start the next leg', async () => {
    const t = make()
    const s = await t.toPayment({ destination: ARB })
    await t.hook([{ ref: s.ref, status: 'processing', output: usdc('9') }])
    await t.hook([{ ref: s.ref, status: 'succeeded', output: other('9') }])
    const rec = await t.record(s.id)
    expect(rec.active!.legs[0]!.amountMismatch).toMatchObject({ reason: 'asset_mismatch' })
    expect(t.bridgeStarts).toHaveLength(0)
    expect(rec.step).toMatchObject({ state: 'FAILED', error: { code: 'DELIVERY_FAILED' } })
  })

  it('checks the output of an earlier attempt that becomes the payment again', async () => {
    const t = make()
    const s = await t.toPayment({ destination: ARB })
    const first = s.ref
    expect((await t.post(`/sessions/${s.id}/transitions/restart`, s.clientSecret)).status).toBe(200)
    await t.pay(s)
    await t.hook([{ ref: first, status: 'succeeded', output: other('9') }])
    const rec = await t.record(s.id)
    expect(rec.active!.legs[0]!.ref).toBe(first)
    expect(rec.active!.legs[0]!.amountMismatch).toMatchObject({ reason: 'asset_mismatch' })
    expect(t.bridgeStarts).toHaveLength(0)
    expect(rec.step).toMatchObject({ state: 'FAILED', error: { code: 'DELIVERY_FAILED' } })
  })

  it('a sweep never saves a half-applied poll: the next leg failed to start, and an earlier attempt changed', async () => {
    const t = make()
    const s = await t.toPayment({ destination: ARB })
    const first = s.ref
    await t.post(`/sessions/${s.id}/transitions/restart`, s.clientSecret)
    const second = await t.pay(s)
    // In one sweep: the payment succeeds but the bridge API is down, and the left attempt moves on.
    t.statusOf[second] = { status: 'succeeded' }
    t.statusOf[first] = { status: 'processing' }
    t.bridge.down = true
    await t.ramp.sweep()
    // Nothing of that sweep is saved: the leg that waits keeps its step, and the next sweep tries again.
    let rec = await t.record(s.id)
    expect(rec.active!.index).toBe(0)
    expect(rec.active!.legs[0]!.step).toBeDefined()

    // The bridge API is back: the next sweep starts the next leg.
    t.bridge.down = false
    await t.ramp.sweep()
    rec = await t.record(s.id)
    expect(t.bridgeStarts).toHaveLength(1)
    expect(rec.active!.index).toBe(1)
    expect(rec.active!.legs[1]!.step!.status).toBe('processing')
    expect(rec.step.state).toBe('PROCESSING')
  })

  it('a sweep never saves a half-applied earlier attempt: it became the payment again, then its next leg failed to start', async () => {
    const t = make()
    const s = await t.toPayment({ destination: ARB })
    const a0 = s.ref
    await t.post(`/sessions/${s.id}/transitions/restart`, s.clientSecret)
    const a1 = await t.pay(s)
    await t.post(`/sessions/${s.id}/transitions/restart`, s.clientSecret)
    const a2 = await t.pay(s)
    t.statusOf[a1] = { status: 'succeeded' }
    t.statusOf[a0] = { status: 'processing' }
    t.bridge.down = true
    await t.ramp.sweep()
    let rec = await t.record(s.id)
    expect(rec.active!.legs[0]!.ref).toBe(a2)
    expect(rec.active!.legs[rec.active!.index]!.step).toBeDefined()

    t.bridge.down = false
    await t.ramp.sweep()
    rec = await t.record(s.id)
    expect(rec.active!.legs[0]!.ref).toBe(a1)
    expect(t.bridgeStarts).toHaveLength(1)
    expect(rec.active!.legs[1]!.step!.status).toBe('processing')
  })

  it('a refund of an earlier attempt that never succeeded does not replace the payment in progress', async () => {
    const t = make()
    const s = await t.toPayment()
    const first = s.ref
    await t.post(`/sessions/${s.id}/transitions/restart`, s.clientSecret)
    const second = await t.pay(s)
    await t.hook([{ ref: first, status: 'refunded' }])
    let rec = await t.record(s.id)
    expect(rec.active!.legs[0]!.ref).toBe(second)
    expect(rec.step.state).toBe('PAYMENT')
    expect(rec.attempts![0]!.legs[0]!.step!.status).toBe('refunded')
    expect(t.app.of('session.refunded')).toHaveLength(0)

    // The user pays the payment in progress: the session completes.
    await t.hook([{ ref: second, status: 'succeeded' }])
    rec = await t.record(s.id)
    expect(rec.step.state).toBe('COMPLETED')
    expect(t.app.of('session.completed')).toHaveLength(1)
    expect(t.app.of('session.late_payment')).toHaveLength(0)
  })
})
