// The adapter contract v2 on the server: one state rule (stateFor), actions and phases, transactions
// with roles, provider references, and the merge of a new step into the leg.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAdapter } from '@openrampkit/adapter'
import type { LegEvent } from '@openrampkit/adapter'
import { USDC, stateFor } from '@openrampkit/core'
import type { LegSpec, LegStep } from '@openrampkit/core'
import { createOpenRamp, memoryStore } from './index.js'
import { mergeLegStep } from './legs.js'

const BASE = 'https://app.test/api/openramp'
const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const DEST = { type: 'crypto' as const, chain: 'eip155:8453', token: USDC['eip155:8453']!, address: '0x000000000000000000000000000000000000beef' }
const REDIRECT = { kind: 'REDIRECT' as const, url: 'https://provider.test/kyc', popup: true }
const H1 = '0x' + '11'.repeat(32)
const H2 = '0x' + '22'.repeat(32)

describe('stateFor', () => {
  it('derives the UI phase from the status, the action and the phase', () => {
    expect(stateFor({ status: 'requires_action', action: { kind: 'kyc', transitions: [] } })).toBe('KYC')
    expect(stateFor({ status: 'requires_action', action: { kind: 'auth', transitions: [] } })).toBe('AUTH')
    expect(stateFor({ status: 'requires_action' })).toBe('PAYMENT')
    expect(stateFor({ status: 'processing', phase: 'kyc' })).toBe('KYC')
    expect(stateFor({ status: 'processing' })).toBe('PROCESSING')
    expect(stateFor({ status: 'pending' })).toBe('PROCESSING')
    expect(stateFor({ status: 'succeeded' })).toBe('COMPLETED')
    expect(stateFor({ status: 'reversed' })).toBe('REVERSED')
  })
})

describe('mergeLegStep', () => {
  it('keeps refs, output, transactions and the action surface; drops the action when the user is done', () => {
    const first: LegStep = { status: 'requires_action', ref: 'r', providerRef: 'P-1', action: { kind: 'payment', surface: REDIRECT, transitions: [] }, transactions: [{ role: 'approval', hash: H1 }] }
    const poll = mergeLegStep(first, { status: 'requires_action', action: { kind: 'payment', transitions: [] } })
    expect(poll.action!.surface).toEqual(REDIRECT)
    expect(poll.providerRef).toBe('P-1')
    const paid = mergeLegStep(poll, { status: 'processing', transactions: [{ role: 'source', hash: H2 }] })
    expect(paid.action).toBeUndefined()
    expect(paid.ref).toBe('r')
    expect(paid.transactions).toEqual([{ role: 'approval', hash: H1 }, { role: 'source', hash: H2 }])
    // The same transaction again (another case of the hex) is not a second record.
    const again = mergeLegStep(paid, { status: 'succeeded', transactions: [{ role: 'source', hash: H2.toUpperCase().replace('0X', '0x') }, { role: 'destination', hash: H2 }] })
    expect(again.transactions).toHaveLength(3)
  })
})

/** A KYC provider: start asks for KYC, webhooks move the leg (review, payment, success). */
function kycAdapter() {
  const spec: LegSpec = {
    id: 'card', kind: 'fiat_onramp', methods: ['card'],
    from: { asset: { kind: 'fiat', currencies: '*' }, location: ['user_account'] },
    to: { asset: { kind: 'crypto', chains: { 'eip155:8453': [USDC['eip155:8453']!] } }, location: ['address'] },
    regions: { allow: ['*'], deny: [] }, eta: { min: 1, max: 2 }, surfaces: ['REDIRECT'],
  }
  let n = 0
  return createAdapter({
    id: 'kyc', name: 'KYC Provider', legs: [spec],
    async quote({ leg, amountIn }) {
      return { adapterId: 'kyc', legId: leg.legId, input: amountIn!, output: { value: '9', asset: { kind: 'crypto', chain: 'eip155:8453', token: USDC['eip155:8453']!, symbol: 'USDC', decimals: 6 } }, fees: [], eta: { min: 1, max: 2 }, guarantee: 'estimate', expiresAt: new Date(Date.now() + 60_000).toISOString() }
    },
    async start() {
      return { status: 'requires_action', ref: `k-${++n}`, action: { kind: 'kyc', surface: REDIRECT, transitions: [{ name: 'poll', kind: 'AWAIT', poll: { intervalMs: 1000, backoff: 1, maxIntervalMs: 1000, giveUpAfterMs: 60_000 } }] }, detail: { code: 'kyc_verify' } }
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

async function kycSession() {
  const store = memoryStore()
  const ramp = createOpenRamp({ secret: 's'.repeat(40), baseUrl: BASE, adapters: [kycAdapter()], logger: quiet, store, admin: { token: 't'.repeat(32) } })
  const call = (path: string, secret: string, body?: unknown) =>
    ramp.handle(new Request(`${BASE}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
  const s = await ramp.sessions.create({ userId: 'u', country: 'US', destination: DEST })
  await call(`/sessions/${s.id}/plan`, s.clientSecret, {})
  const q = await (await call(`/sessions/${s.id}/quotes`, s.clientSecret, { method: 'card', amount: '10' })).json()
  const sel = await (await call(`/sessions/${s.id}/select`, s.clientSecret, { quoteId: q.quotes[0].id })).json()
  const hook = async (evs: LegEvent[]) => {
    const r = await ramp.handle(new Request(`${BASE}/webhooks/kyc`, { method: 'POST', body: JSON.stringify(evs) }))
    expect(r.status).toBe(200)
    return (await call(`/sessions/${s.id}`, s.clientSecret)).json()
  }
  return { s, sel, hook, ramp, store }
}

describe('a provider event keeps a leg in KYC', () => {
  it('requires_action kyc, then a KYC review (processing in phase kyc), then the payment', async () => {
    const { sel, hook } = await kycSession()
    expect(sel).toMatchObject({ status: 'requires_action', step: { state: 'KYC', detail: { code: 'kyc_verify' }, surface: { kind: 'REDIRECT' } } })
    const review = await hook([{ ref: 'k-1', status: 'processing', phase: 'kyc', detail: { code: 'kyc_review', providerStatus: 'UNDER_REVIEW' } }])
    expect(review).toMatchObject({ status: 'processing', step: { state: 'KYC', detail: { code: 'kyc_review', providerStatus: 'UNDER_REVIEW' } } })
    expect(review.step.surface).toBeUndefined()
    expect(review.step.transitions).toEqual([expect.objectContaining({ kind: 'AWAIT' })])
    const pay = await hook([{ ref: 'k-1', status: 'requires_action', action: { kind: 'payment', surface: { kind: 'REDIRECT', url: 'https://provider.test/pay', popup: true }, transitions: [] } }])
    // A review step (phase kyc, no money moved) may end with a step for the user.
    expect(pay).toMatchObject({ status: 'requires_action', step: { state: 'PAYMENT', surface: { kind: 'REDIRECT' } } })
    const done = await hook([{ ref: 'k-1', status: 'succeeded', providerRef: 'KYC-ORDER-9', transactions: [{ role: 'destination', hash: H1 }] }])
    expect(done).toMatchObject({
      status: 'succeeded',
      payment: { attempt: 0, provider: 'KYC Provider', activeLeg: 0, legs: [{ index: 0, adapterId: 'kyc', provider: 'KYC Provider', ref: 'k-1', providerRef: 'KYC-ORDER-9', status: 'succeeded' }] },
      result: { transactions: [{ role: 'destination', chain: 'eip155:8453', hash: H1, legIndex: 0 }] },
    })
  })

  it('drops a detail code that is not in the list, and an action on a step that is not requires_action', async () => {
    const { hook } = await kycSession()
    const s = await hook([{ ref: 'k-1', status: 'processing', detail: { code: 'WAITING' as never }, action: { kind: 'payment', transitions: [] } }])
    expect(s.step.state).toBe('PROCESSING')
    expect(s.step.detail).toBeUndefined()
  })

  it('a failure after a submitted transaction is final; after an approval only it is a failed attempt', async () => {
    const a = await kycSession()
    await a.hook([{ ref: 'k-1', status: 'requires_action', action: { kind: 'payment', transitions: [] }, transactions: [{ role: 'approval', hash: H1 }] }])
    const retry = await a.hook([{ ref: 'k-1', status: 'failed' }])
    expect(retry.status).toBe('requires_payment_method')
    const b = await kycSession()
    await b.hook([{ ref: 'k-1', status: 'requires_action', action: { kind: 'payment', transitions: [] }, transactions: [{ role: 'source', hash: H2 }] }])
    const final = await b.hook([{ ref: 'k-1', status: 'failed' }])
    expect(final.status).toBe('failed')
  })

  it('the admin finds a session by any transaction hash of any role', async () => {
    const { s, hook, ramp } = await kycSession()
    await hook([{ ref: 'k-1', status: 'processing', transactions: [{ role: 'source', hash: H1 }] }])
    await hook([{ ref: 'k-1', status: 'succeeded', transactions: [{ role: 'destination', hash: H2 }] }])
    for (const h of [H1, H2, H2.toUpperCase().replace('0X', '0x')]) expect((await ramp.admin.findByTx(undefined, h)).map((x) => x.id)).toEqual([s.id])
    expect(await ramp.admin.findByTx('eip155:1', H1)).toEqual([])
    const view = (await ramp.admin.get(s.id))!
    expect(view.transactions.map((t) => t.role)).toEqual(['source', 'destination'])
    expect(view.payment!.legs[0]!.transactions).toHaveLength(2)
  })
})

describe('a status poll that repeats the provider REDIRECT', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('is no change: no new start URL and no write', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-09T12:00:00Z'), toFake: ['Date'] })
    const spec: LegSpec = {
      id: 'card', kind: 'fiat_onramp', methods: ['card'],
      from: { asset: { kind: 'fiat', currencies: '*' }, location: ['user_account'] },
      to: { asset: { kind: 'crypto', chains: { 'eip155:8453': [USDC['eip155:8453']!] } }, location: ['address'] },
      regions: { allow: ['*'], deny: [] }, eta: { min: 1, max: 2 }, surfaces: ['REDIRECT'],
    }
    const action = { kind: 'payment' as const, surface: { kind: 'REDIRECT' as const, url: 'https://provider.test/pay?o=1', popup: true }, transitions: [] }
    const a = createAdapter({
      id: 'redir', name: 'Redirect', legs: [spec],
      async quote({ leg, amountIn }) {
        return { adapterId: 'redir', legId: leg.legId, input: amountIn!, output: { value: '9', asset: { kind: 'crypto', chain: 'eip155:8453', token: USDC['eip155:8453']! } }, fees: [], eta: { min: 1, max: 2 }, guarantee: 'estimate', expiresAt: new Date(Date.now() + 60_000).toISOString() }
      },
      async start() {
        return { status: 'requires_action', ref: 'o-1', action }
      },
      async status({ ref }) {
        return { status: 'requires_action', ref, action }
      },
    })
    const store = memoryStore()
    const ramp = createOpenRamp({ secret: 's'.repeat(40), baseUrl: BASE, adapters: [a], logger: quiet, store })
    const call = (path: string, secret: string, body?: unknown) =>
      ramp.handle(new Request(`${BASE}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
    const s = await ramp.sessions.create({ userId: 'u', country: 'US', destination: DEST })
    await call(`/sessions/${s.id}/plan`, s.clientSecret, {})
    const q = await (await call(`/sessions/${s.id}/quotes`, s.clientSecret, { method: 'card', amount: '10' })).json()
    await call(`/sessions/${s.id}/select`, s.clientSecret, { quoteId: q.quotes[0].id })
    const before = (await store.get(s.id))!
    for (let i = 1; i <= 3; i++) {
      vi.setSystemTime(Date.parse('2026-10-09T12:00:00Z') + i * 10_000)
      expect((await call(`/sessions/${s.id}/step`, s.clientSecret)).status).toBe(200)
    }
    const after = (await store.get(s.id))!
    expect(Object.keys(after.startUrls)).toEqual(Object.keys(before.startUrls))
    expect(after.step.surface).toEqual(before.step.surface)
  })
})
