// Provider events that come late, twice or in the wrong order: the leg moves only forward, and an
// event id that the session already applied is dropped.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAdapter } from '@openrampkit/adapter'
import type { LegEvent } from '@openrampkit/adapter'
import { USDC } from '@openrampkit/core'
import type { LegSpec, LegStatus, LegStep } from '@openrampkit/core'
import { createOpenRamp, memoryStore } from './index.js'
import type { OpenRampConfig } from './index.js'

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
