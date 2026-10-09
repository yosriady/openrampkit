import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { checkAdapterShape, checkLegQuote, checkLegStep } from '@openrampkit/adapter'
import { USDC, isRegionAllowed, stateFor } from '@openrampkit/core'
import type { PathwayLeg } from '@openrampkit/core'
import { fakeFetch, makeCtx, makeWebhookCtx, memoryKV, recordingLog, runAdapterConformance, silentLog } from '@openrampkit/adapter/testing'
import type { FakeRoute } from '@openrampkit/adapter/testing'
import { PEER_OPT_IN_ERROR, PEER_RAILS, peer } from './index.js'
import type { PeerOptions } from './index.js'

const KEY = 'peer_test_key'
const SECRET = 'whsec_peer_test'
const opts: PeerOptions = { enabled: true, apiKey: KEY, webhookSecret: SECRET, env: 'sandbox' }
const BASE_USDC = { kind: 'crypto' as const, chain: 'eip155:8453', token: USDC['eip155:8453']! }
const BASE_USDC_FULL = { ...BASE_USDC, symbol: 'USDC', decimals: 6 }
const money = (amount: string, currency = 'USD') => ({ value: amount, asset: { kind: 'fiat' as const, currency } })
const env = <T>(responseObject: T, message = 'ok') => ({ success: true, message, responseObject, statusCode: 200 })

const leg = (legId: string, currency = 'USD'): PathwayLeg => ({
  adapterId: 'peer',
  legId,
  from: { asset: { kind: 'fiat', currency }, location: { kind: 'user_account' } },
  to: { asset: BASE_USDC, location: { kind: 'address', address: 'deposit' } },
})

// Live orderbook entry shape (GET https://api.zkp2p.xyz/v3/orderbook, 2026-09-29)
const entry = (price: string, min = '13000000', max = '250000000', available = '249904998') => ({
  chainId: 8453, depositId: 'd', price, conversionRate: price,
  availableTokenAmount: available, intentAmountMin: min, intentAmountMax: max, feeBps: 95,
})
const BOOK = (entries: unknown[]) => env({ chainId: 8453, currency: 'USD', paymentPlatform: 'venmo', entries })
const AVAILABLE = env({ available: true, quoteCount: 3, nearbySuggestions: null })
const ORDER = { id: 'cmf5k2x9d0001abcd1234efgh', status: 'CREATED', requestedUsdcAmount: '100', remainingUsdcAmount: '100', destinationChainId: '8453' }
const CREATED = env({ order: ORDER, orderToken: 'tok_123' }, 'Order created')

const routes = (extra: FakeRoute[] = []): FakeRoute[] => [
  ...extra,
  { method: 'POST', match: '/api/v1/merchants/me/quotes/availability', reply: () => AVAILABLE },
  { match: 'api.zkp2p.xyz/v3/orderbook', reply: () => BOOK([entry('1010000000000000000'), entry('1020000000000000000')]) },
  { method: 'POST', match: '/api/v1/orders', reply: () => CREATED },
]

const hook = (type: string, order: Record<string, unknown>, payment: Record<string, unknown> | null = null, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ id: 'evt_1', type, timestamp: '2026-09-29T10:00:00.000Z', data: { order: { ...ORDER, ...order }, payment, refund: null, paymentBridge: null, ...extra } })

describe('peer adapter: opt-in', () => {
  it('refuses to build without enabled: true, with an explanation', () => {
    expect(() => peer({ ...opts, enabled: undefined } as unknown as PeerOptions)).toThrow(PEER_OPT_IN_ERROR)
    expect(() => peer({ ...opts, enabled: 'yes' } as unknown as PeerOptions)).toThrow(/opt-in/)
    expect(PEER_OPT_IN_ERROR).toMatch(/peer-to-peer/)
    expect(PEER_OPT_IN_ERROR).toMatch(/charged back/)
    expect(() => peer({ ...opts, webhookSecret: '' })).toThrow(/webhookSecret/)
    expect(() => peer({ ...opts, rails: ['pix'] })).toThrow(/selects no known rail/)
  })
})

describe('peer adapter', () => {
  it('declares one leg per rail: US-only apps in USD, Wise and Revolut in USD, EUR, GBP; USDC on Base', () => {
    const a = peer(opts)
    expect(checkAdapterShape(a)).toEqual([])
    expect(a.legs.map((l) => [l.id, l.methods![0]])).toEqual(PEER_RAILS.map((r) => [r.rail, r.method]))
    const venmo = a.legs.find((l) => l.id === 'venmo')!
    expect(venmo.from.asset).toEqual({ kind: 'fiat', currencies: ['USD'] })
    expect(venmo.to.asset).toEqual({ kind: 'crypto', chains: { 'eip155:8453': [USDC['eip155:8453']] } })
    expect(isRegionAllowed(venmo.regions, 'US', 'US-NY')).toBe(true)
    expect(isRegionAllowed(venmo.regions, 'GB')).toBe(false)
    expect(a.legs.find((l) => l.id === 'cashapp')!.methods).toEqual(['cash_app'])
    const wise = a.legs.find((l) => l.id === 'wise')!
    expect(wise.from.asset).toEqual({ kind: 'fiat', currencies: ['USD', 'EUR', 'GBP'] })
    expect(isRegionAllowed(wise.regions, 'SG')).toBe(true)
    expect(isRegionAllowed(a.legs.find((l) => l.id === 'revolut')!.regions, 'DE')).toBe(true)
    expect(venmo.surfaces).toEqual(['REDIRECT'])
    expect(peer({ ...opts, rails: ['zelle'], surface: 'iframe' }).legs.map((l) => [l.id, l.surfaces])).toEqual([['zelle', ['IFRAME']]])
  })

  it('quote: availability check scoped to the rail, estimate from the orderbook minus the 2.95% fee', async () => {
    const { fetch, calls } = fakeFetch(routes())
    const a = peer(opts)
    const q = await a.quote({ leg: leg('venmo'), amountIn: money('100'), deliverTo: { address: '0xabc' } }, makeCtx({ fetch }))
    expect(checkLegQuote(q)).toEqual([])
    const av = calls[0]!
    expect(av.url).toBe('https://api.pay.peer.xyz/api/v1/merchants/me/quotes/availability')
    expect(av.headers.get('x-api-key')).toBe(KEY)
    expect(av.body).toEqual({
      amount: '100.00', quoteMode: 'exact-fiat', enabledRails: ['venmo'], destinationChainId: '8453', destinationToken: 'USDC',
      destinationAddress: '0xabc', fiatCurrency: 'USD', nearbyQuotesCount: 2,
    })
    const ob = new URL(calls[1]!.url)
    expect(ob.origin + ob.pathname).toBe('https://api.zkp2p.xyz/v3/orderbook')
    expect(Object.fromEntries(ob.searchParams)).toEqual({ currency: 'USD', paymentPlatform: 'venmo', chainId: '8453', sortBy: 'price', sortDirection: 'asc', limit: '50' })
    // 100 USD at 1.01 USD/USDC = 99.00990099 USDC; fee 2.95% = 2.920792; out = 96.089109
    expect(q.input).toEqual(money('100.00'))
    expect(q.output).toEqual({ value: '96.089109', asset: BASE_USDC_FULL })
    expect(q.fees).toEqual([{ kind: 'provider', label: 'Peer fee', amount: { value: '2.920792', asset: BASE_USDC_FULL }, included: true }])
    expect(q.guarantee).toBe('estimate')
    expect(q.minOutput).toBeUndefined()
    expect(q.data).toMatchObject({ rail: 'venmo', currency: 'USD', amount: '100.00', quoteCount: 3 })
  })

  it('quote: feeBps, buyer-pays, EUR on Wise, and the 1:1 USD fallback without an orderbook', async () => {
    const eurBook = fakeFetch(routes([{ match: 'api.zkp2p.xyz/v3/orderbook', reply: () => BOOK([entry('860000000000000000', '1000000', '1000000000')]) }]))
    const w = await peer({ ...opts, feeBps: 495 }).quote({ leg: leg('wise', 'EUR'), amountIn: money('86', 'EUR') }, makeCtx({ fetch: eurBook.fetch }))
    // 86 EUR / 0.86 = 100 USDC; 4.95% fee
    expect(w.output.value).toBe('95.05')
    expect(eurBook.calls[0]!.body).toMatchObject({ fiatCurrency: 'EUR', enabledRails: ['wise'] })

    const payee = await peer({ ...opts, feePayer: 'PAYEE' }).quote({ leg: leg('zelle'), amountIn: money('100') }, makeCtx({ fetch: fakeFetch(routes()).fetch }))
    expect(payee.input.value).toBe('103.04')
    expect(payee.output.value).toBe('99.009901')
    expect(payee.fees).toEqual([{ kind: 'provider', label: 'Peer fee', amount: money('3.04'), included: true }])
    expect(payee.guarantee).toBe('estimate')

    const down = fakeFetch(routes([{ match: 'api.zkp2p.xyz', status: 503, reply: () => ({}) }]))
    const q = await peer(opts).quote({ leg: leg('cashapp'), amountIn: money('50') }, makeCtx({ fetch: down.fetch }))
    expect(q.output.value).toBe('48.525')
    // No orderbook and not USD: cannot price
    await expect(peer(opts).quote({ leg: leg('revolut', 'GBP'), amountIn: money('50', 'GBP') }, makeCtx({ fetch: down.fetch }))).rejects.toMatchObject({ error: { code: 'NO_QUOTES' } })
    // No entry can fill the amount (too large for every seller)
    const small = fakeFetch(routes([{ match: 'api.zkp2p.xyz', reply: () => BOOK([entry('950000000000000000', '1000000', '5000000')]) }]))
    await expect(peer(opts).quote({ leg: leg('wise', 'EUR'), amountIn: money('100', 'EUR') }, makeCtx({ fetch: small.fetch }))).rejects.toMatchObject({ error: { code: 'NO_QUOTES' } })
  })

  it('quote: no liquidity is NO_QUOTES with nearby amounts; bad currency, low amount and HTTP errors', async () => {
    const none = fakeFetch([{ method: 'POST', match: '/quotes/availability', reply: () => env({ available: false, quoteCount: 0, nearbySuggestions: { below: [{ suggestedAmount: '75', rail: 'venmo' }], above: [{ suggestedAmount: '150.5', rail: 'venmo' }] } }) }])
    await expect(peer(opts).quote({ leg: leg('venmo'), amountIn: money('100') }, makeCtx({ fetch: none.fetch }))).rejects.toMatchObject({
      error: { code: 'NO_QUOTES', message: 'Peer has no venmo liquidity for this amount right now. Try 75.00 or 150.50 USD.' },
    })
    const empty = fakeFetch([{ method: 'POST', match: '/quotes/availability', reply: () => env({ available: false, quoteCount: 0, nearbySuggestions: null }) }])
    await expect(peer(opts).quote({ leg: leg('venmo'), amountIn: money('100') }, makeCtx({ fetch: empty.fetch }))).rejects.toMatchObject({ error: { code: 'NO_QUOTES', message: 'Peer has no venmo liquidity for this amount right now.' } })
    const a = peer(opts)
    const f = fakeFetch(routes()).fetch
    await expect(a.quote({ leg: leg('venmo', 'EUR'), amountIn: money('100', 'EUR') }, makeCtx({ fetch: f }))).rejects.toMatchObject({ error: { code: 'NO_QUOTES' } })
    await expect(a.quote({ leg: leg('venmo'), amountIn: money('9.99') }, makeCtx({ fetch: f }))).rejects.toMatchObject({ error: { code: 'AMOUNT_TOO_LOW' } })
    await expect(a.quote({ leg: leg('venmo'), amountOut: { value: '10', asset: BASE_USDC } }, makeCtx({ fetch: f }))).rejects.toMatchObject({ error: { code: 'NO_QUOTES' } })
    await expect(a.quote({ leg: leg('venmo'), amountIn: money('100') }, makeCtx({ fetch: f, destination: { type: 'merchant', currency: 'USD' } }))).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
    const run = (status: number, body: unknown) => a.quote({ leg: leg('venmo'), amountIn: money('100') }, makeCtx({ fetch: fakeFetch([{ match: '/quotes/availability', status, reply: () => body }]).fetch }))
    await expect(run(401, { success: false, message: 'Invalid API key', responseObject: null, statusCode: 401 })).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
    await expect(run(429, { success: false, message: 'Too many requests' })).rejects.toMatchObject({ error: { code: 'RATE_LIMITED' } })
    await expect(run(502, { success: false, message: 'Quote provider unavailable' })).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
    await expect(run(400, { success: false, message: 'Merchant config not found' })).rejects.toMatchObject({ error: { code: 'NO_QUOTES', message: 'Peer: Merchant config not found' } })
  })

  it('start: POST /api/v1/orders in fiat mode with the idempotency key; REDIRECT to the checkout with the rail preselected', async () => {
    const { fetch, calls } = fakeFetch(routes())
    const a = peer({ ...opts, feePayer: 'SPLIT', buyerFeeShareBps: 5000 })
    const ctx = makeCtx({ fetch, session: { userId: 'u_42' } })
    const q = await a.quote({ leg: leg('venmo'), amountIn: money('100') }, ctx)
    const step = await a.start({ leg: leg('venmo'), quote: q, deliverTo: { address: '0xd16e' } }, ctx)
    expect(checkLegStep(step)).toEqual([])
    expect(stateFor(step)).toBe('PAYMENT')
    expect(step).toMatchObject({ status: 'requires_action', action: { kind: 'payment' }, ref: ORDER.id, providerRef: ORDER.id })
    expect(step.action?.surface).toEqual({ kind: 'REDIRECT', url: `https://pay.peer.xyz/?order=${ORDER.id}&token=tok_123&method=venmo`, popup: true, provider: 'Peer' })
    const post = calls.find((c) => c.url.endsWith('/api/v1/orders'))!
    expect(post.method).toBe('POST')
    expect(post.headers.get('x-api-key')).toBe(KEY)
    const idem = post.headers.get('idempotency-key')!
    expect(idem).toMatch(/^sess_1_peer-venmo-[0-9a-f]{16}$/)
    expect(post.body).toEqual({
      requestedFiatAmount: '100.00', requestedFiatCurrency: 'USD', destinationAddress: '0xd16e', destinationChainId: 8453, destinationToken: 'USDC',
      enabledRails: ['venmo'], successUrl: 'https://app.test/api/openramp/return', cancelUrl: 'https://app.test/api/openramp/return', dynamicOrdersEnabled: false,
      feePayer: 'SPLIT', buyerFeeShareBps: 5000, idempotencyKey: idem, notes: { openrampSessionId: 'sess_1', openrampUserId: 'u_42', env: 'sandbox' },
    })
    // A retry of the same start reuses the saved checkout URL (the API replay has no token)
    const again = await a.start({ leg: leg('venmo'), quote: q, deliverTo: { address: '0xd16e' } }, ctx)
    expect(again.action?.surface).toEqual(step.action?.surface)
    expect(again.providerRef).toBe(ORDER.id)
    expect(calls.filter((c) => c.url.endsWith('/api/v1/orders'))).toHaveLength(1)
  })

  it('start: IFRAME surface with embed=true and checkout postMessage events; replay without token; error codes', async () => {
    const a = peer({ ...opts, surface: 'iframe' })
    const ctx = makeCtx({ fetch: fakeFetch(routes()).fetch })
    const q = await a.quote({ leg: leg('wise', 'USD'), amountIn: money('20') }, ctx)
    const step = await a.start({ leg: leg('wise'), quote: q }, ctx)
    expect(step.action?.surface).toEqual({
      kind: 'IFRAME',
      url: `https://pay.peer.xyz/?order=${ORDER.id}&token=tok_123&method=wise&embed=true`,
      origin: 'https://pay.peer.xyz',
      allow: 'clipboard-write',
      height: 720,
      provider: 'Peer',
      messages: { origin: 'https://pay.peer.xyz', completed: ['checkout.success'], failed: ['checkout.failed'], closed: ['checkout.closed'] },
    })
    const replay = fakeFetch([{ method: 'POST', match: '/api/v1/orders', reply: () => env({ order: ORDER, orderToken: null, idempotentReplay: true }) }])
    await expect(a.start({ leg: leg('wise'), quote: q }, makeCtx({ fetch: replay.fetch }))).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
    const err = (errorCode: string, status = 400) => fakeFetch([{ method: 'POST', match: '/api/v1/orders', status, reply: () => ({ success: false, message: errorCode, responseObject: null, statusCode: status, errorCode }) }]).fetch
    await expect(a.start({ leg: leg('wise'), quote: q }, makeCtx({ fetch: err('AMOUNT_BELOW_MIN') }))).rejects.toMatchObject({ error: { code: 'AMOUNT_TOO_LOW' } })
    await expect(a.start({ leg: leg('wise'), quote: q }, makeCtx({ fetch: err('MERCHANT_MONTHLY_VOLUME_LIMIT_EXCEEDED', 403) }))).rejects.toMatchObject({ error: { code: 'AMOUNT_TOO_HIGH' } })
    await expect(a.start({ leg: leg('wise'), quote: q }, makeCtx({ fetch: err('NO_ELIGIBLE_PAYMENT_RAILS') }))).rejects.toMatchObject({ error: { code: 'NO_QUOTES' } })
    await expect(a.start({ leg: leg('wise'), quote: q }, makeCtx({ fetch: err('MERCHANT_TIER_FORBIDDEN', 403) }))).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
  })

  it('status: GET /api/v1/orders/{id} maps order and payment state', async () => {
    const run = async (order: Record<string, unknown>, currentPayment: Record<string, unknown> | null, log = recordingLog()) => {
      const { fetch, calls } = fakeFetch([{ match: `/api/v1/orders/${ORDER.id}`, reply: () => env({ order: { ...ORDER, ...order }, merchant: { environment: 'SANDBOX' }, currentPayment }) }])
      const s = await peer(opts).status!({ leg: leg('venmo'), ref: ORDER.id }, makeCtx({ fetch, log }))
      expect(calls[0]!.method).toBe('GET')
      expect(checkLegStep(s)).toEqual([])
      return s
    }
    const unpaid = await run({}, null)
    expect(stateFor(unpaid)).toBe('PAYMENT')
    expect(unpaid).toMatchObject({ status: 'requires_action', action: { kind: 'payment' } })
    expect(unpaid.action?.surface).toBeUndefined()
    expect(stateFor(await run({}, { id: 'p', status: 'CREATED', rail: 'venmo' }))).toBe('PAYMENT')
    expect(await run({}, { id: 'p', status: 'EXPIRED' })).toMatchObject({ status: 'requires_action' })
    expect(stateFor(await run({}, { id: 'p', status: 'FAILED' }))).toBe('PAYMENT')
    const partial = await run({ status: 'PARTIALLY_FULFILLED' }, { status: 'SETTLED' })
    expect(stateFor(partial)).toBe('PROCESSING')
    expect(partial).toMatchObject({ providerRef: ORDER.id, detail: { code: 'processing', providerStatus: 'PARTIALLY_FULFILLED' } })
    const done = await run({ status: 'FULFILLED', remainingUsdcAmount: '0' }, { status: 'SETTLED', netSettledUsdcAmount: '96.09', fulfillTransaction: '0xabc' })
    expect(stateFor(done)).toBe('COMPLETED')
    expect(done).toMatchObject({
      status: 'succeeded', providerRef: ORDER.id, transactions: [{ role: 'destination', chain: 'eip155:8453', hash: '0xabc' }], output: { value: '96.09', asset: BASE_USDC_FULL },
    })
    const cancelled = await run({ status: 'CANCELLED' }, null)
    expect(stateFor(cancelled)).toBe('FAILED')
    expect(cancelled).toMatchObject({ error: { code: 'PAYMENT_FAILED' } })
    // An unknown order status is logged and is not processing: a payment poll (the server never moves a leg back)
    const log = recordingLog()
    const unknown = await run({ status: 'ON_HOLD_NEW' }, null, log)
    expect(unknown.status).toBe('requires_action')
    expect(unknown.status).not.toBe('processing')
    expect(log.warnings.join(' ')).toContain('unknown provider status')
    const nf = fakeFetch([{ match: '/api/v1/orders/', status: 404, reply: () => ({ success: false, message: 'Order not found' }) }])
    await expect(peer(opts).status!({ leg: leg('venmo'), ref: 'x' }, makeCtx({ fetch: nf.fetch }))).rejects.toMatchObject({ error: { code: 'NO_QUOTES' } })
  })

  it('webhook: X-Webhook-Signature over timestamp.body (good, bad, missing, stale)', async () => {
    const a = peer(opts)
    const wctx = makeWebhookCtx()
    const body = hook('ORDER_FULFILLED', { status: 'FULFILLED' }, { id: 'pay_1', status: 'SETTLED', netSettledUsdcAmount: '49.5', fulfillTransaction: '0xabc' })
    const ts = String(Math.floor(Date.now() / 1000))
    const sign = (t: string, b = body) => createHmac('sha256', SECRET).update(`${t}.${b}`).digest('hex')
    const req = (h: Record<string, string>) => new Request('https://app.test/h', { method: 'POST', body, headers: h })
    expect(await a.webhook!.verify(req({ 'X-Webhook-Signature': sign(ts), 'X-Webhook-Timestamp': ts, 'X-Webhook-Id': 'evt_1' }), body, wctx)).toBe(true)
    expect(await a.webhook!.verify(req({ 'X-Webhook-Signature': sign(ts, 'x'), 'X-Webhook-Timestamp': ts }), body, wctx)).toBe(false)
    expect(await a.webhook!.verify(req({ 'X-Webhook-Signature': sign(ts) }), body, wctx)).toBe(false)
    expect(await a.webhook!.verify(req({ 'X-Webhook-Timestamp': ts }), body, wctx)).toBe(false)
    const old = String(Math.floor(Date.now() / 1000) - 301)
    expect(await a.webhook!.verify(req({ 'X-Webhook-Signature': sign(old), 'X-Webhook-Timestamp': old }), body, wctx)).toBe(false)
    expect(await a.webhook!.verify(req({ 'X-Webhook-Signature': sign(ts), 'X-Webhook-Timestamp': `${ts}.5` }), body, wctx)).toBe(false)
    // Known vector: hex HMAC-SHA256(secret, "1700000000.{}")
    expect(sign('1700000000', '{}')).toBe('b63cbc8ba6d3e7f797fb76bc45ad1568aa4209b5826828541752096b6ceeba69')
  })

  it('webhook: parse maps ORDER_FULFILLED, PAYMENT_SETTLED, ORDER_CANCELLED; payment failures keep waiting', async () => {
    const a = peer(opts)
    const wctx = makeWebhookCtx()
    const parse = (b: string) => a.webhook!.parse(b, wctx)
    const settled = { id: 'pay_1', status: 'SETTLED', rail: 'venmo', netSettledUsdcAmount: '49.5', fulfillTransaction: '0xabc' }
    expect(await parse(hook('ORDER_FULFILLED', { status: 'FULFILLED' }, settled))).toEqual([
      { ref: ORDER.id, providerRef: ORDER.id, status: 'succeeded', transactions: [{ role: 'destination', chain: 'eip155:8453', hash: '0xabc' }], output: { value: '49.5', asset: BASE_USDC_FULL } },
    ])
    expect(await parse(hook('PAYMENT_SETTLED', { status: 'FULFILLED' }, settled))).toMatchObject([{ status: 'succeeded' }])
    expect(await parse(hook('PAYMENT_SETTLED', { status: 'PARTIALLY_FULFILLED' }, settled))).toEqual([
      { ref: ORDER.id, providerRef: ORDER.id, status: 'processing', detail: { code: 'processing', providerStatus: 'PARTIALLY_FULFILLED' } },
    ])
    // An unknown order status gives no event (never processing)
    expect(await parse(hook('PAYMENT_SETTLED', { status: 'SOMETHING_NEW' }, settled))).toEqual([])
    expect(await parse(hook('ORDER_CANCELLED', { status: 'CANCELLED' }))).toMatchObject([{ ref: ORDER.id, status: 'failed', error: { code: 'PAYMENT_FAILED' } }])
    for (const t of ['PAYMENT_CREATED', 'PAYMENT_FAILED', 'PAYMENT_EXPIRED', 'PAYMENT_CANCELLED', 'ORDER_CREATED', 'ORDER_RESIZED', 'PAYMENT_BRIDGE_PENDING']) {
      expect(await parse(hook(t, {}, { id: 'pay_1', status: 'EXPIRED' }))).toEqual([])
    }
    expect(await parse(hook('PAYMENT_CHARGEBACKED', { status: 'FULFILLED' }, settled))).toEqual([])
    expect(await parse(JSON.stringify({ type: 'ORDER_CREATED', data: { test: true, order: null, payment: null } }))).toEqual([])
    expect(await parse('{')).toEqual([])
  })

  it('catalog: hides rails with no orderbook liquidity for the currency; cached; failures throw', async () => {
    const { fetch, calls } = fakeFetch([
      { match: /paymentPlatform=wise/, reply: () => BOOK([entry('860000000000000000')]) },
      { match: /paymentPlatform=revolut/, reply: () => BOOK([]) },
    ])
    const a = peer(opts)
    const shared = memoryKV()
    const eur = await a.catalog!({ country: 'DE', currency: 'EUR', direction: 'deposit' }, { fetch, log: silentLog, shared })
    expect(eur.map((l) => [l.id, l.from.asset])).toEqual([['wise', { kind: 'fiat', currencies: ['EUR'] }]])
    await a.catalog!({ country: 'DE', currency: 'EUR', direction: 'deposit' }, { fetch, log: silentLog, shared })
    expect(calls).toHaveLength(2)
    for (const l of eur) expect(checkAdapterShape({ ...a, legs: [l] })).toEqual([])
    // No check: every rail with the currency
    const off = await peer({ ...opts, liquidityCheck: false }).catalog!({ currency: 'GBP', direction: 'deposit' }, { fetch: fakeFetch([]).fetch, log: silentLog, shared: memoryKV() })
    expect(off.map((l) => l.id)).toEqual(['revolut', 'wise'])
    const down = fakeFetch([{ match: 'orderbook', status: 500, reply: () => ({}) }])
    await expect(a.catalog!({ currency: 'USD', direction: 'deposit' }, { fetch: down.fetch, log: silentLog, shared: memoryKV() })).rejects.toBeTruthy()
  })

  it('passes runAdapterConformance', async () => {
    const { fetch } = fakeFetch(
      routes([{ method: 'GET', match: `/api/v1/orders/${ORDER.id}`, reply: () => env({ order: { ...ORDER, status: 'FULFILLED' }, currentPayment: { status: 'SETTLED', netSettledUsdcAmount: '96', fulfillTransaction: '0x1' } }) }]),
    )
    const body = hook('ORDER_FULFILLED', { status: 'FULFILLED' }, { status: 'SETTLED', netSettledUsdcAmount: '96', fulfillTransaction: '0x1' })
    const ts = String(Math.floor(Date.now() / 1000))
    const sig = createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex')
    const report = await runAdapterConformance(peer(opts), {
      fetch,
      fixtures: [
        { leg: leg('venmo'), quote: { amountIn: money('100') }, expect: { start: 'PAYMENT', status: 'COMPLETED' } },
        { leg: leg('wise', 'USD'), quote: { amountIn: money('25') } },
      ],
      errorPaths: [{ leg: leg('venmo'), quote: { amountIn: money('100') } }],
      webhooks: [
        { name: 'signed', rawBody: body, request: () => new Request('https://x/h', { method: 'POST', body, headers: { 'x-webhook-signature': sig, 'x-webhook-timestamp': ts } }), events: 1 },
        { name: 'unsigned', rawBody: body, request: () => new Request('https://x/h', { method: 'POST', body }), valid: false },
      ],
    })
    expect(report.problems).toEqual([])
  })

  // Live calls to the provider: allow 30 s, not the 5 s vitest default.
  it.runIf(process.env.LIVE === '1')('live: the public orderbook has USD liquidity on some rail', async () => {
    const legs = await peer({ ...opts, rails: ['venmo', 'cashapp', 'zelle', 'paypal'] }).catalog!({ country: 'US', currency: 'USD', direction: 'deposit' }, { fetch, log: silentLog, shared: memoryKV() })
    expect(legs.length).toBeGreaterThan(0)
  }, 30_000)
})
