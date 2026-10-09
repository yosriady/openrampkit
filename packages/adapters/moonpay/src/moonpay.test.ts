import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { checkAdapterShape, checkLegQuote, checkLegStep } from '@openrampkit/adapter'
import { USDC, isRegionAllowed } from '@openrampkit/core'
import type { PathwayLeg } from '@openrampkit/core'
import { fakeFetch, makeCtx, makeWebhookCtx, memoryKV, runAdapterConformance, silentLog } from '@openrampkit/adapter/testing'
import { MOONPAY_METHODS, moonpay } from './index.js'

const PK = 'pk_test_123'
const SK = 'sk_test_secret'
const WK = 'wk_test_webhook'
const BASE_USDC = { kind: 'crypto' as const, chain: 'eip155:8453', token: USDC['eip155:8453']! }
const ETH_USDC = { kind: 'crypto' as const, chain: 'eip155:1', token: USDC['eip155:1']! }
const usd = (amount: string) => ({ value: amount, asset: { kind: 'fiat' as const, currency: 'USD' } })

const leg = (legId: string, to = BASE_USDC, currency = 'USD'): PathwayLeg => ({
  adapterId: 'moonpay',
  legId,
  from: { asset: { kind: 'fiat', currency }, location: { kind: 'user_account' } },
  to: { asset: to, location: { kind: 'address', address: 'deposit' } },
})

// Live response shape (GET /v3/currencies/usdc_base/buy_quote, areFeesIncluded=true)
const QUOTE = {
  baseCurrencyAmount: 94.62, baseCurrencyCode: 'usd', quoteCurrencyCode: 'usdc_base', quoteCurrencyAmount: 94.55, quoteCurrencyPrice: 1.0007,
  feeAmount: 4.99, extraFeeAmount: 0, extraFeePercentage: 0, networkFeeAmount: 0.39, networkFeeAmountNonRefundable: true, totalAmount: 100,
}

const TX = (status: string, extra: Record<string, unknown> = {}) => ({
  id: 'tx_1', status, externalTransactionId: 'ork_abc', currency: { code: 'usdc_base' }, quoteCurrencyAmount: 94.55, cryptoTransactionId: null, ...extra,
})

const opts = { publishableKey: PK, secretKey: SK, webhookKey: WK, env: 'production' as const }

describe('moonpay adapter', () => {
  it('declares one leg per payment method with MoonPay region rules', () => {
    const a = moonpay(opts)
    expect(checkAdapterShape(a)).toEqual([])
    expect(a.legs.map((l) => l.id)).toEqual(MOONPAY_METHODS.map((m) => m.id))
    const card = a.legs.find((l) => l.id === 'card')!
    expect(card.methods).toEqual(['card'])
    expect(card.surfaces).toEqual(['REDIRECT'])
    expect(isRegionAllowed(card.regions, 'US', 'US-CA')).toBe(true)
    expect(isRegionAllowed(card.regions, 'US', 'US-VI')).toBe(false)
    expect(isRegionAllowed(card.regions, 'IN')).toBe(false)
    expect(isRegionAllowed(card.regions, 'DE')).toBe(true)
    const sepa = a.legs.find((l) => l.id === 'sepa')!
    expect(sepa.from.asset).toEqual({ kind: 'fiat', currencies: ['EUR'] })
    expect(isRegionAllowed(sepa.regions, 'DE')).toBe(true)
    expect(isRegionAllowed(sepa.regions, 'US')).toBe(false)
    const ach = a.legs.find((l) => l.id === 'ach')!
    expect(isRegionAllowed(ach.regions, 'US', 'US-TX')).toBe(true)
    expect(isRegionAllowed(ach.regions, 'US', 'US-VI')).toBe(false)
    expect(moonpay({ ...opts, methods: ['card'], surface: 'iframe' }).legs.map((l) => [l.id, l.surfaces])).toEqual([['card', ['IFRAME']]])
    expect(() => moonpay({ ...opts, methods: ['nope'] })).toThrow(/selects no known leg/)
  })

  it('UK legs: Faster Payments and open banking (GBP, GB only), quoted and started with their MoonPay ids', async () => {
    const a = moonpay(opts)
    const fps = a.legs.find((l) => l.id === 'gbp_bank')!
    const ob = a.legs.find((l) => l.id === 'gbp_open_banking')!
    expect(fps.methods).toEqual(['faster_payments'])
    expect(ob.methods).toEqual(['open_banking'])
    for (const l of [fps, ob]) {
      expect(l.from.asset).toEqual({ kind: 'fiat', currencies: ['GBP'] })
      expect(isRegionAllowed(l.regions, 'GB')).toBe(true)
      expect(isRegionAllowed(l.regions, 'DE')).toBe(false)
    }
    for (const [legId, pm] of [['gbp_bank', 'gbp_bank_transfer'], ['gbp_open_banking', 'gbp_open_banking_payment']] as const) {
      const { fetch, calls } = fakeFetch([{ match: '/buy_quote', reply: () => ({ ...QUOTE, baseCurrencyCode: 'gbp' }) }])
      const ctx = makeCtx({ fetch, session: { country: 'GB' } })
      const gbp = { value: '100', asset: { kind: 'fiat' as const, currency: 'GBP' } }
      const q = await a.quote({ leg: leg(legId, BASE_USDC, 'GBP'), amountIn: gbp }, ctx)
      const qp = new URL(calls[0]!.url).searchParams
      expect(qp.get('paymentMethod')).toBe(pm)
      expect(qp.get('baseCurrencyCode')).toBe('gbp')
      const step = await a.start({ leg: leg(legId, BASE_USDC, 'GBP'), quote: q, deliverTo: { address: '0xd16e0c839b6f652970c5d4d035d9cfcff5c185af' } }, ctx)
      const url = new URL(step.surface!.kind === 'REDIRECT' ? step.surface!.url.split('&signature=')[0]! : '')
      expect(url.searchParams.get('paymentMethod')).toBe(pm)
      expect(url.searchParams.get('baseCurrencyCode')).toBe('gbp')
    }
  })

  it('quote: GET buy_quote with fees included, maps amounts and fees', async () => {
    const { fetch, calls } = fakeFetch([{ match: '/buy_quote', reply: () => QUOTE }])
    const a = moonpay(opts)
    const q = await a.quote({ leg: leg('card'), amountIn: usd('100'), deliverTo: { address: '0xabc' } }, makeCtx({ fetch }))
    expect(checkLegQuote(q)).toEqual([])
    const u = new URL(calls[0]!.url)
    expect(u.origin + u.pathname).toBe('https://api.moonpay.com/v3/currencies/usdc_base/buy_quote')
    expect(Object.fromEntries(u.searchParams)).toEqual({
      apiKey: PK, baseCurrencyCode: 'usd', paymentMethod: 'credit_debit_card', areFeesIncluded: 'true', baseCurrencyAmount: '100.00', walletAddress: '0xabc',
    })
    expect(q.input).toEqual(usd('100'))
    expect(q.output).toEqual({ value: '94.55', asset: { ...BASE_USDC, symbol: 'USDC', decimals: 6 } })
    expect(q.fees).toEqual([
      { kind: 'provider', label: 'MoonPay fee', amount: '4.99', currency: 'USD' },
      { kind: 'network', label: 'Network fee', amount: '0.39', currency: 'USD' },
    ])
    expect(q.data).toMatchObject({ currencyCode: 'usdc_base', paymentMethod: 'credit_debit_card' })
  })

  it('quote: exact output, other chains and the extra fee', async () => {
    const { fetch, calls } = fakeFetch([{ match: '/buy_quote', reply: () => ({ ...QUOTE, extraFeeAmount: 1, quoteCurrencyCode: 'usdc' }) }])
    const a = moonpay({ ...opts, extraFeePercentage: 1 })
    const q = await a.quote({ leg: leg('apple_pay', ETH_USDC), amountOut: { value: '50', asset: ETH_USDC } }, makeCtx({ fetch }))
    const u = new URL(calls[0]!.url)
    expect(u.pathname).toBe('/v3/currencies/usdc/buy_quote')
    expect(u.searchParams.get('quoteCurrencyAmount')).toBe('50')
    expect(u.searchParams.get('baseCurrencyAmount')).toBeNull()
    expect(u.searchParams.get('paymentMethod')).toBe('apple_pay')
    expect(u.searchParams.get('extraFeePercentage')).toBe('1')
    expect(q.fees.find((f) => f.kind === 'app')).toEqual({ kind: 'app', label: 'App fee', amount: '1', currency: 'USD' })
    expect(q.output.asset).toMatchObject({ chain: 'eip155:1' })
  })

  it('quote: region rules per asset (usdc_base is not sold in New York or Canada)', async () => {
    const { fetch, calls } = fakeFetch([{ match: '/buy_quote', reply: () => QUOTE }])
    const a = moonpay(opts)
    await expect(a.quote({ leg: leg('card'), amountIn: usd('100') }, makeCtx({ fetch, session: { country: 'US', region: 'US-NY' } }))).rejects.toMatchObject({ error: { code: 'REGION_UNSUPPORTED' } })
    await expect(a.quote({ leg: leg('card'), amountIn: usd('100') }, makeCtx({ fetch, session: { country: 'CA' } }))).rejects.toMatchObject({ error: { code: 'REGION_UNSUPPORTED' } })
    expect(calls).toHaveLength(0)
    // USDC on Ethereum is fine in New York
    await expect(a.quote({ leg: leg('card', ETH_USDC), amountIn: usd('100') }, makeCtx({ fetch, session: { country: 'US', region: 'US-NY' } }))).resolves.toBeTruthy()
  })

  it('quote: maps HTTP errors (400 NO_QUOTES with the MoonPay message, 429, 5xx, missing fields)', async () => {
    const a = moonpay(opts)
    const run = (status: number, body: unknown = {}) =>
      a.quote({ leg: leg('card'), amountIn: usd('1') }, makeCtx({ fetch: fakeFetch([{ match: '/buy_quote', status, reply: () => body }]).fetch }))
    await expect(run(400, { message: 'Amount too low', type: 'BadRequestError' })).rejects.toMatchObject({ error: { code: 'NO_QUOTES', message: 'MoonPay: Amount too low' } })
    await expect(run(429)).rejects.toMatchObject({ error: { code: 'RATE_LIMITED' } })
    await expect(run(503)).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' }, status: 502 })
    await expect(run(401, { message: 'Not authorized' })).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
    await expect(run(200, { baseCurrencyAmount: 1 })).rejects.toMatchObject({ error: { code: 'NO_QUOTES' } })
    await expect(a.quote({ leg: leg('card'), amountIn: usd('1') }, makeCtx({ fetch: fakeFetch([]).fetch }))).rejects.toMatchObject({ error: { code: 'NO_QUOTES' } })
    await expect(a.quote({ leg: leg('nope'), amountIn: usd('1') }, makeCtx({ fetch: fakeFetch([]).fetch }))).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
  })

  it('start: signed REDIRECT URL (base64 HMAC-SHA256 over the "?" query string, appended last)', async () => {
    const { fetch } = fakeFetch([{ match: '/buy_quote', reply: () => QUOTE }])
    const a = moonpay(opts)
    const ctx = makeCtx({ fetch, session: { email: 'a@b.co', userId: 'u_42' } })
    const q = await a.quote({ leg: leg('card'), amountIn: usd('100') }, ctx)
    const step = await a.start({ leg: leg('card'), quote: q, deliverTo: { address: '0xd16e0c839b6f652970c5d4d035d9cfcff5c185af' } }, ctx)
    expect(checkLegStep(step)).toEqual([])
    expect(step).toMatchObject({ state: 'PAYMENT', status: 'awaiting_user' })
    expect(step.ref).toMatch(/^ork_[0-9a-f]{24}$/)
    const s = step.surface!
    if (s.kind !== 'REDIRECT') throw new Error('expected REDIRECT')
    expect(s.popup).toBe(true)
    const [unsigned, sigPart] = s.url.split('&signature=')
    const url = new URL(unsigned!)
    expect(url.origin).toBe('https://buy.moonpay.com')
    // The MoonPay docs sample, with node:crypto (tests only)
    expect(decodeURIComponent(sigPart!)).toBe(createHmac('sha256', SK).update(url.search).digest('base64'))
    expect(Object.fromEntries(url.searchParams)).toEqual({
      apiKey: PK,
      currencyCode: 'usdc_base',
      walletAddress: '0xd16e0c839b6f652970c5d4d035d9cfcff5c185af',
      baseCurrencyCode: 'usd',
      baseCurrencyAmount: '100.00',
      lockAmount: 'true',
      paymentMethod: 'credit_debit_card',
      externalTransactionId: step.ref,
      externalCustomerId: 'u_42',
      email: 'a@b.co',
      redirectURL: 'https://app.test/api/openramp/return',
      showWalletAddressForm: 'false',
    })
  })

  it('start: a known signature vector, the IFRAME surface and the sandbox widget', async () => {
    const { fetch } = fakeFetch([{ match: '/buy_quote', reply: () => QUOTE }])
    const a = moonpay({ ...opts, env: 'sandbox', surface: 'iframe' })
    const ctx = makeCtx({ fetch })
    const q = await a.quote({ leg: leg('card'), amountIn: usd('100') }, ctx)
    const step = await a.start({ leg: leg('card'), quote: q }, ctx)
    const s = step.surface!
    if (s.kind !== 'IFRAME') throw new Error('expected IFRAME')
    expect(s.origin).toBe('https://buy-sandbox.moonpay.com')
    expect(s.url.startsWith('https://buy-sandbox.moonpay.com/?apiKey=')).toBe(true)
    expect(new URL(s.url).searchParams.get('walletAddress')).toBe('0x000000000000000000000000000000000000beef')
    // Fixed vector: the signature of a fixed query string does not depend on the adapter
    const search = '?apiKey=pk_test_123&currencyCode=usdc&walletAddress=0xabc'
    expect(createHmac('sha256', SK).update(search).digest('base64')).toBe('RgaRl8JrhTmxsJDUF+aYiOF5/xG652v/h2zz6aS0tgA=')
  })

  it('start: needs a wallet address', async () => {
    const a = moonpay(opts)
    const ctx = makeCtx({ fetch: fakeFetch([]).fetch, destination: { type: 'merchant', currency: 'USD' } })
    const quote = { adapterId: 'moonpay', legId: 'card', input: usd('10'), output: { value: '9', asset: BASE_USDC }, fees: [], eta: { min: 1, max: 2 } }
    await expect(a.start({ leg: leg('card'), quote }, ctx)).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
  })

  it('status: maps MoonPay transaction statuses (array or object, 404 = not paid yet)', async () => {
    const a = moonpay(opts)
    const status = async (reply: unknown, httpStatus = 200) => {
      const { fetch, calls } = fakeFetch([{ match: '/v1/transactions/ext/', status: httpStatus, reply: () => reply }])
      const s = await a.status!({ leg: leg('card'), ref: 'ork_abc' }, makeCtx({ fetch }))
      expect(calls[0]!.url).toBe(`https://api.moonpay.com/v1/transactions/ext/ork_abc?apiKey=${PK}`)
      expect(checkLegStep(s)).toEqual([])
      return s
    }
    expect(await status([TX('completed', { cryptoTransactionId: '0xhash' })])).toMatchObject({
      state: 'COMPLETED', status: 'succeeded', txHash: '0xhash', output: { value: '94.55', asset: { chain: 'eip155:8453' } },
    })
    expect(await status(TX('failed'))).toMatchObject({ state: 'FAILED', status: 'failed', error: { code: 'PAYMENT_FAILED' } })
    expect(await status([TX('failed'), TX('pending')])).toMatchObject({ state: 'PROCESSING', status: 'processing' })
    expect(await status([TX('waitingPayment')])).toMatchObject({ state: 'PAYMENT', status: 'awaiting_user' })
    expect(await status([TX('waitingAuthorization')])).toMatchObject({ state: 'PAYMENT', status: 'awaiting_user' })
    expect(await status({ message: 'Transaction not found' }, 404)).toMatchObject({ state: 'PAYMENT', status: 'awaiting_user', ref: 'ork_abc' })
    expect(await status([])).toMatchObject({ state: 'PAYMENT' })
    await expect(status({}, 500)).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
  })

  it('webhook: Moonpay-Signature-V2 (good, bad, missing, stale, no key) and event mapping', async () => {
    const a = moonpay(opts)
    const wctx = makeWebhookCtx()
    const body = JSON.stringify({ type: 'transaction_updated', data: TX('completed', { cryptoTransactionId: '0xhash' }), externalCustomerId: 'u_42' })
    const t = Math.floor(Date.now() / 1000)
    const sig = (ts: number, b = body) => `t=${ts},s=${createHmac('sha256', WK).update(`${ts}.${b}`).digest('hex')}`
    const req = (header?: string) => new Request('https://app.test/hook', { method: 'POST', body, headers: header ? { 'Moonpay-Signature-V2': header } : {} })
    expect(await a.webhook!.verify(req(sig(t)), body, wctx)).toBe(true)
    expect(await a.webhook!.verify(req(sig(t, 'tampered')), body, wctx)).toBe(false)
    expect(await a.webhook!.verify(req(), body, wctx)).toBe(false)
    expect(await a.webhook!.verify(req(`t=${t}`), body, wctx)).toBe(false)
    expect(await a.webhook!.verify(req(sig(t - 3600)), body, wctx)).toBe(false)
    expect(await moonpay({ ...opts, webhookKey: undefined }).webhook!.verify(req(sig(t)), body, wctx)).toBe(false)

    expect(await a.webhook!.parse(body, wctx)).toEqual([
      { ref: 'ork_abc', status: 'succeeded', txHash: '0xhash', output: { value: '94.55', asset: { ...BASE_USDC, symbol: 'USDC', decimals: 6 } } },
    ])
    const parse = (o: unknown) => a.webhook!.parse(JSON.stringify(o), wctx)
    expect(await parse({ type: 'transaction_failed', data: TX('failed') })).toMatchObject([{ status: 'failed' }])
    expect(await parse({ type: 'transaction_created', data: TX('waitingPayment') })).toEqual([{ ref: 'ork_abc', status: 'awaiting_user' }])
    expect(await parse({ type: 'transaction_updated', data: TX('pending') })).toMatchObject([{ status: 'processing' }])
    expect(await parse({ type: 'identity_check_updated', data: {} })).toEqual([])
    expect(await parse({ type: 'transaction_updated', data: TX('completed', { externalTransactionId: null }) })).toEqual([])
    expect(await a.webhook!.parse('not json', wctx)).toEqual([])
  })

  it('catalog: countries and US states from GET /v3/countries, cached for a day', async () => {
    const countries = [
      { alpha2: 'US', isBuyAllowed: true, states: [{ code: 'NY', isBuyAllowed: true }, { code: 'VI', isBuyAllowed: false }] },
      { alpha2: 'DE', isBuyAllowed: true },
      { alpha2: 'GB', isBuyAllowed: true },
      { alpha2: 'IN', isBuyAllowed: false },
    ]
    const { fetch, calls } = fakeFetch([{ match: '/v3/countries', reply: () => countries }])
    const a = moonpay(opts)
    const shared = memoryKV()
    const legs = await a.catalog!({ country: 'US', currency: 'USD', direction: 'deposit' }, { fetch, log: silentLog, shared })
    await a.catalog!({ country: 'US', currency: 'USD', direction: 'deposit' }, { fetch, log: silentLog, shared })
    expect(calls).toHaveLength(1)
    const card = legs.find((l) => l.id === 'card')!
    expect(card.regions).toEqual({ allow: ['US', 'DE', 'GB'], deny: ['US-VI'] })
    expect(legs.find((l) => l.id === 'sepa')!.regions.allow).toEqual(['DE'])
    // No allowed country for PIX, Interac: dropped
    expect(legs.map((l) => l.id)).not.toContain('pix')
    expect(legs.map((l) => l.id)).not.toContain('interac')
    for (const l of legs) expect(checkAdapterShape({ ...a, legs: [l] })).toEqual([])
  })

  it('catalog: a failed or empty countries call throws (the server keeps the static legs)', async () => {
    const a = moonpay(opts)
    const bad = fakeFetch([{ match: '/v3/countries', status: 500, reply: () => ({}) }])
    await expect(a.catalog!({ currency: 'USD', direction: 'deposit' }, { fetch: bad.fetch, log: silentLog, shared: memoryKV() })).rejects.toBeTruthy()
    const empty = fakeFetch([{ match: '/v3/countries', reply: () => [] }])
    await expect(a.catalog!({ currency: 'USD', direction: 'deposit' }, { fetch: empty.fetch, log: silentLog, shared: memoryKV() })).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
  })

  it('passes runAdapterConformance (card fixture, status, signed webhooks)', async () => {
    const { fetch } = fakeFetch([
      { match: '/buy_quote', reply: () => QUOTE },
      { match: '/v1/transactions/ext/', reply: () => [TX('completed', { cryptoTransactionId: '0x1' })] },
    ])
    const body = JSON.stringify({ type: 'transaction_updated', data: TX('completed') })
    const t = Math.floor(Date.now() / 1000)
    const good = `t=${t},s=${createHmac('sha256', WK).update(`${t}.${body}`).digest('hex')}`
    const report = await runAdapterConformance(moonpay(opts), {
      fetch,
      fixtures: [
        { leg: leg('card'), quote: { amountIn: usd('100') }, expect: { start: 'PAYMENT', status: 'COMPLETED' } },
        { leg: leg('sepa', BASE_USDC, 'EUR'), quote: { amountIn: { value: '100', asset: { kind: 'fiat', currency: 'EUR' } } }, ctx: makeCtx({ fetch, session: { country: 'DE' } }) },
      ],
      webhooks: [
        { name: 'signed', rawBody: body, request: () => new Request('https://x/h', { method: 'POST', body, headers: { 'moonpay-signature-v2': good } }), events: 1 },
        { name: 'unsigned', rawBody: body, request: () => new Request('https://x/h', { method: 'POST', body }), valid: false },
      ],
    })
    expect(report.problems).toEqual([])
    expect(report.quotes).toHaveLength(2)
  })

  // LIVE=1 with a real key in MOONPAY_PUBLISHABLE_KEY. A fake key proves nothing, so without one the test skips.
  // Test mode sells USDC only as `usdc` (Ethereum): usdc_base, usdc_arbitrum, usdc_optimism and usdc_polygon are not in test mode.
  it.runIf(process.env.LIVE === '1')('live: public countries and a real test-mode quote for usdc (MOONPAY_PUBLISHABLE_KEY)', async ({ skip }) => {
    const publishableKey = process.env.MOONPAY_PUBLISHABLE_KEY
    skip(!publishableKey, 'MOONPAY_PUBLISHABLE_KEY is not set. Set a pk_test_ key to quote against MoonPay test mode.')
    const a = moonpay({ ...opts, publishableKey: publishableKey!, env: publishableKey!.startsWith('pk_live_') ? 'production' : 'sandbox' })
    const legs = await a.catalog!({ country: 'US', currency: 'USD', direction: 'deposit' }, { fetch, log: silentLog, shared: memoryKV() })
    expect(legs.find((l) => l.id === 'card')!.regions.allow).toContain('US')
    const q = await a.quote({ leg: leg('card', ETH_USDC), amountIn: usd('100') }, makeCtx({ fetch, session: { country: 'US' } }))
    expect(checkLegQuote(q)).toEqual([])
    expect(q.data).toMatchObject({ currencyCode: 'usdc' })
    expect(q.output.asset).toMatchObject({ chain: 'eip155:1', token: USDC['eip155:1'] })
    expect(Number(q.output.value)).toBeGreaterThan(50)
    expect(Number(q.output.value)).toBeLessThan(110)
  }, 30_000)
})
