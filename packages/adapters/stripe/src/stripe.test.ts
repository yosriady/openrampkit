import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { checkAdapterShape, checkLegQuote, checkLegStep } from '@openrampkit/adapter'
import { USDC, isRegionAllowed, stateFor } from '@openrampkit/core'
import type { PathwayLeg } from '@openrampkit/core'
import { fakeFetch, makeCtx, makeWebhookCtx, runAdapterConformance } from '@openrampkit/adapter/testing'
import { parseStripeSignature, stripe } from './index.js'

const SK = 'sk_test_51abc'
const PK = 'pk_test_51abc'
const WH = 'whsec_test_secret'
const opts = { secretKey: SK, publishableKey: PK, webhookSecret: WH }
const BASE_USDC = { kind: 'crypto' as const, chain: 'eip155:8453', token: USDC['eip155:8453']! }
const ETH_USDC = { kind: 'crypto' as const, chain: 'eip155:1', token: USDC['eip155:1']! }
const POLY_USDC = { kind: 'crypto' as const, chain: 'eip155:137', token: USDC['eip155:137']! }
const usd = (amount: string) => ({ value: amount, asset: { kind: 'fiat' as const, currency: 'USD' } })

const leg = (legId: string, to: typeof BASE_USDC = BASE_USDC, currency = 'USD'): PathwayLeg => ({
  adapterId: 'stripe',
  legId,
  from: { asset: { kind: 'fiat', currency }, location: { kind: 'user_account' } },
  to: { asset: to, location: { kind: 'address', address: 'deposit' } },
})

// Shape from https://docs.stripe.com/api/crypto/onramp_quotes/retrieve
const QUOTES = {
  id: 'cpqt_1', object: 'crypto.onramp.quotes', livemode: false, source_amount: '100.00', source_currency: 'usd', rate_fetched_at: 1727600000.1,
  destination_network_quotes: {
    base_network: [
      { id: 'q1', destination_currency: 'usdc', destination_network: 'base', destination_amount: '97.912345', source_total_amount: '103.26', fees: { network_fee_monetary: '0.01', transaction_fee_monetary: '3.25' } },
      { id: 'q2', destination_currency: 'eth', destination_network: 'base', destination_amount: '0.03', source_total_amount: '103.26', fees: {} },
    ],
  },
}

const SESSION = (status: string, extra: Record<string, unknown> = {}) => ({
  id: 'cos_123', object: 'crypto.onramp_session', client_secret: 'cos_123_secret_abc', livemode: false, status,
  redirect_url: 'https://crypto.link.com?session_hash=abc',
  transaction_details: { destination_amount: '97.912345', destination_currency: 'usdc', destination_network: 'base', source_amount: '100.00', source_currency: 'usd', transaction_id: null, wallet_address: '0xabc' },
  ...extra,
})

describe('stripe adapter', () => {
  it('declares card, Apple Pay, Google Pay and ACH legs for the US (not Hawaii) and the EU', () => {
    const a = stripe(opts)
    expect(checkAdapterShape(a)).toEqual([])
    expect(a.legs.map((l) => [l.id, l.surfaces])).toEqual([
      ['card', ['PROVIDER_SDK']], ['apple_pay', ['PROVIDER_SDK']], ['google_pay', ['PROVIDER_SDK']], ['ach', ['PROVIDER_SDK']],
    ])
    const card = a.legs[0]!
    expect(isRegionAllowed(card.regions, 'US', 'US-CA')).toBe(true)
    expect(isRegionAllowed(card.regions, 'US', 'US-HI')).toBe(false)
    expect(isRegionAllowed(card.regions, 'FR')).toBe(true)
    expect(isRegionAllowed(card.regions, 'GB')).toBe(false)
    expect(isRegionAllowed(card.regions, 'SG')).toBe(false)
    const ach = a.legs.find((l) => l.id === 'ach')!
    expect(isRegionAllowed(ach.regions, 'FR')).toBe(false)
    expect(ach.from.asset).toEqual({ kind: 'fiat', currencies: ['USD'] })
    expect(stripe({ ...opts, surface: 'redirect', methods: ['card'] }).legs.map((l) => l.surfaces)).toEqual([['REDIRECT']])
    expect(() => stripe({ ...opts, methods: [] })).toThrow()
  })

  it('quote: GET /v1/crypto/onramp_quotes with basic auth, picks the USDC quote on the network', async () => {
    const { fetch, calls } = fakeFetch([{ match: '/v1/crypto/onramp_quotes', reply: () => QUOTES }])
    const q = await stripe(opts).quote({ leg: leg('card'), amountIn: usd('100') }, makeCtx({ fetch }))
    expect(checkLegQuote(q)).toEqual([])
    const u = new URL(calls[0]!.url)
    expect(u.origin + u.pathname).toBe('https://api.stripe.com/v1/crypto/onramp_quotes')
    expect([...u.searchParams]).toEqual([
      ['source_currency', 'usd'], ['source_amount', '100.00'], ['destination_currencies[]', 'usdc'], ['destination_networks[]', 'base'],
    ])
    expect(calls[0]!.headers.get('authorization')).toBe(`Basic ${Buffer.from(`${SK}:`).toString('base64')}`)
    expect(q.input).toEqual(usd('103.26'))
    expect(q.output).toEqual({ value: '97.912345', asset: { ...BASE_USDC, symbol: 'USDC', decimals: 6 } })
    expect(q.fees).toEqual([
      { kind: 'provider', label: 'Stripe fee', amount: usd('3.25'), included: true },
      { kind: 'network', label: 'Network fee', amount: usd('0.01'), included: true },
    ])
    expect(q.guarantee).toBe('estimate')
    expect(q.minOutput).toBeUndefined()
  })

  it('quote: falls back to /v1/crypto/onramp/quotes on 404, supports exact output', async () => {
    const { fetch, calls } = fakeFetch([
      { match: '/v1/crypto/onramp_quotes', status: 404, reply: () => ({ error: { message: 'Unrecognized request URL' } }) },
      { match: '/v1/crypto/onramp/quotes', reply: () => ({ destination_network_quotes: { ethereum: [{ destination_currency: 'usdc', destination_amount: '50', source_total_amount: '52.5', fees: { transaction_fee_monetary: '2.5' } }] } }) },
    ])
    const q = await stripe(opts).quote({ leg: leg('card', ETH_USDC), amountOut: { value: '50', asset: ETH_USDC } }, makeCtx({ fetch }))
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/v1/crypto/onramp_quotes', '/v1/crypto/onramp/quotes'])
    expect(new URL(calls[1]!.url).searchParams.get('destination_amount')).toBe('50')
    expect(new URL(calls[1]!.url).searchParams.get('source_amount')).toBeNull()
    expect(q.output.value).toBe('50')
    expect(q.input.value).toBe('52.5')
  })

  it('quote: region rules per asset (no Base USDC in the EU, no Polygon USDC in New York)', async () => {
    const { fetch, calls } = fakeFetch([{ match: '/onramp_quotes', reply: () => QUOTES }])
    const a = stripe(opts)
    await expect(a.quote({ leg: leg('card', BASE_USDC, 'EUR'), amountIn: { value: '100', asset: { kind: 'fiat', currency: 'EUR' } } }, makeCtx({ fetch, session: { country: 'DE' } }))).rejects.toMatchObject({ error: { code: 'REGION_UNSUPPORTED' } })
    await expect(a.quote({ leg: leg('card', POLY_USDC), amountIn: usd('100') }, makeCtx({ fetch, session: { country: 'US', region: 'US-NY' } }))).rejects.toMatchObject({ error: { code: 'REGION_UNSUPPORTED' } })
    await expect(a.quote({ leg: leg('card', BASE_USDC, 'GBP'), amountIn: { value: '100', asset: { kind: 'fiat', currency: 'GBP' } } }, makeCtx({ fetch }))).rejects.toMatchObject({ error: { code: 'NO_QUOTES' } })
    expect(calls).toHaveLength(0)
  })

  it('quote: maps Stripe errors', async () => {
    const run = (status: number, body: unknown) =>
      stripe(opts).quote({ leg: leg('card'), amountIn: usd('100') }, makeCtx({ fetch: fakeFetch([{ match: '/onramp_quotes', status, reply: () => body }]).fetch }))
    await expect(run(400, { error: { code: 'crypto_onramp_unsupported_country', message: 'x' } })).rejects.toMatchObject({ error: { code: 'REGION_UNSUPPORTED' } })
    await expect(run(400, { error: { message: 'Amount must be at least $1.00' } })).rejects.toMatchObject({ error: { code: 'NO_QUOTES', message: 'Stripe: Amount must be at least $1.00' } })
    await expect(run(401, { error: { message: 'Invalid API Key' } })).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
    await expect(run(429, {})).rejects.toMatchObject({ error: { code: 'RATE_LIMITED' } })
    await expect(run(500, {})).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
    await expect(run(200, { destination_network_quotes: {} })).rejects.toMatchObject({ error: { code: 'NO_QUOTES' } })
  })

  it('start: form-encoded session, idempotency key, PROVIDER_SDK surface with the client secret', async () => {
    const { fetch, calls } = fakeFetch([
      { match: '/onramp_quotes', reply: () => QUOTES },
      { method: 'POST', match: '/v1/crypto/onramp_sessions', reply: () => SESSION('initialized') },
    ])
    const a = stripe(opts)
    const ctx = makeCtx({ fetch, session: { ip: '203.0.113.9' } })
    const q = await a.quote({ leg: leg('card'), amountIn: usd('100') }, ctx)
    const step = await a.start({ leg: leg('card'), quote: q, deliverTo: { address: '0xd16e' } }, ctx)
    expect(checkLegStep(step)).toEqual([])
    expect(stateFor(step)).toBe('PAYMENT')
    // The onramp session id is both our ref and Stripe's order id
    expect(step).toMatchObject({ status: 'requires_action', action: { kind: 'payment', transitions: [{ kind: 'AWAIT' }] }, ref: 'cos_123', providerRef: 'cos_123' })
    expect(step.action!.surface).toEqual({
      kind: 'PROVIDER_SDK', provider: 'stripe',
      params: { clientSecret: 'cos_123_secret_abc', publishableKey: PK, sessionId: 'cos_123', redirectUrl: 'https://crypto.link.com?session_hash=abc' },
    })
    const post = calls[1]!
    expect(post.url).toBe('https://api.stripe.com/v1/crypto/onramp_sessions')
    expect(post.headers.get('content-type')).toBe('application/x-www-form-urlencoded')
    expect(post.headers.get('idempotency-key')).toMatch(/^sess_1:stripe:[0-9a-f]{16}$/)
    expect([...new URLSearchParams(post.raw!)]).toEqual([
      ['wallet_addresses[base_network]', '0xd16e'],
      ['lock_wallet_address', 'true'],
      ['destination_currency', 'usdc'],
      ['destination_network', 'base'],
      ['destination_currencies[]', 'usdc'],
      ['destination_networks[]', 'base'],
      ['source_currency', 'usd'],
      ['source_amount', '100.00'],
      ['customer_ip_address', '203.0.113.9'],
      ['metadata[ork_session]', 'sess_1'],
      ['metadata[ork_leg]', 'card'],
    ])
  })

  it('start: REDIRECT to the hosted onramp when asked, SDK fallback without redirect_url, rejected sessions fail', async () => {
    const quote = { adapterId: 'stripe', legId: 'card', input: usd('103'), output: { value: '97', asset: ETH_USDC }, fees: [], guarantee: 'estimate' as const, eta: { min: 1, max: 2 }, expiresAt: '2030-01-01T00:00:00.000Z', data: { network: 'ethereum', sourceCurrency: 'usd', sourceAmount: '100.00' } }
    const run = async (session: unknown, surface: 'sdk' | 'redirect' = 'redirect') => {
      const { fetch, calls } = fakeFetch([{ method: 'POST', match: '/onramp_sessions', reply: () => session }])
      const step = await stripe({ ...opts, surface }).start({ leg: leg('card', ETH_USDC), quote }, makeCtx({ fetch }))
      return { step, body: new URLSearchParams(calls[0]!.raw!) }
    }
    const r1 = await run(SESSION('initialized'))
    expect(r1.step.action!.surface).toEqual({ kind: 'REDIRECT', url: 'https://crypto.link.com?session_hash=abc', popup: true, provider: 'Stripe' })
    expect(r1.body.get('wallet_addresses[ethereum]')).toBe('0x000000000000000000000000000000000000beef')
    expect(r1.body.get('customer_ip_address')).toBeNull()
    expect((await run(SESSION('initialized', { redirect_url: null }))).step.action!.surface?.kind).toBe('PROVIDER_SDK')
    const rejected = (await run(SESSION('rejected'))).step
    expect(checkLegStep(rejected)).toEqual([])
    expect(stateFor(rejected)).toBe('FAILED')
    expect(rejected).toMatchObject({ status: 'failed', ref: 'cos_123', providerRef: 'cos_123', error: { code: 'PROVIDER_DECLINED' } })
    await expect(run({ id: 'cos_1' })).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
  })

  it('status: maps session statuses', async () => {
    const run = async (s: unknown) => {
      const { fetch, calls } = fakeFetch([{ match: '/v1/crypto/onramp_sessions/cos_123', reply: () => s }])
      const step = await stripe(opts).status!({ leg: leg('card'), ref: 'cos_123' }, makeCtx({ fetch }))
      expect(calls[0]!.method).toBe('GET')
      expect(checkLegStep(step)).toEqual([])
      return step
    }
    for (const st of ['initialized', 'requires_payment']) {
      const s = await run(SESSION(st))
      expect(stateFor(s)).toBe('PAYMENT')
      // A status poll without a surface: the UI keeps the onramp
      expect(s).toMatchObject({ status: 'requires_action', providerRef: 'cos_123', action: { kind: 'payment', transitions: [{ kind: 'AWAIT' }] } })
      expect(s.action!.surface).toBeUndefined()
    }
    const processing = await run(SESSION('fulfillment_processing'))
    expect(stateFor(processing)).toBe('PROCESSING')
    expect(processing).toMatchObject({ status: 'processing', providerRef: 'cos_123', detail: { code: 'processing', providerStatus: 'fulfillment_processing' } })
    const done = await run(SESSION('fulfillment_complete', { transaction_details: { ...SESSION('x').transaction_details, transaction_id: '0xhash' } }))
    expect(stateFor(done)).toBe('COMPLETED')
    expect(done).toMatchObject({
      status: 'succeeded', providerRef: 'cos_123', transactions: [{ role: 'destination', hash: '0xhash', chain: 'eip155:8453' }], output: { value: '97.912345', asset: { chain: 'eip155:8453' } },
    })
    const rejected = await run(SESSION('rejected'))
    expect(stateFor(rejected)).toBe('FAILED')
    expect(rejected).toMatchObject({ error: { code: 'PROVIDER_DECLINED' } })
    // An unknown Stripe status is never `processing`: a status poll that keeps the current step
    const unknown = await run(SESSION('fulfillment_paused'))
    expect(unknown.status).not.toBe('processing')
    expect(unknown).toMatchObject({ status: 'requires_action', action: { kind: 'payment' } })
  })

  it('webhook: Stripe-Signature (good, rotated v1, bad, missing, stale) and parse', async () => {
    const a = stripe(opts)
    const wctx = makeWebhookCtx()
    const body = JSON.stringify({ id: 'evt_1', type: 'crypto.onramp_session.updated', data: { object: SESSION('fulfillment_complete', { transaction_details: { ...SESSION('x').transaction_details, transaction_id: '0xhash' } }) } })
    const t = Math.floor(Date.now() / 1000)
    const v1 = (ts: number, b = body, secret = WH) => createHmac('sha256', secret).update(`${ts}.${b}`).digest('hex')
    const req = (h?: string) => new Request('https://app.test/hook', { method: 'POST', body, headers: h ? { 'Stripe-Signature': h } : {} })
    expect(await a.webhook!.verify(req(`t=${t},v1=${v1(t)}`), body, wctx)).toBe(true)
    expect(await a.webhook!.verify(req(`t=${t},v1=${v1(t, body, 'old')},v1=${v1(t)},v0=abc`), body, wctx)).toBe(true)
    expect(await a.webhook!.verify(req(`t=${t},v1=${v1(t, 'x')}`), body, wctx)).toBe(false)
    expect(await a.webhook!.verify(req(`t=${t},v0=${v1(t)}`), body, wctx)).toBe(false)
    expect(await a.webhook!.verify(req(), body, wctx)).toBe(false)
    expect(await a.webhook!.verify(req(`t=${t - 301},v1=${v1(t - 301)}`), body, wctx)).toBe(false)
    // An unset secret (e.g. a missing environment variable) must not accept a signature made with an empty key.
    const unset = stripe({ ...opts, webhookSecret: undefined as unknown as string })
    expect(await unset.webhook!.verify(req(`t=${t},v1=${v1(t, body, '')}`), body, wctx)).toBe(false)
    expect(parseStripeSignature('t=1,v1=a,v1=b')).toEqual({ t: '1', v1: ['a', 'b'] })
    // Known vector: HMAC-SHA256("whsec_test_secret", "1700000000.{}")
    expect(v1(1700000000, '{}')).toBe('ceb8863f7208fa249a6cd8f951e993c7563412aca65866f6272283debe143ab3')

    expect(await a.webhook!.parse(body, wctx)).toEqual([
      {
        ref: 'cos_123',
        status: 'succeeded',
        providerRef: 'cos_123',
        transactions: [{ role: 'destination', hash: '0xhash', chain: 'eip155:8453' }],
        output: { value: '97.912345', asset: { ...BASE_USDC, symbol: 'USDC', decimals: 6 } },
      },
    ])
    const parse = (o: unknown) => a.webhook!.parse(JSON.stringify(o), wctx)
    expect(await parse({ type: 'crypto.onramp_session_updated', data: { object: SESSION('fulfillment_processing') } })).toMatchObject([{ status: 'processing' }])
    expect(await parse({ type: 'crypto.onramp_session.updated', data: { object: SESSION('initialized') } })).toEqual([{ ref: 'cos_123', status: 'requires_action', providerRef: 'cos_123' }])
    // An unknown status: no event
    expect(await parse({ type: 'crypto.onramp_session.updated', data: { object: SESSION('fulfillment_paused') } })).toEqual([])
    expect(await parse({ type: 'payment_intent.succeeded', data: { object: { id: 'pi_1' } } })).toEqual([])
    expect(await parse({ type: 'crypto.onramp_session.updated', data: {} })).toEqual([])
    expect(await a.webhook!.parse('{', wctx)).toEqual([])
  })

  it('passes runAdapterConformance', async () => {
    const { fetch } = fakeFetch([
      { match: '/onramp_quotes', reply: () => QUOTES },
      { method: 'POST', match: '/v1/crypto/onramp_sessions', reply: () => SESSION('initialized') },
      { method: 'GET', match: '/v1/crypto/onramp_sessions/', reply: () => SESSION('fulfillment_complete') },
    ])
    const body = JSON.stringify({ type: 'crypto.onramp_session.updated', data: { object: SESSION('fulfillment_complete') } })
    const t = Math.floor(Date.now() / 1000)
    const sig = `t=${t},v1=${createHmac('sha256', WH).update(`${t}.${body}`).digest('hex')}`
    const report = await runAdapterConformance(stripe(opts), {
      fetch,
      fixtures: [
        { leg: leg('card'), quote: { amountIn: usd('100') }, expect: { start: 'PAYMENT', status: 'COMPLETED' } },
        { leg: leg('ach'), quote: { amountIn: usd('100') } },
      ],
      webhooks: [
        { name: 'signed', rawBody: body, request: () => new Request('https://x/h', { method: 'POST', body, headers: { 'stripe-signature': sig } }), events: 1 },
        { name: 'bad', rawBody: body, request: () => new Request('https://x/h', { method: 'POST', body, headers: { 'stripe-signature': `t=${t},v1=00` } }), valid: false },
      ],
    })
    expect(report.problems).toEqual([])
  })
})
