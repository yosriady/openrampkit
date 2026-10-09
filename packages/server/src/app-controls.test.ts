// App controls on sessions: externalId, Idempotency-Key on every POST, and cancel.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAdapter } from '@openrampkit/adapter'
import type { LegEvent } from '@openrampkit/adapter'
import { mockAdapter } from '@openrampkit/adapter-mock'
import { USDC } from '@openrampkit/core'
import type { LegSpec } from '@openrampkit/core'
import { createOpenRamp, memoryStore } from './index.js'
import type { OpenRampConfig } from './index.js'

const BASE = 'https://app.test/api/openramp'
const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const DEST = { type: 'crypto' as const, chain: 'eip155:8453', token: USDC['eip155:8453']!, address: '0x000000000000000000000000000000000000beef' }
const POLL = { intervalMs: 1000, backoff: 1, maxIntervalMs: 1000, giveUpAfterMs: 60000 }

const spec: LegSpec = {
  id: 'hook', kind: 'fiat_onramp', methods: ['card'],
  from: { asset: { kind: 'fiat', currencies: '*' }, location: ['user_account'] },
  to: { asset: { kind: 'crypto', chains: { 'eip155:8453': [USDC['eip155:8453']!] } }, location: ['address'] },
  regions: { allow: ['*'], deny: [] }, eta: { min: 1, max: 2 }, surfaces: ['REDIRECT'],
}

function provider(canceled: string[] = [], failCancel = false) {
  let n = 0
  return createAdapter({
    id: 'hooked', name: 'Hooked', legs: [spec],
    async quote({ leg, amountIn }) {
      return { adapterId: 'hooked', legId: leg.legId, input: amountIn!, output: { value: '9', asset: leg.to.asset }, fees: [], eta: { min: 1, max: 2 }, guarantee: 'estimate' as const, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }
    },
    async start() {
      n++
      return { state: 'PAYMENT', status: 'requires_action', ref: `order-${n}`, surface: { kind: 'REDIRECT', url: 'https://provider.test/pay', popup: true }, transitions: [{ name: 'poll', kind: 'AWAIT', poll: POLL }] }
    },
    async cancel({ ref }) {
      if (failCancel) throw new Error('provider down')
      canceled.push(ref)
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
}

type Hook = { type: string; data: { object: Record<string, any> } }

function make(extra: Partial<OpenRampConfig> = {}, adapters = [provider()]) {
  const hooks: Hook[] = []
  const ramp = createOpenRamp({
    secret: 's'.repeat(40), baseUrl: BASE, adapters, logger: quiet, store: memoryStore(),
    webhooks: { url: 'https://app.test/hooks', secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw' },
    fetch: async (_u, init) => {
      hooks.push(JSON.parse(String(init?.body)))
      return new Response('ok')
    },
    ...extra,
  })
  const call = async (path: string, opts: { secret?: string; body?: unknown; key?: string; method?: string; raw?: string } = {}) => {
    const headers = new Headers({ 'content-type': 'application/json' })
    if (opts.secret) headers.set('authorization', `Bearer ${opts.secret}`)
    if (opts.key) headers.set('idempotency-key', opts.key)
    const body = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body))
    const res = await ramp.handle(new Request(`${BASE}${path}`, { method: opts.method ?? (body === undefined ? 'GET' : 'POST'), headers, ...(body === undefined ? {} : { body }) }))
    return { status: res.status, headers: res.headers, body: (await res.json()) as Record<string, any> }
  }
  const event = (ev: LegEvent) => ramp.handle(new Request(`${BASE}/webhooks/hooked`, { method: 'POST', body: JSON.stringify([ev]) }))
  const pay = async (s: { id: string; clientSecret?: string }) => {
    await call(`/sessions/${s.id}/plan`, { secret: s.clientSecret!, body: {} })
    const q = await call(`/sessions/${s.id}/quotes`, { secret: s.clientSecret!, body: { method: 'card', amount: '10' } })
    return call(`/sessions/${s.id}/select`, { secret: s.clientSecret!, body: { quoteId: q.body.quotes[0].id } })
  }
  return { ramp, call, event, pay, hooks, types: () => hooks.map((h) => h.type) }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('externalId', () => {
  it('is on the backend view and the webhooks, never on the browser view', async () => {
    const t = make()
    const s = await t.ramp.sessions.create({ userId: 'u', destination: DEST, externalId: 'order-42' })
    expect(await t.ramp.sessions.retrieve(s.id)).toMatchObject({ externalId: 'order-42', userId: 'u' })
    expect(t.hooks[0]!.data.object.session.externalId).toBe('order-42')
    const pub = await t.call(`/sessions/${s.id}`, { secret: s.clientSecret })
    expect(pub.body).not.toHaveProperty('externalId')
    expect(pub.body).not.toHaveProperty('userId')
  })

  it('a repeat by the same user with the same input returns the session, with no client secret', async () => {
    const t = make()
    const a = await t.ramp.sessions.create({ userId: 'u', destination: DEST, externalId: 'order-1', metadata: { cart: '1' } })
    const b = await t.ramp.sessions.create({ userId: 'u', destination: DEST, externalId: 'order-1', metadata: { cart: '1' } })
    expect(b).toEqual({ id: a.id, expiresAt: a.expiresAt, existing: true })
    expect(b.clientSecret).toBeUndefined()
    // The first secret still works, and only one session was made.
    expect((await t.call(`/sessions/${a.id}`, { secret: a.clientSecret })).status).toBe(200)
    expect(t.types().filter((x) => x === 'session.created')).toHaveLength(1)
    // While a payment waits for the user, a repeat still returns it.
    await t.pay(a)
    expect(await t.ramp.sessions.create({ userId: 'u', destination: DEST, externalId: 'order-1', metadata: { cart: '1' } })).toMatchObject({ id: a.id, existing: true })
    // Another externalId is another session.
    expect((await t.ramp.sessions.create({ userId: 'u', destination: DEST, externalId: 'order-2' })).id).not.toBe(a.id)
  })

  it('another user, or other input, with the same externalId is 409 EXTERNAL_ID_CONFLICT and gets no session', async () => {
    const t = make()
    const a = await t.ramp.sessions.create({ userId: 'alice', destination: DEST, externalId: 'order-7' })
    const conflict = { status: 409, error: { code: 'EXTERNAL_ID_CONFLICT', message: 'This externalId is already used by another session. Use a new externalId.' } }
    // Another user: never a lookup (no id, no secret, no status in the answer)
    const other = t.ramp.sessions.create({ userId: 'mallory', destination: DEST, externalId: 'order-7' })
    await expect(other).rejects.toMatchObject(conflict)
    await expect(other).rejects.not.toMatchObject({ error: { message: expect.stringContaining(a.id) } })
    // The same user with another destination, metadata or amount bounds
    const OTHER_DEST = { ...DEST, address: '0x000000000000000000000000000000000000dead' }
    await expect(t.ramp.sessions.create({ userId: 'alice', destination: OTHER_DEST, externalId: 'order-7' })).rejects.toMatchObject(conflict)
    await expect(t.ramp.sessions.create({ userId: 'alice', destination: DEST, externalId: 'order-7', metadata: { x: '1' } })).rejects.toMatchObject(conflict)
    await expect(t.ramp.sessions.create({ userId: 'alice', destination: DEST, externalId: 'order-7', amountBounds: { min: '1', currency: 'USD' } })).rejects.toMatchObject(conflict)
    expect(t.types().filter((x) => x === 'session.created')).toHaveLength(1)
  })

  it('POST /sessions (authorize hook): a repeat gets 200 and no client secret; another user gets 409', async () => {
    let user = 'alice'
    const t = make({ authorize: async (_req, body) => ({ userId: user, destination: DEST, ...(body as object) }) })
    const a = await t.call('/sessions', { body: { externalId: 'cart-5' } })
    expect(a.status).toBe(201)
    expect(a.body.clientSecret).toMatch(/^ors_/)
    const again = await t.call('/sessions', { body: { externalId: 'cart-5' } })
    expect(again.status).toBe(200)
    expect(again.body).toEqual({ id: a.body.id, expiresAt: a.body.expiresAt, existing: true })
    user = 'mallory'
    const stolen = await t.call('/sessions', { body: { externalId: 'cart-5' } })
    expect(stolen.status).toBe(409)
    expect(stolen.body.error.code).toBe('EXTERNAL_ID_CONFLICT')
    expect(JSON.stringify(stolen.body)).not.toContain(a.body.id)
    // No public or admin route finds a session by externalId without server-side auth.
    expect((await t.call('/sessions?externalId=cart-5')).status).toBe(404)
    expect((await t.call('/admin/sessions?externalId=cart-5')).status).toBe(404)
  })

  it('a repeat for a final session answers 409', async () => {
    const t = make()
    const a = await t.ramp.sessions.create({ userId: 'u', destination: DEST, externalId: 'order-9' })
    await t.pay(a)
    await t.event({ ref: 'order-1', status: 'succeeded' })
    await expect(t.ramp.sessions.create({ userId: 'u', destination: DEST, externalId: 'order-9' })).rejects.toMatchObject({ status: 409, error: { code: 'EXTERNAL_ID_CONFLICT' } })
    const c = await t.ramp.sessions.create({ userId: 'u', destination: DEST, externalId: 'order-10' })
    await t.ramp.sessions.cancel(c.id)
    await expect(t.ramp.sessions.create({ userId: 'u', destination: DEST, externalId: 'order-10' })).rejects.toMatchObject({ status: 409 })
  })

  it('creates at the same time make one session', async () => {
    const t = make()
    const all = await Promise.all([1, 2, 3].map(() => t.ramp.sessions.create({ userId: 'u', destination: DEST, externalId: 'order-race' })))
    expect(new Set(all.map((x) => x.id)).size).toBe(1)
    expect(all.filter((x) => x.clientSecret)).toHaveLength(1)
  })

  it('refuses an externalId that is not 1 to 256 printable characters', async () => {
    const t = make()
    await expect(t.ramp.sessions.create({ userId: 'u', destination: DEST, externalId: '' })).rejects.toMatchObject({ status: 400 })
    await expect(t.ramp.sessions.create({ userId: 'u', destination: DEST, externalId: 'a b' })).rejects.toMatchObject({ status: 400 })
    await expect(t.ramp.sessions.create({ userId: 'u', destination: DEST, externalId: 'x'.repeat(257) })).rejects.toMatchObject({ status: 400 })
  })
})

describe('Idempotency-Key on every POST', () => {
  it('replays the same body, refuses another body with 422 IDEMPOTENCY_MISMATCH', async () => {
    const t = make({}, [mockAdapter({ settleMs: 0 })])
    const s = await t.ramp.sessions.create({ userId: 'u', country: 'VN', destination: DEST })
    const first = await t.call(`/sessions/${s.id}/quotes`, { secret: s.clientSecret, body: { method: 'vietqr', amount: '500000' }, key: 'k-1' })
    expect(first.status).toBe(200)
    const again = await t.call(`/sessions/${s.id}/quotes`, { secret: s.clientSecret, body: { method: 'vietqr', amount: '500000' }, key: 'k-1' })
    expect(again.headers.get('idempotent-replay')).toBe('true')
    expect(again.body).toEqual(first.body)
    const other = await t.call(`/sessions/${s.id}/quotes`, { secret: s.clientSecret, body: { method: 'vietqr', amount: '600000' }, key: 'k-1' })
    expect(other.status).toBe(422)
    expect(other.body.error).toMatchObject({ code: 'IDEMPOTENCY_MISMATCH', retryable: false })
    // The same key on another route is another request.
    expect((await t.call(`/sessions/${s.id}/plan`, { secret: s.clientSecret, body: {}, key: 'k-1' })).status).toBe(200)
  })

  it('select with the same key starts one payment', async () => {
    const t = make()
    const s = await t.ramp.sessions.create({ userId: 'u', destination: DEST })
    await t.call(`/sessions/${s.id}/plan`, { secret: s.clientSecret, body: {} })
    const q = await t.call(`/sessions/${s.id}/quotes`, { secret: s.clientSecret, body: { method: 'card', amount: '10' } })
    const body = { quoteId: q.body.quotes[0].id }
    const [a, b] = [await t.call(`/sessions/${s.id}/select`, { secret: s.clientSecret, body, key: 'sel-1' }), await t.call(`/sessions/${s.id}/select`, { secret: s.clientSecret, body, key: 'sel-1' })]
    expect(a.status).toBe(200)
    expect(b.body).toEqual(a.body)
    expect((await t.ramp.admin.get(s.id))!.timeline.filter((e) => e.type === 'payment.started')).toHaveLength(1)
    expect((await t.call(`/sessions/${s.id}/select`, { secret: s.clientSecret, body: { quoteId: 'q_other' }, key: 'sel-1' })).status).toBe(422)
  })

  it('POST /sessions (authorize hook): a repeat replays the created session; another body is a 422', async () => {
    const t = make({ authorize: async (_req, body) => ({ userId: 'u', destination: DEST, ...(body as object) }) })
    const a = await t.call('/sessions', { body: { metadata: { cart: '1' } }, key: 'create-1' })
    expect(a.status).toBe(201)
    const b = await t.call('/sessions', { body: { metadata: { cart: '1' } }, key: 'create-1' })
    expect(b.body).toEqual(a.body)
    expect((await t.call('/sessions', { body: { metadata: { cart: '2' } }, key: 'create-1' })).status).toBe(422)
    expect(t.types().filter((x) => x === 'session.created')).toHaveLength(1)
  })
})

describe('cancel', () => {
  it('cancels a session before payment: CANCELED, status canceled, session.canceled', async () => {
    const t = make()
    const s = await t.ramp.sessions.create({ userId: 'u', destination: DEST })
    const v = await t.ramp.sessions.cancel(s.id)
    expect(v).toMatchObject({ status: 'canceled', step: { state: 'CANCELED', error: { code: 'CANCELED' } }, canceled: { reason: 'requested_by_app' } })
    const hook = t.hooks.find((h) => h.type === 'session.canceled')!
    expect(hook.data.object).toMatchObject({ reason: 'requested_by_app', session: { status: 'canceled' } })
    // Again: no change and no second event.
    expect(await t.ramp.sessions.cancel(s.id)).toMatchObject({ status: 'canceled' })
    expect(t.types().filter((x) => x === 'session.canceled')).toHaveLength(1)
    // A canceled session takes no new payment.
    expect((await t.call(`/sessions/${s.id}/plan`, { secret: s.clientSecret, body: {} })).status).toBe(409)
    expect(await t.ramp.sessions.cancel('ors_missing')).toBeNull()
  })

  it('the browser cancels while the user still has to pay; the adapter voids the order', async () => {
    const canceled: string[] = []
    const t = make({}, [provider(canceled)])
    const s = await t.ramp.sessions.create({ userId: 'u', destination: DEST })
    await t.pay(s)
    const r = await t.call(`/sessions/${s.id}/cancel`, { secret: s.clientSecret, body: {} })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ status: 'canceled', canceled: { reason: 'requested_by_user' } })
    expect(canceled).toEqual(['order-1'])
    // A late payment on the canceled order: session.late_payment, never session.succeeded.
    await t.event({ ref: 'order-1', status: 'succeeded', txHash: '0xlate' })
    expect((await t.ramp.sessions.retrieve(s.id))!.status).toBe('canceled')
    expect(t.hooks.find((h) => h.type === 'session.late_payment')!.data.object).toMatchObject({ reason: 'after_cancel', txHash: '0xlate' })
    expect(t.types()).not.toContain('session.succeeded')
  })

  it('a provider error on cancel refuses the cancel (409), and the session does not change', async () => {
    const t = make({}, [provider([], true)])
    const s = await t.ramp.sessions.create({ userId: 'u', destination: DEST })
    await t.pay(s)
    await expect(t.ramp.sessions.cancel(s.id, { reason: 'abandoned' })).rejects.toMatchObject({ status: 409, error: { code: 'PROVIDER_UNAVAILABLE' } })
    expect(await t.ramp.sessions.retrieve(s.id)).toMatchObject({ status: 'requires_action', step: { state: 'PAYMENT' } })
    expect(t.types()).not.toContain('session.canceled')
  })

  it('refuses a cancel (and a restart) after a transaction was submitted, also while the leg still waits', async () => {
    const t = make()
    const s = await t.ramp.sessions.create({ userId: 'u', destination: DEST })
    await t.pay(s)
    // The provider reports the user's transaction, but the leg still waits for the user.
    await t.event({ ref: 'order-1', status: 'requires_action', sourceTxHash: '0xsent' } as LegEvent)
    expect((await t.ramp.sessions.retrieve(s.id))!.status).toBe('requires_action')
    await expect(t.ramp.sessions.cancel(s.id)).rejects.toMatchObject({ status: 409, error: { message: expect.stringMatching(/on its way/) } })
    expect((await t.call(`/sessions/${s.id}/cancel`, { secret: s.clientSecret, body: {} })).status).toBe(409)
    expect((await t.call(`/sessions/${s.id}/transitions/restart`, { secret: s.clientSecret, body: {} })).status).toBe(409)
    expect(t.types()).not.toContain('session.canceled')
  })

  it('a provider success after cancel: session.late_payment, in the admin timeline, never session.succeeded', async () => {
    const t = make({ admin: {} })
    const s = await t.ramp.sessions.create({ userId: 'u', destination: DEST })
    await t.pay(s)
    await t.ramp.sessions.cancel(s.id)
    expect((await t.event({ ref: 'order-1', status: 'succeeded', txHash: '0xlate' })).status).toBe(200)
    const v = (await t.ramp.admin.get(s.id))!
    expect(v.status).toBe('canceled')
    expect(v.timeline.map((e) => e.type)).toEqual(expect.arrayContaining(['session.canceled', 'leg.succeeded', 'session.late_payment']))
    expect(v.payment!.legs[0]).toMatchObject({ ref: 'order-1', status: 'succeeded', txHash: '0xlate' })
    expect(await t.ramp.admin.findByRef('hooked', 'order-1')).toMatchObject({ id: s.id })
    expect(t.types()).not.toContain('session.succeeded')
  })

  it('refuses a cancel while the payment is processing, and after a final status', async () => {
    const t = make()
    const s = await t.ramp.sessions.create({ userId: 'u', destination: DEST })
    await t.pay(s)
    await t.event({ ref: 'order-1', status: 'processing' })
    await expect(t.ramp.sessions.cancel(s.id)).rejects.toMatchObject({ status: 409 })
    expect((await t.call(`/sessions/${s.id}/cancel`, { secret: s.clientSecret, body: {} })).status).toBe(409)
    await t.event({ ref: 'order-1', status: 'succeeded' })
    await expect(t.ramp.sessions.cancel(s.id)).rejects.toMatchObject({ status: 409 })
    expect(t.types()).not.toContain('session.canceled')
  })

  it('a polled provider (no webhook): the sweep still finds a payment after cancel and sends session.late_payment', async () => {
    let paid = false
    const polled = createAdapter({
      ...provider(),
      webhook: undefined,
      async status({ ref }) {
        return paid
          ? { state: 'COMPLETED', status: 'succeeded', ref, txHash: '0xpolled', transitions: [] }
          : { state: 'PAYMENT', status: 'requires_action', ref, transitions: [{ name: 'poll', kind: 'AWAIT', poll: POLL }] }
      },
    })
    const t = make({ admin: {} }, [polled])
    const s = await t.ramp.sessions.create({ userId: 'u', destination: DEST })
    await t.pay(s)
    await t.ramp.sessions.cancel(s.id)
    paid = true
    vi.useFakeTimers({ now: Date.now() + 2 * 60_000, toFake: ['Date'] })
    expect(await t.ramp.sweep()).toMatchObject({ sessions: { grace: 1, changed: 1 } })
    expect((await t.ramp.sessions.retrieve(s.id))!.status).toBe('canceled')
    expect(t.hooks.find((h) => h.type === 'session.late_payment')!.data.object).toMatchObject({ reason: 'after_cancel', txHash: '0xpolled' })
  })

  it('a pay link cannot cancel; the client secret can', async () => {
    const t = make()
    const s = await t.ramp.sessions.create({ userId: 'u', destination: DEST })
    const link = (await t.ramp.sessions.payLink(s.id))!
    const credential = new URL(link.url).pathname.split('/').pop()!
    expect((await t.call(`/sessions/${s.id}/cancel`, { secret: credential, body: {} })).status).toBe(403)
  })
})
