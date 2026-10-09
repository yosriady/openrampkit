import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkAdapterShape, checkLegQuote, checkLegStep } from '@openrampkit/adapter'
import { USDC, isRegionAllowed } from '@openrampkit/core'
import type { PathwayLeg } from '@openrampkit/core'
import { transak, verifyHs256 } from './index.js'
import { fakeFetch, makeCtx, makeWebhookCtx, memoryKV, recordingLog, runAdapterConformance, silentLog } from '@openrampkit/adapter/testing'

const DEST = '0x000000000000000000000000000000000000beef'
const BASE_USDC = { kind: 'crypto' as const, chain: 'eip155:8453', token: USDC['eip155:8453']! }
const cardLeg: PathwayLeg = {
  adapterId: 'transak',
  legId: 'card',
  from: { asset: { kind: 'fiat', currency: 'EUR' }, location: { kind: 'user_account' } },
  to: { asset: BASE_USDC, location: { kind: 'address', address: DEST } },
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url')
function hs256(claims: object, secret: string) {
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const p = b64url(JSON.stringify(claims))
  const s = createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url')
  return `${h}.${p}.${s}`
}

const PRICE = {
  response: {
    quoteId: 'q1', conversionPrice: 1.07, marketConversionPrice: 1.08, slippage: 1, fiatCurrency: 'EUR', cryptoCurrency: 'USDC',
    paymentMethod: 'credit_debit_card', fiatAmount: 100, cryptoAmount: 102.345678, isBuyOrSell: 'BUY', network: 'base', feeDecimal: 0.0564, totalFee: 5.64,
    feeBreakdown: [
      { name: 'Transak fee', value: 4.5, id: 'transak_fee', ids: ['transak_fee'] },
      { name: 'Partner fee', value: 1, id: 'partner_fee', ids: ['partner_fee'] },
      { name: 'Network/Exchange fee', value: 0.14, id: 'network_fee', ids: ['network_fee'] },
    ],
    nonce: 1, cryptoLiquidityProvider: 'transak', notes: [],
  },
}

function routes() {
  return fakeFetch([
    { method: 'POST', match: '/partners/api/v2/refresh-token', reply: () => ({ data: { accessToken: 'ACCESS_TOKEN_1', expiresAt: Math.floor(Date.now() / 1000) + 7 * 86400 } }) },
    { method: 'GET', match: '/api/v1/pricing/public/quotes', reply: () => PRICE },
    { method: 'POST', match: '/api/v2/auth/session', reply: () => ({ data: { widgetUrl: 'https://global-stg.transak.com?apiKey=K&sessionId=eyJ.x.y' } }) },
    {
      method: 'GET',
      match: '/fiat/public/v1/currencies/fiat-currencies',
      reply: () => ({
        response: [
          {
            symbol: 'EUR', isAllowed: true, supportingCountries: ['DE', 'FR'],
            paymentOptions: [
              { id: 'credit_debit_card', isActive: true, minAmount: 4, maxAmount: 5278 },
              { id: 'apple_pay', isActive: true, minAmount: 4, maxAmount: 5278 },
              { id: 'sepa_bank_transfer', isActive: true, minAmount: 20, maxAmount: 30000 },
              { id: 'google_pay', isActive: false },
            ],
          },
          { symbol: 'PHP', isAllowed: true, supportingCountries: ['PH'], paymentOptions: [{ id: 'pm_gcash', isActive: true, minAmount: 500, maxAmount: 50000 }] },
        ],
      }),
    },
  ])
}

describe('transak adapter', () => {
  it('passes the shape check; static legs include card, wallets, bank transfer and UPI (IN)', () => {
    const a = transak({ apiKey: 'K', apiSecret: 'S', referrerDomain: 'app.test' })
    expect(checkAdapterShape(a)).toEqual([])
    expect(a.legs.map((l) => l.methods![0])).toEqual(['card', 'apple_pay', 'google_pay', 'bank_transfer', 'upi', 'faster_payments', 'open_banking', 'pse'])
    expect(a.legs.find((l) => l.id === 'upi')!.regions.allow).toEqual(['IN'])
    expect(a.legs.find((l) => l.id === 'faster_payments')!.regions.allow).toEqual(['GB'])
    expect(a.legs.find((l) => l.id === 'pse')!.from.asset).toEqual({ kind: 'fiat', currencies: ['COP'] })
    expect(a.legs.find((l) => l.id === 'open_banking')!.regions.allow).toContain('NL')
    // GBP bank transfers moved to the faster_payments leg
    expect(a.legs.find((l) => l.id === 'bank_transfer')!.from.asset).toEqual({ kind: 'fiat', currencies: ['EUR', 'USD'] })
    expect(a.legs[0]!.surfaces).toEqual(['IFRAME'])
  })

  it('catalog: methods and limits per fiat currency from the public list', async () => {
    const { fetch } = routes()
    const a = transak({ apiKey: 'K', apiSecret: 'S', referrerDomain: 'app.test', env: 'sandbox' })
    const eur = await a.catalog!({ country: 'DE', currency: 'EUR', direction: 'deposit' }, { fetch, log: silentLog, shared: memoryKV() })
    expect(eur.map((l) => [l.id, l.methods![0]])).toEqual([
      ['card', 'card'],
      ['apple_pay', 'apple_pay'],
      ['bank_transfer', 'sepa'],
    ])
    expect(eur[0]!.limits).toEqual({ min: '4', max: '5278', currency: 'EUR' })
    expect(eur[0]!.regions.allow).toEqual(['DE', 'FR'])
    const php = await a.catalog!({ country: 'PH', currency: 'PHP', direction: 'deposit' }, { fetch, log: silentLog, shared: memoryKV() })
    expect(php.map((l) => [l.id, l.methods![0]])).toEqual([['pm_gcash', 'gcash']])
  })

  it('quote: public pricing API with fees; start: access token + server-side widget URL (IFRAME)', async () => {
    const { fetch, calls } = routes()
    const a = transak({ apiKey: 'K', apiSecret: 'S', referrerDomain: 'app.test', env: 'sandbox' })
    const shared = memoryKV()
    const ctx = makeCtx({ fetch, shared, session: { country: 'DE', email: 'a@b.co' } })
    const q = await a.quote({ leg: cardLeg, amountIn: { value: '100', asset: { kind: 'fiat', currency: 'EUR' } } }, ctx)
    expect(checkLegQuote(q)).toEqual([])
    expect(q.output).toEqual({ value: '102.345678', asset: { ...BASE_USDC, symbol: 'USDC', decimals: 6 } })
    expect(q.fees.map((f) => [f.kind, f.amount])).toEqual([
      ['provider', '4.5'],
      ['app', '1'],
      ['network', '0.14'],
    ])
    const priceUrl = new URL(calls[0]!.url)
    expect(priceUrl.origin + priceUrl.pathname).toBe('https://api-stg.transak.com/api/v1/pricing/public/quotes')
    expect(Object.fromEntries(priceUrl.searchParams)).toEqual({
      partnerApiKey: 'K', fiatCurrency: 'EUR', cryptoCurrency: 'USDC', network: 'base', isBuyOrSell: 'BUY', paymentMethod: 'credit_debit_card', fiatAmount: '100', quoteCountryCode: 'DE',
    })

    const step = await a.start({ leg: cardLeg, quote: q, deliverTo: { address: DEST } }, ctx)
    expect(checkLegStep(step)).toEqual([])
    expect(step).toMatchObject({ state: 'PAYMENT', status: 'awaiting_user', surface: { kind: 'IFRAME', url: 'https://global-stg.transak.com?apiKey=K&sessionId=eyJ.x.y', origin: 'https://global-stg.transak.com', provider: 'Transak' } })
    expect(step.ref).toMatch(/^ork_[0-9a-f]{20}$/)
    const tokenCall = calls.find((c) => c.url.includes('refresh-token'))!
    expect(tokenCall.headers.get('api-secret')).toBe('S')
    expect(tokenCall.body).toEqual({ apiKey: 'K' })
    const session = calls.find((c) => c.url.includes('/api/v2/auth/session'))!
    expect(session.url).toBe('https://api-gateway-stg.transak.com/api/v2/auth/session')
    expect(session.headers.get('access-token')).toBe('ACCESS_TOKEN_1')
    expect((session.body as { widgetParams: Record<string, unknown> }).widgetParams).toMatchObject({
      apiKey: 'K', referrerDomain: 'app.test', cryptoCurrencyCode: 'USDC', network: 'base', walletAddress: DEST, disableWalletAddressForm: true,
      fiatCurrency: 'EUR', fiatAmount: 100, paymentMethod: 'credit_debit_card', partnerOrderId: step.ref, partnerCustomerId: 'user_1', redirectURL: 'https://app.test/api/openramp/return', email: 'a@b.co',
    })

    // the token is cached: a second start does not refresh it
    await a.start({ leg: cardLeg, quote: q, deliverTo: { address: DEST } }, ctx)
    expect(calls.filter((c) => c.url.includes('refresh-token'))).toHaveLength(1)
  })

  it('webhook: verifies the HS256 JWT in `data` with the access token and maps order statuses', async () => {
    const { fetch } = routes()
    const a = transak({ apiKey: 'K', apiSecret: 'S', referrerDomain: 'app.test' })
    // no token known yet: reject
    const body0 = JSON.stringify({ data: hs256({ webhookData: { partnerOrderId: 'ork_1', status: 'COMPLETED' }, eventID: 'ORDER_COMPLETED' }, 'ACCESS_TOKEN_1') })
    expect(await a.webhook!.verify(new Request('https://x', { method: 'POST', body: body0 }), body0, { log: silentLog, shared: memoryKV(), fetch })).toBe(false)

    // after a start() the adapter knows the token
    const ctx = makeCtx({ fetch })
    const q = await a.quote({ leg: cardLeg, amountIn: { value: '100', asset: { kind: 'fiat', currency: 'EUR' } } }, ctx)
    await a.start({ leg: cardLeg, quote: q, deliverTo: { address: DEST } }, ctx)
    const make = (webhookData: object, secret = 'ACCESS_TOKEN_1') => JSON.stringify({ data: hs256({ webhookData, eventID: 'X' }, secret) })
    const ok = make({ partnerOrderId: 'ork_1', status: 'COMPLETED', cryptoAmount: 99.5, network: 'base', transactionHash: '0xtx' })
    expect(await a.webhook!.verify(new Request('https://x', { method: 'POST', body: ok }), ok, { log: silentLog, shared: memoryKV(), fetch })).toBe(true)
    const forged = make({ partnerOrderId: 'ork_1', status: 'COMPLETED' }, 'wrong')
    expect(await a.webhook!.verify(new Request('https://x', { method: 'POST', body: forged }), forged, { log: silentLog, shared: memoryKV(), fetch })).toBe(false)

    expect(await a.webhook!.parse(ok, { log: silentLog, shared: memoryKV(), fetch })).toEqual([
      { ref: 'ork_1', status: 'succeeded', txHash: '0xtx', output: { value: '99.5', asset: { ...BASE_USDC, symbol: 'USDC', decimals: 6 } } },
    ])
    const st = async (status: string) => (await a.webhook!.parse(make({ partnerOrderId: 'ork_1', status }), { log: silentLog, shared: memoryKV(), fetch }))[0]?.status
    expect(await st('AWAITING_PAYMENT_FROM_USER')).toBeUndefined()
    expect(await st('PROCESSING')).toBe('processing')
    expect(await st('PENDING_DELIVERY_FROM_TRANSAK')).toBe('processing')
    expect(await st('FAILED')).toBe('failed')
    expect(await st('CANCELLED')).toBe('failed')
    expect(await st('EXPIRED')).toBe('expired')
    expect(await st('REFUNDED')).toBe('refunded')
  })

  it('verifyHs256 rejects other algorithms and bad signatures', async () => {
    const t = hs256({ a: 1 }, 'k')
    expect(await verifyHs256(t, 'k')).toEqual({ a: 1 })
    expect(await verifyHs256(t, 'x')).toBeUndefined()
    const none = `${b64url(JSON.stringify({ alg: 'none' }))}.${b64url('{}')}.`
    expect(await verifyHs256(none, 'k')).toBeUndefined()
  })
})


const eur = (amount: string) => ({ value: amount, asset: { kind: 'fiat' as const, currency: 'EUR' } })
const opts = { apiKey: 'K', apiSecret: 'S', referrerDomain: 'app.test' }
const TOKEN_ROUTE = { method: 'POST', match: '/partners/api/v2/refresh-token', reply: () => ({ data: { accessToken: 'ACCESS_TOKEN_1', expiresAt: Math.floor(Date.now() / 1000) + 7 * 86400 } }) }
const QUOTE = { adapterId: 'transak', legId: 'card', input: eur('100'), output: { value: '100', asset: BASE_USDC }, fees: [], eta: { min: 1, max: 2 } }

describe('transak conformance', () => {
  it('card leg and HS256 webhooks pass runAdapterConformance', async () => {
    const { fetch } = routes()
    const good = JSON.stringify({ data: hs256({ webhookData: { partnerOrderId: 'ork_1', status: 'COMPLETED', network: 'base', cryptoAmount: '5' } }, 'ACCESS_TOKEN_1') })
    const forged = JSON.stringify({ data: hs256({ webhookData: { partnerOrderId: 'ork_1', status: 'COMPLETED' } }, 'guess') })
    const req = (body: string) => () => new Request('https://x', { method: 'POST', body })
    const report = await runAdapterConformance(transak(opts), {
      fetch,
      fixtures: [{ leg: cardLeg, quote: { amountIn: eur('100') }, start: { deliverTo: { address: DEST } }, expect: { start: 'PAYMENT' } }],
      webhooks: [
        { name: 'signed', rawBody: good, request: req(good), events: 1 },
        { name: 'forged', rawBody: forged, request: req(forged), valid: false },
        { name: 'not json', rawBody: 'x', request: req('x'), valid: false },
        { name: 'data not a string', rawBody: '{"data":{"a":1}}', request: req('{"data":{"a":1}}'), valid: false },
      ],
    })
    expect(report.problems).toEqual([])
  })
})

describe('transak errors and edge cases', () => {
  afterEach(() => vi.useRealTimers())

  it('regions: UPI only in India', () => {
    const upi = transak(opts).legs.find((l) => l.id === 'upi')!
    expect(isRegionAllowed(upi.regions, 'IN')).toBe(true)
    expect(isRegionAllowed(upi.regions, 'US')).toBe(false)
  })

  it('quote: maps 429, 4xx with a message, 401 and 5xx; an empty answer is NO_QUOTES', async () => {
    const a = transak(opts)
    const q = (route: object) => a.quote({ leg: cardLeg, amountIn: eur('10') }, makeCtx({ fetch: fakeFetch([{ method: 'GET', match: '/pricing/public/quotes', ...route }]).fetch }))
    await expect(q({ status: 429, reply: () => ({}) })).rejects.toMatchObject({ status: 429, error: { code: 'RATE_LIMITED' } })
    await expect(q({ status: 400, reply: () => ({ error: { message: 'Minimum is 30 EUR' } }) })).rejects.toMatchObject({ error: { code: 'NO_QUOTES', message: 'Transak: Minimum is 30 EUR' } })
    await expect(q({ status: 400, reply: () => ({}) })).rejects.toMatchObject({ error: { code: 'NO_QUOTES', message: 'Transak could not price this amount.' } })
    await expect(q({ status: 401, reply: () => ({ message: 'Invalid API key' }) })).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
    await expect(q({ status: 502, reply: () => ({}) })).rejects.toMatchObject({ status: 502, error: { code: 'PROVIDER_UNAVAILABLE', message: 'Transak is not available right now.' } })
    await expect(q({ reply: () => ({}) })).rejects.toMatchObject({ status: 422, error: { code: 'NO_QUOTES', message: 'Transak did not return a quote.' } })
    await expect(a.quote({ leg: cardLeg, amountIn: { value: '1', asset: BASE_USDC } }, makeCtx({ fetch: fakeFetch([]).fetch }))).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
  })

  it('quote: payment method per leg and currency, exact output, country, zero fees dropped', async () => {
    const { fetch, calls } = fakeFetch([{ method: 'GET', match: '/pricing/public/quotes', reply: () => ({ response: { ...PRICE.response, feeBreakdown: [{ name: 'Zero', value: 0, id: 'x' }] } }) }])
    const a = transak({ ...opts, defaultCountry: 'gb' })
    const params = () => Object.fromEntries(new URL(calls.at(-1)!.url).searchParams)
    const leg = (legId: string, currency: string): PathwayLeg => ({ ...cardLeg, legId, from: { asset: { kind: 'fiat', currency }, location: { kind: 'user_account' } } })
    for (const [legId, currency, pm] of [
      ['bank_transfer', 'EUR', 'sepa_bank_transfer'],
      ['bank_transfer', 'GBP', 'gbp_bank_transfer'],
      ['bank_transfer', 'USD', 'pm_wire'],
      ['bank_transfer', 'CHF', 'sepa_bank_transfer'],
      ['upi', 'INR', 'inr_upi'],
      ['pm_gcash', 'PHP', 'pm_gcash'],
      ['faster_payments', 'GBP', 'gbp_bank_transfer'],
      ['open_banking', 'GBP', 'pm_open_banking'],
      ['open_banking', 'EUR', 'pm_open_banking'],
      ['pse', 'COP', 'pm_pse'],
    ] as const) {
      const q = await a.quote({ leg: leg(legId, currency), amountOut: { value: '20', asset: BASE_USDC } }, makeCtx({ fetch, session: { country: undefined } }))
      expect(params()).toMatchObject({ paymentMethod: pm, fiatCurrency: currency, cryptoAmount: '20', quoteCountryCode: 'GB' })
      expect(params().fiatAmount).toBeUndefined()
      expect(q.fees).toEqual([])
      expect(q.eta).toEqual(a.legs.find((l) => l.id === legId)?.eta ?? { min: 120, max: 1800 })
    }
    expect(a.legs.find((l) => l.id === 'bank_transfer')!.eta).toEqual({ min: 600, max: 259200 })
    await transak(opts).quote({ leg: { ...cardLeg, to: { asset: { kind: 'crypto', chain: 'eip155:137', token: USDC['eip155:137']! }, location: { kind: 'address', address: DEST } } } }, makeCtx({ fetch, session: { country: undefined } }))
    expect(params().quoteCountryCode).toBeUndefined()
    expect(params().network).toBe('polygon')
    expect(params().fiatAmount).toBeUndefined()
    expect(params().cryptoAmount).toBeUndefined()
  })

  it('start: needs a wallet; token and widget failures are PROVIDER_UNAVAILABLE and logged', async () => {
    const a = transak(opts)
    await expect(a.start({ leg: cardLeg, quote: QUOTE }, makeCtx({ fetch: fakeFetch([]).fetch, destination: { type: 'merchant', merchantId: 'm', currency: 'EUR' } as never }))).rejects.toMatchObject({
      error: { message: 'Transak needs a wallet address to deliver to.' },
    })
    const start = (routes: Parameters<typeof fakeFetch>[0], log = recordingLog()) => transak(opts).start({ leg: cardLeg, quote: QUOTE }, makeCtx({ fetch: fakeFetch(routes).fetch, log }))
    const log = recordingLog()
    await expect(start([{ method: 'POST', match: 'refresh-token', status: 401, reply: () => ({}) }], log)).rejects.toMatchObject({ status: 502, error: { message: 'Transak could not start the checkout.' } })
    expect(log.warnings).toEqual(['transak: create widget URL failed'])
    await expect(start([{ method: 'POST', match: 'refresh-token', reply: () => ({ data: {} }) }])).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
    await expect(start([TOKEN_ROUTE, { method: 'POST', match: '/auth/session', status: 500, reply: () => ({}) }])).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
    await expect(start([TOKEN_ROUTE, { method: 'POST', match: '/auth/session', reply: () => ({ data: {} }) }])).rejects.toMatchObject({ error: { message: 'Transak did not return a widget URL.' } })
    await expect(start([TOKEN_ROUTE, { method: 'POST', match: '/auth/session', reply: () => ({ data: { widgetUrl: 'not a url' } }) }])).rejects.toMatchObject({ error: { message: 'Transak did not return a widget URL.' } })
  })

  it('start: regional legs send their Transak payment method (PSE, Faster Payments, open banking)', async () => {
    for (const [legId, currency, pm] of [
      ['pse', 'COP', 'pm_pse'],
      ['faster_payments', 'GBP', 'gbp_bank_transfer'],
      ['open_banking', 'EUR', 'pm_open_banking'],
    ] as const) {
      const { fetch, calls } = routes()
      const shared = memoryKV()
      await shared.put('accessToken', { token: 'STORED', expiresAt: Math.floor(Date.now() / 1000) + 86400 })
      const a = transak({ ...opts, env: 'sandbox' })
      const quote = { ...QUOTE, input: { value: '100', asset: { kind: 'fiat' as const, currency } }, data: {} }
      await a.start({ leg: { ...cardLeg, legId }, quote }, makeCtx({ fetch, shared }))
      const session = calls.find((c) => c.url.includes('/auth/session'))!
      expect((session.body as { widgetParams: Record<string, unknown> }).widgetParams).toMatchObject({ fiatCurrency: currency, paymentMethod: pm })
    }
  })

  it('start: REDIRECT surface; quote data missing uses the leg method; token from shared KV; refresh near expiry', async () => {
    const { fetch, calls } = routes()
    const shared = memoryKV()
    await shared.put('accessToken', { token: 'STORED', expiresAt: Math.floor(Date.now() / 1000) + 86400 })
    const a = transak({ ...opts, surface: 'REDIRECT', env: 'sandbox' })
    expect(a.legs[0]!.surfaces).toEqual(['REDIRECT'])
    const ctx = makeCtx({ fetch, shared, session: { email: undefined, country: undefined, ip: '203.0.113.7' } })
    const step = await a.start({ leg: { ...cardLeg, legId: 'bank_transfer' }, quote: { ...QUOTE, input: { value: '100', asset: BASE_USDC } } }, ctx)
    // keepReferrer: Transak checks the Referer against the partner domain
    expect(step.surface).toEqual({ kind: 'REDIRECT', url: 'https://global-stg.transak.com?apiKey=K&sessionId=eyJ.x.y', popup: true, provider: 'Transak', keepReferrer: true })
    const session = calls.find((c) => c.url.includes('/auth/session'))!
    expect(session.headers.get('access-token')).toBe('STORED')
    expect(session.headers.get('x-user-ip')).toBe('203.0.113.7')
    const params = (session.body as { widgetParams: Record<string, unknown> }).widgetParams
    expect(params).toMatchObject({ fiatCurrency: 'USD', paymentMethod: 'pm_wire', network: 'base' })
    expect(params.email).toBeUndefined()
    expect(params.countryCode).toBeUndefined()
    expect(calls.some((c) => c.url.includes('refresh-token'))).toBe(false)

    // a token that expires within the hour is refreshed; two parallel starts refresh once
    const soon = memoryKV()
    await soon.put('accessToken', { token: 'OLD', expiresAt: Math.floor(Date.now() / 1000) + 600 })
    const b = transak(opts)
    const r2 = routes()
    const c2 = makeCtx({ fetch: r2.fetch, shared: soon })
    await Promise.all([b.start({ leg: cardLeg, quote: QUOTE }, c2), b.start({ leg: cardLeg, quote: QUOTE }, c2)])
    expect(r2.calls.filter((c) => c.url.includes('refresh-token'))).toHaveLength(1)
    expect(await soon.get('accessToken')).toMatchObject({ token: 'ACCESS_TOKEN_1' })
    // a token without expiresAt is kept for 6 days
    const noExp = fakeFetch([{ method: 'POST', match: 'refresh-token', reply: () => ({ data: { accessToken: 'T2' } }) }, { method: 'POST', match: '/auth/session', reply: () => ({ data: { widgetUrl: 'https://global.transak.com/?s=1' } }) }])
    const kv = memoryKV()
    await transak(opts).start({ leg: cardLeg, quote: QUOTE }, makeCtx({ fetch: noExp.fetch, shared: kv }))
    const rec = await kv.get<{ expiresAt: number }>('accessToken')
    expect(rec!.expiresAt).toBeGreaterThan(Date.now() / 1000 + 5 * 86400)
  })

  it('catalog: a missing list throws and is not cached; unknown or blocked currencies give no legs', async () => {
    const a = transak(opts)
    const shared = memoryKV()
    await expect(a.catalog!({ currency: 'EUR', direction: 'deposit' }, { fetch: fakeFetch([{ match: 'fiat-currencies', reply: () => ({}) }]).fetch, log: silentLog, shared })).rejects.toMatchObject({
      error: { code: 'PROVIDER_UNAVAILABLE' },
    })
    await expect(a.catalog!({ currency: 'EUR', direction: 'deposit' }, { fetch: fakeFetch([{ match: 'fiat-currencies', status: 503, reply: () => ({}) }]).fetch, log: silentLog, shared })).rejects.toMatchObject({ status: 503 })
    expect(shared.data.size).toBe(0)
    const list = {
      response: [
        { symbol: 'GBP', isAllowed: false, paymentOptions: [{ id: 'credit_debit_card' }] },
        {
          symbol: 'eur',
          paymentOptions: [{ id: 'sepa_bank_transfer', minAmount: 20 }, { id: 'gbp_bank_transfer' }, { id: 'pm_open_banking' }, { id: 'pm_something_new', maxAmount: 99 }],
        },
      ],
    }
    const { fetch, calls } = fakeFetch([{ match: 'fiat-currencies', reply: () => list }])
    const legs = await a.catalog!({ currency: 'EUR', direction: 'deposit' }, { fetch, log: silentLog, shared })
    expect(legs.map((l) => [l.id, l.methods![0], l.limits])).toEqual([
      ['bank_transfer', 'sepa', { min: '20', currency: 'EUR' }],
      ['faster_payments', 'faster_payments', { currency: 'EUR' }],
      ['open_banking', 'open_banking', { currency: 'EUR' }],
      ['pm_something_new', 'something_new', { max: '99', currency: 'EUR' }],
    ])
    expect(legs[0]!.regions.allow).toEqual(['*'])
    expect(await a.catalog!({ currency: 'GBP', direction: 'deposit' }, { fetch, log: silentLog, shared })).toEqual([])
    expect(await a.catalog!({ currency: 'JPY', direction: 'deposit' }, { fetch, log: silentLog, shared })).toEqual([])
    expect(calls).toHaveLength(1) // cached
    // a currency with no payment options at all
    const bare = fakeFetch([{ match: 'fiat-currencies', reply: () => ({ response: [{ symbol: 'EUR' }] }) }])
    expect(await a.catalog!({ currency: 'EUR', direction: 'deposit' }, { fetch: bare.fetch, log: silentLog, shared: memoryKV() })).toEqual([])
  })

  it('webhook: token from shared KV; expired JWTs; parse edge cases', async () => {
    const shared = memoryKV()
    await shared.put('accessToken', { token: 'KV_TOKEN', expiresAt: Math.floor(Date.now() / 1000) + 86400 })
    const a = transak(opts)
    const ctx = makeWebhookCtx({ shared })
    const body = (claims: object, secret = 'KV_TOKEN') => JSON.stringify({ data: hs256(claims, secret) })
    const ok = body({ partnerOrderId: 'ork_9', status: 'ON_HOLD_PENDING_DELIVERY_FROM_TRANSAK', network: 'unknown-net', cryptoAmount: 1 })
    expect(await a.webhook!.verify(new Request('https://x', { method: 'POST', body: ok }), ok, ctx)).toBe(true)
    // flat claims (no webhookData), unknown network: no output
    expect(await a.webhook!.parse(ok, ctx)).toEqual([{ ref: 'ork_9', status: 'processing' }])
    const expired = body({ webhookData: { partnerOrderId: 'x' }, exp: Math.floor(Date.now() / 1000) - 3600 })
    expect(await a.webhook!.verify(new Request('https://x', { method: 'POST', body: expired }), expired, ctx)).toBe(false)
    // no token anywhere: rejected and logged
    const log = recordingLog()
    expect(await transak(opts).webhook!.verify(new Request('https://x', { method: 'POST', body: ok }), ok, makeWebhookCtx({ log }))).toBe(false)
    expect(log.warnings).toHaveLength(1)
    // parse
    const plog = recordingLog()
    expect(await a.webhook!.parse('not json', makeWebhookCtx({ log: plog }))).toEqual([])
    expect(plog.warnings).toEqual(['transak: webhook body is not JSON'])
    expect(await a.webhook!.parse('{"data":5}', ctx)).toEqual([])
    expect(await a.webhook!.parse(body({ webhookData: { status: 'COMPLETED' } }), ctx)).toEqual([])
    expect(await a.webhook!.parse(JSON.stringify({ data: 'a.!!!.c' }), ctx)).toEqual([])
    expect(await a.webhook!.parse(body({ webhookData: { partnerOrderId: 'o', status: 'PAYMENT_DONE_MARKED_BY_USER' } }), ctx)).toEqual([{ ref: 'o', status: 'processing' }])
    expect(await a.webhook!.parse(body({ webhookData: { partnerOrderId: 'o', status: 'COMPLETED', network: 'polygon', cryptoAmount: '7.25' } }), ctx)).toMatchObject([{ status: 'succeeded', output: { value: '7.25', asset: { chain: 'eip155:137' } } }])
  })

  it('verifyHs256: malformed tokens and payloads', async () => {
    expect(await verifyHs256('a.b', 'k')).toBeUndefined()
    expect(await verifyHs256('!!!.e30.x', 'k')).toBeUndefined()
    // a correct signature over a payload that is not JSON
    const h = b64url(JSON.stringify({ alg: 'HS256' }))
    const p = b64url('not json')
    const sig = createHmac('sha256', 'k').update(`${h}.${p}`).digest('base64url')
    expect(await verifyHs256(`${h}.${p}.${sig}`, 'k')).toBeUndefined()
    const fresh = hs256({ exp: Math.floor(Date.now() / 1000) + 60 }, 'k')
    expect(await verifyHs256(fresh, 'k')).toMatchObject({ exp: expect.any(Number) })
  })

  it('health: ok, unexpected shape, down', async () => {
    const a = transak(opts)
    expect(await a.health!({ fetch: fakeFetch([{ match: 'fiat-currencies', reply: () => ({ response: [] }) }]).fetch, log: silentLog })).toEqual({ ok: true })
    expect(await a.health!({ fetch: fakeFetch([{ match: 'fiat-currencies', reply: () => ({}) }]).fetch, log: silentLog })).toEqual({ ok: false })
    const down = await a.health!({ fetch: fakeFetch([{ match: 'fiat-currencies', status: 500, reply: () => ({}) }]).fetch, log: silentLog })
    expect(down).toMatchObject({ ok: false, detail: expect.stringMatching(/HTTP 500/) })
  })
})
