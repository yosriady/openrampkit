// Payment attempts: a failed attempt is not a failed session. `session.failed` is final.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAdapter } from '@openrampkit/adapter'
import type { LegEvent } from '@openrampkit/adapter'
import { USDC } from '@openrampkit/core'
import type { LegSpec } from '@openrampkit/core'
import { createOpenRamp } from './index.js'
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

/** A provider whose orders are `order-1`, `order-2`, ... and whose webhooks are plain LegEvent arrays */
function provider() {
  let n = 0
  return createAdapter({
    id: 'hooked', name: 'Hooked', legs: [spec],
    async quote({ leg, amountIn }) {
      return { adapterId: 'hooked', legId: leg.legId, input: amountIn!, output: { value: '9', asset: leg.to.asset }, fees: [], eta: { min: 1, max: 2 } }
    },
    async start() {
      n++
      return { state: 'PAYMENT', status: 'requires_action', ref: `order-${n}`, surface: { kind: 'REDIRECT', url: 'https://provider.test/pay', popup: true }, transitions: [{ name: 'poll', kind: 'AWAIT', poll: POLL }] }
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

function make(extra: Partial<OpenRampConfig> = {}) {
  const hooks: Hook[] = []
  const ramp = createOpenRamp({
    secret: 's'.repeat(40), baseUrl: BASE, adapters: [provider()], logger: quiet,
    webhooks: { url: 'https://app.test/hooks', secret: 'w'.repeat(32) },
    fetch: async (_u, init) => {
      hooks.push(JSON.parse(String(init?.body)))
      return new Response('ok')
    },
    ...extra,
  })
  const call = async (path: string, secret: string, body?: unknown) => {
    const res = await ramp.handle(new Request(`${BASE}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
    return { status: res.status, body: (await res.json()) as Record<string, any> }
  }
  const event = (ev: LegEvent) => ramp.handle(new Request(`${BASE}/webhooks/hooked`, { method: 'POST', body: JSON.stringify([ev]) }))
  const pay = async (s: { id: string; clientSecret: string }) => {
    await call(`/sessions/${s.id}/plan`, s.clientSecret, {})
    const q = await call(`/sessions/${s.id}/quotes`, s.clientSecret, { method: 'card', amount: '10' })
    return call(`/sessions/${s.id}/select`, s.clientSecret, { quoteId: q.body.quotes[0].id })
  }
  const types = () => hooks.map((h) => h.type)
  return { ramp, call, event, pay, hooks, types }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('a failed attempt', () => {
  it('sends session.payment_failed, sets lastError and goes back to requires_payment_method; a retry can succeed', async () => {
    const t = make()
    const s = await t.ramp.sessions.create({ userId: 'u', country: 'SG', destination: DEST })
    expect((await t.pay(s)).body.status).toBe('requires_action')
    await t.event({ ref: 'order-1', status: 'failed', error: { code: 'PROVIDER_DECLINED', message: 'Declined.', retryable: false, recovery: 'choose_other' } })
    const failed = (await t.call(`/sessions/${s.id}`, s.clientSecret)).body
    expect(failed).toMatchObject({ status: 'requires_payment_method', step: { state: 'FAILED' }, lastError: { code: 'PROVIDER_DECLINED' } })
    const pf = t.hooks.find((h) => h.type === 'session.payment_failed')!
    expect(pf.data.object).toMatchObject({ attempt: 0, index: 0, adapterId: 'hooked', error: { code: 'PROVIDER_DECLINED' } })
    expect(t.types()).not.toContain('session.failed')

    // The user tries again (restart, then a new quote). The new payment clears lastError.
    expect((await t.call(`/sessions/${s.id}/transitions/restart`, s.clientSecret, {})).body).toMatchObject({ status: 'requires_payment_method', step: { state: 'SELECT_METHOD' } })
    const again = await t.pay(s)
    expect(again.body.status).toBe('requires_action')
    expect(again.body.lastError).toBeUndefined()
    await t.event({ ref: 'order-2', status: 'succeeded', txHash: '0xabc' })
    expect((await t.call(`/sessions/${s.id}`, s.clientSecret)).body.status).toBe('succeeded')
    const order = t.types()
    expect(order.indexOf('session.payment_failed')).toBeLessThan(order.indexOf('session.succeeded'))
    expect(order).not.toContain('session.failed')
    expect(order.filter((x) => x === 'session.succeeded')).toHaveLength(1)
  })

  it('a new quote after a failed attempt also works without restart', async () => {
    const t = make()
    const s = await t.ramp.sessions.create({ userId: 'u', country: 'SG', destination: DEST })
    await t.pay(s)
    await t.event({ ref: 'order-1', status: 'failed' })
    expect((await t.pay(s)).status).toBe(200)
    await t.event({ ref: 'order-2', status: 'succeeded' })
    expect((await t.ramp.sessions.retrieve(s.id))!.status).toBe('succeeded')
  })

  it('sends session.requires_action and session.processing once per leg and attempt', async () => {
    const t = make()
    const s = await t.ramp.sessions.create({ userId: 'u', country: 'SG', destination: DEST })
    await t.pay(s)
    await t.event({ ref: 'order-1', status: 'processing' })
    await t.event({ ref: 'order-1', status: 'processing' })
    await t.event({ ref: 'order-1', status: 'succeeded' })
    expect(t.types()).toEqual(['session.created', 'session.requires_action', 'session.processing', 'leg.succeeded', 'session.succeeded'])
  })

  it('a session with a failed attempt expires at its deadline', async () => {
    const t = make({ tasksToken: 't'.repeat(32) })
    const s = await t.ramp.sessions.create({ userId: 'u', country: 'SG', destination: DEST, ttlMinutes: 5 })
    await t.pay(s)
    await t.event({ ref: 'order-1', status: 'failed' })
    vi.useFakeTimers({ now: Date.now() + 6 * 60_000, toFake: ['Date'] })
    expect(await t.ramp.sweep()).toMatchObject({ sessions: { expired: 1 } })
    expect((await t.ramp.sessions.retrieve(s.id))!.status).toBe('expired')
    expect(t.types()).toContain('session.expired')
    expect(t.types()).not.toContain('session.failed')
  })
})

describe('a final failure', () => {
  it('out of attempts: session.failed, no restart, no new payment, and nothing after it', async () => {
    const t = make({ policy: { maxAttempts: 2 } })
    const s = await t.ramp.sessions.create({ userId: 'u', country: 'SG', destination: DEST })
    // Attempt 0: the user leaves it while it waits for payment (it may still be paid).
    await t.pay(s)
    expect((await t.call(`/sessions/${s.id}/transitions/restart`, s.clientSecret, {})).status).toBe(200)
    // Attempt 1 (the last one) fails: the session fails.
    await t.pay(s)
    await t.event({ ref: 'order-2', status: 'failed' })
    const pub = (await t.call(`/sessions/${s.id}`, s.clientSecret)).body
    expect(pub).toMatchObject({ status: 'failed', step: { state: 'FAILED' }, lastError: { code: 'PAYMENT_FAILED' } })
    const failed = t.hooks.find((h) => h.type === 'session.failed')!
    expect(failed.data.object).toMatchObject({ error: { code: 'PAYMENT_FAILED' } })
    expect(t.types()).not.toContain('session.payment_failed')

    // The session takes no new attempt.
    expect((await t.call(`/sessions/${s.id}/transitions/restart`, s.clientSecret, {})).status).toBe(409)
    expect((await t.call(`/sessions/${s.id}/quotes`, s.clientSecret, { method: 'card', amount: '10' })).status).toBe(409)
    expect((await t.call(`/sessions/${s.id}/plan`, s.clientSecret, {})).status).toBe(409)

    // The left attempt is paid after all: a late payment, never session.succeeded.
    expect((await t.event({ ref: 'order-1', status: 'succeeded', txHash: '0xlate' })).status).toBe(200)
    expect((await t.ramp.sessions.retrieve(s.id))!.status).toBe('failed')
    const late = t.hooks.find((h) => h.type === 'session.late_payment')!
    expect(late.data.object).toMatchObject({ reason: 'earlier_attempt', attempt: 0 })
    expect(t.types()).not.toContain('session.succeeded')
    expect(t.types().indexOf('session.failed')).toBeLessThan(t.types().indexOf('session.late_payment'))
  })

  it('maxAttempts: 1 makes the first failure final', async () => {
    const t = make({ policy: { maxAttempts: 1 } })
    const s = await t.ramp.sessions.create({ userId: 'u', country: 'SG', destination: DEST })
    await t.pay(s)
    await t.event({ ref: 'order-1', status: 'failed' })
    expect((await t.ramp.sessions.retrieve(s.id))!.status).toBe('failed')
    expect(t.types()).toContain('session.failed')
  })

  it('an operator resolve to FAILED is final', async () => {
    const t = make()
    const s = await t.ramp.sessions.create({ userId: 'u', country: 'SG', destination: DEST })
    await t.pay(s)
    await t.ramp.admin.resolve(s.id, 'FAILED', 'Fraud check')
    expect((await t.ramp.sessions.retrieve(s.id))).toMatchObject({ status: 'failed', lastError: { code: 'PAYMENT_FAILED' } })
    await t.event({ ref: 'order-1', status: 'succeeded' })
    expect((await t.ramp.sessions.retrieve(s.id))!.status).toBe('failed')
    expect(t.types()).not.toContain('session.succeeded')
  })
})
