import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkAdapterShape, checkLegQuote, checkLegStep } from '@openrampkit/adapter'
import type { AdapterContext } from '@openrampkit/adapter'
import { SOLANA_MAINNET, USDC, isRegionAllowed, stateFor } from '@openrampkit/core'
import type { LegQuote, LegStep, PathwayLeg } from '@openrampkit/core'
import { fakeFetch, makeCtx, makeWebhookCtx, memoryKV, runAdapterConformance } from '@openrampkit/adapter/testing'
import type { FakeRoute, MemoryKV } from '@openrampkit/adapter/testing'
import { STRIPE_LINK_TRANSITIONS as T, STRIPE_VERSION, kycState, stripeLink } from './index.js'
import { seal, sealKey, unseal } from './seal.js'

const SK = 'sk_test_51abc'
const PK = 'pk_test_51abc'
const WH = 'whsec_test_secret'
const CLIENT = 'lcid_test_1'
const ACCESS = 'liwltoken_secret_value_123'
const REFRESH = 'liwlrefresh_secret_value_456'
const opts = { secretKey: SK, publishableKey: PK, webhookSecret: WH, oauthClientId: CLIENT }
const BASE_USDC = { kind: 'crypto' as const, chain: 'eip155:8453', token: USDC['eip155:8453']! }
const ARB_USDC = { kind: 'crypto' as const, chain: 'eip155:42161', token: USDC['eip155:42161']! }
const WALLET = '0x000000000000000000000000000000000000beef'
const HASH = `0x${'ab'.repeat(32)}`
const usd = (v: string) => ({ value: v, asset: { kind: 'fiat' as const, currency: 'USD' } })

afterEach(() => {
  vi.useRealTimers()
})

const leg = (legId: string, to: typeof BASE_USDC = BASE_USDC, currency = 'USD'): PathwayLeg => ({
  adapterId: 'stripe-link',
  legId,
  from: { asset: { kind: 'fiat', currency }, location: { kind: 'user_account' } },
  to: { asset: to, location: { kind: 'address', address: 'deposit' } },
})

// From the guide's "Display a price estimate" example
const QUOTES = {
  id: 'cd35', rate_fetched_at: 1721433600.688338, livemode: false, source_currency: 'usd', source_amount: '100.00',
  destination_network_quotes: {
    base: [
      { id: 'q1', destination_currency: 'usdc', destination_amount: '100.00', destination_network: 'base', fees: { network_fee_monetary: '0.01', transaction_fee_monetary: '3.00' }, source_total_amount: '103.01' },
    ],
  },
}

const SESSION = (status: string, extra: Record<string, unknown> = {}) => ({
  id: 'cos_123', object: 'crypto.onramp_session', client_secret: 'cos_123_secret_abc', livemode: false, status, redirect_url: null,
  metadata: {},
  transaction_details: { destination_amount: '100.00', destination_currency: 'usdc', destination_network: 'base', source_amount: '100.00', source_currency: 'usd', transaction_id: null, wallet_address: WALLET },
  ...extra,
})

const VERIFIED = { id: 'crc_1', object: 'crypto.customer', kyc_tiers: [{ tier: 'l0', verification_status: 'verified' }, { tier: 'l1', verification_status: 'verified' }, { tier: 'l2', verification_status: 'not_started' }] }

/** A scripted Stripe and Link. Change `state` to change what they answer. */
function provider(over: Partial<{ intent: FakeRoute; customer: () => unknown; wallets: () => unknown; session: FakeRoute; checkout: () => unknown; retrieve: () => unknown }> = {}) {
  const state = { customer: over.customer ?? (() => VERIFIED), wallets: over.wallets ?? (() => ({ object: 'list', data: [] })) }
  const routes: FakeRoute[] = [
    { method: 'GET', match: '/v1/crypto/onramp_quotes', reply: () => QUOTES },
    over.intent ?? { method: 'POST', match: /login\.link\.com\/v1\/link_auth_intent$/, reply: () => ({ id: 'lai_1', expires_at: 1756238966 }) },
    { method: 'POST', match: '/v1/link_auth_intent/lai_1/tokens', reply: () => ({ access_token: ACCESS, expires_in: 3600, token_type: 'Bearer', scope: 'kyc.status:read crypto:ramp', refresh: { refresh_token: REFRESH, expires_in: 7776000 } }) },
    { method: 'GET', match: '/crypto_consumer_wallets', reply: () => state.wallets() },
    { method: 'GET', match: '/v1/crypto/customers/crc_1', reply: () => state.customer() },
    { method: 'POST', match: '/v1/crypto/onramp_sessions/cos_123/checkout', reply: over.checkout ?? (() => SESSION('fulfillment_processing')) },
    over.session ?? { method: 'POST', match: /\/v1\/crypto\/onramp_sessions$/, reply: () => SESSION('initialized') },
    { method: 'GET', match: '/v1/crypto/onramp_sessions/cos_123', reply: over.retrieve ?? (() => SESSION('fulfillment_complete', { transaction_details: { ...SESSION('x').transaction_details, transaction_id: HASH } })) },
  ]
  const f = fakeFetch(routes)
  return { ...f, state }
}

/** The client key of the client that signs in to Link (see `STRIPE_LINK_CLIENT_KEY`) */
const KEY = 'k'.repeat(43)

type Run = {
  a: ReturnType<typeof stripeLink>
  ctx: AdapterContext
  store: MemoryKV
  shared: MemoryKV
  quote: LegQuote
  step: LegStep
  ref: string
  /** A transition from the client that signs in (it sends `KEY`) */
  go: (name: string, inputs?: Record<string, unknown>) => Promise<LegStep>
  /** A transition with exactly these inputs (another client: no key, or another key) */
  raw: (name: string, inputs?: Record<string, unknown>, ctx?: AdapterContext) => Promise<LegStep>
}

async function begin(p: ReturnType<typeof provider>, o: { legId?: string; email?: string | null; options?: Partial<Parameters<typeof stripeLink>[0]>; ip?: string } = {}): Promise<Run> {
  const a = stripeLink({ ...opts, ...o.options })
  const store = memoryKV()
  const shared = memoryKV()
  const ctx = makeCtx({ fetch: p.fetch, store, shared, session: { ...(o.email === null ? {} : { email: o.email ?? 'user@example.com' }), ip: o.ip ?? '203.0.113.9' } })
  const l = leg(o.legId ?? 'card')
  const quote = await a.quote({ leg: l, amountIn: usd('100') }, ctx)
  const step = await a.start({ leg: l, quote, deliverTo: { address: WALLET } }, ctx)
  const ref = step.ref!
  const raw = (name: string, inputs?: Record<string, unknown>, c: AdapterContext = ctx) => a.transition!({ leg: l, ref, name, ...(inputs ? { inputs } : {}) }, c)
  return { a, ctx, store, shared, quote, step, ref, raw, go: (name, inputs) => raw(name, { clientKey: KEY, ...inputs }) }
}

const sdkStep = (s: LegStep) => (s.action?.surface?.kind === 'PROVIDER_SDK' ? s.action.surface.params.step : undefined)

describe('stripe-link adapter', () => {
  it('declares card, Apple Pay, Google Pay and ACH legs for the US (not New York)', () => {
    const a = stripeLink(opts)
    expect(checkAdapterShape(a)).toEqual([])
    expect(a.id).toBe('stripe-link')
    expect(a.env).toBe('sandbox')
    expect(a.legs.map((l) => [l.id, l.surfaces])).toEqual([
      ['card', ['PROVIDER_SDK']], ['apple_pay', ['PROVIDER_SDK']], ['google_pay', ['PROVIDER_SDK']], ['ach', ['PROVIDER_SDK']],
    ])
    const card = a.legs[0]!
    expect(isRegionAllowed(card.regions, 'US', 'US-CA')).toBe(true)
    expect(isRegionAllowed(card.regions, 'US', 'US-NY')).toBe(false)
    expect(isRegionAllowed(card.regions, 'FR')).toBe(false)
    expect(card.from.asset).toEqual({ kind: 'fiat', currencies: ['USD'] })
    // A sandbox delivers only on Solana, Ethereum and Base; live mode adds Arbitrum, Polygon and Tempo.
    const chains = (x: ReturnType<typeof stripeLink>) => Object.keys((x.legs[0]!.to.asset as { chains: Record<string, string[]> }).chains).sort()
    expect(chains(a)).toEqual(['eip155:1', 'eip155:8453', SOLANA_MAINNET].sort())
    expect(chains(stripeLink({ ...opts, secretKey: 'sk_live_1' }))).toEqual(['eip155:1', 'eip155:137', 'eip155:4217', 'eip155:42161', 'eip155:8453', SOLANA_MAINNET].sort())
    expect(stripeLink({ ...opts, methods: ['ach'] }).legs.map((l) => l.id)).toEqual(['ach'])
    expect(() => stripeLink({ ...opts, methods: [] })).toThrow(/no known leg/)
    expect(() => stripeLink({ ...opts, oauthClientId: '' })).toThrow(/oauthClientId/)
    expect(() => stripeLink({ ...opts, tokenKey: 'short' })).toThrow(/32 characters/)
    expect(() => stripeLink({ ...opts, env: 'production' })).toThrow(/test mode/)
  })

  it('quote: GET /v1/crypto/onramp_quotes with ui_mode=headless, Bearer auth and the preview Stripe-Version', async () => {
    const { fetch, calls } = fakeFetch([{ match: '/v1/crypto/onramp_quotes', reply: () => QUOTES }])
    const q = await stripeLink(opts).quote({ leg: leg('card'), amountIn: usd('100') }, makeCtx({ fetch }))
    expect(checkLegQuote(q)).toEqual([])
    const u = new URL(calls[0]!.url)
    expect(u.origin + u.pathname).toBe('https://api.stripe.com/v1/crypto/onramp_quotes')
    expect([...u.searchParams]).toEqual([
      ['ui_mode', 'headless'], ['source_currency', 'usd'], ['source_amount', '100.00'], ['destination_currencies[]', 'usdc'], ['destination_networks[]', 'base'],
    ])
    expect(calls[0]!.headers.get('authorization')).toBe(`Bearer ${SK}`)
    expect(calls[0]!.headers.get('stripe-version')).toBe(STRIPE_VERSION)
    expect(calls[0]!.headers.get('stripe-oauth-token')).toBeNull()
    expect(q.input).toEqual(usd('103.01'))
    expect(q.output).toEqual({ value: '100.00', asset: { ...BASE_USDC, symbol: 'USDC', decimals: 6 } })
    expect(q.fees).toEqual([
      { kind: 'provider', label: 'Stripe fee', amount: usd('3.00'), included: true },
      { kind: 'network', label: 'Network fee', amount: usd('0.01'), included: true },
    ])
    expect(q.guarantee).toBe('estimate')
  })

  it('quote: USD only, no live-only network in a sandbox, and Stripe errors', async () => {
    const { fetch, calls } = fakeFetch([])
    const a = stripeLink(opts)
    await expect(a.quote({ leg: leg('card', BASE_USDC, 'EUR'), amountIn: { value: '100', asset: { kind: 'fiat', currency: 'EUR' } } }, makeCtx({ fetch }))).rejects.toMatchObject({ error: { code: 'NO_QUOTES' } })
    await expect(a.quote({ leg: leg('card', ARB_USDC), amountIn: usd('100') }, makeCtx({ fetch }))).rejects.toMatchObject({ error: { code: 'NO_QUOTES' } })
    expect(calls).toHaveLength(0)
    const run = (status: number, body: unknown) =>
      a.quote({ leg: leg('card'), amountIn: usd('100') }, makeCtx({ fetch: fakeFetch([{ match: '/onramp_quotes', status, reply: () => body }]).fetch }))
    await expect(run(400, { error: { code: 'crypto_onramp_unsupported_country', message: 'x' } })).rejects.toMatchObject({ error: { code: 'REGION_UNSUPPORTED' } })
    await expect(run(400, { error: { message: 'Amount must be at least $1.00' } })).rejects.toMatchObject({ error: { code: 'NO_QUOTES' } })
    await expect(run(401, {})).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
    await expect(run(200, { destination_network_quotes: {} })).rejects.toMatchObject({ error: { code: 'NO_QUOTES' } })
  })

  it('start: with a known email, creates a LinkAuthIntent and asks the client to authenticate', async () => {
    const p = provider()
    const r = await begin(p)
    expect(checkLegStep(r.step)).toEqual([])
    expect(stateFor(r.step)).toBe('AUTH')
    expect(r.ref).toMatch(/^slk_[0-9a-f]{24}$/)
    expect(r.step.action).toEqual({
      kind: 'auth',
      surface: { kind: 'PROVIDER_SDK', provider: 'stripe-link', params: { publishableKey: PK, step: 'authenticate', linkAuthIntentId: 'lai_1' } },
      transitions: [{ name: T.authenticated, kind: 'SUBMIT', label: 'Continue' }],
    })
    const call = p.calls.find((c) => c.url.endsWith('/v1/link_auth_intent'))!
    expect(call.url).toBe('https://login.link.com/v1/link_auth_intent')
    expect(call.headers.get('authorization')).toBe(`Bearer ${SK}`)
    expect(call.body).toEqual({ email: 'user@example.com', oauth_client_id: CLIENT, oauth_scopes: 'kyc.status:read,crypto:ramp' })
  })

  it('start: without an email, asks for it (FORM); a bad email is refused', async () => {
    const r = await begin(provider(), { email: null })
    expect(stateFor(r.step)).toBe('AUTH')
    expect(r.step.action).toEqual({
      kind: 'auth',
      surface: { kind: 'FORM', fields: [{ id: 'email', label: 'Email', type: 'email', required: true }] },
      transitions: [{ name: T.email, kind: 'SUBMIT', label: 'Continue' }],
    })
    await expect(r.go(T.email, { email: 'nope' })).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
    expect(sdkStep(await r.go(T.email, { email: ' user@example.com ' }))).toBe('authenticate')
  })

  it('auth: no Link account (404) asks the client to register, then signs in; a revoked connection (409) fails', async () => {
    let first = true
    const p = provider({
      intent: {
        method: 'POST',
        match: /link_auth_intent$/,
        reply: () => {
          if (!first) return { id: 'lai_1', expires_at: 1 }
          first = false
          return new Response(JSON.stringify({ error: { message: 'No such customer' } }), { status: 404 })
        },
      },
    })
    const r = await begin(p)
    expect(r.step.action?.surface).toEqual({ kind: 'PROVIDER_SDK', provider: 'stripe-link', params: { publishableKey: PK, step: 'register_link_user', email: 'user@example.com', country: 'US' } })
    expect(r.step.action?.transitions.map((t) => t.name)).toEqual([T.registered])
    expect(sdkStep(await r.go(T.registered))).toBe('authenticate')

    const revoked = await begin(provider({ intent: { method: 'POST', match: /link_auth_intent$/, status: 409, reply: () => ({ error: { message: 'revoked' } }) } }))
    expect(revoked.step).toMatchObject({ status: 'failed', error: { code: 'PROVIDER_DECLINED' } })
    await expect(begin(provider({ intent: { method: 'POST', match: /link_auth_intent$/, status: 403, reply: () => ({}) } }))).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
  })

  it('full flow: sign-in, KYC, wallet, payment method, session, checkout; the token is sealed and never leaves the server', async () => {
    let kycDone = false
    let walletOnFile = false
    const p = provider({
      customer: () => (kycDone ? VERIFIED : { id: 'crc_1', verifications: [{ type: 'kyc_verified', status: 'not_started' }] }),
      wallets: () => ({ object: 'list', data: walletOnFile ? [{ id: 'cw_1', object: 'crypto.consumer_wallet', wallet_address: WALLET.toUpperCase().replace('0X', '0x'), network: 'base' }] : [] }),
    })
    const r = await begin(p)
    const steps: LegStep[] = [r.step]
    await expect(r.go(T.authenticated, { cryptoCustomerId: 'nope' })).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })

    // 1. Sign-in done: we exchange the intent for tokens, then KYC is missing
    const kyc = await r.go(T.authenticated, { cryptoCustomerId: 'crc_1' })
    steps.push(kyc)
    expect(stateFor(kyc)).toBe('KYC')
    expect(sdkStep(kyc)).toBe('submit_kyc_info')
    const tok = p.calls.find((c) => c.url.includes('/tokens'))!
    expect(tok.url).toBe('https://login.link.com/v1/link_auth_intent/lai_1/tokens')
    expect(tok.headers.get('authorization')).toBe(`Bearer ${SK}`)
    const cust = p.calls.find((c) => c.url.endsWith('/v1/crypto/customers/crc_1'))!
    expect(cust.headers.get('stripe-oauth-token')).toBe(ACCESS)
    expect(cust.headers.get('stripe-version')).toBe(STRIPE_VERSION)

    // The token is in the store only sealed; the refresh token is nowhere.
    const dump = JSON.stringify([...r.store.data.values(), ...r.shared.data.values()])
    expect(dump).not.toContain(ACCESS)
    expect(dump).not.toContain(REFRESH)
    expect(dump).toMatch(/"v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+"/)

    // 2. KYC sent by the client SDK; the address is not on file yet
    kycDone = true
    const wallet = await r.go(T.kyc)
    steps.push(wallet)
    expect(wallet.action?.surface).toEqual({ kind: 'PROVIDER_SDK', provider: 'stripe-link', params: { publishableKey: PK, step: 'register_wallet_address', walletAddress: WALLET, network: 'base' } })
    await expect(r.go(T.wallet)).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })

    // 3. Wallet registered by the client SDK (the address case does not matter on EVM)
    walletOnFile = true
    const pm = await r.go(T.wallet)
    steps.push(pm)
    expect(stateFor(pm)).toBe('PAYMENT')
    expect(pm.detail).toEqual({ code: 'card_details' })
    expect(pm.action?.surface).toMatchObject({ params: { step: 'collect_payment_method', paymentMethodTypes: ['card'], wallets: { applePay: 'never', googlePay: 'never' } } })
    await expect(r.go(T.paymentMethod, { paymentToken: 'pm_1' })).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })

    // 4. Payment token: the server creates the headless session
    const co = await r.go(T.paymentMethod, { paymentToken: 'cpt_1' })
    steps.push(co)
    expect(co).toMatchObject({ status: 'requires_action', ref: r.ref, providerRef: 'cos_123' })
    expect(co.action?.surface).toEqual({ kind: 'PROVIDER_SDK', provider: 'stripe-link', params: { publishableKey: PK, step: 'perform_checkout', onrampSessionId: 'cos_123', clientSecret: 'cos_123_secret_abc' } })
    expect(co.action?.transitions.map((t) => [t.name, t.kind])).toEqual([[T.checkout, 'SUBMIT'], ['poll', 'AWAIT']])
    const post = p.calls.find((c) => c.method === 'POST' && c.url.endsWith('/v1/crypto/onramp_sessions'))!
    expect(post.headers.get('stripe-oauth-token')).toBe(ACCESS)
    expect(post.headers.get('content-type')).toBe('application/x-www-form-urlencoded')
    expect(post.headers.get('idempotency-key')).toMatch(/^sess_1:stripe-link:[0-9a-f]{16}:cpt_1$/)
    expect([...new URLSearchParams(post.raw!)]).toEqual([
      ['ui_mode', 'headless'],
      ['crypto_customer_id', 'crc_1'],
      ['payment_token', 'cpt_1'],
      ['source_amount', '100.00'],
      ['source_currency', 'usd'],
      ['destination_currency', 'usdc'],
      ['destination_currencies[]', 'usdc'],
      ['destination_network', 'base'],
      ['destination_networks[]', 'base'],
      ['wallet_address', WALLET],
      ['customer_ip_address', '203.0.113.9'],
      ['metadata[ork_ref]', r.ref],
      ['metadata[ork_session]', 'sess_1'],
      ['metadata[ork_leg]', 'card'],
    ])
    expect(await r.shared.get('cos:cos_123')).toBe(r.ref)

    // 5. Checkout from the SDK callback: payment confirmed, crypto on its way. The token is dropped.
    const done = await r.go(T.checkout)
    steps.push(done)
    expect(stateFor(done)).toBe('PROCESSING')
    expect(done).toMatchObject({ status: 'processing', providerRef: 'cos_123', output: { value: '100.00' } })
    const ck = p.calls.find((c) => c.url.endsWith('/cos_123/checkout'))!
    expect(ck.method).toBe('POST')
    expect(ck.headers.get('stripe-oauth-token')).toBe(ACCESS)
    expect(ck.raw).toBeUndefined()
    expect(r.store.data.get(`t:${r.ref}`)).toBeNull()

    // 6. Status: delivered on chain
    const fin = await r.a.status!({ leg: leg('card'), ref: r.ref }, r.ctx)
    steps.push(fin)
    expect(stateFor(fin)).toBe('COMPLETED')
    expect(fin).toMatchObject({ status: 'succeeded', providerRef: 'cos_123', transactions: [{ role: 'destination', hash: HASH, chain: 'eip155:8453' }] })
    expect(p.calls.at(-1)!.headers.get('stripe-oauth-token')).toBeNull()

    for (const s of steps) {
      expect(checkLegStep(s)).toEqual([])
      expect(JSON.stringify(s)).not.toContain(ACCESS)
    }
  })

  it('checkout: 3DS keeps the payment step with the new client secret; rejected fails', async () => {
    let n = 0
    const p = provider({
      wallets: () => ({ data: [{ wallet_address: WALLET, network: 'base' }] }),
      checkout: () => (n++ === 0 ? SESSION('requires_payment', { client_secret: 'cos_123_secret_2' }) : SESSION('rejected')),
    })
    const r = await begin(p)
    await r.go(T.authenticated, { cryptoCustomerId: 'crc_1' })
    await r.go(T.paymentMethod, { paymentToken: 'cpt_1' })
    const again = await r.go(T.checkout)
    expect(stateFor(again)).toBe('PAYMENT')
    expect(again.action?.surface).toMatchObject({ params: { step: 'perform_checkout', clientSecret: 'cos_123_secret_2' } })
    const rejected = await r.go(T.checkout)
    expect(rejected).toMatchObject({ status: 'failed', error: { code: 'PROVIDER_DECLINED' } })
    expect(r.store.data.get(`t:${r.ref}`)).toBeNull()
  })

  it('checkout: ACH mandate_data with the IP and the user agent', async () => {
    const p = provider({ wallets: () => ({ data: [{ wallet_address: WALLET, network: 'base' }] }) })
    const r = await begin(p, { legId: 'ach' })
    const pm = await r.go(T.authenticated, { cryptoCustomerId: 'crc_1' })
    expect(pm.detail).toEqual({ code: 'bank_details' })
    expect(pm.action?.surface).toMatchObject({ params: { paymentMethodTypes: ['us_bank_account'] } })
    await r.go(T.paymentMethod, { paymentToken: 'cpt_1' })
    await expect(r.go(T.checkout)).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
    await r.go(T.checkout, { userAgent: 'Mozilla/5.0' })
    const ck = p.calls.filter((c) => c.url.endsWith('/checkout')).at(-1)!
    expect([...new URLSearchParams(ck.raw!)]).toEqual([
      ['mandate_data[customer_acceptance][type]', 'online'],
      ['mandate_data[customer_acceptance][online][ip_address]', '203.0.113.9'],
      ['mandate_data[customer_acceptance][online][user_agent]', 'Mozilla/5.0'],
    ])
  })

  it('identity challenge: missing document verification asks for documents, then retries the session', async () => {
    let l2 = 'not_started'
    let sessions = 0
    const p = provider({
      customer: () => ({ ...VERIFIED, kyc_tiers: [{ tier: 'l1', verification_status: 'verified' }, { tier: 'l2', verification_status: l2 }] }),
      wallets: () => ({ data: [{ wallet_address: WALLET, network: 'base' }] }),
      session: {
        method: 'POST',
        match: /\/v1\/crypto\/onramp_sessions$/,
        reply: () =>
          sessions++ === 0
            ? new Response(JSON.stringify({ error: { code: 'crypto_onramp_missing_document_verification', message: 'Documents needed' } }), { status: 400 })
            : SESSION('initialized'),
      },
    })
    const r = await begin(p)
    await r.go(T.authenticated, { cryptoCustomerId: 'crc_1' })
    const docs = await r.go(T.paymentMethod, { paymentToken: 'cpt_1' })
    expect(stateFor(docs)).toBe('KYC')
    expect(docs).toMatchObject({ detail: { code: 'kyc_verify' } })
    expect(sdkStep(docs)).toBe('verify_documents')
    // Still under review: wait (KYC phase), and the status poll retries the session once verified
    l2 = 'pending'
    const review = await r.go(T.documents)
    expect(review).toMatchObject({ status: 'processing', phase: 'kyc', detail: { code: 'kyc_review' } })
    expect(stateFor(review)).toBe('KYC')
    l2 = 'verified'
    const co = await r.a.status!({ leg: leg('card'), ref: r.ref }, r.ctx)
    expect(co).toMatchObject({ status: 'requires_action', providerRef: 'cos_123' })
    expect(sessions).toBe(2)
  })

  it('KYC rejected fails the leg; an expired token sends the user back to the Link sign-in', async () => {
    const rej = await begin(provider({ customer: () => ({ id: 'crc_1', kyc_tiers: [{ tier: 'l1', verification_status: 'rejected' }] }) }))
    expect(await rej.go(T.authenticated, { cryptoCustomerId: 'crc_1' })).toMatchObject({ status: 'failed', error: { code: 'KYC_REJECTED' } })

    vi.useFakeTimers({ now: Date.parse('2030-01-01T00:00:00Z') })
    const r = await begin(provider({ wallets: () => ({ data: [] }) }))
    expect(sdkStep(await r.go(T.authenticated, { cryptoCustomerId: 'crc_1' }))).toBe('register_wallet_address')
    vi.setSystemTime(Date.parse('2030-01-01T00:59:30Z'))
    const back = await r.go(T.wallet)
    expect(stateFor(back)).toBe('AUTH')
    expect(sdkStep(back)).toBe('authenticate')
  })

  it('status: stage steps before the session, and session statuses after', async () => {
    const r = await begin(provider())
    expect(sdkStep(await r.a.status!({ leg: leg('card'), ref: r.ref }, r.ctx))).toBe('authenticate')
    await r.go(T.authenticated, { cryptoCustomerId: 'crc_1' })
    expect(sdkStep(await r.a.status!({ leg: leg('card'), ref: r.ref }, r.ctx))).toBe('register_wallet_address')
    const p2 =provider({ wallets: () => ({ data: [{ wallet_address: WALLET, network: 'base' }] }), retrieve: () => SESSION('requires_payment') })
    const r2 = await begin(p2)
    await r2.go(T.authenticated, { cryptoCustomerId: 'crc_1' })
    await r2.go(T.paymentMethod, { paymentToken: 'cpt_1' })
    const poll = await r2.a.status!({ leg: leg('card'), ref: r2.ref }, r2.ctx)
    expect(checkLegStep(poll)).toEqual([])
    // A status poll has no surface: the client keeps the one with its client secret
    expect(poll).toMatchObject({ status: 'requires_action', providerRef: 'cos_123', action: { kind: 'payment' } })
    expect(poll.action!.surface).toBeUndefined()
    expect(p2.calls.at(-1)!.headers.get('stripe-oauth-token')).toBe(ACCESS)
    // An unknown record
    await expect(r2.a.status!({ leg: leg('card'), ref: 'slk_unknown' }, r2.ctx)).rejects.toMatchObject({ error: { code: 'SESSION_EXPIRED' } })
    await expect(r2.go('nope')).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
    // cancel forgets the token
    await r2.a.cancel!({ leg: leg('card'), ref: r2.ref }, r2.ctx)
    expect(r2.store.data.get(`t:${r2.ref}`)).toBeNull()
  })

  describe('identity binding and authorization', () => {
    const onFile = () => ({ data: [{ wallet_address: WALLET, network: 'base' }] })

    it('a crypto customer id that the Link token cannot read (another person) is refused; the token is never stored', async () => {
      const p = provider({ wallets: onFile })
      const r = await begin(p)
      // crc_2 is not the customer of this sign-in: Stripe answers 404 for this token
      const back = await r.go(T.authenticated, { cryptoCustomerId: 'crc_2' })
      expect(sdkStep(back)).toBe('authenticate')
      expect(r.store.data.get(`t:${r.ref}`) ?? null).toBeNull()
      // The id is never used for a later call: KYC, wallet and payment need a new sign-in first
      await expect(r.go(T.paymentMethod, { paymentToken: 'cpt_1' })).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
      expect(p.calls.some((c) => c.method === 'POST' && c.url.endsWith('/v1/crypto/onramp_sessions'))).toBe(false)
    })

    it('a customer object with another id is refused', async () => {
      const r = await begin(provider({ customer: () => ({ ...VERIFIED, id: 'crc_other' }) }))
      expect(sdkStep(await r.go(T.authenticated, { cryptoCustomerId: 'crc_1' }))).toBe('authenticate')
      expect(r.store.data.get(`t:${r.ref}`) ?? null).toBeNull()
    })

    it('an auth intent that the account owner did not approve gives no token (403 from Link)', async () => {
      const p = provider()
      const routes = { method: 'POST' as const, match: '/v1/link_auth_intent/lai_1/tokens', status: 403, reply: () => ({ error: { message: "LinkAuthIntent hasn't been consented by the user" } }) }
      const f = fakeFetch([{ method: 'GET', match: '/v1/crypto/onramp_quotes', reply: () => QUOTES }, routes, { method: 'POST', match: /link_auth_intent$/, reply: () => ({ id: 'lai_1' }) }])
      const r = await begin({ ...p, fetch: f.fetch, calls: f.calls })
      await expect(r.go(T.authenticated, { cryptoCustomerId: 'crc_1' })).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
      expect(r.store.data.get(`t:${r.ref}`) ?? null).toBeNull()
      expect(f.calls.some((c) => c.url.includes('/v1/crypto/customers'))).toBe(false)
    })

    it('link_authenticated needs a client key; another client (a pay link, no key or another key) cannot use the token', async () => {
      const p = provider({ wallets: onFile })
      const r = await begin(p)
      await expect(r.raw(T.authenticated, { cryptoCustomerId: 'crc_1' })).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
      await expect(r.raw(T.authenticated, { cryptoCustomerId: 'crc_1', clientKey: 'short' })).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
      expect(sdkStep(await r.go(T.authenticated, { cryptoCustomerId: 'crc_1' }))).toBe('collect_payment_method')
      expect(JSON.stringify([...r.store.data.values()])).not.toContain(KEY)
      // Another client: no session is created with the owner's token; the token is dropped; a new sign-in starts
      const before = p.calls.length
      const other = await r.raw(T.paymentMethod, { paymentToken: 'cpt_9', clientKey: 'x'.repeat(43) })
      expect(sdkStep(other)).toBe('authenticate')
      expect(p.calls.slice(before).some((c) => c.url.includes('/v1/crypto/'))).toBe(false)
      expect(r.store.data.get(`t:${r.ref}`)).toBeNull()
      // The owner signs in again (one-time code) and goes on
      expect(sdkStep(await r.go(T.authenticated, { cryptoCustomerId: 'crc_1' }))).toBe('collect_payment_method')
      expect(sdkStep(await r.raw(T.paymentMethod, { paymentToken: 'cpt_9' }))).toBe('authenticate')
    })

    it('checkout from another client is refused (403) and keeps the leg; the owner can still pay', async () => {
      const p = provider({ wallets: onFile })
      const r = await begin(p)
      await r.go(T.authenticated, { cryptoCustomerId: 'crc_1' })
      await r.go(T.paymentMethod, { paymentToken: 'cpt_1' })
      await expect(r.raw(T.checkout)).rejects.toMatchObject({ status: 403 })
      await expect(r.raw(T.checkout, { clientKey: 'y'.repeat(43) })).rejects.toMatchObject({ status: 403 })
      expect(p.calls.some((c) => c.url.endsWith('/checkout'))).toBe(false)
      expect(await r.go(T.checkout)).toMatchObject({ status: 'processing' })
    })

    it('transitions run only from their own stage (no skipped KYC, wallet or payment method step)', async () => {
      const p = provider({ customer: () => ({ id: 'crc_1', verifications: [{ type: 'kyc_verified', status: 'not_started' }] }) })
      const r = await begin(p)
      await expect(r.go(T.paymentMethod, { paymentToken: 'cpt_1' })).rejects.toMatchObject({ status: 409 })
      await expect(r.go(T.checkout)).rejects.toMatchObject({ status: 409 })
      await expect(r.go(T.registered)).rejects.toMatchObject({ status: 409 })
      expect(sdkStep(await r.go(T.authenticated, { cryptoCustomerId: 'crc_1' }))).toBe('submit_kyc_info')
      // KYC is not done: the client cannot jump to the wallet, the payment method or a second sign-in
      await expect(r.go(T.wallet)).rejects.toMatchObject({ status: 409 })
      await expect(r.go(T.paymentMethod, { paymentToken: 'cpt_1' })).rejects.toMatchObject({ status: 409 })
      await expect(r.go(T.authenticated, { cryptoCustomerId: 'crc_1' })).rejects.toMatchObject({ status: 409 })
      await expect(r.go(T.email, { email: 'other@example.com' })).rejects.toMatchObject({ status: 409 })
      expect(p.calls.some((c) => c.method === 'POST' && c.url.endsWith('/v1/crypto/onramp_sessions'))).toBe(false)
    })

    it("the app's email is locked: the client cannot sign in with another person's email", async () => {
      const p = provider()
      const r = await begin(p)
      await expect(r.go(T.email, { email: 'victim@example.com' })).rejects.toMatchObject({ status: 409 })
      const intents = p.calls.filter((c) => c.url.endsWith('/v1/link_auth_intent'))
      expect(intents.map((c) => (c.body as { email: string }).email)).toEqual(['user@example.com'])
      // requireSessionEmail: no FORM fallback
      await expect(begin(provider(), { email: null, options: { requireSessionEmail: true } })).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
      // A malformed app email is an error, not a reason to ask the client
      await expect(begin(provider(), { email: 'not-an-email' })).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
      // With no app email, the FORM email can be fixed before the sign-in, and is locked after it
      const f = await begin(provider({ wallets: onFile }), { email: null })
      expect(sdkStep(await f.go(T.email, { email: 'typo@example.com' }))).toBe('authenticate')
      expect(sdkStep(await f.go(T.email, { email: 'user@example.com' }))).toBe('authenticate')
      await f.go(T.authenticated, { cryptoCustomerId: 'crc_1' })
      await expect(f.go(T.email, { email: 'other@example.com' })).rejects.toMatchObject({ status: 409 })
    })

    it('the leg record and the token are bound to the session and the app user', async () => {
      const p = provider({ wallets: onFile })
      const r = await begin(p)
      await r.go(T.authenticated, { cryptoCustomerId: 'crc_1' })
      // Another session or another user with the same store (and the same ref) gets nothing
      const otherUser = makeCtx({ fetch: p.fetch, store: r.store, shared: r.shared, session: { userId: 'user_2', email: 'user@example.com' } })
      const otherSession = makeCtx({ fetch: p.fetch, store: r.store, shared: r.shared, session: { id: 'sess_2', email: 'user@example.com' } })
      await expect(r.raw(T.paymentMethod, { paymentToken: 'cpt_1', clientKey: KEY }, otherUser)).rejects.toMatchObject({ error: { code: 'SESSION_EXPIRED' } })
      await expect(r.raw(T.paymentMethod, { paymentToken: 'cpt_1', clientKey: KEY }, otherSession)).rejects.toMatchObject({ error: { code: 'SESSION_EXPIRED' } })
      await expect(r.a.status!({ leg: leg('card'), ref: r.ref }, otherUser)).rejects.toMatchObject({ error: { code: 'SESSION_EXPIRED' } })
      // Even with a copied record, the sealed token does not open for another user
      const recKey = [...r.store.data.keys()].find((k) => k.startsWith('r:'))!
      const rec = r.store.data.get(recKey) as Record<string, unknown>
      await r.store.put(recKey, { ...rec, owner: 'sess_1:user_2' })
      const before = p.calls.length
      expect(sdkStep(await r.raw(T.paymentMethod, { paymentToken: 'cpt_1', clientKey: KEY }, otherUser))).toBe('authenticate')
      expect(p.calls.slice(before).some((c) => c.headers.get('stripe-oauth-token') === ACCESS)).toBe(false)
    })

    it('after a server restart (a new adapter, the same store) the same user and client go on', async () => {
      const p = provider({ wallets: onFile })
      const r = await begin(p)
      await r.go(T.authenticated, { cryptoCustomerId: 'crc_1' })
      const again = stripeLink(opts)
      const co = await again.transition!({ leg: leg('card'), ref: r.ref, name: T.paymentMethod, inputs: { paymentToken: 'cpt_1', clientKey: KEY } }, r.ctx)
      expect(co).toMatchObject({ status: 'requires_action', providerRef: 'cos_123' })
    })

    it('the wallet is always the server-set address; client inputs cannot change it', async () => {
      const ATTACKER = '0x000000000000000000000000000000000000dead'
      const p = provider({ wallets: () => ({ data: [{ wallet_address: ATTACKER, network: 'base' }] }) })
      const r = await begin(p)
      const w = await r.go(T.authenticated, { cryptoCustomerId: 'crc_1' })
      expect(w.action?.surface).toMatchObject({ params: { step: 'register_wallet_address', walletAddress: WALLET } })
      // Only the attacker's address is on file: the wallet step does not pass
      await expect(r.go(T.wallet, { walletAddress: ATTACKER })).rejects.toMatchObject({ status: 409 })
      p.state.wallets = () => ({ data: [{ wallet_address: WALLET, network: 'base' }] })
      await r.go(T.wallet, { walletAddress: ATTACKER })
      await r.go(T.paymentMethod, { paymentToken: 'cpt_1', walletAddress: ATTACKER, wallet_address: ATTACKER })
      const post = p.calls.find((c) => c.method === 'POST' && c.url.endsWith('/v1/crypto/onramp_sessions'))!
      expect(new URLSearchParams(post.raw!).getAll('wallet_address')).toEqual([WALLET])
    })

    it('webhook: the server index wins; a metadata ref that disagrees with it is ignored', async () => {
      const a = stripeLink(opts)
      const shared = memoryKV()
      const wctx = makeWebhookCtx({ shared })
      const mine = `slk_${'a'.repeat(24)}`
      const other = `slk_${'c'.repeat(24)}`
      const ev = (meta: Record<string, string>) => JSON.stringify({ id: 'evt_9', type: 'crypto.onramp_session.updated', data: { object: SESSION('fulfillment_processing', { metadata: meta }) } })
      await shared.put('cos:cos_123', mine)
      expect(await a.webhook!.parse(ev({ ork_ref: other }), wctx)).toEqual([])
      expect(await a.webhook!.parse(ev({ ork_ref: 'x' }), wctx)).toEqual([])
      expect(await a.webhook!.parse(ev({ ork_ref: mine }), wctx)).toMatchObject([{ ref: mine }])
      expect(await a.webhook!.parse(ev({}), wctx)).toMatchObject([{ ref: mine }])
    })
  })

  it('kycState reads both shapes', () => {
    expect(kycState({ verifications: [{ type: 'kyc_verified', status: 'not_started' }] })).toBe('collect')
    expect(kycState({ verifications: [{ type: 'kyc_verified', status: 'verified' }] })).toBe('ok')
    expect(kycState({ kyc_tiers: [{ tier: 'l1', verification_status: 'pending' }] })).toBe('review')
    expect(kycState({ kyc_tiers: [{ tier: 'l1', verification_status: 'verified' }, { tier: 'l2', verification_status: 'failed' }] }, 'l2')).toBe('rejected')
    expect(kycState({})).toBe('ok')
  })

  it('seal: AES-GCM bound to the leg ref; another ref, a changed value or another key do not open it', async () => {
    const k = await sealKey('k'.repeat(32))
    const s = await seal(k, 'secret', 'slk_1')
    expect(s).not.toContain('secret')
    expect(await unseal(k, s, 'slk_1')).toBe('secret')
    expect(await unseal(k, s, 'slk_2')).toBeUndefined()
    expect(await unseal(k, s.slice(0, -4) + 'AAAA', 'slk_1')).toBeUndefined()
    expect(await unseal(await sealKey('j'.repeat(32)), s, 'slk_1')).toBeUndefined()
    expect(await unseal(k, 'plain', 'slk_1')).toBeUndefined()
    expect(await unseal(k, null, 'slk_1')).toBeUndefined()
    await expect(sealKey('')).rejects.toThrow()
  })

  it('webhook: Stripe-Signature (good, rotated v1, bad, missing, stale, unset secret) and parse', async () => {
    const a = stripeLink(opts)
    const shared = memoryKV()
    const wctx = makeWebhookCtx({ shared })
    const ref = `slk_${'a'.repeat(24)}`
    const obj = SESSION('fulfillment_complete', { metadata: { ork_ref: ref }, transaction_details: { ...SESSION('x').transaction_details, transaction_id: HASH } })
    const body = JSON.stringify({ id: 'evt_1', object: 'event', type: 'crypto.onramp_session.updated', data: { object: obj } })
    const t = Math.floor(Date.now() / 1000)
    const v1 = (ts: number, b = body, secret = WH) => createHmac('sha256', secret).update(`${ts}.${b}`).digest('hex')
    const req = (h?: string) => new Request('https://app.test/hook', { method: 'POST', body, headers: h ? { 'Stripe-Signature': h } : {} })
    expect(await a.webhook!.verify(req(`t=${t},v1=${v1(t)}`), body, wctx)).toBe(true)
    expect(await a.webhook!.verify(req(`t=${t},v1=${v1(t, body, 'old')},v1=${v1(t)}`), body, wctx)).toBe(true)
    expect(await a.webhook!.verify(req(`t=${t},v1=${v1(t, 'x')}`), body, wctx)).toBe(false)
    expect(await a.webhook!.verify(req(`t=${t},v0=${v1(t)}`), body, wctx)).toBe(false)
    expect(await a.webhook!.verify(req(), body, wctx)).toBe(false)
    expect(await a.webhook!.verify(req(`t=${t - 301},v1=${v1(t - 301)}`), body, wctx)).toBe(false)
    const unset = stripeLink({ ...opts, webhookSecret: '' })
    expect(unset.webhook!.configured).toBe(false)
    expect(await unset.webhook!.verify(req(`t=${t},v1=${v1(t, body, '')}`), body, wctx)).toBe(false)
    expect(await a.webhook!.replayKey!(req(), body, wctx)).toBe('evt:evt_1')

    expect(await a.webhook!.parse(body, wctx)).toEqual([
      { ref, status: 'succeeded', providerRef: 'cos_123', eventId: 'evt_1', transactions: [{ role: 'destination', hash: HASH, chain: 'eip155:8453' }], output: { value: '100.00', asset: { ...BASE_USDC, symbol: 'USDC', decimals: 6 } } },
    ])
    const parse = (o: unknown) => a.webhook!.parse(JSON.stringify(o), wctx)
    const ev = (o: unknown) => ({ type: 'crypto.onramp_session.updated', data: { object: o } })
    // A Stripe transaction id (cxt_...) is not a chain hash
    expect((await parse(ev({ ...obj, transaction_details: { ...obj.transaction_details, transaction_id: 'cxt_1ABC' } })))[0]!.transactions).toBeUndefined()
    expect(await parse(ev(SESSION('fulfillment_processing', { metadata: { ork_ref: ref } })))).toMatchObject([{ ref, status: 'processing' }])
    expect(await parse(ev(SESSION('rejected', { metadata: { ork_ref: ref } })))).toMatchObject([{ ref, status: 'failed', error: { code: 'PROVIDER_DECLINED' } }])
    expect(await parse(ev(SESSION('requires_payment', { metadata: { ork_ref: ref } })))).toEqual([{ ref, status: 'requires_action', providerRef: 'cos_123' }])
    // A session of another integration (no ork_ref, not in the index) is not ours
    expect(await parse(ev(SESSION('fulfillment_complete')))).toEqual([])
    // ... unless the index knows it
    await shared.put('cos:cos_123', ref)
    expect(await parse(ev(SESSION('fulfillment_processing')))).toMatchObject([{ ref, status: 'processing' }])
    expect(await parse(ev(SESSION('fulfillment_paused', { metadata: { ork_ref: ref } })))).toEqual([])
    expect(await parse({ type: 'payment_intent.succeeded', data: { object: { id: 'pi_1' } } })).toEqual([])
    expect(await parse({ type: 'crypto.onramp_session.updated', data: {} })).toEqual([])
    expect(await a.webhook!.parse('{', wctx)).toEqual([])
  })

  it('passes runAdapterConformance', async () => {
    const p = provider({ wallets: () => ({ data: [{ wallet_address: WALLET, network: 'base' }] }) })
    const ref = `slk_${'b'.repeat(24)}`
    const body = JSON.stringify({ id: 'evt_2', type: 'crypto.onramp_session.updated', data: { object: SESSION('fulfillment_complete', { metadata: { ork_ref: ref } }) } })
    const t = Math.floor(Date.now() / 1000)
    const sig = `t=${t},v1=${createHmac('sha256', WH).update(`${t}.${body}`).digest('hex')}`
    const report = await runAdapterConformance(stripeLink(opts), {
      fetch: p.fetch,
      ctx: () => makeCtx({ fetch: p.fetch, session: { email: 'user@example.com', ip: '203.0.113.9' } }),
      fixtures: [
        {
          leg: leg('card'),
          quote: { amountIn: usd('100') },
          expect: { start: 'AUTH', status: 'COMPLETED' },
          transitions: [
            { name: T.authenticated, inputs: { cryptoCustomerId: 'crc_1', clientKey: KEY } },
            { name: T.paymentMethod, inputs: { paymentToken: 'cpt_1', clientKey: KEY } },
            { name: T.checkout, inputs: { clientKey: KEY } },
          ],
        },
        { leg: leg('google_pay'), quote: { amountIn: usd('50') }, expect: { start: 'AUTH' } },
      ],
      errorPaths: [{ leg: leg('card'), quote: { amountIn: usd('100') } }],
      webhooks: [
        { name: 'signed', rawBody: body, request: () => new Request('https://x/h', { method: 'POST', body, headers: { 'stripe-signature': sig } }), events: 1 },
        { name: 'bad', rawBody: body, request: () => new Request('https://x/h', { method: 'POST', body, headers: { 'stripe-signature': `t=${t},v1=00` } }), valid: false },
      ],
    })
    expect(report.problems).toEqual([])
  })
})
