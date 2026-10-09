// No silent fallback to the wrong asset: an adapter that does not deliver the requested token gives no quote.
import { describe, expect, it } from 'vitest'
import { USDC } from '@openrampkit/core'
import type { Asset, PathwayLeg } from '@openrampkit/core'
import { binance } from '@openrampkit/adapter-binance'
import { bridge } from '@openrampkit/adapter-bridge'
import { coinbase } from '@openrampkit/adapter-coinbase'
import { meld } from '@openrampkit/adapter-meld'
import { moonpay } from '@openrampkit/adapter-moonpay'
import { onramper } from '@openrampkit/adapter-onramper'
import { stripe } from '@openrampkit/adapter-stripe'
import { swapped } from '@openrampkit/adapter-swapped'
import { transak } from '@openrampkit/adapter-transak'
import { deliverableToAsset, findDeliverAsset, requireDeliverAsset } from './index.js'
import type { Adapter } from './index.js'
import { fakeFetch, makeCtx } from './testing.js'

const BASE_USDC = { kind: 'crypto' as const, chain: 'eip155:8453', token: USDC['eip155:8453']! }
const LIST = [
  { chain: 'eip155:8453', token: USDC['eip155:8453']!, symbol: 'USDC', decimals: 6, code: 'usdc_base' },
  { chain: 'eip155:1', token: USDC['eip155:1']!, symbol: 'USDC', decimals: 6, code: 'usdc' },
  { chain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', token: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', code: 'usdc_sol' },
]

describe('findDeliverAsset and requireDeliverAsset', () => {
  it('matches chain and token (EVM addresses without case, Solana with case)', () => {
    expect(findDeliverAsset(LIST, { kind: 'crypto', chain: 'eip155:1', token: USDC['eip155:1']!.toUpperCase().replace('0X', '0x') })?.code).toBe('usdc')
    expect(findDeliverAsset(LIST, { kind: 'crypto', chain: LIST[2]!.chain, token: LIST[2]!.token })?.code).toBe('usdc_sol')
    expect(findDeliverAsset(LIST, { kind: 'crypto', chain: LIST[2]!.chain, token: LIST[2]!.token.toLowerCase() })).toBeUndefined()
  })

  it('returns undefined on no match: never the first entry', () => {
    const misses: Array<Asset | undefined> = [
      undefined,
      { kind: 'fiat', currency: 'USD' },
      { kind: 'crypto', chain: '*', token: '*' },
      { kind: 'crypto', chain: 'eip155:8453', token: '0x000000000000000000000000000000000000dead' },
      { kind: 'crypto', chain: 'eip155:143', token: USDC['eip155:8453']! },
    ]
    for (const a of misses) expect(findDeliverAsset(LIST, a)).toBeUndefined()
    expect(() => requireDeliverAsset(LIST, misses[3], 'Acme')).toThrow(expect.objectContaining({ status: 422, error: expect.objectContaining({ code: 'NO_QUOTES', recovery: 'choose_other' }) }))
    expect(requireDeliverAsset(LIST, BASE_USDC, 'Acme').code).toBe('usdc_base')
  })

  it('deliverableToAsset keeps symbol and decimals only when known', () => {
    expect(deliverableToAsset(LIST[0]!)).toEqual({ ...BASE_USDC, symbol: 'USDC', decimals: 6 })
    expect(deliverableToAsset(LIST[2]!)).toEqual({ kind: 'crypto', chain: LIST[2]!.chain, token: LIST[2]!.token })
  })
})

describe('adapters: a destination token the provider does not deliver gets no quote', () => {
  // A token on Base that no adapter delivers, and a chain that no adapter delivers to.
  const targets: Asset[] = [
    { kind: 'crypto', chain: 'eip155:8453', token: '0x000000000000000000000000000000000000dEaD' },
    { kind: 'crypto', chain: 'eip155:999999', token: USDC['eip155:8453']! },
  ]
  const cases: Array<[string, Adapter, string, string]> = [
    ['MoonPay', moonpay({ publishableKey: 'pk_test_1', secretKey: 'sk_test_1', webhookKey: 'wk_test_1', env: 'production' }), 'card', 'USD'],
    ['Binance', binance({ apiUrl: 'https://binance.partner.test', clientId: 'c', accessToken: 't', privateKey: 'not-used', binancePublicKey: 'not-used' }), 'account', 'EUR'],
    ['Meld', meld({ apiKey: 'k', env: 'sandbox', webhookSecret: 's' }), 'card', 'USD'],
    ['Onramper', onramper({ apiKey: 'pk_test_1', secretKey: 'not-used', webhookSecret: 's', env: 'sandbox' }), 'creditcard', 'USD'],
    ['Stripe', stripe({ secretKey: 'sk_test_1', publishableKey: 'pk_test_1', webhookSecret: 'whsec_1' }), 'card', 'USD'],
    ['Swapped', swapped({ publicKey: 'pk', secretKey: 'sk' }), 'creditcard', 'USD'],
    ['Transak', transak({ apiKey: 'K', apiSecret: 'S', referrerDomain: 'app.test' }), 'card', 'EUR'],
    ['Coinbase', coinbase({ apiKeyId: 'k', apiKeySecret: 'not-used' }), 'card', 'USD'],
    ['Bridge', bridge({ apiKey: 'sk-test-x', webhookPublicKey: 'not-used' }), 'usd-ach', 'USD'],
  ]
  for (const [name, a, legId, currency] of cases) {
    it(`${name}: NO_QUOTES, and no provider call`, async () => {
      for (const to of targets) {
        const { fetch, calls } = fakeFetch([])
        const leg: PathwayLeg = {
          adapterId: a.id,
          legId,
          from: { asset: { kind: 'fiat', currency }, location: { kind: 'user_account' } },
          to: { asset: to, location: { kind: 'address', address: '0x000000000000000000000000000000000000beef' } },
        }
        const ctx = makeCtx({ fetch, session: { country: 'US' } })
        await expect(a.quote({ leg, amountIn: { amount: '100', asset: { kind: 'fiat', currency } }, deliverTo: { address: '0x000000000000000000000000000000000000beef' } }, ctx)).rejects.toMatchObject({
          status: 422,
          error: { code: 'NO_QUOTES', message: expect.stringMatching(new RegExp(`^${name} does not deliver `)) },
        })
        expect(calls).toEqual([])
      }
    })
  }
})
