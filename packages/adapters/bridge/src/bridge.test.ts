import { describe, expect, it } from 'vitest'
import { checkAdapterShape, checkLegQuote, checkLegStep, erc20TransferData } from '@openrampkit/adapter'
import type { AdapterContext } from '@openrampkit/adapter'
import { fakeFetch, makeCtx, makeWebhookCtx, memoryKV, recordingLog, runAdapterConformance } from '@openrampkit/adapter/testing'
import type { FakeRoute } from '@openrampkit/adapter/testing'
import { USDC, stateFor } from '@openrampkit/core'
import type { Amount, LegQuote, LegStep, PathwayLeg } from '@openrampkit/core'
import { BRIDGE_DENY, bridge, importBridgePublicKey, parseBridgeSignature, verifyBridgeSignature } from './index.js'
import type { BridgeOptions } from './index.js'

const BASE_USDC = USDC['eip155:8453']!
const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
const WALLET = '0x000000000000000000000000000000000000beef'
const API = 'https://api.bridge.xyz/v0'

/** A step with its UI phase (`stateFor`), for assertions */
const ui = (step: LegStep) => ({ ...step, state: stateFor(step) })

// ---------- webhook keys ----------

function b64(bytes: ArrayBuffer): string {
  let s = ''
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b)
  return btoa(s)
}

async function keyPair() {
  const kp = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )
  const der = b64(await crypto.subtle.exportKey('spki', kp.publicKey))
  const pem = `-----BEGIN PUBLIC KEY-----\n${der.match(/.{1,64}/g)!.join('\n')}\n-----END PUBLIC KEY-----\n`
  return { pem, privateKey: kp.privateKey }
}

/** Bridge's scheme: RSA PKCS#1 v1.5 with SHA-256 over SHA-256(`${t}.${body}`) */
async function sign(privateKey: CryptoKey, body: string, t = Date.now()): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${t}.${body}`))
  const sig = await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, privateKey, digest)
  return `t=${t},v0=${b64(sig)}`
}

const KEYS = await keyPair()
const OTHER_KEYS = await keyPair()
const SIGNED = await sign(KEYS.privateKey, JSON.stringify({ event_category: 'transfer', event_object: { id: 'tr_1', client_reference_id: 'brg_1', state: 'payment_processed', receipt: { final_amount: '25' } } }))

// ---------- fixtures ----------

const depositLeg = (legId: string, currency: string, chain = 'eip155:8453', token = BASE_USDC): PathwayLeg => ({
  adapterId: 'bridge',
  legId,
  from: { asset: { kind: 'fiat', currency }, location: { kind: 'user_account' } },
  to: { asset: { kind: 'crypto', chain, token }, location: { kind: 'address', address: WALLET } },
})

const payoutLeg = (legId: string, currency: string, chain = 'eip155:8453', token = BASE_USDC): PathwayLeg => ({
  adapterId: 'bridge',
  legId,
  from: { asset: { kind: 'crypto', chain, token }, location: { kind: 'user_wallet' } },
  to: { asset: { kind: 'fiat', currency }, location: { kind: 'user_account' } },
})

const fiat = (amount: string, currency: string) => ({ value: amount, asset: { kind: 'fiat' as const, currency } })
const usdc = (amount: string, chain = 'eip155:8453', token = BASE_USDC) => ({ value: amount, asset: { kind: 'crypto' as const, chain, token } })

const USD_INSTRUCTIONS = {
  currency: 'usd',
  bank_name: 'Lead Bank',
  bank_address: '1801 Main St., Kansas City, MO 64108',
  bank_routing_number: '101019644',
  bank_account_number: '900123456789',
  bank_beneficiary_name: 'Jane Doe',
  payment_rails: ['ach_push', 'wire'],
}

const now = () => new Date().toISOString()
const active = (endorsements = [{ name: 'base', status: 'approved' }, { name: 'sepa', status: 'approved' }, { name: 'pix', status: 'approved' }]) => ({ id: 'cust_1', status: 'active', endorsements })

const opts = (over: Partial<BridgeOptions> = {}): BridgeOptions => ({ apiKey: 'sk-live-x', webhookPublicKey: KEYS.pem, ...over })

function ctxWith(routes: FakeRoute[], over: Partial<Parameters<typeof makeCtx>[0]> = {}) {
  const ff = fakeFetch(routes)
  const shared = over.shared ?? memoryKV()
  const ctx = makeCtx({ fetch: ff.fetch, shared, ...over })
  return { ...ff, ctx, shared }
}

async function quoteAndStart(a: ReturnType<typeof bridge>, leg: PathwayLeg, ctx: AdapterContext, amount: Amount = fiat('100', 'USD'), extra: Record<string, unknown> = {}) {
  const q = await a.quote({ leg, amountIn: amount }, ctx)
  const s = await a.start({ leg, quote: q, ...extra }, ctx)
  return { q, s }
}

// ---------- tests ----------

describe('bridge adapter: shape and quotes', () => {
  const a = bridge(opts())

  it('declares deposit and payout legs that pass the shape check', () => {
    expect(checkAdapterShape(a)).toEqual([])
    expect(a.legs.map((l) => l.id)).toEqual(['usd-ach', 'usd-wire', 'eur-sepa', 'mxn-spei', 'brl-pix', 'gbp-fps', 'payout-usd-ach', 'payout-usd-wire', 'payout-eur-sepa'])
    expect(a.legs.find((l) => l.id === 'usd-ach')).toMatchObject({ kind: 'fiat_onramp', methods: ['ach'], requires: ['provider_kyc'], regions: { allow: ['*'], deny: BRIDGE_DENY } })
    expect(a.legs.find((l) => l.id === 'brl-pix')!.surfaces).toContain('QR')
    expect(a.legs.find((l) => l.id === 'eur-sepa')!.surfaces).toContain('BANK_FIELDS')
    expect(a.legs.find((l) => l.id === 'payout-eur-sepa')).toMatchObject({ kind: 'crypto_offramp', methods: ['sepa'], surfaces: ['FORM', 'WALLET_TX', 'REDIRECT'] })
    expect(BRIDGE_DENY).toEqual(expect.arrayContaining(['US-NY', 'JP', 'CN', 'RU', 'KP']))
  })

  it('filters legs and withdraw, and refuses bad options', () => {
    expect(bridge(opts({ legs: ['eur-sepa'] })).legs.map((l) => l.id)).toEqual(['eur-sepa'])
    expect(bridge(opts({ withdraw: false })).legs.some((l) => l.kind === 'crypto_offramp')).toBe(false)
    expect(() => bridge(opts({ legs: ['nope'] }))).toThrow(/selects no known leg/)
    expect(() => bridge(opts({ developerFeePercent: 'abc' }))).toThrow(/decimal/)
  })

  it('quotes USD 1:1 with the Bridge and app fees, without a network call', async () => {
    const b = bridge(opts({ developerFeePercent: '0.5', bridgeFeeBps: 50 }))
    const { ctx, calls } = ctxWith([])
    const q = await b.quote({ leg: depositLeg('usd-ach', 'USD'), amountIn: fiat('200', 'USD') }, ctx)
    expect(checkLegQuote(q)).toEqual([])
    expect(q.input).toEqual(fiat('200.00', 'USD'))
    expect(q.output.value).toBe('198.000000')
    expect(q.output.asset).toMatchObject({ kind: 'crypto', chain: 'eip155:8453', token: BASE_USDC, symbol: 'USDC', decimals: 6 })
    expect(q.fees).toEqual([
      { kind: 'provider', label: 'Bridge fee', amount: { value: '1.00', asset: { kind: 'fiat', currency: 'USD' } }, included: true },
      { kind: 'app', label: 'App fee', amount: { value: '1.00', asset: { kind: 'fiat', currency: 'USD' } }, included: true },
    ])
    // no rate lock: the output is an estimate
    expect(q.guarantee).toBe('estimate')
    expect(q.minOutput).toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  it('quotes EUR with the exchange rate (cached), and exact output rounds the input up', async () => {
    const { ctx, calls } = ctxWith([{ method: 'GET', match: '/exchange_rates', reply: () => ({ midmarket_rate: '1.09', buy_rate: '1.08', sell_rate: '1.07' }) }])
    const q = await a.quote({ leg: depositLeg('eur-sepa', 'EUR'), amountIn: fiat('100', 'EUR') }, ctx)
    expect(q.output.value).toBe('108.000000')
    // Bridge's FX fee is in the rate, and Bridge does not say how much
    expect(q.fees).toEqual([{ kind: 'provider', label: 'FX fee in the rate', amount: null, included: true }])
    expect(q.guarantee).toBe('estimate')
    expect(checkLegQuote(q)).toEqual([])
    expect(calls[0]!.url).toBe(`${API}/exchange_rates?from=eur&to=usd`)
    expect(calls[0]!.headers.get('api-key')).toBe('sk-live-x')
    expect(calls[0]!.headers.get('idempotency-key')).toBeNull()
    const q2 = await a.quote({ leg: depositLeg('eur-sepa', 'EUR'), amountOut: usdc('100') }, ctx)
    expect(q2.input.value).toBe('92.60') // 100 / 1.08 = 92.592..., rounded up
    expect(calls).toHaveLength(1) // cached rate
  })

  it('quotes payouts from USDC to USD and EUR', async () => {
    const { ctx, calls } = ctxWith([{ method: 'GET', match: '/exchange_rates', reply: () => ({ buy_rate: '0.9' }) }])
    const q = await a.quote({ leg: payoutLeg('payout-usd-ach', 'USD'), amountIn: usdc('50') }, ctx)
    expect(q.input.value).toBe('50.000000')
    expect(q.output).toEqual(fiat('50.00', 'USD'))
    expect(q).toMatchObject({ fees: [], guarantee: 'estimate' })
    const e = await a.quote({ leg: payoutLeg('payout-eur-sepa', 'EUR'), amountIn: usdc('50') }, ctx)
    expect(e.output).toEqual(fiat('45.00', 'EUR'))
    expect(e.fees).toEqual([{ kind: 'provider', label: 'FX fee in the rate', amount: null, included: true }])
    expect(calls[0]!.url).toBe(`${API}/exchange_rates?from=usd&to=eur`)
    const o = await a.quote({ leg: payoutLeg('payout-usd-wire', 'USD'), amountOut: fiat('20', 'USD') }, ctx)
    expect(o.input.value).toBe('20.000000')
  })

  it('enforces limits, legs and networks', async () => {
    const { ctx } = ctxWith([{ method: 'GET', match: '/exchange_rates', reply: () => ({ buy_rate: '0.05' }) }])
    await expect(a.quote({ leg: depositLeg('usd-ach', 'USD'), amountIn: fiat('0.5', 'USD') }, ctx)).rejects.toMatchObject({ error: { code: 'AMOUNT_TOO_LOW' } })
    await expect(a.quote({ leg: depositLeg('mxn-spei', 'MXN'), amountIn: fiat('20', 'MXN') }, ctx)).rejects.toMatchObject({ error: { code: 'AMOUNT_TOO_LOW', message: expect.stringContaining('50 MXN') } })
    await expect(a.quote({ leg: payoutLeg('payout-usd-ach', 'USD'), amountIn: usdc('0.1') }, ctx)).rejects.toMatchObject({ error: { code: 'AMOUNT_TOO_LOW' } })
    await expect(a.quote({ leg: depositLeg('xx', 'USD'), amountIn: fiat('10', 'USD') }, ctx)).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
    await expect(a.quote({ leg: depositLeg('usd-ach', 'USD', 'eip155:56', '0xabc'), amountIn: fiat('10', 'USD') }, ctx)).rejects.toMatchObject({ error: { code: 'NO_QUOTES' } })
  })

  it('maps HTTP errors and uses the sandbox URL', async () => {
    const s = bridge(opts({ env: 'sandbox' }))
    for (const [status, code] of [[429, 'RATE_LIMITED'], [500, 'PROVIDER_UNAVAILABLE'], [400, 'NO_QUOTES']] as const) {
      const { ctx, calls } = ctxWith([{ match: '/exchange_rates', status, reply: () => ({ code: 'x', message: 'nope' }) }])
      await expect(s.quote({ leg: depositLeg('eur-sepa', 'EUR'), amountIn: fiat('10', 'EUR') }, ctx)).rejects.toMatchObject({ error: { code } })
      expect(calls[0]!.url.startsWith('https://api.sandbox.bridge.xyz/v0/')).toBe(true)
    }
    const { ctx } = ctxWith([{ match: '/exchange_rates', reply: () => ({ buy_rate: '0' }) }])
    await expect(a.quote({ leg: depositLeg('eur-sepa', 'EUR'), amountIn: fiat('10', 'EUR') }, ctx)).rejects.toMatchObject({ error: { code: 'NO_QUOTES' } })
  })
})

describe('bridge adapter: deposits', () => {
  it('asks for name and email, creates a KYC link, sends the user to the ToS and KYC pages, then shows bank details', async () => {
    let link: Record<string, unknown> = { id: 'kyc_1', customer_id: null, kyc_link: 'https://bridge.test/kyc', tos_link: 'https://bridge.test/tos', kyc_status: 'not_started', tos_status: 'pending' }
    let history: unknown[] = []
    const { ctx, calls } = ctxWith([
      { method: 'POST', match: '/kyc_links', reply: () => link },
      { method: 'GET', match: '/kyc_links/kyc_1', reply: () => link },
      { method: 'GET', match: /\/customers\/cust_1$/, reply: () => active() },
      { method: 'POST', match: '/customers/cust_1/virtual_accounts', reply: () => ({ id: 'va_1', status: 'activated', source_deposit_instructions: USD_INSTRUCTIONS }) },
      { method: 'GET', match: '/virtual_accounts/va_1/history', reply: () => ({ count: history.length, data: history }) },
    ])
    const a = bridge(opts())
    const leg = depositLeg('usd-ach', 'USD')
    const { s } = await quoteAndStart(a, leg, ctx)
    expect(checkLegStep(s)).toEqual([])
    expect(ui(s)).toMatchObject({ state: 'KYC', detail: { code: 'kyc_details' }, status: 'requires_action', action: { kind: 'kyc', surface: { kind: 'FORM' } } })
    expect((s.action?.surface as { fields: Array<{ id: string }> }).fields.map((f) => f.id)).toEqual(['full_name', 'email'])
    const ref = s.ref!
    expect(ref).toMatch(/^brg_/)

    await expect(a.transition!({ leg, ref, name: 'submit_kyc', inputs: { full_name: 'J', email: 'jane@example.com' } }, ctx)).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
    await expect(a.transition!({ leg, ref, name: 'submit_kyc', inputs: { full_name: 'Jane Doe', email: 'nope' } }, ctx)).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
    const tos = await a.transition!({ leg, ref, name: 'submit_kyc', inputs: { full_name: 'Jane Doe', email: 'jane@example.com' } }, ctx)
    expect(ui(tos)).toMatchObject({ state: 'KYC', detail: { code: 'kyc_terms' }, action: { kind: 'kyc', surface: { kind: 'REDIRECT', url: 'https://bridge.test/tos', popup: true, provider: 'Bridge' } } })
    expect(checkLegStep(tos)).toEqual([])
    const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/kyc_links'))!
    expect(post.url).toBe(`${API}/kyc_links`)
    expect(post.headers.get('idempotency-key')).toBe(`sess_1:bridge:kyc:${ref}`)
    expect(post.body).toEqual({ full_name: 'Jane Doe', email: 'jane@example.com', type: 'individual', endorsements: ['base'], redirect_uri: 'https://app.test/api/openramp/return' })

    link = { ...link, tos_status: 'approved' }
    expect(ui(await a.status!({ leg, ref }, ctx))).toMatchObject({ state: 'KYC', detail: { code: 'kyc_verify' }, action: { kind: 'kyc', surface: { kind: 'REDIRECT', url: 'https://bridge.test/kyc' } } })
    link = { ...link, kyc_status: 'under_review', customer_id: 'cust_1' }
    // The review: processing in the KYC phase, with no action.
    const review = await a.status!({ leg, ref }, ctx)
    expect(ui(review)).toMatchObject({ state: 'KYC', status: 'processing', phase: 'kyc', detail: { code: 'kyc_review' } })
    expect(review.action).toBeUndefined()
    expect(checkLegStep(review)).toEqual([])

    link = { ...link, kyc_status: 'approved' }
    const pay = await a.status!({ leg, ref }, ctx)
    expect(checkLegStep(pay)).toEqual([])
    expect(ui(pay)).toMatchObject({ state: 'PAYMENT', detail: { code: 'bank_details' }, status: 'requires_action', action: { kind: 'payment' }, ref })
    const fields = (pay.action?.surface as { kind: string; fields: Array<{ label: string; value: string; copy: boolean }> })
    expect(fields.kind).toBe('BANK_FIELDS')
    expect(fields.fields).toEqual(expect.arrayContaining([
      { label: 'Amount', value: '100.00 USD', copy: true },
      { label: 'Routing number', value: '101019644', copy: true },
      { label: 'Account number', value: '900123456789', copy: true },
      { label: 'Bank name', value: 'Lead Bank', copy: false },
    ]))
    const va = calls.find((c) => c.method === 'POST' && c.url.includes('/virtual_accounts'))!
    expect(va.url).toBe(`${API}/customers/cust_1/virtual_accounts`)
    expect(va.body).toEqual({ source: { currency: 'usd' }, destination: { currency: 'usdc', payment_rail: 'base', address: WALLET } })
    expect(va.headers.get('idempotency-key')).toBe(`sess_1:bridge:va:${ref}`)

    // No deposit yet: still the bank details. Old deposits (before the session) are ignored.
    history = [{ id: 'e0', type: 'payment_processed', deposit_id: 'dep_old', amount: '5', created_at: '2020-01-01T00:00:00.000Z' }]
    expect(ui(await a.status!({ leg, ref }, ctx))).toMatchObject({ state: 'PAYMENT', action: { surface: { kind: 'BANK_FIELDS' } } })
    history = [...history, { id: 'e1', type: 'funds_received', deposit_id: 'dep_1', amount: '100', created_at: now() }]
    expect(ui(await a.status!({ leg, ref }, ctx))).toMatchObject({ state: 'PROCESSING', status: 'processing', providerRef: 'dep_1', detail: { code: 'settling', providerStatus: 'funds_received' }, poll: { intervalMs: 5000 } })
    // A virtual account event type that is not in the table does not move the deposit (never processing by default).
    history = [...history, { id: 'e1b', type: 'something_new', deposit_id: 'dep_1', created_at: now() }]
    expect(ui(await a.status!({ leg, ref }, ctx))).toMatchObject({ state: 'PROCESSING', detail: { providerStatus: 'funds_received' } })
    history = [...history, { id: 'e2', type: 'payment_processed', deposit_id: 'dep_1', amount: '99.5', destination_tx_hash: '0xabc', created_at: now() }]
    const done = await a.status!({ leg, ref }, ctx)
    expect(ui(done)).toMatchObject({ state: 'COMPLETED', status: 'succeeded', providerRef: 'dep_1', transactions: [{ role: 'destination', chain: 'eip155:8453', hash: '0xabc' }], output: { value: '99.5', asset: { kind: 'crypto', chain: 'eip155:8453', token: BASE_USDC } } })
    expect(checkLegStep(done)).toEqual([])
    // The ids are stored, the email from the form is not.
    expect(JSON.stringify([...((ctx.shared as unknown as { data: Map<string, unknown> }).data.values())])).not.toContain('jane@example.com')
  })

  it('uses a known customer from the hook, reuses the virtual account across sessions, and gives each deposit to one session', async () => {
    const shared = memoryKV()
    let history: unknown[] = []
    const routes: FakeRoute[] = [
      { method: 'GET', match: /\/customers\/cust_1$/, reply: () => active() },
      { method: 'POST', match: '/virtual_accounts', reply: () => ({ id: 'va_1', source_deposit_instructions: USD_INSTRUCTIONS }) },
      { method: 'GET', match: '/history', reply: () => ({ count: history.length, data: history }) },
    ]
    const seen: Array<{ userId: string; email?: string }> = []
    const a = bridge(opts({ customer: async (u) => (seen.push(u), { customerId: 'cust_1' }) }))
    const leg = depositLeg('usd-wire', 'USD')
    const one = ctxWith(routes, { shared, session: { email: 'jane@example.com' } })
    const s1 = (await quoteAndStart(a, leg, one.ctx)).s
    expect(ui(s1)).toMatchObject({ state: 'PAYMENT', action: { kind: 'payment', surface: { kind: 'BANK_FIELDS' } } })
    expect(seen[0]).toEqual({ userId: 'user_1', email: 'jane@example.com' })
    const two = ctxWith(routes, { shared, session: { id: 'sess_2' } })
    const s2 = (await quoteAndStart(a, leg, two.ctx)).s
    expect(stateFor(s2)).toBe('PAYMENT')
    expect([...one.calls, ...two.calls].filter((c) => c.method === 'POST')).toHaveLength(1)

    history = [{ id: 'e1', type: 'payment_submitted', deposit_id: 'dep_1', amount: '10', created_at: now() }]
    expect(stateFor(await a.status!({ leg, ref: s1.ref! }, one.ctx))).toBe('PROCESSING')
    // The second session does not take the first session's deposit.
    expect(stateFor(await a.status!({ leg, ref: s2.ref! }, two.ctx))).toBe('PAYMENT')
  })

  it('shows a Pix QR for BRL and maps refunds', async () => {
    let history: unknown[] = []
    const { ctx } = ctxWith([
      { method: 'GET', match: '/exchange_rates', reply: () => ({ buy_rate: '0.18' }) },
      { method: 'GET', match: /\/customers\/cust_1$/, reply: () => active() },
      { method: 'POST', match: '/virtual_accounts', reply: () => ({ id: 'va_2', source_deposit_instructions: { currency: 'brl', br_code: '00020126580014br.gov.bcb.pix', account_holder_name: 'Jane' } }) },
      { method: 'GET', match: '/history', reply: () => ({ data: history }) },
    ])
    const a = bridge(opts({ customer: async () => ({ customerId: 'cust_1' }) }))
    const leg = depositLeg('brl-pix', 'BRL')
    const { s } = await quoteAndStart(a, leg, ctx, fiat('500', 'BRL'))
    expect(s.action?.surface).toEqual({ kind: 'QR', payload: '00020126580014br.gov.bcb.pix', amount: '500.00', currency: 'BRL', method: 'pix' })
    for (const [type, state] of [['refund_in_flight', 'PROCESSING'], ['refund', 'REFUNDED'], ['refunded', 'REFUNDED'], ['refund_failed', 'FAILED'], ['microdeposit', 'PAYMENT']] as const) {
      history = [{ id: `e-${type}`, type, deposit_id: 'dep_9', created_at: now() }]
      const st = await a.status!({ leg, ref: s.ref! }, ctx)
      expect(stateFor(st)).toBe(state)
      expect(checkLegStep(st)).toEqual([])
    }
  })

  it('fails on rejected KYC and on paused customers; waits on review; sends the user back for a missing endorsement', async () => {
    const leg = depositLeg('eur-sepa', 'EUR')
    const rate: FakeRoute = { method: 'GET', match: '/exchange_rates', reply: () => ({ buy_rate: '1.1' }) }
    const run = async (customer: unknown, link?: unknown) => {
      const { ctx } = ctxWith([rate, { method: 'GET', match: /\/customers\/cust_1$/, reply: () => customer }, { method: 'GET', match: '/kyc_links/', reply: () => link }])
      if (link) await ctx.shared.put('user:user_1', { ...((link as { customer_id?: string }).customer_id ? { customerId: 'cust_1' } : {}), kycLinkId: 'kyc_1' })
      const a = bridge(opts({ customer: async () => (link ? undefined : { customerId: 'cust_1' }) }))
      return (await quoteAndStart(a, leg, ctx, fiat('100', 'EUR'))).s
    }
    expect(ui(await run({ id: 'cust_1', status: 'rejected' }))).toMatchObject({ state: 'FAILED', error: { code: 'KYC_REJECTED' } })
    expect(ui(await run({ id: 'cust_1', status: 'paused' }))).toMatchObject({ state: 'FAILED', error: { code: 'PROVIDER_DECLINED' } })
    expect(ui(await run({ id: 'cust_1', status: 'under_review' }))).toMatchObject({ state: 'KYC', status: 'processing', phase: 'kyc', detail: { code: 'kyc_review' } })
    expect(ui(await run({ id: 'cust_1', status: 'active', endorsements: [{ name: 'sepa', status: 'revoked' }] }))).toMatchObject({ state: 'FAILED', error: { code: 'KYC_REJECTED' } })
    const link = { id: 'kyc_1', customer_id: 'cust_1', kyc_link: 'https://bridge.test/kyc', tos_status: 'approved', kyc_status: 'approved' }
    expect(ui(await run({ id: 'cust_1', status: 'active', endorsements: [{ name: 'base', status: 'approved' }, { name: 'sepa', status: 'incomplete' }] }, link))).toMatchObject({ state: 'KYC', detail: { code: 'kyc_verify' }, action: { kind: 'kyc', surface: { kind: 'REDIRECT', url: 'https://bridge.test/kyc' } } })
    expect(ui(await run({ id: 'cust_1', status: 'active' }, { ...link, customer_id: null, kyc_status: 'rejected' }))).toMatchObject({ state: 'FAILED' })
    // A KYC link status that is not in the table: the KYC page (Bridge shows what is left), not a review or processing.
    expect(ui(await run({ id: 'cust_1', status: 'active' }, { ...link, customer_id: null, kyc_status: 'something_new' }))).toMatchObject({ state: 'KYC', status: 'requires_action', detail: { code: 'kyc_verify' } })
  })

  it('creates the KYC link at once when the hook gives name and email, and refuses unsafe links', async () => {
    const reply = (url: string) => () => ({ id: 'kyc_2', kyc_link: url, tos_link: url, kyc_status: 'not_started', tos_status: 'pending' })
    const a = bridge(opts({ customer: async () => ({ fullName: 'Jane Doe', email: 'jane@example.com' }) }))
    const ok = ctxWith([{ method: 'POST', match: '/kyc_links', reply: reply('https://bridge.test/tos') }])
    expect(ui((await quoteAndStart(a, depositLeg('usd-ach', 'USD'), ok.ctx)).s)).toMatchObject({ state: 'KYC', action: { kind: 'kyc', surface: { kind: 'REDIRECT' } } })
    expect(await ok.ctx.shared.get('user:user_1')).toEqual({ kycLinkId: 'kyc_2' })
    const bad = ctxWith([{ method: 'POST', match: '/kyc_links', reply: reply('javascript:alert(1)') }])
    await expect(quoteAndStart(a, depositLeg('usd-ach', 'USD'), bad.ctx)).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
  })

  it('refuses unknown refs and transitions', async () => {
    const a = bridge(opts())
    const { ctx } = ctxWith([])
    await expect(a.status!({ leg: depositLeg('usd-ach', 'USD'), ref: 'brg_x' }, ctx)).rejects.toMatchObject({ error: { code: 'NOT_FOUND' } })
    const { s } = await quoteAndStart(a, depositLeg('usd-ach', 'USD'), ctx)
    await expect(a.transition!({ leg: depositLeg('usd-ach', 'USD'), ref: s.ref!, name: 'nope' }, ctx)).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
    await expect(a.transition!({ leg: depositLeg('usd-ach', 'USD'), ref: s.ref!, name: 'submit_tx' }, ctx)).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
  })
})

describe('bridge adapter: payouts', () => {
  function payoutRoutes(state: { transfer: Record<string, unknown> }): FakeRoute[] {
    return [
      { method: 'GET', match: '/exchange_rates', reply: () => ({ buy_rate: '0.9' }) },
      { method: 'GET', match: /\/customers\/cust_1$/, reply: () => active() },
      { method: 'POST', match: '/external_accounts', reply: () => ({ id: 'ea_1' }) },
      { method: 'POST', match: '/transfers', reply: () => state.transfer },
      { method: 'GET', match: '/transfers/tr_1', reply: () => state.transfer },
    ]
  }
  const usInputs = {
    first_name: 'Jane', last_name: 'Doe', bank_name: 'Chase', routing_number: '021000021', account_number: '123456789',
    checking_or_savings: 'checking', street_line_1: '1 Main St', city: 'Austin', postal_code: '73301', state: 'tx',
  }

  it('asks for the US bank account, creates it and a transfer, asks for the USDC, and completes', async () => {
    const state = { transfer: { id: 'tr_1', state: 'awaiting_funds', source_deposit_instructions: { to_address: '0x00000000000000000000000000000000000000aa', amount: '50.0', currency: 'usdc', payment_rail: 'base' } } as Record<string, unknown> }
    const { ctx, calls } = ctxWith(payoutRoutes(state), { session: { direction: 'withdraw' }, destination: { type: 'fiat', currency: 'USD' } })
    const a = bridge(opts({ customer: async () => ({ customerId: 'cust_1' }), developerFeePercent: '1' }))
    const leg = payoutLeg('payout-usd-ach', 'USD')
    const { q, s } = await quoteAndStart(a, leg, ctx, usdc('50'), { source: { chain: 'eip155:8453', token: BASE_USDC, address: '0x00000000000000000000000000000000000000f0' } })
    expect(q.output).toEqual(fiat('49.50', 'USD'))
    expect(ui(s)).toMatchObject({ state: 'PAYMENT', detail: { code: 'payout_account' }, action: { kind: 'payment', surface: { kind: 'FORM' }, transitions: [{ name: 'submit_details', kind: 'SUBMIT' }] } })
    const ref = s.ref!
    // The status before the account is set shows the form again.
    expect((await a.status!({ leg, ref }, ctx)).detail?.code).toBe('payout_account')
    await expect(a.transition!({ leg, ref, name: 'submit_tx', inputs: { txHash: '0x1' } }, ctx)).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
    await expect(a.transition!({ leg, ref, name: 'submit_details', inputs: { ...usInputs, routing_number: '12' } }, ctx)).rejects.toMatchObject({ error: { message: expect.stringContaining('routing') } })
    await expect(a.transition!({ leg, ref, name: 'submit_details', inputs: { ...usInputs, city: '' } }, ctx)).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })

    const send = await a.transition!({ leg, ref, name: 'submit_details', inputs: usInputs }, ctx)
    expect(checkLegStep(send)).toEqual([])
    expect(ui(send)).toMatchObject({ state: 'PAYMENT', detail: { code: 'send_crypto' }, providerRef: 'tr_1', action: { kind: 'payment', surface: { kind: 'WALLET_TX', chain: 'eip155:8453' }, transitions: [{ name: 'submit_tx', kind: 'SURFACE_RESULT', expects: 'tx_hash' }] } })
    expect((send.action?.surface as { txs: unknown[] }).txs).toEqual([{ to: BASE_USDC, data: erc20TransferData('0x00000000000000000000000000000000000000aa', '50000000'), value: '0', chainId: 8453 }])
    const ea = calls.find((c) => c.url.endsWith('/external_accounts'))!
    expect(ea.url).toBe(`${API}/customers/cust_1/external_accounts`)
    expect(ea.headers.get('idempotency-key')).toBe(`sess_1:bridge:ea:${ref}`)
    expect(ea.body).toMatchObject({ currency: 'usd', account_type: 'us', account_owner_type: 'individual', account: { routing_number: '021000021', account_number: '123456789', checking_or_savings: 'checking' }, address: { state: 'TX', country: 'USA' } })
    const tr = calls.find((c) => c.method === 'POST' && c.url.endsWith('/transfers'))!
    expect(tr.headers.get('idempotency-key')).toBe(`sess_1:bridge:transfer:${ref}`)
    expect(tr.body).toEqual({
      amount: '50.000000', on_behalf_of: 'cust_1', client_reference_id: ref, developer_fee_percent: '1',
      source: { payment_rail: 'base', currency: 'usdc', from_address: '0x00000000000000000000000000000000000000f0' },
      destination: { payment_rail: 'ach', currency: 'usd', external_account_id: 'ea_1' },
    })
    // A second submit does not create a second account.
    await a.transition!({ leg, ref, name: 'submit_details', inputs: usInputs }, ctx)
    expect(calls.filter((c) => c.url.endsWith('/external_accounts'))).toHaveLength(1)

    expect((await a.status!({ leg, ref }, ctx)).detail?.code).toBe('send_crypto')
    const sent = await a.transition!({ leg, ref, name: 'submit_tx', inputs: { txHash: '0xfeed' } }, ctx)
    expect(ui(sent)).toMatchObject({ state: 'PROCESSING', status: 'processing', providerRef: 'tr_1', transactions: [{ role: 'source', chain: 'eip155:8453', hash: '0xfeed' }] })
    expect(checkLegStep(sent)).toEqual([])
    expect(ui(await a.status!({ leg, ref }, ctx))).toMatchObject({ state: 'PROCESSING', detail: { code: 'confirming' } })
    state.transfer = { ...state.transfer, state: 'payment_processed', receipt: { final_amount: '49.5', source_tx_hash: '0xfeed', destination_tx_hash: '0xd' } }
    const paid = await a.status!({ leg, ref }, ctx)
    expect(ui(paid)).toMatchObject({ state: 'COMPLETED', status: 'succeeded', providerRef: 'tr_1', output: fiat('49.5', 'USD') })
    // The source is the user's USDC transfer. A payout delivers fiat: no destination transaction.
    expect(paid.transactions).toEqual([{ role: 'source', chain: 'eip155:8453', hash: '0xfeed' }])
  })

  it('maps every transfer state', async () => {
    const state = { transfer: { id: 'tr_1', state: 'awaiting_funds', source_deposit_instructions: { to_address: '0x00000000000000000000000000000000000000aa' } } as Record<string, unknown> }
    const { ctx } = ctxWith(payoutRoutes(state))
    const a = bridge(opts({ customer: async () => ({ customerId: 'cust_1' }) }))
    const leg = payoutLeg('payout-usd-wire', 'USD')
    const { s } = await quoteAndStart(a, leg, ctx, usdc('10'))
    await a.transition!({ leg, ref: s.ref!, name: 'submit_details', inputs: usInputs }, ctx)
    const cases: Array<[string, string]> = [
      ['in_review', 'PROCESSING'], ['funds_received', 'PROCESSING'], ['payment_submitted', 'PROCESSING'], ['refund_in_flight', 'PROCESSING'],
      ['refunded', 'REFUNDED'], ['canceled', 'FAILED'], ['error', 'FAILED'], ['undeliverable', 'FAILED'], ['returned', 'FAILED'],
      ['refund_failed', 'FAILED'], ['missing_return_policy', 'FAILED'],
    ]
    for (const [st, expected] of cases) {
      state.transfer = { ...state.transfer, state: st }
      const step = await a.status!({ leg, ref: s.ref! }, ctx)
      expect([st, stateFor(step)]).toEqual([st, expected])
      expect(step.providerRef).toBe('tr_1')
      expect(checkLegStep(step)).toEqual([])
    }
  })

  it('a transfer state that is not in the table keeps the last known step (never processing by default)', async () => {
    const state = { transfer: { id: 'tr_1', state: 'awaiting_funds', source_deposit_instructions: { to_address: '0x00000000000000000000000000000000000000aa' } } as Record<string, unknown> }
    const log = recordingLog()
    const { ctx } = ctxWith(payoutRoutes(state), { log })
    const a = bridge(opts({ customer: async () => ({ customerId: 'cust_1' }) }))
    const leg = payoutLeg('payout-usd-ach', 'USD')
    const { s } = await quoteAndStart(a, leg, ctx, usdc('10'))
    await a.transition!({ leg, ref: s.ref!, name: 'submit_details', inputs: usInputs }, ctx)
    // Before any known state: the user still sends the USDC.
    state.transfer = { ...state.transfer, state: 'brand_new_state' }
    const first = await a.status!({ leg, ref: s.ref! }, ctx)
    expect(ui(first)).toMatchObject({ state: 'PAYMENT', status: 'requires_action', detail: { code: 'send_crypto' } })
    expect(log.warnings.filter((w) => w.includes('Bridge transfer: unknown provider status'))).toHaveLength(1)
    // After a known state: that step.
    state.transfer = { ...state.transfer, state: 'refunded' }
    expect((await a.status!({ leg, ref: s.ref! }, ctx)).status).toBe('refunded')
    state.transfer = { ...state.transfer, state: 'funds_received' }
    expect((await a.status!({ leg, ref: s.ref! }, ctx)).status).toBe('processing')
    state.transfer = { ...state.transfer, state: 'another_new_state' }
    const kept = await a.status!({ leg, ref: s.ref! }, ctx)
    expect(ui(kept)).toMatchObject({ state: 'PROCESSING', status: 'processing', providerRef: 'tr_1', detail: { code: 'settling', providerStatus: 'funds_received' } })
    expect(checkLegStep(kept)).toEqual([])
  })

  it('pays out EUR to an IBAN, from Solana USDC, and lets any sender pay when the address is unknown', async () => {
    const state = { transfer: { id: 'tr_1', state: 'awaiting_funds', source_deposit_instructions: { to_address: 'BridgeSoLDepositAddress1111111111111111111', amount: '20' } } as Record<string, unknown> }
    const { ctx, calls } = ctxWith(payoutRoutes(state))
    const a = bridge(opts({ customer: async () => ({ customerId: 'cust_1' }) }))
    const leg = payoutLeg('payout-eur-sepa', 'EUR', SOLANA, USDC[SOLANA]!)
    const { s } = await quoteAndStart(a, leg, ctx, usdc('20', SOLANA, USDC[SOLANA]!))
    expect((s.action?.surface as { fields: Array<{ id: string }> }).fields.map((f) => f.id)).toContain('iban')
    const inputs = { first_name: 'Jan', last_name: 'Mueller', iban: 'DE89 3704 0044 0532 0130 00', bic: 'COBADEFFXXX', street_line_1: 'Hauptstr. 1', city: 'Berlin', postal_code: '10115', country: 'deu' }
    await expect(a.transition!({ leg, ref: s.ref!, name: 'submit_details', inputs: { ...inputs, iban: 'nope' } }, ctx)).rejects.toMatchObject({ error: { message: 'Enter a valid IBAN.' } })
    await expect(a.transition!({ leg, ref: s.ref!, name: 'submit_details', inputs: { ...inputs, country: 'DE' } }, ctx)).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
    const send = await a.transition!({ leg, ref: s.ref!, name: 'submit_details', inputs }, ctx)
    expect(send.action?.surface).toEqual({ kind: 'WALLET_TX', chain: SOLANA, txs: [{ kind: 'solana', type: 'transfer', to: 'BridgeSoLDepositAddress1111111111111111111', mint: USDC[SOLANA], amount: '20000000', decimals: 6 }] })
    expect(calls.find((c) => c.url.endsWith('/external_accounts'))!.body).toMatchObject({ currency: 'eur', account_type: 'iban', iban: { account_number: 'DE89370400440532013000', bic: 'COBADEFFXXX', country: 'DEU' }, address: { country: 'DEU' } })
    expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/transfers'))!.body).toMatchObject({
      source: { payment_rail: 'solana', currency: 'usdc' },
      destination: { payment_rail: 'sepa', currency: 'eur', external_account_id: 'ea_1' },
      features: { allow_any_from_address: true },
    })
  })

  it('runs KYC before the payout form', async () => {
    const { ctx } = ctxWith([])
    const a = bridge(opts())
    const { s } = await quoteAndStart(a, payoutLeg('payout-usd-ach', 'USD'), ctx, usdc('10'))
    expect(ui(s)).toMatchObject({ state: 'KYC', detail: { code: 'kyc_details' }, action: { kind: 'kyc' } })
    // submit_details before KYC goes back to the KYC step
    expect(ui(await a.transition!({ leg: payoutLeg('payout-usd-ach', 'USD'), ref: s.ref!, name: 'submit_details', inputs: usInputs }, ctx))).toMatchObject({ state: 'KYC' })
  })
})

describe('bridge adapter: webhooks', () => {
  const a = bridge(opts())
  const req = (sig?: string) => new Request('https://app.test/api/openramp/webhooks/bridge', { method: 'POST', headers: sig ? { 'x-webhook-signature': sig } : {} })

  it('parses the signature header', () => {
    expect(parseBridgeSignature('t=123,v0=abc=,v0=def')).toEqual({ t: '123', v0: ['abc=', 'def'] })
    expect(parseBridgeSignature('garbage')).toEqual({ v0: [] })
  })

  it('verifies RSA signatures over the double SHA-256 digest, with a 10 minute window', async () => {
    const body = JSON.stringify({ event_id: 'wh_1', event_category: 'transfer' })
    const w = makeWebhookCtx()
    expect(await a.webhook!.verify(req(await sign(KEYS.privateKey, body)), body, w)).toBe(true)
    expect(await a.webhook!.verify(req(await sign(KEYS.privateKey, body)), `${body} `, w)).toBe(false)
    expect(await a.webhook!.verify(req(await sign(OTHER_KEYS.privateKey, body)), body, w)).toBe(false)
    expect(await a.webhook!.verify(req(await sign(KEYS.privateKey, body, Date.now() - 11 * 60_000)), body, w)).toBe(false)
    expect(await a.webhook!.verify(req('t=1,v0=@@@'), body, w)).toBe(false)
    expect(await a.webhook!.verify(req(), body, w)).toBe(false)
    // A key from an env file with literal \n works.
    const escaped = bridge(opts({ webhookPublicKey: KEYS.pem.replace(/\n/g, '\\n') }))
    expect(await escaped.webhook!.verify(req(await sign(KEYS.privateKey, body)), body, w)).toBe(true)
    // No key or a broken key: refused, not thrown.
    expect(await bridge(opts({ webhookPublicKey: '' })).webhook!.verify(req(await sign(KEYS.privateKey, body)), body, w)).toBe(false)
    expect(await bridge(opts({ webhookPublicKey: '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----' })).webhook!.verify(req(await sign(KEYS.privateKey, body)), body, w)).toBe(false)
    const key = await importBridgePublicKey(KEYS.pem)
    const header = await sign(KEYS.privateKey, body, 1_000_000)
    expect(await verifyBridgeSignature(key, header, body, 1_000_000 + 9 * 60_000)).toBe(true)
  })

  it('maps virtual account activity to the session that shows the account, once per deposit', async () => {
    const shared = memoryKV()
    const { ctx } = ctxWith([
      { method: 'GET', match: /\/customers\/cust_1$/, reply: () => active() },
      { method: 'POST', match: '/virtual_accounts', reply: () => ({ id: 'va_1', source_deposit_instructions: USD_INSTRUCTIONS }) },
    ], { shared })
    const b = bridge(opts({ customer: async () => ({ customerId: 'cust_1' }) }))
    const { s } = await quoteAndStart(b, depositLeg('usd-ach', 'USD'), ctx)
    const w = makeWebhookCtx({ shared })
    const body = (type: string, deposit = 'dep_1') => JSON.stringify({
      api_version: 'v0', event_id: `wh_${type}`, event_category: 'virtual_account.activity', event_type: 'virtual_account.activity.created',
      event_object: { id: `e_${type}`, type, virtual_account_id: 'va_1', deposit_id: deposit, amount: '99.5', destination_tx_hash: '0xabc', created_at: now() },
    })
    const tx = [{ role: 'destination', chain: 'eip155:8453', hash: '0xabc' }]
    expect(await b.webhook!.parse(body('funds_received'), w)).toEqual([{ ref: s.ref, providerRef: 'dep_1', status: 'processing', detail: { code: 'settling', providerStatus: 'funds_received' }, transactions: tx }])
    const done = await b.webhook!.parse(body('payment_processed'), w)
    expect(done).toEqual([{ ref: s.ref, providerRef: 'dep_1', status: 'succeeded', transactions: tx, output: { value: '99.5', asset: { kind: 'crypto', chain: 'eip155:8453', token: BASE_USDC, symbol: 'USDC', decimals: 6 } } }])
    for (const e of done) expect(checkLegStep(e)).toEqual([])
    expect(await b.webhook!.parse(body('payment_processed'), w)).toEqual(done) // idempotent
    expect(await b.webhook!.parse(body('account_update'), w)).toEqual([])
    // A type that is not in the table: no event (never processing by default).
    expect(await b.webhook!.parse(body('brand_new_type'), w)).toEqual([])
    // Another deposit id goes to the same session only while no other session claimed it; unknown accounts are ignored.
    expect(await b.webhook!.parse(JSON.stringify({ event_category: 'virtual_account.activity', event_object: { type: 'funds_received', virtual_account_id: 'va_x', deposit_id: 'd', created_at: now() } }), w)).toEqual([])
  })

  it('maps transfer events by client_reference_id or transfer id', async () => {
    const shared = memoryKV()
    const w = makeWebhookCtx({ shared })
    const ev = (obj: Record<string, unknown>) => JSON.stringify({ event_category: 'transfer', event_type: 'transfer.updated.status_transitioned', event_object: obj })
    expect(await a.webhook!.parse(ev({ id: 'tr_1', client_reference_id: 'brg_1', state: 'payment_submitted' }), w)).toEqual([{ ref: 'brg_1', providerRef: 'tr_1', status: 'processing', detail: { code: 'settling', providerStatus: 'payment_submitted' } }])
    expect(await a.webhook!.parse(ev({ id: 'tr_1', client_reference_id: 'brg_1', state: 'brand_new_state' }), w)).toEqual([])
    await shared.put('tr:tr_2', 'brg_2')
    expect(await a.webhook!.parse(ev({ id: 'tr_2', state: 'returned' }), w)).toMatchObject([{ ref: 'brg_2', status: 'failed', error: { code: 'DELIVERY_FAILED' } }])
    expect(await a.webhook!.parse(ev({ id: 'tr_3', state: 'payment_processed' }), w)).toEqual([])
    expect(await a.webhook!.parse(ev({ id: 'tr_1', client_reference_id: 'brg_1', state: 'awaiting_funds' }), w)).toEqual([])
    expect(await a.webhook!.parse(JSON.stringify({ event_category: 'kyc_link', event_object: {} }), w)).toEqual([])
    expect(await a.webhook!.parse('not json', w)).toEqual([])
  })
})

describe('bridge adapter: conformance', () => {
  it('passes the conformance kit for a deposit and a payout', async () => {
    const shared = memoryKV()
    let transfer: Record<string, unknown> = { id: 'tr_1', state: 'awaiting_funds', source_deposit_instructions: { to_address: '0x00000000000000000000000000000000000000aa', amount: '25' } }
    const { fetch } = fakeFetch([
      { method: 'GET', match: /\/customers\/cust_1$/, reply: () => active() },
      { method: 'POST', match: '/virtual_accounts', reply: () => ({ id: 'va_1', source_deposit_instructions: USD_INSTRUCTIONS }) },
      { method: 'GET', match: '/history', reply: () => ({ data: [{ id: 'e1', type: 'payment_processed', deposit_id: 'dep_1', amount: '100', created_at: now() }] }) },
      { method: 'POST', match: '/external_accounts', reply: () => ({ id: 'ea_1' }) },
      { method: 'POST', match: '/transfers', reply: () => transfer },
      { method: 'GET', match: '/transfers/tr_1', reply: () => { transfer = { ...transfer, state: 'payment_processed', receipt: { final_amount: '25' } }; return transfer } },
    ])
    const a = bridge(opts({ customer: async () => ({ customerId: 'cust_1' }) }))
    const body = JSON.stringify({ event_category: 'transfer', event_object: { id: 'tr_1', client_reference_id: 'brg_1', state: 'payment_processed', receipt: { final_amount: '25' } } })
    const report = await runAdapterConformance(a, {
      ctx: () => makeCtx({ fetch, shared }),
      fixtures: [
        { leg: depositLeg('usd-ach', 'USD'), quote: { amountIn: fiat('100', 'USD') }, expect: { start: 'PAYMENT', status: 'COMPLETED' } },
        {
          leg: payoutLeg('payout-usd-ach', 'USD'),
          quote: { amountIn: usdc('25') },
          transitions: [
            { name: 'submit_details', inputs: { first_name: 'Jane', last_name: 'Doe', bank_name: 'Chase', routing_number: '021000021', account_number: '123456789', checking_or_savings: 'savings', street_line_1: '1 Main St', city: 'Austin', postal_code: '73301', state: 'TX' } },
            { name: 'submit_tx', inputs: { txHash: '0xfeed' } },
          ],
          expect: { start: 'PAYMENT', status: 'COMPLETED' },
        },
      ],
      // A USD leg needs no rate, so its quote makes no provider call. The EUR leg reads the exchange rate from Bridge.
      errorPaths: [{ leg: depositLeg('eur-sepa', 'EUR'), quote: { amountIn: fiat('100', 'EUR') }, ctx: (f) => makeCtx({ fetch: f, shared: memoryKV() }) }],
      webhooks: [
        { name: 'signed transfer', request: () => new Request('https://x.test', { method: 'POST', headers: { 'x-webhook-signature': SIGNED } }), rawBody: body, events: 1 },
        { name: 'bad signature', request: () => new Request('https://x.test', { method: 'POST', headers: { 'x-webhook-signature': 't=1,v0=AAAA' } }), rawBody: body, valid: false },
      ],
    })
    expect(report.problems).toEqual([])
    expect(report.steps[0]?.action?.surface?.kind).toBe('BANK_FIELDS')
    expect(report.quotes.every((q: LegQuote) => q.adapterId === 'bridge')).toBe(true)
  })
})

