import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { checkAdapterShape, checkLegQuote, checkLegStep } from '@openrampkit/adapter'
import { USDC, isRegionAllowed, planPathways } from '@openrampkit/core'
import type { PathwayLeg } from '@openrampkit/core'
import { swapped, swappedMethodId } from './index.js'
import { fakeFetch, makeCtx, memoryKV, silentLog } from './testctx.js'

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
  it('passes the shape check; static legs are card, Apple Pay and Google Pay', () => {
    const a = swapped({ publicKey: PK, secretKey: SK })
    expect(checkAdapterShape(a)).toEqual([])
    expect(a.legs.map((l) => l.methods![0])).toEqual(['card', 'apple_pay', 'google_pay'])
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
    expect(await a.webhook!.parse(broadcast, { log: silentLog, shared: memoryKV(), fetch })).toEqual([
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
