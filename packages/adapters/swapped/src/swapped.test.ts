import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkAdapterShape, checkLegQuote, checkLegStep } from '@openrampkit/adapter'
import { USDC, isRegionAllowed, planPathways } from '@openrampkit/core'
import type { PathwayLeg } from '@openrampkit/core'
import { DEFAULT_DELIVER_ASSETS, swapped, swappedMethodId } from './index.js'
import { resultChannels, webhookBodyKey } from '@openrampkit/adapter'
import { createOpenRamp } from '@openrampkit/server'
import { fakeFetch, makeCtx, makeWebhookCtx, memoryKV, recordingLog, runAdapterConformance, silentLog } from '@openrampkit/adapter/testing'

const PK = 'pk_sandbox_rT9bW3sN6mJ8F5hP2cRqLvZ7SaD4XoY9'
const SK = 'sk_sandbox_gV4eT2aK5bP6C7nR3fWmQxY8FdZ9HhE2'
const BASE_USDC = { kind: 'crypto' as const, chain: 'eip155:8453', token: USDC['eip155:8453']! }

const m = (payment_group: string, currency: string[], extra: Record<string, unknown> = {}) => ({
  id: 1, name: payment_group, fee: 1.75, slug: `${payment_group}-extra`, currency, base_fee: { base_fee: 0.35 },
  disabled: false, min_amount: 7, max_amount: 100000, payment_group, img_url: '', ...extra,
})

// Shape of the live response: { success, data: { [country]: Method[] } }
const METHODS = {
  success: true,
  data: {
    US: [m('creditcard', ['USD', 'EUR']), m('apple-pay', ['USD']), m('google-pay', ['USD'])],
    VN: [
      m('vietqr', ['VND'], { fee: 1.9, max_amount: 3500 }),
      m('momo', ['VND'], { fee: 2, max_amount: 3500 }),
      m('zalo', ['VND'], { disabled: true }),
      m('creditcard', ['USD', 'VND']),
    ],
    DE: [m('bank-transfer', ['EUR'], { max_amount: 1000000 }), m('creditcard', ['EUR'])],
  },
}

const PRICING = {
  success: true,
  data: {
    crypto_amount: 95.93, crypto_currency: 'USDC_BASE', crypto_unit_price: 1.02, network_fee: 0.01, network_fee_local: 0.02,
    fiat_amount_incl_fees: 87.97, fiat_amount_excl_fees: 86.06, fiat_amount_incl_fees_local: 100, fiat_amount_excl_fees_local: 97.84,
    fiat_currency: 'USD', markup_fiat_value: 0, processing_fee: 2.16, payment_method: 'creditcard-extra', payment_group: 'creditcard',
  },
}

const cardLeg: PathwayLeg = {
  adapterId: 'swapped',
  legId: 'creditcard',
  from: { asset: { kind: 'fiat', currency: 'USD' }, location: { kind: 'user_account' } },
  to: { asset: BASE_USDC, location: { kind: 'address', address: 'deposit' } },
}

describe('swapped adapter', () => {
  it('passes the shape check; static buy legs are card, Apple Pay and Google Pay', () => {
    const a = swapped({ publicKey: PK, secretKey: SK })
    expect(checkAdapterShape(a)).toEqual([])
    expect(a.legs.filter((l) => l.kind === 'fiat_onramp').map((l) => l.methods![0])).toEqual(['card', 'apple_pay', 'google_pay'])
    expect(isRegionAllowed(a.legs[0]!.regions, 'US', 'US-TX')).toBe(false)
    expect(isRegionAllowed(a.legs[0]!.regions, 'US', 'US-CA')).toBe(true)
    expect(swappedMethodId('vietqr')).toBe('vietqr')
    expect(swappedMethodId('something-new')).toBe('something-new')
  })

  it('catalog: one leg per payment_group for the user currency, skips disabled, caches 1 h', async () => {
    const { fetch, calls } = fakeFetch([{ match: '/get_payment_methods', reply: () => METHODS }])
    const a = swapped({ publicKey: PK, secretKey: SK })
    const shared = memoryKV()
    const vn = await a.catalog!({ country: 'VN', currency: 'VND', direction: 'deposit' }, { fetch, log: silentLog, shared })
    expect(vn.map((l) => [l.id, l.methods])).toEqual([
      ['vietqr', ['vietqr']],
      ['momo', ['momo']],
      ['creditcard', ['card']],
    ])
    expect(vn[0]!.limits).toEqual({ min: '7', max: '3500', currency: 'EUR' })
    expect(vn[0]!.regions.allow).toEqual(['VN'])
    const de = await a.catalog!({ country: 'DE', currency: 'EUR', direction: 'deposit' }, { fetch, log: silentLog, shared })
    expect(de.map((l) => l.methods![0])).toEqual(['bank_transfer', 'card'])
    expect(calls.filter((c) => c.url.includes('get_payment_methods'))).toHaveLength(1)
    expect(calls[0]!.url).toContain(`apiKey=${PK}`)
    for (const l of [...vn, ...de]) expect(checkAdapterShape({ ...a, legs: [l] })).toEqual([])

    // the planner turns catalog legs into a two-leg pathway through a bridge
    const plan = planPathways({
      direction: 'deposit',
      destination: { type: 'crypto', chain: 'eip155:143', token: '0x00000000000000000000000000000000000000c0', address: '0x000000000000000000000000000000000000beef' },
      user: { country: 'VN' },
      legs: [
        ...vn.map((spec) => ({ adapterId: 'swapped', provider: 'Swapped', spec })),
        {
          adapterId: 'relay', provider: 'Relay',
          spec: {
            id: 'bridge', kind: 'bridge_swap', from: { asset: { kind: 'crypto', chains: { 'eip155:8453': [BASE_USDC.token] } }, location: ['address'] },
            to: { asset: { kind: 'crypto', chains: '*' }, location: ['address'] }, regions: { allow: ['*'], deny: [] }, eta: { min: 1, max: 2 }, surfaces: ['DEPOSIT_ADDRESS'],
          },
        },
      ],
    })
    expect(plan.methods[0]!.method).toBe('vietqr')
    expect(plan.pathways[0]!.id).toBe('vietqr:swapped.vietqr>relay.bridge@eip155:8453')
  })

  it('quote: prices through POST /merchant/pricing and maps fees', async () => {
    const { fetch, calls } = fakeFetch([{ method: 'POST', match: '/api/v1/merchant/pricing', reply: () => PRICING }])
    const a = swapped({ publicKey: PK, secretKey: SK, markup: 1 })
    const ctx = makeCtx({ fetch })
    const q = await a.quote({ leg: cardLeg, amountIn: { amount: '100', asset: { kind: 'fiat', currency: 'USD' } } }, ctx)
    expect(checkLegQuote(q)).toEqual([])
    expect(q.output).toEqual({ amount: '95.93', asset: { ...BASE_USDC, symbol: 'USDC', decimals: 6 } })
    expect(q.fees).toEqual([
      { kind: 'provider', label: 'Swapped fee', amount: '2.16', currency: 'USD' },
      { kind: 'network', label: 'Network fee', amount: '0.02', currency: 'USD' },
    ])
    expect(calls[0]!.url).toBe('https://widget.swapped.com/api/v1/merchant/pricing')
    expect(calls[0]!.body).toEqual({ api_key: PK, payment_method: 'creditcard', fiat_currency: 'USD', fiat_amount: 100, crypto_currency: 'USDC_BASE', region: 'US', markup: 1 })
  })

  it('quote: a failed pricing call is PROVIDER_UNAVAILABLE, an unsuccessful one is NO_QUOTES', async () => {
    const bad = fakeFetch([{ method: 'POST', match: '/pricing', status: 500, reply: () => ({}) }])
    const a = swapped({ publicKey: PK, secretKey: SK })
    await expect(a.quote({ leg: cardLeg, amountIn: { amount: '1', asset: { kind: 'fiat', currency: 'USD' } } }, makeCtx({ fetch: bad.fetch }))).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
    const no = fakeFetch([{ method: 'POST', match: '/pricing', reply: () => ({ success: false, message: 'Amount too low' }) }])
    await expect(a.quote({ leg: cardLeg, amountIn: { amount: '1', asset: { kind: 'fiat', currency: 'USD' } } }, makeCtx({ fetch: no.fetch }))).rejects.toMatchObject({ error: { code: 'NO_QUOTES', message: 'Swapped: Amount too low' } })
  })

  it('regional groups: BLIK (PL), SPEI (MX) and mobile money (KE) from the catalog, planned, quoted and started', async () => {
    expect(swappedMethodId('blik')).toBe('blik')
    expect(swappedMethodId('spei')).toBe('spei')
    expect(swappedMethodId('mobile-money')).toBe('mobile_money')
    expect(swappedMethodId('astropay')).toBe('astropay')
    const live = {
      success: true,
      data: {
        PL: [m('blik', ['PLN']), m('creditcard', ['PLN', 'EUR'])],
        MX: [m('spei', ['MXN']), m('creditcard', ['MXN'])],
        KE: [m('mobile-money', ['KES']), m('creditcard', ['KES'])],
      },
    }
    const cases: Array<[string, string, string, string]> = [
      ['PL', 'PLN', 'blik', 'blik'],
      ['MX', 'MXN', 'spei', 'spei'],
      ['KE', 'KES', 'mobile-money', 'mobile_money'],
    ]
    for (const [country, currency, group, method] of cases) {
      const { fetch, calls } = fakeFetch([
        { match: '/get_payment_methods', reply: () => live },
        { method: 'POST', match: '/pricing', reply: () => ({ ...PRICING, data: { ...PRICING.data, fiat_currency: currency, payment_group: group } }) },
      ])
      const a = swapped({ publicKey: PK, secretKey: SK })
      const legs = await a.catalog!({ country, currency, direction: 'deposit' }, { fetch, log: silentLog, shared: memoryKV() })
      expect(legs.map((l) => l.methods![0])).toEqual([method, 'card'])
      const plan = planPathways({
        direction: 'deposit',
        destination: { type: 'crypto', chain: 'eip155:8453', token: BASE_USDC.token, address: '0x000000000000000000000000000000000000beef' },
        user: { country },
        legs: legs.map((spec) => ({ adapterId: 'swapped', provider: 'Swapped', spec })),
      })
      expect(plan.currency).toBe(currency)
      expect(plan.methods[0]).toMatchObject({ method, group: 'recommended', providers: ['Swapped'] })
      const leg: PathwayLeg = { ...cardLeg, legId: group, from: { asset: { kind: 'fiat', currency }, location: { kind: 'user_account' } } }
      const ctx = makeCtx({ fetch, session: { country } })
      const q = await a.quote({ leg, amountIn: { amount: '100', asset: { kind: 'fiat', currency } } }, ctx)
      expect(calls.find((c) => c.url.includes('/pricing'))!.body).toMatchObject({ payment_method: group, fiat_currency: currency, region: country })
      const step = await a.start({ leg, quote: q, deliverTo: { address: '0xd16e0c839b6f652970c5d4d035d9cfcff5c185af' } }, ctx)
      expect(new URL((step.surface as { url: string }).url).searchParams.get('method')).toBe(group)
    }
  })

  it('start: signed IFRAME URL (signature over the "?" query string, appended last)', async () => {
    const { fetch } = fakeFetch([{ method: 'POST', match: '/pricing', reply: () => PRICING }])
    const a = swapped({ publicKey: PK, secretKey: SK })
    const ctx = makeCtx({ fetch, session: { email: 'a@b.co', country: 'US', userId: 'u_42' } })
    const q = await a.quote({ leg: cardLeg, amountIn: { amount: '100', asset: { kind: 'fiat', currency: 'USD' } } }, ctx)
    const step = await a.start({ leg: cardLeg, quote: q, deliverTo: { address: '0xd16e0c839b6f652970c5d4d035d9cfcff5c185af' } }, ctx)
    expect(checkLegStep(step)).toEqual([])
    expect(step.state).toBe('PAYMENT')
    expect(step.status).toBe('awaiting_user')
    expect(step.ref).toMatch(/^u_42\.[0-9a-f]{12}$/)
    const s = step.surface!
    if (s.kind !== 'IFRAME') throw new Error('expected IFRAME')
    expect(s.origin).toBe('https://widget.swapped.com')
    expect(s.allow).toBe('accelerometer; autoplay; camera; encrypted-media; gyroscope; payment; clipboard-read; clipboard-write')
    expect(s.height).toBe(560)

    const [unsigned, sigPart] = s.url.split('&signature=')
    const url = new URL(unsigned!)
    // the signature, recomputed like the Swapped docs sample (node:crypto, only in tests)
    const expected = createHmac('sha256', SK).update(url.search).digest('base64')
    expect(decodeURIComponent(sigPart!)).toBe(expected)
    const p = url.searchParams
    expect(p.get('apiKey')).toBe(PK)
    expect(p.get('currencyCode')).toBe('USDC_BASE')
    expect(p.get('walletAddress')).toBe('0xd16e0c839b6f652970c5d4d035d9cfcff5c185af')
    expect(p.get('method')).toBe('creditcard')
    expect(p.get('baseCurrencyCode')).toBe('USD')
    expect(p.get('baseCurrencyAmount')).toBe('100.00')
    expect(p.get('lockBaseCurrency')).toBe('true')
    expect(p.get('externalCustomerId')).toBe(step.ref)
    expect(p.get('email')).toBe('a@b.co')
    expect(p.get('baseCountry')).toBe('US')
    expect(p.get('redirectUrl')).toBe('https://app.test/api/openramp/return')
    expect(p.get('responseUrl')).toBe('https://app.test/api/openramp/webhooks/test')
  })

  it('webhook: verifies the signature header and maps order statuses', async () => {
    const a = swapped({ publicKey: PK, secretKey: SK })
    const sign = (body: string) => createHmac('sha256', SK).update(body).digest('base64')
    const req = (body: string, sig?: string) => new Request('https://app.test/api/openramp/webhooks/swapped', { method: 'POST', body, headers: sig ? { signature: sig } : {} })

    const broadcast = JSON.stringify({
      order_id: '9fcc', order_crypto_amount: 95.93, order_crypto: 'USDC_BASE', order_status: 'order_broadcasted', transaction_id: '0xhash',
      order_crypto_address: '0xd16e', external_customer_id: 'u_42.abc', network: 'base',
    })
    expect(await a.webhook!.verify(req(broadcast, sign(broadcast)), broadcast, { log: silentLog, shared: memoryKV(), fetch })).toBe(true)
    expect(await a.webhook!.verify(req(broadcast, sign('tampered')), broadcast, { log: silentLog, shared: memoryKV(), fetch })).toBe(false)
    expect(await a.webhook!.verify(req(broadcast), broadcast, { log: silentLog, shared: memoryKV(), fetch })).toBe(false)
    // An empty key must not accept a signature made with an empty key.
    const unset = swapped({ publicKey: PK, secretKey: '' })
    const emptySig = createHmac('sha256', '').update(broadcast).digest('base64')
    expect(await unset.webhook!.verify(req(broadcast, emptySig), broadcast, { log: silentLog, shared: memoryKV(), fetch })).toBe(false)
    expect(await a.webhook!.parse(broadcast, { log: silentLog, shared: memoryKV(), fetch })).toMatchObject([
      { ref: 'u_42.abc', status: 'succeeded', txHash: '0xhash', output: { amount: '95.93', asset: { ...BASE_USDC, symbol: 'USDC', decimals: 6 } } },
    ])
    const parse = (o: object) => a.webhook!.parse(JSON.stringify(o), { log: silentLog, shared: memoryKV(), fetch })
    expect(await parse({ order_status: 'payment_pending', external_customer_id: 'u_42.abc' })).toEqual([])
    expect(await parse({ order_status: 'order_completed', external_customer_id: 'u_42.abc', order_crypto: 'USDC_BASE', order_crypto_amount: '10' })).toMatchObject([{ status: 'processing' }])
    expect(await parse({ order_status: 'order_cancelled', external_customer_id: 'u_42.abc' })).toMatchObject([{ status: 'failed', error: { code: 'PAYMENT_FAILED' } }])
    expect(await parse({ order_status: 'order_broadcasted' })).toEqual([])
  })

  it('sandbox env uses sandbox.swapped.com', async () => {
    const { fetch, calls } = fakeFetch([{ match: '/get_payment_methods', reply: () => METHODS }])
    const a = swapped({ publicKey: PK, secretKey: SK, env: 'sandbox' })
    await a.catalog!({ country: 'US', currency: 'USD', direction: 'deposit' }, { fetch, log: silentLog, shared: memoryKV() })
    expect(calls[0]!.url.startsWith('https://sandbox.swapped.com/api/v1/merchant/get_payment_methods')).toBe(true)
  })
})


const usd = (amount: string) => ({ amount, asset: { kind: 'fiat' as const, currency: 'USD' } })
const signB64 = (body: string) => createHmac('sha256', SK).update(body).digest('base64')
const hookReq = (body: string, headers: Record<string, string> = {}) => new Request('https://app.test/api/openramp/webhooks/swapped', { method: 'POST', body, headers })

describe('swapped conformance', () => {
  it('card leg and signed webhooks pass runAdapterConformance', async () => {
    const { fetch } = fakeFetch([{ method: 'POST', match: '/pricing', reply: () => PRICING }])
    const body = JSON.stringify({ order_status: 'order_broadcasted', external_customer_id: 'u.1', order_crypto: 'USDC_BASE', order_crypto_amount: 10, transaction_id: '0x1' })
    const report = await runAdapterConformance(swapped({ publicKey: PK, secretKey: SK }), {
      fetch,
      fixtures: [{ leg: cardLeg, quote: { amountIn: usd('100') }, expect: { start: 'PAYMENT' } }],
      webhooks: [
        { name: 'signed', rawBody: body, request: () => hookReq(body, { signature: signB64(body) }), events: 1 },
        { name: 'bad signature', rawBody: body, request: () => hookReq(body, { signature: signB64(`${body} `) }), valid: false },
        { name: 'no header', rawBody: body, request: () => hookReq(body), valid: false },
      ],
    })
    expect(report.problems).toEqual([])
  })
})

describe('swapped errors and edge cases', () => {
  afterEach(() => vi.useRealTimers())

  it('quote: 429, 4xx with a message, 5xx and timeouts', async () => {
    const a = swapped({ publicKey: PK, secretKey: SK })
    const q = (fetch: typeof globalThis.fetch) => a.quote({ leg: cardLeg, amountIn: usd('5') }, makeCtx({ fetch }))
    await expect(q(fakeFetch([{ method: 'POST', match: '/pricing', status: 429, reply: () => ({}) }]).fetch)).rejects.toMatchObject({ status: 429, error: { code: 'RATE_LIMITED' } })
    await expect(q(fakeFetch([{ method: 'POST', match: '/pricing', status: 400, reply: () => ({ message: 'Unsupported region' }) }]).fetch)).rejects.toMatchObject({
      error: { code: 'NO_QUOTES', message: 'Swapped: Unsupported region' },
    })
    await expect(q(fakeFetch([{ method: 'POST', match: '/pricing', status: 403, reply: () => ({ message: 'bad key' }) }]).fetch)).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
    await expect(q(fakeFetch([{ method: 'POST', match: '/pricing', reply: () => ({ success: true }) }]).fetch)).rejects.toMatchObject({ error: { code: 'NO_QUOTES', message: 'Swapped could not price this amount.' } })
    vi.useFakeTimers()
    const p = q(fakeFetch([{ method: 'POST', match: '/pricing', hang: true }]).fetch).catch((e) => e)
    await vi.advanceTimersByTimeAsync(8001)
    expect(await p).toMatchObject({ status: 504 })
  })

  it('quote: exact crypto output, markup fee, local-method ETA, default country and deliver asset', async () => {
    const { fetch, calls } = fakeFetch([
      { method: 'POST', match: '/pricing', reply: () => ({ success: true, data: { ...PRICING.data, crypto_amount: 50, crypto_currency: 'USDC_ARBITRUM', fiat_amount_incl_fees_local: 52.5, markup_fiat_value: 0.25, processing_fee: 0, network_fee_local: 0 } }) },
    ])
    const a = swapped({ publicKey: PK, secretKey: SK, defaultCountry: 'vn', markup: 0.5 })
    const arb = { kind: 'crypto' as const, chain: 'eip155:42161', token: USDC['eip155:42161']!.toUpperCase().replace('0X', '0x') }
    const leg: PathwayLeg = { ...cardLeg, legId: 'vietqr', to: { asset: arb, location: { kind: 'address', address: 'x' } } }
    const q = await a.quote({ leg, amountOut: { amount: '50', asset: arb } }, makeCtx({ fetch, session: { country: undefined } }))
    expect(checkLegQuote(q)).toEqual([])
    expect(calls[0]!.body).toEqual({ api_key: PK, payment_method: 'vietqr', fiat_currency: 'USD', crypto_currency: 'USDC_ARBITRUM', crypto_amount: 50, region: 'VN', markup: 0.5 })
    expect(q.input.amount).toBe('52.5')
    expect(q.output.asset).toMatchObject({ chain: 'eip155:42161', decimals: 6 })
    expect(q.fees).toEqual([{ kind: 'app', label: 'App fee', amount: '0.25', currency: 'USD' }])
    expect(q.eta).toEqual({ min: 120, max: 1800 })
    const ap = await a.quote({ leg: { ...cardLeg, legId: 'apple-pay' }, amountIn: usd('10') }, makeCtx({ fetch }))
    expect(ap.eta).toEqual({ min: 120, max: 900 })
    // a token Swapped does not deliver: no quote (never the first deliver asset instead), and no Swapped call
    await expect(a.quote({ leg: { ...cardLeg, to: { asset: { kind: 'crypto', chain: 'eip155:143', token: '0x1' }, location: { kind: 'address', address: 'x' } } }, amountIn: usd('10') }, makeCtx({ fetch }))).rejects.toMatchObject({
      status: 422,
      error: { code: 'NO_QUOTES', message: 'Swapped does not deliver 0x1 on eip155:143.' },
    })
    expect(calls).toHaveLength(2)
    // Swapped needs a fiat amount
    await expect(a.quote({ leg: { ...cardLeg, from: { asset: BASE_USDC, location: { kind: 'user_wallet' } } }, amountIn: { amount: '1', asset: BASE_USDC } }, makeCtx({ fetch }))).rejects.toMatchObject({
      error: { code: 'BAD_REQUEST' },
    })
  })

  it('custom deliver assets: non-EVM tokens match exactly; the first one is the default', async () => {
    const SOL = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
    const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
    const a = swapped({ publicKey: PK, secretKey: SK, deliverAssets: [{ chain: SOL, token: mint, currencyCode: 'USDC_SOLANA' }] })
    expect(a.legs[0]!.to.asset).toEqual({ kind: 'crypto', chains: { [SOL]: [mint] } })
    const { fetch, calls } = fakeFetch([{ method: 'POST', match: '/pricing', reply: () => PRICING }])
    const q = await a.quote({ leg: { ...cardLeg, to: { asset: { kind: 'crypto', chain: SOL, token: mint }, location: { kind: 'address', address: 'x' } } }, amountIn: usd('10') }, makeCtx({ fetch }))
    expect((calls[0]!.body as { crypto_currency: string }).crypto_currency).toBe('USDC_SOLANA')
    expect(q.output.asset).toEqual({ kind: 'crypto', chain: SOL, token: mint })
    expect(q.output.amount).toBe('95.93')
    expect(swapped({ publicKey: PK, secretKey: SK, deliverAssets: [] }).legs[0]!.to.asset).toMatchObject({ chains: { 'eip155:8453': [DEFAULT_DELIVER_ASSETS[0]!.token] } })
  })

  it('start: needs a wallet address; falls back to the leg and target when quote data is missing', async () => {
    const a = swapped({ publicKey: PK, secretKey: SK, markup: 1 })
    const quote = { adapterId: 'swapped', legId: 'creditcard', input: usd('20'), output: { amount: '19', asset: BASE_USDC }, fees: [], eta: { min: 1, max: 2 } }
    await expect(a.start({ leg: cardLeg, quote }, makeCtx({ fetch: fakeFetch([]).fetch, destination: { type: 'merchant', merchantId: 'm', currency: 'USD' } as never }))).rejects.toMatchObject({
      error: { code: 'BAD_REQUEST', message: 'Swapped needs a wallet address to deliver to.' },
    })
    const ctx = makeCtx({ fetch: fakeFetch([]).fetch, session: { email: undefined, country: undefined } })
    const step = await a.start({ leg: cardLeg, quote }, ctx)
    const url = new URL((step.surface as { url: string }).url)
    expect(url.searchParams.get('currencyCode')).toBe('USDC_BASE')
    expect(url.searchParams.get('method')).toBe('creditcard')
    expect(url.searchParams.get('walletAddress')).toBe('0x000000000000000000000000000000000000beef')
    expect(url.searchParams.get('markup')).toBe('1')
    expect(url.searchParams.has('email')).toBe(false)
    expect(url.searchParams.has('baseCountry')).toBe(false)
    expect(await ctx.store.get(`o:${step.ref}`)).toMatchObject({ currencyCode: 'USDC_BASE' })
    // a crypto-denominated quote input uses the currency stored in quote data
    const s2 = await a.start({ leg: cardLeg, quote: { ...quote, input: { amount: '20', asset: BASE_USDC }, data: { fiat: 'EUR' } } }, ctx)
    expect(new URL((s2.surface as { url: string }).url).searchParams.get('baseCurrencyCode')).toBe('EUR')
  })

  it('catalog: refused or empty answers throw and are not cached; errors throw; flat lists and all countries', async () => {
    const a = swapped({ publicKey: PK, secretKey: SK })
    const shared = memoryKV()
    const cat = (fetch: typeof globalThis.fetch, country?: string) =>
      a.catalog!({ ...(country ? { country } : {}), currency: 'USD', direction: 'deposit' }, { fetch, log: silentLog, shared })
    await expect(cat(fakeFetch([{ match: '/get_payment_methods', reply: () => ({ success: false, message: 'Invalid apiKey' }) }]).fetch, 'US')).rejects.toMatchObject({
      error: { code: 'PROVIDER_UNAVAILABLE', message: 'Swapped returned no payment methods: Invalid apiKey.' },
    })
    await expect(cat(fakeFetch([{ match: '/get_payment_methods', reply: () => ({ success: true }) }]).fetch, 'US')).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
    await expect(cat(fakeFetch([{ match: '/get_payment_methods', status: 500, reply: () => ({}) }]).fetch, 'US')).rejects.toMatchObject({ status: 500 })
    expect(shared.data.size).toBe(0)
    // flat list (docs shape): regions allow everyone except US-TX
    const flat = await cat(fakeFetch([{ match: '/get_payment_methods', reply: () => ({ success: true, data: [m('creditcard', ['usd'], { min_amount: undefined, max_amount: undefined }), m('sepa', ['EUR'])] }) }]).fetch)
    expect(flat).toHaveLength(1)
    expect(flat[0]!.regions).toEqual({ allow: ['*'], deny: ['US-TX'] })
    expect(flat[0]!.limits).toEqual({ currency: 'EUR' })
    // all countries, min/max merged across countries
    const all = await a.catalog!({ currency: 'USD', direction: 'deposit' }, { fetch: fakeFetch([{ match: '/get_payment_methods', reply: () => METHODS }]).fetch, log: silentLog, shared: memoryKV() })
    const card = all.find((l) => l.id === 'creditcard')!
    expect(card.regions.allow).toEqual(['US', 'VN'])
    expect(card.limits).toEqual({ min: '7', max: '100000', currency: 'EUR' })
    expect(isRegionAllowed(card.regions, 'US', 'US-TX')).toBe(false)
    const mixed = await a.catalog!({ currency: 'USD', direction: 'deposit' }, {
      fetch: fakeFetch([{ match: '/get_payment_methods', reply: () => ({ success: true, data: { US: [m('creditcard', ['USD'], { min_amount: 10, max_amount: 500 })], GB: [m('creditcard', ['USD'], { min_amount: 5, max_amount: 900 })], XX: [{ ...m('x', ['USD']), currency: undefined }] } }) }]).fetch,
      log: silentLog,
      shared: memoryKV(),
    })
    expect(mixed.map((l) => [l.id, l.limits])).toEqual([['creditcard', { min: '5', max: '900', currency: 'EUR' }]])
  })

  it('webhook parse: non-JSON, no customer id, unknown asset, completed without amount', async () => {
    const a = swapped({ publicKey: PK, secretKey: SK })
    const log = recordingLog()
    const ctx = makeWebhookCtx({ log })
    expect(await a.webhook!.parse('not json', ctx)).toEqual([])
    expect(await a.webhook!.parse(JSON.stringify({ order_id: 'o1', order_status: 'order_broadcasted', external_customer_id: null }), ctx)).toEqual([])
    expect(log.warnings).toEqual(['swapped: webhook body is not JSON', 'swapped: notification without external_customer_id'])
    expect(await a.webhook!.parse(JSON.stringify({ order_status: 'order_broadcasted', external_customer_id: 'u.1', order_crypto: 'BTC', order_crypto_amount: 1 }), ctx)).toMatchObject([{ ref: 'u.1', status: 'succeeded' }])
    expect(await a.webhook!.parse(JSON.stringify({ order_status: 'order_completed', external_customer_id: 'u.1', order_crypto: 'USDC_BASE' }), ctx)).toMatchObject([{ ref: 'u.1', status: 'processing' }])
    expect(await a.webhook!.parse(JSON.stringify({ order_status: 'something_new', external_customer_id: 'u.1' }), ctx)).toEqual([])
    expect(log.warnings).toHaveLength(2)
    expect(await a.webhook!.verify(hookReq('{}', { signature: ` ${signB64('{}')} ` }), '{}', ctx)).toBe(true)
  })

  it('health: ok, refused, down', async () => {
    const a = swapped({ publicKey: PK, secretKey: SK, apiUrl: 'https://api.swapped.test/' })
    const ok = fakeFetch([{ match: '/get_payment_methods', reply: () => ({ success: true }) }])
    expect(await a.health!({ fetch: ok.fetch, log: silentLog })).toEqual({ ok: true })
    expect(ok.calls[0]!.url).toBe(`https://api.swapped.test/api/v1/merchant/get_payment_methods?apiKey=${PK}`)
    expect(await a.health!({ fetch: fakeFetch([{ match: '/', reply: () => ({ success: false }) }]).fetch, log: silentLog })).toEqual({ ok: false })
    const down = await a.health!({ fetch: fakeFetch([{ match: '/', status: 502, reply: () => ({}) }]).fetch, log: silentLog })
    expect(down.ok).toBe(false)
    expect(down.detail).toMatch(/HTTP 502/)
  })
})

describe('swapped status polling (statusPolling: true)', () => {
  const orders = (list: unknown[]) => ({ data: { orders: list } })

  it('is off by default; when on, the adapter has status() (polling comes from it, not from a capability)', () => {
    expect(resultChannels(swapped({ publicKey: PK, secretKey: SK }))).toEqual({ polling: false, webhooks: true })
    const a = swapped({ publicKey: PK, secretKey: SK, statusPolling: true })
    expect(a.status).toBeTypeOf('function')
    expect(resultChannels(a)).toEqual({ polling: true, webhooks: true })
    expect(a.legs[0]!.capabilities).toBeUndefined()
  })

  it('signs get_transactions and maps every order status', async () => {
    let list: unknown[] = []
    const { fetch, calls } = fakeFetch([
      { method: 'POST', match: '/pricing', reply: () => PRICING },
      { method: 'POST', match: '/get_transactions', reply: () => orders(list) },
    ])
    const a = swapped({ publicKey: PK, secretKey: SK, statusPolling: true })
    const ctx = makeCtx({ fetch })
    const step = await a.start({ leg: cardLeg, quote: await a.quote({ leg: cardLeg, amountIn: usd('100') }, ctx) }, ctx)
    const ref = step.ref!
    const status = () => a.status!({ leg: cardLeg, ref }, ctx)

    expect(await status()).toMatchObject({ state: 'PAYMENT', status: 'awaiting_user' })
    const call = calls.at(-1)!
    const { signature, ...unsigned } = call.body as Record<string, unknown>
    expect(signature).toBe(signB64(JSON.stringify(unsigned)))
    expect(unsigned).toMatchObject({ apiKey: PK, limit: 100 })
    expect(Date.parse(String(unsigned.start_date))).toBeLessThan(Date.now() - 59_000)

    list = [{ external_customer_id: 'someone-else', order_status: 'order_broadcasted' }, { external_customer_id: ref, order_status: 'payment_pending' }]
    expect(await status()).toMatchObject({ state: 'PAYMENT', status: 'awaiting_user' })
    list = [{ external_customer_id: ref, order_status: 'order_completed', order_crypto: 'USDC_BASE', order_crypto_amount: '95.93' }]
    expect(await status()).toMatchObject({ state: 'PROCESSING', status: 'processing' })
    list = [{ external_customer_id: ref, order_status: 'order_completed', transaction_id: '0xtx', order_crypto: 'USDC_BASE', order_crypto_amount: 95.93 }]
    const done = await status()
    expect(done).toMatchObject({ state: 'COMPLETED', status: 'succeeded', txHash: '0xtx', output: { amount: '95.93' } })
    expect(checkLegStep(done)).toEqual([])
    list = [{ external_customer_id: ref, order_status: 'order_cancelled' }]
    expect(await status()).toMatchObject({ state: 'FAILED', status: 'failed', error: { code: 'PAYMENT_FAILED' } })
  })

  it('works without a stored order and maps HTTP errors', async () => {
    const a = swapped({ publicKey: PK, secretKey: SK, statusPolling: true })
    const ok = fakeFetch([{ method: 'POST', match: '/get_transactions', reply: () => ({}) }])
    expect(await a.status!({ leg: cardLeg, ref: 'u.x' }, makeCtx({ fetch: ok.fetch }))).toMatchObject({ state: 'PAYMENT' })
    expect((ok.calls[0]!.body as Record<string, unknown>).start_date).toBeUndefined()
    const bad = fakeFetch([{ method: 'POST', match: '/get_transactions', status: 401, reply: () => ({ message: 'bad signature' }) }])
    await expect(a.status!({ leg: cardLeg, ref: 'u.x' }, makeCtx({ fetch: bad.fetch }))).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
  })
})

describe('swapped live API', () => {
  it.runIf(process.env.LIVE === '1')('catalog and pricing (public endpoints)', async () => {
    const a = swapped({ publicKey: PK, secretKey: SK })
    const ctx = makeCtx({ fetch: globalThis.fetch, session: { country: 'US' } })
    const legs = await a.catalog!({ country: 'US', currency: 'USD', direction: 'deposit' }, ctx)
    expect(legs.map((l) => l.methods![0])).toContain('card')
    const q = await a.quote({ leg: cardLeg, amountIn: { amount: '100', asset: { kind: 'fiat', currency: 'USD' } } }, ctx)
    expect(checkLegQuote(q)).toEqual([])
    expect(Number(q.output.amount)).toBeGreaterThan(80)
  }, 30_000)
})

describe('swapped webhook replay protection', () => {
  const sign = (body: string) => createHmac('sha256', SK).update(body).digest('base64')
  const ramp = () => createOpenRamp({ secret: 's'.repeat(40), baseUrl: 'https://app.test/api', adapters: [swapped({ publicKey: PK, secretKey: SK })], logger: silentLog })
  const post = (r: ReturnType<typeof ramp>, body: string) =>
    r.handle(new Request('https://app.test/api/webhooks/swapped', { method: 'POST', headers: { signature: sign(body) }, body }))

  it('gives the body hash as the replay key and as the event id', async () => {
    const a = swapped({ publicKey: PK, secretKey: SK })
    const body = JSON.stringify({ order_status: 'order_cancelled', external_customer_id: 'u_42.abc' })
    const key = await a.webhook!.replayKey!(new Request('https://app.test/w', { method: 'POST' }), body, makeWebhookCtx())
    expect(key).toBe(await webhookBodyKey(body))
    expect((await a.webhook!.parse(body, makeWebhookCtx()))[0]!.eventId).toBe(key!.slice(0, 32))
  })

  it('ignores a replayed signed body (200, nothing applied), and lets a retry of an unapplied body through', async () => {
    const r = ramp()
    const body = JSON.stringify({ order_status: 'payment_pending', external_customer_id: 'u_42.abc' })
    expect(await (await post(r, body)).json()).toEqual({ received: true })
    const replay = await post(r, body)
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual({ received: true, duplicate: true })

    const unknown = JSON.stringify({ order_status: 'order_cancelled', external_customer_id: 'u_unknown.1' })
    expect((await post(r, unknown)).status).toBe(503)
    expect((await post(r, unknown)).status).toBe(503)
  })
})
