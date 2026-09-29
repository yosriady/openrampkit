import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { checkAdapterShape, checkLegQuote, checkLegStep } from '@openrampkit/adapter'
import { USDC } from '@openrampkit/core'
import type { PathwayLeg } from '@openrampkit/core'
import { transak, verifyHs256 } from './index.js'
import { fakeFetch, makeCtx, memoryKV, silentLog } from './testctx.js'

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
    expect(a.legs.map((l) => l.methods![0])).toEqual(['card', 'apple_pay', 'google_pay', 'bank_transfer', 'upi'])
    expect(a.legs.find((l) => l.id === 'upi')!.regions.allow).toEqual(['IN'])
    expect(a.legs[0]!.surfaces).toEqual(['IFRAME'])
  })

  it('catalog: methods and limits per fiat currency from the public list', async () => {
    const { fetch } = routes()
    const a = transak({ apiKey: 'K', apiSecret: 'S', referrerDomain: 'app.test', env: 'staging' })
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
    const a = transak({ apiKey: 'K', apiSecret: 'S', referrerDomain: 'app.test', env: 'staging' })
    const shared = memoryKV()
    const ctx = makeCtx({ fetch, shared, session: { country: 'DE', email: 'a@b.co' } })
    const q = await a.quote({ leg: cardLeg, amountIn: { amount: '100', asset: { kind: 'fiat', currency: 'EUR' } } }, ctx)
    expect(checkLegQuote(q)).toEqual([])
    expect(q.output).toEqual({ amount: '102.345678', asset: { ...BASE_USDC, symbol: 'USDC', decimals: 6 } })
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
    const q = await a.quote({ leg: cardLeg, amountIn: { amount: '100', asset: { kind: 'fiat', currency: 'EUR' } } }, ctx)
    await a.start({ leg: cardLeg, quote: q, deliverTo: { address: DEST } }, ctx)
    const make = (webhookData: object, secret = 'ACCESS_TOKEN_1') => JSON.stringify({ data: hs256({ webhookData, eventID: 'X' }, secret) })
    const ok = make({ partnerOrderId: 'ork_1', status: 'COMPLETED', cryptoAmount: 99.5, network: 'base', transactionHash: '0xtx' })
    expect(await a.webhook!.verify(new Request('https://x', { method: 'POST', body: ok }), ok, { log: silentLog, shared: memoryKV(), fetch })).toBe(true)
    const forged = make({ partnerOrderId: 'ork_1', status: 'COMPLETED' }, 'wrong')
    expect(await a.webhook!.verify(new Request('https://x', { method: 'POST', body: forged }), forged, { log: silentLog, shared: memoryKV(), fetch })).toBe(false)

    expect(await a.webhook!.parse(ok, { log: silentLog, shared: memoryKV(), fetch })).toEqual([
      { ref: 'ork_1', status: 'succeeded', txHash: '0xtx', output: { amount: '99.5', asset: { ...BASE_USDC, symbol: 'USDC', decimals: 6 } } },
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
