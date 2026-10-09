// Swapped sell (offramp) legs: catalog, estimate quote, signed /sell widget, webhooks that ask for funds.
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { checkLegQuote, checkLegStep } from '@openrampkit/adapter'
import { USDC, fromBaseUnits } from '@openrampkit/core'
import type { PathwayLeg } from '@openrampkit/core'
import { SWAPPED_PAYOUT_METHODS, swapped } from './index.js'
import { fakeFetch, makeCtx, makeWebhookCtx, memoryKV } from '@openrampkit/adapter/testing'

const PK = 'pk_test_sell'
const SK = 'sk_test_sell_secret'
const BASE_USDC = { kind: 'crypto' as const, chain: 'eip155:8453', token: USDC['eip155:8453']!, symbol: 'USDC', decimals: 6 }
const sellLeg = (slug: string, currency: string): PathwayLeg => ({
  adapterId: 'swapped',
  legId: `sell-${slug}`,
  from: { asset: BASE_USDC, location: { kind: 'user_wallet' } },
  to: { asset: { kind: 'fiat', currency }, location: { kind: 'user_account' } },
})

const pricing = (fiat: number) => ({
  success: true,
  data: { crypto_amount: fiat / 0.92, crypto_unit_price: 0.92, fiat_amount_incl_fees: fiat, fiat_amount_excl_fees: fiat * 0.98, fiat_amount_excl_fees_local: fiat * 0.98, fiat_currency: 'EUR', processing_fee: fiat * 0.02 },
})

describe('swapped sell legs', () => {
  const a = swapped({ publicKey: PK, secretKey: SK })

  it('declares static crypto_offramp legs for the documented payout methods', () => {
    const sells = a.legs.filter((l) => l.kind === 'crypto_offramp')
    expect(sells.map((l) => l.id)).toEqual(SWAPPED_PAYOUT_METHODS.map((m) => `sell-${m.slug}`))
    expect(sells.find((l) => l.id === 'sell-pix')).toMatchObject({ methods: ['pix'], regions: { allow: ['BR'] }, to: { asset: { kind: 'fiat', currencies: ['BRL'] } } })
    expect(sells.find((l) => l.id === 'sell-interac-extra')!.methods).toEqual(['interac'])
    expect(sells[0]!.from.location).toEqual(['user_wallet', 'address'])
  })

  it('withdraw catalog comes from the payout methods API, filtered by currency', async () => {
    const { fetch, calls } = fakeFetch([
      { match: 'sell/get_payout_methods', reply: () => ({ success: true, data: { DK: [{ slug: 'bank-transfer', currency: ['EUR', 'DKK', 'GBP'], disabled: false, min_amount: 7, max_amount: 1000000 }], BR: [{ slug: 'pix', currency: ['BRL'], disabled: false }] } }) },
    ])
    const ctx = makeWebhookCtx({ fetch, shared: memoryKV() })
    const legs = await a.catalog!({ country: 'DK', currency: 'EUR', direction: 'withdraw' }, ctx)
    expect(legs.map((l) => l.id)).toEqual(['sell-bank-transfer'])
    expect(legs[0]!.limits).toEqual({ min: '7', max: '1000000', currency: 'EUR' })
    await a.catalog!({ country: 'DK', currency: 'EUR', direction: 'withdraw' }, ctx)
    expect(calls).toHaveLength(1) // cached
    const failing = fakeFetch([{ match: 'sell/get_payout_methods', reply: () => ({ success: false }) }])
    await expect(a.catalog!({ currency: 'EUR', direction: 'withdraw' }, makeWebhookCtx({ fetch: failing.fetch }))).rejects.toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } })
  })

  it('quotes a crypto amount in two pricing calls (probe, then the estimated fiat amount)', async () => {
    const { fetch, calls } = fakeFetch([{ match: 'sell/pricing', reply: (c) => pricing((c.body as { fiat_amount: number }).fiat_amount) }])
    const q = await a.quote({ leg: sellLeg('bank-transfer', 'EUR'), amountIn: { value: '100', asset: BASE_USDC } }, makeCtx({ fetch }))
    expect(checkLegQuote(q)).toEqual([])
    expect(calls.map((c) => (c.body as { fiat_amount: number }).fiat_amount)).toEqual([100, 92])
    expect((calls[0]!.body as Record<string, unknown>)).toMatchObject({ api_key: PK, payout_method: 'bank-transfer', crypto_currency: 'USDC_BASE', fiat_currency: 'EUR' })
    expect(q.input).toEqual({ value: '100', asset: expect.objectContaining({ chain: 'eip155:8453' }) })
    expect(q.output).toEqual({ value: '90.16', asset: { kind: 'fiat', currency: 'EUR' } })
    expect(q.data).toMatchObject({ estimate: true, slug: 'bank-transfer' })
    expect(q.guarantee).toBe('estimate')
    expect(q.fees).toEqual([{ kind: 'provider', label: 'Swapped fee', amount: { value: '1.84', asset: { kind: 'fiat', currency: 'EUR' } }, included: true }])
    const bad = fakeFetch([{ match: 'sell/pricing', reply: () => ({ success: true, data: { crypto_amount: 0, fiat_amount_incl_fees: 0, fiat_amount_excl_fees: 0 } }) }])
    await expect(a.quote({ leg: sellLeg('bank-transfer', 'EUR'), amountIn: { value: '100', asset: BASE_USDC } }, makeCtx({ fetch: bad.fetch }))).rejects.toMatchObject({ error: { code: 'NO_QUOTES' } })
  })

  it('starts a signed /sell widget with userSendsFunds=false and the locked crypto amount', async () => {
    const { fetch } = fakeFetch([{ match: 'sell/pricing', reply: (c) => pricing((c.body as { fiat_amount: number }).fiat_amount) }])
    const ctx = makeCtx({ fetch, session: { country: 'DK', email: 'a@b.test' } })
    const q = await a.quote({ leg: sellLeg('bank-transfer', 'EUR'), amountIn: { value: '100', asset: BASE_USDC } }, ctx)
    const step = await a.start({ leg: sellLeg('bank-transfer', 'EUR'), quote: q }, ctx)
    expect(checkLegStep(step)).toEqual([])
    expect(step).toMatchObject({ state: 'PAYMENT', status: 'requires_action', surface: { kind: 'IFRAME', origin: 'https://widget.swapped.com' } })
    const url = new URL((step.surface as { url: string }).url)
    expect(url.pathname).toBe('/sell')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ apiKey: PK, method: 'bank-transfer', userSendsFunds: 'false', cryptoCurrencyCode: 'USDC_BASE', cryptoCurrencyAmount: '100', fiatCurrencyCode: 'EUR', baseCountry: 'DK' })
    // signature: base64 HMAC of the query string (with '?') before `&signature=`
    const raw = (step.surface as { url: string }).url
    const search = raw.slice(raw.indexOf('?'), raw.indexOf('&signature='))
    expect(url.searchParams.get('signature')).toBe(createHmac('sha256', SK).update(search).digest('base64'))
  })

  it('payment_pending on a sell asks for the USDC transfer to Swapped (ERC20 calldata)', async () => {
    const ctx = makeWebhookCtx()
    const body = { order_type: 'sell', order_status: 'payment_pending', external_customer_id: 'u1.abc', order_crypto: 'USDC_BASE', order_crypto_amount: '100.5', order_crypto_address: '0x00000000000000000000000000000000000000AA' }
    const [ev] = await a.webhook!.parse(JSON.stringify(body), ctx) as Array<Record<string, unknown>>
    expect(ev).toMatchObject({ ref: 'u1.abc', status: 'requires_action', transitions: [{ name: 'submit_tx', kind: 'SURFACE_RESULT', expects: 'tx_hash' }] })
    const surface = ev!.surface as { kind: string; chain: string; txs: Array<{ to: string; data: string; chainId: number; value: string }> }
    expect(surface).toMatchObject({ kind: 'WALLET_TX', chain: 'eip155:8453' })
    const tx = surface.txs[0]!
    expect(tx).toMatchObject({ to: USDC['eip155:8453'], chainId: 8453, value: '0' })
    expect(tx.data.slice(0, 10)).toBe('0xa9059cbb')
    expect(tx.data.slice(10, 74)).toBe('00000000000000000000000000000000000000000000000000000000000000aa')
    expect(fromBaseUnits(BigInt(`0x${tx.data.slice(74)}`).toString(), 6)).toBe('100.5')
    // missing address or unknown crypto: no event
    expect(await a.webhook!.parse(JSON.stringify({ ...body, order_crypto_address: undefined }), ctx)).toEqual([])
    expect(await a.webhook!.parse(JSON.stringify({ ...body, order_crypto: 'BTC' }), ctx)).toEqual([])
  })

  it('maps sell payout_pending, order_completed and order_cancelled; buy order_completed stays processing', async () => {
    const ctx = makeWebhookCtx()
    const sell = (order_status: string, extra = {}) => a.webhook!.parse(JSON.stringify({ order_type: 'sell', order_status, external_customer_id: 'r', ...extra }), ctx)
    expect(await sell('payout_pending', { transaction_id: '0xtx' })).toMatchObject([{ ref: 'r', status: 'processing', txHash: '0xtx' }])
    expect(await sell('order_completed')).toMatchObject([{ ref: 'r', status: 'succeeded' }])
    expect(await sell('order_broadcasted', { transaction_id: '0xt' })).toMatchObject([{ ref: 'r', status: 'succeeded', txHash: '0xt' }])
    expect((await sell('order_cancelled'))[0]).toMatchObject({ status: 'failed', error: { code: 'PAYMENT_FAILED' } })
    expect(await sell('something_else')).toEqual([])
    const buy = await a.webhook!.parse(JSON.stringify({ order_type: 'buy', order_status: 'order_completed', external_customer_id: 'r' }), ctx)
    expect(buy[0]!.status).toBe('processing')
  })

  it('submit_tx moves the sell leg to processing; other transitions are refused', async () => {
    const ctx = makeCtx({ fetch: fakeFetch([]).fetch })
    const s = await a.transition!({ leg: sellLeg('bank-transfer', 'EUR'), ref: 'r', name: 'submit_tx', inputs: { txHash: '0xabc' } }, ctx)
    expect(s).toMatchObject({ state: 'PROCESSING', status: 'processing', txHash: '0xabc' })
    await expect(a.transition!({ leg: sellLeg('bank-transfer', 'EUR'), ref: 'r', name: 'nope' }, ctx)).rejects.toMatchObject({ error: { code: 'BAD_REQUEST' } })
  })
})
