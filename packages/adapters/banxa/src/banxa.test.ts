import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { checkAdapterShape, checkLegQuote, checkLegStep, resultChannels } from '@openrampkit/adapter'
import { USDC, isRegionAllowed, stateFor } from '@openrampkit/core'
import type { PathwayLeg } from '@openrampkit/core'
import { fakeFetch, makeCtx, makeWebhookCtx, memoryKV, recordingLog, runAdapterConformance, silentLog } from '@openrampkit/adapter/testing'
import type { FakeRoute } from '@openrampkit/adapter/testing'
import { BANXA_METHODS, banxa, banxaCanonical, banxaSignature } from './index.js'

const API_KEY = 'bx_api_key'
const HMAC_KEY = 'pk_2f8c91ab4d7e'
const HMAC_SECRET = 'bx_hmac_secret'
const BASE_USDC = { kind: 'crypto' as const, chain: 'eip155:8453', token: USDC['eip155:8453']! }
const ETH_USDC = { kind: 'crypto' as const, chain: 'eip155:1', token: USDC['eip155:1']! }
const usd = (amount: string) => ({ value: amount, asset: { kind: 'fiat' as const, currency: 'USD' } })
const HOOK_PATH = '/api/openramp/webhooks/banxa'
const HOOK_URL = `https://app.test${HOOK_PATH}`

const leg = (legId: string, to = BASE_USDC, currency = 'USD'): PathwayLeg => ({
  adapterId: 'banxa',
  legId,
  from: { asset: { kind: 'fiat', currency }, location: { kind: 'user_account' } },
  to: { asset: to, location: { kind: 'address', address: 'deposit' } },
})

const opts = { partnerRef: 'mypartner', apiKey: API_KEY, hmacSecret: HMAC_SECRET, hmacKey: HMAC_KEY, env: 'production' as const }

// Shapes from the docs (Get a Quote, Create Buy Order, Order Lookup, OpenAPI catalog examples)
const QUOTE = { paymentMethodId: 'debit-credit-card', cryptoAmount: '96.41000000', fiatAmount: '100.00', processingFee: '0.92', networkFee: '1.67' }
const CREATED = {
  checkoutUrl: 'https://partner.banxa.com/portal?expires=xxx&oid=xxx&signature=xxx',
  id: '191fa5b4b1f45e1cf784422e09317d56',
  externalOrderId: 'ork_x',
  externalCustomerId: 'user_1',
  fiat: 'USD',
  fiatAmount: '100.00',
  crypto: 'USDC',
  cryptoAmount: null,
  blockchain: 'BASE',
}
const ORDER = (status: string, extra: Record<string, unknown> = {}) => ({
  id: '191fa5b4b1f45e1cf784422e09317d56',
  externalId: 'ork_abc',
  externalCustomerId: 'user_1',
  country: 'US',
  orderType: 'BUY',
  status,
  crypto: { id: 'USDC', blockchain: 'BASE', address: USDC['eip155:8453'], network: '8453' },
  fiat: 'USD',
  fiatAmount: '100.00',
  cryptoAmount: '96.41',
  paymentMethodId: 'debit-credit-card',
  processingFee: '0.92',
  networkFee: '1.67',
  walletAddress: '0x000000000000000000000000000000000000beef',
  ...extra,
})
const CRYPTO = [
  { id: 'AAVE', blockchains: [{ id: 'ETH', network: '1', address: '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9', unsupportedCountries: [] }] },
  {
    id: 'USDC',
    blockchains: [
      { id: 'ETH', network: '1', address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', unsupportedCountries: { CA: [], US: ['NY'] } },
      { id: 'BASE_MAINNET', network: '8453', address: USDC['eip155:8453'], unsupportedCountries: [] },
      { id: 'MATIC', network: '137', address: USDC['eip155:137'], unsupportedCountries: [] },
    ],
  },
]
const FIATS = [{ id: 'USD', supportedPaymentMethods: [{ id: 'debit-credit-card', minimum: '10', maximum: '50000' }, { id: 'apple-pay', minimum: '75', maximum: '50000' }] }]

const routes = (over: FakeRoute[] = []): FakeRoute[] => [
  ...over,
  { match: '/v2/crypto/buy', reply: () => CRYPTO },
  { match: '/v2/fiats/buy', reply: () => FIATS },
  { match: '/v2/quotes/buy', reply: () => QUOTE },
  { method: 'POST', match: '/v2/buy', status: 201, reply: () => CREATED },
  { match: '/v2/orders/', reply: () => ORDER('complete', { transactionHash: '0xhash' }) },
]

const WEBHOOK = (status: string, extra: Record<string, unknown> = {}) => ({
  order_id: '191fa5b4b1f45e1cf784422e09317d56',
  status,
  status_date: '2026-01-1604:04:21',
  created_at: '2026-01-1604:04:20',
  updated_at: '2026-01-1604:04:20',
  external_id: 'ork_abc',
  order_type: 'BUY',
  crypto_coin: 'USDC',
  crypto_blockchain: 'BASE',
  crypto_amount: '96.4100000000000000',
  fiat_currency: 'USD',
  fiat_amount: '100',
  payment_method: 'debit-credit-card',
  original_payment_method: 'debit-credit-card',
  is_retry: false,
  processing_fee: '0.92',
  network_fee: '1.67',
  transaction_hash: '0',
  metadata: [],
  ...extra,
})

/** The Authorization header that Banxa sends, made with node:crypto (tests only) */
const authHeader = (body: string, opts2: { path?: string; nonce?: string; secret?: string; key?: string } = {}) => {
  const nonce = opts2.nonce ?? '1785804345837761'
  const sig = createHmac('sha256', opts2.secret ?? HMAC_SECRET).update(`POST\n${opts2.path ?? HOOK_PATH}\n${nonce}\n${body}`).digest('hex')
  return `Bearer ${opts2.key ?? HMAC_KEY}:${sig}:${nonce}`
}
const hookReq = (body: string, auth?: string, url = HOOK_URL) => new Request(url, { method: 'POST', body, headers: auth ? { authorization: auth } : {} })

describe('banxa adapter', () => {
  it('declares one leg per buy payment method with Banxa region rules', () => {
    const a = banxa(opts)
    expect(checkAdapterShape(a)).toEqual([])
    expect(a.id).toBe('banxa')
    expect(a.env).toBe('production')
    expect(a.legs.map((l) => l.id)).toEqual(BANXA_METHODS.map((m) => m.id))
    expect(a.legs.map((l) => l.id)).not.toContain('ach')
    const card = a.legs.find((l) => l.id === 'card')!
    expect(card.methods).toEqual(['card'])
    expect(card.kind).toBe('fiat_onramp')
    expect(card.surfaces).toEqual(['REDIRECT'])
    expect(card.requires).toEqual(['provider_kyc'])
    expect(card.to.asset).toMatchObject({ kind: 'crypto', chains: { 'eip155:8453': [USDC['eip155:8453']!.toLowerCase()] } })
    expect(isRegionAllowed(card.regions, 'US', 'US-CA')).toBe(true)
    expect(isRegionAllowed(card.regions, 'AU')).toBe(true)
    for (const c of ['NG', 'RU', 'MY', 'UA', 'CN']) expect(isRegionAllowed(card.regions, c)).toBe(false)
    const sepa = a.legs.find((l) => l.id === 'sepa')!
    expect(sepa.from.asset).toEqual({ kind: 'fiat', currencies: ['EUR'] })
    expect(isRegionAllowed(sepa.regions, 'DE')).toBe(true)
    expect(isRegionAllowed(sepa.regions, 'US')).toBe(false)
    expect(a.legs.find((l) => l.id === 'payid')!.methods).toEqual(['payid'])
    expect(a.legs.find((l) => l.id === 'gbp_bank')!.methods).toEqual(['faster_payments'])
    expect(banxa({ ...opts, methods: ['card'], surface: 'iframe' }).legs.map((l) => [l.id, l.surfaces])).toEqual([['card', ['IFRAME']]])
    expect(() => banxa({ ...opts, methods: ['nope'] })).toThrow(/selects no known leg/)
    expect(() => banxa({ ...opts, partnerRef: '' })).toThrow(/partnerRef/)
    expect(() => banxa({ ...opts, partnerRef: 'a/b' })).toThrow(/partnerRef/)
    expect(() => banxa({ ...opts, env: 'live' as never })).toThrow(/env/)
  })

  it('webhooks are configured only with the HMAC secret', () => {
    expect(resultChannels(banxa(opts))).toEqual({ polling: true, webhooks: true })
    expect(resultChannels(banxa({ ...opts, hmacSecret: undefined }))).toEqual({ polling: true, webhooks: false })
  })

  it('quote: GET /{partnerRef}/v2/quotes/buy with x-api-key, the live blockchain code, fees and the spread', async () => {
    const { fetch, calls } = fakeFetch(routes())
    const a = banxa({ ...opts, discountCode: 'XMAS' })
    const ctx = makeCtx({ fetch, session: { userId: 'u_42', ip: '203.0.113.10' } })
    const q = await a.quote({ leg: leg('card'), amountIn: usd('100') }, ctx)
    expect(checkLegQuote(q)).toEqual([])
    const call = calls.find((c) => c.url.includes('/quotes/buy'))!
    const u = new URL(call.url)
    expect(u.origin + u.pathname).toBe('https://api.banxa.com/mypartner/v2/quotes/buy')
    expect(call.headers.get('x-api-key')).toBe(API_KEY)
    expect(call.headers.get('authorization')).toBeNull()
    expect(Object.fromEntries(u.searchParams)).toEqual({
      fiat: 'USD',
      crypto: 'USDC',
      // From GET /v2/crypto/buy, matched by chain id 8453 and the token address
      blockchain: 'BASE_MAINNET',
      paymentMethodId: 'debit-credit-card',
      fiatAmount: '100.00',
      externalCustomerId: 'u_42',
      ipAddress: '203.0.113.10',
      discountCode: 'XMAS',
    })
    expect(q.input).toEqual(usd('100'))
    expect(q.output).toEqual({ value: '96.41', asset: { ...BASE_USDC, symbol: 'USDC', decimals: 6 } })
    expect(q.fees).toEqual([
      { kind: 'provider', label: 'Banxa processing fee', amount: usd('0.92'), included: true },
      { kind: 'network', label: 'Network fee', amount: usd('1.67'), included: true },
      { kind: 'provider', label: 'Banxa spread (in the rate)', amount: null, included: true },
    ])
    expect(q.guarantee).toBe('estimate')
    expect(Date.parse(q.expiresAt) - Date.now()).toBeLessThanOrEqual(60_000)
    expect(q.data).toMatchObject({ coin: 'USDC', blockchain: 'BASE_MAINNET', paymentMethodId: 'debit-credit-card', side: 'fiat' })
    // The catalog lists are cached in the shared store
    await a.quote({ leg: leg('card'), amountIn: usd('100') }, ctx)
    expect(calls.filter((c) => c.url.includes('/crypto/buy'))).toHaveLength(1)
    expect(calls.filter((c) => c.url.includes('/fiats/buy'))).toHaveLength(1)
  })

  it('quote: by crypto amount, the discount code list answer, the sandbox host and the static code fallback', async () => {
    const { fetch, calls } = fakeFetch([
      { match: '/v2/crypto/buy', status: 500, reply: () => ({}) },
      { match: '/v2/quotes/buy', reply: () => [{ ...QUOTE, fiatAmount: '52.10', cryptoAmount: '50', processingFee: '0', networkFee: '0', partnerFee: '0.50', discount: { discountCode: 'XMAS' } }] },
    ])
    const log = recordingLog()
    const a = banxa({ ...opts, env: 'sandbox' })
    const q = await a.quote({ leg: leg('apple_pay', ETH_USDC), amountOut: { value: '50', asset: ETH_USDC } }, makeCtx({ fetch, log }))
    const u = new URL(calls.find((c) => c.url.includes('/quotes/buy'))!.url)
    expect(u.origin).toBe('https://api.banxa-sandbox.com')
    expect(u.searchParams.get('cryptoAmount')).toBe('50.000000')
    expect(u.searchParams.get('fiatAmount')).toBeNull()
    expect(u.searchParams.get('paymentMethodId')).toBe('apple-pay')
    // The crypto list failed: the static code
    expect(u.searchParams.get('blockchain')).toBe('ETH')
    expect(log.warnings.some((w) => w.includes('/v2/crypto/buy failed'))).toBe(true)
    expect(q.input).toEqual(usd('52.1'))
    expect(q.output).toMatchObject({ value: '50', asset: { chain: 'eip155:1' } })
    // Zero fees are left out; the partner fee is an app fee
    expect(q.fees).toEqual([
      { kind: 'app', label: 'App fee', amount: usd('0.5'), included: true },
      { kind: 'provider', label: 'Banxa spread (in the rate)', amount: null, included: true },
    ])
    expect(q.data).toMatchObject({ side: 'crypto', cryptoAmount: '50' })
  })

  it('quote: region rules per asset (no stablecoins in Canada; live US state rules), before any quote call', async () => {
    const { fetch, calls } = fakeFetch(routes())
    const a = banxa(opts)
    await expect(a.quote({ leg: leg('card'), amountIn: usd('100') }, makeCtx({ fetch, session: { country: 'CA' } }))).rejects.toMatchObject({ error: { code: 'REGION_UNSUPPORTED' } })
    await expect(a.quote({ leg: leg('card', ETH_USDC), amountIn: usd('100') }, makeCtx({ fetch, session: { country: 'US', region: 'US-NY' } }))).rejects.toMatchObject({
      error: { code: 'REGION_UNSUPPORTED', recovery: 'choose_other' },
    })
    expect(calls.filter((c) => c.url.includes('/quotes/buy'))).toHaveLength(0)
    await expect(a.quote({ leg: leg('card', ETH_USDC), amountIn: usd('100') }, makeCtx({ fetch, session: { country: 'US', region: 'US-CA' } }))).resolves.toBeTruthy()
    // A token Banxa does not deliver: NO_QUOTES, never another token
    const other = { kind: 'crypto' as const, chain: 'eip155:8453', token: '0x0000000000000000000000000000000000000001' }
    await expect(a.quote({ leg: leg('card', other), amountIn: usd('100') }, makeCtx({ fetch }))).rejects.toMatchObject({ error: { code: 'NO_QUOTES' } })
  })

  it('quote: amount limits from GET /v2/fiats/buy', async () => {
    const { fetch, calls } = fakeFetch(routes())
    const a = banxa(opts)
    await expect(a.quote({ leg: leg('card'), amountIn: usd('5') }, makeCtx({ fetch }))).rejects.toMatchObject({ error: { code: 'AMOUNT_TOO_LOW' } })
    await expect(a.quote({ leg: leg('apple_pay'), amountIn: usd('50') }, makeCtx({ fetch }))).rejects.toMatchObject({ error: { code: 'AMOUNT_TOO_LOW', message: 'The Banxa minimum is 75 USD.' } })
    await expect(a.quote({ leg: leg('card'), amountIn: usd('60000') }, makeCtx({ fetch }))).rejects.toMatchObject({ error: { code: 'AMOUNT_TOO_HIGH' } })
    expect(calls.filter((c) => c.url.includes('/quotes/buy'))).toHaveLength(0)
    // No limits list: Banxa decides
    const noLimits = fakeFetch(routes([{ match: '/v2/fiats/buy', status: 500, reply: () => ({}) }]))
    await expect(a.quote({ leg: leg('card'), amountIn: usd('5') }, makeCtx({ fetch: noLimits.fetch }))).resolves.toBeTruthy()
  })

  it('quote: maps Banxa errors (5034, limits and KYC text, 400, 401, 429, 5xx, empty answers)', async () => {
    const a = banxa(opts)
    const run = (status: number, body: unknown = {}, legId = 'card') =>
      a.quote({ leg: leg(legId), amountIn: usd('100') }, makeCtx({ fetch: fakeFetch(routes([{ match: '/v2/quotes/buy', status, reply: () => body }])).fetch }))
    await expect(run(422, { code: 5034, message: 'Coin restriction' })).rejects.toMatchObject({ error: { code: 'REGION_UNSUPPORTED', message: 'Banxa: Coin restriction' } })
    await expect(run(400, { code: '4002', message: 'Amount is below the minimum of 20 USD' })).rejects.toMatchObject({ error: { code: 'AMOUNT_TOO_LOW' } })
    await expect(run(400, { message: 'Amount exceeds the maximum limit' })).rejects.toMatchObject({ error: { code: 'AMOUNT_TOO_HIGH' } })
    await expect(run(422, { message: 'Customer KYC was rejected' })).rejects.toMatchObject({ error: { code: 'KYC_REJECTED' } })
    await expect(run(400, { message: 'Currency not available on pricing' })).rejects.toMatchObject({ error: { code: 'NO_QUOTES', message: 'Banxa: Currency not available on pricing' } })
    await expect(run(401, { message: 'Unauthorized' })).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE', retryable: false } })
    await expect(run(429)).rejects.toMatchObject({ error: { code: 'RATE_LIMITED' } })
    await expect(run(503)).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' }, status: 502 })
    await expect(run(200, { paymentMethodId: 'debit-credit-card' })).rejects.toMatchObject({ error: { code: 'NO_QUOTES' } })
    await expect(run(200, { ...QUOTE, cryptoAmount: '0' })).rejects.toMatchObject({ error: { code: 'NO_QUOTES' } })
    await expect(run(200, QUOTE, 'nope')).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
    await expect(a.quote({ leg: leg('card') }, makeCtx({ fetch: fakeFetch(routes()).fetch }))).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
  })

  it('start: POST /v2/buy with the order fields, REDIRECT popup to checkoutUrl, Banxa id kept for status', async () => {
    const { fetch, calls } = fakeFetch(routes())
    const a = banxa({ ...opts, subPartnerId: 'web' })
    const store = memoryKV()
    const ctx = makeCtx({ fetch, store, session: { email: 'a@b.co', userId: 'u_42' } })
    const q = await a.quote({ leg: leg('card'), amountIn: usd('100') }, ctx)
    const step = await a.start({ leg: leg('card'), quote: q, deliverTo: { address: '0xd16e0c839b6f652970c5d4d035d9cfcff5c185af' } }, ctx)
    expect(checkLegStep(step)).toEqual([])
    expect(stateFor(step)).toBe('PAYMENT')
    expect(step.ref).toMatch(/^ork_[0-9a-f]{24}$/)
    expect(step.providerRef).toBe(CREATED.id)
    expect(step.action).toMatchObject({ kind: 'payment', surface: { kind: 'REDIRECT', url: CREATED.checkoutUrl, popup: true, provider: 'Banxa' }, transitions: [{ kind: 'AWAIT' }] })
    const post = calls.find((c) => c.method === 'POST')!
    expect(post.url).toBe('https://api.banxa.com/mypartner/v2/buy')
    expect(post.headers.get('x-api-key')).toBe(API_KEY)
    expect(post.headers.get('content-type')).toBe('application/json')
    expect(post.body).toEqual({
      crypto: 'USDC',
      blockchain: 'BASE_MAINNET',
      fiat: 'USD',
      fiatAmount: '100.00',
      walletAddress: '0xd16e0c839b6f652970c5d4d035d9cfcff5c185af',
      redirectUrl: 'https://app.test/api/openramp/return',
      paymentMethodId: 'debit-credit-card',
      externalCustomerId: 'u_42',
      externalOrderId: step.ref,
      email: 'a@b.co',
      subPartnerId: 'web',
    })
    expect(await store.get(`order:${step.ref}`)).toBe(CREATED.id)
  })

  it('start: crypto-amount quotes send cryptoAmount only; no null fields; the IFRAME surface', async () => {
    const { fetch, calls } = fakeFetch(routes())
    const a = banxa({ ...opts, surface: 'iframe' })
    const ctx = makeCtx({ fetch })
    const q = await a.quote({ leg: leg('card'), amountOut: { value: '96.41', asset: BASE_USDC } }, ctx)
    const step = await a.start({ leg: leg('card'), quote: q }, ctx)
    const body = calls.find((c) => c.method === 'POST')!.body as Record<string, unknown>
    expect(body.cryptoAmount).toBe('96.41')
    expect(body.fiatAmount).toBeUndefined()
    expect(body.walletAddress).toBe('0x000000000000000000000000000000000000beef')
    expect(Object.values(body).every((v) => typeof v === 'string')).toBe(true)
    expect(body).not.toHaveProperty('email')
    const s = step.action!.surface!
    if (s.kind !== 'IFRAME') throw new Error('expected IFRAME')
    expect(s).toMatchObject({ url: CREATED.checkoutUrl, origin: 'https://partner.banxa.com', allow: 'payment; camera; microphone; encrypted-media' })
  })

  it('start: needs a wallet address, a checkout URL, and maps order errors', async () => {
    const a = banxa(opts)
    const quote = {
      adapterId: 'banxa', legId: 'card', input: usd('100'), output: { value: '96', asset: BASE_USDC }, fees: [], guarantee: 'estimate' as const, eta: { min: 1, max: 2 }, expiresAt: '2030-01-01T00:00:00.000Z',
      data: { coin: 'USDC', blockchain: 'BASE', paymentMethodId: 'debit-credit-card', fiat: 'USD', side: 'fiat' },
    }
    await expect(a.start({ leg: leg('card'), quote }, makeCtx({ fetch: fakeFetch(routes()).fetch, destination: { type: 'merchant', currency: 'USD' } }))).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
    const run = (status: number, body: unknown) => a.start({ leg: leg('card'), quote }, makeCtx({ fetch: fakeFetch([{ method: 'POST', match: '/v2/buy', status, reply: () => body }]).fetch }))
    await expect(run(201, { id: 'x' })).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
    await expect(run(201, { id: 'x', checkoutUrl: 'not a url' })).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
    await expect(run(422, { code: 5034, message: 'Coin restriction' })).rejects.toMatchObject({ error: { code: 'REGION_UNSUPPORTED' } })
    await expect(run(400, { code: 4002, message: 'Validation error' })).rejects.toMatchObject({ error: { code: 'NO_QUOTES' } })
    await expect(run(401, {})).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE', retryable: false } })
  })

  it('status: reads GET /v2/orders/{id} and maps every Banxa order status', async () => {
    const a = banxa(opts)
    const store = memoryKV()
    await store.put('order:ork_abc', ORDER('x').id)
    const status = async (reply: unknown, httpStatus = 200) => {
      const { fetch, calls } = fakeFetch([{ match: '/v2/orders/', status: httpStatus, reply: () => reply }])
      const s = await a.status!({ leg: leg('card'), ref: 'ork_abc' }, makeCtx({ fetch, store }))
      expect(calls[0]!.url).toBe('https://api.banxa.com/mypartner/v2/orders/191fa5b4b1f45e1cf784422e09317d56')
      expect(calls[0]!.headers.get('x-api-key')).toBe(API_KEY)
      expect(checkLegStep(s)).toEqual([])
      return s
    }
    const done = await status(ORDER('complete', { transactionHash: '0xhash' }))
    expect(stateFor(done)).toBe('COMPLETED')
    expect(done).toMatchObject({
      status: 'succeeded',
      ref: 'ork_abc',
      providerRef: ORDER('x').id,
      transactions: [{ role: 'destination', hash: '0xhash', chain: 'eip155:8453' }],
      output: { value: '96.41', asset: { chain: 'eip155:8453', token: USDC['eip155:8453'] } },
    })
    const pending = await status(ORDER('pendingPayment'))
    expect(stateFor(pending)).toBe('PAYMENT')
    expect(pending).toMatchObject({ status: 'requires_action', action: { kind: 'payment', transitions: [{ kind: 'AWAIT' }] } })
    expect(pending.action!.surface).toBeUndefined()
    const table: Array<[string, string, string?]> = [
      ['waitingPayment', 'PROCESSING', 'processing'],
      ['paymentReceived', 'PROCESSING', 'settling'],
      ['inProgress', 'PROCESSING', 'processing'],
      ['extraVerification', 'PROCESSING', 'delayed'],
      ['cryptoTransferred', 'PROCESSING', 'confirming'],
      ['expired', 'EXPIRED'],
      ['refunded', 'REFUNDED'],
    ]
    for (const [st, state, detail] of table) {
      const s = await status(ORDER(st))
      expect(stateFor(s), st).toBe(state)
      if (detail) expect(s.detail, st).toEqual({ code: detail, providerStatus: st })
    }
    const declined = await status(ORDER('declined'))
    expect(stateFor(declined)).toBe('FAILED')
    expect(declined.error).toMatchObject({ code: 'PAYMENT_FAILED', recovery: 'retry_payment' })
    const cancelled = await status(ORDER('cancelled'))
    expect(stateFor(cancelled)).toBe('FAILED')
    expect(cancelled.error).toMatchObject({ code: 'PROVIDER_DECLINED', recovery: 'contact_support' })
    // An unknown Banxa status is never `processing`: a status poll that keeps the current step
    const unknown = await status(ORDER('somethingNew'))
    expect(unknown).toMatchObject({ status: 'requires_action', action: { kind: 'payment' } })
    expect(stateFor(await status({ message: 'Order not found' }, 404))).toBe('PAYMENT')
    await expect(status({}, 500)).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
    // A 400 on lookup is not "no quotes"
    await expect(status({ message: 'bad id' }, 400)).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
  })

  it('status: with no stored Banxa id, waits for a webhook and calls nothing', async () => {
    const { fetch, calls } = fakeFetch([])
    const log = recordingLog()
    const s = await banxa(opts).status!({ leg: leg('card'), ref: 'ork_none' }, makeCtx({ fetch, log }))
    expect(s).toMatchObject({ status: 'requires_action', ref: 'ork_none' })
    expect(calls).toHaveLength(0)
    expect(log.warnings.some((w) => w.includes('no Banxa order id'))).toBe(true)
  })

  it('signature: the canonical string and HMAC of the Banxa docs example', async () => {
    const body = '{"externalCustomerId":"example_01"}'
    expect(banxaCanonical('POST', '/mypartner/v2/identities/token/share', '1785804345837761', body)).toBe(`POST\n/mypartner/v2/identities/token/share\n1785804345837761\n${body}`)
    expect(banxaCanonical('get', '/mypartner/v2/orders?start=2024-03-01', '1785804345837761')).toBe('GET\n/mypartner/v2/orders?start=2024-03-01\n1785804345837761')
    // Fixed vector: the docs canonical string, signed with the docs placeholder secret
    const sig = await banxaSignature('[YOUR_API_SECRET]', 'POST', '/mypartner/v2/identities/token/share', '1785804345837761', body)
    expect(sig).toBe('4086065a157303ee5a70958407b3d92aa76c0eb14c1cdf6958668b4af20a335c')
    expect(sig).toBe(createHmac('sha256', '[YOUR_API_SECRET]').update(`POST\n/mypartner/v2/identities/token/share\n1785804345837761\n${body}`).digest('hex'))
  })

  it('webhook verify: good, bad, wrong path, wrong key, malformed, no secret, path override', async () => {
    const a = banxa(opts)
    const wctx = makeWebhookCtx()
    const body = JSON.stringify(WEBHOOK('complete'))
    const verify = (auth: string | undefined, url = HOOK_URL, adapter = a) => adapter.webhook!.verify(hookReq(body, auth, url), body, wctx)
    expect(await verify(authHeader(body))).toBe(true)
    // An old nonce still verifies: Banxa retries one delivery for up to 2 hours (replays: see replayKey)
    expect(await verify(authHeader(body, { nonce: '1500000000000000' }))).toBe(true)
    expect(await verify(authHeader('{"tampered":true}'))).toBe(false)
    expect(await verify(authHeader(body, { secret: 'other' }))).toBe(false)
    expect(await verify(authHeader(body, { path: '/webhooks/banxa' }))).toBe(false)
    expect(await verify(authHeader(body, { key: 'pk_other' }))).toBe(false)
    expect(await verify(authHeader(body, { key: 'pk_other' }), HOOK_URL, banxa({ ...opts, hmacKey: undefined }))).toBe(true)
    expect(await verify(undefined)).toBe(false)
    expect(await verify('Basic abc')).toBe(false)
    expect(await verify(`Bearer ${HMAC_KEY}:nothex:1785804345837761`)).toBe(false)
    expect(await verify(`Bearer ${HMAC_KEY}:1785804345837761`)).toBe(false)
    // Upper-case hex is the same signature
    const [, sig, nonce] = authHeader(body).slice('Bearer '.length).split(':')
    expect(await verify(`Bearer ${HMAC_KEY}:${sig!.toUpperCase()}:${nonce}`)).toBe(true)
    expect(await verify(authHeader(body), HOOK_URL, banxa({ ...opts, hmacSecret: undefined }))).toBe(false)
    // Behind a proxy that rewrites the path: the path Banxa called, from the option
    expect(await verify(authHeader(body), 'https://internal/hooks/b', banxa({ ...opts, webhookPath: HOOK_PATH }))).toBe(true)
    expect(await verify(authHeader(body), 'https://internal/hooks/b')).toBe(false)
  })

  it('webhook parse: order events by external_id, every status, other webhook types ignored', async () => {
    const a = banxa(opts)
    const wctx = makeWebhookCtx()
    const parse = (o: unknown) => a.webhook!.parse(JSON.stringify(o), wctx)
    const key = (st: string) => `banxa:191fa5b4b1f45e1cf784422e09317d56:${st}:2026-01-1604:04:21`
    expect(await parse(WEBHOOK('complete', { transaction_hash: '0xhash' }))).toEqual([
      {
        ref: 'ork_abc',
        status: 'succeeded',
        providerRef: '191fa5b4b1f45e1cf784422e09317d56',
        transactions: [{ role: 'destination', hash: '0xhash', chain: 'eip155:8453' }],
        output: { value: '96.41', asset: { ...BASE_USDC, symbol: 'USDC', decimals: 6 } },
        eventId: key('complete'),
      },
    ])
    // transaction_hash "0" is no transaction
    expect((await parse(WEBHOOK('complete')))[0]!.transactions).toBeUndefined()
    expect(await parse(WEBHOOK('pendingPayment'))).toEqual([{ ref: 'ork_abc', status: 'requires_action', providerRef: '191fa5b4b1f45e1cf784422e09317d56', eventId: key('pendingPayment') }])
    expect(await parse(WEBHOOK('paymentReceived'))).toMatchObject([{ status: 'processing', detail: { code: 'settling', providerStatus: 'paymentReceived' } }])
    expect(await parse(WEBHOOK('declined'))).toMatchObject([{ status: 'failed', error: { code: 'PAYMENT_FAILED' } }])
    expect(await parse(WEBHOOK('cancelled'))).toMatchObject([{ status: 'failed', error: { code: 'PROVIDER_DECLINED' } }])
    expect(await parse(WEBHOOK('expired'))).toMatchObject([{ status: 'expired' }])
    expect(await parse(WEBHOOK('refunded'))).toMatchObject([{ status: 'refunded' }])
    // An unknown status: no event, logged once
    const log = recordingLog()
    expect(await a.webhook!.parse(JSON.stringify(WEBHOOK('brandNewStatus')), { ...wctx, log })).toEqual([])
    expect(log.warnings.some((w) => w.includes('unknown provider status'))).toBe(true)
    // KYC, extra verification and account blocked webhooks, sell orders, orders without our id
    expect(await parse({ external_customer_id: 'u_1', account: { exists: true, blocked: false }, kyc: { status: 'VERIFIED' } })).toEqual([])
    expect(await parse({ external_customer_id: 'u_1', status: 'extraVerification', status_date: '2026-02-1304:39:38', order_id: 'abc', internal_reason: 'x', external_reason: 'y' })).toEqual([])
    expect(await parse({ external_customer_id: 'u_1', status: 'cancelled', order_id: '', internal_reason: 'Account is blocked.' })).toEqual([])
    expect(await parse(WEBHOOK('complete', { order_type: 'SELL' }))).toEqual([])
    expect(await parse(WEBHOOK('complete', { external_id: null }))).toEqual([])
    expect(await a.webhook!.parse('not json', wctx)).toEqual([])
    // A chain code that only the cached crypto list knows still finds the asset
    const shared = memoryKV()
    await shared.put('crypto', CRYPTO)
    const [ev] = await a.webhook!.parse(JSON.stringify(WEBHOOK('complete', { crypto_blockchain: 'BASE_MAINNET' })), { ...wctx, shared })
    expect(ev!.output).toMatchObject({ asset: { chain: 'eip155:8453' } })
    // An unknown chain: the event without an output
    const [ev2] = await parse(WEBHOOK('complete', { crypto_blockchain: 'NOPE' }))
    expect(ev2!.output).toBeUndefined()
  })

  it('webhook replayKey: order_id, status and status_date; the body hash for other bodies', async () => {
    const a = banxa(opts)
    const wctx = makeWebhookCtx()
    const body = JSON.stringify(WEBHOOK('complete'))
    const k1 = await a.webhook!.replayKey!(hookReq(body), body, wctx)
    expect(k1).toBe('banxa:191fa5b4b1f45e1cf784422e09317d56:complete:2026-01-1604:04:21')
    // A retry sends the same payload: the same key
    expect(await a.webhook!.replayKey!(hookReq(body), body, wctx)).toBe(k1)
    const later = JSON.stringify(WEBHOOK('inProgress', { status_date: '2026-01-1604:09:00' }))
    expect(await a.webhook!.replayKey!(hookReq(later), later, wctx)).not.toBe(k1)
    const kyc = JSON.stringify({ external_customer_id: 'u_1', kyc: { status: 'VERIFIED' } })
    expect(await a.webhook!.replayKey!(hookReq(kyc), kyc, wctx)).toMatch(/^[0-9a-f]{64}$/)
    expect(await a.webhook!.replayKey!(hookReq('x'), 'x', wctx)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('catalog: countries and buy methods, cached for a day; unknown Banxa methods become bx_ legs', async () => {
    const countries = [{ id: 'US', states: [{ id: 'AL' }] }, { id: 'DE', states: [] }, { id: 'AU', states: [] }, { id: 'GB', states: [] }, { id: 'RU', states: [] }]
    const methods = [
      { id: 'debit-credit-card', name: 'Credit Debit Card', supportedFiats: ['USD', 'EUR', 'AUD'] },
      { id: 'sepa-bank-transfer', name: 'SEPA', supportedFiats: ['EUR'] },
      { id: 'payid-bank-transfer', name: 'PayID', supportedFiats: ['AUD'] },
      { id: 'interac-bank-transfer', name: 'Interac', supportedFiats: ['CAD'] },
      { id: 'open-banking', name: 'Pay by bank', supportedFiats: ['GBP'] },
      { id: 'ach-bank-transfer', name: 'ACH', supportedFiats: ['USD'] },
      { id: 'empty', name: 'No fiats', supportedFiats: [] },
    ]
    const { fetch, calls } = fakeFetch([
      { match: '/v2/countries', reply: () => countries },
      { match: '/v2/payment-methods/buy', reply: () => methods },
    ])
    const a = banxa(opts)
    const shared = memoryKV()
    const legs = await a.catalog!({ country: 'US', currency: 'USD', direction: 'deposit' }, { fetch, log: silentLog, shared })
    await a.catalog!({ country: 'US', currency: 'USD', direction: 'deposit' }, { fetch, log: silentLog, shared })
    expect(calls).toHaveLength(2)
    expect(calls.every((c) => c.headers.get('x-api-key') === API_KEY)).toBe(true)
    expect(legs.map((l) => l.id)).toEqual(['card', 'sepa', 'payid', 'bx_open_banking'])
    const card = legs.find((l) => l.id === 'card')!
    expect(card.regions).toEqual({ allow: ['US', 'DE', 'AU', 'GB'], deny: [] })
    expect(card.from.asset).toEqual({ kind: 'fiat', currencies: ['USD', 'EUR', 'AUD'] })
    expect(legs.find((l) => l.id === 'sepa')!.regions.allow).toEqual(['DE'])
    const ob = legs.find((l) => l.id === 'bx_open_banking')!
    expect(ob.methods).toEqual(['open_banking'])
    for (const l of legs) expect(checkAdapterShape({ ...a, legs: [l] })).toEqual([])
    // A catalog leg quotes with its Banxa id
    const q = fakeFetch(routes())
    await a.quote({ leg: leg('bx_open_banking', BASE_USDC, 'GBP'), amountIn: { value: '100', asset: { kind: 'fiat', currency: 'GBP' } } }, makeCtx({ fetch: q.fetch }))
    expect(new URL(q.calls.find((c) => c.url.includes('/quotes/buy'))!.url).searchParams.get('paymentMethodId')).toBe('open-banking')
    // `methods` also limits catalog legs
    const only = await banxa({ ...opts, methods: ['card'] }).catalog!({ currency: 'USD', direction: 'deposit' }, { fetch, log: silentLog, shared: memoryKV() })
    expect(only.map((l) => l.id)).toEqual(['card'])
  })

  it('catalog: a failed or empty call throws (the server keeps the static legs)', async () => {
    const a = banxa(opts)
    const bad = fakeFetch([{ match: '/v2/countries', status: 500, reply: () => ({}) }, { match: '/v2/payment-methods/buy', reply: () => [] }])
    await expect(a.catalog!({ currency: 'USD', direction: 'deposit' }, { fetch: bad.fetch, log: silentLog, shared: memoryKV() })).rejects.toBeTruthy()
    const empty = fakeFetch([{ match: '/v2/countries', reply: () => [{ id: 'US' }] }, { match: '/v2/payment-methods/buy', reply: () => [] }])
    await expect(a.catalog!({ currency: 'USD', direction: 'deposit' }, { fetch: empty.fetch, log: silentLog, shared: memoryKV() })).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
  })

  it('health: GET /v2/countries', async () => {
    const a = banxa(opts)
    expect(await a.health!({ fetch: fakeFetch([{ match: '/v2/countries', reply: () => [{ id: 'US' }] }]).fetch, log: silentLog })).toEqual({ ok: true })
    expect(await a.health!({ fetch: fakeFetch([{ match: '/v2/countries', status: 401, reply: () => ({}) }]).fetch, log: silentLog })).toMatchObject({ ok: false })
  })

  it('passes runAdapterConformance (card and SEPA fixtures, status, signed webhooks, error paths)', async () => {
    const { fetch } = fakeFetch(routes())
    const body = JSON.stringify(WEBHOOK('complete'))
    const report = await runAdapterConformance(banxa(opts), {
      fetch,
      fixtures: [
        { leg: leg('card'), quote: { amountIn: usd('100') }, expect: { start: 'PAYMENT', status: 'COMPLETED' } },
        { leg: leg('sepa', BASE_USDC, 'EUR'), quote: { amountIn: { value: '100', asset: { kind: 'fiat', currency: 'EUR' } } }, ctx: makeCtx({ fetch, session: { country: 'DE' } }) },
      ],
      errorPaths: [{ leg: leg('card'), quote: { amountIn: usd('100') } }],
      webhooks: [
        { name: 'signed', rawBody: body, request: () => hookReq(body, authHeader(body)), events: 1 },
        { name: 'unsigned', rawBody: body, request: () => hookReq(body), valid: false },
        { name: 'kyc', rawBody: '{"kyc":{"status":"VERIFIED"}}', request: () => hookReq('{"kyc":{"status":"VERIFIED"}}', authHeader('{"kyc":{"status":"VERIFIED"}}')), events: 0 },
      ],
    })
    expect(report.problems).toEqual([])
    expect(report.quotes).toHaveLength(2)
  })
})
